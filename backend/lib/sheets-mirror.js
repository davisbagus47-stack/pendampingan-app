'use strict';

/**
 * Rencana mirror PostgreSQL ke Google Sheets (F1.11).
 *
 * Tujuannya satu: TPK lama yang masih membaca spreadsheet tidak kehilangan
 * alur. Postgres yang jadi sumber kebenaran, Sheets yang jadi salinan.
 *
 * Modul ini tidak menyentuh jaringan maupun database. Ia menerima daftar
 * record dari Postgres dan daftar baris yang sudah tercermin, lalu mengembalikan
 * RENCANA: baris mana yang perlu ditambah, baris mana yang perlu ditulis ulang,
 * dan baris mana yang boleh dibiarkan. Semua keputusan ada di sini supaya bisa
 * diuji tanpa kredensial Google dan tanpa PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * Idempotensi adalah syarat utama, bukan tambahan kecil.
 * ---------------------------------------------------------------------------
 *
 * Job mirror dijalankan berulang, dijadwalkan, dan pasti pernah dijalankan dua
 * kali: karena prosesnya terbunuh di tengah, atau karena operator menekan
 * tombol Run Now. Kalau append tanpa memorized apa yang sudah tercermin, setiap
 * menjalankan membuat baris duplikat, dan spreadsheet TPK lama akan terisi
 * salinan yang sama berulang kali tanpa ada yangwifeedish mengetahuinya.
 *
 * Yang menentukan bukan "sudah pernahappend" tapi versi dan hash:
 *
 *   - `record_id` sama, `version` sama, `record_hash` sama  -> lewati. Ini yang
 *     membuat job kedua harmless.
 *   - `record_id` sama, `version` lebih besar              -> tulis ulang baris
 *     yang sama, jangan tambah. Baris versi lama akan selalu ada di sheet
 *     karena TPK lama sudah membacanya.
 *   - `record_id` sama, `version` lebih kecil              -> lewati. Job yang
 *     membaca data lebih dulu bisa selesai belakangan, dan menimpanya dengan
 *     versi lama berarti membatalkan koreksi yang sudah tercatat di anchor.
 *   - `record_id` sama, `record_hash` beda pada `version` sama -> lewati dan
 *     laporkan sebagai anomali. Dua hash berbeda untuk versi yang sama berarti
 *     ada data yang berubah di tempat, dan itu bukan yang boleh ditimpa
 *     tanpa dilihat manusia.
 *
 * ---------------------------------------------------------------------------
 * Record `redacted`
 * ---------------------------------------------------------------------------
 *
 * FR-3.7: payload yang di-redacted tidak dapat dipulihkan. Kalau barisnya
 * masih ada di sheet dengan isi lengkap, penghapusan di Postgres tidak berarti
 * apa-apa -- datanya masih terbaca di spreadsheet. Jadi record `redacted`
 * ditangani dengan MENGOSONGKAN baris yang sudah ada, bukan dengan menambah
 * baris kosong atau dengan melupakannya.
 */

/** Versi record yang dianggap "terbaru" untuk satu `record_id`. */
function versiTertinggi(records) {
  const terbaik = new Map();
  for (const r of records || []) {
    const ada = terbaik.get(r.record_id);
    if (ada === undefined || r.version > ada.version) terbaik.set(r.record_id, r);
  }
  return [...terbaik.values()];
}

/**
 * Susun baris sheet dari satu record.
 *
 * Urutannya mengikuti FIELD_ORDER, sama persis dengan `buildRow` di index.js.
 * Nilai yang tidak ada menjadi string kosong, bukan `undefined` -- Sheets
 * menulis `undefined` sebagai teks "undefined" pada sebagian konfigurasi, dan
 * baris jadi tidak seragam.
 *
 * `labels` sengaja tidak dipakai: sheet legacy memakai LABEL sebagai header tapi
 * menyimpan nilai dalam URUTAN FIELD_ORDER. Menempelkan label di sini akan
 * membuat baris berisi teks label.
 */
function barisSheet(record, fieldOrder) {
  const p = (record && record.payload) || {};
  return fieldOrder.map((f) => {
    const v = p[f];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

/**
 * Baris yang harus ditulis ulang: versi lebih baru, atau isi versi sama yang
 * berubah bentuk.
 *
 * Perbandingan dibuat atas `record_hash`, bukan atas isi payload. Hash sudah
 * mencakup payload verbatim, jadi dua hash sama berarti isi sama -- dan
 * membandingkan 72 nilai satu per satu akan bisa salah menyimpang karena
 * perbedaan format (`1` vs `1.0`) yang sebenarnya bukan perubahan data.
 */
function perluDiperbarui(record, tercermin) {
  if (!tercermin) return 'tambah';
  if (record.version > tercermin.version) return 'perbarui';
  if (record.version < tercermin.version) return 'kedaluwarsa';
  if (record.record_hash !== tercermin.record_hash) return 'anomali';
  return 'sama';
}

/**
 * Susun rencana mirror.
 *
 * Duplikat di input itu NORMAL, bukan galat. Query worker mengambil semua versi
 * satu record (`ORDER BY record_id, version DESC`), jadi dua record dengan
 * `record_id` sama memang muncul bersama dan `versiTertinggi` memilih yang
 * terbaru. Menolaknya akan membuat worker berhenti pada data yang valid.
 *
 * Yang tidak boleh terjadi: satu record menduduki dua baris sheet. Itu
 * dijamin oleh `versiTertinggi`, dan diuji langsung.
 *
 * @param {object[]} records record dari Postgres: {record_id, version, status,
 *                                payload, record_hash}
 * @param {object} tercermin peta `record_id` -> {version, record_hash, no, baris}
 *                 berisi baris yang SUDAH ada di sheet
 * @param {string[]} fieldOrder urutan kolom
 * @param {number} barisTerakhir nomor baris data terakhir di sheet (kolom No)
 * @returns {{ tambah: object[], perbarui: object[], kosongkan: object[],
 *             lewati: object[], anomali: object[], ringkas: object }}
 */
function rencanaMirror(records, tercermin, fieldOrder, barisTerakhir) {
  const sudah = tercermin || {};

  // `record_id` kosong berarti record tidak punya kunci idempotensi: tidak ada
  // cara tahu apakah sudah pernah tercermin, jadi barisnya akan ditulis ulang
  // setiap kali job berjalan. Menolak lebih baik daripada menjadi duplikat.
  const tanpaId = (records || []).find(
    (r) => r.record_id === undefined || r.record_id === null || String(r.record_id).trim() === ''
  );
  if (tanpaId) {
    throw new Error('Record tanpa record_id tidak bisa dimirror: tidak ada kunci idempotensi.');
  }

  const hasil = {
    tambah: [],
    perbarui: [],
    kosongkan: [],
    lewati: [],
    anomali: [],
  };

  let nomor = (typeof barisTerakhir === 'number' && barisTerakhir > 0) ? barisTerakhir : 0;

  // `versiTertinggi` sudah menjamin satu `record_id` satu kali, jadi tidak
  // perlu pemeriksaan duplikat di sini. Dulu ada -- dan pemeriksaan itu tidak
  // pernah bisa gagal, karena membuang duplikat bukan tugasnya.
  for (const record of versiTertinggi(records)) {
    const entry = sudah[record.record_id];

    // Record redacted tidak boleh menambah baris baru. Kalau belum pernah
    // tercermin, tidak ada yang perlu dibersihkan di sheet.
    if (record.status === 'redacted') {
      if (entry) {
        // `no` ikut dipertahankan saat baris dikosongkan: kolom No di sheet
        // legacy dibaca TPK sebagai nomor urut, dan menyamakamnya hanya karena
        // datanya dihapus akan membuat baris berikutnya terlihat salah.
        //
        // `record_hash` ikut dibawa. Tanpa itu, penanda redacted ditulis dengan
        // hash kosong: run berikutnya akan membandingkan hash kosong dengan hash
        // record redacted yang sama selalu dibandingkan sebagai "berbeda", jadi
        // recordset redacted jadi anomali permanen -- dan setiap run mengulang
        // pengosongan baris yang sama.
        hasil.kosongkan.push({
          record_id: record.record_id,
          version: record.version,
          record_hash: record.record_hash,
          no: entry.no,
          baris: entry.baris,
        });
      } else {
        hasil.lewati.push({ record_id: record.record_id, alasan: 'redacted-belum-pernah-tercermin' });
      }
      continue;
    }

    const keadaan = perluDiperbarui(record, entry);

    if (keadaan === 'tambah') {
      nomor += 1;
      hasil.tambah.push({
        record_id: record.record_id,
        version: record.version,
        record_hash: record.record_hash,
        no: nomor,
        // Sheet legacy: baris 1 header, data mulai baris 2.
        baris: nomor + 1,
        values: barisSheet(record, fieldOrder),
      });
    } else if (keadaan === 'perbarui') {
      // Baris versi lama TIDAK dihapus dan record baru tidak ditambahkan: baris
      // yang sama ditulis ulang, supaya `no` yang sudah dipakai TPK lama tetap
      // menunjuk ke record yang sama.
      //
      // `no` diambil dari penanda, bukan dihitung ulang. Kalau penomoran di
      //hitung dari posisi baris, satu baris TPK yang disisipkan di tengah akan
      // membuat mirror menimpa baris yang salah.
      hasil.perbarui.push({
        record_id: record.record_id,
        version: record.version,
        record_hash: record.record_hash,
        no: entry.no,
        baris: entry.baris,
        values: barisSheet(record, fieldOrder),
      });
    } else if (keadaan === 'kedaluwarsa') {
      hasil.lewati.push({
        record_id: record.record_id,
        alasan: 'versi-lebih-lama-dari-yang-sudah-tercermin',
        punya: record.version,
        sudah: entry.version,
      });
    } else if (keadaan === 'anomali') {
      hasil.anomali.push({
        record_id: record.record_id,
        reason: 'hash-berbeda-pada-versi-yang-sama',
        punya: record.record_hash,
        sudah: entry.record_hash,
      });
    } else {
      hasil.lewati.push({ record_id: record.record_id, alasan: 'sudah-tercermin' });
    }
  }

  // Sheet bisa punya baris yang tidak ada lagi di Postgres -- record dihapus
  // dari sumber, atau sheet diisi manual oleh TPK lama. Baris seperti itu TIDAK
  // boleh dihapus oleh mirror: sheet bukan milik job ini, dan menghapusnya
  // berarti mirror ikut mengambil keputusan data yang bukan miliknya.
  hasil.ringkas = {
    tambah: hasil.tambah.length,
    perbarui: hasil.perbarui.length,
    kosongkan: hasil.kosongkan.length,
    lewati: hasil.lewati.length,
    anomali: hasil.anomali.length,
    baris_tersisa_di_sheet: Object.keys(sudah).length,
  };

  return hasil;
}

/**
 * Baca penanda dari sheet Mirror menjadi peta `record_id` -> penanda.
 *
* Sheet legacy tidak boleh disentuh strukturnya: TPK lama sudah membacanya, dan
 * menambah kolom di sana merusak pembacaan yang sedang berjalan. Karena itu
 * penanda disimpan di sheet Mirror yang berdampingan.
 *
 * Yang dibaca adalah kolom `no`, BUKAN indeks baris sheet Mirror. Keduanya
 * berbeda: sheet Mirror hanya mendapat baris untuk record yang sudah pernah
 * tercermin, sedangkan sheet legacy juga berisi baris yang ditambahkan TPK lama
 * sendiri dan baris dari batch lama. Begitu saja isinya tidak lagi sejajar, dan
 * memakai indeks baris Mirror akan menulis ke baris yang salah -- yang berarti
 * menimpa data TPK dengan data record lain.
 */
function bacaTercermin(values, kolom) {
  const pos = kolom || { record_id: 0, version: 1, record_hash: 2, no: 3 };
  const peta = {};
  const rows = values || [];
  // Baris 0 adalah header.
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const id = r[pos.record_id];
    if (id === undefined || id === null || String(id).trim() === '') continue;
    const no = Number(r[pos.no]);
    // Tanpa `no` yang sah, penanda ini tidak bisa dipetakan ke baris legacy.
    // Melewatinya lebih aman daripada menebak: menebak berarti menimpa baris
    // yang salah.
    if (!Number.isFinite(no) || no <= 0) continue;
    peta[String(id)] = {
      version: Number(r[pos.version]) || 0,
      record_hash: r[pos.record_hash] === undefined || r[pos.record_hash] === null
        ? null
        : String(r[pos.record_hash]),
      no,
      // Sheet legacy: baris 1 adalah header, data mulai baris 2. Record `no`
      // berada di baris no+1.
      baris: no + 1,
    };
  }
return peta;
}

/** Header sheet Mirror. Berdampingan dengan sheet legacy, bukan menggantinya. */
const HEADER_MIRROR = ['record_id', 'version', 'record_hash', 'no', 'synced_at'];

/** Baris marker untuk satu record yang baru tercermin. */
function marker(record, no, syncedAt) {
  return [record.record_id, record.version, record.record_hash, no, syncedAt || ''];
}

/**
 * Redaksi baris di sheet: kolom `no` dipertahankan supaya penomoran TPK lama
 * tidak bergeser, sisanya dikosongkan.
 *
 * Mengosongkan lebih baik daripada menghapus: penghapusan baris di spreadsheet
 * yang sedang dibaca orang tidak selalu langsung terlihat, dan baris kosong
 * jelas berarti "sudah dihapus".
 */
function selKosong(kolom) {
  return new Array(kolom || 1).fill('');
}

module.exports = {
  versiTertinggi,
  barisSheet,
  perluDiperbarui,
  rencanaMirror,
  bacaTercermin,
  marker,
  HEADER_MIRROR,
  selKosong,
};
