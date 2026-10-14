'use strict';

/**
 * Uji F1.11: rencana mirror PostgreSQL ke Google Sheets.
 *
 * Yang paling diuji di sini adalah idempotensi, karena itu alasan mirror
 * boleh dipakai di produksi. Job mirror dijalankan terjadwal dan pasti pernah
 * berjalan dua kali; kalau dua kali menghasilkan dua baris, spreadsheet TPK
 * lama akan berisi salinan ganda yang tidak ada yangotong menghapus.
 *
 * Yang TIDAK diuji: panggilan Google Sheets sungguhan dan pembacaan
 * PostgreSQL sungguhan. Keduanya butuh kredensial dan database. Yang diuji
 * adalah keputusan yang akan diambil worker, dan itu yang menentukan benar atau
 * salahnya mirror.
 */

const path = require('path');
const app = require(path.join(__dirname, '..', 'index.js'));
const mirror = require(path.join(__dirname, '..', 'lib', 'sheets-mirror.js'));

const { FIELD_ORDER, HEADERS } = app;

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

/**
 * Ambil elemen ke-n, atau objek kosong kalau tidak ada.
 *
 * Assertion harus melaporkan kegagalan, bukan melempar galat. Kalau uji berhenti
 * di tengah karena `perbarui[0]` tidak ada, baris setelahnya tidak pernah
 * dijalankan -- dan mutasi yang seharusnya ditolak hanya terlihat sebagai
 * "crash", sehingga tidak jelas apakah pagar itu bekerja atau tidak.
 */
function item(arr, n) {
  return (arr && arr[n]) || {};
}

/** Record Postgres dengan bentuk yang dipakai worker. */
function record(id, version, hash, payload, status) {
  return {
    record_id: id,
    version: version === undefined ? 1 : version,
    record_hash: hash || ('hash-' + id + '-v' + version),
    status: status || 'active',
    payload: payload || {},
  };
}

/** Record dengan payload terisi penuh, supaya jumlah kolom bisa diperiksa. */
function recordPenuh(id, version) {
  const p = {};
  for (const f of FIELD_ORDER) p[f] = 'nilai-' + f;
  return record(id, version, null, p);
}

console.log('=== 1. Bentuk baris sheet mengikuti FIELD_ORDER ===');

// Baris sheet harus punya kolom sebanyak FIELD_ORDER dan urutannya sama.
// Urutan yang berbeda berarti TPK lama membaca kolom yang keliru.
// TPK membaca lewat label header, jadi tidak ada galat yang muncul -- hanya
// data yang berpindah ke kolom yang salah.
const r1 = recordPenuh('rec-1', 1);
const baris1 = mirror.barisSheet(r1, FIELD_ORDER);
eq('jumlah sel = jumlah FIELD_ORDER', baris1.length, FIELD_ORDER.length);
eq('nilai sesuai posisi field', baris1[FIELD_ORDER.indexOf('nik')], 'nilai-nik');
eq('nilai pertama benar', baris1[0], 'nilai-namaTPK');
eq('jumlah sel = HEADERS minus kolom No', baris1.length, HEADERS.length - 1);

console.log('\n=== 2. Nilai kosong jadi string kosong, bukan "undefined" ===');

// Sheets menulis undefined sebagai teks pada sebagian konfigurasi. Baris jadi
// tidak seragam dan kolom berikutnya bergeser.
const rKosong = record('rec-k', 1, null, { nik: '3201234567890' });
const bKosong = mirror.barisSheet(rKosong, FIELD_ORDER);
eq('jumlah sel tetap penuh', bKosong.length, FIELD_ORDER.length);
eq('tidak ada nilai undefined', bKosong.some((c) => c === undefined), false);
eq('tidak ada teks "undefined"', bKosong.some((c) => c === 'undefined'), false);
eq('tidak ada teks "null"', bKosong.some((c) => c === 'null'), false);
eq('nilai yang ada tetap terbaca', bKosong[FIELD_ORDER.indexOf('nik')], '3201234567890');

// Payload yang salah bentuk tidak boleh membuat baris ikut berubah panjang.
const bNull = mirror.barisSheet(record('rec-n', 1, null, { nik: null, namaLengkap: undefined }), FIELD_ORDER);
eq('null dan undefined jadi kosong', bNull[FIELD_ORDER.indexOf('nik')], '');
eq('jumlah sel tidak berubah', bNull.length, FIELD_ORDER.length);

console.log('\n=== 3. Jalankan pertama: semua record baru ditambahkan ===');

const batch = [
  recordPenuh('rec-1', 1),
  recordPenuh('rec-2', 1),
  recordPenuh('rec-3', 1),
];

const r1a = mirror.rencanaMirror(batch, {}, FIELD_ORDER, 0);
eq('tiga baris ditambah', r1a.tambah.length, 3);
eq('tidak ada yang diperbarui', r1a.perbarui.length, 0);
eq('tidak ada yang dikosongkan', r1a.kosongkan.length, 0);
eq('tidak ada anomali', r1a.anomali.length, 0);
eq('penomoran mulai dari 1', r1a.tambah.map((t) => t.no), [1, 2, 3]);
eq('nomor mengikuti baris terakhir yang ada', r1a.tambah.map((t) => t.no), [1, 2, 3]);

// Penomoran harus melanjutkan dari baris yang sudah ada di sheet, bukan mulai
// dari 1 -- kalau tidak, nomor TPK lama jadi bentrok.
const r1b = mirror.rencanaMirror(batch, {}, FIELD_ORDER, 40);
eq('melanjutkan penomoran dari 40', r1b.tambah.map((t) => t.no), [41, 42, 43]);

console.log('\n=== 4. Jalankan kedua: tidak boleh menambah apa pun ===');

// Ini inti F1.11. Job yang sama dijalankan lagi setelah job pertama selesai.
const tercerminSetelahRun1 = {};
for (const t of r1a.tambah) {
  tercerminSetelahRun1[t.record_id] = { version: t.version, record_hash: t.record_hash, no: t.no, baris: t.baris };
}

const run2 = mirror.rencanaMirror(batch, tercerminSetelahRun1, FIELD_ORDER, 43);
eq('tidak menambah baris', run2.tambah.length, 0);
eq('tidak memperbarui baris', run2.perbarui.length, 0);
eq('tidak mengosongkan baris', run2.kosongkan.length, 0);
eq('tidak ada anomali', run2.anomali.length, 0);
eq('tiga record dianggap sudah tercermin', run2.lewati.length, 3);
eq('alasannya sudah-tercermin', run2.lewati.every((l) => l.alasan === 'sudah-tercermin'), true);

// Jalankan ketiga, keempat: harus tetap nol. Job terjadwal tidak boleh
// bergantung pada berapa kali sudah berjalan.
for (let i = 0; i < 3; i++) {
  const runN = mirror.rencanaMirror(batch, tercerminSetelahRun1, FIELD_ORDER, 43);
  if (runN.tambah.length !== 0 || runN.perbarui.length !== 0) {
    failed++;
    console.log('GAGAL  menjalankan ke-' + (i + 3) + ' mengubah sheet');
  }
}
passed++;
console.log('LULUS  menjalankan berulang tidak mengubah sheet');

console.log('\n=== 5. Versi baru menulis ulang baris yang sama ===');

// Koreksi field: record sama, versi naik. Baris yang SAMA ditulis ulang, bukan
// ditambah. Kalau ditambah, TPK lama akan punya dua baris untuk satu kunjungan
// dan menghitungnya dua kali.
const corrected = recordPenuh('rec-2', 2);
corrected.payload.usia = '29';
const run3 = mirror.rencanaMirror([corrected], tercerminSetelahRun1, FIELD_ORDER, 43);

// `values` perlu penjaga sendiri: kalau `perbarui` kosong, assertion sebelumnya
// sudah melaporkan kegagalan, tapi membiarkan baris ini meledak akan menghentikan
// seluruh sisa suite -- dan mutasi yang harusnya ditolak hanya terlihat sebagai
// "crash" tanpa ringkasan.
function nilaiAt(rencana, indeksKolom) {
  const o = item(rencana.perbarui, 0);
  return Array.isArray(o.values) ? o.values[indeksKolom] : undefined;
}

eq('tidak menambah baris baru', run3.tambah.length, 0);
eq('satu baris diperbarui', run3.perbarui.length, 1);
eq('bukan record lain', item(run3.perbarui, 0).record_id, 'rec-2');
// Nomor dan baris legacy harus sama seperti sebelumnya: koreksi menulis ulang
// baris yang sama, bukan membuat baris baru.
eq('nomor tidak berubah', item(run3.perbarui, 0).no, 2);
eq('menulis di baris legacy yang sama', item(run3.perbarui, 0).baris, 3);
eq('nilai baru ikut terpasang', nilaiAt(run3, FIELD_ORDER.indexOf('usia')), '29');

// Setelah diperbarui, penanda harus ikut berubah. Kalau tidak, menjalankan lagi
// akan melihat versi lama dan memperbarui sekali lagi tanpa henti.
const tercerminSetelahRun3 = Object.assign({}, tercerminSetelahRun1, {
  'rec-2': { version: 2, record_hash: corrected.record_hash, no: 2, baris: 3 },
});
const run4 = mirror.rencanaMirror([corrected], tercerminSetelahRun3, FIELD_ORDER, 43);
eq('setelah diperbarui, idempoten lagi', run4.perbarui.length, 0);
eq('tidak menambah lagi', run4.tambah.length, 0);

console.log('\n=== 6. Versi lama yang telat sampai tidak menimpa versi baru ===');

// Job bisa membaca data lebih dulu tapi selesai belakangan. Kalau menimpa,
// koreksi yang sudah tercatat di anchor justru dibatalkan.
const lama = recordPenuh('rec-2', 1);
const runLama = mirror.rencanaMirror([lama], tercerminSetelahRun3, FIELD_ORDER, 43);
eq('versi lama tidak ditulis', runLama.perbarui.length, 0);
eq('versi lama tidak menambah', runLama.tambah.length, 0);
eq('dilewati sebagai kedaluwarsa',
  runLama.lewati.some((l) => l.alasan === 'versi-lebih-lama-dari-yang-sudah-tercermin'), true);

// Urutan input tidak boleh memengaruhi hasil: batch besar bisa tiba dengan
// versi lama lebih dulu.
const campur = [lama, corrected];
const runCampur = mirror.rencanaMirror(campur, tercerminSetelahRun3, FIELD_ORDER, 43);
eq('urutan input tidak memengaruhi', runCampur.perbarui.length, 0);
eq('versi tertinggi yang dipakai', mirror.versiTertinggi(campur).length, 1);
eq('dan itu versi tertinggi', mirror.versiTertinggi(campur)[0].version, 2);

console.log('\n=== 7. Hash berbeda pada versi sama = anomali, bukan overwrite ===');

// Dua hash berbeda untuk satu versi berarti data berubah di tempat. Menimpanya
// tanpa dilihat manusia berarti membatalkan apa yang sudah tercatat.
const berubah = recordPenuh('rec-1', 1);
berubah.record_hash = 'hash-yang-berbeda';
const runAnomali = mirror.rencanaMirror([berubah], tercerminSetelahRun1, FIELD_ORDER, 43);
eq('tidak ditulis', runAnomali.perbarui.length, 0);
eq('tidak ditambah', runAnomali.tambah.length, 0);
eq('dilaporkan sebagai anomali', runAnomali.anomali.length, 1);
eq('alasannya menyebut hash', item(runAnomali.anomali, 0).reason, 'hash-berbeda-pada-versi-yang-sama');
eq('anomali menyebut record-nya', item(runAnomali.anomali, 0).record_id, 'rec-1');

console.log('\n=== 8. Record redacted mengosongkan baris yang ada ===');

// FR-3.7: payload yang di-redacted tidak dapat dipulihkan. Kalau barisnya masih
// ada dengan isi lengkap di sheet, penghapusan di Postgres tidak berarti apa-apa.
const redacted = record('rec-3', 2, 'hash-rec-3-v2', { nik: '3201234567890' }, 'redacted');
const runRedact = mirror.rencanaMirror([redacted], tercerminSetelahRun1, FIELD_ORDER, 43);
eq('tidak menambah baris', runRedact.tambah.length, 0);
eq('satu baris dikosongkan', runRedact.kosongkan.length, 1);
eq('baris legacy yang benar', item(runRedact.kosongkan, 0).baris, 4);
eq('nomor tetap dipertahankan', item(runRedact.kosongkan, 0).no, 3);
eq('nama record-nya benar', item(runRedact.kosongkan, 0).record_id, 'rec-3');

// Record redacted yang belum pernah tercermin tidak boleh menambah baris kosong.
const redactedBaru = record('rec-9', 1, 'hash-rec-9', {}, 'redacted');
const runRedactBaru = mirror.rencanaMirror([redactedBaru], {}, FIELD_ORDER, 0);
eq('redacted yang baru tidak menambah baris', runRedactBaru.tambah.length, 0);
eq('tidak ada baris yang dikosongkan', runRedactBaru.kosongkan.length, 0);
eq('dilewati dengan alasan jelas',
  runRedactBaru.lewati.some((l) => l.alasan === 'redacted-belum-pernah-tercermin'), true);

// Baris kosong harus punya kolom sebanyak kolom yang dikosongkan, kalau tidak
// spreadsheet menggeser kolom di baris itu sendiri.
eq('sel kosong cukup manyanya', mirror.selKosong(FIELD_ORDER.length).length, FIELD_ORDER.length);
eq('sel kosong benar-benar kosong', mirror.selKosong(3).every((c) => c === ''), true);

console.log('\n=== 9. Duplikat di input tidak boleh menduduki dua baris ===');

// Duplikat di input itu NORMAL: query worker mengambil semua versi satu record
// (`ORDER BY record_id, version DESC`), jadi versi 1 dan 2 datang bersama.
// Yang tidak boleh terjadi adalah keduanya menduduki dua baris sheet -- TPK lama
// akan menghitung satu kunjungan dua kali.
const banyakVersi = [recordPenuh('rec-1', 1), recordPenuh('rec-1', 2), recordPenuh('rec-1', 1)];
const runBanyakVersi = mirror.rencanaMirror(banyakVersi, {}, FIELD_ORDER, 0);
eq('hanya satu baris', runBanyakVersi.tambah.length, 1);
eq('nomor tidak melompat', runBanyakVersi.tambah.map((t) => t.no), [1]);
eq('versi tertinggi yang ditulis', runBanyakVersi.tambah[0].version, 2);

const dobel = [recordPenuh('rec-1', 1), recordPenuh('rec-1', 1)];
const runDobel = mirror.rencanaMirror(dobel, {}, FIELD_ORDER, 0);
eq('duplikat identik tetap satu baris', runDobel.tambah.length, 1);
eq('nomor tetap satu', runDobel.tambah.map((t) => t.no), [1]);

// Dua record berbeda tetap dua baris. Kalau ini salah, data dua sasaran akan
// tertimpa diam-diam.
const duaBeda = [recordPenuh('rec-1', 1), recordPenuh('rec-2', 1)];
const runDuaBeda = mirror.rencanaMirror(duaBeda, {}, FIELD_ORDER, 0);
eq('dua record berbeda tetap dua baris', runDuaBeda.tambah.length, 2);
eq('dengan nomor berurutan', runDuaBeda.tambah.map((t) => t.no), [1, 2]);

// Record tanpa `record_id` tidak punya kunci idempotensi, jadi akan ditulis
// ulang setiap kali job berjalan. Menolaknya lebih baik daripada jadi duplikat.
let tanpaId = null;
try {
  mirror.rencanaMirror([recordPenuh('rec-1', 1), { version: 1, payload: {} }], {}, FIELD_ORDER, 0);
} catch (e) { tanpaId = e; }
ok('record tanpa record_id ditolak', tanpaId !== null);
ok('alasannya menyebut idempotensi', tanpaId && /idempotensi/i.test(tanpaId.message));

console.log('\n=== 10. Sheet tidak ikut berubah oleh baris asing ===');

// TPK lama boleh menambah baris sendiri di sheet. Mirror tidak boleh menghapus
// atau menimpa baris yang bukan miliknya: sheet bukan milik job ini.
const sheetPunyaTpK = {
  'rec-1': { version: 1, record_hash: 'hash-rec-1-v1', no: 1, baris: 2 },
  'baris-tpk-lama': { version: 0, record_hash: null, no: 2, baris: 3 },
  'catatan-tpk': { version: 0, record_hash: null, no: 3, baris: 4 },
};
const runAsing = mirror.rencanaMirror([recordPenuh('rec-1', 1)], sheetPunyaTpK, FIELD_ORDER, 3);
eq('baris TPK lama tidak dihapus', runAsing.kosongkan.length, 0);
eq('baris TPK lama tidak ditulis', runAsing.perbarui.length, 0);
eq('jumlah baris di sheet dilaporkan', runAsing.ringkas.baris_tersisa_di_sheet, 3);

console.log('\n=== 11. Baca penanda dari sheet Mirror ===');

// Sheet Mirror berdampingan dengan sheet legacy. Baris 0 adalah header.
const nilaiMarker = [
  mirror.HEADER_MIRROR,
  ['rec-1', '1', 'hash-a', '1', '2026-01-01T00:00:00Z'],
  ['rec-2', '2', 'hash-b', '2', '2026-01-01T00:00:00Z'],
  [],
  ['rec-3', '1', 'hash-c', '3', '2026-01-01T00:00:00Z'],
];
// Baris 5 ada di sheet Mirror tapi no=3, jadi berada di baris 4 legacy. Sheet
// Mirror dan legacy tidak dijamin sama panjang -- TPK juga menambah baris.

const terbaca = mirror.bacaTercermin(nilaiMarker);
eq('tiga record terbaca', Object.keys(terbaca).length, 3);
eq('versi jadi angka', terbaca['rec-2'].version, 2);
eq('hash ikut terbaca', terbaca['rec-1'].record_hash, 'hash-a');
eq('baris kosong diabaikan', 'rec-4' in terbaca, false);
eq('baris legacy dihitung dari no', terbaca['rec-3'].baris, 4);

console.log('\n=== 11b. Penanda dipetakan lewat kolom `no`, bukan indeks baris Mirror ===');

// Sheet Mirror dan sheet legacy TIDAK sejajar: legacy juga berisi baris yang
// ditambahkan TPK lama sendiri, dan Mirror hanya berisi record yang sudah
// pernah tercermin. Memakai indeks baris Mirror akan menulis ke baris legacy
// yang salah -- menimpa data TPK dengan data record lain.
//
// Diuji dengan penanda yang nomornya sengaja tidak sama dengan posisinya.
const tidakSejajar = [
  mirror.HEADER_MIRROR,
  ['rec-1', '1', 'hash-a', '17', '2026-01-01'],  // di Mirror baris 2, di legacy no=17
  ['rec-2', '1', 'hash-b', '42', '2026-01-01'],
];
const peta = mirror.bacaTercermin(tidakSejajar);
eq('no dibaca dari kolom, bukan dari posisi baris', peta['rec-1'].no, 17);
eq('baris legacy dihitung dari no', peta['rec-1'].baris, 18);
eq('record kedua juga', peta['rec-2'].baris, 43);

// Penanda tanpa `no` yang sah tidak boleh dipetakan: menebak berarti menimpa
// baris yang salah, dan itu lebih buruk daripada melewati.
const tanpaNo = [mirror.HEADER_MIRROR, ['rec-3', '1', 'hash-c', '', ''], ['rec-4', '1', 'hash-d', 'abc', '']];
const petaTanpaNo = mirror.bacaTercermin(tanpaNo);
eq('tanpa no dilewati', 'rec-3' in petaTanpaNo, false);
eq('no bukan angka dilewati', 'rec-4' in petaTanpaNo, false);

// Rencana harus memakai `no` itu, bukan menghitung penomoran baru.
const runPeta = mirror.rencanaMirror(
  [recordPenuh('rec-1', 2)],
  petaTanpaNo,
  FIELD_ORDER,
  50
);
// Karena petanya kosong, record dianggap baru dan dapat nomor setelah 50.
eq('record tanpa penanda diperlakukan baru', runPeta.tambah.length, 1);
eq('mendapat nomor berikutnya', item(runPeta.tambah, 0).no, 51);
eq('baris legacy = no + 1', item(runPeta.tambah, 0).baris, 52);

// Kalau penandanya ada, nomor dari penanda HARUS dipakai -- tidak boleh
// dihitung ulang dari posisi.
const runUpdate = mirror.rencanaMirror([recordPenuh('rec-1', 2)], peta, FIELD_ORDER, 50);
eq('perbarui memakai no dari penanda', item(runUpdate.perbarui, 0).no, 17);
eq('perbarui memakai baris dari penanda', item(runUpdate.perbarui, 0).baris, 18);
eq('bukan nomor baru di akhir', item(runUpdate.perbarui, 0).no !== 51, true);

eq('header Mirror punya lima kolom', mirror.HEADER_MIRROR.length, 5);
eq('header Mirror dimulai dari record_id', mirror.HEADER_MIRROR[0], 'record_id');

// Marker harus memuat record_id dan hash: tanpa keduanya, mirror tidak bisa
// membedakan "sudah tercermin" dari "baru".
const m = mirror.marker(recordPenuh('rec-1', 1), 7, '2026-01-01');
eq('marker memuat record_id', m[0], 'rec-1');
eq('marker memuat versi', m[1], 1);
eq('marker memuat hash', m[2], 'hash-rec-1-v1');
eq('marker memuat nomor', m[3], 7);
eq('marker punya lima kolom', m.length, mirror.HEADER_MIRROR.length);

console.log('\n=== 12. Sheet kosong dan input kosong tidak membuat crash ===');

eq('sheet kosong aman', mirror.bacaTercermin(undefined), {});
eq('sheet null aman', mirror.bacaTercermin(null), {});
const runKosong = mirror.rencanaMirror([], {}, FIELD_ORDER, 0);
eq('input kosong tidak menambah', runKosong.tambah.length, 0);
eq('ringkasan tetap terbentuk', typeof runKosong.ringkas, 'object');
eq('tanpa input, sheet tetap 0 baris', runKosong.ringkas.baris_tersisa_di_sheet, 0);

// Header saja tanpa data.
eq('hanya header terbaca sebagai kosong', Object.keys(mirror.bacaTercermin([mirror.HEADER_MIRROR])).length, 0);

console.log('\n=== 13. Ringkasan benar ===');

const runRingkas = mirror.rencanaMirror(
  [recordPenuh('rec-a', 1), recordPenuh('rec-b', 1), recordPenuh('rec-c', 1)],
  {},
  FIELD_ORDER,
  0
);
eq('tiga menambah', runRingkas.ringkas.tambah, 3);
eq('nol memperbarui', runRingkas.ringkas.perbarui, 0);
eq('nol mengosongkan', runRingkas.ringkas.kosongkan, 0);
eq('nol anomali', runRingkas.ringkas.anomali, 0);

console.log('\n=== 14. Worker: posisi penanda dan penulisan baris ===');

// ---------------------------------------------------------------------------
// Client Sheets palsu.
//
// Semua fungsi worker diuji tanpa jaringan: yang diuji adalah range yang
// dikirim dan urutan operasinya._range_ adalah satu-satunya hal yang menentukan
// data mendarat di baris yang benar, jadi itulah yang direkam di sini.
// ---------------------------------------------------------------------------

function sheetsPalsu(tabNilai) {
  const panggilan = [];
  const sheets = {
    spreadsheets: {
      values: {
        async get({ range }) {
          panggilan.push({ op: 'get', range });
          const tab = tabNilai[range.split('!')[0]];
          if (!tab) throw new Error('Unable to parse range: ' + range);
          return { data: { values: tab } };
        },
        async append({ range, resource }) {
          panggilan.push({ op: 'append', range, values: resource.values });
          return {};
        },
        async update({ range, resource }) {
          panggilan.push({ op: 'update', range, values: resource.values });
          return {};
        },
      },
      async get() {
        panggilan.push({ op: 'getMeta' });
        return { data: { sheets: Object.keys(tabNilai).map((t) => ({ properties: { title: t } })) } };
      },
      async batchUpdate({ resource }) {
        panggilan.push({ op: 'batchUpdate', requests: resource.requests });
        return {};
      },
    },
    panggilan,
  };
  return sheets;
}

async function ujiWorker() {
  const lib = require('../tools/mirror-sheets.js');

  // --- posisi penanda -----------------------------------------------------
  const nilaiMarker = [
    ['record_id', 'version', 'record_hash', 'no', 'synced_at'],
    ['rec-1', '1', 'hash-a', '1', 'waktu-1'],
    [],
    ['rec-2', '2', 'hash-b', '2', 'waktu-2'],
  ];
  const posisi = lib.bacaMarkerPosisi(nilaiMarker);
  eq('penanda baris 2 ditemukan', posisi['rec-1'], 2);
  eq('penanda baris 4 ditemukan', posisi['rec-2'], 4);
  eq('baris kosong dilewati', Object.keys(posisi).length, 2);
  eq('sheet kosong aman', lib.bacaMarkerPosisi(undefined), {});

  // --- penanda harus di-update, bukan append ------------------------------
  // Ini pagar untuk bug yang pernah ada: update memakai `values.append`, jadi
  // sheet Mirror tumbuh satu baris tiap kali record diperbarui dan tidak pernah
  // berhenti.
  const legacyAwal = [['No', 'usia'], ['1', '20'], ['2', '30']];
  const markerAwal = [
    mirror.HEADER_MIRROR,
    ['rec-1', '1', 'hash-a', '1', 'waktu-1'],
    ['rec-2', '1', 'hash-lama', '2', 'waktu-1'],
  ];
  const fakeA = sheetsPalsu({ Mirror: markerAwal, Sheet1: legacyAwal });
  const { tercermin, posisiMarker, barisTerakhir } = await lib.bacaSheet(fakeA);
  eq('tercermin terbaca dari Mirror', Object.keys(tercermin).length, 2);
  eq('baris terakhir legacy terbaca', barisTerakhir, 2);

  const recordBaru = {
    record_id: 'rec-2',
    version: 2,
    record_hash: 'hash-baru',
    status: 'active',
    payload: { usia: '31' },
  };
  const rencana = mirror.rencanaMirror([recordBaru], tercermin, FIELD_ORDER, barisTerakhir);
  lib.pasangkanPosisiMarker(rencana, posisiMarker);

  eq('rencana berisi perbarui', rencana.perbarui.length, 1);
  eq('baris penanda terpasang', rencana.perbarui[0].markerBaris, 3);
  eq('baris legacy dari kolom no', rencana.perbarui[0].baris, 3);

  fakeA.panggilan.length = 0;
  const n = await lib.terapkan(fakeA, rencana, 'waktu-baru');
  eq('satu baris legacy ditulis', n, 1);
  const updateLegacy = fakeA.panggilan.filter((c) => c.op === 'update');
  eq('legacy pakai update, bukan append', updateLegacy.length, 1);
  eq('range legacy baris 3', updateLegacy[0].range, 'Sheet1!A3:' + lib.kolomKe(FIELD_ORDER.length + 1) + '3');
  eq('nomor legacy dipertahankan', updateLegacy[0].values[0][0], 2);

  fakeA.panggilan.length = 0;
  const hasilMarker = await lib.tulisMarker(fakeA, rencana, 'waktu-baru');
  eq('satu penanda diperbarui', hasilMarker.diperbarui, 1);
  eq('tidak ada penanda baru', hasilMarker.baru, 0);
  const updateMarker = fakeA.panggilan.filter((c) => c.op === 'update');
  eq('penanda ditulis dengan update', updateMarker.length, 1);
  eq('bukan append', fakeA.panggilan.filter((c) => c.op === 'append').length, 0);
  eq('range penanda baris 3', updateMarker[0].range, 'Mirror!A3:E3');
  eq('versi penanda ikut naik', Number(updateMarker[0].values[0][1]), 2);
  eq('hash penanda ikut naik', updateMarker[0].values[0][2], 'hash-baru');

  // --- record baru boleh append ------------------------------------------
  const rencanaBaru = mirror.rencanaMirror(
    [{ record_id: 'rec-9', version: 1, record_hash: 'h9', status: 'active', payload: {} }],
    tercermin,
    FIELD_ORDER,
    barisTerakhir
  );
  lib.pasangkanPosisiMarker(rencanaBaru, posisiMarker);
  const fakeB = sheetsPalsu({ Mirror: markerAwal, Sheet1: legacyAwal });
  await lib.terapkan(fakeB, rencanaBaru, 'waktu-baru');
  const appendLegacy = fakeB.panggilan.filter((c) => c.op === 'append');
  eq('record baru di-append ke legacy', appendLegacy.length, 1);
  eq('satu baris saja', appendLegacy[0].values.length, 1);
  eq('jumlah sel legacy benar', appendLegacy[0].values[0].length, FIELD_ORDER.length + 1);
  eq('nomor baru 3', appendLegacy[0].values[0][0], 3);

  // --- redacted: legacy dikosongkan, No tetap ----------------------------
  const rencanaRedact = mirror.rencanaMirror(
    [{ record_id: 'rec-1', version: 2, record_hash: 'h-red', status: 'redacted', payload: {} }],
    tercermin,
    FIELD_ORDER,
    barisTerakhir
  );
  lib.pasangkanPosisiMarker(rencanaRedact, posisiMarker);
  eq('rencana mengosongkan', rencanaRedact.kosongkan.length, 1);
  const fakeC = sheetsPalsu({ Mirror: markerAwal, Sheet1: legacyAwal });
  await lib.terapkan(fakeC, rencanaRedact, 'waktu-baru');
  const kosong = fakeC.panggilan.filter((c) => c.op === 'update');
  eq('legacy ditulis mengosong', kosong.length, 1);
  eq('range baris no=1 -> baris 2', kosong[0].range, 'Sheet1!A2:' + lib.kolomKe(FIELD_ORDER.length + 1) + '2');
  eq('nomor No dipertahankan', kosong[0].values[0][0], 1);
  eq('seluruh kolom lain kosong', kosong[0].values[0].slice(1).every((v) => v === ''), true);

  fakeC.panggilan.length = 0;
  const hasilRedact = await lib.tulisMarker(fakeC, rencanaRedact, 'waktu-baru');
  eq('penanda redacted ikut diperbarui', hasilRedact.diperbarui, 1);
  eq('penanda redacted bukan append', fakeC.panggilan.filter((c) => c.op === 'append').length, 0);
  const updateRedact = fakeC.panggilan.filter((c) => c.op === 'update');
  // Baris penanda harus mengikuti `no` di sheet Mirror, bukan posisi baru di
  // akhir. Menempelkan penanda redacted di baris lain berarti penanda lama tetap
  //ihi version lama, dan record redacted akan dikosongkan ulang tiap run.
  eq('range penanda redacted', updateRedact[0].range, 'Mirror!A2:E2');
  eq('versi penanda redacted', Number(updateRedact[0].values[0][1]), 2);
  eq('hash penanda redacted', updateRedact[0].values[0][2], 'h-red');
  eq('nomor penanda redacted', Number(updateRedact[0].values[0][3]), 1);

  // --- tab Mirror belum ada harus dibuat ---------------------------------
  const fakeD = sheetsPalsu({ Sheet1: legacyAwal });
  const dibuat = await lib.pastikanMarker(fakeD);
  eq('tab Mirror dilaporkan dibuat', dibuat, true);
  const add = fakeD.panggilan.filter((c) => c.op === 'batchUpdate');
  eq('addSheet dipanggil', add.length, 1);
  eq('judul tab benar', add[0].requests[0].addSheet.properties.title, 'Mirror');

  // --- tab Mirror sudah ada: jangan buat lagi ----------------------------
  const fakeE = sheetsPalsu({ Mirror: [mirror.HEADER_MIRROR], Sheet1: legacyAwal });
  eq('tab yang ada tidak dibuat ulang', await lib.pastikanMarker(fakeE), false);
  eq('tidak ada addSheet', fakeE.panggilan.filter((c) => c.op === 'batchUpdate').length, 0);

  // --- galat lain bukan berarti "tab tidak ada" --------------------------
  const sheetsGalat = {
    spreadsheets: {
      values: { async get() { throw new Error('Request contains an invalid argument'); } },
      async get() { throw new Error('tidak boleh dipanggil'); },
      async batchUpdate() { throw new Error('tidak boleh dipanggil'); },
    },
  };
  let jebakan = null;
  try { await lib.pastikanMarker(sheetsGalat); } catch (e) { jebakan = e; }
  ok('galat izin tidak ditelan sebagai "tab tidak ada"', jebakan !== null);
  eq('alasannya bukan tab hilang', /invalid argument/i.test(jebakan.message), true);

  // --- kolomKe ----------------------------------------------------------
  eq('kolom 1 = A', lib.kolomKe(1), 'A');
  eq('kolom 26 = Z', lib.kolomKe(26), 'Z');
  eq('kolom 27 = AA', lib.kolomKe(27), 'AA');
  eq('kolom FIELD_ORDER+1', lib.kolomKe(FIELD_ORDER.length + 1), 'BU');
  eq('kolom 69 = BQ', lib.kolomKe(69), 'BQ');

  // --- penomoran tidak menimpa baris TPK --------------------------------
  eq('baris terakhir dari kolom No', lib.hitungBarisTerakhir([['No'], ['5'], ['7'], ['9']]), 9);
  eq('nomor nonnumerik dilewati', lib.hitungBarisTerakhir([['No'], ['abc'], ['4']]), 4);
  eq('sheet kosong -> 0', lib.hitungBarisTerakhir(undefined), 0);
}

ujiWorker().catch((e) => {
  failed++;
  console.log('GAGAL  uji worker melempar galat');
  console.log('        ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  console.log('lulus: ' + passed + '   gagal: ' + failed);
  process.exit(1);
}).then(() => {
  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nADA YANG RUSAK. Jangan andalkan mirror sebelum ini hijau.');
    process.exit(1);
  } else {
    console.log('\nSEMUA UJI LOLOS');
  }
});
