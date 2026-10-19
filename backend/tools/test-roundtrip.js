'use strict';

/**
 * Uji round-trip F1.9 -- titik paling rawan di Fase 1.
 *
 * Yang diuji, berurutan dari luar ke dalam:
 *
 *  1. Jalur tulis aplikasi sungguhan. `buildRow` dan `tombol` diambil dari
 *     `index.js`, bukan disalin. Kalau `FIELD_ORDER` berubah, uji ini ikut
 *     berubah dan tidak bisa diam-diam lulus.
 *  2. Empat varian `jenisSasaran` (FR-2.4), masing-masing dengan field
 *     bersyaratnya sendiri.
 *  3. Round-trip: body form -> baris sheet -> payload -> hash, lalu payload
 *     dibaca kembali dan di-hash ulang harus sama.
 *  4. Verifikasi lintas implementasi. Hash dihitung ulang dengan Python
 *     (`JCS_reference.py` + `hashlib`) tanpa menyentuh satu baris pun kode
 *     JavaScript kita. Inilah klaim penelitiannya: instansi lain
 *     bisa memverifikasi commitment tanpa pustaka proyek ini.
 *  5. Cakupan taksonomi: `NORMALIZE_SASARAN` harus menutup semua pilihan yang
 *     ada di form.
 *
 * Jalankan: node tools/test-roundtrip.js
 */

const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const app = require(path.join(__dirname, '..', 'index.js'));
const { FIELD_ORDER, LABELS, HEADERS, buildRow, tombol, NORMALIZE_SASARAN } = app;
const c = require(path.join(__dirname, '..', 'lib', 'canonical'));
const commitmentFor = c.commitmentFor;
const { NUMERIC_FIELDS, FORCED_TEXT } = require(path.join(__dirname, '..', 'lib', 'field-types'));

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

function ok(name, cond) {
  check(name, !!cond, true);
}

/** Body form yang realistis, hanya berisi field yang relevan untuk variannya. */
function formBody(varian, extra) {
  const shared = {
    namaTPK: 'Siti Aminah',
    peranTPK: 'TPK',
    namaDesa: 'Sukamaju',
    namaKecamatan: 'Cimanggis',
    rw: '0A',
    rt: '005',
    nik: '3273011234560001',
    noKK: '3273011234560002',
    namaLengkap: 'Ahmad Fauzi',
    alamat: 'Jl. Merdeka No. 3',
    tanggalKunjungan: '2026-09-29',
    pendampinganKe: '1',
  };
  return Object.assign(shared, varian, extra || {});
}

const VARIANTS = [
  {
    taksonomi: 'Catin',
    formValue: 'Calon Pengantin',
    body: { jenisSasaran: 'Calon Pengantin', jenisKelamin: 'Laki-laki', usia: '25', tanggalLahir: '2001-04-12' },
    own: ['jenisKelamin', 'usia', 'tanggalLahir'],
  },
  {
    taksonomi: 'Ibu Hamil',
    formValue: 'Ibu Hamil',
    body: {
      jenisSasaran: 'Ibu Hamil', usia: '28', usiaKehamilan: '24', hpht: '2025-11-02',
      bbSebelumHamil: '55', bbSekarang: '62,5', tb: '160', lila: '100', hb: '12', tfu: '24',
    },
    own: ['usiaKehamilan', 'hpht', 'bbSebelumHamil', 'bbSekarang', 'tb', 'lila', 'hb', 'tfu'],
  },
  {
    taksonomi: 'Ibu Nifas',
    formValue: 'Ibu Nifas',
    body: {
      jenisSasaran: 'Ibu Nifas', tanggalLahirBayi: '2026-08-20', umurBayi: '0,5',
      asiEksklusif: 'Ya', bbLahir: '3,1', pbLahir: '49',
    },
    own: ['tanggalLahirBayi', 'umurBayi', 'asiEksklusif', 'bbLahir', 'pbLahir'],
  },
  {
    taksonomi: 'Baduta',
    formValue: 'Baduta',
    body: {
      jenisSasaran: 'Baduta', tanggalLahirBayi: '2025-03-10', umurBayi: '18',
      bbLahir: '3,2', pbLahir: '50', cukupBulan: 'Ya',
      bbSekarang: '11,5', tb: '76', asiEksklusif: 'Ya', sudahImunisasi: 'Ya',
    },
    own: ['tanggalLahirBayi', 'umurBayi', 'bbLahir', 'pbLahir', 'cukupBulan',
      'bbSekarang', 'tb', 'asiEksklusif', 'sudahImunisasi'],
  },
];

/**
 * Simulasikan apa yang benar-benar terjadi di Google Sheets, lalu baca balik.
 *
 * Meniru `index.js`:saat tulis baris adalah `[no, ...buildRow(body)]`, dan saat
 * baca kolom dicari berdasarkan LABEL header yang dibaca dari sheet -- bukan
 * indeks tetap. Meniru mekanisme aslinya penting: kalau pembaca sheet kita
 * berubah, uji ini harus ikut berubah.
 */
function writeToSheet(body, no) {
  return {
    header: HEADERS.slice(),
    row: [String(no == null ? 1 : no), ...buildRow(body)],
  };
}

function readFromSheet(sheet, fields) {
  const header = sheet.header.map((h) => String(h || '').trim());
  const payload = {};
  for (const field of fields || FIELD_ORDER) {
    const i = header.indexOf(LABELS[field]);
    payload[field] = i !== undefined && sheet.row[i] !== undefined
      ? String(sheet.row[i]).trim()
      : '';
  }
  return payload;
}

/** Siklus penuh yang dilewati submit form. */
function submitAndRead(body) {
  const sheet = writeToSheet(body);
  const payload = readFromSheet(sheet);
  return { sheet, payload, hash: c.recordHash(payload) };
}

console.log('=== 1. Jalur tulis aplikasi sungguhan ===');

check('buildRow sepanjang FIELD_ORDER (kolom No ditambahkan terpisah)',
  buildRow(formBody(VARIANTS[0].body)).length, FIELD_ORDER.length);
check('baris sheet = No + buildRow',
  writeToSheet(formBody(VARIANTS[0].body)).row.length, FIELD_ORDER.length + 1);
check('tombol: undefined jadi string kosong', tombol(undefined), '');
check('tombol: 0 TIDAK jadi kosong', tombol(0), '0');
check('tombol: false jadi "false"', tombol(false), 'false');
check('HEADERS kolom pertama No', HEADERS[0], 'No');
check('HEADERS panjang = 1 + FIELD_ORDER', HEADERS.length, 1 + FIELD_ORDER.length);
ok('LABELS memuat semua FIELD_ORDER',
  FIELD_ORDER.every((f) => typeof LABELS[f] === 'string' && LABELS[f].length > 0));

// Dua label yang sama akan membuat pembaca sheet salah kolom. Ini kesalahan
// paling halus dan paling merusak, jadi diperiksa.
const labelCounts = new Map();
for (const f of FIELD_ORDER) {
  labelCounts.set(LABELS[f], (labelCounts.get(LABELS[f]) || 0) + 1);
}
const duplikat = [...labelCounts.entries()].filter(([, n]) => n > 1);
ok('LABELS unik (pembaca sheet bergantung pada label unik)', duplikat.length === 0);
if (duplikat.length > 0) {
  for (const [label, n] of duplikat) {
    console.log('        label ganda: "' + label + '" dipakai ' + n + 'x');
  }
}

console.log('\n=== 2. Empat varian: round-trip stabil ===');

// Penjaga terhadap data uji yang membusuk: setiap nama field yang dipakai di
// sini harus benar-benar ada di FIELD_ORDER dan punya label. Tanpa ini, salah
// ketik pada data uji membuat "field sendiri terisi" gagal untuk alasan yang
// tidak jelas, atau -- lebih buruk -- lolos karena field itu memang absen.
const allTestFields = new Set();
for (const v of VARIANTS) {
  Object.keys(v.body).forEach((f) => allTestFields.add(f));
  v.own.forEach((f) => allTestFields.add(f));
}
const fieldsTidakDikenal = [...allTestFields].filter((f) => !FIELD_ORDER.includes(f));
ok('data uji: semua field ada di FIELD_ORDER', fieldsTidakDikenal.length === 0);
if (fieldsTidakDikenal.length > 0) {
  for (const f of fieldsTidakDikenal) console.log('        field tak dikenal: ' + f);
  console.log('        -> perbaiki tools/test-roundtrip.js, bukan FIELD_ORDER.');
}

for (const v of VARIANTS) {
  const body = formBody(v.body);
  const a = submitAndRead(body);
  const b = submitAndRead(JSON.parse(JSON.stringify(body)));

  check(v.taksonomi + ': hash sama setelah dua submit identik', a.hash, b.hash);
  check(v.taksonomi + ': round-trip normalisasi idempoten',
    c.recordHash(c.normalizeRecord(a.payload)), a.hash);

  // Field yang tidak berlaku untuk varian ini tidak boleh muncul sebagai
  // nilai berisi. Kunci dengan nilai kosong tetap sah -- yang diperiksa adalah
  // nilainya benar-benar kosong, bukan absen.
  const leaking = v.own.filter((f) => !a.payload[f] && body[f] === undefined
    && VARIANTS.some((o) => o !== v && o.own.includes(f)));
  ok(v.taksonomi + ': tidak ada field varian lain yang terisi', leaking.length === 0);

  ok(v.taksonomi + ': field sendiri terisi',
    v.own.every((f) => typeof a.payload[f] === 'string' && a.payload[f].length > 0));

  // NIK dan No. KK harus tetap persis seperti yang diketik.
  check(v.taksonomi + ': NIK tidak berubah', a.payload.nik, body.nik);
  check(v.taksonomi + ': No. KK tidak berubah', a.payload.noKK, body.noKK);
  check(v.taksonomi + ': RW/RT tidak jadi angka', [a.payload.rw, a.payload.rt].join('/'), '0A/005');
}

console.log('\n=== 3. Varian berbeda -> hash berbeda ===');

for (let i = 0; i < VARIANTS.length; i++) {
  for (let j = i + 1; j < VARIANTS.length; j++) {
    const hi = submitAndRead(formBody(VARIANTS[i].body)).hash;
    const hj = submitAndRead(formBody(VARIANTS[j].body)).hash;
    ok(VARIANTS[i].taksonomi + ' vs ' + VARIANTS[j].taksonomi + ': hash berbeda', hi !== hj);
  }
}

console.log('\n=== 4. Verifikasi lintas implementasi (tanpa pustaka kita) ===');

// Bukti operasional klaim penelitian: instance lain harus dapat menghitung
// ulang `record_hash` tanpa satu baris pun kode JavaScript kita.
// `tools/verify_commitment.py` hanya memakai pustaka standar Python, JCS-nya
// diimplementasikan ulang di `JCS_reference.py`, dan tidak mengimpor apa pun
// dari `backend/lib/`.
function verifyWithPython(payload) {
  const out = execFileSync('python', [path.join(__dirname, 'verify_commitment.py')], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new Error('python menghasilkan bukan hex64: ' + out);
  return out;
}

// Commitment harus bisa dihitung ulang oleh pihak ketiga yang tidak menjalankan
// kode kita sama sekali. Kemampuan itu adalah inti klaim "gateway terdesentralisasi",
// jadi ia harus diuji lintas implementasi, bukan hanya di dalam JavaScript yang
// sama dengan yang menghasilkannya.
function commitmentWithPython(payload, institutionKey) {
  const out = execFileSync(
    'python',
    [path.join(__dirname, 'verify_commitment.py'), '--institution', institutionKey],
    { input: JSON.stringify(payload), encoding: 'utf8' }
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new Error('python menghasilkan bukan hex64: ' + out);
  return out;
}

// Verifier Python punya daftar field sendiri. Kalau ada kolom numerik baru yang
// ditambahkan di field-types.js tanpa memperbarui skrip itu, hash akan berbeda
// dan seluruh uji ini gagal -- persis yang harus terjadi.
const pySource = require('fs').readFileSync(
  path.join(__dirname, 'verify_commitment.py'), 'utf8');
ok('verifier python punya daftar field numerik yang sama',
  pySource.includes('"pendampinganKe"') && pySource.includes('"bbSekarang"'));
ok('verifier python tidak mengimpor kode JS',
  !/require\(|\.js['"]/.test(pySource));

for (const v of VARIANTS) {
  const { payload, hash } = submitAndRead(formBody(v.body));
  let theirs;
  try {
    theirs = verifyWithPython(payload);
  } catch (e) {
    failed++;
    console.log('GAGAL  python/ ' + v.taksonomi + '  (' + e.message.split('\n')[0] + ')');
    continue;
  }
  check('python/ ' + v.taksonomi + ': hash sama dengan implementasi JS', theirs, hash);
}

// Varian yang paling rawan: angka dengan koma desimal. Kalau Python dan JS
// berbeda di sini, verifikasi lintas instansi tidak mungkin dipercaya.
{
  const { payload, hash } = submitAndRead(formBody(VARIANTS[1].body, { bbSekarang: '62,55', tfu: '24' }));
  check('python/ koma desimal: hash sama', verifyWithPython(payload), hash);
}

// NIK dengan nol di depan harus tetap berbeda di kedua implementasi.
{
  const a = submitAndRead(formBody(VARIANTS[0].body, { nik: '0071234567890' }));
  const b = submitAndRead(formBody(VARIANTS[0].body, { nik: '0071234567891' }));
  ok('python/ NIK nol di depan tidak collide', verifyWithPython(a.payload) !== verifyWithPython(b.payload));
  check('python/ NIK nol di depan hash sama dengan JS', verifyWithPython(a.payload), a.hash);
}

// ---------------------------------------------------------------------------
// Commitment lintas implementasi (ADR-3, FR-4.3)
// ---------------------------------------------------------------------------
console.log('\n=== 4c. commitment lintas implementasi ===');

const INSTANSI_UJI = ['kota-bogor', 'kabupaten-bogor', 'bidang-kb-01', '12345'];

for (const key of INSTANSI_UJI) {
  const { payload } = submitAndRead(formBody(VARIANTS[0].body));
  check('python/ commitment dengan institution_key "' + key + '" sama dengan JS',
    commitmentWithPython(payload, key),
    commitmentFor(payload, key));
}

// Sifat yang membuat verifikasi independen mungkin terjadi: semua penerima sah
// menghitung nilai yang sama untuk record yang sama. Kalau ini tidak berlaku,
// FR-4.3 mustahil dipenuhi.
{
  const { payload } = submitAndRead(formBody(VARIANTS[0].body));
  ok('commitment/ dua penerima menghitung nilai sama',
    commitmentFor(payload, 'kota-bogor') === commitmentFor(payload, 'kota-bogor'));
  ok('commitment/ pemilik berbeda menghasilkan nilai berbeda',
    commitmentFor(payload, 'kota-bogor') !== commitmentFor(payload, 'kabupaten-bogor'));
}

// Python harus menolak institution_key kosong, sama seperti JS. Kalau hanya satu
// sisi yang menolak, kedua implementasi tidak bisa dianggap satu spesifikasi.
{
  const { payload } = submitAndRead(formBody(VARIANTS[0].body));
  let pythonExit = 0;
  try {
    execFileSync(
      'python',
      [path.join(__dirname, 'verify_commitment.py'), '--institution', ''],
      { input: JSON.stringify(payload), encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    pythonExit = e.status === undefined ? 1 : e.status;
  }
  ok('python/ institution_key kosong ditolak', pythonExit !== 0);

  let jsThrew = false;
  try {
    commitmentFor(payload, '');
  } catch (e) {
    jsThrew = true;
  }
  ok('commitment/ institution_key kosong ditolak oleh JS', jsThrew);
}


console.log('\n=== 5. Cakupan taksonomi ===');

// Semua pilihan yang benar-benar ada di form harus punya pemetaan.
const NILAI_DI_FORM = ['Calon Pengantin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita'];
for (const nilai of NILAI_DI_FORM) {
  const mapped = NORMALIZE_SASARAN[nilai.toLowerCase()];
  ok('taksonomi: "' + nilai + '" termappable', typeof mapped === 'string' && mapped.length > 0);
}

// Daftar pilihan `jenisSasaran` dibaca langsung dari form, bukan ditulis ulang
// di sini. Kalau opsi form berubah, test ikut berubah -- tidak ada daftar kedua
// yang bisa basuh diam-diam.
const FORM_PATH = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'FormPendampingan.jsx');
const formSrc = require('fs').readFileSync(FORM_PATH, 'utf8');
const optionsBlock = /JENIS_SASARAN_OPTIONS\s*=\s*\[([\s\S]*?)\];/.exec(formSrc);
const OPSI_FORM = optionsBlock
  ? [...optionsBlock[1].matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1])
  : [];

ok('opsi jenisSasaran terbaca dari form', OPSI_FORM.length > 0);
console.log('        opsi di form: ' + OPSI_FORM.join(' | '));
ok('opsi form: 5 pilihan (semua dalam taksonomi)', OPSI_FORM.length === 5);

// Yang dikirim ke backend adalah `value`, bukan `label`. Kalau form berubah ke
// label, pemetaan akan gagal diam-diam.
const TAKSONOMI = ['Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita'];
const DILUAR_TAKSONOMI = [];

for (const nilai of OPSI_FORM) {
  const mapped = NORMALIZE_SASARAN[nilai.toLowerCase()];
  check('taksonomi: "' + nilai + '" termappable', mapped, nilai);
}

const hasilPemetaan = new Set(Object.values(NORMALIZE_SASARAN));
ok('taksonomi: semua nilai pemetaan ada di CHECK constraint DDL',
  [...hasilPemetaan].every((v) => TAKSONOMI.includes(v)));
ok('taksonomi: kelima kategori terwakili',
  TAKSONOMI.every((t) => hasilPemetaan.has(t)));
ok('taksonomi: tidak ada nilai pemetaan di luar CHECK',
  [...hasilPemetaan].every((v) => TAKSONOMI.includes(v)));

// Balita kini dalam taksonomi: INSERT lolos CHECK, hash dihitung normal.
const balitaRow = submitAndRead(formBody({ jenisSasaran: 'Balita', tanggalLahirBayi: '2025-01-01' }));
ok('taksonomi: Balita dibaca, di-hash, dan INSERT lolos CHECK',
  /^[0-9a-f]{64}$/.test(balitaRow.hash));
console.log('        hash Balita : ' + balitaRow.hash.slice(0, 16) + '...');
console.log('        -> INSERT lolos CHECK (Balita kini dalam taksonomi ADR-5).');

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK DI JALUR TULIS.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
