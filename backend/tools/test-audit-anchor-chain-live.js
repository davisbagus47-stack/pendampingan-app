'use strict';

/**
 * Uji live E2E FR-7.4: anchor akar log audit -> jembatan chain -> kontrak
 * `DataAnchor` di anvil, dengan `audit_anchor` di PostgreSQL nyata.
 *
 * Rantai yang dibuktikan ujung-ke-ujung:
 *   access_log (nyata) -> worker-audit-anchor menghitung akar -> jembatan
 *   `buatPengirimAkarDariEnv` -> `DataAnchor.anchorAuditRoot` -> event
 *   `AuditRootAnchored` di anvil -> `audit_anchor.tx_hash` terisi.
 *
 * Yang hanya bisa dibuktikan di sini (bukan uji murni):
 *   1. Baris `audit_anchor` yang dibuat saat pengirim GAGAL (tx_hash NULL)
 *      dilengkapi on-chain oleh pass BERIKUTNYA tanpa menggandakan baris --
 *      ini jalur pemulihan untuk anchor yang dibuat sebelum kontrak ada.
 *   2. `tx_hash` yang tersimpan benar-benar ada di rantai, dari kontrak yang
 *      benar, dan event-nya membawa toSeq/root/headHash yang sama.
 *   3. Pass ulang saat akar belum berubah tidak mengirim transaksi baru
 *      (idempoten: hemat gas, tidak mengotori rantai).
 *   4. Kontrak menolak akar BERBEDA untuk toSeq yang sama (penjaga perubahan
 *      log) sementara akar yang sama boleh diulang.
 *
 * Kontrak seperti live test lain:
 *   - Tanpa `DATABASE_URL` atau tanpa artefak: DILEWATI exit 0 (bukan bukti).
 *   - Tidak meninggalkan data: baris access_log ber-watermark `uji-f7a-*` dan
 *     anchor baru dihapus di `finally` lewat koneksi owner.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

try { require('dotenv').config(); } catch (e) {}

const main = require(path.join(__dirname, '..', 'tools', 'worker-audit-anchor.js'));
const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

const ARTEFAK = path.join(__dirname, '..', '..', 'contracts', 'out', 'DataAnchor.sol', 'DataAnchor.json');
const PORT = Number(process.env.ANCHOR_AUDIT_LIVE_PORT || 8550);
const RPC = 'http://127.0.0.1:' + PORT;
const KUNCI = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ALAMAT_ANVIL = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let passed = 0;
let failed = 0;

function ok(nama, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

function eq(nama, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + nama); }
  else {
    failed++;
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

function cariAnvil() {
  const kandidat = [];
  if (process.env.ANVIL_BIN) kandidat.push(process.env.ANVIL_BIN);
  const home = os.homedir();
  kandidat.push(path.join(home, '.foundry', 'bin', 'anvil.exe'));
  kandidat.push(path.join(home, '.foundry', 'bin', 'anvil'));
  for (const k of kandidat) { if (fs.existsSync(k)) return k; }
  return 'anvil';
}

function tunggu(fn, batasMs, jedaMs) {
  const akhir = Date.now() + batasMs;
  return new Promise((resolve, reject) => {
    (function coba() {
      Promise.resolve().then(fn).then(resolve).catch((e) => {
        if (Date.now() > akhir) reject(e);
        else setTimeout(coba, jedaMs || 250);
      });
    })();
  });
}

async function jalankan() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return 0;
  }
  if (!fs.existsSync(ARTEFAK)) {
    console.log('\nDLEWATI: artefak ' + path.relative(process.cwd(), ARTEFAK) + ' belum ada (jalankan `forge build`).');
    return 0;
  }

  const { Pool } = require('pg');
  const { JsonRpcProvider, Wallet, Contract, ContractFactory } = require('ethers');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const proc = spawn(cariAnvil(), ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const bersihkanAnvil = () => { try { proc.kill(); } catch (_) {} };
  process.on('exit', bersihkanAnvil);

  const tanda = 'uji-f7a-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const endpointAir = '/' + tanda;

  let anchorSebelum = [];
  let anchorSesudah = [];

  try {
    const provider = new JsonRpcProvider(RPC);
    await tunggu(async () => { await provider.getBlockNumber(); }, 20000, 250);

    const art = JSON.parse(fs.readFileSync(ARTEFAK, 'utf8'));
    const dompet = new Wallet(KUNCI, provider);
    const pabrik = new ContractFactory(art.abi, art.bytecode.object, dompet);
    const terpasang = await pabrik.deploy('0x0000000000000000000000000000000000000000');
    await terpasang.waitForDeployment();
    const alamat = await terpasang.getAddress();
    const kontrakBaca = new Contract(alamat, ac.ABI, provider);
    console.log('kontrak  : ' + alamat + ' @ ' + RPC + '\n');

    // --- seed access_log nyata (agar log tidak kosong) lewat koneksi owner
    const nilai = [];
    for (let i = 0; i < 4; i++) {
      nilai.push([
        'agency', 10 + i, 'Catin', JSON.stringify({ limit: 100 + i }),
        'success', 1, endpointAir,
      ]);
    }
    await utama.query(
      'INSERT INTO access_log (actor_type, actor_id, category, params, result, response_rows, endpoint)' +
      ' VALUES ' + nilai.map((_, i) =>
        '($' + (i * 7 + 1) + ',$' + (i * 7 + 2) + ',$' + (i * 7 + 3) + ',$' + (i * 7 + 4) + '::jsonb,' +
        '$' + (i * 7 + 5) + ',$' + (i * 7 + 6) + ',$' + (i * 7 + 7) + ')').join(', '),
      nilai.flat()
    );
    anchorSebelum = (await utama.query('SELECT id FROM audit_anchor')).rows.map((r) => String(r.id));

    // Worker memilih pengirim dari env (jalur CLI): arahkan ke anvil.
    process.env.ANCHOR_RPC_URL = RPC;
    process.env.ANCHOR_CONTRACT = alamat;
    process.env.ANCHOR_PRIVATE_KEY = KUNCI;

    console.log('=== 1. pengirim GAGAL -> baris dibuat, tx_hash NULL ===');
    const kirimGagal = async () => ({ ok: false, error: 'uji: RPC sengaja mati' });
    const r1 = await main.sekali({ kirimAkar: kirimGagal });
    eq('tidak dilewati', r1.dilewati, false, r1.alasan);
    ok('akar hex64', /^[0-9a-f]{64}$/.test(r1.anchor && r1.anchor.root), r1.anchor && r1.anchor.root);
    eq('tx_hash masih NULL', r1.anchor.tx_hash, null);
    eq('rantai ditandai tersedia', r1.rantai.tersedia, true);
    ok('galat rantai dilaporkan apa adanya', /RPC sengaja mati/.test(r1.rantai.error || ''), r1.rantai.error);
    const idAnchor = String(r1.anchor.id);
    const akar = '0x' + r1.anchor.root;
    const kepala = '0x' + r1.anchor.head_hash;
    const toSeq = Number(r1.anchor.to_seq);

    console.log('\n=== 2. pass berikutnya melengkapi on-chain (tanpa baris baru) ===');
    const kirimBaik = ac.buatPengirimAkarDariEnv(process.env);
    let jumlahKirim = 0;
    const terhitung = async (a) => { jumlahKirim++; return kirimBaik(a); };
    const r2 = await main.sekali({ kirimAkar: terhitung });
    eq('id baris tetap sama (tidak digandakan)', String(r2.anchor.id), idAnchor);
    ok('tx_hash terisi 0x64', /^0x[0-9a-f]{64}$/i.test(r2.anchor.tx_hash || ''), r2.anchor.tx_hash);
    eq('rantai.tx_hash sama dgn anchor', r2.rantai.tx_hash, r2.anchor.tx_hash);
    eq('kirim dipanggil sekali', jumlahKirim, 1);
    const txHash = r2.anchor.tx_hash;

    console.log('\n=== 3. tx_hash benar-benar ada di rantai + event benar ===');
    const receipt = await provider.getTransactionReceipt(txHash);
    ok('receipt ada', !!receipt);
    eq('status sukses', receipt && receipt.status, 1);
    eq('ditujukan ke kontrak', (receipt.to || '').toLowerCase(), alamat.toLowerCase());
    const log = (receipt.logs || []).map((l) => { try { return kontrakBaca.interface.parseLog(l); } catch (e) { return null; } })
      .find((p) => p && p.name === 'AuditRootAnchored');
    ok('event AuditRootAnchored ada', !!log);
    eq('event.toSeq', Number(log.args[0]), toSeq);
    eq('event.root', String(log.args[1]).toLowerCase(), akar.toLowerCase());
    eq('event.headHash', String(log.args[2]).toLowerCase(), kepala.toLowerCase());
    eq('event.writer = deployer', String(log.args[3]).toLowerCase(), ALAMAT_ANVIL.toLowerCase());

    console.log('\n=== 4. kontrak mengakui akar (isAuditRootAnchored) ===');
    eq('akar tercatat', await kontrakBaca.isAuditRootAnchored(toSeq, akar), true);
    eq('akar salah -> false', await kontrakBaca.isAuditRootAnchored(toSeq, '0x' + '55'.repeat(32)), false);

    console.log('\n=== 5. pass ulang saat akar tetap -> tanpa transaksi baru ===');
    const r3 = await main.sekali({ kirimAkar: terhitung });
    eq('dilewati', r3.dilewati, true);
    eq('id baris tetap', String(r3.anchor.id), idAnchor);
    eq('tx_hash tidak berubah', r3.anchor.tx_hash, txHash);
    eq('tidak ada kirim tambahan', jumlahKirim, 1);

    console.log('\n=== 6. penjaga kontrak: toSeq sama, akar berbeda ditolak ===');
    const kontrakTulis = new Contract(alamat, ac.ABI, dompet);
    const kepalaB = '0x' + '33'.repeat(32);
    let pesanTolak = '';
    let ditolak = false;
    try {
      await kontrakTulis.anchorAuditRoot.staticCall(toSeq, '0x' + '55'.repeat(32), kepalaB);
    } catch (e) { ditolak = true; pesanTolak = (e && (e.shortMessage || e.message)) || ''; }
    ok('akar berbeda untuk toSeq sama -> revert', ditolak);
    ok('pesan menyebut audit root mismatch', /audit root mismatch/.test(pesanTolak), pesanTolak);
    let diterima = false;
    try {
      await kontrakTulis.anchorAuditRoot.staticCall(toSeq, akar, kepala);
      diterima = true;
    } catch (e) { diterima = false; }
    ok('akar sama boleh diulang (idempoten)', diterima);

    anchorSesudah = (await utama.query('SELECT id FROM audit_anchor')).rows.map((r) => String(r.id));
  } finally {
    proc.kill();

    if (process.env.DATABASE_URL) {
      await utama.query('DELETE FROM access_log WHERE endpoint LIKE $1', [endpointAir + '%']).catch(() => {});
      const baru = anchorSesudah.filter((id) => !anchorSebelum.includes(id));
      if (baru.length) {
        await utama.query('DELETE FROM audit_anchor WHERE id = ANY($1::bigint[])', [baru]).catch(() => {});
      }
      const sisaLog = (await utama.query(
        'SELECT count(*)::int AS n FROM access_log WHERE endpoint LIKE $1', [endpointAir + '%']
      ).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
      console.log('\nbersih: ' + sisaLog + ' baris access_log sisa, ' + baru.length + ' anchor dihapus');
    }

    await utama.end().catch(() => {});
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exitCode = 1;
  return failed;
}

jalankan().then((n) => { if (n > 0) process.exitCode = 1; }).catch((e) => {
  console.error('uji live akar audit gagal: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
