/**
 * Uji middleware autentikasi kunci API lewat HTTP (F3.10a).
 *
 * Berbeda dari test-api-key-auth.js yang menguji modul murni, berkas ini
 * mengirim request ke server sungguhan. Yang diuji adalah PIRINGATAN yang
 * paling sering luput: urutan middleware, apa yang terjadi pada 404, dan
 * apakah penolakan benar-benar sampai ke access_log.
 *
 * Database tidak dibutuhkan: `setCariKunci` menerima fungsi pencarian yang
 * dibuat di sini, sama seperti `spyGetSheets` untuk Google Sheets.
 *
 * Catatan jalur: `/api/sasaran` dan `/api/submit` masuk JALUR_PUBLIK (form TPK
 * tidak bisa menyimpan kunci API), jadi uji penolakan memakai `/api/audit/status`
 * yang tetap wajib kunci. Bagian 10 menguji sisi publiknya.
 */

const http = require('http');
const app = require('../index.js');
const auth = require('../lib/api-key-auth.js');
const { buatToken, hashToken } = require('./api-keys.js');

let lulus = 0;
let gagal = 0;

function ok(nama, syarat) {
  if (syarat) { console.log('lulus  ' + nama); lulus++; }
  else { console.log('GAGAL  ' + nama); gagal++; }
}

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

// ---------------------------------------------------------------------------
// Server sungguhan
// ---------------------------------------------------------------------------

const server = http.createServer(app);
let port = 0;

/** Tunggu pencatatan selesai: `finish` dijadwalkan setelah klien menerima respons. */
const settle = () => new Promise((r) => setTimeout(r, 15));

function minta(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: headers || {} },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Permintaan POST JSON tanpa kunci -- untuk jalur publik form. */
function mintaPost(path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Kunci uji
// ---------------------------------------------------------------------------

const tokenAktif = buatToken();
const tokenStandby = buatToken();
const tokenRevoked = buatToken();
const tokenKatA = buatToken();

const BARIS = {
  [tokenAktif.hash]: {
    id: 1, agency_id: 42, key_prefix: tokenAktif.prefix,
    status: 'primary', category: null, table_name: null,
  },
  [tokenStandby.hash]: {
    id: 2, agency_id: 43, key_prefix: tokenStandby.prefix,
    status: 'standby', category: null, table_name: null,
  },
  [tokenRevoked.hash]: {
    id: 3, agency_id: 44, key_prefix: tokenRevoked.prefix,
    status: 'revoked', category: null, table_name: null,
  },
  [tokenKatA.hash]: {
    id: 4, agency_id: 45, key_prefix: tokenKatA.prefix,
    status: 'primary', category: 'a', table_name: null,
  },
};

let dipanggilCari = 0;
const cariKunciUji = async (hash) => {
  dipanggilCari++;
  return BARIS[hash] || null;
};

/** Sink yang menangkap entri access_log, bukan menulis ke stdout. */
let tertangkap = [];
const loggerUji = require('../lib/access-log.js').buatLogger({
  sink: (entri) => { tertangkap.push(entri); },
});

// Kuota longgar supaya rate limit tidak ikut menentukan hasil assertion.
app.limiter.aturKonfigurasi('id-42', { kuota: 100000, jendelaMs: 60000, burst: 0 });
app.limiter.aturKonfigurasi('id-43', { kuota: 100000, jendelaMs: 60000, burst: 0 });
app.limiter.aturKonfigurasi('id-44', { kuota: 100000, jendelaMs: 60000, burst: 0 });
app.limiter.aturKonfigurasi('id-45', { kuota: 100000, jendelaMs: 60000, burst: 0 });
// Jalur publik memakai kunci sintetis 'publik' (lihat KUNCI_PUBLIK di index.js).
// Konfigurasinya sudah dipasang saat modul dimuat; ditegaskan di sini supaya
// urutan muat modul tidak bisa diam-diam menjatuhkan uji ini.
app.limiter.aturKonfigurasi('publik', { kuota: 100000, jendelaMs: 60000, burst: 0 });

app.gantiAccessLogger(loggerUji);
app.setCariKunci(cariKunciUji);
app.spyGetSheets(async () => [{ nik: '3201010101800001', namaLengkap: 'Uji Satu' }]);

const AUTH = (t) => ({ authorization: 'Bearer ' + t.token });

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  // -------------------------------------------------------------------------
  console.log('=== 1. Kunci valid diterima ===');

  tertangkap = [];
  let r = await minta('/api/audit/status', AUTH(tokenAktif));
  await settle();
  eq('kunci primary tidak ditolak', r.status, 200);

  // actor_id harus terisi sekarang. Inilah yang F3.9 tidak bisa lakukan tanpa
  // F3.10a: tanpa ini, `actor_id` selalu null dan audit tidak bisa
  // Linking ke instansi mana pun.
  const e1 = tertangkap[tertangkap.length - 1];
  eq('actor_id terisi agency_id dari kunci', e1.actor_id, 42);
  eq('actor_type = agency', e1.actor_type, 'agency');
  eq('result sukses', e1.result, 'success');

  // -------------------------------------------------------------------------
  console.log('=== 2. Kredensial ditolak ===');

  tertangkap = [];
  r = await minta('/api/audit/status', {});
  await settle();
  eq('tanpa kunci = 401', r.status, 401);
  eq('kode MISSING_KEY', JSON.parse(r.body).code, auth.KODE.MISSING);
  const e2 = tertangkap[tertangkap.length - 1];
  eq('penolakan tercatat sebagai denied_auth', e2.result, 'denied_auth');
  eq('kode alasan masuk params', e2.params.auth_code, auth.KODE.MISSING);

  r = await minta('/api/audit/status', { authorization: 'Bearer tokenNgawur' });
  await settle();
  eq('token salah bentuk = 401', r.status, 401);
  eq('kode MALFORMED_KEY', JSON.parse(r.body).code, auth.KODE.MALFORMED);

  r = await minta('/api/audit/status', AUTH(tokenRevoked));
  await settle();
  eq('kunci dicabut = 401', r.status, 401);
  eq('kode KEY_REVOKED', JSON.parse(r.body).code, auth.KODE.REVOKED);
  const e3 = tertangkap[tertangkap.length - 1];
  eq('kunci dicabut tetap tercatat', e3.result, 'denied_auth');
  // Ini yang paling berharga saat insiden: kunci dicabut TAPI masih dipakai.
  eq('kunci dicabut yang dipakai tercatat dengan agency-nya', e3.params.agency_id, 44);

  r = await minta('/api/audit/status', AUTH(tokenStandby));
  await settle();
  eq('kunci cadangan = 401', r.status, 401);
  eq('kode KEY_STANDBY', JSON.parse(r.body).code, auth.KODE.STANDBY);

  r = await minta('/api/audit/status', { authorization: 'abc123' });
  await settle();
  eq('Authorization tanpa Bearer = 401', r.status, 401);
  eq('kode MALFORMED_KEY untuk header salah format', JSON.parse(r.body).code, auth.KODE.MALFORMED);

  // -------------------------------------------------------------------------
  console.log('=== 3. Token tidak boleh bocor ke log ===');

  tertangkap = [];
  const tokenSalah = 'pa_sk_live_' + 'A'.repeat(43);
  await minta('/api/audit/status', AUTH({ token: tokenSalah }));
  await settle();
  const e4 = tertangkap[tertangkap.length - 1];
  ok('token utuh tidak muncul di entri log',
    JSON.stringify(e4).indexOf(tokenSalah) < 0);
  // Token berbentuk benar tapi tidak dikenal dicatat apa adanya: bentuknya sudah
  // pasti benar, jadi `token_shape` tidak ada gunanya di sini.
  eq('token tak dikenal tidak butuh token_shape', e4.params.token_shape, undefined);

  // Yang perlu `token_shape` justru token salah BENTUK: dari situ operator bisa
  // melihat "yang dikirim bukan token pa_sk_live_ sama sekali" tanpa pernah
  // melihat tokennya.
  const tokenCacat = 'sembilan-pastas-token';
  await minta('/api/audit/status', AUTH({ token: tokenCacat }));
  await settle();
  const e4b = tertangkap[tertangkap.length - 1];
  ok('token cacat utuh tidak masuk log',
    JSON.stringify(e4b).indexOf(tokenCacat) < 0);
  ok('bentuk token tetap dicatat untuk diagnosis',
    typeof e4b.params.token_shape === 'string' && e4b.params.token_shape.length < 40);

  // Klien tidak boleh diberi tahu hash atau agency mana yang cocok.
  r = await minta('/api/audit/status', AUTH(tokenRevoked));
  await settle();
  ok('respons tidak menyebut agency',
    r.body.indexOf('"44"') < 0 && r.body.indexOf('agency') < 0);
  ok('respons tidak menyebut hash',
    r.body.indexOf(tokenRevoked.hash) < 0);
  eq('respons hanya punya tiga field',
    Object.keys(JSON.parse(r.body)).sort(), ['code', 'message', 'success']);

  // -------------------------------------------------------------------------
  console.log('=== 4. Scope = 403, bukan 401 ===');

  r = await minta('/api/audit/status?kategori_1=a', AUTH(tokenKatA));
  await settle();
  eq('kategori sesuai scope = boleh', r.status, 200);

  r = await minta('/api/audit/status?kategori_1=c', AUTH(tokenKatA));
  await settle();
  eq('kategori di luar scope = 403', r.status, 403);
  eq('kode KEY_SCOPE_DENIED', JSON.parse(r.body).code, auth.KODE.SCOPE);
  const e5 = tertangkap[tertangkap.length - 1];
  eq('scope tetap denied_auth', e5.result, 'denied_auth');

  // Tanpa filter kategori berarti "semua kategori". Kunci yang dibatasi satu
  // kategori tidak boleh mendapat itu.
  r = await minta('/api/audit/status', AUTH(tokenKatA));
  await settle();
  eq('scope tanpa filter kategori = 403', r.status, 403);

  // -------------------------------------------------------------------------
  console.log('=== 5. Verifikasi sebelum kuota ===');

  // Kalau kuota dihitung lebih dulu, kunci dicabut akan memakai jatah kuota
  // sebelum ditolak. Dan Authorization 401 harus TIDAK menghasilkan 429.
  const sebelum = tertangkap.length;
  r = await minta('/api/audit/status', AUTH(tokenRevoked));
  await settle();
  eq('401 bukan 429', r.status, 401);
  ok('tidak ada header RateLimit pada penolakan auth',
    r.headers['ratelimit-limit'] === undefined);

  // -------------------------------------------------------------------------
  console.log('=== 6. Endpoint lain ikut terlindungi ===');

  // Dipasang dengan app.use('/api'), jadi route yang ditambahkan nanti ikut
  // tanpa perlu mengingat. 404 di dalam /api harus ikut 401 kalau tanpa kunci.
  r = await minta('/api/tidak-ada', {});
  await settle();
  eq('route tidak dikenal tanpa kunci = 401, bukan 404', r.status, 401);

  r = await minta('/api/tidak-ada', AUTH(tokenAktif));
  await settle();
  eq('route tidak dikenal dengan kunci = 404', r.status, 404);
  const e6 = tertangkap[tertangkap.length - 1];
  eq('404 tetap tercatat di access_log', e6.result, 'error');

  // -------------------------------------------------------------------------
  console.log('=== 7. Kuota tetap diterapkan pada jalur publik ===');

  // `/api/sasaran` masuk daftar JALUR_PUBLIK, jadi kunci di sini sengaja TIDAK
  // dikirim: yang diuji adalah bahwa jalur publik tidak lolos dari penghitungan
  // kuota. Identitasnya jatuh ke '' (tak terverifikasi), dan itulah basis
  // kuncinya -- bukan token yang bisa diganti-ganti untuk mendapat jatah baru.
  const r1 = await minta('/api/sasaran', {});
  const r2 = await minta('/api/sasaran', {});
  await settle();
  const rem1 = Number(r1.headers['ratelimit-remaining']);
  const rem2 = Number(r2.headers['ratelimit-remaining']);
  eq('jalur publik bukan 429', r1.status, 200);
  ok('sisa kuota berkurang pada permintaan kedua', rem2 < rem1);
  ok('sisa kuota dihitung dari agency_id, bukan token',
    app.kunciKuota({ agencyId: 42, terverifikasi: true }) === 'id-42');
  ok('mode legacy tetap memakai isi header apa adanya',
    app.kunciKuota({ agencyId: 'ag-1', terverifikasi: false }) === 'ag-1');

  // -------------------------------------------------------------------------
  console.log('=== 8. Mode legacy ===');

  // Tanpa setCariKunci, header dibaca apa adanya. Perilaku lama harus tetap
  // jalan, karenaseluruh server harus bisa dijalankan sebelum F1.8a.
  app.setCariKunci(null);
  tertangkap = [];
  const rLegacy = await minta('/api/audit/status', { 'x-agency-id': 'ag-legacy' });
  await settle();
  eq('mode legacy tetap memakai header', rLegacy.status, 200);
  const e7 = tertangkap[tertangkap.length - 1];
  // actor_id null di mode legacy: header berisi string, sedangkan kolomnya
  // BIGINT. Kalau dipaksa jadi angka, "ag-legacy" jadi NaN atau 0 -- keduanya
  // lebih buruk daripada null, karena-null berarti "tidak diketahui", sedangkan
  // 0 berarti "instansi dengan id 0".
  eq('actor_id null di mode legacy', e7.actor_id, null);
  ok('peringatan legacy ada dan menyebut jangan dipakai di publik',
    app.PERINGATAN_LEGACY.indexOf('publik') > 0);
  ok('peringatan menyebut x-agency-id sebagai sumber tak tepercaya',
    app.PERINGATAN_LEGACY.indexOf('x-agency-id') > 0);
  ok('mode legacy tidak diam-diam: ada peringatan, bukan hanya kode diam',
    app.PERINGATAN_LEGACY.length > 0);

  app.setCariKunci(cariKunciUji);

  // -------------------------------------------------------------------------
  console.log('=== 9. Kontrak hash dengan penerbit ===');

  // Kalau hash di sini berbeda dari hash di CLI, gejalanya adalah 401 untuk
  // semua kunci yang yang baru diterbitkan -- terlihat seperti bug identitas.
  eq('hash lib cocok dengan hash CLI', auth.hashToken(tokenAktif.token), tokenAktif.hash);
  ok('baris uji ditemukan lewat hash yang sama',
    BARIS[auth.hashToken(tokenAktif.token)] !== undefined);
  ok('cariKunci dipanggil untuk token berbentuk benar', dipanggilCari > 0);

  // -------------------------------------------------------------------------
  console.log('=== 10. Jalur form publik tidak butuh kunci ===');

  // Sengaja memakai jalur yang SAMA dengan form TPK. Kalau daftar JALUR_PUBLIK
  // salah (mis. path tanpa metode, atau kecualian yang merembet ke route
  // tetangga), bagian inilah yang menangkapnya.
  tertangkap = [];
  r = await minta('/api/sasaran', {});
  await settle();
  eq('GET /api/sasaran terbuka tanpa kunci', r.status, 200);

  // Kecualian tidak boleh merembet: route lain di /api tetap tertutup.
  r = await minta('/api/audit/status', {});
  await settle();
  eq('GET /api/audit/status tetap 401 tanpa kunci', r.status, 401);

  // POST /api/submit juga publik. Yang diuji bukan cara menulis ke Sheets
  // (urusan test-submit.js), melainkan bahwa jalurnya tidak ditolak middleware.
  app.setSheets(() => ({
    spreadsheets: {
      values: {
        async get() { return { data: { values: [['No']] } }; },
        async update() { return { data: {} }; },
        async append() { return { data: { updates: { updatedRange: 'Sheet1!A2' } } }; },
      },
    },
  }));

  const payloadPublik = {
    nik: '3201010101800001', namaLengkap: 'Uji Publik',
    namaTPK: 'TPK Uji', peranTPK: 'Kader', namaDesa: 'Desa Uji',
    jenisSasaran: 'Catin', tanggalKunjungan: '31 Des 2024',
  };
  // Jalur form sukses menyentuh per-input audit (records+outbox). Uji ini tidak
  // bermaksud menulis database, jadi titik suntiknya dimatikan.
  app.setCatatFormAudit(null);
  r = await mintaPost('/api/submit', payloadPublik);
  await settle();
  eq('POST /api/submit terbuka tanpa kunci', r.status, 200);
  app.setSheets(null);

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