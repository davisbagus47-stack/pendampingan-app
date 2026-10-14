/**
 * Uji log akses (F3.9, FR-4.4, AT-14, F1.5).
 *
 * Yang diuji bukan "entri log punya isi yang benar" -- itu mudah, dan tidak
 * menarik. Yang diuji adalah dua klaim yang lebih besar dan lebih mudah gagal
 * tanpa disadari:
 *
 *   1. **Setiap** respons punya tepat satu entri. Tidak ada jalur keluar dari
 *      aplikasi yang bisa melewatkan pencatatan: bukan 404, bukan 429, bukan
 *      500, bukan penolakan kolom, bukan format asing, bukan permintaan yang
 *     uosa saat cuerposdiri.
 *   2. `result` selalu salah satu dari delapan nilai yang diizinkan CHECK
 *      constraint `access_log.result`. Nilai di luar itu akan ditolak database,
 *      jadi hasil akhirnya log hilang tepat pada kode yang paling penting.
 *
 * Bentuk entri dikunci ke nama kolom di `sql/001_schema.sql`. Kunci kolom
 * diambil dari berkas DDL, bukan ditulis ulang di sini: kalau nama kolomnya
 * berubah dan daftar di sini tidak, betulan ketahuan saat generator DDL
 * gagal, bukan setelah data masuk production.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const accessLog = require('../lib/access-log.js');
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

// ---------------------------------------------------------------------------
// Logger tangkap. Dipasang lewat `gantiAccessLogger`, jadi middleware aslinya
// tetap terpasang dan yang diuji tetap jalur HTTP sungguhan.
// ---------------------------------------------------------------------------
const tertangkap = [];
const logger = accessLog.buatLogger({ sink: (e) => { tertangkap.push(e); } });
app.gantiAccessLogger(logger);

/** Entri terakhir, atau null. */
function terakhir() {
  return tertangkap.length ? tertangkap[tertangkap.length - 1] : null;
}

function bersihkan() {
  tertangkap.length = 0;
}

const server = http.createServer(app);

function listening() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function tutup() {
  return new Promise((resolve) => server.close(() => resolve()));
}

function minta(port, pathUrl, headers, method, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: pathUrl,
        method: method || 'GET', headers: headers || {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function json(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

/** Nama kolom `access_log` yang wajib ada di setiap entri. */
const KOLOM_WAJIB = [
  'actor_type', 'actor_id', 'category', 'params', 'result', 'response_rows', 'ip', 'endpoint',
];

/**
 * Tunggu pencatatan selesai.
 *
 * Ini bukan jeda acak untuk menebak. Urutannya nyata: event `finish` di sisi
 * server dijadwalkan SETELAH respons diterima klien, jadi begitu `minta()`
 * resolve, entri log belum tentu ada. Tanpa jeda ini, jumlah assertion
 * bergantung pada penjadwalan event Node -- kadang hijau, kadang merah, tanpa
 * ada yang berubah di kodenya. Log yang sesekali hilang karena balapan adalah
 * tanda pengujian yang salah, bukan tanda sistem yang salah.
 */
function settle() {
  return new Promise((r) => setTimeout(r, 15));
}

async function main() {
  const port = await listening();

  // Identitas uji diberi kuota longgar, dan burst dimatikan sepenuhnya.
  //
  // Alasannya bukan hal yang subtlet: uji ini mengirim puluhan permintaan ke
  // server sungguhan dalam hitungan detik. Dengan burst bawaan 10/detik, hasil
  // ujinya bergantung pada kecepatan mesin -- di mesin yang sedang lambat
  // semua lolos, di mesin yang sedang cepat satu permintaan jadi 429 dan
  // assertion `success` gagal. Itu uji yang salah bentuk: yang diujinya
  // pencatatan log, bukan rate limit, tapi outcome-nya ditentukan limiter.
  //
  // Bagian 3 menguji rate limit dengan sengaja, memakai identitas sendiri dan
  // konfigurasi eksplisit, jadi mematikan burst di sini tidak mengurangi cakupan
  // apa pun.
  app.limiter.aturKonfigurasi('ag-uji-9', { kuota: 100000, jendelaMs: 60000, burst: 0 });
  const AG = { 'x-agency-id': 'ag-uji-9' };

  // Uji ini memakai identitas legacy (`x-agency-id`). Begitu `DATABASE_URL`
  // tersedia, index.js otomatis menyalakan verifikasi kunci API (F3.10a);
  // tanpa ini seluruh permintaan jadi 401 dan yang diuji bukan lagi log,
  // melainkan autentikasi (itu urusan test-auth-middleware). Matikan
  // pencarian kunci agar suite tetap menguji pencatatan log.
  app.setCariKunci(null);

  console.log('=== 1. Bentuk entri sesuai CHECK constraint di DDL ===');

  // Nama kolom diambil dari DDL. Kalau DDL berubah, daftar di sini ikut
  // gagal dan pesan ujinya menyebut kolom mana yang tidak lagi cocok.
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', '001_schema.sql'), 'utf8');
  const blokAccessLog = ddl.slice(ddl.indexOf('CREATE TABLE access_log'));
  // `id` dan `ts` sengaja tidak termasuk: keduanya diisi database
  // (BIGSERIAL dan DEFAULT now()), bukan oleh aplikasi. Menuntut keduanya di
  // sini akan membuat kode produksi mengirim timestamp sendiri -- dan itu
  // berarti jam aplikasi, yang bisa berbeda dari jam database.
  const KOLOM_ISI_DB = ['id', 'ts'];
  const kolomDdl = [];
  {
    const isi = blokAccessLog.slice(0, blokAccessLog.indexOf(');'));
    for (const baris of isi.split('\n')) {
      const m = baris.trim().match(/^([a-z_]+)\s+(BIGSERIAL|TIMESTAMPTZ|TEXT|BIGINT|JSONB|INTEGER|INET)/);
      if (m && KOLOM_ISI_DB.indexOf(m[1]) < 0) kolomDdl.push(m[1]);
    }
  }
  eq('kolom yang ditulis aplikasi cocok dengan DDL', kolomDdl, KOLOM_WAJIB);
  ok('id dan ts memang diisi database, bukan aplikasi',
    KOLOM_ISI_DB.every((k) => ddl.indexOf(k + ' ') > 0));

  bersihkan();
  await minta(port, '/api/sasaran?format=json', AG);
  await settle();
  eq('satu permintaan menghasilkan satu entri', tertangkap.length, 1);
  const e1 = terakhir();
  eq('kunci entri sama persis dengan kolom DDL', Object.keys(e1).sort(), KOLOM_WAJIB.slice().sort());

  console.log('\n=== 2. Setiap respons punya entri, apa pun hasilnya ===');

  // Daftar ini adalah inti FR-4.4. Tiap baris: permintaan yang dijalankan, dan
  // nilai `result` yang WAJIB muncul. Kalau ada jalur yang tidak menghasilkan
  // entri, jumlah entri tidak bertambah dan assertion berikutnya gagal.
  const KASUS = [
    { nama: 'sukses json', url: '/api/sasaran', hasil: 'success' },
    { nama: 'sukses csv', url: '/api/sasaran?format=csv', hasil: 'success' },
    { nama: 'sukses xlsx', url: '/api/sasaran?format=xlsx', hasil: 'success' },
    { nama: 'kolom terlarang', url: '/api/sasaran?fields=catatanTPK', hasil: 'denied_column' },
    // `FIELD_UNKNOWN` sengaja tidak dipetakan ke nilai tersendiri di
  // `PETA_KODE`: CHECK constraint tidak punya nilai untuk "nama kolom tidak
  // ada", jadi ia harus berakhir sebagai `error`. Kalau suatu saat ada nilai
  // khusus untuknya, tambahkan ke PETA_KODE dan ke CHECK constraint DDL
  // bersamaan -- kalau hanya salah satu, penulisan ke database akan gagal.
    { nama: 'kolom asing', url: '/api/sasaran?fields=kolomNgawur', hasil: 'error' },
    { nama: 'format asing', url: '/api/sasaran?format=pdf', hasil: 'invalid_format' },
    { nama: 'health check', url: '/', hasil: 'success' },
    { nama: 'rute tidak ada', url: '/tidak-ada', hasil: 'error' },
  ];

  for (const k of KASUS) {
    bersihkan();
    await minta(port, k.url, AG);
  await settle();
    eq(k.nama + ': tepat satu entri', tertangkap.length, 1);
    eq(k.nama + ': result=' + k.hasil, terakhir() && terakhir().result, k.hasil);
    ok(k.nama + ': result diizinkan CHECK constraint',
      accessLog.HASIL_IZIN.indexOf(terakhir().result) >= 0);
  }

  console.log('\n=== 3. Kuota habis tercatat sebagai rate_limited ===');

  // Kuota dicek lebih dulu, jadi 429 terjadi sebelum data disentuh. Entri
  // tetap harus ada: dari log inilah terlihat instansi mana yang sedang rakus.
  const appLimiter = app.limiter;
  appLimiter.reset();
  appLimiter.aturKonfigurasi('ag-limit', { kuota: 2, jendelaMs: 60000, burst: 0 });

  bersihkan();
  await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-limit' });
  await settle();
  await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-limit' });
  await settle();
  eq('dua permintaan pertama lolos', tertangkap.filter((e) => e.result === 'success').length, 2);
  await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-limit' });
  await settle();
  const eLimit = terakhir();
  eq('permintaan ketiga tercatat', tertangkap.length, 3);
  eq('hasilnya rate_limited', eLimit.result, 'rate_limited');
  eq('kode yang sama dengan yang dibaca klien', json((await minta(port, '/api/sasaran', { 'x-agency-id': 'ag-limit' })).body).code, 'RATE_LIMITED');
  await settle();
  appLimiter.reset();

  console.log('\n=== 4. Metadata yang hanya diketahui route masuk log ===');

  // FR-4.8: format yang dipakai wajib tercatat. Tanpa ini, hasil CSV dan XLSX
  // bisa memuat kolom yang tidak pernah terlihat di JSON dan tidak ada yang
  // bisa merekonstruksinya dari log.
  bersihkan();
  await minta(port, '/api/sasaran?format=csv', AG);
  await settle();
  eq('format tercatat di params', terakhir().params.format, 'csv');

  bersihkan();
  await minta(port, '/api/sasaran?fields=nik,usia&kategori_1=Ibu%20Hamil&limit=5', AG);
  await settle();
  const eParam = terakhir();
  eq('fields yang diminta tercatat', eParam.params.fields, ['nik', 'usia']);
  eq('kategori tercatat', eParam.params.kategori_1, 'Ibu Hamil');
  eq('limit tercatat', eParam.params.limit, '5');

  // Parameter tak dikenal tidak boleh ikut masuk. `params` dibaca auditor;
  // log yang memuat apa pun yang kebetulan dikirim klien berubah dari bukti
  // jadi tempat kebocoran.
  bersihkan();
  await minta(port, '/api/sasaran?format=json&apikey=rahasia', AG);
  await settle();
  ok('parameter tak dikenal tidak ikut masuk params',
    !Object.prototype.hasOwnProperty.call(terakhir().params, 'apikey'));

  console.log('\n=== 5. Jumlah baris hasil tercatat ===');

  // Tanpa response_rows, log tidak bisa menjawab "berapa data yang instansi
  // ini tarik", yang justru pertanyaan paling sering ditanya saat audit.
  bersihkan();
  await minta(port, '/api/sasaran', AG);
  await settle();
  const eRows = terakhir();
  ok('response_rows adalah angka', typeof eRows.response_rows === 'number' && Number.isFinite(eRows.response_rows));
  ok('response_rows bukan negatif', eRows.response_rows >= 0);

  console.log('\n=== 6. Penolakan kolom terlarang: kode di log sama dengan di respons ===');

  // Dua bentuk harus sama persis. Kalau diterjemahkan dua kali, keduanya bisa
  // berbeda dan log jadi tidak bisa dipercaya sebagai bukti.
  bersihkan();
  const tolak = await minta(port, '/api/sasaran?fields=catatanTPK', AG);
  await settle();
  const kodeRespons = json(tolak.body).code;
  eq('responsnya 403', tolak.status, 403);
  eq('kode Field_NOT_GRANTED', kodeRespons, 'FIELD_NOT_GRANTED');
  eq('result di log = denied_column', terakhir().result, 'denied_column');
  ok('kolom yang ditolak tercatat di params',
    Array.isArray(terakhir().params.fields) && terakhir().params.fields.indexOf('catatanTPK') >= 0);

  console.log('\n=== 7. Klien yang tidak dipercaya tidak bisa memperbesar params ===');

  // `fields` datang dari klien dan tidak dipercaya. Tanpa batas panjang, satu
  // permintaan dengan ribuan nama kolom menulis baris log raksasa -- dan itu
  // cara termurah untuk membuat access_log tidak berguna.
  bersihkan();
  const banyak = Array.from({ length: 500 }, (_, i) => 'kolom' + i).join(',');
  await minta(port, '/api/sasaran?format=json&fields=' + encodeURIComponent(banyak), AG);
  await settle();
  const eBesar = terakhir();
  const nFields = Array.isArray(eBesar.params.fields) ? eBesar.params.fields.length : 0;
  ok('daftar fields dipangkas, tidak disimpan utuh', nFields <= accessLog.HASIL_IZIN.length + 1 || nFields <= 41,
    'dapat ' + nFields);
  ok('entri tetap terbentuk walau params dibesarkan', eBesar && typeof eBesar.result === 'string');

  console.log('\n=== 8. ip dan endpoint selalu terisi atau null ===');

  // Kolomnya `INET` dan `NOT NULL`. String yang tidak berbentuk IP akan ditolak
  // database dan menggagalkan pencatatan, jadi nilai buruk harus jadi null.
  bersihkan();
  await minta(port, '/api/sasaran', AG);
  await settle();
  const eIp = terakhir();
  ok('ip berupa string atau null', eIp.ip === null || typeof eIp.ip === 'string');
  eq('endpoint tercatat tanpa query string', eIp.endpoint, '/api/sasaran');

  eq('ip junk ditolak jadi null', accessLog.ipBersih('bukan-ip'), null);
  eq('ip ipv4 valid diterima', accessLog.ipBersih('127.0.0.1'), '127.0.0.1');
  eq('ip ipv4 di luar rentang ditolak', accessLog.ipBersih('999.1.1.1'), null);
  eq('ip kosong jadi null', accessLog.ipBersih(''), null);
  eq('ip dengan SQL ditolak', accessLog.ipBersih("127.0.0.1'; DROP TABLE access_log; --"), null);

  console.log('\n=== 9. Kegagalan menulis tidak menjatuhkan permintaan ===');

  // Log akses yang bisa menjatuhkan API adalah vektor penolakan layanan yang
  // dibuat sendiri. Sink yang gagal harus dihitung dan dilaporkan, tapi respons
  // tetap terkirim dan proses tetap hidup.
  const reported = [];
  const loggerGagal = accessLog.buatLogger({
    sink: () => { throw new Error('database tidak ada'); },
    pelapor: (e) => reported.push(e.message),
  });
  app.gantiAccessLogger(loggerGagal);
  bersihkan();
  const tetap = await minta(port, '/api/sasaran', AG);
  await settle();
  eq('permintaan tetap 200 walau sink gagal', tetap.status, 200);
  eq('kegagalan dilaporkan', reported.length > 0, true);
  eq('kegagalan dihitung', loggerGagal.gagal(), 1);

  // Janji async juga harus tertangani: sink yang mengembalikan Promise yang
  // reject adalah bentuk paling umum dari kegagalan database.
  //
  // Perilakunya berubah pada 2026-10-06 (keputusan fail-open yang terukur):
  // kegagalan async TIDAK langsung dihitung sebagai hilang. Ia ditahan di
  // antrean dan dicoba ulang, karena koneksi database yang putus sesaat adalah
  // hal biasa dan berbeda dari database yang mati. Menghitungnya langsung akan
  // membuat angka `gagal` berisik pada setiap blip jaringan.
  const loggerAsync = accessLog.buatLogger({
    sink: () => Promise.reject(new Error('connection refused')),
    pelapor: () => {},
  });
  app.gantiAccessLogger(loggerAsync);
  const tetap2 = await minta(port, '/api/sasaran', AG);
  await settle();
  eq('permintaan tetap 200 walau sink async gagal', tetap2.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  eq('kegagalan async ditahan dulu, belum dihitung hilang', loggerAsync.gagal(), 0);
  eq('entri masih menunggu di antrean', loggerAsync.status().tertahan, 1);
  eq('respons tetap tidak terpengaruh', tetap2.status, 200);

  // Batas percobaan: tanpa ini, sink yang mati permanen membuat antrean tumbuh
  // tanpa henti sampai memori habis -- kegagalan logging berubah jadi crash.
  const loggerPutus = accessLog.buatLogger({
    sink: () => Promise.reject(new Error('mati total')),
    pelapor: () => {},
    maksCoba: 1,
  });
  app.gantiAccessLogger(loggerPutus);
  await minta(port, '/api/sasaran', AG);
  await settle();
  await new Promise((r) => setTimeout(r, 300));
  eq('percobaan berhenti pada batas', loggerPutus.gagal(), 1);
  eq('entri dihitung sebagai dibuang, bukan tertahan', loggerPutus.status().dibuang, 1);
  eq('antrean tidak lagi menumpuk', loggerPutus.status().tertahan, 0);
  eq('penyebabnya tercatat untuk pemantauan',
    loggerPutus.status().terakhir_gagal.pesan.indexOf('mati total') >= 0, true);

  // Skenario terpenting: sink pulih sendiri tanpa request baru. Tanpa flush
  // terjadwal, entri yang tertahan hanya keluar kalau ada permintaan berikut --
  // dan pada malam hari lalu lintas bisa nol selama berjam-jam.
  const pulih = [];
  let percobaanPulih = 0;
  const loggerPulih = accessLog.buatLogger({
    sink: (e) => {
      percobaanPulih++;
      if (percobaanPulih < 3) return Promise.reject(new Error('blip'));
      pulih.push(e.endpoint);
      return undefined;
    },
    pelapor: () => {},
  });
  app.gantiAccessLogger(loggerPulih);
  await minta(port, '/api/sasaran', AG);
  await settle();
  // Tidak ada request lain setelah ini.
  await new Promise((r) => setTimeout(r, 900));
  eq('entri terselamatkan sendiri setelah sink pulih', pulih.length, 1);
  eq('tidak ada yang hilang', loggerPulih.status().dibuang, 0);
  eq('antrean bersih setelah pulih', loggerPulih.status().tertahan, 0);
  eq('tidak dihitung gagal karena akhirnya berhasil', loggerPulih.gagal(), 0);
  ok('dicoba ulang tanpa bantuan request baru', percobaanPulih >= 3,
    'dapat ' + percobaanPulih);

  // Sink yang kembalikan non-Promise tidak boleh dianggap gagal.
  const loggerSync = accessLog.buatLogger({ sink: () => undefined });
  app.gantiAccessLogger(loggerSync);
  await minta(port, '/api/sasaran', AG);
  await settle();
  eq('sink yang sinkron tidak dianggap gagal', loggerSync.gagal(), 0);
  eq('tetap dihitung sebagai entri', loggerSync.jumlah(), 1);
  eq('status sehat: tidak ada kegagalan',
    JSON.stringify(loggerSync.status().terakhir_gagal), 'null');

  console.log('\n=== 10.params tidak bisa membawa objek sembarang ===');

  // params kolomnya JSONB dan isinya dilihat auditor. Objek dari klien tidak
  // boleh ikut di-serialize, karena `toJSON` buatan klien bisa dipanggil.
  const jebakan = { toJSON() { return { bocor: 'data' }; } };
  const p = accessLog.paramsBersih({ a: {}, b: [], c: new Date(0), d: 'teks' });
  eq('obyek tidak ikut', p.a, '(tipe tidak dicatat)');
  eq('tanggal tidak ikut', p.c, '(tipe tidak dicatat)');
  eq('teks tetap ikut', p.d, 'teks');

  console.log('\n=== 11. Susun ulang logger tidak membuat route tanpa pelindung ===');

  // Logger bisa diganti saat proses berjalan, jadi yangacja-jaganya harus
  // tetap aman: kalau yang diganti bukan objek logger, entri hilang tapi
  // respons harus tetap terkirim.
  app.gantiAccessLogger({});
  const tamu = await minta(port, '/api/sasaran', AG);
  await settle();
  eq('respons tetap terkirim walau logger rusak', tamu.status, 200);

  // Pasang ulang logger yang benar.
  app.gantiAccessLogger(logger);

  console.log('\n=== 12. Logger tanpa sink tetap menghitung entri ===');

  // Untuk dipakai sebelum koneksi database ada: entri dihitung supaya bisa
  // dibandingkan, hanya tidak ditulis ke mana pun.
  const loggerKosong = accessLog.buatLogger({});
  loggerKosong.catat({ result: 'success' });
  eq('tetap dihitung', loggerKosong.jumlah(), 1);
  eq('tidak ada yang gagal', loggerKosong.gagal(), 0);
  eq('entri terakhir tersimpan', loggerKosong.terakhir().result, 'success');

  // Entri bukan objek harus dihitung sebagai kegagalan, bukan diabaikan
  // diam-diam -- kalau tidak, bug di route bisa menutupi dirinya sendiri.
  loggerKosong.catat(null);
  eq('entri bukan objek dihitung gagal', loggerKosong.gagal(), 1);

  console.log('\n=== 13. results yang tidak dikenal ditolak, bukan diterjemahkan diam-diam ===');

  // Kalau kode galat baru muncul, `hasilDari` harus jatuh ke `error` supaya
  // terlihat di log -- bukan diam-diam jadi `success`.
  eq('kode asing jatuh ke error', accessLog.hasilDari({ status: 500, kode: 'KODE_BARU' }), 'error');
  eq('tanpa kode, status 403 jadi denied_auth', accessLog.hasilDari({ status: 403 }), 'denied_auth');
  eq('tanpa kode, status 429 jadi rate_limited', accessLog.hasilDari({ status: 429 }), 'rate_limited');
  eq('status 2xx jadi success', accessLog.hasilDari({ status: 201 }), 'success');
  eq('kode mengalahkan status yang bertentangan',
    accessLog.hasilDari({ status: 403, kode: 'FIELD_NOT_GRANTED' }), 'denied_column');

  // Setiap kode yang dipetakan harus menuju nilai yang diizinkan DDL.
  for (const kode of Object.keys(accessLog.PETA_KODE)) {
    ok('kode ' + kode + ' memetakan ke nilai yang diizinkan',
      accessLog.HASIL_IZIN.indexOf(accessLog.PETA_KODE[kode]) >= 0);
  }

  console.log('\n=== 14. Klien tidak bisa mengubah prototipe objek lewat params ===');

  // Ini yang paling mudah dianggap gurauan sampai terjadi. `params` datang
  // dari query string, yang bisa memuat kunci `__proto__` -- dan karena
  // `paramsBersih` menulis ke objek `{}`, `out['__proto__'] = {...}` BUKAN
  // menambahkan properti. Ia mengganti prototipe objek itu sendiri.
  //
  // Kebanyakan exploit prototype pollution membawa payload OBJECT. Query string
  // tidak bisa mengirim object, hanya string. Tapi itu bukan alasan untuk
  // menulisnya: `nilaiBersih` mengembalikan string apa adanya, jadi prototipe
  // jadi berisi string, dan `Object.keys` tidak lagi melihat properti yang
  // diharapkan. Cukup untuk membuat entri log salah bentuk, dan suatu saat
  // jalan dipanggil lewat body JSON yang memang bisa membawa object.
  const js14 = (o) => JSON.stringify(o);
  const asli14 = Object.prototype.hasOwnProperty;
  const sebelum14 = js14(accessLog.paramsBersih({ a: '1' }));

  const bersih14 = accessLog.paramsBersih({ '__proto__': { evil: true }, aman: 'ya' });
  ok('kunci __proto__ dibuang',
    Object.keys(bersih14).indexOf('__proto__') < 0);
  eq('kunci biasa tetap ada', bersih14.aman, 'ya');
  ok('prototipe objek hasil tidak berubah',
    js14(accessLog.paramsBersih({ a: '1' })) === sebelum14);
  ok('Object.prototype tidak tersentuh',
    ({}).evil === undefined && asli14.call({}, 'evil') === false);

  // Dilakukan pada objek temporer -- cek bahwa pollution-nya sendiri tidak
  // membawa efek keluar dari fungsi.
  const ts14 = { x: 1 };
  accessLog.paramsBersih({ '__proto__': { tainted: 1 }, k: 'v' });
  ok('objek di luar fungsi tidak tercemar', ts14.tainted === undefined);

  // Pakai `Object.keys`, bukan `x.constructor`: objek `{}` tetap punya
  // `constructor` dari prototipe-nya, jadi memeriksa `hasil.constructor === undefined`
  // akan gagal meski kunci itu sudah dibuang.
  ok('constructor dibuang', Object.keys(accessLog.paramsBersih({ constructor: 'x' })).indexOf('constructor') < 0);
  ok('prototype dibuang', Object.keys(accessLog.paramsBersih({ prototype: 'x' })).indexOf('prototype') < 0);
  ok('kunci lain tetap terbaca sebagai properti biasa',
    Object.keys(accessLog.paramsBersih({ constructor: 'x', lain: 'ya' })).indexOf('lain') >= 0);

  console.log('\n=== 15. Kegagalan pencatatan terlihat, bukan tersembunyi ===');

  // Inilah bagian "jangan diam" dari keputusan fail-open (2026-10-06).
  // Karena penulisan terjadi setelah respons terkirim, gagal menulis tidak
  // bisa menjatuhkan permintaan. Tapi kalau kegagalannya juga tidak terlihat,
  // maka "permintaan sukses tapi tidak tercatat" dan "memang tidak pernah ada
  // permintaan" tampak identik -- dan klaim FR-4.4 tidak bisa diverifikasi.

  // 1. Sehat: tidak ada kegagalan.
  const loggerSehat = accessLog.buatLogger({ sink: () => undefined });
  app.gantiAccessLogger(loggerSehat);
  bersihkan();
  await minta(port, '/api/sasaran', AG);
  await settle();
  let st = await minta(port, '/api/audit/status', AG);
  let isi = JSON.parse(st.body);
  eq('endpoint status menjawab 200', st.status, 200);
  eq('sehat dilaporkan true', isi.sehat, true);
  eq('tidak ada catatan peringatan', isi.catatan, null);
  eq('dibuang nol', isi.log_akses.dibuang, 0);
  eq('gagal nol', isi.log_akses.gagal, 0);
  ok('ditulis terisi', isi.log_akses.ditulis >= 1, 'dapat ' + isi.log_akses.ditulis);

  // 2. Tidak sehat: sink menolak, entri hilang.
  const loggerHilang = accessLog.buatLogger({
    sink: () => { throw new Error('database hilang'); },
    pelapor: () => {},
    maksCoba: 1,
  });
  app.gantiAccessLogger(loggerHilang);
  bersihkan();
  await minta(port, '/api/sasaran', AG);
  await settle();
  st = await minta(port, '/api/audit/status', AG);
  isi = JSON.stringify(JSON.parse(st.body));
  ok('kegagalan terlihat dari status', isi.indexOf('"sehat":false') >= 0, isi.slice(0, 200));
  ok('jumlah entri hilang dilaporkan', isi.indexOf('"dibuang":1') >= 0, isi.slice(0, 200));
  ok('penyebabnya ikut tercatat', isi.indexOf('database hilang') >= 0);

  // 3. Yang paling penting: permintaan TETAP dilayani walau log hilang.
  //    Ini inti fail-open, dan gagal di sini berarti API ikut mati.
  eq('respons data tetap 200 meski log hilang', (await minta(port, '/api/sasaran', AG)).status, 200);

  // 4. Batas antrean: entri yang tertahan tidak boleh menumpuk tanpa batas.
  const loggerAntrean = accessLog.buatLogger({
    sink: () => Promise.reject(new Error('sink asinkron mati')),
    pelapor: () => {},
    kapasitasAntrean: 5,
    maksCoba: 50,
  });
  app.gantiAccessLogger(loggerAntrean);
  bersihkan();
  for (let i = 0; i < 12; i++) await minta(port, '/api/sasaran', AG);
  await settle();
  ok('antrean dibatasi, tidak menumpuk tanpa batas',
    loggerAntrean.status().tertahan <= 5, 'dapat ' + loggerAntrean.status().tertahan);
  ok('entri yang dibuang tetap dihitung',
    loggerAntrean.status().dibuang >= 1, 'dapat ' + loggerAntrean.status().dibuang);
  eq('jumlah ditulis mencerminkan semua permintaan',
    loggerAntrean.jumlah(), 12);

  await tutup();

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nADA YANG RUSAK. Jangan andalkan log akses sebelum ini hijau.');
    process.exit(1);
  } else {
    console.log('\nSEMUA UJI LOLOS');
  }
}

main().catch((e) => {
  console.error('Uji log akses gagal dijalankan:', e.message);
  server.close();
  process.exit(1);
});