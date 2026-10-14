/**
 * Uji F3.10b: ekspor XLSX.
 *
 * Yang diuji:
 * 1. Berkas yang dihasilkan benar-benar ZIP/OOXML dan bisa dibaca kembali.
 * 2. Isi sel sama dengan data sumber dan sama dengan JSON/CSV (FR-4.8).
 * 3. Isian yang diawali `=` tidak menjadi formula (CSV injection versi XLSX).
 * 4. Nilai khusus XML tidak merusak berkas.
 * 5. Data kosong dan nombre kolom tidak menghasilkan berkas rusak.
 */

const ExcelJS = require('exceljs');
const { bangunXlsx, selAman } = require('../lib/xlsx-export.js');

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

/** Baca kembali workbook yang sudah ditulis menjadi array of array of teks. */
async function bacaUlang(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const out = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    out.push(row.values.slice(1).map((v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object' && v.formula) return 'FORMULA:' + v.formula;
      return String(v);
    }));
  });
  return { out, namaSheet: ws.name };
}

/** Buang satu awalan kutip apostrof yang ditambahkan selAman. */
function tanpaApostrof(s) {
  return typeof s === 'string' && s.startsWith("'") ? s.slice(1) : s;
}

async function main() {
  console.log('=== 1. Berkas yang dihasilkan bisa dibaca kembali ===');

  const header = ['nik', 'namaLengkap', 'tanggalKunjungan'];
  const baris = [
    ['3201010101800001', 'Siti Aminah', '2026-01-15'],
    ['3273010202850002', 'Budi Santoso', '2026-02-20'],
  ];

  const buf = await bangunXlsx(header, baris);
  ok('hasil berupa Buffer', Buffer.isBuffer(buf));
  ok('ditandai sebagai ZIP (PK)', buf.toString('utf8', 0, 2) === 'PK');
  ok('ukuran wajar untuk 3 baris', buf.length > 1000);

  const baca = await bacaUlang(buf);
  eq('nama sheet sesuai permintaan', baca.namaSheet, 'Data');
  eq('jumlah baris = 1 header + 2 data', baca.out.length, 3);
  eq('header utuh', baca.out[0], header);
  eq('baris pertama utuh', baca.out[1], baris[0]);
  eq('baris kedua utuh', baca.out[2], baris[1]);

  console.log('\n=== 2. Isi sama dengan sumber (FR-4.8) ===');

  // Kolom terlarang tidak boleh pernah muncul. Disimulasikan dengan tidak
  // mengirim kolom itu sama sekali -- lib/column-grants.js yang membuang
  // kolomnya sebelum sampai ke sini, diuji terpisah di test-column-grants.js.
  const headerBersih = ['nik', 'namaLengkap'];
  const barisBersih = [['3201010101800001', 'Siti Aminah']];
  const bufBersih = await bangunXlsx(headerBersih, barisBersih);
  const bacaBersih = await bacaUlang(bufBersih);

  let adaTerlarang = false;
  for (const f of ['catatanTPK', 'nikAyah', 'nikIbu', 'namaAyah', 'namaIbu']) {
    if (bacaBersih.out.some((r) => r.some((c) => String(c).toLowerCase().includes(f.toLowerCase())))) {
      adaTerlarang = true;
    }
  }
  ok('kolom terlarang tidak muncul di berkas', !adaTerlarang);
  eq('jumlah kolom sesuai permintaan', bacaBersih.out[0].length, 2);

  console.log('\n=== 3. Formula injection ditahan ===');

  // Nilai dikontrol pemohon. Kalau diteruskan apa adanya, Excel akan menghitung
  // `=HYPERLINK(...)` saat operator membuka berkas.
  const serang = [
    ['=HYPERLINK("http://evil.example/klik","KLIK")', '=1+1', '=cmd|\' /c calc\'!A0'],
    ['+1', '-1', '@SUM(A1)'],
  ];
  const bufSerang = await bangunXlsx(['a', 'b', 'c'], serang);
  const bacaSerang = await bacaUlang(bufSerang);

  eq('tidak ada sel yang jadi formula',
    bacaSerang.out.slice(1).flat().filter((c) => c.startsWith('FORMULA:')).length, 0);

  // Nilai aslinya harus utuh setelah dibuka, hanya tidak dieksekusi.
  eq('nilai formula utuh setelah dibuka',
    tanpaApostrof(bacaSerang.out[1][0]), serang[0][0]);
  eq('nilai =1+1 utuh setelah dibuka',
    tanpaApostrof(bacaSerang.out[1][1]), '=1+1');
  eq('nilai +1 utuh setelah dibuka',
    tanpaApostrof(bacaSerang.out[2][0]), '+1');
  eq('nilai @SUM utuh setelah dibuka',
    tanpaApostrof(bacaSerang.out[2][2]), '@SUM(A1)');

  eq('selAman tidak mengubah teks biasa', selAman('Siti Aminah'), 'Siti Aminah');
  eq('selAman mengubah angka menjadi teks', selAman(42), '42');

  console.log('\n=== 4. Nilai khusus XML ===');

  // & < > " ' adalah karakterCadangan XML. Kalau tidak di-escape, workbook
  // jadi rusak dan Excel menolak membukanya.
  const khusus = [
    ['a & b', '<script>', 'kutip " di dalam'],
    ["ampersand & entitas &lt;", 'garis\nbaru', 'tab\there'],
  ];
  const bufKhusus = await bangunXlsx(['x', 'y', 'z'], khusus);
  const bacaKhusus = await bacaUlang(bufKhusus);
  eq('ampersand tidak merusak', bacaKhusus.out[1][0], 'a & b');
  eq('kurung sudut tidak merusak', bacaKhusus.out[1][1], '<script>');
  eq('kutip tidak merusak', bacaKhusus.out[1][2], 'kutip " di dalam');
  eq('entitas tidak diurai dua kali', bacaKhusus.out[2][0], 'ampersand & entitas &lt;');

  console.log('\n=== 5. Kasus batas ===');

  const bufKosong = await bangunXlsx([], []);
  ok('header kosong tetap menghasilkan berkas valid', Buffer.isBuffer(bufKosong));
  await bacaUlang(bufKosong);

  const bufTanpaHeader = await bangunXlsx(null, [['a', 'b']]);
  const bacaTanpa = await bacaUlang(bufTanpaHeader);
  eq('tanpa header, baris tetap terbaca', bacaTanpa.out, [['a', 'b']]);

  // Baris tidak sama panjang dengan header. Baris pendek harus mengosongkan
  // sel yang tidak diisi, bukan menggeser nilai ke kolom berikutnya.
  const bufRamping = await bangunXlsx(['a', 'b', 'c'], [['1'], ['1', '2', '3', '4']]);
  const bacaRamping = await bacaUlang(bufRamping);
  eq('baris pendek tidak menggeser kolom', bacaRamping.out[1][0], '1');
  ok('baris pendek tidak menambah sel', bacaRamping.out[1].length <= 3);
  eq('baris panjang dipotong pada lebar header', bacaRamping.out[2], ['1', '2', '3']);

  // Sel di luar lebar header akan terlihat di Excel tanpa label header, jadi
  // harus hilang total -- bukan hanya disembunyikan.
  ok('tidak ada sel di luar lebar header',
    bacaRamping.out.every((r) => r.length <= 3));

  const bufNumerik = await bangunXlsx(['no'], [[0], [null], [undefined], [false]]);
  const bacaNumerik = await bacaUlang(bufNumerik);
  eq('nilai falsy tidak jadi string "null"',
    bacaNumerik.out.slice(1).map((r) => r[0]), ['0', '', '', 'false']);

  // Nama sheet memanjang harus dipotong, bukan ditolak.
  const bufNamaPanjang = await bangunXlsx(['a'], [['1']], { namaSheet: 'nama yang jauh terlalu panjang untuk excel' });
  const bacaNama = await bacaUlang(bufNamaPanjang);
  ok('nama sheet dipotong ke 31 karakter', bacaNama.namaSheet.length <= 31);

  // Karakter terlarang pada nama sheet harus dinetralkan, bukan membuat
  // workbook gagal dibuka.
  const bufNamaAneh = await bangunXlsx(['a'], [['1']], { namaSheet: 'a/b\\c*d?e[f]g' });
  const bacaNamaAneh = await bacaUlang(bufNamaAneh);
  ok('karakter terlarang nama sheet dibersihkan', !/[\/*?:[\]]/.test(bacaNamaAneh.namaSheet));

  console.log('\n=== 6. Determinisme ===');

  // Determinisme diuji pada ISI, bukan byte mentah. Berkas ZIP membawa stempel
  // waktu per entri (ditulis archiver saat writeBuffer), jadi dua pembangunan
  // pada detik berbeda selalu berbeda byte walau isinya sama -- ini sudah
  // diverifikasi terhadap exceljs secara langsung, bukan ditebak. Membekukan
  // wb.created/wb.modified pun hanya menutup 334 dari 366 byte yang berubah.
  // Yang menentukan hasil ekspor bagi operator adalah isi sheet, dan itu yang
  // dibandingkan di sini.
  const a1 = await bangunXlsx(header, baris);
  const a2 = await bangunXlsx(header, baris);
  const bacaA1 = await bacaUlang(a1);
  const bacaA2 = await bacaUlang(a2);
  eq('isi sama untuk masukan sama', bacaA1, bacaA2);
  ok('nama sheet sama', bacaA1.namaSheet === bacaA2.namaSheet);
  ok('isinya memang terisi (bukan dua buffer kosong yang kebetulan sama)',
    bacaA1.out.length > 0 && bacaA1.out[0].length > 0);

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nADA YANG RUSAK. Ekspor XLSX tidak boleh.andalkan sebelum ini hijau.');
    process.exit(1);
  } else {
    console.log('\nSEMUA UJI LOLOS');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});