/**
 * Uji end-to-end `POST /api/submit` (FR-4.4).
 *
 * Berkas ini ada karena jalur submit tidak pernah teruji end-to-end: tidak ada
 * titik injeksi, jadi satu-satunya cara mengujinya adalah memanggil Google
 * Sheets sungguhan. `setSheets` baru ditambahkan untuk ini.
 *
 * Yang diperiksa adalah verifikasi tanda tangan dan identitas kader sebelum
 * submit, serta pencatatan hasil yang sesuai di access_log.
 */

const http = require('http');
const { Wallet } = require('ethers');
const app = require('../index.js');
const tpkIdentity = require('../lib/tpk-identity.js');

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

const walletUji = Wallet.createRandom();

async function minta(path, o) {
  let requestBody = o.body;
  if (path === '/api/submit' && o.sign !== false && requestBody !== undefined) {
    const signedPayload = o.signPayload || requestBody;
    const signature = await walletUji.signMessage(tpkIdentity.pesanPengiriman(walletUji.address, signedPayload));
    requestBody = {
      ...requestBody,
      writerWalletAddress: walletUji.address,
      writerSignature: signature,
    };
  }
  const data = requestBody === undefined ? null : JSON.stringify(requestBody);
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
let writerIdentitySeen = null;
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

// Per-input audit jalur form menulis ke PostgreSQL. Uji ini sengaja berjalan
// TANPA database (Sheets palsu), jadi titik suntiknya dimatikan supaya
// DATABASE_URL yang kebetulan ada di .env tidak membuat uji menulis record
// sungguhan.
app.setCatatFormAudit(async (_body, writer) => {
  writerIdentitySeen = writer;
  return { status: 'skipped', reason: 'TEST' };
});
app.setCariAnggotaTpk(async (address) => (
  address.toLowerCase() === walletUji.address.toLowerCase()
    ? { nik: '3201234567890001', nama_lengkap: 'Kader Uji', wallet_address: walletUji.address }
    : null
));

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
  eq('submit tidak memanggil Sheets langsung (flush dilakukan worker)', sheets._catatan.append, 0);
  eq('writer berasal dari pemetaan wallet TPK',
    writerIdentitySeen,
    {
      nik: '3201234567890001',
      name: 'Kader Uji',
      walletAddress: walletUji.address,
    });

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
  ok('signature tidak masuk access_log', JSON.stringify(e1).indexOf('writerSignature') < 0);

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
  eq('input tidak valid tidak memanggil Sheets', sheets._catatan.append, 0);
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
  eq('body kosong tidak memanggil Sheets', sheets._catatan.append, 0);

  // -------------------------------------------------------------------------
  console.log('=== 3. Tanda tangan harus cocok dengan payload ===');

  tertangkap = [];
  r = await minta('/api/submit', { method: 'POST', body: PAYLOAD, sign: false });
  await settle();
  eq('tanpa signature = 401', r.status, 401);
  const e4 = terakhir();
  eq('penolakan signature tercatat denied_auth', e4.result, 'denied_auth');
  eq('tidak ada Sheets yang dipanggil', sheets._catatan.append, 0);

  r = await minta('/api/submit', {
    method: 'POST',
    body: Object.assign({}, PAYLOAD, { namaTPK: 'Nama dipalsukan setelah tanda tangan' }),
    signPayload: PAYLOAD,
  });
  eq('payload yang berubah setelah ditandatangani ditolak', r.status, 401);

  // -------------------------------------------------------------------------
  console.log('=== 4. Wallet tidak terdaftar ditolak ===');

  app.setCariAnggotaTpk(async () => null);
  r = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
  await settle();
  eq('wallet tanpa pemetaan TPK = 401', r.status, 401);
  app.setCariAnggotaTpk(async (address) => (
    address.toLowerCase() === walletUji.address.toLowerCase()
      ? { nik: '3201234567890001', nama_lengkap: 'Kader Uji', wallet_address: walletUji.address }
      : null
  ));

  // -------------------------------------------------------------------------
  console.log('=== 5. Rate limit tidak membajak submit ===');

  // endpoint ini pakai identitas agency yang sama; pastikan kuota dipakai
  // tapi tidak membuat semua submit jadi 429.
  let suksesBerturut = 0;
  let rrTerakhir = null;
  for (let i = 0; i < 5; i++) {
    rrTerakhir = await minta('/api/submit', { method: 'POST', body: PAYLOAD });
    if (rrTerakhir.status === 200) suksesBerturut++;
  }
  await settle();
  eq('lima submit berturut-turut semua 200', suksesBerturut, 5);
  eq('tidak ada pemanggilan Sheets langsung', sheets._catatan.append, 0);
  const e5 = terakhir();
  eq('entri terakhir sukses', e5.result, 'success');

  // Justru karena /api/submit ikut JALUR_PUBLIK (tanpa kunci), kuota WAJIB
  // tetap jalan di sini: menonaktifkan autentikasi tanpa memasang jatah sama
  // dengan membuka pintu tulis tak terbatas ke Google Sheets. Header ini satu-
  // satunya cara lewat HTTP untuk memastikan limiter dipanggil di route ini.
  ok('submit keluar dari limiter (header RateLimit ada)',
    rrTerakhir.headers['ratelimit-limit'] !== undefined);
  ok('sisa kuota submit terbaca dan terbatas',
    Number.isFinite(Number(rrTerakhir.headers['ratelimit-remaining']))
    && Number(rrTerakhir.headers['ratelimit-limit']) > 0);

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