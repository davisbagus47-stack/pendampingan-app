'use strict';

/**
 * Uji F3.10c-2: proyeksi kolom eksplisit + FIELD_NOT_GRANTED (FR-4.20a..c).
 *
 * Yang diuji: daftar SELECT tidak pernah memuat kolom terlarang atau `*`, dan
 * permintaan eksplisit ditolak dengan kode yang PRD sebutkan.
 *
 * Yang TIDAK diuji: RLS itu sendiri. Kolom terlarang ditegakkan di database;
 * modul ini menentukan daftar SELECT yang dipanggil RLS, dan menguji daftar
 * itu bukan berarti menguji Postgres. Bukti F1.8a tetap terpisah.
 *
 * Setiap aturan PRD punya penjaga yang gagal kalau aturan itu dilanggar, bukan
 * sekadar membandingkan nilai yang sama dengan dirinya sendiri. Kalau blokir
 * tidak ditegakkan, uji ini harus memerah -- bukan tetap hijau karena tidak
 * ada yang berubah.
 */

const path = require('path');
const app = require(path.join(__dirname, '..', 'index.js'));
const cg = require(path.join(__dirname, '..', 'lib', 'column-grants.js'));

const { FIELD_ORDER, LABELS } = app;

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

function throws(name, fn) {
  try {
    fn();
    failed++;
    console.log('GAGAL  ' + name + '  (tidak melempar galat)');
  } catch (e) {
    passed++;
    console.log('LULUS  ' + name + '  (' + e.message.slice(0, 64) + ')');
  }
}

/** Tangkap kode galat, bukan pesannya. Ini yang dilihat klien. */
function kode(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code || null;
  }
}

console.log('=== 1. Daftar bawaan sesuai PRD 6.4.1a ===');

{
  eq('lima kolom diblokir keras', cg.DENIED_BAWAAN.slice().sort(),
    ['catatanTPK', 'namaAyah', 'namaIbu', 'nikAyah', 'nikIbu']);

  // Semua nama bawaan harus benar-benar ada di FIELD_ORDER. Kalau form berubah
  // dan salah satu nama hilang, blokirnya jadi tidak berlaku tanpa galat -- yang
  // persis hasil terburuk: blokir terlihat aktif padahal tidak berlaku.
  for (const f of cg.DENIED_BAWAAN) {
    ok('"' + f + '" ada di FIELD_ORDER', FIELD_ORDER.includes(f));
  }

  eq('nama kolom SQL sesuai DDL', cg.deniedColumnKeys(FIELD_ORDER),
    ['catatan_tpk', 'nama_ayah', 'nama_ibu', 'nik_ayah', 'nik_ibu']);
}

// ===========================================================================

console.log('\n=== 2. Proyeksi kolom: yang terlihat dan yang tidak ===');

{
  const visible = cg.visibleFields(FIELD_ORDER);
  eq('72 dikurangi 5 = 67 kolom terlihat', visible.length, 67);
  ok('tidak ada kolom terlarang yang lolos',
    cg.DENIED_BAWAAN.every((f) => !visible.includes(f)));
  ok('urutan FIELD_ORDER dipertahankan',
    JSON.stringify(visible) === JSON.stringify(FIELD_ORDER.filter((f) => !cg.DENIED_BAWAAN.includes(f))));
  eq('kolom yang bukan terlarang tetap ada', visible.includes('nik'), true);
  eq('kolom bebas tidak ikut hilang', visible.includes('namaLengkap'), true);
}

// ===========================================================================

console.log('\n=== 3. FR-4.20c: SELECT eksplisit, tanpa SELECT * ===');

{
  const daftar = cg.selectList(FIELD_ORDER, null).split(', ');
  eq('7 metadata + 67 payload', daftar.length, 74);
  ok('tidak ada wildcard', !daftar.some((c) => c.includes('*')));

  for (const f of cg.DENIED_BAWAAN) {
    ok('SELECT tidak memuat ' + f, !daftar.includes(f));
  }

  // Metadata yang wajib ada untuk verifikasi commitment (FR-4.3, F3.8).
  // Menghilangkan institution_id atau record_hash dari respons membuat klien
  // tidak bisa memeriksa commitment -- jadi ini bug, bukan penyederhanaan.
  for (const m of ['record_id', 'record_hash', 'institution_id', 'version', 'schema_version']) {
    ok('SELECT memuat metadata ' + m, daftar.includes(m));
  }

  // Kolom yang tidak ada di katalog harus tidak mungkin masuk.
  ok('kolom tak dikenal tidak masuk SELECT',
    !daftar.includes('drop_table') && !daftar.includes('id_besar'));

  // Penjaga eksplisit: assertNoStar menolak wildcard.
  throws('assertNoStar menolak *', () => cg.assertNoStar(['record_id', '*']));
  throws('assertNoStar menolak table.*', () => cg.assertNoStar(['r.*']));
  ok('assertNoStar menerima daftar biasa',
    cg.assertNoStar(['record_id', 'nik']).length === 2);
}

// ===========================================================================

console.log('\n=== 4. FR-4.20a: permintaan eksplisit ditolak FIELD_NOT_GRANTED ===');

{
  eq('fields=null berarti semua, tidak digagalkan',
    kode(() => cg.assertFieldsAllowed(null, FIELD_ORDER, null)), null);

  eq('fields=[] berarti tidak ada kolom, tidak digagalkan',
    kode(() => cg.assertFieldsAllowed([], FIELD_ORDER, null)), null);

  eq('kolom terlarang ditolak', kode(() => cg.assertFieldsAllowed(['catatanTPK'], FIELD_ORDER, null)),
    'FIELD_NOT_GRANTED');
  eq('semua kolom bawaan ditolak',
    cg.DENIED_BAWAAN.map((f) => kode(() => cg.assertFieldsAllowed([f], FIELD_ORDER, null))),
    cg.DENIED_BAWAAN.map(() => 'FIELD_NOT_GRANTED'));

  // Ganti garis bawah jadi huruf besar harus tetap tertangkap.
  // Kalau hanya nama camel yang dicek, blokir bisa dilewati dengan mengetik
  // `catatan_tpk` -- nama yang justru muncul di respons SQL.
  eq('nama kolom SQL juga ditolak', kode(() => cg.assertFieldsAllowed(['catatan_tpk'], FIELD_ORDER, null)),
    'FIELD_NOT_GRANTED');
  eq('campuran huruf besar ditolak', kode(() => cg.assertFieldsAllowed(['CATATAN_TPK'], FIELD_ORDER, null)),
    'FIELD_NOT_GRANTED');
  eq('dengan spasi di tepi ditolak', kode(() => cg.assertFieldsAllowed(['  catatanTPK  '], FIELD_ORDER, null)),
    'FIELD_NOT_GRANTED');

  // Kode harus dikembalikan sebagai field terpisah supaya lapisan HTTP tidak
  // perlu parsing pesan.
  let err = null;
  try {
    cg.assertFieldsAllowed(['nikAyah', 'catatanTPK'], FIELD_ORDER, null);
  } catch (e) {
    err = e;
  }
  eq('galat punya kode', err.code, 'FIELD_NOT_GRANTED');
  eq('galat punya HTTP 403', err.status, 403);
  eq('galat sebut semua kolom terlarang', err.fields.slice().sort(), ['catatanTPK', 'nikAyah']);
  ok('pesan menyebut FR-4.20a', /FR-4\.20a/.test(err.message));
  ok('pesan tidak membocorkan isi kolom terlarang',
    !/catatan bebas operator/i.test(err.message));

  // Kolom asing bukan kolom terlarang. Bedanya penting: satu berarti "tidak
  // ada", yang lain berarti "ada tapi tidak berhak".
  eq('kolom tak dikenal punya kode sendiri',
    kode(() => cg.assertFieldsAllowed(['budi'], FIELD_ORDER, null)), 'FIELD_UNKNOWN');
  let errAsing = null;
  try {
    cg.assertFieldsAllowed(['budi'], FIELD_ORDER, null);
  } catch (e) {
    errAsing = e;
  }
  eq('kolom asing HTTP 400', errAsing.status, 400);

  // Kolom yang ada dan BOLEH diminta tidak boleh ditolak.
  eq('kolom yang diizinkan lolos',
    kode(() => cg.assertFieldsAllowed(['nik', 'namaLengkap'], FIELD_ORDER, null)), null);

  throws('fields bukan array ditolak TypeError',
    () => cg.assertFieldsAllowed('nik', FIELD_ORDER, null));

  // Urutan tidak boleh memengaruhi hasil.
  eq('urutan fields tidak berpengaruh',
    kode(() => cg.assertFieldsAllowed(['namaLengkap', 'catatanTPK'], FIELD_ORDER, null)),
    'FIELD_NOT_GRANTED');
}

// ===========================================================================

console.log('\n=== 5. Denial tambahan instansi ===');

{
  // Admin boleh menambah blokir sendiri. Bawaan tidak boleh bisa dilepas:
  // daftar tambahan bersifat menambah, bukan mengganti.
  const tambahan = ['alamat', 'noHp'];
  const blokir = cg.deniedSet(FIELD_ORDER, tambahan);
  eq('tambahan menambah, tidak mengganti', blokir.size, 7);
  ok('bawaan masih ada setelah tambahan diberikan',
    cg.DENIED_BAWAAN.every((f) => blokir.has(f)));

  // Upaya melepas blokir bawaan lewat daftar tambahan yang "sebenarnya" daftar
  // lengkap kolom: bawaan harus tetap berlaku.
  const semuaKolom = FIELD_ORDER.slice();
  const blokirPenuh = cg.deniedSet(FIELD_ORDER, semuaKolom);
  eq('daftar tambahan berisi semua kolom tetap menyisakan bawaan',
    blokirPenuh.size >= 5, true);
  ok('dan tidak ada kolom yang lolos',
    cg.visibleFields(FIELD_ORDER, blokirPenuh).length === 0);

  // Nama asing dibuang, bukan disimpan -- sehingga tidak bisa dipakai sebagai
  // bypass lewat daftar tambahan yang salah ketik.
  const asing = cg.deniedSet(FIELD_ORDER, ['kolom_hantu']);
  eq('nama asing tidak menambah apa pun', asing.size, 5);
  ok('kolom_hantu tidak masuk blokir', !asing.has('kolom_hantu'));

  eq('deniedColumnKeys menerima nama SQL',
    cg.deniedColumnKeys(FIELD_ORDER, ['catatan_tpk', 'alamat']),
    ['alamat', 'catatan_tpk', 'nama_ayah', 'nama_ibu', 'nik_ayah', 'nik_ibu']);

  // selectList harus ikut daftar tambahan, bukan hanya bawaan.
  const select = cg.selectList(FIELD_ORDER, tambahan).split(', ');
  ok('alamat tidak masuk SELECT', !select.includes('alamat'));
  eq('tambahan mengurangi kolom terlihat',
    cg.visibleFields(FIELD_ORDER, tambahan).length, 65);
}

// ===========================================================================

console.log('\n=== 6. FR-4.20b: semua format ikut diblokir ===');

{
  const baris = {};
  for (const f of FIELD_ORDER) baris[f] = 'nilai-' + f;

  // JSON: jalur filter baris.
  const json = cg.filterRow(baris, FIELD_ORDER, null);
  for (const f of cg.DENIED_BAWAAN) {
    ok('JSON tidak memuat ' + f, !(f in json));
  }
  ok('JSON tak punya kunci kolom terlarang sama sekali',
    !JSON.stringify(json).includes('catatanTPK'));

  // CSV dan XLSX: keduanya dibangun dari header + exportRow. Keduanya harus
  // punya jumlah kolom sama dan tidak boleh memuat kolom terlarang.
  const header = cg.exportHeader(FIELD_ORDER, LABELS, null);
  const row = cg.exportRow(baris, FIELD_ORDER, null);
  eq('CSV/XLSX header dan baris sama panjang', header.length, row.length);
  eq('jumlah kolom ekspor', header.length, 67);

  for (const f of cg.DENIED_BAWAAN) {
    ok('header ekspor tidak memuat ' + f, !header.includes(LABELS[f]));
  }
  ok('nilai kolom terlarang tidak ikut terekspor',
    !row.some((cell) => String(cell).includes('nilai-catatanTPK')));

  // Baris kedua harus punya bentuk sama -- CSV/XLSX tidak bisa punya
  // "kolom hilang di tengah".
  const rowKosong = cg.exportRow({}, FIELD_ORDER, null);
  eq('baris kosong tetap_sejumlah kolom', rowKosong.length, 67);
  ok('sel kosong jadi string kosong, bukan "null" atau "undefined"',
    rowKosong.every((c) => c === ''));

  // Header harus berlabel manusia, bukan column_key.
  ok('header memakai label form', header.includes('Nama Petugas TPK'));
  ok('header tidak memakai column_key', !header.includes('nama_tpk'));

  // Baris dibaca dengan kunci kolom SQL harus tetap bisa diekspor.
  const barisSql = {};
  for (const f of FIELD_ORDER) barisSql[require(path.join(__dirname, '..', 'lib', 'field-types.js')).columnName(f)] = 'sql-' + f;
  const rowSql = cg.exportRow(barisSql, FIELD_ORDER, null);
  eq('baris berkunci SQL diekspor dengan benar', rowSql.length, 67);
  ok('nilai dari kunci SQL terbaca', rowSql.includes('sql-namaTPK'));
  ok('kolom terlarang tetap tersaring pada baris berkunci SQL',
    !rowSql.some((c) => String(c).includes('sql-catatanTPK')));

  // filterRows untuk banyak baris.
  const banyak = cg.filterRows([baris, baris], FIELD_ORDER, null);
  eq('filterRows jumlah baris utuh', banyak.length, 2);
  ok('semua baris bersih', banyak.every((r) => !('catatanTPK' in r)));

  // filterRow juga harus MEMBUANG kolom yang tidak diminta. Regresi nyata:
  // filterRow dulu hanya memeriksa blokir, jadi `?fields=nik` tetap
  // mengembalikan 67 kolom dan parameter itu tidak berguna. Uji ini menggigit
  // kalau ada yang mengembalikan filterRow ke sifat lama.
  const satu = cg.filterRow(baris, FIELD_ORDER, null, ['nik']);
  eq('filterRow menghormati fields', Object.keys(satu), ['nik']);
  eq('filterRows menghormati fields',
    cg.filterRows([baris], FIELD_ORDER, null, ['nik', 'namaLengkap'])[0],
    { nik: 'nilai-nik', namaLengkap: 'nilai-namaLengkap' });
  eq('fields kosong berarti tidak ada kolom', Object.keys(cg.filterRow(baris, FIELD_ORDER, null, [])), []);
}

// ===========================================================================

console.log('\n=== 7. Ekspor dengan fields= eksplisit ===');

{
  const baris = { nik: '3201234567890', namaLengkap: 'Sari', catatanTPK: 'rahasia' };

  const header = cg.exportHeader(FIELD_ORDER, LABELS, null, ['nik', 'namaLengkap']);
  eq('hanya dua kolom diekspor', header, ['NIK', 'Nama Lengkap']);

  const row = cg.exportRow(baris, FIELD_ORDER, null, ['nik', 'namaLengkap']);
  eq('nilainya sesuai', row, ['3201234567890', 'Sari']);

// Urutan respons tidak boleh bergantung urutan parameter. Klien yang mengirim
    // fields dalam urutan acak harus mendapat kolom dalam urutan FIELD_ORDER,
    // supaya dua klien dengan query berbeda tidak melihat urutan berbeda.
    eq('urutan fields dibalik -> urutan tetap (FIELD_ORDER)',
      cg.exportRow(baris, FIELD_ORDER, null, ['namaLengkap', 'nik']), ['3201234567890', 'Sari']);
    eq('dan daftar SELECT juga ikut urutan FIELD_ORDER',
      cg.selectList(FIELD_ORDER, null, ['namaLengkap', 'nik']),
      cg.META_COLUMNS.concat(['nik', 'nama_lengkap']).join(', '));

  eq('export dengan kolom terlarang ditolak',
    kode(() => cg.exportHeader(FIELD_ORDER, LABELS, null, ['catatanTPK'])), 'FIELD_NOT_GRANTED');
  eq('exportRow juga menolak',
    kode(() => cg.exportRow(baris, FIELD_ORDER, null, ['nik', 'nama_ibu'])), 'FIELD_NOT_GRANTED');
  eq('export dengan kolom asing ditolak',
    kode(() => cg.exportRow(baris, FIELD_ORDER, null, ['hantu'])), 'FIELD_NOT_GRANTED');
}

// ===========================================================================

console.log('\n=== 8. Normalisasi nama kolom ===');

{
  eq('nama FIELD_ORDER diteruskan', cg.normalizeColumnKey('nik', FIELD_ORDER), 'nik');
  eq('nama kolom SQL dipetakan balik', cg.normalizeColumnKey('nama_tpk', FIELD_ORDER), 'namaTPK');
  eq('override mbg3b dipetakan', cg.normalizeColumnKey('mbg3b', FIELD_ORDER), 'mbg3B');
  // Pencocokan tidak membedakan huruf besar-kecil. Untuk kolom terlarang itu
  // justru bagus: `CATATAN_TPK` harus tertangkap sama seperti
  // `catatanTPK`, bukan lolos hanya karena beda ejaan.
  eq('huruf besar diteruskan ke field yang sama', cg.normalizeColumnKey('NIK', FIELD_ORDER), 'nik');
  eq('huruf besar kolom terlarang diteruskan', cg.normalizeColumnKey('CATATAN_TPK', FIELD_ORDER), 'catatanTPK');

  // Syarat agar aman: columnName harus memetakan 72 field ke 72 nama unik.
  // Kalau ada dua field yang jadi satu nama, klien yang salah pilih akan
  // mendapat data kolom lain -- kebocoran, bukan sekadar bug tampilan.
  const ft = require(path.join(__dirname, '..', 'lib', 'field-types.js'));
  const namaUnik = new Set(FIELD_ORDER.map(ft.columnName));
  eq('columnName memetakan 72 field ke 72 nama unik', namaUnik.size, FIELD_ORDER.length);

  // Dan tidak ada nama kolom yang sama setelah dilipat huruf kecil, karena
  // pencocokan mengabaikan huruf besar.
  const namaLower = new Set(FIELD_ORDER.map((f) => ft.columnName(f).toLowerCase()));
  eq('nama kolom unik juga setelah dilipat huruf kecil', namaLower.size, FIELD_ORDER.length);
  eq('string kosong jadi null', cg.normalizeColumnKey('', FIELD_ORDER), null);
  eq('undefined jadi null', cg.normalizeColumnKey(undefined, FIELD_ORDER), null);
  eq('nama asing jadi null', cg.normalizeColumnKey('drop', FIELD_ORDER), null);
}

// ===========================================================================

console.log('\n=== 9. selectList tidak bisa dipanggil tanpa penjaga ===');

{
  // selectList harus menjadi satu-satunya jalan ke SQL, dan harus menolak
  // kolom terlarang bahkan dipanggil tanpa assertFieldsAllowed lebih dulu.
  eq('selectList menolak kolom terlarang tanpa assert',
    kode(() => cg.selectList(FIELD_ORDER, null, ['catatanTPK'])), 'FIELD_NOT_GRANTED');
  eq('selectList menolak kolom asing tanpa assert',
    kode(() => cg.selectList(FIELD_ORDER, null, ['hantu'])), 'FIELD_NOT_GRANTED');

  const daftar = cg.selectList(FIELD_ORDER, null, ['nik']).split(', ');
  ok('kolom tak diminta tidak ikut', !daftar.includes('nama_tpk'));
  eq('hanya metadata + satu kolom', daftar.length, 8);
}

// ===========================================================================

console.log('\n=== 10. Ringkasan tidak membocorkan daftar terlarang ===');

{
  const r = cg.ringkasan(FIELD_ORDER, null);
  eq('jumlah kolom terlihat', r.visible_count, 67);
  eq('jumlah kolom terlarang', r.denied_count, 5);
  eq('ringkasan tidak menyebut kolom terlarang',
    r.visible.some((f) => cg.DENIED_BAWAAN.includes(f)), false);
  ok('tidak ada field denied_names di ringkasan', !('denied_names' in r));
}

// ===========================================================================

console.log('\n=== 11. Katalog dan DDLXG agrees ===');

{
  // Modul ini dan DDL harus sepakat soal nama kolom. Kalau generate-schema
  // mengubah nama kolom, blokir yang dihitung dari camelCase bisa meleset --
  // dan yang salah adalah kolom yang DILETAKKAN, bukan yang dilindungi.
  const fs = require('fs');
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', '001_schema.sql'), 'utf8');
  for (const key of cg.deniedColumnKeys(FIELD_ORDER)) {
    ok('kolom terlarang ada di DDL: ' + key, ddl.includes('\n  ' + key + ' '));
  }
  const { columnName } = require(path.join(__dirname, '..', 'lib', 'field-types.js'));
  for (const f of cg.visibleFields(FIELD_ORDER).slice(0, 20)) {
    ok('kolom terlihat ada di DDL (sampel): ' + f, ddl.includes('\n  ' + columnName(f) + ' '));
  }
}

// ===========================================================================

console.log('\n=== 12. Daftar SELECT siap pakai untuk query ===');

{
  // Bentuk yang dipakai lapisan database: eksplisit dan bisa dibaca manusia.
  const sql = 'SELECT ' + cg.selectList(FIELD_ORDER, null, ['nik', 'namaLengkap']) +
    ' FROM records WHERE institution_id = $1';
  ok('query tidak memuat SELECT *', !/\*\s*FROM/.test(sql));
  ok('query menyebut kolom yang diminta', sql.includes('nik, nama_lengkap'));
  ok('query tidak memuat kolom terlarang', !sql.includes('catatan_tpk'));
  ok('query memuat record_id untuk commit', sql.includes('record_id'));
  ok('query memuat record_hash untuk verifikasi', sql.includes('record_hash'));
  ok('query memuat institution_id untuk FR-4.3', sql.includes('institution_id'));
}

// ===========================================================================

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK. Jangan_andalkan blokir kolom sebelum ini hijau.');
  process.exit(1);
} else {
  console.log('\nSEMUA UJI LOLOS');
}
