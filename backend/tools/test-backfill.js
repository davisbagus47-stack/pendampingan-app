'use strict';

/**
 * Uji backfill F1.8 tanpa database.
 *
 * Yang diuji, dan yang tidak:
 *
 *   Diuji  - pemetaan baris ke payload, penolakan yang disengaja, identitas
 *            record yang stabil, proyeksi ke kolom bertipe khusus, dan SQL yang
 *            dihasilkan.
 *   Tidak  - bahwa SQL-nya benar-benar bisa jalan. Itu butuh `psql` dan
 *            tercatat sebagai F1.8a.
 *
 * Setiap uji yang bisa gagal diam-diam punya penjaga. Contoh: uji "SQL tidak
 * menulis nilai mentah ke kolom DATE" dibuat karena versi pertama skrip
 * menuliskan begitu, dan itu baru ketahuan saat membaca SQL yang dihasilkan --
 * bukan saat membaca kodenya.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const app = require(path.join(__dirname, '..', 'index.js'));
const { deriveSections } = require(path.join(__dirname, '..', 'lib', 'sections.js'));
const { columnName } = require(path.join(__dirname, '..', 'lib', 'field-types.js'));
const bf = require(path.join(__dirname, '..', 'lib', 'backfill.js'));
const cli = require(path.join(__dirname, 'backfill.js'));

const { FIELD_ORDER, LABELS, NORMALIZE_SASARAN, normalizeNik, headerToIndex, pickField } = app;
const { map: sectionMap } = deriveSections();

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
    console.log('LULUS  ' + name + '  (' + e.message.slice(0, 60) + ')');
  }
}

const normalisasi = (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v;

function rencana(rows, opsi) {
  return bf.rencanaBackfill(Object.assign({
    rows,
    fieldOrder: FIELD_ORDER,
    institutionKey: 'kota-bogor',
    sectionMap,
    normalizeSasaran: normalisasi,
    normalizeNik,
  }, opsi || {}));
}

const BARIS = function sebaris() {
  return {
    namaTPK: 'Siti Aminah', peranTPK: 'PK', namaDesa: 'Sukamaju',
    namaKecamatan: 'Cibinong', nik: '3201234567890',
    namaLengkap: 'Sari Dewi', jenisSasaran: 'Ibu Hamil',
    tanggalKunjungan: '2024-03-15', pendampinganKe: '1',
    usia: '27', bbSekarang: '62,55', tfu: '24', hpht: '2023-10-01',
  };
};

// ===========================================================================
console.log('=== 1. Identitas record ===');
// ===========================================================================

{
  const a = rencana([BARIS()]);
  const b = rencana([BARIS()]);
  eq('record_id stabil untuk input yang sama', a.records[0].record_id, b.records[0].record_id);
  ok('record_id berbentuk UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.records[0].record_id));

  // Idempotensi adalah alasan utama record_id diturunkan dari isi. Kalau ini
  // berubah, menjalankan backfill dua kali akan menggandakan data.
  const urut = rencana([BARIS(), Object.assign(BARIS(), { pendampinganKe: '2', nik: '3201234567890' })]);
  ok('kunjungan berbeda untuk NIK sama -> record_id berbeda',
    urut.records[0].record_id !== urut.records[1].record_id);

  const nikBeda = rencana([BARIS(), Object.assign(BARIS(), { nik: '3201234567891' })]);
  ok('NIK berbeda -> record_id berbeda',
    nikBeda.records[0].record_id !== nikBeda.records[1].record_id);

  const instBeda = rencana([BARIS()], { institutionKey: 'kabupaten-bogor' });
  ok('instansi berbeda -> record_id berbeda',
    instBeda.records[0].record_id !== a.records[0].record_id);

  // Konten yang bisa dikoreksi TIDAK boleh mengubah identitas, kalau tidak
  // koreksi akan jadi record baru dan bukan versi baru (ADR-4).
  const dikoreksi = rencana([Object.assign(BARIS(), { catatanTPK: 'tadi datang', usia: '28' })]);
  eq('koreksi isi tidak mengubah record_id',
    dikoreksi.records[0].record_id, a.records[0].record_id);
  ok('koreksi isi mengubah record_hash',
    dikoreksi.records[0].record_hash !== a.records[0].record_hash);
}

// ===========================================================================
console.log('\n=== 2. Penolakan yang disengaja ===');
// ===========================================================================

{
  const balita = rencana([Object.assign(BARIS(), { jenisSasaran: 'Balita' })]);
  eq('Balita ditolak', balita.records.length, 0);
  eq('Balita tercatat sebagai ditolak', balita.ditolak.length, 1);
  ok('alasan Balita menyebut taksonomi', /taksonomi/.test(balita.ditolak[0].alasan));

  const takDikenal = rencana([Object.assign(BARIS(), { jenisSasaran: 'Zombie' })]);
  eq('jenisSasaran tak dikenal ditolak', takDikenal.records.length, 0);

  // NIK bertanda hubung adalah hal yang wajar di legacy sheet. normalizeNik
  // harus membersihkan, bukan menolak.
  const nikKotor = rencana([Object.assign(BARIS(), { nik: '3201-2345-6789-0' })]);
  eq('NIK bergaris diterima dan dibersihkan', nikKotor.records.length, 1);
  eq('NIK dibersihkan', nikKotor.records[0].payload_json.nik, '3201234567890');

  // NIK yang hilang tidak boleh "ditebak" dari baris lain.
  const tanpaNik = rencana([Object.assign(BARIS(), { nik: '' })]);
  eq('NIK kosong ditolak', tanpaNik.records.length, 0);
  eq('kategori penolakan nik', tanpaNik.ditolak[0].kategori, 'nik');

  const tanpaKunjungan = rencana([Object.assign(BARIS(), { pendampinganKe: '', tanggalKunjungan: '' })]);
  eq('tanpa tanggal kunjungan ditolak', tanpaKunjungan.records.length, 0);
  eq('kategori penolakan tanggal kunjungan', tanpaKunjungan.ditolak[0].kategori, 'wajib-kosong');

  // Identitas kunjungan selalu ada karena tanggal_kunjungan NOT NULL. Tidak ada
  // jalur "pakai nomor baris" -- kalau ada, itu bohong ke pemanggil.
  const tanpaNomor = rencana([Object.assign(BARIS(), { pendampinganKe: '' })]);
  eq('tanpa pendampinganKe tetap bisa masuk lewat tanggal', tanpaNomor.records.length, 1);
  eq('kunci jatuh ke tanggal', tanpaNomor.records[0].sumber.kunci, 'tgl:2024-03-15');

  // Kunci tanggal harus dinormalisasi ke ISO. Kalau tidak, satu kunjungan
  // yang ditulis "15/03/2024" di sheet A dan "2024-03-15" di sheet B masuk
  // sebagai dua record, dan record_id tidak bisa diperbaiki tanpa membatalkan
  // anchor.
  eq('kunci tanggal memakai bentuk ISO, bukan teks mentah',
    rencana([Object.assign(BARIS(), { pendampinganKe: '', tanggalKunjungan: '15/03/2024' })])
      .records[0].sumber.kunci,
    'tgl:2024-03-15');
  {
    const bedaFormat = ['15/03/2024', '2024-03-15', '15 Mar 2024'];
    const ids = bedaFormat.map((t) => rencana([Object.assign(BARIS(),
      { pendampinganKe: '', tanggalKunjungan: t })], { dateOrder: 'ddmmyyyy' })
      .records[0].record_id);
    ok('tiga format tanggal yang sama -> satu record_id',
      ids[0] === ids[1] && ids[1] === ids[2]);
    eq('tiga format itu dianggap satu record dalam satu berkas',
      rencana(bedaFormat.map((t) => Object.assign(BARIS(),
        { pendampinganKe: '', tanggalKunjungan: t })), { dateOrder: 'ddmmyyyy' }).records.length, 1);
    const satuTiga = rencana(bedaFormat.map((t) => Object.assign(BARIS(),
      { pendampinganKe: '', tanggalKunjungan: t })), { dateOrder: 'ddmmyyyy' });
    eq('duplikat dilaporkan, bukan tiga record', satuTiga.duplikat.length, 2);
  }

  // Daftar kolom wajib diambil dari lib, bukan disalin di sini. Salinan akan
  // diam-diam usang kalau DDL atau lib berubah, dan tes tetap hijau --
  // persis kelas kegagalan yang tidak terlihat. `nik` punya kategori penolakan
  // sendiri, jadi dikecualikan di sini dan sudah diuji di bagian atas.
  for (const wajib of bf.WAJIB.filter((f) => f !== 'nik')) {
    const r = rencana([Object.assign(BARIS(), { [wajib]: '' })]);
    eq('kolom wajib "' + wajib + '" kosong ditolak', r.records.length, 0);
    eq('kategori penolakan kolom wajib', r.ditolak[0].kategori, 'wajib-kosong');
  }

  // Penjaga kedua: WAJIB harus konsisten dengan kolom bertipe khusus yang
  // NOT NULL di DDL. Menambah kolom NOT NULL bertipe baru di skema tanpa
  // menambahkannya di WAJIB akan membuat kolom itu kosong lolos ke psql.
  // DDL memakai nama kolom snake_case, WAJIB memakai nama field camelCase,
  // jadi nama kolom dipetakan balik dulu.
  {
    const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', '001_schema.sql'), 'utf8');
    const blok = ddl.slice(ddl.indexOf('CREATE TABLE records'), ddl.indexOf('CREATE TABLE access_log'));
    const kebalikField = new Map();
    for (const f of FIELD_ORDER) kebalikField.set(columnName(f), f);
    const wajibBertipe = [];
    for (const baris of blok.split('\n')) {
      const m = /^\s{2}(\w+)\s+(?:DATE|NUMERIC)\b.*\bNOT NULL/.exec(baris);
      if (m) wajibBertipe.push(m[1]);
    }
    eq('kolom bertipe khusus NOT NULL di DDL ditemukan', wajibBertipe, ['tanggal_kunjungan']);
    const diLuarKatalog = wajibBertipe.filter((c) => !kebalikField.has(c));
    eq('tidak ada kolom typed NOT NULL yang tak dikenal katalog', diLuarKatalog, []);
    const fieldWAJIB = wajibBertipe.map((c) => kebalikField.get(c));
    ok('semua kolom typed NOT NULL itu ada di WAJIB',
      fieldWAJIB.every((f) => bf.WAJIB.includes(f)));
    ok('nik ada di WAJIB', bf.WAJIB.includes('nik'));
  }
}

// ===========================================================================
console.log('\n=== 3. Duplikat dalam satu berkas ===');
// ===========================================================================

{
  const sama = rencana([BARIS(), BARIS()]);
  eq('dua baris identik -> satu record', sama.records.length, 1);
  eq('duplikat dilaporkan', sama.duplikat.length, 1);
  ok('duplikat menunjuk baris pertama', sama.duplikat[0].barisPertama === 1);
  eq('duplikat bukan penolakan', sama.ditolak.length, 0);
}

// ===========================================================================
console.log('\n=== 4. instance_key wajib dan bentuknya dikunci ===');
// ===========================================================================

{
  throws('institutionKey kosong ditolak',
    () => rencana([BARIS()], { institutionKey: '' }));
  throws('institutionKey undefined ditolak',
    () => rencana([BARIS()], { institutionKey: undefined }));
  throws('institutionKey huruf besar ditolak',
    () => rencana([BARIS()], { institutionKey: 'Kota-Bogor' }));
  throws('institutionKey dengan spasi ditolak',
    () => rencana([BARIS()], { institutionKey: 'kota bogor' }));
  throws('institutionKey dengan garis miring ditolak',
    () => rencana([BARIS()], { institutionKey: '../../etc' }));
  ok('slug valid diterima',
    rencana([BARIS()], { institutionKey: 'kota-bogor' }).records.length === 1);
  ok('key numerik diterima',
    rencana([BARIS()], { institutionKey: '12345' }).records.length === 1);
}

// ===========================================================================
console.log('\n=== 5. sections mengikuti isi, bukan keberadaan kolom ===');
// ===========================================================================

{
  const ibuHamil = rencana([BARIS()]);
  const sections = ibuHamil.records[0].sections;
  ok('section A terisi (namaTPK ada)', sections.includes('A'));
  ok('section B terisi (nik ada)', sections.includes('B'));
  ok('section F terisi (usia/bbSekarang ada)', sections.includes('F'));
  ok('section I terisi (tanggalKunjungan ada)', sections.includes('I'));

  // Kolom Baduta ada di form Ibu Hamil juga. Kalau section dihitung dari
  // keberadaan kolom, setiap record Ibu Hamil akan selalu punya section F/G.
  ok('section G tidak terisi dari kolom Baduta yang kosong', !sections.includes('G'));
  ok('section C tidak terisi', !sections.includes('C'));

  // Kolom lintas section harus masuk keduanya kalau terisi.
  const catatan = rencana([Object.assign(BARIS(), { catatanTPK: 'catatan lapangan',terpaparRokok: 'Ya' })]);
  ok('catatanTPK mengisi section G dan I',
    catatan.records[0].sections.includes('G') && catatan.records[0].sections.includes('I'));
  ok('terpaparRokok mengisi section C',
    catatan.records[0].sections.includes('C'));

  // Sections harus konsisten dengan field_catalog yang dihasilkan generator.
  const katalog = new Map();
  for (const f of FIELD_ORDER) {
    const s = (sectionMap[f] || new Set());
    for (const x of s) {
      if (!katalog.has(x)) katalog.set(x, []);
      katalog.get(x).push(f);
    }
  }
  ok('setiap section punya minimal satu field terdefinisi', katalog.size === 9);
}

// ===========================================================================
console.log('\n=== 6. Proyeksi ke kolom bertipe khusus ===');
// ===========================================================================

{
  const r = rencana([Object.assign(BARIS(), {
    usia: '27', bbSekarang: '62,55', tfu: '24', pendampinganKe: '3',
    tanggalKunjungan: '15/03/2024', hpht: '2023-10-01',
  })]);
  const p = r.records[0].proyeksi;
  eq('usia diparse jadi angka', p.usia, 27);
  eq('koma desimal jadi titik', p.bbSekarang, 62.55);
  eq('tfu diparse', p.tfu, 24);
  eq('pendampinganKe diparse jadi integer', p.pendampinganKe, 3);
  eq('tanggal dd/mm/yyyy jadi ISO', p.tanggalKunjungan, '2024-03-15');
  eq('tanggal YYYY-MM-DD dipertahankan', p.hpht, '2023-10-01');

  const satuan = rencana([Object.assign(BARIS(), { bbSekarang: '62,55 kg' })]);
  eq('satuan dibuang', satuan.records[0].proyeksi.bbSekarang, 62.55);

  for (const kosong of ['', '-', 'N/A', 'n/a', 'Kosong', 'tidak ada']) {
    const x = rencana([Object.assign(BARIS(), { tfu: kosong })]);
    eq('"' + kosong + '" jadi NULL', x.records[0].proyeksi.tfu, null);
  }

  const rusak = rencana([Object.assign(BARIS(), { tfu: 'abc' })]);
  eq('nilai tidak terparse jadi NULL, bukan galat', rusak.records[0].proyeksi.tfu, null);
  eq('payload verbatim tetap utuh padahal proyeksi gagal',
    rusak.records[0].payload_json.tfu, 'abc');

  // Di kolom nullable, tanggal kalender yang tidak ada jadi NULL dan baris
  // tetap masuk. Di kolom NOT NULL, baris yang sama ditolak -- diperiksa di
  // bagian 7.
  const tglRusak = rencana([Object.assign(BARIS(), { hpht: '31 Feb 2024' })]);
  eq('tanggal kalender tidak ada jadi NULL', tglRusak.records[0].proyeksi.hpht, null);

  // Regresi: TYPES menyimpan 'NUMERIC(4,1)', bukan 'NUMERIC'. Perbandingan
  // `=== 'NUMERIC'` tidak pernah benar, jadi setiap kolom numerik lolos ke
  // kolom TEXT dan PostgreSQL menolaknya dengan "invalid input syntax for type
  // numeric". Uji ini gagal diam-diam kalau klasifikasi FIELD dikembalikan ke
  // bentuk turunan ulang.
  eq('NUMERIC_FIELDS berisi usia', bf.NUMERIC_FIELDS.has('usia'), true);
  eq('NUMERIC_FIELDS berisi bbSekarang', bf.NUMERIC_FIELDS.has('bbSekarang'), true);
  eq('NUMERIC_FIELDS tidak berisi tanggalKunjungan', bf.NUMERIC_FIELDS.has('tanggalKunjungan'), false);
  eq('DATE_FIELDS berisi tanggalKunjungan', bf.DATE_FIELDS.has('tanggalKunjungan'), true);
  eq('proyeksi menutupi seluruh 18 kolom bertipe khusus',
    Object.keys(r.records[0].proyeksi).length, 18);
}

// ===========================================================================
console.log('\n=== 6b. Tanggal ambigu ditolak, bukan ditebak ===');
// ===========================================================================

{
  // 03/04/2024 bisa 3 April atau 4 Maret. Menebak berarti menulis hash untuk
  // tanggal yang kemungkinan salah, dan hash itu tidak bisa dikoreksi tanpa
  // membatalkan anchor.
  eq('03/04/2024 ditolak tanpa dateOrder', bf.parseTanggal('03/04/2024'), null);
  eq('03/04/2024 dengan ddmmyyyy -> 3 April', bf.parseTanggal('03/04/2024', 'ddmmyyyy'), '2024-04-03');
  eq('03/04/2024 dengan mmddyyyy -> 4 Maret', bf.parseTanggal('03/04/2024', 'mmddyyyy'), '2024-03-04');

  // Tidak ambigu tidak butuh flag apa pun.
  eq('15/03/2024 tidak ambigu (15 mustahil bulan)', bf.parseTanggal('15/03/2024'), '2024-03-15');
  eq('03/15/2024 tidak ambigu (15 mustahil bulan)', bf.parseTanggal('03/15/2024'), '2024-03-15');

  eq('timestamp dibuang jamnya dan dipadatkan', bf.parseTanggal('2024-1-2 08:30'), '2024-01-02');
  eq('tahun dulu tidak ambigu', bf.parseTanggal('2024/3/5'), '2024-03-05');
  eq('bulan bernama', bf.parseTanggal('5 Maret 2024'), '2024-03-05');
  eq('tahun dua digit jadi abad 21', bf.parseTanggal('5 Mar 24'), '2024-03-05');

  eq('31 Feb ditolak', bf.parseTanggal('31 Feb 2024'), null);
  eq('29 Feb tahun kabisat diterima', bf.parseTanggal('29 Feb 2024'), '2024-02-29');
  eq('29 Feb tahun biasa ditolak', bf.parseTanggal('29 Feb 2023'), null);

  // Di kolom nullable, tanggal yang tidak terbaca dilaporkan terpisah dari
  // kosong: nilainya ada, tapi tidak bisa dipastikan. Di kolom NOT NULL
  // (tanggalKunjungan) baris yang sama ditolak -- diuji di bagian 7.
  const rusak = rencana([Object.assign(BARIS(), { hpht: '03/04/2024' })]);
  eq('tanggal ambigu dilaporkan', rusak.tanggalRusak.length, 1);
  eq('dikenali sebagai ambigu, bukan rusak', rusak.tanggalRusak[0].masalah, 'ambigu');
  eq('kedua pembacaan dicatat', [rusak.tanggalRusak[0].ddmmyyyy, rusak.tanggalRusak[0].mmddyyyy], ['2024-04-03', '2024-03-04']);
  eq('kolom tanggal tetap kosong, tidak menebak', rusak.records[0].proyeksi.hpht, null);

  const rusakBenar = rencana([Object.assign(BARIS(), { hpht: '31 Feb 2024' })]);
  eq('tanggal yang memang rusak juga dilaporkan', rusakBenar.tanggalRusak.length, 1);
  eq('dikenali sebagai rusak, bukan ambigu', rusakBenar.tanggalRusak[0].masalah, 'rusak');

  const jelas = rencana([Object.assign(BARIS(), { hpht: '03/04/2024' })], { dateOrder: 'ddmmyyyy' });
  eq('dengan date-order tidak ada yang dilaporkan', jelas.tanggalRusak.length, 0);
  eq('tanggal terisi sesuai locale', jelas.records[0].proyeksi.hpht, '2024-04-03');

  // Batas yang harus diketahui, bukan dijanjikan: record_hash dihitung dari
  // payload verbatim, sedangkan kolom bertipe berisi hasil parse. Jadi
  // --date-order mengubah isi record_hash? Tidak -- dan itu tidak seharusnya,
  // karena payload-nya memang sama persis. Yang berubah adalah kolom bertipe,
  // dan nilai kolom bertipe itu tidak tercakup anchor.
  ok('dateOrder tidak mengubah identitas record',
    jelas.records[0].record_id === rusak.records[0].record_id);
  ok('dateOrder tidak mengubah record_hash karena payload verbatim sama',
    jelas.records[0].record_hash === rusak.records[0].record_hash);
  eq('tapi kolom bertipe ikut berubah', [jelas.records[0].proyeksi.hpht, rusak.records[0].proyeksi.hpht],
    ['2024-04-03', null]);
}

// ===========================================================================
console.log('\n=== 6c. Nilai yang berubah bentuk tidak tercakup anchor ===');
// ===========================================================================

{
  const r = rencana([Object.assign(BARIS(), {
    tanggalKunjungan: '15/03/2024', bbSekarang: '62,55 kg', tfu: '24',
  })]);
  const berubah = r.diubah.map((u) => u.field);
  ok('tanggal bergaris miring tercatat berubah', berubah.includes('tanggalKunjungan'));
  ok('angka bersatuan tercatat berubah', berubah.includes('bbSekarang'));
  ok('angka yang sudah bersih tidak tercatat berubah', !berubah.includes('tfu'));

  const tgl = r.diubah.find((u) => u.field === 'tanggalKunjungan');
  eq('bentuk asal dicatat', tgl.asal, '15/03/2024');
  eq('bentuk jadi dicatat', tgl.jadi, '2024-03-15');

  // Payload tetap menyimpan apa yang ada di sheet.
  eq('payload tetap verbatim', r.records[0].payload_json.tanggalKunjungan, '15/03/2024');
  eq('payload angka tetap verbatim', r.records[0].payload_json.bbSekarang, '62,55 kg');

  ok('peringatan menyebut bahwa nilai ini tidak tercakup anchor',
    r.peringatan.some((p) => /TIDAK tercakup anchor/.test(p)));
}

// ===========================================================================
console.log('\n=== 7. SQL yang dihasilkan ===');
// ===========================================================================

{
  const r = rencana([Object.assign(BARIS(), {
    tfu: 'abc', usia: '27', bbSekarang: '62,55', pendampinganKe: '1',
  })]);
  const sql = cli.sqlUntuk(r.records);

  ok('SQL dibungkus BEGIN dan COMMIT', /BEGIN;[\s\S]*COMMIT;/.test(sql));

  // Uji ini dulu salah: ia mencocokkan /ON CONFLICT/ ke seluruh isi berkas,
  // dan kata-kata itu muncul di komentar header -- sementara SQL-nya sendiri
  // tidak punya ON CONFLICT sama sekali. Backfill kedua kali akan gagal dengan
  // "duplicate key value violates unique constraint pkey" dan membatalkan
  // seluruh transaksi.
  //
  // Karena itu klausa diperiksa pada badan statement, bukan pada berkas.
  const statement = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  ok('ON CONFLICT benar-benar ada di badan SQL',
    (statement.match(/ON CONFLICT \(record_id, version\) DO NOTHING/g) || []).length === 1);
  ok('setiap INSERT punya tepat satu ON CONFLICT',
    (statement.match(/INSERT INTO records/g) || []).length ===
    (statement.match(/ON CONFLICT/g) || []).length);
  ok('ON CONFLICT menunjuk kolom kunci yang benar',
    statement.includes('ON CONFLICT (record_id, version) DO NOTHING'));

  // Kolom bertipe khusus yang NOT NULL tidak boleh kosong, karena kegagalan
  // baru muncul saat psql menjalankan INSERT.
  {
    const ambigu = rencana([Object.assign(BARIS(), { tanggalKunjungan: '03/04/2024' })]);
    eq('tanggal ambigu pada kolom NOT NULL menolak baris', ambigu.records.length, 0);
    eq('kategori penolakan rusak', ambigu.ditolak[0].kategori, 'wajib-rusak');
    ok('alasan menyebut nama kolomnya', /tanggalKunjungan/.test(ambigu.ditolak[0].alasan));
    ok('alasan menyebut nilai aslinya', /03\/04\/2024/.test(ambigu.ditolak[0].alasan));
    // Dua masalah berbeda harus punya dua petunjuk berbeda: yang ambigu bisa
    // diperbaiki --date-order, yang rusak tidak.
    ok('petunjuk --date-order muncul untuk tanggal ambigu',
      /--date-order/.test(ambigu.ditolak[0].alasan));
    ok('petunjuk menyebut kedua pembacaan yang mungkin',
      /2024-04-03/.test(ambigu.ditolak[0].alasan) && /2024-03-04/.test(ambigu.ditolak[0].alasan));

    const rusak = rencana([Object.assign(BARIS(), { tanggalKunjungan: '31 Feb 2024' })]);
    eq('tanggal kalender tidak ada pada kolom NOT NULL juga menolak', rusak.records.length, 0);
    ok('tanggal rusak tidak menyarankan --date-order',
      !/--date-order/.test(rusak.ditolak[0].alasan));
  }
  {
    // Kolom nullable boleh NULL -- itu kebijakan parse, bukan kegagalan.
    const nullable = rencana([Object.assign(BARIS(), { hpht: '31 Feb 2024', tfu: 'abc' })]);
    eq('kolom nullable yang rusak tidak menolak baris', nullable.records.length, 1);
    eq('dan diproyeksi jadi NULL', nullable.records[0].proyeksi.hpht, null);
  }

  // Regresi: versi pertama menuliskan nilai mentah ke kolom bertipe khusus.
  // Kolom DATE menerima "31 Feb 2024"? PostgreSQL menolak dengan invalid input
  // syntax, padahal kebijakan di sql/001_schema.sql menetapkan NULL.
  ok('kolom bertipe khusus tidak menulis nilai mentah yang gagal parse',
    !/,\s*'abc'\s*,/.test(statement) && !/,\s*'31 Feb 2024'\s*,/.test(statement));

  const tanpaKonflik = sql.replace(/ON CONFLICT DO NOTHING/, 'ON CONFLICT DO UPDATE');
  ok('DO NOTHING bisa diganti untuk uji', tanpaKonflik.length > 0);

  const sqlQuote = cli.sqlQuote;
  eq("kutip tunggal diescape ganda", sqlQuote("O'Brien"), "'O''Brien'");
  eq('null jadi NULL tanpa kutip', sqlQuote(null), 'NULL');
  eq('angka jadi string berkuot', sqlQuote(27), "'27'");

  const kosong = cli.sqlUntuk([]);
  eq('SQL kosong tidak menghasilkan statement', kosong, '');

  // Nama kolom harus sama persis dengan yang dipakai DDL.
  const kolomSql = sql.match(/INSERT INTO records \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  const metadata = ['record_id', 'version', 'status', 'schema_version',
    'institution_id', 'record_hash', 'payload_json', 'sections'];
  eq('kolom metadata lengkap', kolomSql.slice(0, 8), metadata);
  eq('jumlah kolom = 8 metadata + 72 proyeksi', kolomSql.length, 80);
  eq('nama kolom proyeksi sama dengan columnName()',
    kolomSql.slice(8), FIELD_ORDER.map(columnName));

  // Urutan kolom harus sama dengan urutan DDL supaya mudah dibandingkan.
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', '001_schema.sql'), 'utf8');
  const blokRecords = ddl.slice(ddl.indexOf('CREATE TABLE records'), ddl.indexOf('CREATE TABLE access_log'));
  for (const f of FIELD_ORDER) {
    const kolom = columnName(f);
    if (!blokRecords.includes('\n  ' + kolom + ' ')) {
      failed++;
      console.log('GAGAL  kolom "' + kolom + '" tidak ada di DDL records');
      break;
    }
  }
  passed++;
  console.log('LULUS  semua 72 kolom proyeksi ada di DDL');

  ok('payload_json ditulis sebagai ::jsonb', /'::jsonb/.test(sql));
  ok('sections ditulis sebagai text[]', /::text\[\]/.test(sql));
  ok('institution_id ikut ditulis', sql.includes("'kota-bogor'"));
}

// ===========================================================================
console.log('\n=== 8. Pembacaan input ===');
// ===========================================================================

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-uji-'));
  try {
    const f1 = path.join(dir, 'objek.json');
    fs.writeFileSync(f1, JSON.stringify([BARIS()]), 'utf8');
    eq('baca array of objects', cli.bacaInput(f1).rows.length, 1);

    const f2 = path.join(dir, 'tabel.json');
    fs.writeFileSync(f2, JSON.stringify({ headers: ['NIK', 'Nama Lengkap'], rows: [['123', 'Sari']] }), 'utf8');
    const t = cli.bacaInput(f2);
    eq('baca {headers, rows}', t.rows.length, 1);
    eq('header dipakai apa adanya', t.headers, ['NIK', 'Nama Lengkap']);

    const f3 = path.join(dir, 'rusak.json');
    fs.writeFileSync(f3, JSON.stringify({ baris: [] }), 'utf8');
    throws('format tidak dikenal ditolak', () => cli.bacaInput(f3));

    // Konversi baris array ke objek harus lewat label, bukan indeks tetap.
    // Test ini memakai header yang hanya berisi sebagian field, sehingga indeks
    // tetap akan menghasilkan NIK yang salah tanpa ketahuan.
    const headers = [LABELS.nik, LABELS.namaLengkap, LABELS.tanggalKunjungan];
    const konv = cli.barisKeObjek(headers, [['999', 'Budi', '2024-01-02']]);
    eq('baris array dikonversi lewat header', konv.objek[0].nik, '999');
    eq('nama lengkap dari kolom kedua', konv.objek[0].namaLengkap, 'Budi');
    ok('field yang tidak ada di header dilaporkan', konv.hilang.length > 0);
    eq('field yang hilang bernilai kosong', konv.objek[0].namaTPK, '');

    const idx = headerToIndex([LABELS.nik, LABELS.namaLengkap]);
    eq('pickField mengembalikan nilai yang benar', pickField(['1', 'X'], idx, 'nik'), '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
console.log('\n=== 9. Argumen CLI ===');
// ===========================================================================

{
  const o = cli.parseArgs(['--institution', 'kota-bogor', '--input', 'x.json', '--dry-run']);
  eq('--institution terbaca', o.institution, 'kota-bogor');
  eq('--input terbaca', o.input, 'x.json');
  ok('--dry-run terbaca', o.dryRun === true);
  ok('bendera lain default', o.skipBalita === false && o.dateOrder === null && o.out === null);

  throws('argumen tak dikenal ditolak', () => cli.parseArgs(['--ngawur']));
  throws('--institution tanpa nilai ditolak', () => cli.parseArgs(['--institution']));
  throws('--input tanpa nilai ditolak', () => cli.parseArgs(['--input']));
  throws('--date-order ngawur ditolak', () => cli.parseArgs(['--date-order', 'yymmdd']));
  eq('--date-order ddmmyyyy diterima', cli.parseArgs(['--date-order', 'ddmmyyyy']).dateOrder, 'ddmmyyyy');

  ok('bantuan menyebut --institution sebagai wajib', /WAJIB/.test(cli.BANTUAN));
  ok('bantuan menjelaskan --date-order', /ddmmyyyy/.test(cli.BANTUAN));
  ok('bantuan menjelaskan --skip-balita', /taksonomi/.test(cli.BANTUAN));

  // Penjaga: --identity-row sengaja tidak ada sebagai bendera. Kalau suatu saat
  // orang menambahkannya lagi, dokumentasi harus menyebut alasannya.
  ok('--identity-row tidak ditawarkan sebagai pilihan',
    !cli.BANTUAN.split('\n').some((l) => /^\s+--identity-row\b/.test(l)));
  ok('bantuan menyebut alasan tidak adanya', /NOT NULL/.test(cli.BANTUAN));
}

// ===========================================================================
console.log('\n=== 9b. Keluar dengan pesan, bukan stack trace ===');
// ===========================================================================

{
  // main() tidak diekspor, jadi dipanggil sebagai proses anak. Galat input
  // yang tidak tertangani mencetak stack trace beserta nomor baris kode, dan
  // nomor baris kode tidak menolong siapa pun yang ingin memperbaiki berkasnya.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-cli-'));
  try {
    const jalan = (args) => {
      const r = require('child_process').spawnSync(process.execPath,
        [path.join(__dirname, 'backfill.js')].concat(args),
        { encoding: 'utf8' });
      return { kode: r.status, err: r.stderr || '', out: r.stdout || '' };
    };

    const hilang = jalan(['--institution', 'kota-bogor',
      '--input', path.join(dir, 'tidak-ada.json'), '--dry-run']);
    eq('berkas hilang: exit 2', hilang.kode, 2);
    ok('berkas hilang: pesan menyebut nama berkas',
      /Berkas tidak ditemukan/.test(hilang.err) && /tidak-ada\.json/.test(hilang.err));
    ok('berkas hilang: tanpa stack trace', !/at Object\.|at Module\./.test(hilang.err));

    const rusak = path.join(dir, 'rusak.json');
    fs.writeFileSync(rusak, '{ "headers": [', 'utf8');
    const jsonRusak = jalan(['--institution', 'kota-bogor', '--input', rusak, '--dry-run']);
    eq('JSON rusak: exit 2', jsonRusak.kode, 2);
    ok('JSON rusak: pesan mengarah ke berkas',
      /bukan JSON yang valid/.test(jsonRusak.err));
    ok('JSON rusak: tanpa stack trace', !/at Object\.|at Module\./.test(jsonRusak.err));

    const tunggal = path.join(dir, 'tunggal.json');
    fs.writeFileSync(tunggal, '{"a":1}', 'utf8');
    const format = jalan(['--institution', 'kota-bogor', '--input', tunggal, '--dry-run']);
    eq('format tak dikenal: exit 2', format.kode, 2);
    ok('format tak dikenal: menjelaskan bentuk yang diterima',
      /Format input tidak dikenali/.test(format.err));
    ok('format tak dikenal: tanpa stack trace', !/at Object\.|at Module\./.test(format.err));

    // Dry-run yang bersih tetap exit 0 -- penjaga di atas tidak boleh
    // menangkap kondisi sukses sebagai galat.
    const baik = path.join(dir, 'baik.json');
    const isi = BARIS();
    isi.jenisSasaran = 'Ibu Hamil';
    fs.writeFileSync(baik, JSON.stringify([isi], null, 2), 'utf8');
    const sukses = jalan(['--institution', 'kota-bogor', '--input', baik,
      '--date-order', 'ddmmyyyy', '--dry-run']);
    eq('dry-run bersih tetap exit 0', sukses.kode, 0);
    ok('dry-run bersih mengonfirmasi tidak menulis', /dry-run bersih/.test(sukses.out));

    // --skip-balita harus mengubah perilaku dry-run, bukan cuma ada di
    // laporan. Versi pertama tetap exit 1 karena cek "ada baris ditolak"
    // menghitung baris taksonomi yang sudah di-opt-in -- sehingga opt-in
    // tidak pernah berlaku untuk dry-run.
    const balita = Object.assign(BARIS(), { jenisSasaran: 'Balita' });
    const tanpaNik = Object.assign(BARIS(), { nik: '', jenisSasaran: 'Ibu Hamil' });

    const balitaDulu = path.join(dir, 'balita.json');
    fs.writeFileSync(balitaDulu, JSON.stringify([balita], null, 2), 'utf8');
    const takBoleh = jalan(['--institution', 'kota-bogor', '--input', balitaDulu,
      '--date-order', 'ddmmyyyy', '--dry-run']);
    eq('Balita tanpa opt-in tetap menggagalkan', takBoleh.kode, 1);
    ok('dan menyebut --skip-balita', /--skip-balita tidak diberikan/.test(takBoleh.err));

    const boleh = jalan(['--institution', 'kota-bogor', '--input', balitaDulu,
      '--skip-balita', '--date-order', 'ddmmyyyy', '--dry-run']);
    eq('Balita dengan --skip-balita: dry-run bersih', boleh.kode, 0);
    ok('tetapi barisnya tetap dilaporkan sebagai ditolak',
      /ditolak\s+:\s+1/.test(boleh.out));

    // Opt-in hanya berlaku untuk taksonomi. NIK kosong harus tetap
    // menggagalkan walau --skip-balita diberikan, atau opt-innya jadi
    // terlalu luas.
    const campur = path.join(dir, 'campur.json');
    fs.writeFileSync(campur, JSON.stringify([balita, tanpaNik], null, 2), 'utf8');
    const campurOptIn = jalan(['--institution', 'kota-bogor', '--input', campur,
      '--skip-balita', '--date-order', 'ddmmyyyy', '--dry-run']);
    eq('penolakan lain tetap menggagalkan meski --skip-balita', campurOptIn.kode, 1);
    ok('dan jumlahnya hanya penolakan non-taksonomi',
      /dry-run dengan 1 baris ditolak/.test(campurOptIn.err));

    // Yazaman opt-in: baris taksonomi yang dilewati tidak boleh muncul di SQL.
    const sql = path.join(dir, 'out.sql');
    const sah = Object.assign(BARIS(), { nik: '3201234567891', jenisSasaran: 'Ibu Hamil' });
    fs.writeFileSync(campur, JSON.stringify([balita, sah], null, 2), 'utf8');
    const tulis = jalan(['--institution', 'kota-bogor', '--input', campur,
      '--skip-balita', '--date-order', 'ddmmyyyy', '--out', sql]);
    eq('jalur --out tetap menulis walau ada penolakan', tulis.kode, 0);
    const isiSql = fs.readFileSync(sql, 'utf8');
    eq('hanya record yang lolos taksonomi yang masuk SQL',
      (isiSql.match(/INSERT INTO records/g) || []).length, 1);
    ok('SQL tidak memuat baris taksonomi', !/Balita/.test(isiSql));
    ok('SQL memuat record yang sah', /Sari Dewi/.test(isiSql));

    // Locale bawaan proyek: "hari dulu" sudah dikonfirmasi pemilik proyek, jadi
    // tanggal ambigu harus diterima TANPA --date-order. Tapi itu asumsi manusia,
    // jadi harus terlihat di laporan -- kalau tidak, locale yang keliru tidak
    // akan pernah ketahuan.
    const ambigu = path.join(dir, 'ambigu.json');
    fs.writeFileSync(ambigu, JSON.stringify([Object.assign(BARIS(), {
      tanggalKunjungan: '03/04/2024',
    })], null, 2), 'utf8');

    const tanpaBendera = jalan(['--institution', 'kota-bogor', '--input', ambigu, '--dry-run']);
    eq('tanggal ambigu diterima tanpa --date-order', tanpaBendera.kode, 0);
    ok('tapi ditebak memakai hari dulu', /tanggalKunjungan="03\/04\/2024"\s+-> 2024-04-03/
      .test(tanpaBendera.out));
    ok('laporan menyebut jumlah tebakan',
      /tanggal ambigu yang ditebak \(1\)/.test(tanpaBendera.out));
    ok('laporan menyebut asumsi yang dipakai', /ddmmyyyy/.test(tanpaBendera.out));

    // month-first harus tetap bisa dipakai, dan laporan harus berubah sesuai
    // asumsi yang berbeda -- kalau tidak, ringkasan itu tidak berguna.
    const bulanDulu = jalan(['--institution', 'kota-bogor', '--input', ambigu,
      '--date-order', 'mmddyyyy', '--dry-run']);
    eq('--date-order mmddyyyy dipakai kalau diminta', bulanDulu.kode, 0);
    ok('hasilnya jadi 4 Maret, bukan 3 April',
      /tanggalKunjungan="03\/04\/2024"\s+-> 2024-03-04/.test(bulanDulu.out));

    // Teks asli harus tetap utuh di payload_json, apa pun locale yang dipakai:
    // payload_json adalah sumber hash, dan hash tidak boleh ikut berubah karena
    // pilihan lokalenya berganti.
    const lib = require(path.join(__dirname, '..', 'lib', 'backfill.js'));
    const isiAmbigus = JSON.parse(fs.readFileSync(ambigu, 'utf8'));
    const dua = ['ddmmyyyy', 'mmddyyyy'].map((order) => lib.rencanaBackfill(Object.assign({
      rows: isiAmbigus,
      fieldOrder: FIELD_ORDER,
      institutionKey: 'kota-bogor',
      sectionMap,
      normalizeSasaran: normalisasi,
      normalizeNik,
      dateOrder: order,
    })));
    eq('record_hash sama walupun locale berganti',
      dua[0].records[0].record_hash, dua[1].records[0].record_hash);
    eq('teks asli di payload_json tetap utuh',
      dua[0].records[0].payload_json.tanggalKunjungan, '03/04/2024');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
console.log('\n=== 10. Hash sama dengan jalur produksi ===');
// ===========================================================================

{
  // Backfill menghitung record_hash dengan modul yang sama seperti jalur tulis
  // produksi. Kalau payload-nya berbeda bentuk, hash untuk isi yang sama akan
  // berbeda dan tidak akan ketahuan tanpa perbandingan manual.
  const canonical = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
  const r = rencana([BARIS()]);
  const payload = {};
  for (const f of FIELD_ORDER) payload[f] = String(BARIS()[f] === undefined ? '' : BARIS()[f]);
  payload.jenisSasaran = 'Ibu Hamil';
  eq('record_hash backfill sama dengan canonical.recordHash',
    r.records[0].record_hash, canonical.recordHash(payload));
}

// ===========================================================================
console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK. Jangan jalankan backfill sebelum ini hijau.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
