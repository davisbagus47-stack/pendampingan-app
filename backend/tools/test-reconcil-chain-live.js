'use strict';

/**
 * Uji live jembatan rekonsiliasi on-chain (F3.5 separuh rantai): membaca event
 * `DataAnchored`/`RecordSuperseded` dari kontrak `DataAnchor` (F2) di rantai
 * lokal anvil, lalu membandingkannya dengan baris `chain_outbox`.
 *
 * Uji ini menjalankan anvil sendiri dan men-deploy kontrak dari artefak Foundry
 * yang sudah dibangun. Database TIDAK disentuh: baris outbox dibuat di memori.
 * Yang dibuktikan HANYA yang tidak bisa dibuktikan uji murni:
 *
 *   1. Pembacaan log ethers sungguhan, termasuk pencocokan record_id yang
 *      ter-index (yang di log hanya tersimpan keccak256(utf8(record_id))).
 *   2. Perbandingan menghasilkan kelas selisih yang benar: cocok, hilang,
 *      komitmen menyimpang, ekstra di rantai, dan pending yang wajar.
 *   3. Penyambungan dari variabel lingkungan (`pembandingDariEnv`) bekerja
 *      TANPA kunci pribadi -- membaca memang operasi publik.
 *
 * Prasyarat: `forge build` pernah dijalankan dan biner `anvil` tersedia
 * (env `ANVIL_BIN`, `~/.foundry/bin/anvil`, atau di PATH). Bila tidak, uji
 * DILEWATI dengan kode keluar 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));
const rc = require(path.join(__dirname, '..', 'lib', 'reconcil-chain.js'));
const workerRecon = require(path.join(__dirname, '..', 'tools', 'worker-recon.js'));

const ARTEFAK = path.join(__dirname, '..', '..', 'contracts', 'out', 'DataAnchor.sol', 'DataAnchor.json');
const PORT = Number(process.env.RECON_LIVE_PORT || 8547);
const RPC = 'http://127.0.0.1:' + PORT;
// Akun #0 bawaan anvil (kunci publik, hanya untuk rantai lokal).
const KUNCI = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

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

async function main() {
  if (!fs.existsSync(ARTEFAK)) {
    lewati('artefak ' + path.relative(process.cwd(), ARTEFAK) + ' belum ada (jalankan `forge build` di contracts/)');
  }
  const { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, ZeroAddress } = require('ethers');

  const bin = cariAnvil();
  const proc = spawn(bin || 'anvil', ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let procGagal = null;
  proc.on('error', (e) => { procGagal = e; });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});
  const bersihkan = () => { try { proc.kill(); } catch (_) {} };
  process.on('exit', bersihkan);

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

    const kontrak = new Contract(alamat, ac.ABI, dompet);

    // -----------------------------------------------------------------------
    // 0. Tanam event on-chain: R1 v1, R2 v1, dan R1 v2 lewat supersede.
    // -----------------------------------------------------------------------
    console.log('=== 0. Tanam event on-chain ===');
    const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
    const tandaiSuper = ac.buatPenanda({
      kontrak, kategori: async () => 'Ibu Hamil',
      leluhur: async () => ({ record_id: 'R1', version: 1 }),
    });
    await tandai({ record_id: 'R1', version: 1, commitment: A, supersedes_id: null });
    await tandai({ record_id: 'R2', version: 1, commitment: B, supersedes_id: null });
    await tandaiSuper({ record_id: 'R1', version: 2, commitment: C, supersedes_id: '1' });
    ok('tiga event tertanam', (await kontrak.queryFilter('DataAnchored', 0, 'latest')).length === 2 &&
      (await kontrak.queryFilter('RecordSuperseded', 0, 'latest')).length === 1);

    console.log('\n=== 1. Buat pembanding dari kontrak langsung ===');
    const bandingkan = rc.buatPembanding({ kontrak });

    // Outbox memori: satu cocok (R1v1), satu komitmen menyimpang (R2v1 diklaim
    // 'd'), satu klaim hilang (R3v1), satu pending wajar (R4v1). R1v2 sengaja
    // TIDAK punya baris outbox -> harus muncul sebagai ekstra di rantai.
    const outbox = [
      { record_id: 'R1', version: 1, commitment: A, chain_status: 'anchored' },
      { record_id: 'R2', version: 1, commitment: 'd'.repeat(64), chain_status: 'anchored' },
      { record_id: 'R3', version: 1, commitment: 'e'.repeat(64), chain_status: 'anchored' },
      { record_id: 'R4', version: 1, commitment: 'f'.repeat(64), chain_status: 'pending' },
    ];
    const h = await bandingkan(outbox);

    eq('tersedia', h.tersedia, true);
    eq('jumlah event terbaca', h.jumlahEvent, 3);
    eq('versi unik di rantai', h.diRantai, 3);
    eq('dicocokkan: R1v1', h.dicocokkan, 1);
    eq('hilang di rantai: R3', h.hilangDiRantai.map((x) => x.record_id), ['R3']);
    eq('komitmen menyimpang: R2', h.komitmen.map((x) => x.record_id), ['R2']);
    eq('komitmen R2: lokal', h.komitmen[0].lokal, rc.normalHex32('d'.repeat(64)));
    eq('komitmen R2: rantai', h.komitmen[0].rantai, rc.normalHex32(B));
    eq('pending wajar dihitung', h.belumDiRantai, 1);
    eq('ekstra di rantai: hash(R1) v2 (supersede tanpa outbox)',
      h.ekstraDiRantai.map((x) => x.hash_record_id + ':' + x.version),
      [rc.hashTeks('R1') + ':2']);
    eq('jumlah selisih = 3', h.jumlahSelisih, 3);
    eq('tidak nihil', h.nihil, false);

    console.log('\n=== 2. Outbox yang sepenuhnya cocok -> M-3 nihil ===');
    const bersih = [
      { record_id: 'R1', version: 1, commitment: A, chain_status: 'anchored' },
      { record_id: 'R2', version: 1, commitment: B, chain_status: 'anchored' },
      { record_id: 'R1', version: 2, commitment: C, chain_status: 'anchored' },
    ];
    const h2 = await bandingkan(bersih);
    eq('dicocokkan 3', h2.dicocokkan, 3);
    eq('nol selisih', h2.jumlahSelisih, 0);
    eq('M-3 nihil', h2.nihil, true);
    eq('belum di rantai 0', h2.belumDiRantai, 0);

    // -----------------------------------------------------------------------
    // 3. Penyambungan dari env TANPA kunci pribadi (membaca = publik).
    // -----------------------------------------------------------------------
    console.log('\n=== 3. pembandingDariEnv tanpa kunci pribadi ===');
    const simpan = {
      rpc: process.env.ANCHOR_RPC_URL,
      kontrak: process.env.ANCHOR_CONTRACT,
      kunci: process.env.ANCHOR_PRIVATE_KEY,
      dariBlok: process.env.ANCHOR_FROM_BLOCK,
    };
    try {
      process.env.ANCHOR_RPC_URL = RPC;
      process.env.ANCHOR_CONTRACT = alamat;
      delete process.env.ANCHOR_PRIVATE_KEY;
      delete process.env.ANCHOR_FROM_BLOCK;

      const p = workerRecon.pembandingDariEnv(process.env);
      ok('pembanding terakit dari env', typeof p === 'function');
      const hEnv = await p(bersih);
      eq('env: tersedia', hEnv.tersedia, true);
      eq('env: cocok 3', hEnv.dicocokkan, 3);
      eq('env: M-3 nihil', hEnv.nihil, true);

      // Tanpa konfigurasi -> seam menolak jujur, bukan mengaku cocok.
      const kosong = {};
      eq('tanpa env: pembanding null', workerRecon.pembandingDariEnv(kosong), null);
      const bawaan = await workerRecon.bandingkanRantaiBawaan();
      eq('bawaan: tersedia false', bawaan.tersedia, false);
      ok('bawaan: menyebut alasan', /ANCHOR_RPC_URL/.test(bawaan.catatan || ''));
    } finally {
      if (simpan.rpc === undefined) delete process.env.ANCHOR_RPC_URL; else process.env.ANCHOR_RPC_URL = simpan.rpc;
      if (simpan.kontrak === undefined) delete process.env.ANCHOR_CONTRACT; else process.env.ANCHOR_CONTRACT = simpan.kontrak;
      if (simpan.kunci === undefined) delete process.env.ANCHOR_PRIVATE_KEY; else process.env.ANCHOR_PRIVATE_KEY = simpan.kunci;
      if (simpan.dariBlok === undefined) delete process.env.ANCHOR_FROM_BLOCK; else process.env.ANCHOR_FROM_BLOCK = simpan.dariBlok;
    }

    // -----------------------------------------------------------------------
    // 4. Kegagalan baca rantai dilaporkan jujur, tidak menghapus laporan.
    // -----------------------------------------------------------------------
    console.log('\n=== 4. Seam yang melempar dibungkus jadi tersedia:false ===');
    const tertangkap = await workerRecon.panggilBandingkan(() => {
      throw new Error('RPC mati');
    }, bersih);
    eq('tersedia:false', tertangkap.tersedia, false);
    eq('ditandai galat', tertangkap.galat, true);
    ok('pesan memuat sebab', /RPC mati/.test(tertangkap.catatan || ''));

    // -----------------------------------------------------------------------
    // 5. Blok dari env berbentuk teks dikoersi ke angka (regresi: ethers
    //    menolak "11924828" sebagai string dengan INVALID_ARGUMENT).
    // -----------------------------------------------------------------------
    console.log('\n=== 5. dariBlok teks dikoersi ke angka ===');
    const dariTeks = rc.buatPembanding({ kontrak, dariBlok: '0', sampaiBlok: 'latest' });
    const h5 = await dariTeks(bersih);
    eq('tersedia', h5.tersedia, true);
    eq('dariBlok jadi angka 0', h5.dariBlok, 0);
    eq('typeof dariBlok number', typeof h5.dariBlok, 'number');
    eq('M-3 nihil', h5.nihil, true);
    const tagTeks = rc.buatPembanding({ kontrak, dariBlok: 'latest', sampaiBlok: 'latest' });
    const hTag = await tagTeks(bersih);
    eq('tag latest diteruskan apa adanya', hTag.dariBlok, 'latest');
  } finally {
    bersihkan();
  }

  console.log('\n' + '='.repeat(60));
  console.log('lulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nJEMBATAN REKONSILIASI (LIVE) RUSAK.');
    process.exit(1);
  }
  console.log('SEMUA UJI LOLOS');
}

main().catch((e) => {
  const pesan = e && e.message ? e.message : String(e);
  if (/ENOENT|spawn anvil/.test(pesan)) {
    lewati('biner anvil tidak ditemukan (set ANVIL_BIN atau pasang Foundry)');
  }
  console.error('uji live jembatan rekonsiliasi gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
