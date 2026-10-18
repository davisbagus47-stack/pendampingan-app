/**
 * Uji endpoint cron penyapu outbox `GET /api/cron/anchor`.
 *
 * Endpoint ini menyiarkan transaksi berbayar, jadi yang paling penting diuji
 * adalah KENDALI AKSES-nya:
 *   - CRON_SECRET belum diset  -> 503 (endpoint mati, tidak terbuka)
 *   - token salah / tidak ada  -> 401
 *   - token benar              -> 200, menjalankan satu pass penyapu
 *
 * Penyapu ditukar dengan stub (`setSapuAnchor`) supaya uji ini tidak menyentuh
 * database maupun blockchain. DATABASE_URL sementara diisi nilai dummy: handler
 * hanya memeriksa keberadaannya sebagai pagar, dan stub tidak pernah memakainya.
 */

const http = require('http');
const app = require('../index.js');
const accessLog = require('../lib/access-log.js');

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

const server = http.createServer(app);
let port = 0;

function minta(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/cron/anchor', method: 'GET',
      headers: headers || {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let isi = null;
        try { isi = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, body: isi, teks: b });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const envAsli = {
    CRON_SECRET: process.env.CRON_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    ANCHOR_CRON_BATCH: process.env.ANCHOR_CRON_BATCH,
  };
  const pulihkan = () => {
    for (const k of Object.keys(envAsli)) {
      if (envAsli[k] === undefined) delete process.env[k];
      else process.env[k] = envAsli[k];
    }
    app.setSapuAnchor(null);
  };

  // Matikan sink DB access_log: uji ini bukan soal log, dan jangan menulis
  // ke Supabase hanya karena DATABASE_URL ada di .env.
  app.gantiAccessLogger(accessLog.buatLogger({ sink: () => {} }));

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  try {
    // ---------------------------------------------------------------------
    console.log('=== 1. CRON_SECRET belum diset: endpoint mati (503) ===');
    delete process.env.CRON_SECRET;
    process.env.DATABASE_URL = 'postgres://uji-bukan-nyata';
    let st = await minta({});
    eq('status 503', st.status, 503);
    ok('pesan menyebut CRON_SECRET', /CRON_SECRET/.test((st.body && st.body.message) || ''));

    // ---------------------------------------------------------------------
    console.log('\n=== 2. CRON_SECRET diset, token salah/kosong: 401 ===');
    process.env.CRON_SECRET = 'rahasia-uji';
    st = await minta({});
    eq('tanpa header: 401', st.status, 401);
    st = await minta({ authorization: 'Bearer salah' });
    eq('token salah: 401', st.status, 401);
    st = await minta({ authorization: 'rahasia-uji' });
    eq('tanpa skema Bearer: 401', st.status, 401);

    // ---------------------------------------------------------------------
    console.log('\n=== 3. token benar: 200, satu pass penyapu (batch bawaan 5) ===');
    let dipanggil = [];
    app.setSapuAnchor(async (batas) => {
      dipanggil.push(batas);
      return { dibaca: 1, anchored: 1, retry: 0, failed: 0, diabaikan: 0, galat: 0, rincian: [] };
    });
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('status 200', st.status, 200);
    eq('batch bawaan', st.body && st.body.batas, 5);
    eq('ringkasan diteruskan', st.body && st.body.ringkasan && st.body.ringkasan.anchored, 1);
    eq('penyapu dipanggil sekali', dipanggil.length, 1);
    eq('penyapu menerima batas', dipanggil[0], 5);

    // ---------------------------------------------------------------------
    console.log('\n=== 4. ANCHOR_CRON_BATCH dihormati dan dijepit ===');
    process.env.ANCHOR_CRON_BATCH = '3';
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('batch dari env', st.body && st.body.batas, 3);
    process.env.ANCHOR_CRON_BATCH = '9999';
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('batch dijepit ke 50', st.body && st.body.batas, 50);
    process.env.ANCHOR_CRON_BATCH = '0';
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('batch 0 jatuh ke bawaan 5', st.body && st.body.batas, 5);
    delete process.env.ANCHOR_CRON_BATCH;

    // ---------------------------------------------------------------------
    console.log('\n=== 5. penyapu tak terpasang: ringkasan kosong, bukan galat ===');
    app.setSapuAnchor(null);
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('status 200', st.status, 200);
    eq('ringkasan kosong', st.body && st.body.ringkasan && st.body.ringkasan.dibaca, 0);

    // ---------------------------------------------------------------------
    console.log('\n=== 6. penyapu melempar: 500 dengan pesan ===');
    app.setSapuAnchor(async () => { throw new Error('rpc mati'); });
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('status 500', st.status, 500);
    ok('pesan memuat sebab', /rpc mati/.test((st.body && st.body.message) || ''));

    // ---------------------------------------------------------------------
    console.log('\n=== 7. DATABASE_URL kosong: 503 (pagar DB) ===');
    delete process.env.DATABASE_URL;
    app.setSapuAnchor(async () => ({ dibaca: 0 }));
    st = await minta({ authorization: 'Bearer rahasia-uji' });
    eq('status 503', st.status, 503);
    ok('pesan menyebut DATABASE_URL', /DATABASE_URL/.test((st.body && st.body.message) || ''));
  } finally {
    pulihkan();
    server.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log('lulus: ' + lulus + '   gagal: ' + gagal);
  if (gagal > 0) { console.log('\nUJI CRON RUSAK.'); process.exit(1); }
  console.log('SEMUA UJI LOLOS');
}

main().catch((e) => {
  console.error('uji cron gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
