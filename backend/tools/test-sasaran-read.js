/**
 * F1.12 - menghapus indeks kolom hardcode di /api/sasaran.
 *
 * Versi lama menulis `row[8]` untuk NIK, `row[10]` untuk nama, dan seterusnya.
 * Angka-angka itu benar HARI INI, tapi tidak ada yang menjaganya: menyisipkan
 * satu kolom di form, atau mengurutkan kolom di sheet secara manual, akan
 * membuat seluruh respons berisi NIK dan nama tertukar tanpa error apa pun.
 *
 * Uji ini mengunci dua hal:
 *   1. Perilaku tidak berubah. Implementasi baru harus menghasilkan objek yang
 *      identik dengan implementasi lama untuk data apa pun. Ini yang membuat
 *      refactor ini aman, dan butuh implementasi lama yang ikut disimpan.
 *   2. Ketahanan. Setelah kolom digeser atau diurutkan ulang, pembacaan by-label
 *      harus tetap benar -- sementara indeks lama akan salah diam-diam.
 */

const path = require('path');
const {
  FIELD_ORDER, LABELS, HEADERS, buildRow, tombol,
  FIELDS_SASARAN, headerToIndex, looksLikeHeaderRow, pickField,
} = require('../index.js');

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); if (extra !== undefined) console.log('        ' + extra); }
}

function eq(name, a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); console.log('        diharapkan: ' + sb); console.log('        diterima  : ' + sa); }
}

// ---------------------------------------------------------------------------
// Implementasi lama, disalin apa adanya dari index.js sebelum F1.12.
// Ada sebagai pembanding. Jangan diperbarui mengikuti kode baru -- justru
// itulah nilainya: kalau nanti ada yang mengubah FIELDS_SASARAN, uji ini yang berteriak.
// ---------------------------------------------------------------------------

const LAMA_INDEKS = {
  nik: 8, namaLengkap: 10, noKK: 9, tanggalLahir: 12, usia: 13, noHp: 11,
  alamat: 14, jenisSasaran: 15, namaDesa: 4, namaKecamatan: 5, rw: 6, rt: 7,
  namaTPK: 1, peranTPK: 2, noHpTPK: 3, sumberAir: 16, jamban: 17,
  terpaparRokok: 18, gunakanKB: 23, jenisKB: 24, rencanaKB: 25,
  rencanaKehamilan: 26, bpjsAktif: 27, jenisBPJS: 28, dtks: 29,
  bansosDiterima: 30,
};

function versiLama(rows) {
  const map = {};
  for (const row of rows) {
    const nik = row[8] || '';
    if (!nik || nik.length !== 16) continue;
    if (!map[nik]) {
      const e = {};
      for (const [field, idx] of Object.entries(LAMA_INDEKS)) {
        e[field] = row[idx] || '';
      }
      map[nik] = e;
    }
  }
  return Object.values(map);
}

function versiBaru(rows, headerRow) {
  const pakaiHeader = looksLikeHeaderRow(headerRow);
  const colIndex = headerToIndex(pakaiHeader ? headerRow : HEADERS);
  const data = pakaiHeader ? rows : [headerRow || null, ...rows].filter(Boolean);

  const map = {};
  for (const row of data) {
    const nik = pickField(row, colIndex, 'nik') || '';
    if (!nik || nik.length !== 16) continue;
    if (!map[nik]) {
      const e = {};
      for (const f of FIELDS_SASARAN) e[f] = pickField(row, colIndex, f) || '';
      map[nik] = e;
    }
  }
  return Object.values(map);
}

// Baris sheet harus dibentuk persis seperti produksi: kolom "No" di depan,
// lalu buildRow. buildRow sendirian hanya 72 elemen sedangkan HEADERS 73,
// jadi memberi buildRow langsung ke pickField akan menggeser semua kolom satu
// posisi -- kesalahan yang dibuat uji, bukan oleh kode.
const sheetRow = (body, no) => [String(no === undefined ? 1 : no), ...buildRow(body)];

// Penjaga: bentuk baris harus sesuai HEADERS, kalau tidak seluruh sisa uji
// hanya membandingkan dua implementasi yang sama-sama salah.
{
  const probe = sheetRow({});
  eq('bentuk baris: panjang = panjang HEADERS', probe.length, HEADERS.length);
  ok('bentuk baris: kolom pertama adalah No', probe[0] === '1');
  const kosongkan = {};
  kosongkan.nik = '3273011234560001';
  const isi = sheetRow(kosongkan);
  const p = headerToIndex(HEADERS);
  eq('bentuk baris: NIK berada di kolom yang benar menurut header',
    pickField(isi, p, 'nik'), kosongkan.nik);
}

// ---------------------------------------------------------------------------

console.log('=== 1. Peta kolom dari header ===');

{
  const idx = headerToIndex(HEADERS);
  ok('headerToIndex: NIK -> 8 (posisi lama)', idx.get('NIK') === 8);
  eq('headerToIndex: jumlah peta = jumlah header', idx.size, HEADERS.length);
  ok('headerToIndex: label kosong diabaikan', !headerToIndex(['No', '', 'NIK']).has(''));
  ok('headerToIndex: label duplikat ambil yang pertama',
    headerToIndex(['NIK', 'NIK']).get('NIK') === 0);
  ok('headerToIndex: header kosong memberi peta kosong', headerToIndex([]).size === 0);
  ok('headerToIndex: undefined aman', headerToIndex(undefined).size === 0);
}

{
  ok('looksLikeHeaderRow: HEADERS dikenali', looksLikeHeaderRow(HEADERS));
  ok('looksLikeHeaderRow: baris data biasa ditolak',
    !looksLikeHeaderRow(['1', 'Ahmad', '3273011234560001']));
  ok('looksLikeHeaderRow: undefined ditolak', !looksLikeHeaderRow(undefined));
  ok('looksLikeHeaderRow: array kosong ditolak', !looksLikeHeaderRow([]));
}

console.log('\n=== 2. FIELDS_SASARAN masih cocok dengan indeks lama ===');

{
  const salah = FIELDS_SASARAN.filter((f) => HEADERS[LAMA_INDEKS[f]] !== LABELS[f]);
  ok('semua field punya label yang cocok di indeks lamanya', salah.length === 0,
    salah.length ? 'tidak cocok: ' + salah.join(', ') : undefined);
  eq('jumlah field sama dengan implementasi lama', FIELDS_SASARAN.length, Object.keys(LAMA_INDEKS).length);
  ok('nik adalah field pertama (kunci map)', FIELDS_SASARAN[0] === 'nik');
  ok('semua field ada di FIELD_ORDER',
    FIELDS_SASARAN.every((f) => FIELD_ORDER.includes(f)));
  eq('urutan field tidak berubah', FIELDS_SASARAN, Object.keys(LAMA_INDEKS));
}

console.log('\n=== 3. Perilaku identik dengan implementasi lama ===');

// Baris dibangun oleh buildRow, jadi uji memakai data yang benar-benar bisa
// terjadi di produksi, bukan array angka karangan.
const SAMPLES = [
  {
    nama: 'lengkap',
    body: {
      namaTPK: 'Siti Aminah', peranTPK: 'PKK', noHpTPK: '08123456789',
      namaDesa: 'Sukamaju', namaKecamatan: 'Cibadak', rw: '003', rt: '007',
      nik: '3273011234560001', noKK: '3273010201110001',
      namaLengkap: 'Ahmad Fauzi', noHp: '081298765432', tanggalLahir: '1990-05-12',
      usia: '34', alamat: 'Jl. Merdeka No. 12', jenisSasaran: 'Catin',
      sumberAir: 'PDAM', jamban: 'Jamban sendiri', terpaparRokok: 'Tidak',
      gunakanKB: 'Belum KB', rencanaKB: 'KB suntik', rencanaKehamilan: 'Ya',
      bpjsAktif: 'Ya', jenisBPJS: 'BPJS Kesehatan', dtks: 'Ya', bansosDiterima: 'Ya',
    },
  },
  { nama: 'hanya NIK', body: { nik: '3273019876543210' } },
  { nama: 'NIK terisi, sisanya kosong',
    body: { nik: '3273011111222233', namaLengkap: 'Siti Aminah', jenisSasaran: 'Baduta' } },
  { nama: 'bukan Catin, kolom 23+ kosong',
    body: { nik: '3273014444555566', namaLengkap: 'Dewi Lestari', jenisSasaran: 'Ibu Hamil' } },
  { nama: 'tidak ada NIK, harus dilewati',
    body: { namaLengkap: 'Tanpa NIK', jenisSasaran: 'Ibu Nifas' } },
  { nama: 'NIK terlalu pendek, harus dilewati',
    body: { nik: '12345', namaLengkap: 'Pendek' } },
];

for (const s of SAMPLES) {
  const row = sheetRow(s.body);
  const lama = versiLama([row]);
  const baru = versiBaru([row], HEADERS);
  eq('sampel "' + s.nama + '": hasil identik dengan versi lama', baru, lama);
}

// Sheet kosong dan sheet tanpa header harus sama-sama menghasilkan array kosong.
eq('sheet kosong: kedua versi kosong', versiBaru([], HEADERS), versiLama([]));
eq('sheet tanpa header: kedua versi kosong', versiBaru([], ['a', 'b']), versiLama([]));

console.log('\n=== 4. Ketahanan: kolom digeser dan diurutkan ulang ===');

// Skenario nyata: admin menambah kolom "Catatan" di tengah sheet. Posisi semua
// kolom setelahnya bergeser. Indeks lama jadi salah baca; by-label tidak.
{
  const row = sheetRow(SAMPLES[0].body);
  const headerBaru = [...HEADERS];
  headerBaru.splice(10, 0, 'Kolom Admin'); // sisipkan di tengah
  const rowBaru = [...row];
  rowBaru.splice(10, 0, 'catatan admin');

  const lama = versiLama([rowBaru]);
  const baru = versiBaru([rowBaru], headerBaru);

  ok('indeks lama: salah baca setelah kolom disisipkan',
    lama.length === 0 || lama[0].namaLengkap !== SAMPLES[0].body.namaLengkap);
  ok('by-label: NIK tetap benar setelah kolom disisipkan',
    baru.length === 1 && baru[0].nik === SAMPLES[0].body.nik);
  ok('by-label: namaLengkap tetap benar setelah kolom disisipkan',
    baru.length === 1 && baru[0].namaLengkap === SAMPLES[0].body.namaLengkap);
  ok('by-label: bansosDiterima tetap benar (kolom paling akhir)',
    baru.length === 1 && baru[0].bansosDiterima === SAMPLES[0].body.bansosDiterima);
}

// Skenario nyata kedua: sheet diurutkan ulang, urutan kolom dibalik.
{
  const row = sheetRow(SAMPLES[0].body);
  const headerBalik = [...HEADERS].reverse();
  const rowBalik = [...row].reverse();

  const baru = versiBaru([rowBalik], headerBalik);
  ok('by-label: urutan kolom dibalik, NIK tetap benar',
    baru.length === 1 && baru[0].nik === SAMPLES[0].body.nik);
  ok('by-label: urutan kolom dibalik, namaLengkap tetap benar',
    baru.length === 1 && baru[0].namaLengkap === SAMPLES[0].body.namaLengkap);

  const lama = versiLama([rowBalik]);
  ok('indeks lama: gagal total saat urutan dibalik', lama.length === 0);
}

// Baris pertama yang bukan header tidak boleh dipakai sebagai peta kolom.
{
  const row = sheetRow(SAMPLES[0].body);
  const salahHeader = ['1', 'Ahmad Fauzi', '3273011234560001'];
  const baru = versiBaru([row], salahHeader);
  ok('header palsu diabaikan, fallback ke urutan bawaan', baru.length === 1);
  ok('fallback urutan bawaan: NIK benar', baru[0].nik === SAMPLES[0].body.nik);
}

console.log('\n=== 5. Kolom hilang dilaporkan, bukan diisi diam-diam ===');

{
  const headerTanpaKolom = HEADERS.filter((h) => h !== LABELS.bansosDiterima);
  const row = sheetRow({ ...SAMPLES[0].body, bansosDiterima: 'Ya' });
  const colIndex = headerToIndex(headerTanpaKolom);
  ok('pickField: kolom hilang menghasilkan undefined',
    pickField(row, colIndex, 'bansosDiterima') === undefined);
  ok('pickField: kolom ada tetap terbaca',
    pickField(row, colIndex, 'nik') === SAMPLES[0].body.nik);
  ok('kolom hilang terdeteksi dari daftar',
    FIELDS_SASARAN.some((f) => !colIndex.has(LABELS[f])));
}

// Nilai undefined di tengah baris tidak boleh menggeser pembacaan kolom lain.
{
  const row = sheetRow(SAMPLES[0].body);
  const colIndex = headerToIndex(HEADERS);
  row[8] = undefined;
  ok('nilai undefined jadi string kosong', pickField(row, colIndex, 'nik') === '');
  ok('kolom setelahnya tidak bergeser',
    pickField(row, colIndex, 'namaLengkap') === SAMPLES[0].body.namaLengkap);
}

console.log('\n=== 6. Tidak ada indeks kolom hardcode yang tersisa ===');

{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // Area endpoint /api/sasaran saja; definisi lain di file ini memang memakai
  // indeks (HEADERS.slice, dst) dan itu wajar.
  const mulai = src.indexOf("app.get('/api/sasaran'");
  const selesai = src.indexOf("app.post('/api/submit'");
  const blok = src.slice(mulai, selesai);

  const hardcoded = blok.match(/row\[\d+\]/g) || [];
  ok('blok /api/sasaran tidak memakai row[angka]', hardcoded.length === 0,
    hardcoded.length ? 'masih ada: ' + [...new Set(hardcoded)].join(', ') : undefined);
  ok('blok /api/sasaran menyebut FIELDS_SASARAN', blok.includes('FIELDS_SASARAN'));
  ok('blok /api/sasaran memakai pickField', blok.includes('pickField'));
  ok('blok /api/sasaran hanya satu panggilan values.get',
    (blok.match(/spreadsheets\.values\.get/g) || []).length === 1);
}

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nJALUR BACA SASARAN BERUBAH.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
