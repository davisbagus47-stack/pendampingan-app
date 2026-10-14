/**
 * Uji end-to-end `POST /api/submit` (FR-4.4).
 *
 * Berkas ini ada karena jalur submit tidak pernah teruji end-to-end: tidak ada
 * titik injeksi, jadi satu-satunya cara mengujinya adalah memanggil Google
 * Sheets sungguhan. `setSheets` baru ditambahkan untuk ini.
 *
 * Yang diperiksa bukan cara menulis ke Sheets (itu urusan Sheets), tapi jalur
 * yang SULIT terlihat: metadata yang hanya diketahui route ini masuk log,
 * apa yang terjadi pada input yang tidak valid, dan apakah galat jaringan
 * menghasilkan entri `error` yang benar bukan `success`.
 */

const http = require('http');
const app = require('../index.js');

let lulus = 0;
let gagal = 0;

function eq(nama, dapat, harap) {
  const a = JSON.stringify(dapat);
  const b = JSON.stringify(harap);
  if (a === b) { console.log('lulus  ' + nama); lulus++; }
  else {
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
    gagal++;
  }
}

function ok(nama, syarat, detail) {
  if (syarat) { console.log('lulus  ' + nama); lulus++; }
  else { console.log('GAGAL  ' + nama + (detail ? ' (' + detail + ')' : '')); gagal++; }
}

const settle = () => new Promise((r) => setTimeout(r, 15));

const server = http.createServer(app);
let port = 0;

function minta(path, o) {
  const data = o.body === undefined ? null : JSON.stringify(o.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: o.method || 'GET',
      headers: Object.assign({
        'content-type': 'application/json',
        'x-agency-id': 'ag-submit',
      }, data ? { 'content-length': Buffer.byteLength(data) } : {}, o.headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Sheets palsu yang mencatat setiap pemanggilan dan bisa disuruh gagal. */
function sheetsPalsu() {
  const catatan = { get: 0, update: 0, append: 0, baris: [] };
  let gagalAppend = false;
  const s = {
    _catatan: catatan,
    _gagalAppend: (v) => { gagalAppend = v; },
    spreadsheets: {
      values: {
        async get() { catatan.get++; return { data: { values: [['No']] } }; },
        async update() { catatan.update++; return { data: {} }; },
        async append(a) {
          if (gagalAppend) throw new Error('gagal jaringan (palsu)');
          catatan.append++;
          catatan.baris.push(a.resource.values[0]);
          return { data: { updates: { updatedRange: 'Sheet1!A2' } } };
        },
      },
    },
  };
  return s;
}

// Payload yang lolos `validate()`.
const PAYLOAD = {
  nik: '3201010101800001',
  namaLengkap: 'Uji Submit',
  namaTPK: 'TPK Uji',
  peranTPK: 'Kader',
  namaDesa: 'Desa Uji',
  jenisSasaran: 'Catin',
  tanggalKunjungan: '31 Des 2024',
  alamat: 'Jl. Uji 1',
};

let tertangkap = [];
const loggerUji = require('../lib/access-log.js').buatLogger({
  sink: (entri) => { tertangkap.push(entri); },
});
const terakhir = () => tertangkap[tertangkap.length - 1];

// Kuota longgar supaya rate limit tidak menentukan hasil assertion.
app.limiter.aturKonfigurasi('ag-submit', { kuota: 100000, jendelaMs: 60000, burst: 0 });
app.gantiAccessLogger(loggerUji);

// Suite ini memakai identitas legacy `x-agency-id`; begitu DATABASE_URL
// tersedia, index.js otomatis menyalakan verifikasi kunci API (F3.10a).
// Matikan di sini supaya yang diuji tetap alur submit, bukan autentikasi.
app.setCariKunci(null);

async function main() {
  const sheets = sheetsPalsu();
  app.setSheets(() => sheets);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  // -------------------------------------------------------------------------
  console.log('=== 1. Submit sukses tercatat ===');

  tertangkap = [];
  let r = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
  await settle();
  eq('respons 200', r.status, 200);
  eq('json sukses', JSON.parse(r.body).success, true);
  ok('append dipanggil tepat satu kali', sheets._catatan.append === 1,
    'dapat ' + sheets._catatan.append);

  const e1 = terakhir();
  ok('entri tercatat', !!e1 && typeof e1.result === 'string');
  eq('result sukses', e1.result, 'success');
  // Route submit memang sengaja menandai actorType=operator: dia berbeda dari
  // endpoint baca, yang mengidentifikasi instansi. Kalau disamakan, dari log
  // tidak akan terlihat siapa yang MENULIS data.
  eq('actorType route submit = operator', e1.actor_type, 'operator');
  eq('category diambil dari jenisSasaran mentah', e1.category, 'Catin');
  eq('response_rows = 1 untuk satu baris tertulis', e1.response_rows, 1);
  eq('endpoint', e1.endpoint, '/api/submit');

  // =========================================================================
  // Yang paling penting: SUBMIT tidak pernah boleh mencatat `denied_*`.
  //
  // Route ini tidak membaca data instansi lain, jadi tidak ada yang bisa
  // ditolak per-kategori. Kalau salah satu berakhir `denied_auth` atau
  // `denied_category`, berarti metadata route tercampur dengan penolakan
  // lain -- dan orang akan salah menyimpulkan bahwa penyebabnya hak akses,
  // padahal masalahnya di tempat lain.
  ok('submit sukses bukan denied_auth', e1.result !== 'denied_auth');
  ok('submit sukses bukan denied_category', e1.result !== 'denied_category');
  ok('submit sukses bukan rate_limited', e1.result !== 'rate_limited');
  eq('actor_id null di mode legacy (header berisi string)',
    e1.actor_id, null);

  // -------------------------------------------------------------------------
  console.log('=== 2. Input tidak valid: galat, bukan sukses ===');

  const berkasKosong = Object.assign({}, PAYLOAD, { nik: 'abc' });
  tertangkap = [];
  r = await minta('/api/submit', { method: 'POST', body: berkasKosong });
  await settle();
  eq('validasi gagal = 400', r.status, 400);
  eq('respons bukan sukses', JSON.parse(r.body).success, false);
  // Inti uji ini: yang membaca dirinya berulangkali. Ini bukan tentang vakerasi
  // itu sendiri, tapi bahwa pencatatan mengikuti hasil yang SEBENARNYA.
  const e2 = terakhir();
  eq('tercatat sebagai error, bukan success', e2.result, 'error');
  eq('tidak ada baris yang ditulis', sheets._catatan.append, 1);
  eq('tidak ada yang menyimpan catatan galat palsu', e2.response_rows, 0);

  // `fields_invalid` harus tercatat: tanpa itu, dari log tidak bisa dibedakan
  // "input kosong" dari "galat server yang tidak ada hubungannya dengan input".
  eq('jumlah field tidak valid tercatat', e2.params.fields_invalid, 1);

  const tubuhKosong = {};
  tertangkap = [];
  r = await minta('/api/submit', { method: 'POST', body: tubuhKosong });
  await settle();
  eq('body kosong = 400', r.status, 400);
  const e3 = terakhir();
  eq('body kosong tercatat error', e3.result, 'error');
  ok('setiap field yang gagal terhitung', e3.params.fields_invalid >= 6,
    'dapat ' + e3.params.fields_invalid);
  eq('tabel tidak disentuh', sheets._catatan.append, 1);

  // -------------------------------------------------------------------------
  console.log('=== 3. Galat jaringan: error, bukan sukses ===');

  // Ini yang paling mudah salah: respons 500 bisa saja tercatat `success`
  // kalau result di-set sebelum melempar. Dari log, kegagalan Google akan
  // terlihat seperti penyimpanan sukses.
  sheets._gagalAppend(true);
  tertangkap = [];
  r = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
  await settle();
  eq('galat jaringan = 500', r.status, 500);
  const e4 = terakhir();
  eq('tercatat error', e4.result, 'error');
  eq('kode INTERNAL_ERROR', e4.params && e4.params.code !== undefined ? e4.params.code : 'INTERNAL_ERROR',
    'INTERNAL_ERROR');
  eq('tidak ada baris yang tertulis', sheets._catatan.append, 1);
  sheets._gagalAppend(false);

  // -------------------------------------------------------------------------
  console.log('=== 4. Tidak ada kebocoran pesan galat ke klien ===');

  r = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
  await settle();
  ok('pesan 500 disaring, tidak membocorkan detail internal',
    r.body.indexOf('Pokus') < 0 && r.body.indexOf('stack') < 0);
  ok('respons 500 tetap menyebut Google Sheets sebagai penyebab luar',
    r.body.indexOf('Google Sheets') > 0);
  eq('append berhasil sekali lagi setelah dinyalakan', sheets._catatan.append, 2);

  // -------------------------------------------------------------------------
  console.log('=== 5. Rate limit tidak membajak submit ===');

  // endpoint ini pakai identitas agency yang sama; pastikan kuota dipakai
  // tapi tidak membuat semua submit jadi 429.
  let suksesBerturut = 0;
  for (let i = 0; i < 5; i++) {
    const rr = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
    if (rr.status === 200) suksesBerturut++;
  }
  await settle();
  eq('lima submit berturut-turut semua 200', suksesBerturut, 5);
  eq('lima baris tercatat', sheets._catatan.append, 7);
  const e5 = terakhir();
  eq('entri terakhir sukses', e5.result, 'success');

  console.log('\nlulus: ' + lulus + '  gagal: ' + gagal);
  if (gagal === 0) console.log('SEMUA UJI LOLOS');

  server.close();
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('GALAT tak terduga:', e && e.stack ? e.stack : e);
  server.close();
  process.exit(1);
});