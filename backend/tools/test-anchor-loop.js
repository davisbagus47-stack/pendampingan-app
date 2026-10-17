'use strict';

/**
 * Uji murni penjadwalan berkala anchor audit (`lib/anchor-loop.js`): parsing
 * argumen, pemilihan selang, dan orkestrasi loop TANPA database, TANPA
 * jaringan, dan TANPA timer sungguhan (tidur disuntik).
 *
 * Yang tidak dibuktikan di sini adalah perilaku `sekali()` sungguhan -- itu
 * dipakai apa adanya dari `tools/worker-audit-anchor.js` dan diuji di
 * `tools/test-audit-anchor-chain-live.js`.
 */

const path = require('path');
const al = require(path.join(__dirname, '..', 'lib', 'anchor-loop.js'));

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

async function main() {
  console.log('=== 1. bacaArgv ===');
  {
    eq('tanpa argumen', al.bacaArgv([]), { loop: false, intervalDetik: null, bantuan: false, offChain: false, galat: null });
    eq('--loop', al.bacaArgv(['--loop']).loop, true);
    eq('--interval terpisah', al.bacaArgv(['--interval', '30']).intervalDetik, 30);
    eq('--interval=seragam', al.bacaArgv(['--interval=45']).intervalDetik, 45);
    eq('-i terpisah', al.bacaArgv(['-i', '10']).intervalDetik, 10);
    eq('--help', al.bacaArgv(['--help']).bantuan, true);
    eq('-h', al.bacaArgv(['-h']).bantuan, true);
    eq('--loop + --interval', al.bacaArgv(['--loop', '--interval', '5']),
      { loop: true, intervalDetik: 5, bantuan: false, offChain: false, galat: null });
    eq('--off-chain', al.bacaArgv(['--off-chain']).offChain, true);
    eq('--off-chain + --loop', al.bacaArgv(['--off-chain', '--loop']),
      { loop: true, intervalDetik: null, bantuan: false, offChain: true, galat: null });

    const bad = al.bacaArgv(['--interval', 'abc']);
    ok('--interval abc -> galat', typeof bad.galat === 'string' && bad.galat.indexOf('abc') >= 0);
    eq('--interval abc -> null', bad.intervalDetik, null);
    ok('--interval 0 -> galat', !!al.bacaArgv(['--interval', '0']).galat);
    ok('--interval negatif -> galat', !!al.bacaArgv(['--interval', '-3']).galat);
    ok('--interval tanpa nilai -> galat', !!al.bacaArgv(['--interval']).galat);
    ok('argumen tak dikenal diabaikan', al.bacaArgv(['--berisik']).galat === null);
    eq('argv bukan array aman', al.bacaArgv(null), { loop: false, intervalDetik: null, bantuan: false, offChain: false, galat: null });
  }

  console.log('\n=== 2. selangMs ===');
  {
    eq('bawaan', al.selangMs(null, {}), al.SELANG_BAWAAN_MS);
    eq('argumen menang', al.selangMs(30, {}), 30000);
    eq('env dipakai bila argumen kosong', al.selangMs(null, { ANCHOR_INTERVAL: '5' }), 5000);
    eq('argumen mengalahkan env', al.selangMs(30, { ANCHOR_INTERVAL: '5' }), 30000);
    eq('dijepit ke minimum', al.selangMs(0.5, {}), al.SELANG_MIN_MS);
    eq('env tak sah -> bawaan', al.selangMs(null, { ANCHOR_INTERVAL: 'xyz' }), al.SELANG_BAWAAN_MS);
    eq('env 0 -> bawaan', al.selangMs(null, { ANCHOR_INTERVAL: '0' }), al.SELANG_BAWAAN_MS);
    eq('env kosong -> bawaan', al.selangMs(null, { ANCHOR_INTERVAL: '' }), al.SELANG_BAWAAN_MS);
  }

  console.log('\n=== 3. jalankan: jumlah pass & panggilan tidur ===');
  {
    let calls = 0;
    const tidurMs = [];
    const logs = [];
    const r = await al.jalankan({
      sekaliFn: async () => { calls++; return { dilewati: false, jumlah_entri: calls }; },
      maksPass: 3,
      selangMs: 7,
      tidur: (ms) => { tidurMs.push(ms); return Promise.resolve(); },
      log: (x) => { logs.push(x); },
    });
    eq('pass', r.pass, 3);
    eq('lulus', r.lulus, 3);
    eq('galat', r.galat, 0);
    eq('sekaliFn dipanggil 3x', calls, 3);
    eq('tidur antar-pass saja (2x)', tidurMs, [7, 7]);
    eq('log tiap pass', logs.length, 3);
    eq('terakhir = pass terakhir', r.terakhir.jumlah_entri, 3);
    ok('log tanpa galat', logs.every((x) => x.galat === null));
  }

  console.log('\n=== 4. jalankan: berhenti menghentikan loop ===');
  {
    let n = 0;
    const r = await al.jalankan({
      sekaliFn: async () => { n++; return {}; },
      maksPass: 10,
      berhenti: () => n >= 2,
      tidur: () => Promise.resolve(),
    });
    eq('berhenti setelah 2 pass', r.pass, 2);
    eq('lulus 2', r.lulus, 2);
  }

  console.log('\n=== 5. jalankan: galat dicatat, loop lanjut ===');
  {
    let c = 0;
    const logs = [];
    const r = await al.jalankan({
      sekaliFn: async () => { c++; if (c === 2) throw new Error('boom'); return {}; },
      maksPass: 3,
      tidur: () => Promise.resolve(),
      log: (x) => { logs.push(x); },
    });
    eq('pass tetap 3', r.pass, 3);
    eq('lulus', r.lulus, 2);
    eq('galat', r.galat, 1);
    eq('galat tercatat', logs[1].galat, 'boom');
    eq('hasil null pada galat', logs[1].hasil, null);
  }

  console.log('\n=== 6. jalankan: sekaliFn wajib ===');
  {
    let err = null;
    try { await al.jalankan({}); } catch (e) { err = e && e.message; }
    ok('tanpa sekaliFn -> melempar', !!err && err.indexOf('sekaliFn') >= 0);
  }

  console.log('\n=== 7. teksBantuan ===');
  {
    ok('memuat judul Penggunaan', al.teksBantuan().indexOf('Penggunaan') >= 0);
    ok('menyebut --loop', al.teksBantuan().indexOf('--loop') >= 0);
    ok('menyebut --off-chain', al.teksBantuan().indexOf('--off-chain') >= 0);
  }

  console.log('\nRegresi: ' + passed + ' lulus, ' + failed + ' gagal.');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('uji gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
