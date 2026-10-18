/**
 * Uji integrasi route: rate limit (FR-4.5) dan penolakan kolom terlarang
 * (FR-4.20a/c) pada jalur HTTP sebenarnya.
 *
 * Yang diuji di sini adalah urutan operasinya, bukan hanya isi respons.
 * Dua kebocoran yang paling mungkin pada PoC ini sama-sama tidak terlihat di
 * respons:
 *
 *   - permintaan terlarang yang tetap membaca spreadsheet sebelum ditolak
 *   - rate limit yang baru jalan SETELAH pekerjaan mahal selesai
 *
 * Keduanya hanya terlihat kalau kita menghitung berapa kali sumber data
 * dipanggil, jadi `req` dan `res` di sini palsu dan sengaja dihitung.
 */

const http = require('http');
const app = require('../index.js');

let passed = 0;
let failed = 0;

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

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

const server = http.createServer(app);

// Aplikasi menulis access_log ke PostgreSQL bila DATABASE_URL diset, dan
// suite ini bukan tempat untuk menguji penulisan itu (itu urusan
// test-access-log / test-db). Ganti logger bawaan dengan sink tangkap supaya
// permintaan uji tidak menulis ke database sungguhan dan suite tetap jalan
// cepat tanpa jaringan. Sink tangkap sama seperti yang dipakai test-submit.
const tertangkapLog = [];
app.gantiAccessLogger(
  require('../lib/access-log.js').buatLogger({
    sink: (e) => { tertangkapLog.push(e); },
  })
);

function listening() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function tutup() {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Permintaan GET sungguhan ke route. */
function minta(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Ubah body respons jadi objek, atau null kalau bukan JSON. */
function json(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

async function main() {
  const port = await listening();
  console.log('=== 1. Rate limit: 429, header, dan kode mesin ===');

  // Bawa agency_id supaya kuota terisolasi ke instansi ini saja.
  const A = { 'x-agency-id': 'ag-rl-1' };

  const hasil = [];


  // Setiap permintaan nyata membaca spreadsheet dan butuh waktu, sehingga banyak
  // permintaan bisa tersebar lebih dari satu detik. Batas burst diukur per
  // detik, jadi burst tidak pernah terlampaui dan uji jadi tidak stabil --
  // bergantung pada latensi jaringan, bukan pada kode. Kuota kecil dengan
  // burst dimatikan membuat uji ini bergantung pada kode saja.

  app.limiter.aturKonfigurasi('ag-rl-1', { kuota: 3, burst: 0 });
  app.limiter.aturKonfigurasi('ag-rl-3', { kuota: 50, burst: 0 });

  // Suite ini menguji rate limit dan penolakan kolom, BUKAN autentikasi,
  // dan memakai identitas legacy `x-agency-id`. Begitu DATABASE_URL tersedia,
  // index.js otomatis menyalakan verifikasi kunci API (F3.10a) -- matikan di
  // sini supaya yang diuji tetap rate limit, bukan kredensial.
  app.setCariKunci(null);

  for (let i = 0; i < 6; i++) hasil.push(await minta(port, '/api/sasaran', A));

  const ditolak = hasil.filter((r) => r.status === 429);

  const tolakPertama = ditolak[0];
  const bodyTolak = json(tolakPertama.body);
  eq('kode mesin rate limit', bodyTolak && bodyTolak.code, 'RATE_LIMITED');
  eq('success false', bodyTolak && bodyTolak.success, false);
  ok('retry_after ada di body', bodyTolak && bodyTolak.retry_after > 0);

  ok('Retry-After ada di header', tolakPertama.headers['retry-after'] !== undefined);
  ok('RateLimit-Limit ada di header', tolakPertama.headers['ratelimit-limit'] !== undefined);
  eq('sisa nol saat ditolak', tolakPertama.headers['ratelimit-remaining'], '0');

  // Response 429 harus selalu punya Retry-After. Tanpa itu klien hanya menebak,
  // dan menebak biasanya berarti mencoba lagi lebih cepat.
  for (const r of ditolak) {
    if (Number(r.headers['retry-after']) <= 0) {
      failed++;
      console.log('GAGAL  setiap 429 punya Retry-After > 0');
      break;
    }
  }
  if (ditolak.every((r) => Number(r.headers['retry-after']) > 0)) {
    passed++; console.log('LULUS  setiap 429 punya Retry-After > 0');
  }

  console.log('\n=== 2. Kuota terisolasi per instansi ===');

  const lain = await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-rl-2' });
  ok('instansi lain tidak ikut kena', lain.status !== 429);

  // `/api/sasaran` termasuk JALUR_PUBLIK (form TPK). Tanpa identitas sama sekali
  // ia tidak lagi 429, karena halaman form memang tidak mengirim apa pun --
  // kalau tetap ditolak, form publik tidak akan bisa memuat pencarian sama
  // sekali. Yang diganti adalah BASIS kuncinya: identitas '' jatuh ke kunci
  // bersama 'publik', jadi tetap dibatasi kuota, bukan lolos begitu saja.
  // Route non-publik tanpa identitas masih 429 seperti biasa.
  const tanpaHeader = await minta(port, '/api/sasaran', {});
  eq('jalur publik tanpa identitas tetap dibatasi kuota', tanpaHeader.status, 200);
  const sisaPublik = Number(tanpaHeader.headers['ratelimit-remaining']);
  ok('kuota jalur publik memakai kunci bersama (bukan tak terbatas)',
    Number.isFinite(sisaPublik) && sisaPublik >= 0);

  console.log('\n=== 3. Validasi MENJALAN sebelum sumber data disentuh ===');

  // `kirimBaris` juga memvalidasi kolom terlarang, jadi respons yang sama akan
  // muncul apakah validasi awal ada atau tidak. Menguji respons saja tidak
  // bisa membedakan keduanya -- dan itu tepat bahaya yang paling ingin dicegah:
  // permintaan terlarang tetap membaca spreadsheet sebelum ditolak.
  //
  // Yang diuji: validasi awal melempar SEBELUM pemanggilan mana pun ke
  // sumber data. Kalau dihapus, pemanggilan pertama yang terjadi adalah
  // pembacaan sheet.
  const reqPalsu = { headers: {}, query: { fields: 'catatanTPK' }, originalUrl: '/api/sasaran' };
  let dibangun = null;
  try {
    app.validasiPermintaan(reqPalsu);
  } catch (e) {
    dibangun = e;
  }
  ok('validasi awal menolak kolom terlarang', dibangun !== null);
  eq('kodenya FIELD_NOT_GRANTED', dibangun && dibangun.code, 'FIELD_NOT_GRANTED');
  eq('statusnya 403', dibangun && dibangun.status, 403);

  // Validasi awal juga menolak format yang tidak dikenal, sebelum apa pun
  // dijalankan.
  const reqFormat = { headers: {}, query: { format: 'pdf' }, originalUrl: '/api/sasaran' };
  let formatGalat = null;
  try { app.validasiPermintaan(reqFormat); } catch (e) { formatGalat = e; }
  ok('validasi awal menolak format yang tidak dikenal', formatGalat !== null);
  eq('kodenya INVALID_FORMAT', formatGalat && formatGalat.code, 'INVALID_FORMAT');

  // XLSX harus LOLOS validasi awal. Ia ditolak di sini pada versi sebelumnya,
  // padahal `kirimBaris` sudah bisa menulisnya -- jadi fiturnya ada tapi tidak
  // bisa dipanggil. Assertion ini mengubah pengaman lama menjadi pernyataan bahwa
  // validasi tidak lagi menolak format yang memang didukung.
  const reqXlsx = { headers: {}, query: { format: 'xlsx' }, originalUrl: '/api/sasaran' };
  let xlsxValidasi = null;
  let xlsxGalat = null;
  try { xlsxValidasi = app.validasiPermintaan(reqXlsx); } catch (e) { xlsxGalat = e; }
  ok('validasi awal tidak lagi menolak xlsx', xlsxGalat === null);
  eq('format xlsx diteruskan', xlsxValidasi && xlsxValidasi.format, 'xlsx');

  // Permintaan yang valid harus LOLOS validasi.
  const reqOk = { headers: {}, query: { fields: 'nik,usia', format: 'csv' }, originalUrl: '/api/sasaran' };
  let validasiOk = null;
  try { validasiOk = app.validasiPermintaan(reqOk); } catch (e) { validasiOk = e; }
  eq('permintaan valid tidak ditolak', validasiOk && validasiOk.fields, ['nik', 'usia']);
  eq('format valid diteruskan', validasiOk && validasiOk.format, 'csv');

  // Tanpa header, validasi awal tidak boleh menolak: yang menolak adalah
  // limiter, supaya tidak ada dua alasan penolakan yang tumpang tindih.
  const reqKosong = { headers: {}, query: {}, originalUrl: '/api/sasaran' };
  let kosong = null;
  try { kosong = app.validasiPermintaan(reqKosong); } catch (e) { kosong = e; }
  ok('permintaan tanpa fields tetap valid', kosong !== null && !kosong.code);

  console.log('\n=== 3b. Sumber data TIDAK disentuh saat permintaan ditolak ===');

  // Uji yang benar-benar membuktikan urutan, bukan hanya isi respons.
  //
  // Sheets. Kalau `getSheets` tidak pernah dipanggil untuk permintaan
  // terlarang, tidak ada pembacaan data sama sekali. Kalau dipanggil,
  // penolakan datang terlambat -- persis yang dilarang FR-4.20c.
  // penolakan datang terlambat -- persis yang dilarang FR-4.20c.
  //
  // Memeriksa `validasiPermintaan` secara langsung tidak membuktikan apa pun
  // soal urutan: fungsi itu bisa benar sementara route tidak memanggilnya,
  // dan route yang salah urutannya akan tetap menghasilkan respons yang sama.
  const asliGetSheets = require.cache[require.resolve('../index.js')];
  ok('index.js ter-cache (spy bisa dipasang)', !!asliGetSheets);

  let dipanggil = 0;
  const modul = asliGetSheets.exports;
  if (typeof modul.spyGetSheets === 'function') {
    modul.spyGetSheets(() => { dipanggil++; });
  } else {
  // Kuota habis harus menolak tanpa menyentuh data juga -- kalau tidak,
  // rate limit hanya membatasi respons, bukan pekerjaan yang mahal.
  }

  dipanggil = 0;
  await minta(port, '/api/sasaran?fields=catatanTPK', { 'x-agency-id': 'ag-spy-1' });
  eq('kolom terlarang: sumber data tidak disentuh', dipanggil, 0);

  // XLSX sekarang format yang DIDUKUNG, jadi memang harus membaca data --
  // assertion lama di sini mengunci 501 dan ikut menutup kebenaran. Yang tetap
  // wajib: format yang benar-benar tidak didukung tidak boleh menyentuh data.
  dipanggil = 0;
  await minta(port, '/api/sasaran?format=xlsx', { 'x-agency-id': 'ag-spy-1' });
  eq('format xlsx yang didukung memang membaca data', dipanggil, 1);

  dipanggil = 0;
  await minta(port, '/api/sasaran?format=pdf', { 'x-agency-id': 'ag-spy-1' });
  eq('format yang tidak didukung: sumber data tidak disentuh', dipanggil, 0);

  dipanggil = 0;
  await minta(port, '/api/sasaran?fields=kolomNgawur', { 'x-agency-id': 'ag-spy-1' });
  eq('kolom asing: sumber data tidak disentuh', dipanggil, 0);

  dipanggil = 0;
  await minta(port, '/api/sasaran?format=pdf', { 'x-agency-id': 'ag-spy-1' });
  eq('format asing: sumber data tidak disentuh', dipanggil, 0);

  // Kuota habis harus menolak tanpa menyentuh data juga -- kalau tidak,Journeys
  // rate limit hanya membatasi respons, bukan pekerjaan yang mahal.
  app.limiter.aturKonfigurasi('ag-spy-2', { kuota: 1, burst: 0 });
  dipanggil = 0;
  await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-spy-2' });
  const setelahPertama = dipanggil;
  await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-spy-2' });
  eq('permintaan pertama menyentuh sumber', setelahPertama, 1);
  eq('permintaan kedua (429) tidak menyentuh sumber', dipanggil, setelahPertama);

  console.log('\n=== 3c. Kolom terlarang ditolak dengan kode mesin ===');

  const B = { 'x-agency-id': 'ag-rl-3' };
  const terlarang = await minta(port, '/api/sasaran?fields=catatanTPK', B);
  eq('kolom terlarang ditolak', terlarang.status, 403);
  const bodyTerlarang = json(terlarang.body);
  eq('kodenya FIELD_NOT_GRANTED', bodyTerlarang && bodyTerlarang.code, 'FIELD_NOT_GRANTED');
  eq('kolom yang disebut', bodyTerlarang && bodyTerlarang.fields, ['catatanTPK']);
  // Pesan boleh menyebut NAMA kolom yang ditolak -- FR-4.20a justru menuntut
  // penolakan yang bisa ditindaklanjuti. Yang tidak boleh bocor adalah nilai
  // data dari kolom itu, jadi di sini diperiksa tidak ada isi record.
  const pesan = String((bodyTerlarang && bodyTerlarang.message) || '');
  ok('pesan menyebut kolom yang ditolak', /catatanTPK/.test(pesan));
  ok('pesan tidak memuat isi data', !/"data"/.test(pesan) && !/"data"/.test(tolakPertama.body));

  console.log('\n=== 4. Kolom asing ditolak sebagai FIELD_UNKNOWN ===');

  const asing = await minta(port, '/api/sasaran?fields=kolomNgawur', B);
  eq('kolom asing ditolak', asing.status, 400);
  eq('kodenya FIELD_UNKNOWN', json(asing.body) && json(asing.body).code, 'FIELD_UNKNOWN');

  console.log('\n=== 5. Format xlsx benar-benar Bisa dijangkau ===');

  // Uji ini pernah mengunci perilaku yang salah: `validasiPermintaan` menolak
  // xlsx dengan 501 "belum ada pustaka spreadsheet" padahal `lib/xlsx-export.js`
  // sudah ada dan sudah dibuka di Excel sungguhan. Blok itu berjalan sebelum
  // `kirimBaris`, jadi ekspor XLSX tidak pernah bisa dipanggil dari route ini.
  // Uji yang benar harus memanggil jalur yang sama dengan yang dipakai klien.
  const xlsx = await minta(port, '/api/sasaran?format=xlsx', B);
  eq('xlsx tidak ditolak 501 lagi', xlsx.status, 200);
  eq('tipe kontennya XLSX sungguhan',
    String(xlsx.headers['content-type']),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ok('badannya bukan CSV yang diberi nama .xlsx',
    !/^\s*[A-Za-z0-9 ,;]*(\r|\n)/.test(xlsx.body) && xlsx.body.length > 0);

  console.log('\n=== 6. Format asing ditolak ===');

  const formatAsing = await minta(port, '/api/sasaran?format=pdf', B);
  eq('format asing ditolak', formatAsing.status, 400);

  console.log('\n=== 7. Route lain tetap aman dari rate limit ===');

  const root = await minta(port, '/', {});
  eq('endpoint health tetap hidup', root.status, 200);
  const health = json(root.body);
  ok('health melaporkan ok', health && health.status === 'ok');

  console.log('\n=== 8. Kuota yang sudah habis tidak menutup route lain ===');

  const rootLagi = await minta(port, '/', A);
  eq('route / tidak kena 429 walau agency sama', rootLagi.status, 200);

  await tutup();

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nADA YANG RUSAK. Jangan andalkan route sebelum ini hijau.');
    process.exit(1);
  } else {
    console.log('\nSEMUA UJI LOLOS');
  }
}

main().catch((e) => {
  console.error('Uji integrasi gagal dijalankan:', e.message);
  server.close();
  process.exit(1);
});
