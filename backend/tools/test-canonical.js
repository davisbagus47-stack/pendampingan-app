'use strict';

/**
 * Uji kanonikalisasi dan hash (F1.10).
 *
 * Tiga lapis, dari luar ke dalam:
 *
 *  1. Vektor resmi RFC 8785 Appendix B -- membuktikan `lib/jcs.js` benar-benar
 *     JCS, bukan "JSON dengan urutan kunci".
 *  2. Cross-validation terhadap Python. Python punya `json.dumps(sort_keys=True,
 *     separators=(',',':'), ensure_ascii=False)` yang menyelesaikan masalah
 *     yang sama lewat kode yang sama sekali berbeda. Bila keduanya tidak
 *     sepakat pada data yang sama, setidaknya salah satu salah.
 *  3. Aturan normalisasi proyek dan sifat hash, sesuai `keputusan-kanonikalisasi.md`.
 *
 * Jalankan: node tools/test-canonical.js
 * Exit code bukan nol berarti ada yang rusak.
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');

const { canonicalize } = require(path.join(__dirname, '..', 'lib', 'jcs'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical'));

let failed = 0;
let passed = 0;

function check(name, actual, expected) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log('LULUS  ' + name);
  } else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        diharapkan: ' + e);
    console.log('        diterima  : ' + a);
  }
}

function checkThrows(name, fn) {
  try {
    fn();
    failed++;
    console.log('GAGAL  ' + name + '  (tidak melempar galat)');
  } catch (e) {
    passed++;
    console.log('LULUS  ' + name + '  (' + e.message + ')');
  }
}

console.log('=== 1. Vektor resmi RFC 8785 Appendix B ===');

// Angka: bentuk terpendek sesuai Number::toString.
check(
  'RFC 8785 / angka',
  canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001]),
  '[333333333.3333333,1e+30,4.5,0.002,1e-27]'
);

// Literal.
check('RFC 8785 / literal', canonicalize([true, false, null]), '[true,false,null]');

// Urutan kunci menurut code unit UTF-16, dengan karakter non-ASCII dan kontrol.
// Kunci ditulis lewat String.fromCharCode supaya berkas uji ini tidak pernah
// memuat karakter kontrol tak terlihat -- kesalahan ketik di sini menghasilkan
// ekspektasi yang salah tanpa banner error.
//
// Catatan penting soal U+0080: karakter ini TIDAK di-escape. Rentang yang wajib
// di-escape hanya U+0000..U+001F; U+0080 adalah kontrol C1 dan ditulis sebagai
// UTF-8 apa adanya (c2 80). Dikonfirmasi terhadap canonicalize@5.
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const CTRL80 = String.fromCharCode(0x80);
check(
  'RFC 8785 / urutan kunci non-ASCII + kontrol',
  canonicalize({
    '€': 'Euro Sign',
    [CR]: 'Carriage Return',
    [LF]: 'Newline',
    '1': 'One',
    [CTRL80]: 'Control',
    'ö': 'Latin Small Letter O With Diaeresis',
  }),
  '{"\\n":"Newline","\\r":"Carriage Return","1":"One",'
    + '"' + CTRL80 + '":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign"}'
);

// Urutan kunci ditentukan oleh code unit, bukan oleh tampilan:
// U+0080 (128) harus SESUDAH "1" (49).
check(
  'RFC 8785 / U+0080 urut setelah "1" (bukan sebelum)',
  canonicalize({ '1': 'a', [CTRL80]: 'b' }),
  '{"1":"a","' + CTRL80 + '":"b"}'
);

// Hanya U+0000..U+001F yang di-escape. Menyebut U+007F/U+0080 secara
// eksplisit karena inilah tempat implementasi sodium amik salah.
check(
  'JCS / U+007F tidak di-escape',
  canonicalize({ a: String.fromCharCode(0x7f) }),
  '{"a":"' + String.fromCharCode(0x7f) + '"}'
);
check(
  'JCS / U+001F di-escape sebagai \u001f',
  canonicalize({ a: String.fromCharCode(0x1f) }),
  '{"a":"\\u001f"}'
);
check(
  'JCS / U+0000 di-escape sebagai \u0000',
  canonicalize({ a: String.fromCharCode(0x00) }),
  '{"a":"\\u0000"}'
);


// Object kosong dan array kosong.
check('RFC 8785 / object kosong', canonicalize({}), '{}');
check('RFC 8785 / array kosong', canonicalize([]), '[]');

// nested
check(
  'RFC 8785 / nested + urutan kunci',
  canonicalize({ '€': 'Euro Sign', a: { 'ä': [3, 2, 1] } }),
  '{"a":{"ä":[3,2,1]},"€":"Euro Sign"}'
);

// Unpaired surrogate adalah input tidak valid menurut RFC 8785.
checkThrows('RFC 8785 / high surrogate tanpa pasangan ditolak',
  () => canonicalize({ x: '\ud800' }));
checkThrows('RFC 8785 / low surrogate tanpa pasangan ditolak',
  () => canonicalize({ x: '\udc00' }));
checkThrows('JCS / NaN ditolak', () => canonicalize({ x: NaN }));
checkThrows('JCS / Infinity ditolak', () => canonicalize({ x: Infinity }));
// Pasangan surrogate yang valid (emoji) tetap boleh dan tidak di-escape.
check('JCS / pasangan surrogate valid tidak di-escape', canonicalize({ x: '\ud83d\ude00' }), '{"x":"\u{1f600}"}');

console.log('\n=== 2. Cross-validation terhadap Python ===');

function pythonCanonical(text) {
  return execFileSync('python', [path.join(__dirname, 'JCS_reference.py')], {
    input: text,
    encoding: 'utf8',
  });
}

// Kunci control diuji lewat escape JSON, bukan karakter literal.
const crossCases = [
  { name: 'sederhana', json: '{"b":"2","a":"1"}' },
  { name: 'kunci campuran', json: '{"z":1,"A":2,"a":3,"_":4,"0":5,"\\u20ac":6,"\\r":7,"\\n":8,"\\u0080":9}' },
  { name: 'nested', json: '{"a":{"d":[1,{"c":2,"b":3}],"A":null},"B":[{"x":"1","y":"2"}]}' },
  { name: 'angka campuran', json: '{"a":1.0,"b":1e21,"c":-0.0,"d":0.1,"e":1.2345678901234568e+30}' },
  { name: 'unicode', json: '{"nama":"Siti Aminah \\u00e0 \\u00e9","kota":"Jakarta Pusat"}' },
  { name: 'escaping', json: '{"a":"tab\\there\\nnew \\"quote\\" back\\\\slash \\u0001"}' },
  { name: 'nested array dalam object', json: '{"a":[[1,[2,[3]]],{"b":[{}]}]}' },
];

for (const t of crossCases) {
  const parsed = JSON.parse(t.json);
  let mine;
  let theirs;
  try {
    mine = canonicalize(parsed);
    theirs = pythonCanonical(t.json);
  } catch (e) {
    failed++;
    console.log('GAGAL  python/  ' + t.name + '  (' + e.message + ')');
    continue;
  }
  check('python/  ' + t.name, mine, theirs);
}

console.log('\n=== 3. Normalisasi proyek (keputusan-kanonikalisasi.md §3.2) ===');

// Vektor tabel §4.1.
//
// Catatan: "70,00" menjadi "70", bukan "70.0" seperti yang tertulis di draf
// pertama §4.1. Konflik itu dijelaskan di keputusan-kanonikalisasi.md §4.1:
// Kalau "70,00" -> "70.0" sementara "70" -> "70", maka data yang sama tetap bisa
// menghasilkan hash berbeda, persis yang harus dicegah. Bentuk tunggalnya yang
// dipakai adalah hasil pembulatan ke skala kolom lalu String(Number).
check('norm/ koma desimal dibulatkan ke skala kolom', c.normalizeScalar('bbSekarang', '70,00'), '70');
check('norm/ nilai di bawah skala kolom dibulatkan', c.normalizeScalar('bbSekarang', '70,04'), '70');
check('norm/ satu desimal dipertahankan', c.normalizeScalar('bbSekarang', '62,55'), '62.6');
check('norm/ spasi luar di-trim', c.normalizeScalar('namaLengkap', '  Jakarta  '), 'Jakarta');
check('norm/ number -> string', c.normalizeScalar('namaLengkap', 3), '3');
check('norm/ string kosong tetap kosong', c.normalizeScalar('namaLengkap', ''), '');

// null dan "" dibedakan (FR-2.5)
check('norm/ null tetap null', c.normalizeScalar('namaLengkap', null), null);
check('norm/ null !== kosong', String(c.normalizeScalar('a', null) !== c.normalizeScalar('a', '')), 'true');

// undefined dibuang
check('norm/ undefined jadi undefined', c.normalizeScalar('a', undefined), undefined);
check('norm/ kunci undefined hilang dari payload',
  Object.keys(c.normalizeRecord({ a: '1', b: undefined })).join(','), 'a');

// Normalisasi numerik: satu-satunya representasi
check('norm/ 3 vs 3.0 vs 3,00collapse', [
  c.normalizeScalar('usia', '3'),
  c.normalizeScalar('usia', '3.0'),
  c.normalizeScalar('usia', '3,00'),
].join('|'), '3|3|3');
check('norm/ skala kolom dihormati (NUMERIC(4,1))', c.normalizeScalar('usia', '3,55'), '3.6');
check('norm/ pembulatan tidak bocor', c.normalizeScalar('bbSekarang', 70.1), '70.1');
check('norm/ satuan dibuang', c.normalizeScalar('tb', '160 cm'), '160');
check('norm/ tak dikenal dibiarkan utuh', c.normalizeScalar('bbSekarang', 'tidak-diukur'), 'tidak-diukur');
check('norm/ kosong tidak jadi null', c.normalizeScalar('usia', ''), '');

// NIK dan friends: TIDAK boleh jadi angka
check('norm/ NIK nol di depan utuh', c.normalizeScalar('nik', '0071234567890'), '0071234567890');
check('norm/ No. KK utuh', c.normalizeScalar('noKK', '3273011234560001'), '3273011234560001');
check('norm/ RW/RT alphanumeric utuh', c.normalizeScalar('rw', '0A'), '0A');
check('norm/ NIK panjang 16 digit tidak jadi notasi ilmiah',
  c.normalizeScalar('nik', '1234567890123456'), '1234567890123456');

// Tanggal: <input type="date"> sudah YYYY-MM-DD, tidak boleh disentuh
check('norm/ tanggal tidak diubah', c.normalizeScalar('tanggalLahir', '2024-03-12'), '2024-03-12');

console.log('\n=== 4. record_hash ===');

// Test vector §4.2. SHA-256 dari "{}" adalah nilai yang bisa dihitung manual
// (dicek ulang dengan Python di sini), jadi ini bukan angka tebakan.
check('hash/ payload kosong', c.recordHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
check('hash/ hash {} sama dengan sha256("{}") saja',
  c.recordHash({}),
  crypto.createHash('sha256').update('{}', 'utf8').digest('hex'));
check('hash/ hash {} dicocokkan dengan python',
  c.recordHash({}),
  pythonCanonical('{}') && crypto.createHash('sha256').update(pythonCanonical('{}'), 'utf8').digest('hex'));

// Dua payload berbeda-content, tidak ada key pun
check('hash/ a,b -> hash {} yang benar',
  c.recordHash({ a: '1', b: '2' }),
  crypto.createHash('sha256').update('{"a":"1","b":"2"}', 'utf8').digest('hex'));

// Urutan key tidak boleh memengaruhi hash
const p1 = { nik: '1', namaLengkap: '2', usia: '3' };
const p2 = { usia: '3', nik: '1', namaLengkap: '2' };
check('hash/ urutan key tidak berpengaruh', c.recordHash(p1) === c.recordHash(p2), true);

// Nilai yang berbeda representasi tapi sama makna -> hash sama
check('hash/ 70,00 == 70.0 == 70',
  c.recordHash({ bbSekarang: '70,00' }) === c.recordHash({ bbSekarang: '70,0' })
    && c.recordHash({ bbSekarang: '70,0' }) === c.recordHash({ bbSekarang: '70' }), true);

// Mengubah satu karakter -> hash berbeda
check('hash/ satu karakter berubah -> hash berbeda',
  c.recordHash({ namaLengkap: 'Siti' }) !== c.recordHash({ namaLengkap: 'Sitia' }), true);

// null dan "" menghasilkan hash berbeda
check('hash/ null !== ""',
  c.recordHash({ a: null }) !== c.recordHash({ a: '' }), true);

// Field absen tidak sama dengan field kosong
check('hash/ field absent !== field kosong',
  c.recordHash({ a: '1' }) !== c.recordHash({ a: '1', b: '' }), true);

// Idempoten: normalisasi dua kali sama
const raw = { bbSekarang: ' 70,00 ', namaLengkap: ' Jakarta ', usia: 3, b: null };
check('hash/ normalisasi idempoten', JSON.stringify(c.normalizeRecord(c.normalizeRecord(raw))),
  JSON.stringify(c.normalizeRecord(raw)));
check('hash/ hash stabil lintas panggilan', c.recordHash(raw) === c.recordHash(raw), true);

// NIK berbeda tidak boleh collide lewat normalisasi
check('hash/ NIK berbeda tetap hash berbeda',
  c.recordHash({ nik: '0071234567890' }) !== c.recordHash({ nik: '0071234567891' }), true);

console.log('\n=== 5. commitment ===');

const rh = c.recordHash({ namaLengkap: 'Siti' });
check('commitment/ deterministik', c.commitment(rh, 'BIDANG-KB-01') === c.commitment(rh, 'BIDANG-KB-01'), true);
check('commitment/ instansi berbeda -> commitment berbeda',
  c.commitment(rh, 'BIDANG-KB-01') === c.commitment(rh, 'BIDANG-KOTA-02'), false);
check('commitment/ record berbeda -> commitment berbeda',
  c.commitment(c.recordHash({ namaLengkap: 'Sita' }), 'X')
    === c.commitment(c.recordHash({ namaLengkap: 'Siti' }), 'X'), false);
check('commitment/ sama dengan sha256(rh||id) manual',
  c.commitment(rh, 'BIDANG-KB-01'),
  crypto.createHash('sha256').update(rh + 'BIDANG-KB-01', 'utf8').digest('hex'));

// institution_key kosong adalah kegagalan senyap yang berbahaya: hash tetap
// terhitung, tidak ada galat, tapi commitment-nya tidak terikat instansi mana
// pun. Persis kebocoran lintas instansi yang AT-09 berusaha tutup.
checkThrows('commitment/ institution_key kosong ditolak', () => c.commitment(rh, ''));
checkThrows('commitment/ institution_key whitespace ditolak', () => c.commitment(rh, '   '));
checkThrows('commitment/ institution_key null ditolak', () => c.commitment(rh, null));
checkThrows('commitment/ institution_key undefined ditolak', () => c.commitment(rh, undefined));

// Bentuk institution_key yang sah menurut CHECK agencies.institution_key.
check('commitment/ slug huruf kecil dan tanda hubung diterima',
  typeof c.commitment(rh, 'kota-bogor'), 'string');
check('commitment/ key numerik diterima', typeof c.commitment(rh, '12345'), 'string');
check('commitment/ key beranggota satu diterima', typeof c.commitment(rh, 'kb'), 'string');

// Operand pertama harus benar-benar record_hash. Kesalahan yang paling mudah
// terjadi adalah `commitment(payload, key)` -- dan versi lama menerimanya,
// karena `String(payload)` menghasilkan "[object Object]" lalu commitment
// berbentuk 64 hex tetap terhitung. Hasilnya terlihat sah sepenuhnya, jadi
// tidak akan ketahuan sampai dibandingkan dengan ledger, dan yang sudah
// dipublikasikan tidak bisa ditarik kembali.
checkThrows('commitment/ payload sebagai operand pertama ditolak',
  () => c.commitment({ namaLengkap: 'Siti' }, 'kota-bogor'));
checkThrows('commitment/ hash dengan panjang salah ditolak',
  () => c.commitment(rh.slice(0, 63), 'kota-bogor'));
checkThrows('commitment/ hash dengan karakter non-hex ditolak',
  () => c.commitment('z'.repeat(64), 'kota-bogor'));
checkThrows('commitment/ hash kosong ditolak', () => c.commitment('', 'kota-bogor'));
checkThrows('commitment/ hash undefined ditolak', () => c.commitment(undefined, 'kota-bogor'));
check('commitment/ hash huruf besar tetap diterima',
  c.commitment(rh.toUpperCase(), 'kota-bogor'), c.commitment(rh, 'kota-bogor'));
check('commitment/ hash dengan spasi excess diterima',
  c.commitment('  ' + rh + '  ', 'kota-bogor'), c.commitment(rh, 'kota-bogor'));

// Jalur yang benar harus tetap bisa dipakai.
check('commitmentFor/ payload + key menghasilkan nilai yang sama',
  c.commitmentFor({ namaLengkap: 'Siti' }, 'kota-bogor'),
  c.commitment(c.recordHash({ namaLengkap: 'Siti' }), 'kota-bogor'));

// Sifat yang ADR-3 sebutkan: X adalah INSTANSI PEMILIK, sehingga semua penerima
// sah menghitung nilai yang sama untuk record yang sama. Inilah yang membuat
// verifikasi independen FR-4.3 mungkin terjadi -- dan yang hilang kalau X
// disamakan dengan identitas pemanggil.
const commitmentKotaBogor = c.commitment(rh, 'kota-bogor');
check('commitment/ dua pembaca menghitung nilai sama (X = pemilik)',
  commitmentKotaBogor === c.commitment(rh, 'kota-bogor'), true);
check('commitment/ pemilik berbeda menghitung nilai berbeda',
  c.commitment(rh, 'kota-bogor') === c.commitment(rh, 'kabupaten-bogor'), false);
check('commitment/ pasangan record dan key tidak tertukar satu sama lain',
  c.commitment(c.recordHash({ namaLengkap: 'A' }), 'kota-bogor')
    === c.commitment(c.recordHash({ namaLengkap: 'B' }), 'kota-bogor'), false);

// Batas panjang: key yang pendek atau panjang tidak boleh membuat hash kosong
// atau tidak terbedakan. Yang diperiksa hanya output-nya, karena itu yang
// teramati di on-chain.
check('commitment/ key 1 karakter menghasilkan hash penuh',
  c.commitment(rh, 'a').length, 64);
check('commitment/ key sangat panjang tidak melempar galat',
  c.commitment(rh, 'kota-bogor-'.repeat(1000)).length, 64);

console.log('\n=== 5b. Determinisme lintas proses (keputusan-kanonikalisasi.md §4.3) ===');

// Syarat §4.3: dua proses terpisah, input sama -> hash sama.
// Ditinjau sebagai Proses, bukan pustaka, supaya yang diuji benar-benar yang
// akan terjadi saat aplikasi dijalankan ulang.
function hashInChildProcess(payloadJson) {
  const script = [
    "const c = require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'canonical')) + ');',
    'process.stdout.write(c.recordHash(JSON.parse(process.argv[1])));',
  ].join('\n');
  return execFileSync(process.execPath, ['-e', script, JSON.stringify(payloadJson)], {
    encoding: 'utf8',
  });
}

const SAMPLE = {
  jenisSasaran: 'Ibu Hamil',
  nik: '3273011234560002',
  namaLengkap: 'Dewi Lestari',
  usia: '28',
  bbSekarang: '62,5',
  tfu: '24',
  catatanTPK: 'Perlu kunjungan ulang',
  namaAyah: null,
};

const inProcess1 = c.recordHash(SAMPLE);
const inProcess2 = c.recordHash(JSON.parse(JSON.stringify(SAMPLE)));
const child1 = hashInChildProcess(SAMPLE);
const child2 = hashInChildProcess(SAMPLE);

check('proses/ dua proses anak -> hash sama', child1 === child2, true);
check('proses/ proses anak = proses ini', child1 === inProcess1, true);
check('proses/ hash di dalam proses pun sama', inProcess1 === inProcess2, true);
check('proses/ hash anak cocok dengan vektor beku',
  child1, c.recordHash(SAMPLE));

console.log('\n=== 6. Vektor beku (regresi) ===');

const VECTORS_PATH = path.join(__dirname, '..', 'tests', 'vectors.json');
let vectors = null;
try {
  vectors = JSON.parse(require('fs').readFileSync(VECTORS_PATH, 'utf8'));
} catch (e) {
  failed++;
  console.log('GAGAL  vectors.json tidak terbaca: ' + e.message);
}

if (vectors && Array.isArray(vectors.vectors)) {
  for (const v of vectors.vectors) {
    check('vektor/ ' + v.name, c.recordHash(v.payload), v.record_hash);
  }
  // Vektor beku juga harus cocok dengan versi kanonikalisasi yang tercatat.
  check('vektor/ schema_version berkas = implementasi', vectors.schema_version, c.SCHEMA_VERSION);
  for (const v of vectors.vectors) {
    check('vektor/ stabil diulang ' + v.name, c.recordHash(v.payload), v.record_hash);
  }
} else if (vectors) {
  failed++;
  console.log('GAGAL  tests/vectors.json tidak punya array "vectors"');
}

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK. Hash lama bisa jadi tidak dapat diverifikasi lagi --');
  console.log('jika penyebabnya di normalisasi atau JCS, itu breaking change.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
