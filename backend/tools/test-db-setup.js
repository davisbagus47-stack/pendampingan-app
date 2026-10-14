/**
 * Uji logika murni tools/db-setup.js.
 *
 * Tidak ada database yang dibutuhkan. Yang diuji adalah keputusan yang
 * paling mahal kalau salah: kapan skrip berani keluar dengan kode 1.
 *
 * Dua kelompok diuji di sini:
 *
 *   1. Pemeriksaan peran. `rolsuper` dan `rolbypassrls` adalah satu-satunya
 *      alasan RLS bisa senyap-nyap tidak bekerja tanpa pesan galat. Kalau
 *      periksaPeran() meloloskan salah satunya, seluruh verifikasi keras
 *      menjadi hijau palsu -- persis jenis kegagalan yang paling mahal
 *      di proyek ini.
 *
 *   2. evaluasiIsolasi(). Setiap pemeriksaan diuji dua arah: sekali dengan
 *      data yang benar (harus lulus), sekali dengan data yang salah tepat di
 *      posisi itu (harus gagal). Uji satu arah hanya membuktikan fungsi itu
 *      bisa mengembalikan `true`.
 */

const dbSetup = require('./db-setup.js');

let passed = 0;
let failed = 0;

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat      : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

// ---------------------------------------------------------------------------
// 1. Peran
// ---------------------------------------------------------------------------

console.log('=== 1. periksaPeran ===');

eq('peran bersih lulus', dbSetup.periksaPeran({
  rolname: 'app_api', rolsuper: false, rolbypassrls: false,
}), { lulus: true, alasan: '' });

const superuser = dbSetup.periksaPeran({
  rolname: 'app_api', rolsuper: true, rolbypassrls: false,
});
ok('rolsuper ditolak', !superuser.lulus);
ok('penjelasan rolsuper menyebut BYPASSRLS', superuser.alasan.indexOf('rolsuper = true') >= 0);

const bypass = dbSetup.periksaPeran({
  rolname: 'app_api', rolsuper: false, rolbypassrls: true,
});
ok('rolbypassrls ditolak', !bypass.lulus);
ok('penjelasan menyebut FORCE', bypass.alasan.indexOf('FORCE ROW LEVEL SECURITY') >= 0);

const keduanya = dbSetup.periksaPeran({
  rolname: 'app_api', rolsuper: true, rolbypassrls: true,
});
ok('kedua atribut disebut', keduanya.alasan.indexOf('rolsuper') >= 0 && keduanya.alasan.indexOf('rolbypassrls') >= 0);

const tidakAda = dbSetup.periksaPeran(null);
ok('peran null ditolak', !tidakAda.lulus);
ok('peran null alasan berisi pg_roles', tidakAda.alasan.indexOf('pg_roles') >= 0);

// ---------------------------------------------------------------------------
// 2. SQL peran
// ---------------------------------------------------------------------------

console.log('=== 2. sqlBuatPeran ===');

const sqlPeran = dbSetup.sqlBuatPeran('app_api').join('\n');
ok('membuat peran NOLOGIN', sqlPeran.indexOf('CREATE ROLE app_api NOLOGIN') >= 0);
ok('membuat peran NOSUPERUSER', sqlPeran.indexOf('NOSUPERUSER') >= 0);
ok('membuat peran NOBYPASSRLS', sqlPeran.indexOf('NOBYPASSRLS') >= 0);
ok('idempoten lewat IF NOT EXISTS', sqlPeran.indexOf('IF NOT EXISTS') >= 0);
ok('CREATE tidak lagi membawa ALTER', sqlPeran.indexOf('ALTER ROLE') < 0);
ok('CREATE dibungkus DO block', sqlPeran.indexOf('DO $$') >= 0);

const sqlPeranLain = dbSetup.sqlBuatPeran('peran_uji2').join('\n');
ok('nama peran dipakai apa adanya', sqlPeranLain.indexOf('CREATE ROLE peran_uji2') >= 0);

console.log('=== 2b. sqlUbahPeran ===');

const sqlUbah = dbSetup.sqlUbahPeran('app_api');
ok('ALTER ROLE untuk perbaikan atribut', sqlUbah.indexOf('ALTER ROLE app_api NOLOGIN NOSUPERUSER') >= 0);
ok('ALTER membawa NOBYPASSRLS', sqlUbah.indexOf('NOBYPASSRLS') >= 0);

// ---------------------------------------------------------------------------
// 3. Hak
// ---------------------------------------------------------------------------

console.log('=== 3. sqlHak ===');

const hak = dbSetup.sqlHak('app_api').join('\n');
ok('ada USAGE pada skema', hak.indexOf('GRANT USAGE ON SCHEMA public TO app_api') >= 0);
ok('ada SELECT semua tabel', hak.indexOf('GRANT SELECT ON ALL TABLES IN SCHEMA public') >= 0);
ok('access_log dapat INSERT', hak.indexOf('GRANT INSERT ON access_log TO app_api') >= 0);
ok('access_log TIDAK dapat UPDATE', hak.indexOf('UPDATE ON access_log') < 0);
ok('records dapat INSERT dan UPDATE', hak.indexOf('GRANT INSERT, UPDATE ON records') >= 0);
ok('FR-3.1: agencies dapat INSERT (policy sudah ada)', hak.indexOf('GRANT INSERT ON agencies TO app_api') >= 0);
ok('FR-3.1: agency_categories dapat INSERT', hak.indexOf('GRANT INSERT ON agency_categories TO app_api') >= 0);
ok('sequences dapat USAGE', hak.indexOf('GRANT USAGE, SELECT ON ALL SEQUENCES') >= 0);
ok('ada default privileges tabel', hak.indexOf('ALTER DEFAULT PRIVILEGES') >= 0);

// ---------------------------------------------------------------------------
// 4. siapkanSkema
// ---------------------------------------------------------------------------

console.log('=== 4. siapkanSkema ===');

const skemaContoh = [
  '-- header', 'BEGIN;', '', 'CREATE TABLE t (id int);', '', 'COMMIT;',
].join('\n');
const siap = dbSetup.siapkanSkema(skemaContoh);
ok('BEGIN dibuang', siap.indexOf('BEGIN;') < 0);
ok('COMMIT dibuang', siap.indexOf('COMMIT;') < 0);
ok('inti skema dipertahankan', siap.indexOf('CREATE TABLE t (id int);') >= 0);

const tanpaBungkus = 'SELECT 1;\nSELECT 2;';
eq('skema tanpa bungkus tidak berubah', dbSetup.siapkanSkema(tanpaBungkus), tanpaBungkus);

const beginDiTengah = 'CREATE FUNCTION f() AS $$\nBEGIN;\nEND $$;';
ok('BEGIN di dalam dolar-quoted tidak disentuh', dbSetup.siapkanSkema(beginDiTengah).indexOf('BEGIN;') >= 0);

// ---------------------------------------------------------------------------
// 5. nilaiKlaim
// ---------------------------------------------------------------------------

console.log('=== 5. nilaiKlaim ===');

eq('klaim null -> string kosong', dbSetup.nilaiKlaim(null), "''");
eq('klaim operator', dbSetup.nilaiKlaim({ role: 'operator' }), `'{"role":"operator"}'`);
eq(
  'klaim agency',
  dbSetup.nilaiKlaim({ role: 'agency', agency_id: 12 }),
  `'{"role":"agency","agency_id":12}'`
);

let lempar = false;
try {
  dbSetup.nilaiKlaim({ role: "agency'); DROP TABLE x;--" });
} catch (e) {
  lempar = true;
}
ok('klaim berisi kutip tunggal ditolak', lempar);

// ---------------------------------------------------------------------------
// 6. deteksiLingkungan
// ---------------------------------------------------------------------------

console.log('=== 6. deteksiLingkungan ===');

eq('localhost', dbSetup.deteksiLingkungan('postgres://u:p@localhost:5432/db'), 'lokal');
eq('127.0.0.1', dbSetup.deteksiLingkungan('postgres://u:p@127.0.0.1:5432/db'), 'lokal');
eq('supabase', dbSetup.deteksiLingkungan('postgres://u:p@db.abcdef.supabase.co:5432/postgres'), 'supabase');
eq('host lain', dbSetup.deteksiLingkungan('postgres://u:p@db.example.com:5432/db'), 'lain');
eq('URL rusak', dbSetup.deteksiLingkungan('bukan-url'), 'tak dikenal');

// ---------------------------------------------------------------------------
// 7. ramahUrl
// ---------------------------------------------------------------------------

console.log('=== 7. ramahUrl ===');

const tersembunyi = dbSetup.ramahUrl('postgres://postgres:rahasia123@db.example.com:5432/postgres');
ok('kata sandi tidak ikut tercetak', tersembunyi.indexOf('rahasia123') < 0);
ok('pengguna tetap terbaca', tersembunyi.indexOf('postgres:') >= 0);
ok('host tetap terbaca', tersembunyi.indexOf('db.example.com') >= 0);
eq('URL rusak tidak melempar', dbSetup.ramahUrl('bukan-url'), '(URL tidak bisa dibaca)');

// ---------------------------------------------------------------------------
// 8. evaluasiIsolasi -- data benar harus lulus semua
// ---------------------------------------------------------------------------

console.log('=== 8. evaluasiIsolasi: data benar ===');

function hBenar() {
  return {
    peran: 'app_api',
    peranEfektif: 'app_api',
    rolsuper: false,
    rolbypassrls: false,
    bisaBacaRecords: true,
    bisaTulisLog: true,
    bisaUbahLog: false,
    ubahLogDitolak: true,
    operator: { n: 2, pemilik: 'uji-a' },
    agencyA: { n: 1, pemilik: 'uji-a' },
    agencyB: { n: 1, pemilik: 'uji-b' },
    anon: { n: 0, pemilik: null },
  };
}

const semuaLulus = dbSetup.evaluasiIsolasi(hBenar());
eq('jumlah pemeriksaan', semuaLulus.length, 13);
ok('semua lulus', semuaLulus.every((u) => u.lulus));

// ---------------------------------------------------------------------------
// 9. evaluasiIsolasi -- setiap pemeriksaan harus bisa GAGAL
// ---------------------------------------------------------------------------

console.log('=== 9. evaluasiIsolasi: tiap pemeriksaan bisa gagal ===');

// Pasangan [nama pemeriksaan, fungsi merusak]. Setiap kerusakan harus
// menghasilkan tepat satu kegagalan, dan pemeriksaan itu sendiri haruslah
// yang gagal -- kalau yang gagal pemeriksaan lain, pemeriksaan ini tidak
// benar-benar menguji apa-apa.
const kerusakan = [
  ['peran efektif setelah SET ROLE', (h) => { h.peranEfektif = 'postgres'; }],
  ['peran efektif bukan superuser', (h) => { h.rolsuper = true; }],
  ['peran efektif tanpa BYPASSRLS', (h) => { h.rolbypassrls = true; }],
  ['hak SELECT pada records diberikan', (h) => { h.bisaBacaRecords = false; }],
  ['hak INSERT pada access_log diberikan', (h) => { h.bisaTulisLog = false; }],
  ['hak UPDATE pada access_log tidak diberikan', (h) => { h.bisaUbahLog = true; }],
  ['UPDATE access_log ditolak database', (h) => { h.ubahLogDitolak = false; }],
  ['operator melihat kedua record uji', (h) => { h.operator.n = 1; }],
  ['instansi A hanya melihat record A', (h) => { h.agencyA.n = 2; }],
  ['record yang dilihat A milik instansi A', (h) => { h.agencyA.pemilik = 'uji-b'; }],
  ['instansi B hanya melihat record B', (h) => { h.agencyB.n = 0; }],
  ['record yang dilihat B milik instansi B', (h) => { h.agencyB.pemilik = 'uji-a'; }],
  ['tanpa klaim JWT tidak melihat record uji', (h) => { h.anon.n = 3; }],
];

for (const k of kerusakan) {
  const nama = k[0];
  const rusak = k[1];
  const h = hBenar();
  rusak(h);
  const hasil = dbSetup.evaluasiIsolasi(h);
  const gagal = hasil.filter((u) => !u.lulus);
  ok('gagal terdeteksi: ' + nama, gagal.length === 1 && gagal[0].nama === nama);
}

// ---------------------------------------------------------------------------
// 10. parseArgs
// ---------------------------------------------------------------------------

console.log('=== 10. parseArgs ===');

eq('terapkan', dbSetup.parseArgs(['terapkan']), {
  perintah: 'terapkan', peran: 'app_api', help: false,
});
eq('periksa', dbSetup.parseArgs(['periksa']).perintah, 'periksa');
eq('kering', dbSetup.parseArgs(['kering']).perintah, 'kering');
eq('--peran dihormati', dbSetup.parseArgs(['periksa', '--peran', 'peran_lain']).peran, 'peran_lain');
eq('help', dbSetup.parseArgs(['--help']).help, true);
eq('perintah null kalau diawali flag', dbSetup.parseArgs(['--help']).perintah, null);

function lemparArgs(argv) {
  try { dbSetup.parseArgs(argv); return null; }
  catch (e) { return e.message; }
}

ok('argumen kosong ditolak', (lemparArgs([]) || '').indexOf('perintah wajib') >= 0);
ok('perintah asing ditolak', (lemparArgs(['ngawur']) || '').indexOf('tak dikenal') >= 0);
ok('flag asing ditolak', (lemparArgs(['terapkan', '--aneh']) || '').indexOf('tak dikenal') >= 0);
ok('--peran tanpa nilai ditolak', (lemparArgs(['terapkan', '--peran']) || '').indexOf('butuh nilai') >= 0);
ok('nama peran berhuruf besar ditolak',
  (lemparArgs(['terapkan', '--peran', 'AppApi']) || '').indexOf('tidak sah') >= 0);
ok('nama peran berkepala angka ditolak',
  (lemparArgs(['terapkan', '--peran', '1app']) || '').indexOf('tidak sah') >= 0);
ok('nama peran dengan tanda hubung ditolak',
  (lemparArgs(['terapkan', '--peran', 'app-api']) || '').indexOf('tidak sah') >= 0);

// ---------------------------------------------------------------------------
// 11. Modul tidak menjalankan apa pun saat dimuat
// ---------------------------------------------------------------------------

console.log('=== 11. efek samping saat require ===');
ok('require tidak melempar', true);
ok('ekspor lengkap', ['parseArgs', 'deteksiLingkungan', 'ramahUrl', 'periksaPeran',
  'sqlBuatPeran', 'sqlUbahPeran', 'sqlHak', 'siapkanSkema', 'nilaiKlaim', 'evaluasiIsolasi']
  .every((k) => typeof dbSetup[k] === 'function'));

// ---------------------------------------------------------------------------

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK. PeriksaPeran yang bocor membuat seluruh verifikasi RLS hijau palsu.');
  process.exit(1);
} else {
  console.log('\nSEMUA UJI LOLOS');
}
