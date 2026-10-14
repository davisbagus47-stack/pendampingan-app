/**
 * Uji self-check generator: memastikan generator MENOLAK sumber yang tidak
 * lengkap, alih-alih diam-diam menghasilkan skema yang salah.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = 'C:/Users/davis/pendampingan-app/backend';
const INDEX = path.join(BACKEND, 'index.js');
const GEN = path.join(BACKEND, 'tools', 'generate-schema.js');

const original = fs.readFileSync(INDEX, 'utf8');
const sqlPath = path.join(BACKEND, 'sql', '001_schema.sql');
const originalSql = fs.readFileSync(sqlPath, 'utf8');

const cases = [
  {
    name: 'field ditambahkan tapi tanpa label di LABELS',
    from: "'timTPK', 'pendampinganKe', 'jenisKelamin', 'mbg3B',",
    to: "'timTPK', 'pendampinganKe', 'jenisKelamin', 'mbg3B', 'kolomUji',",
    expect: 'Field tanpa label: kolomUji',
  },
  {
    name: 'field ditambahkan tapi tidak ada di form (tanpa section)',
    from: "'hadirPosyandu', 'teridentifikasiRisiko',",
    to: "'hadirPosyandu', 'teridentifikasiRisiko', 'kolomUji',",
    alsoLabel: true,
    expect: 'Field tanpa section: kolomUji',
  },
  {
    name: 'section D diberi huruf di luar A..I ("Z.")',
    file: path.join(BACKEND, '..', 'frontend', 'src', 'pages', 'FormPendampingan.jsx'),
    from: '<h2 className="card-title">D. Faktor Risiko 4T</h2>',
    to: '<h2 className="card-title">Z. Faktor Risiko 4T</h2>',
    expect: 'tidak dikenal sebagai A..I',
  },
  {
    name: 'seluruh penanda section dihapus dari form',
    file: path.join(BACKEND, '..', 'frontend', 'src', 'pages', 'FormPendampingan.jsx'),
    from: '<h2 className="card-title">',
    to: '<h2 className="card-title-xx">',
    expect: 'Field tanpa section: namaTPK',
  },
  {
    // Regresi nyata: kolom bentrok dengan kolom metadata yang ditulis tangan
    // membuat PostgreSQL menolak dengan "specified more than once", dan itu
    // hanya ketahuan saat server berjalan -- tidak saat generator sukses.
    name: 'field bernama "status" (bentrok dengan kolom metadata)',
    from: "'hadirPosyandu', 'teridentifikasiRisiko',",
    to: "'hadirPosyandu', 'teridentifikasiRisiko', 'status',",
    labelOf: 'status',
    expect: 'bentrok dengan kolom metadata',
  },
];

// ---------------------------------------------------------------------------
// Invariant agency_api_keys (F3.10a, 2026-10-06).
//
// Ini diuji di sini, bukan di test-generate-schema yang lain, karena yang
// diuji BUKAN perilaku generator -- generator tidak bisa salah soal ini. Yang
// diuji adalah apakah keputusan yang disepakati masih tertulis di DDL setelah
// refactor berikutnya.
//
// Alasannya spesifik: tanpa pemeriksaan ini, menghapus satu index unik
// bersyarat akan lolos semua uji yang ada, lalu produksi diam-diam menerima dua
// kunci primary untuk satu instansi. Dua identitas aktif, dan tidak ada yang
// berteriak.
// ---------------------------------------------------------------------------
function cek(nama, syarat) {
  console.log((syarat ? 'OK    ' : 'GAGAL ') + nama);
  if (!syarat) failed++;
}
let failed = 0;
const ddlAsli = originalSql;
cek('agency_api_keys ada di DDL', ddlAsli.indexOf('CREATE TABLE agency_api_keys') > 0);
cek('hanya satu primary per instansi', ddlAsli.indexOf('idx_agency_api_keys_one_primary') > 0 && ddlAsli.indexOf('idx_agency_api_keys_one_standby') > 0);
cek('index unik itu benar-benar UNIQUE', /idx_agency_api_keys_one_primary[\s\S]{0,120}ON agency_api_keys \(agency_id\) WHERE status = 'primary'/.test(ddlAsli));
cek('status punya tiga nilai', ddlAsli.indexOf("'primary', 'standby', 'revoked'") > 0);
cek('key_prefix ada untuk display', /key_prefix\s+TEXT\s+NOT NULL/.test(ddlAsli));
cek('scope tidak boleh setengah batasan', ddlAsli.indexOf('agency_api_keys_scope_whole') > 0);
cek('token disimpan sebagai hash, ada key_hash UNIQUE', /key_hash\s+TEXT\s+NOT NULL UNIQUE/.test(ddlAsli));
cek('last_used_at ada untuk jejak audit', ddlAsli.indexOf('last_used_at') > 0);

// category terkunci ke agency_categories (keputusan 2026-10-06).
//
// FK-nya MAJEMUK, dan itu bukan pilihan gaya. `agency_categories` PK-nya
// (agency_id, jenis_sasaran), jadi kolom `category` yang hanya berisi
// "Catin" tidak bisa sendiri-sendiri dijamin ada. Majemuk sekaligus menjawab
// pertanyaan yang lebih penting: bukan "apakah kategori ini ada", tapi
// "apakah agency ini memang DIBERI kategori ini".
//
// Kalau FK ini hilang, kunci bisa dibatasi ke kategori yang agency-nya tidak
// punya grant -- dan{kunci} itu akan terlihat sah di aplikasi, lalu ditolak
// hanya di lapisan RLS yang belum ada.
cek('category punya FK majemuk ke agency_categories',
  /FOREIGN KEY \(agency_id, category\)\s*\n?\s*REFERENCES agency_categories \(agency_id, jenis_sasaran\)/.test(ddlAsli));
cek('FK ikut mend cascades saat grant kategori dicabut',
  /REFERENCES agency_categories \(agency_id, jenis_sasaran\) ON DELETE CASCADE/.test(ddlAsli));
// Kalau dibikin FK satu kolom dengan memaksa UNIQUE pada jenis_sasaran, setiap
// agency bisa punya kategori yang sama berulang -- yang membatalkan makna
// kolom agency_categories.
cek('tidak ada UNIQUE paksa pada jenis_sasaran',
  !/UNIQUE\s*\(\s*jenis_sasaran\s*\)/.test(ddlAsli));

for (const c of cases) {
  const target = c.file || INDEX;
  const src = fs.readFileSync(target, 'utf8');
  if (!src.includes(c.from)) {
    console.log('LEWAT  ' + c.name + '  (pola tidak ditemukan - test tidak valid)');
    failed++;
    continue;
  }
  let mutated = src.replace(c.from, c.to);
  if (c.alsoLabel) {
    mutated = mutated.replace("mbg3B: 'Sudah Menerima MBG 3B',", "mbg3B: 'Sudah Menerima MBG 3B', kolomUji: 'Kolom Uji',");
  }
  if (c.labelOf) {
    mutated = mutated.replace(
      "mbg3B: 'Sudah Menerima MBG 3B',",
      "mbg3B: 'Sudah Menerima MBG 3B', " + c.labelOf + ": 'Kolom Uji Bentrok',"
    );
  }
  fs.writeFileSync(target, mutated, 'utf8');
  let output = '';
  let code = 0;
  try {
    output = execFileSync(process.execPath, [GEN], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    output = (e.stderr || '') + (e.stdout || '');
    code = e.status === undefined ? 1 : e.status;
  }
  fs.writeFileSync(target, src, 'utf8');

  const rejected = code !== 0;
  console.log((rejected ? 'TOLAK ' : 'TERIMA') + '  ' + c.name);
  if (rejected) {
    const line = (output.split('\n').find((l) => l.trim().startsWith('- ')) || output.split('\n').find((l) => l.includes('Error')) || '').trim();
    console.log('        ' + line);
    // Wajib cocok dengan alasan yang dimaksud, bukan sekadar "tidak nol".
    // Tanpa ini, kasus di bawah akan lulus karena alasan lain yang kebetulan
    // lebih dulu muncul dan bug aslinya tetap lolos.
    if (c.expect) {
      const matched = output.includes(c.expect);
      console.log('        alasan: ' + (matched ? 'benar' : 'SALAH - diharapkan "' + c.expect + '"'));
      if (!matched) failed++;
    }
  } else {
    failed++;
  }
}

// pastikan berkas kembali seperti semula
fs.writeFileSync(sqlPath, originalSql, 'utf8');
console.log('\nsql dipulihkan: ' + (fs.readFileSync(sqlPath, 'utf8') === originalSql));

// ---------------------------------------------------------------------------
// Uji validate-sql.js sebagai alat.
//
// Bagian di atas menguji generator. Bagian ini menguji validator-nya sendiri,
// karena generator yang benar tidak menolong kalau validasinya berbohong.
// validate-sql versi lama melaporkan "SINTAKS VALID" untuk skema yang pasti
// gagal dijalankan: records.institution_id merujuk agencies, agencies dibuat
// belakangan. Parser PostgreSQL yang benar menerima keduanya; hanya pemeriksaan
// dependensi yang bisa menangkapnya.
// ---------------------------------------------------------------------------

console.log('\n--- uji validate-sql ---');

const VAL = path.join(BACKEND, 'tools', 'validate-sql.js');
const tmpSql = path.join(BACKEND, 'sql', '_uji_urutan.sql');

const validateCases = [
  {
    name: 'FK ke tabel yang dibuat belakangan harus ditolak',
    sql: [
      'CREATE TABLE records (',
      '  id BIGSERIAL PRIMARY KEY,',
      '  institution_id TEXT NOT NULL REFERENCES agencies(institution_key)',
      ');',
      'CREATE TABLE agencies (',
      '  institution_key TEXT NOT NULL PRIMARY KEY',
      ');',
    ].join('\n'),
    expect: 'URUTAN SALAH',
  },
  {
    name: 'FK level kolom yang benar urutan harus diterima',
    sql: [
      'CREATE TABLE agencies (',
      '  institution_key TEXT NOT NULL PRIMARY KEY',
      ');',
      'CREATE TABLE records (',
      '  id BIGSERIAL PRIMARY KEY,',
      '  institution_id TEXT NOT NULL REFERENCES agencies(institution_key)',
      ');',
    ].join('\n'),
    expect: 'SINTAKS VALID',
  },
  {
    name: 'FK level tabel juga diperiksa, bukan hanya level kolom',
    sql: [
      'CREATE TABLE records (',
      '  id BIGSERIAL PRIMARY KEY,',
      '  institution_id TEXT NOT NULL,',
      '  FOREIGN KEY (institution_id) REFERENCES agencies(institution_key)',
      ');',
      'CREATE TABLE agencies (',
      '  institution_key TEXT NOT NULL PRIMARY KEY',
      ');',
    ].join('\n'),
    expect: 'URUTAN SALAH',
  },
  {
    name: 'FK merujuk diri sendiri tetap sah',
    sql: [
      'CREATE TABLE records (',
      '  id BIGSERIAL PRIMARY KEY,',
      '  supersedes_id BIGINT REFERENCES records(id)',
      ');',
    ].join('\n'),
    expect: 'SINTAKS VALID',
  },
];

for (const c of validateCases) {
  fs.writeFileSync(tmpSql, c.sql + '\n', 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [VAL, tmpSql], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status === undefined ? 1 : e.status;
  }
  const matched = out.includes(c.expect);
  const ok = matched;
  console.log((ok ? 'LOLOS ' : 'GAGAL ') + c.name);
  if (!ok) {
    failed++;
    console.log('        diharapkan "' + c.expect + '", dapat: ' +
      (out.split('\n').filter((l) => l.includes('SINTAKS') || l.includes('URUTAN'))
        .map((l) => l.trim()).join(' / ') || '(tidak ada baris kesimpulan, exit=' + code + ')'));
  }
}

if (fs.existsSync(tmpSql)) fs.unlinkSync(tmpSql);

// ---------------------------------------------------------------------------
// Uji pagar generator terhadap REQUIRED_SCHEMA_MARKERS.
//
// Menghapus institution_id tidak merusak apa pun yang kelihatan: sintaks
// tetap sah, generator tetap sukses, 96 uji kanonikal tetap hijau. Yang rusak
// adalah FR-4.3, karena tidak ada lagi yang bisa memberi tahu commitment itu
// milik instansi mana. Pagar ini ada supaya kegagalan itu muncul sebagai
// galat generator, bukan sebagai temuan diSidang.
// ---------------------------------------------------------------------------

console.log('\n--- uji pagar generator ---');

const genOriginal = fs.readFileSync(GEN, 'utf8');

const guardCases = [
  {
    name: 'hapus emit institution_id harus ditolak',
    from: "  w('  institution_id  TEXT        NOT NULL REFERENCES agencies(institution_key),');",
    to: "  w('  institution_id  TEXT        NULL,');",
    expect: 'institution_id',
  },
  {
    name: 'hapus institution_key di agencies harus ditolak',
    from: "  w('  institution_key TEXT    NOT NULL UNIQUE');",
    to: "  w('  institution_key TEXT    NULL');",
    expect: 'institution_key',
  },
];

for (const c of guardCases) {
  if (!genOriginal.includes(c.from)) {
    console.log('LEWAT  ' + c.name + '  (pola tidak ditemukan - test tidak valid)');
    failed++;
    continue;
  }
  fs.writeFileSync(GEN, genOriginal.replace(c.from, c.to), 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [GEN], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stderr || '') + (e.stdout || '');
    code = e.status === undefined ? 1 : e.status;
  }
  fs.writeFileSync(GEN, genOriginal, 'utf8');

  const rejected = code !== 0 && out.includes(c.expect);
  console.log((rejected ? 'TOLAK ' : 'TERIMA') + '  ' + c.name);
  if (!rejected) {
    failed++;
    if (code === 0) console.log('        generator tetap sukses - pagar tidak bekerja');
    else console.log('        alasan tidak cocok, diharapkan "' + c.expect + '"');
  }
}

// generator harus pulih utuh
fs.writeFileSync(GEN, genOriginal, 'utf8');
const genRestored = fs.readFileSync(GEN, 'utf8') === genOriginal;
console.log('generator dipulihkan: ' + genRestored);
if (!genRestored) failed++;

// ---------------------------------------------------------------------------
// Uji pagar kolom terlarang.
//
// Kelima kolom terlarang tertulis di DDL lewat lib/column-grants.js. Dua
// mutasi berikut mengembalikan generator dengan kode keluar 0 -- artinya DDL
// yang dihasilkan tetap "sintaks valid" dan semua uji skema tetap hijau,
// padahal blokir yang dijanjikan PRD 6.4.1a sudah lenong. Itu sebabnya kedua
// mutasi harus diuji di sini.
// ---------------------------------------------------------------------------

console.log('\n--- uji pagar kolom terlarang ---');

const GRANTS = path.join(BACKEND, 'lib', 'column-grants.js');
const grantsOriginal = fs.readFileSync(GRANTS, 'utf8');

const grantsGuardCases = [
  {
    name: 'kolom terlarang dihapus satu (nikAyah)',
    from: "  'nikAyah', 'nikIbu',",
    to: "  'nikIbu',",
    expect: 'nik_ayah',
  },
  {
    // Nama asing harus berhenti di lib/column-grants.js, bukan hanya lewat
    // pencocokan DDL. Dua-duanya menolak, tapi alasan yang benar lebih berguna.
    name: 'kolom terlarang diganti nama yang tidak ada di form',
    from: "'namaAyah', 'namaIbu',",
    to: "'kolomYangTidakAda', 'namaIbu',",
    expect: 'tidak ada di lib/column-grants.js',
  },
  {
    // Mutasi yang paling penting: nama tetap sah dan urutannya pun sama, tapi
    // satu blokir diganti dengan kolom yang memang boleh diekspor. Yang hilang
    // adalah nik_ayah, dan tidak ada error sintaks yang muncul.
    name: 'kolom terlarang diganti nama yang sah tapi tidak boleh diblokir',
    from: "'nikAyah', 'nikIbu',",
    to: "'namaTPK', 'nikIbu',",
    expect: 'nik_ayah',
  },
  {
    name: 'daftar kolom terlarang dikosongkan',
    from: /const DENIED_BAWAAN = \[[\s\S]*?\];/,
    to: 'const DENIED_BAWAAN = [];',
    expect: 'DENIED_BAWAAN kosong',
  },
];

for (const c of grantsGuardCases) {
  const src = fs.readFileSync(GRANTS, 'utf8');
  const mutated = src.replace(c.from, c.to);
  if (mutated === src) {
    console.log('LEWAT  ' + c.name + '  (pola tidak ditemukan - test tidak valid)');
    failed++;
    continue;
  }
  fs.writeFileSync(GRANTS, mutated, 'utf8');
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [GEN], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stderr || '') + (e.stdout || '');
    code = e.status === undefined ? 1 : e.status;
  }
  // SQL juga harus dipulihkan: generator yang berhenti sebelum menulis tidak
  // mengubah berkas, tapi generator yang berhasil menulis akan. Kalau tidak
  // dipulihkan, DDL yang tersisa adalah hasil mutasi -- persis kesalahan yang
  // seharusnya ditangkap oleh uji berikutnya.
  fs.writeFileSync(GRANTS, src, 'utf8');
  fs.writeFileSync(sqlPath, originalSql, 'utf8');

  const rejected = code !== 0 && out.includes(c.expect);
  console.log((rejected ? 'TOLAK ' : 'TERIMA') + '  ' + c.name);
  if (!rejected) {
    failed++;
    if (code === 0) console.log('        generator tetap sukses - pagar tidak bekerja');
    else console.log('        alasan tidak cocok, diharapkan "' + c.expect + '"');
  }
}

// Fungsi denied_columns harus menggabungkan bawaan dan tambahan agency. Kalau
// hanya membaca tabel, agency dengan tabel kosong otomatis dapat kelima kolom.
fs.writeFileSync(GRANTS, grantsOriginal, 'utf8');
const ddlNow = fs.readFileSync(sqlPath, 'utf8');
const fnBody = (ddlNow.match(/CREATE OR REPLACE FUNCTION denied_columns[\s\S]*?\$fn\$ LANGUAGE sql STABLE;/) || [''])[0];
// Daftar dibaca dari blok hardcoded di generator, bukan dari lib/column-grants.js
// yang barusan dimutasi. Kalau sumbernya ikut berubah, pemeriksaan ini akan
// cocok dengan dirinya sendiri dan tidak bernilai.
const builtinKeys = (function () {
  const list = /const DENIED_BAWAAN_KEYS_HARFAP = \[([\s\S]*?)\];/.exec(genOriginal);
  return list ? (list[1].match(/'[a-z_]+'/g) || []).map((s) => s.replace(/'/g, '')) : [];
})();
if (builtinKeys.length === 0) {
  console.log('        daftar hardcoded tidak ditemukan - pemeriksaan dilewati');
  failed++;
}
console.log('\n--- denied_columns memakai bawaan ---');
let fnOk = fnBody.length > 0;
if (!fnOk) {
  console.log('        fungsi denied_columns tidak ditemukan di DDL');
  failed++;
} else {
  for (const k of builtinKeys) {
    const present = fnBody.includes("'" + k + "'");
    console.log((present ? 'ADA   ' : 'TIDAK ') + '  ' + k + ' tertulis di dalam fungsi');
    if (!present) failed++;
  }
  const merges = /UNION/.test(fnBody) && /agency_denied_columns/.test(fnBody);
  console.log((merges ? 'ADA   ' : 'TIDAK ') + '  fungsi membaca juga agency_denied_columns');
  if (!merges) failed++;
}

console.log('\nlulus: ' + (validateCases.length + guardCases.length + grantsGuardCases.length + builtinKeys.length + 1) + '  gagal: ' + failed);
console.log(failed === 0 ? 'SEMUA UJI LOLOS' : failed + ' UJI GAGAL');
process.exit(failed === 0 ? 0 : 1);
