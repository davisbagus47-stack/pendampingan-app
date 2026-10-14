'use strict';

/**
 * Penegakan kolom yang diblokir keras (FR-4.20a..FR-4.20c).
 *
 * Modul ini adalah sisi JavaScript dari aturan yang seluruhnya ditegakkan di
 * database. Ia tidak menggantikan RLS atau proyeksi SQL; ia menentukan daftar
 * SELECT yang dipakai RLS, dan menjadi penjaga kedua kalau suatu saat ada jalur
 * output yang lupa memfilter.
 *
 * Tiga aturan PRD yang bentuknya menentukan implementasi:
 *
 *   FR-4.20a  Kolom diblokir tidak boleh muncul di respons, DAN permintaan
 *             eksplisit atas kolom itu (`fields`) ditolak `FIELD_NOT_GRANTED`.
 *             Dua hal berbeda. Respons: hilangkan diam-diam. Permintaan
 *             eksplisit: ubah jadi galat. Kalau permintaan eksplisit ikut
 *             dihilangkan diam-diam, Admin tidak akan pernah tahu konfigurasi
 *             blokirnya tidak berlaku -- dan klien akan menafsirkan data yang
 *             tidak lengkap sebagai data yang memang begitu.
 *
 *   FR-4.20b  Berlaku untuk SEMUA format dan SEMUA endpoint yang mengembalikan
 *             baris. Karena itu daftar kolom dihitung sekali, lalu dipakai
 *             JSON, CSV, dan XLSX alike. Kalau tiap format punya daftar sendiri,
 *             satu yang lupa berarti kebocoran di format itu saja.
 *
 *   FR-4.20c  Penegakan lewat proyeksi kolom eksplisit di SQL, bukan filter
 *             setelah dibaca. Alasannya: `SELECT *` membaca nilai terlarang ke
 *             memori proses walaupun tidak dikirim -- dan proses itu bisa
 *             di-log, bisa di-cache, bisa bocor lewat log galat. Yang tidak
 *             pernah dibaca tidak bisa bocor. Karena itu `selectList()` menolak
 *             mengembalikan `*`, dan `assertNoStar()` ada sebagai penjaga.
 *
 * Daftar bawaan mengikuti PRD 6.4.1a dan hanya dapat dilepas Admin dengan
 * alasan tercatat. Diletakkan di sini, bukan ditulis tangan di tiap query,
 * karena satu kolom yang lolos di satu endpoint tapi tidak di endpoint lain
 * adalah kebocoran, bukan ketidaksuaian.
 */

const { columnName } = require('./field-types');

/**
 * Kolom yang diblokir keras secara bawaan (PRD 6.4.1a).
 *
 * Ditulis sebagai nama FIELD_ORDER (camelCase) supaya bisa dibandingkan dengan
 * `FIELD_ORDER` langsung. `field_catalog` menyimpan nama kolom SQL (snake_case),
 * jadi `deniedColumnKeys()` menormalkan ke dua bentuk sekaligus.
 */
const DENIED_BAWAAN = [
  // Catatan bebas operator: bisa memuat apa saja, termasuk informasi yang
  // tidak relevan bagi penerima.
  'catatanTPK',
  // NIK wali. Ruang tebakan 16 digit kecil (6 wilayah + 6 tanggal lahir +
  // 4 nomor urut), jadi membocorkan tahun lahir dan nomor urut. Lihat AT-03.
  'nikAyah', 'nikIbu',
  // Risiko reidentifikasi bila sebagian data wali sudah diketahui.
  'namaAyah', 'namaIbu',
];

/** Metadata `records` yang boleh ikut dikembalikan. Bukan kolom payload. */
const META_COLUMNS = [
  'record_id', 'version', 'status', 'schema_version',
  'institution_id', 'record_hash', 'sections',
];

/**
 * Normalisasi satu nama kolom dari sumber mana pun ke nama FIELD_ORDER.
 *
 * Klien boleh mengirim `fields=catatanTPK` (nama form) atau
 * `fields=catatan_tpk` (nama kolom SQL). Keduanya harus kena blokir yang sama:
 * kalau hanya satu yang dikenali, blokir bisa dilewati dengan mengganti garis
 * bawah jadi huruf besar.
 *
 * @returns {string|null} nama FIELD_ORDER, atau null kalau tidak dikenal
 */
function normalizeColumnKey(nama, fieldOrder) {
  const mentah = String(nama === undefined || nama === null ? '' : nama).trim();
  if (mentah === '') return null;
  if (fieldOrder.includes(mentah)) return mentah;

  const snake = columnName(mentah);
  const kebalik = new Map();
  for (const f of fieldOrder) kebalik.set(columnName(f), f);
  return kebalik.get(snake) || null;
}

/**
 * Gabungkan daftar bawaan dengan daftar tambahan instansi.
 *
 * `deniedColumns()` dibaca dari `agency_denied_columns` per instansi, terpisah
 * dari bawaan. Keduanya tidak pernah dihapus: daftar tambahan menambah, bukan
 * menggantikan. Kalau tambahan berarti "ganti", Admin bisa/langsung melepas
 * `catatanTPK` dengan menulis daftar yang tidak memuatnya -- dan blokir keras
 * berubah jadi Preferensi.
 *
 * Nama yang tidak dikenal DIBUANG, bukan dibiarkan. Dua alasan:
 *   - Penolakan harus berbasis nama yang benar-benar ada, bukan ejaan.
 *   - `agency_denied_columns` punya FK ke `field_catalog`, jadi nama asing
 *     tidak mungkin masuk dari database. Buang di siniKPK membuat path yang
 *     lain (mis. berkas konfigurasi) tidak bisa sneak in lewat sini.
 */
function deniedSet(fieldOrder, tambahan) {
  const hasil = new Set();
  for (const nama of DENIED_BAWAAN.concat(Array.isArray(tambahan) ? tambahan : [])) {
    const f = normalizeColumnKey(nama, fieldOrder);
    if (f !== null) hasil.add(f);
  }
  return hasil;
}

/** Daftar nama kolom SQL yang terlarang, untuk `agency_denied_columns` / SQL. */
function deniedColumnKeys(fieldOrder, tambahan) {
  return [...deniedSet(fieldOrder, tambahan)].map(columnName).sort();
}

/**
 * Kolom payload yang boleh dikembalikan: FIELD_ORDER dikurangi yang terlarang.
 *
 * Urutan FIELD_ORDER dipertahankan supaya urutan kolom di CSV dan XLSX sama
 * dengan form dan sama antar format. FR-4.20b tidak menyebut urutan secara
 * eksplisit, tapi divergence urutan antar format adalah bug yang baru
 * ketahuan saat ada yang menempelkan hasilnya ke Excel.
 */
function visibleFields(fieldOrder, denied) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  return fieldOrder.filter((f) => !blokir.has(f));
}

/**
 * Galat dengan kode mesin-baca. `FIELD_NOT_GRANTED` adalah kode yang PRD
 * sebutkan eksplisit (FR-4.6), jadi dikirim apa adanya -- bukan pesan
 * bebas yang harus di-parse klien.
 */
class FieldNotGrantedError extends Error {
  constructor(fields) {
    const daftar = Array.isArray(fields) ? fields.slice().sort() : [fields];
    super(
      'Kolom berikut diblokir keras untuk instansi ini: ' + daftar.join(', ') +
      ' -- kolom dihapus dari respons dan tidak dapat diminta lewat `fields`' +
      ' (FR-4.20a).'
    );
    this.name = 'FieldNotGrantedError';
    this.code = 'FIELD_NOT_GRANTED';
    this.fields = daftar;
    this.status = 403;
  }
}

/**
 * Permintaan eksplisit `fields` yang memuat kolom terlarang.
 *
 * Inti FR-4.20a. Perbandingan dilakukan pada hasil normalisasi, jadi
 * `catatan_tpk` dan `catatanTPK` sama-sama tertangkap.
 *
 * @param {string[]|null} diminta daftar dari parameter `fields`; null = semua
 * @throws {FieldNotGrantedError}
 */
function assertFieldsAllowed(diminta, fieldOrder, denied) {
  if (diminta === null || diminta === undefined) return;
  if (!Array.isArray(diminta)) {
    throw new TypeError('fields harus berupa array atau null, bukan ' + typeof diminta);
  }
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const ditolak = [];
  for (const nama of diminta) {
    const f = normalizeColumnKey(nama, fieldOrder);
    // Nama asing bukan kolom terlarang. Ditolak sebagai FIELD_UNKNOWN, bukan
    // FIELD_NOT_GRANTED: klien perlu tahu bedanya -- satu berarti "kolom ini
    // tidak ada", yang lain berarti "kolom ini ada tapi Anda tak berhak".
    if (f === null) {
      const err = new Error('Kolom tidak dikenal: ' + String(nama));
      err.code = 'FIELD_UNKNOWN';
      err.status = 400;
      err.fields = [String(nama)];
      throw err;
    }
    if (blokir.has(f) && !ditolak.includes(f)) ditolak.push(f);
  }
  if (ditolak.length > 0) throw new FieldNotGrantedError(ditolak);
}

/**
 * Daftar SELECT eksplisit untuk satu query (FR-4.20c).
 *
 * Tidak pernah `*`, dan tidak pernah kolom metadata yang tidak diizinkan --
 * `institution_id` dan `record_hash` sengaja ADA karena keduanya dibutuhkan
 * klien untuk verifikasi commitment (FR-4.3, F3.8).
 *
 * @param {string[]} diminta daftar dari `fields`; null = semua yang terlihat
 * @returns {string} daftar kolom SQL, dipisah koma
 */
function selectList(fieldOrder, denied, diminta) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const semua = visibleFields(fieldOrder, blokir);

  let kolom;
  if (diminta === null || diminta === undefined) {
    kolom = semua;
  } else {
    kolom = [];
    for (const nama of diminta) {
      const f = normalizeColumnKey(nama, fieldOrder);
      // assertFieldsAllowed sudah menolak nama asing dan kolom terlarang sebelum
      // sini dipanggil. Penjaga di bawah sengaja dibiarkan menebal: dipanggil
      // tanpa assert, nama asing tidak boleh diam-diam hilang dari hasil.
      if (f === null || blokir.has(f)) {
        throw new FieldNotGrantedError([String(nama)]);
      }
      if (!kolom.includes(f)) kolom.push(f);
    }
    // Pertahankan FIELD_ORDER, bukan urutan yang diminta klien. Urutan kolom
    // di respons tidak boleh bergantung pada urutan parameter query.
    kolom = semua.filter((f) => kolom.includes(f));
  }

  const daftar = META_COLUMNS.concat(kolom.map(columnName));
  assertNoStar(daftar);
  return daftar.join(', ');
}

/**
 * Penjaga FR-4.20c: daftar SELECT tidak boleh memuat `*`.
 *
 * Sengaja menolak juga `table.*`, karena itu kembali ke `*` dengan nama tabel.
 */
function assertNoStar(daftar) {
  for (const c of daftar) {
    if (/\*/.test(c)) {
      throw new Error(
        'Daftar SELECT memuat wildcard: ' + JSON.stringify(c) +
        ' -- FR-4.20c melarang SELECT *; kolom terlarang akan terbaca ke memori' +
        ' proses walaupun tidak dikirim.'
      );
    }
  }
  return daftar;
}

/**
 * Buang kolom terlarang dari satu baris yang sudah dibaca.
 *
 * PENJAGA KEDUA, bukan jalur utama. Jalur utama adalah `selectList()` di SQL,
 * supaya nilai terlarang tidak pernah masuk ke memori proses. Fungsi ini ada
 * untuk jalur di mana baris sudah terbaca -- ekspor dari cache, hasil join
 * yang dibungkus query lain, atau fixture pengujian.
 *
 * Sifatnya menghapus, bukan menolak. Untuk jalur baca yang tidak memakai
 * `assertFieldsAllowed`, itulah yang membuat bug terlihat: kolom hilang diam-diam.
 *
 * Kolom yang tidak diminta juga dibuang. Keduanya dibedakan karena punya akibat
 * berbeda: kolom terlarang dibuang demi keamanan (FR-4.20a), kolom yang tidak
 * diminta dibuang karena klien tidak memintanya. Kalau yang kedua dilewati,
 * `?fields=nik` tetap mengembalikan 67 kolom -- parameter itu jadi tidak
 * berguna dan mengembalikan data yang tidak diminta eksplisit.
 *
 * Kunci kolom SQL (`nik_ayah`) ikut dibaca, dan baris dikembalikan dengan kunci
 * FIELD_ORDER supaya pemanggil tidak perlu tahu bentuk baris yang dia kirim.
 *
 * @param {string[]|null} diminta daftar dari `fields`; null = semua terlihat
 */
function filterRow(row, fieldOrder, denied, diminta) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const kolom = pilihKolom(visibleFields(fieldOrder, blokir), diminta, fieldOrder, blokir);
  const keluar = {};
  for (const f of kolom) {
    const v = row && (row[f] !== undefined ? row[f] : row[columnName(f)]);
    if (v !== undefined) keluar[f] = v;
  }
  return keluar;
}

/** Buang kolom terlarang dan yang tidak diminta, dari banyak baris. */
function filterRows(rows, fieldOrder, denied, diminta) {
  return (rows || []).map((r) => filterRow(r, fieldOrder, denied, diminta));
}

/**
 * Header ekspor: label yang boleh ditampilkan, dalam urutan tetap.
 *
 * Berisi label, bukan `column_key`, karena yang dilihat manusia adalah
 * "Nama Petugas TPK", bukan `nama_tpk`. Urutannya mengikuti `visibleFields`
 * supaya CSV dan XLSX punya header yang sama.
 */
function exportHeader(fieldOrder, labels, denied, diminta) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const semua = visibleFields(fieldOrder, blokir);
  const kolom = pilihKolom(semua, diminta, fieldOrder, blokir);
  return kolom.map((f) => (labels && labels[f]) || columnName(f));
}

/**
 * Baris ekspor: nilai sel yang sudah dibersihkan, dalam urutan `exportHeader`.
 *
 * Format CSV/XLSX tidak boleh punya konsep "kolom hilang di tengah". Kalau
 * kolom terlarang dihapus per-sel, baris jadi tidak rata dan file tidak bisa
 * dibuka. Jadi yang dihapus adalah kolomnya, bukan nilainya -- membuat setiap
 * baris jumlah selnya sama dengan header.
 */
function exportRow(row, fieldOrder, denied, diminta) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const semua = visibleFields(fieldOrder, blokir);
  const kolom = pilihKolom(semua, diminta, fieldOrder, blokir);
  return kolom.map((f) => {
    const v = row && (row[f] !== undefined ? row[f] : row[columnName(f)]);
    return v === undefined || v === null ? '' : String(v);
  });
}

function pilihKolom(semua, diminta, fieldOrder, blokir) {
  if (diminta === null || diminta === undefined) return semua;
  const yangDiminta = new Set();
  for (const nama of diminta) {
    const f = normalizeColumnKey(nama, fieldOrder);
    if (f === null || blokir.has(f)) throw new FieldNotGrantedError([String(nama)]);
    yangDiminta.add(f);
  }
  return semua.filter((f) => yangDiminta.has(f));
}

/**
 * Ringkasan jumlah kolom untuk log akses dan halaman admin.
 *
 * Yang dikembalikan hanya ANGKA, bukan daftar kolom terlarang. Instansi yang
 * tidak punya akses ke `catatanTPK` juga tidak perlu tahu kolom itu ada di
 * sistem: itu kebocoran kecil yang tidak ada gunanya.
 */
function ringkasan(fieldOrder, denied) {
  const blokir = denied instanceof Set ? denied : deniedSet(fieldOrder, denied);
  const visible = visibleFields(fieldOrder, blokir);
  return {
    visible_count: visible.length,
    denied_count: fieldOrder.length - visible.length,
    visible,
  };
}

module.exports = {
  DENIED_BAWAAN,
  META_COLUMNS,
  FieldNotGrantedError,
  normalizeColumnKey,
  deniedSet,
  deniedColumnKeys,
  visibleFields,
  assertFieldsAllowed,
  selectList,
  assertNoStar,
  filterRow,
  filterRows,
  exportHeader,
  exportRow,
  ringkasan,
};