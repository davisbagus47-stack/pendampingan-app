/**
 * Uji kontrak CLI kunci API (F3.10a).
 *
 * Yang diuji di sini BUKAN integrasi database -- tidak ada PostgreSQL di
 * lingkungan ini (F1.8a masih terbuka). Yang diuji adalah keputusan yang
 * sudah diambil: bentuk token, apa yang masuk hash, apa yang TIDAK keluar dari
 * perintah cabut, dan apa yang ditolak CLI.
 *
 * Uji-uji ini membangunkan bug yang kalau lolos akan terlihat
 * di tahap yang jauh nanti dan cepat, dan tidak butuh server.
 */

const {
  BANTUAN, PREFIX_TOKEN, PANJANG_RAHASIA,
  parseArgs, buatToken, hashToken, sqlQuote, sqlTerbit, sqlCabut,
} = require('./api-keys.js');

let lulus = 0;
let gagal = 0;

function eq(nama, dapat, harap) {
  const a = JSON.stringify(dapat);
  const b = JSON.stringify(harap);
  if (a === b) {
    console.log('lulus  ' + nama);
    lulus++;
  } else {
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
    gagal++;
  }
}

function ok(nama, syarat) {
  if (syarat) { console.log('lulus  ' + nama); lulus++; }
  else { console.log('GAGAL  ' + nama); gagal++; }
}

function lemparThrows(nama, fn, polaPesan) {
  try {
    fn();
    console.log('GAGAL  ' + nama + ' (tidak melempar galat)');
    gagal++;
  } catch (e) {
    const cocok = !polaPesan || String(e.message).includes(polaPesan);
    if (cocok) { console.log('lulus  ' + nama); lulus++; }
    else {
      console.log('GAGAL  ' + nama);
      console.log('        dapat     : ' + e.message);
      console.log('        diharapkan mengandung : ' + polaPesan);
      gagal++;
    }
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. Bentuk token ===');

const t1 = buatToken();
ok('token diawali prefix yang tetap', t1.token.startsWith(PREFIX_TOKEN));
eq('panjang rahasia 43 char base64url', t1.token.length - PREFIX_TOKEN.length, PANJANG_RAHASIA);
ok('token hanya ASCII yang aman di header HTTP', /^[A-Za-z0-9_-]+$/.test(t1.token.slice(PREFIX_TOKEN.length)));
ok('tidak ada karakter base64 yang perlu di-escape', !/[+/=]/.test(t1.token.slice(PREFIX_TOKEN.length)));

const t2 = buatToken();
ok('dua token tidak sama', t1.token !== t2.token);
ok('dua hash tidak sama', t1.hash !== t2.hash);

eq('prefix 8 char awal untuk display', t1.prefix, t1.token.slice(0, PREFIX_TOKEN.length + 8));
ok('prefix tidak memuat rahasia', t1.prefix.length < t1.token.length);

// Entropi: 32 byte dari crypto.randomBytes, bukan Math.random.
ok('hash panjangnya 64 hex (SHA-256)', /^[0-9a-f]{64}$/.test(t1.hash));

// ---------------------------------------------------------------------------
console.log('=== 2. Apa yang masuk hash ===');

// Prefix dibuang sebelum di-hash. Kalau tidak, semua hash akan shares prefix
// yang sama dan penyaringan lewat index bocor informasi yang tidak perlu.
eq('hash sama untuk token dan token tanpa prefix',
  hashToken(t1.token), hashToken(t1.token.slice(PREFIX_TOKEN.length)));
ok('hash tidak sama dengan SHA-256 token utuh',
  hashToken(t1.token) !== require('crypto').createHash('sha256').update(t1.token, 'utf8').digest('hex'));
ok('hash token dan hash token lain berbeda', hashToken(t1.token) !== hashToken(t2.token));
eq('hash bersifat deterministik', hashToken(t1.token), hashToken(t1.token));

// Kunci berbeda harus menghasilkan hash berbeda walau string-nya mirip.
ok('hash satu karakter beda', hashToken(PREFIX_TOKEN + 'A'.repeat(43)) !== hashToken(PREFIX_TOKEN + 'B'.repeat(43)));

// ---------------------------------------------------------------------------
console.log('=== 3. Argumen ===');

eq('perintah di posisi pertama', parseArgs(['terbit', '--agency', 'BKKBN']).perintah, 'terbit');
eq('--category terpisah dari --agency', parseArgs(['terbit', '--agency', 'A', '--category', 'K']).category, 'K');
eq('--table terpisah', parseArgs(['terbit', '--agency', 'A', '--table', 'records']).table, 'records');
ok('--standby jadi boolean', parseArgs(['terbit', '--agency', 'A', '--standby']).standby === true);
ok('tanpa --standby tetap false', parseArgs(['terbit', '--agency', 'A']).standby === false);

lemparThrows('perintah tak dikenal ditolak', () => parseArgs(['hapus']), 'tak dikenal');
lemparThrows('perintah wajib ada', () => parseArgs([]), 'wajib');
lemparThrows('flag tanpa nilai ditolak', () => parseArgs(['terbit', '--agency']), 'butuh nilai');
lemparThrows('flag tanpa nilai tidak mengambil flag berikutnya', () => parseArgs(['terbit', '--agency', '--standby']), 'butuh nilai');
lemparThrows('argumen tak dikenal ditolak', () => parseArgs(['terbit', '--ngawur']), 'tak dikenal');
// `node tools/api-keys.js --help` tanpa perintah HARUS bisa jalan: kalau tidak,
// siapa pun yang butuh bantuan harusebak cara menampilkan bantuan dulu.
ok('--help jalan tanpa perintah', parseArgs(['--help']).help === true);
ok('--help tanpa perintah tidak menjadi perintah', parseArgs(['--help']).perintah === null);

// ---------------------------------------------------------------------------
console.log('=== 4. SQL terbit ===');

const sqlP = sqlTerbit({ agency: 'BKKBN', category: null, table: null, label: 'x' }, t1);
ok('status primary untuk kunci biasa', sqlP.indexOf("'primary'::agency_key_status") > 0);
ok('activated_at diisi untuk primary', sqlP.indexOf('       now(),\n       now()') > 0);
ok('agency_id disubquery ke agencies.name', sqlP.indexOf('WHERE a.name = ') > 0);
ok('agency_id bukan angka langsung', !/agency_id\s*,\s*\n\s*'\d/.test(sqlP));
ok('INSERT menyebut kolom key_prefix', sqlP.indexOf('key_prefix') > 0);
ok('INSERT menyebut kolom last_used_at TIDAK', sqlP.indexOf('last_used_at') < 0);

const sqlS = sqlTerbit({ agency: 'BKKBN', category: 'a', table: null, label: null, standby: true }, t1);
ok('status standby untuk --standby', sqlS.indexOf("'standby'::agency_key_status") > 0);
ok('activated_at NULL untuk standby', sqlS.indexOf('       now(),\n       NULL') > 0);
ok('category tersimpan', sqlS.indexOf("       'a',") > 0);
ok('table NULL untuk category saja', sqlS.indexOf('       NULL,\n       NULL,') > 0);

// Escape: nama instansi dengan apostrof harus tidak menutup string SQL.
const sqlQ = sqlTerbit({ agency: "O'Brien", category: null, table: null, label: null }, t1);
ok('apostrof di nama agency di-escape', sqlQ.indexOf("a.name = 'O''Brien'") > 0);
ok('tidak ada string SQL yang bocor akibat apostrof', !sqlQ.indexOf("'O'Brien'") >= 0);

// Hash harus muncul persis, apa adanya, tanpa tanda kutip asing.
ok('hash ditulis sebagai string', sqlP.indexOf("'" + t1.hash + "'") > 0);

// --category harus mengecek grant, bukan hanya menempelkan teks.
//
// FK majemuk di DDL sudah menolak kategori yang tidak ada, tapi pesan
// PostgreSQL-nya tidak menyebut agency mana. Kalau CLI diam saja, operator
// akan melihat "violates foreign key constraint" tanpa petunjuk apa yang harus
// diperbaiki -- padahal masalahnya mungkin agency's yang belum di-grant kategori
// itu, bukan salah ketik di baris perintah.
const sqlK = sqlTerbit({ agency: 'BKKBN', category: 'Catin', table: null, label: null }, t1);
ok('--category menambahkan cek EXISTS ke agency_categories',
  /EXISTS \(SELECT 1 FROM agency_categories c/.test(sqlK));
ok('cek EXISTS mengikat agency yang sama', /c\.agency_id = a\.id/.test(sqlK));
ok('cek EXISTS mencocokkan jenis_sasaran', /c\.jenis_sasaran = 'Catin'/.test(sqlK));
ok('pesan galat menyebut kedua kemungkinan',
  sqlK.indexOf('tidak ditemukan ATAU') > 0 && sqlK.indexOf('agency_categories c') > 0);

// Kunci tanpa kategori tidak boleh ikut ter-filter. Kalau ikut, kunci universal
// jadi mustahil diterbitkan -- dan itu tidak akan terlihat sebagai bug, hanya
// sebagai "kategori tidak ditemukan" yang membuat orang mengira masalahnya di
// agency_categories.
//
// Yang diperiksa adalah bagian yang MENJALANKAN INSERT, bukan seluruh SQL.
// Petunjuk diagnosis di akhir memang sengaja menyebut agency_categories untuk
// kedua kasus -- supaya operator tahu apa yang harus dicek -- jadi mengujinya
// di seluruh teks akan salah, karena yang dijamin adalah kueri utama tidak
// ikut ter-filter.
const sqlTanpaKat = sqlTerbit({ agency: 'BKKBN', category: null, table: null, label: null }, t1);
const bagianInsert = sqlTanpaKat.slice(0, sqlTanpaKat.indexOf('-- Kalau tidak ada baris'));
ok('tanpa --category tidak ada cek EXISTS', bagianInsert.indexOf('EXISTS') < 0);
ok('tanpa --category tidak menyebut agency_categories di kueri utama',
  bagianInsert.indexOf('agency_categories') < 0);
ok('kunci universal tetap terbit tanpa cek grant',
  bagianInsert.indexOf('WHERE a.name = ') > 0 && bagianInsert.indexOf('EXISTS') < 0);
ok('kunci universal tidak diam-diam dibatasi kategori',
  sqlTanpaKat.indexOf("'Catin'") < 0);

// ---------------------------------------------------------------------------
console.log('=== 5. SQL cabut ===');

const sqlC = sqlCabut({ keyHash: 'abc123', by: 'admin' });
ok('status jadi revoked', sqlC.indexOf("SET status = 'revoked'") > 0);
ok('revoked_at diisi', sqlC.indexOf('revoked_at = now()') > 0);
ok('revoked_by diisi', sqlC.indexOf("revoked_by = 'admin'") > 0);

// Ini keputusan yang paling mudah dilanggar tanpa disadari. Kalau cabut ikut
// mengaktifkan standby, "primary dicabut = akses berhenti" jadi tidak berlaku.
ok('cabut TIDAK mengaktifkan standby', sqlC.indexOf("'primary'") < 0);
ok('cabut TIDAK menyentuh agency_api_keys status lain', sqlC.indexOf("SET status = 'standby'") < 0);
ok('cabut adalah UPDATE bukan DELETE', sqlC.indexOf('DELETE FROM agency_api_keys') < 0 && sqlC.indexOf('UPDATE agency_api_keys') > 0);
ok('cabut menampilkan SELECT lebih dulu', sqlC.indexOf('SELECT id, agency_id') > 0);

const sqlC2 = sqlCabut({ keyHash: 'abc', by: "O'Brien" });
ok('apostrof di --by di-escape', sqlC2.indexOf("revoked_by = 'O''Brien'") > 0);

// ---------------------------------------------------------------------------
console.log('=== 6. sqlQuote ===');

eq('NULL untuk null', sqlQuote(null), 'NULL');
eq('NULL untuk undefined', sqlQuote(undefined), 'NULL');
eq('angka jadi string', sqlQuote(42), "'42'");
eq('kutip tunggal di-escape ganda', sqlQuote("a'b"), "'a''b'");
eq('string kosong tetap kutip', sqlQuote(''), "''");

// ---------------------------------------------------------------------------
console.log('=== 7. Bantuan ===');

ok('bantuan menyebut ketiga perintah', ['terbit', 'cabut', 'demo'].every((p) => BANTUAN.includes(p)));
ok('bantuan menjelaskan token hanya tampil sekali', BANTUAN.includes('SATU KALI'));
ok('bantuan memperingatkan hash tidak bisa dipulihkan', BANTUAN.includes('tidak akan ditampilkan lagi') || BANTUAN.includes('cari token lama'));
ok('bantuan menyebut --standby tidak aktif otomatis', BANTUAN.includes('Tidak bisa dipakai sampai dipromosikan manual'));

// ---------------------------------------------------------------------------
console.log('\nlulus: ' + lulus + '  gagal: ' + gagal);
if (gagal === 0) console.log('SEMUA UJI LOLOS');
process.exit(gagal === 0 ? 0 : 1);