'use strict';

/**
 * Uji live E2E: anchor worker (F3.4) -> jembatan chain (F2) -> kontrak
 * `DataAnchor` di anvil, dengan `chain_outbox` di PostgreSQL nyata.
 *
 * Ini ujian penutup sambungan: `tools/worker-anchor.js` memilih penanda
 * sungguhan SENDIRI dari variabel lingkungan (`ANCHOR_RPC_URL`,
 * `ANCHOR_CONTRACT`, `ANCHOR_PRIVATE_KEY`) -- tanpa `tandai` disuntik -- lalu
 * baris outbox berpindah ke `anchored` dengan `tx_hash` yang benar-benar ada
 * di rantai. Resolver kategori/leluhur memakai kueri database sungguhan
 * (`kategoriDariDb`/`leluhurDariDb`).
 *
 * Prasyarat (kalau tidak ada, suite DILEWATI exit 0 -- bukan bukti pass):
 *   - `DATABASE_URL` (Supabase) untuk chain_outbox;
 *   - biner `anvil` + artefak `contracts/out/DataAnchor.sol/DataAnchor.json`.
 *
 * Jejak: semua baris ber-watermark `uji-f2w-<ts>-<rand>` dan dihapus di finally.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const worker = require(path.join(__dirname, '..', 'tools', 'worker-anchor.js'));
const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

try { require('dotenv').config(); } catch (e) {}

const ARTEFAK = path.join(__dirname, '..', '..', 'contracts', 'out', 'DataAnchor.sol', 'DataAnchor.json');
const PORT = Number(process.env.ANCHOR_LIVE_PORT || 8549);
const RPC = 'http://127.0.0.1:' + PORT;
const KUNCI = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let passed = 0;
let failed = 0;

function ok(name, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
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

async function baca(tanda) {
  const res = await db.transaksi({ role: 'operator' }, async (client) => {
    return client.query(
      'SELECT record_id, version, chain_status, attempts, tx_hash, last_error' +
      ' FROM chain_outbox WHERE record_id = $1',
      [tanda]
    );
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    record_id: r.record_id,
    version: Number(r.version),
    chain_status: r.chain_status,
    attempts: Number(r.attempts) || 0,
    tx_hash: r.tx_hash,
    last_error: r.last_error,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return 0;
  }
  if (!fs.existsSync(ARTEFAK)) {
    console.log('\nDLEWATI: artefak ' + path.relative(process.cwd(), ARTEFAK) + ' belum ada (jalankan `forge build`).');
    return 0;
  }

  const { Pool } = require('pg');
  const { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, ZeroAddress } = require('ethers');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const proc = spawn(cariAnvil(), ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const bersihkanAnvil = () => { try { proc.kill(); } catch (_) {} };
  process.on('exit', bersihkanAnvil);

  const tanda = 'uji-f2w-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const nama = (x) => tanda + '-' + x;

  try {
    const provider = new JsonRpcProvider(RPC);
    await tunggu(async () => { await provider.getBlockNumber(); }, 20000, 250);

    const art = JSON.parse(fs.readFileSync(ARTEFAK, 'utf8'));
    const dompet = new NonceManager(new Wallet(KUNCI, provider));
    const pabrik = new ContractFactory(art.abi, art.bytecode.object, dompet);
    const terpasang = await pabrik.deploy(ZeroAddress);
    await terpasang.waitForDeployment();
    const alamat = await terpasang.getAddress();
    const kontrak = new Contract(alamat, ac.ABI, dompet);
    console.log('kontrak  : ' + alamat + ' @ ' + RPC + '\n');

    // Seed: G baik (commitment 32 byte), H rusak (bukan hex) -> harus retry.
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)',
      [nama('G'), 'a'.repeat(64), 'pending']
    );
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)',
      [nama('H'), 'bukan-hex', 'pending']
    );

    // Worker memilih penanda SENDIRI dari env (tanpa suntikan `tandai`).
    process.env.ANCHOR_RPC_URL = RPC;
    process.env.ANCHOR_CONTRACT = alamat;
    process.env.ANCHOR_PRIVATE_KEY = KUNCI;

    console.log('=== 1. worker.sekali() tanpa injeksi tandai ===');
    const ring = await worker.sekali({ batas: 10 });
    eq('satu baris anchored', ring.anchored, 1);
    eq('satu baris retry (commitment rusak)', ring.retry, 1);

    const G = await baca(nama('G'));
    const H = await baca(nama('H'));
    eq('G chain_status anchored', G.chain_status, 'anchored');
    ok('G tx_hash berawalan 0x', /^0x[0-9a-f]{64}$/i.test(G.tx_hash || ''), G.tx_hash);
    eq('H tetap pending (retry)', H.chain_status, 'pending');
    eq('H attempts 1', H.attempts, 1);
    ok('H last_error menjelaskan commitment', /commitment/.test(H.last_error || ''), H.last_error);

    console.log('\n=== 2. tx_hash DB benar-benar ada di rantai ===');
    const receipt = await provider.getTransactionReceipt(G.tx_hash);
    ok('receipt tx_hash ada', receipt !== null);
    if (receipt) {
      eq('receipt.to = kontrak', receipt.to.toLowerCase(), alamat.toLowerCase());
      eq('receipt.status sukses', receipt.status, 1);
    }
    eq('isAnchored(G,1) = true on-chain', await kontrak.isAnchored(nama('G'), 1), true);

    // G yang sudah anchored tidak dipilih lagi: pass kedua tak menyentuhnya.
    console.log('\n=== 3. pass kedua tidak meng-anchor G lagi ===');
    const ring2 = await worker.sekali({ batas: 10 });
    eq('ring2 anchored 0', ring2.anchored, 0);
    const G2 = await baca(nama('G'));
    eq('G tx_hash tidak berubah', G2.tx_hash, G.tx_hash);

    console.log('\nRegresi: ' + passed + ' lulus, ' + failed + ' gagal.');
    return failed > 0 ? 1 : 0;
  } finally {
    await utama.query('DELETE FROM chain_outbox WHERE record_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.end().catch(() => {});
    await db.matikan();
    bersihkanAnvil();
  }
}

main()
  .then((kode) => process.exit(kode))
  .catch((e) => {
    console.error('uji live worker->kontrak gagal: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
