'use strict';

/**
 * Uji live PER-INPUT AUDIT end-to-end: POST /api/v1/records (anchor SINKRON)
 * dan POST /api/submit form publik (anchor KILAT / hybrid).
 *
 * Berbeda dari `test-records-write-live.js` yang menukar anchor dengan spy,
 * di sini anchor SUNGGUHAN dijalankan -- tetapi terhadap anvil lokal, bukan
 * Sepolia. Kombinasi yang diuji hanya bisa dibuktikan begini:
 *
 *   A. POST /api/v1/records
 *        -> record + outbox commit, lalu `anchorkanRecordDb` meng-anchor ke
 *           kontrak (tunggu receipt) dan menandai outbox `anchored`; respons
 *           memuat tx_hash.
 *   B. POST /api/submit (form publik)
 *        -> record + outbox commit (peran operator, instansi operator), lalu
 *           anchor KILAT: transaksi disiarkan dan respons memuat tx_hash dengan
 *           status `submitted`; outbox TETAP `pending` + tx_hash. Dilanjutkan
 *           jalur reconcile (periksa receipt) yang dipakai worker -> outbox
 *           `anchored`.
 *
 * Prasyarat: DATABASE_URL (untuk record/outbox) + artefak Foundry + biner
 * anvil. Bila salah satu tidak ada, uji DILEWATI dengan exit 0.
 *
 * Penyapuan outbox oleh worker CLI diuji di test-anchor-worker-live.js /
 * test-anchor-chain-worker-live.js; di sini transisi statusnya diuji lewat
 * mesin murni `anchor-worker.putuskan`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

try { require('dotenv').config(); } catch (e) {}

const app = require(path.join(__dirname, '..', 'index.js'));
const anchorRecord = require(path.join(__dirname, '..', 'lib', 'anchor-record.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const accessLog = require(path.join(__dirname, '..', 'lib', 'access-log.js'));

const ARTEFAK = path.join(__dirname, '..', '..', 'contracts', 'out', 'DataAnchor.sol', 'DataAnchor.json');
const PORT = Number(process.env.ANCHOR_LIVE_PORT || 8551);
const RPC = 'http://127.0.0.1:' + PORT;
const KUNCI = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let passed = 0;
let failed = 0;

function ok(name, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name + '\n        dapat     : ' + a + '\n        diharapkan : ' + b); }
}

function cariAnvil() {
  const kandidat = [];
  if (process.env.ANVIL_BIN) kandidat.push(process.env.ANVIL_BIN);
  const home = os.homedir();
  kandidat.push(path.join(home, '.foundry', 'bin', 'anvil.exe'));
  kandidat.push(path.join(home, '.foundry', 'bin', 'anvil'));
  for (const k of kandidat) { if (fs.existsSync(k)) return k; }
  return null;
}

function lewati(pesan) {
  console.log('DILEWATI: ' + pesan);
  process.exit(0);
}

function tunggu(fn, batasMs, jedaMs) {
  const akhir = Date.now() + batasMs;
  return new Promise((resolve, reject) => {
    (function coba() {
      Promise.resolve().then(fn).then(resolve).catch((e) => {
        if (Date.now() > akhir) reject(e);
        else setTimeout(coba, jedaMs || 200);
      });
    })();
  });
}

// ---------------------------------------------------------------------------
// Harness HTTP
// ---------------------------------------------------------------------------

let port = 0;
let agencyAktif = 0;
const TOKEN = 'pa_sk_live_' + 'b'.repeat(43);

async function kirim(jalur, o, body) {
  const opsi = o || {};
  if (Number.isInteger(opsi.agency)) agencyAktif = opsi.agency;
  const headers = {};
  if (!opsi.tanpaKunci) headers.authorization = 'Bearer ' + TOKEN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + jalur, {
    method: opsi.method || 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const teks = await res.text();
  let isi = null;
  try { isi = JSON.parse(teks); } catch (e) {}
  return { status: res.status, body: isi, teks };
}

/** Payload form/record yang lolos validasi. */
function tubuh(o) {
  o = o || {};
  return {
    namaTPK: 'Siti Aminah',
    peranTPK: 'TPK',
    namaDesa: 'Bantarjati',
    namaKecamatan: 'Ciwaringin',
    nik: o.nik || '3273011234560009',
    namaLengkap: o.nama_lengkap || 'Uji Per-Input',
    jenisSasaran: 'Catin',
    tanggalKunjungan: '2026-10-05',
    pendampinganKe: '2',
    usia: '27',
    bbSekarang: '62,5',
    tanggalLahir: '1999-03-04',
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    lewati('tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
  }
  if (!fs.existsSync(ARTEFAK)) {
    lewati('artefak ' + path.relative(process.cwd(), ARTEFAK) + ' belum ada (jalankan `forge build`)');
  }

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, ZeroAddress } = require('ethers');
  const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

  const bin = cariAnvil();
  const proc = spawn(bin || 'anvil', ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let procGagal = null;
  proc.on('error', (e) => { procGagal = e; });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});
  const bersihkan = () => { try { proc.kill(); } catch (_) {} };
  process.on('exit', bersihkan);

  const tanda = 'uji-pia-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const kunciOperator = tanda + '-opd';
  let idA = 0;

  try {
    const provider = new JsonRpcProvider(RPC);
    await tunggu(async () => { await provider.getBlockNumber(); }, 20000, 250);
    if (procGagal) throw procGagal;

    const art = JSON.parse(fs.readFileSync(ARTEFAK, 'utf8'));
    const dompet = new NonceManager(new Wallet(KUNCI, provider));
    const pabrik = new ContractFactory(art.abi, art.bytecode.object, dompet);
    const terpasang = await pabrik.deploy(ZeroAddress);
    await terpasang.waitForDeployment();
    const alamat = await terpasang.getAddress();
    console.log('kontrak  : ' + alamat + ' @ ' + RPC + '\n');

    // Arahkan anchor ke anvil SETELAH index.js memuat .env (menimpa Sepolia).
    process.env.ANCHOR_RPC_URL = RPC;
    process.env.ANCHOR_CONTRACT = alamat;
    process.env.ANCHOR_PRIVATE_KEY = KUNCI;
    process.env.FORM_INSTITUTION_KEY = kunciOperator;
    anchorRecord.aturUlang();

    // Seed: instansi operator (pemilik record form) dan instansi A (jalur API).
    const insOp = await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3) RETURNING id',
      [kunciOperator, 'Operator Uji PIA', 'active']
    );
    const insA = await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3) RETURNING id',
      [tanda + '-a', 'Instansi Uji PIA-A', 'active']
    );
    idA = Number(insA.rows[0].id);
    const idOp = Number(insOp.rows[0].id);
    await utama.query(
      "INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, 'Catin')", [idA]
    );
    await utama.query(
      "INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, 'Catin')", [idOp]
    );

    app.setCariKunci(async () => ({
      id: 1, agency_id: agencyAktif, key_prefix: 'uji', status: 'primary',
      category: null, table_name: null,
    }));
    app.limiter.aturKonfigurasi('id-' + idA, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('id-' + idOp, { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.limiter.aturKonfigurasi('publik', { kuota: 100000, jendelaMs: 60000, burst: 0 });
    app.gantiAccessLogger(accessLog.buatLogger({ sink: () => {} }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;

    // =======================================================================
    console.log('=== A. POST /api/v1/records: anchor SINKRON ke kontrak ===');
    // =======================================================================

    agencyAktif = idA;
    const ka = await kirim('/api/v1/records', { agency: idA }, tubuh({ nik: '3273011234560011' }));
    eq('create: 201', ka.status, 201);
    eq('respons: status anchor', ka.body && ka.body.anchor && ka.body.anchor.status, 'anchored');
    ok('respons: tx_hash ada', /^0x[0-9a-f]{64}$/i.test((ka.body && ka.body.anchor && ka.body.anchor.tx_hash) || ''));

    const obA = (await utama.query(
      'SELECT chain_status, tx_hash, anchored_at FROM chain_outbox WHERE record_id = $1 AND version = 1',
      [ka.body.record_id]
    )).rows[0];
    eq('outbox: chain_status anchored', obA && obA.chain_status, 'anchored');
    eq('outbox: tx_hash = respons', obA && obA.tx_hash, ka.body.anchor.tx_hash);
    ok('outbox: anchored_at terisi', !!obA && !!obA.anchored_at);

    eq('on-chain: isAnchored(record_id,1) = true',
      await terpasang.isAnchored(ka.body.record_id, 1), true);

    // =======================================================================
    console.log('\n=== B. POST /api/submit: records+outbox + anchor KILAT (hybrid) ===');
    // =======================================================================

    // Sheets palsu: form menulis ke sini, bukan ke Google.
    app.setSheets(() => ({
      spreadsheets: {
        values: {
          async get() { return { data: { values: [['No']] } }; },
          async update() { return { data: {} }; },
          async append() { return { data: { updates: { updatedRange: 'Sheet1!A2' } } }; },
        },
      },
    }));

    const nikForm = '3273' + String(Date.now()).slice(-12);
    const kf = await kirim('/api/submit', { tanpaKunci: true }, tubuh({ nik: nikForm, nama_lengkap: 'Uji Form PIA' }));
    eq('submit: 200', kf.status, 200);
    eq('respons: status anchor = submitted', kf.body && kf.body.anchor && kf.body.anchor.status, 'submitted');
    ok('respons: ada record_id', !!(kf.body && kf.body.anchor && kf.body.anchor.record_id));
    ok('respons: tx_hash ada', /^0x[0-9a-f]{64}$/i.test((kf.body && kf.body.anchor && kf.body.anchor.tx_hash) || ''));
    app.setSheets(null);

    const recF = (await utama.query(
      'SELECT record_id, version, institution_id, record_hash FROM records WHERE record_id = $1',
      [kf.body.anchor.record_id]
    )).rows[0];
    eq('records: institution_id = instansi operator', recF && recF.institution_id, kunciOperator);
    eq('records: commitment = SHA256(record_hash||operator)',
      kf.body.anchor.commitment, c.commitment(recF.record_hash, kunciOperator));

    // Disiarkan tetapi TETAP pending: tx_hash tersimpan, menunggu receipt.
    const obF = (await utama.query(
      'SELECT chain_status, tx_hash, commitment FROM chain_outbox WHERE record_id = $1 AND version = 1',
      [kf.body.anchor.record_id]
    )).rows[0];
    eq('outbox: chain_status pending (hybrid)', obF && obF.chain_status, 'pending');
    eq('outbox: tx_hash = respons', obF && obF.tx_hash, kf.body.anchor.tx_hash);
    eq('outbox: commitment = respons', obF && obF.commitment, kf.body.anchor.commitment);
    ok('on-chain: isAnchored(record_id form,1) = true',
      await terpasang.isAnchored(kf.body.anchor.record_id, 1), true);

    // Finalisasi: jalur reconcile yang dipakai worker TIDAK mengirim ulang --
    // cukup memeriksa receipt (mengirim ulang akan revert FR-5.3).
    const rekon = await anchorRecord.anchorkan({
      record_id: kf.body.anchor.record_id,
      version: 1,
      commitment: obF.commitment,
      jenis_sasaran: 'Catin',
      tx_hash: kf.body.anchor.tx_hash,
    }, { kontrak: terpasang });
    eq('reconcile: ok (receipt ditemukan, tanpa kirim ulang)', rekon.ok, true);
    eq('reconcile: tx_hash sama', rekon.tx_hash, kf.body.anchor.tx_hash);
    ok('reconcile: bukan belum_konfirmasi', !rekon.belum_konfirmasi);

    // Transisi status worker (mesin murni) lalu terapkan ke outbox.
    const aw = require(path.join(__dirname, '..', 'lib', 'anchor-worker.js'));
    const put = aw.putuskan(
      { chain_status: 'pending', attempts: 0, tx_hash: obF.tx_hash }, rekon, {}
    );
    eq('worker: putusan anchored', put.putusan, 'anchored');
    await utama.query(
      "UPDATE chain_outbox SET chain_status = $1, tx_hash = $2, anchored_at = now()" +
      ' WHERE record_id = $3 AND version = 1',
      [put.kolom.chain_status, put.kolom.tx_hash, kf.body.anchor.record_id]
    );
    const obF2 = (await utama.query(
      'SELECT chain_status FROM chain_outbox WHERE record_id = $1 AND version = 1',
      [kf.body.anchor.record_id]
    )).rows[0];
    eq('outbox setelah finalisasi: anchored', obF2 && obF2.chain_status, 'anchored');

    server.close();
  } finally {
    // Bersih-bersih lewat koneksi utama (BYPASSRLS), berurutan menurut FK:
    // outbox (tanpa FK) -> records (institution_id) -> agencies.
    try {
      await utama.query(
        'DELETE FROM chain_outbox WHERE record_id IN' +
        ' (SELECT record_id FROM records WHERE institution_id = ANY($1))',
        [[kunciOperator, tanda + '-a']]
      );
      await utama.query('DELETE FROM records WHERE institution_id = ANY($1)', [[kunciOperator, tanda + '-a']]);
      await utama.query('DELETE FROM agencies WHERE institution_key = ANY($1)', [[kunciOperator, tanda + '-a']]);
    } catch (e) {
      console.log('peringatan bersih-bersih: ' + (e && e.message ? e.message : e));
    }
    await utama.end().catch(() => {});
    bersihkan();
  }

  console.log('\n' + '='.repeat(60));
  console.log('lulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) { console.log('\nPER-INPUT AUDIT (LIVE) RUSAK.'); process.exit(1); }
  console.log('SEMUA UJI LOLOS');
}

main().catch((e) => {
  const pesan = e && e.message ? e.message : String(e);
  if (/ENOENT|spawn anvil/.test(pesan)) {
    lewati('biner anvil tidak ditemukan (set ANVIL_BIN atau pasang Foundry)');
  }
  console.error('uji live per-input audit gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
