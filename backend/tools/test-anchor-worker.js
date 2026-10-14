'use strict';

/**
 * Uji murni F3.4 (anchor worker): backoff, mesin status, dan keserakahan
 * pemilihan TANPA database dan TANPA blockchain.
 *
 * `tools/worker-anchor.js` memakai logika ini; yang tidak bisa dibuktikan di
 * sini adalah perilaku PostgreSQL (klaim SKIP LOCKED, penjaga UPDATE) dan
 * jawaban contract sungguhan -- keduanya di-suntik dan dibuktikan di
 * `tools/test-anchor-worker-live.js`.
 */

const path = require('path');
const aw = require(path.join(__dirname, '..', 'lib', 'anchor-worker.js'));

let passed = 0;
let failed = 0;

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + '   dapat=' + a + '  diharapkan=' + b);
  }
}

console.log('=== 1. Backoff (keputusan F3.4) ===');
{
  eq('coba 1 = TUNDA_AWAL', aw.hitungTunda(1), aw.BAWAAN.TUNDA_AWAL);
  eq('coba 2 = 2x (eksponensial)', aw.hitungTunda(2), aw.BAWAAN.TUNDA_AWAL * 2);
  eq('coba 3 = 4x', aw.hitungTunda(3), aw.BAWAAN.TUNDA_AWAL * 4);
  eq('terpotong di TUNDA_MAKS', aw.hitungTunda(10), aw.BAWAAN.TUNDA_MAKS);
  eq('coba 0 diperlakukan 1', aw.hitungTunda(0), aw.BAWAAN.TUNDA_AWAL);
  eq('aturan kustom', aw.hitungTunda(3, { TUNDA_AWAL: 100, GANDA: 3, TUNDA_MAKS: 1000 }), 900);
  eq('aturan kustom terpotong', aw.hitungTunda(5, { TUNDA_AWAL: 100, GANDA: 3, TUNDA_MAKS: 1000 }), 1000);
  eq('aturan rusak memakai bawaan', aw.hitungTunda(2, { TUNDA_AWAL: 'x' }), aw.BAWAAN.TUNDA_AWAL * 2);
}

console.log('\n=== 2. pantasDiproses (klaim) ===');
{
  const NOW = 1_700_000_000_000;
  ok('pending tanpa jadwal = pantas', aw.pantasDiproses({ chain_status: 'pending', next_retry_at: null }, NOW));
  ok('pending jadwal lewat = pantas', aw.pantasDiproses({ chain_status: 'pending', next_retry_at: NOW - 1 }, NOW));
  ok('pending jadwal belum = tidak', !aw.pantasDiproses({ chain_status: 'pending', next_retry_at: NOW + 1 }, NOW));
  ok('pending jadwal sama = pantas', aw.pantasDiproses({ chain_status: 'pending', next_retry_at: NOW }, NOW));
  ok('anchored = tidak', !aw.pantasDiproses({ chain_status: 'anchored', next_retry_at: NOW - 1 }, NOW));
  ok('failed = tidak (terminal)', !aw.pantasDiproses({ chain_status: 'failed', next_retry_at: NOW - 1 }, NOW));
  ok('skipped = tidak', !aw.pantasDiproses({ chain_status: 'skipped', next_retry_at: NOW - 1 }, NOW));
  ok('tanpa baris = tidak', !aw.pantasDiproses(null, NOW));
}

console.log('\n=== 3. putuskan: sukses ===');
{
  const NOW = 1_700_000_000_000;
  const r = aw.putuskan(
    { chain_status: 'pending', attempts: 0, next_retry_at: null, last_error: 'lama' },
    { ok: true, tx_hash: '0xabc' },
    { now: NOW }
  );
  eq('putusan', r.putusan, 'anchored');
  eq('chain_status', r.kolom.chain_status, 'anchored');
  eq('tx_hash', r.kolom.tx_hash, '0xabc');
  eq('anchored_at', r.kolom.anchored_at, new Date(NOW).toISOString());
  eq('next_retry_at dikosongkan', r.kolom.next_retry_at, null);
  eq('last_error dibersihkan', r.kolom.last_error, null);
  eq('attempts tetap', r.kolom.attempts, 0);
  ok('tx_hash kepanjangan dipotong', aw.putuskan(
    { chain_status: 'pending', attempts: 0 },
    { ok: true, tx_hash: 'x'.repeat(500) },
    { now: NOW }
  ).kolom.tx_hash.length === 256);
}

console.log('\n=== 4. putuskan: sukses tanpa tx_hash = cacat, jadi retry ===');
{
  const NOW = 1_700_000_000_000;
  const r = aw.putuskan({ chain_status: 'pending', attempts: 2 }, { ok: true }, { now: NOW });
  eq('putusan', r.putusan, 'retry');
  eq('tetap pending', r.kolom.chain_status, 'pending');
  eq('attempts naik', r.kolom.attempts, 3);
  ok('last_error menjelaskan', r.kolom.last_error.indexOf('tx_hash') >= 0);
  ok('next_retry_at terisi', typeof r.kolom.next_retry_at === 'string');
}

console.log('\n=== 5. putuskan: gagal -> retry sampai MAKS_CUBA ===');
{
  const NOW = 1_700_000_000_000;
  const MAKS = 3;
  const aturan = { MAKS_CUBA: MAKS, TUNDA_AWAL: 1000, GANDA: 2, TUNDA_MAKS: 100000 };

  let baris = { chain_status: 'pending', attempts: 0, next_retry_at: null };
  const catat = [];
  for (let i = 1; i <= MAKS; i++) {
    const r = aw.putuskan(baris, { ok: false, error: 'RPC mati' }, { now: NOW, aturan });
    catat.push({ i, putusan: r.putusan, attempts: r.kolom.attempts, status: r.kolom.chain_status, retry: r.kolom.next_retry_at });
    baris = { chain_status: r.kolom.chain_status, attempts: r.kolom.attempts, next_retry_at: r.kolom.next_retry_at };
  }

  eq('coba 1 -> retry', catat[0].putusan, 'retry');
  eq('coba 2 -> retry', catat[1].putusan, 'retry');
  eq('coba 3 = MAKS -> failed', catat[2].putusan, 'failed');
  eq('status tetap pending selama retry', [catat[0].status, catat[1].status], ['pending', 'pending']);
  eq('status akhir failed', catat[2].status, 'failed');
  ok('coba 1 jadwal = now + 1000', catat[0].retry === new Date(NOW + 1000).toISOString());
  ok('coba 2 jadwal = now + 2000', catat[1].retry === new Date(NOW + 2000).toISOString());
  eq('failed next_retry_at NULL', catat[2].retry, null);

  const terakhir = aw.putuskan(
    { chain_status: 'failed', attempts: MAKS, next_retry_at: null },
    { ok: true, tx_hash: '0x' },
    { now: NOW, aturan }
  );
  eq('baris failed tidak diproses lagi', terakhir.putusan, 'diabaikan');
  eq('kolom null untuk diabaikan', terakhir.kolom, null);
}

console.log('\n=== 6. putuskan: kegagalan tanpa pesan ===');
{
  const r = aw.putuskan(
    { chain_status: 'pending', attempts: 0 },
    { ok: false },
    { now: 1_700_000_000_000, aturan: { MAKS_CUBA: 3, TUNDA_AWAL: 1, GANDA: 1, TUNDA_MAKS: 1 } }
  );
  eq('putusan retry', r.putusan, 'retry');
  eq('pesan bawaan', r.kolom.last_error, 'anchor gagal');
}

console.log('\n=== 7. last_error dipotong ===');
{
  const panjang = 1200;
  const r = aw.putuskan(
    { chain_status: 'pending', attempts: 0 },
    { ok: false, error: 'x'.repeat(panjang) },
    { now: 1_700_000_000_000, aturan: { MAKS_CUBA: 3, TUNDA_AWAL: 1, GANDA: 1, TUNDA_MAKS: 1 } }
  );
  ok('dipotong ke LAST_ERROR_MAKS', r.kolom.last_error.length === 500);
}

console.log('\n=== 8. aturanDari: nilai rusak memakai bawaan ===');
{
  const a = aw.aturanDari(null);
  eq('bawaan MAKS_CUBA', a.MAKS_CUBA, aw.BAWAAN.MAKS_CUBA);
  eq('bawaan TUNDA_AWAL', a.TUNDA_AWAL, aw.BAWAAN.TUNDA_AWAL);
  ok('aturanDari objek kosong = bawaan', aw.aturanDari({}).MAKS_CUBA === aw.BAWAAN.MAKS_CUBA);
  ok('aturanDari angka negatif = bawaan', aw.aturanDari({ MAKS_CUBA: -5 }).MAKS_CUBA === aw.BAWAAN.MAKS_CUBA);
}

console.log('\nRegresi: ' + passed + ' lulus, ' + failed + ' gagal.');
if (failed > 0) process.exit(1);