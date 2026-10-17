'use strict';

/**
 * Uji live jembatan chain (F3.4 lanjutan): `lib/anchor-chain.js` <-> kontrak
 * `DataAnchor` (F2) di rantai lokal anvil.
 *
 * Uji ini menjalankan anvil sendiri, men-deploy kontrak dari artefak Foundry
 * yang sudah dibangun (`contracts/out/DataAnchor.sol/DataAnchor.json`), lalu
 * memanggil `tandai(baris)` sungguhan -- provider, Wallet, dan RPC nyata. Yang
 * dibuktikan di sini hanya yang TIDAK bisa dibuktikan uji murni: penerimaan
 * transaksi, penolakan duplikat, penegakan peran, dan jalur `supersede`.
 *
 * Database TIDAK disentuh (resolver kategori/leluhur dikonstankan), supaya uji
 * ini tidak meninggalkan jejak di Supabase.
 *
 * Prasyarat: `forge build` pernah dijalankan (ada artefak) dan biner `anvil`
 * tersedia (env `ANVIL_BIN`, atau `~/.foundry/bin/anvil`, atau di PATH). Bila
 * tidak, uji DILEWATI dengan kode keluar 0 -- sama seperti uji live lain yang
 * melewati diri ketika prasarana tidak ada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

const ARTEFAK = path.join(__dirname, '..', '..', 'contracts', 'out', 'DataAnchor.sol', 'DataAnchor.json');
const PORT = Number(process.env.ANCHOR_LIVE_PORT || 8546);
const RPC = 'http://127.0.0.1:' + PORT;
// Akun #0 bawaan anvil (kunci publik, hanya untuk rantai lokal).
const KUNCI = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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
  return null; // harap ada di PATH
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
  const { JsonRpcProvider, Wallet, Contract, ContractFactory, NonceManager, parseEther, ZeroAddress } = require('ethers');

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
    // NonceManager melacak nonce secara lokal: banyak transaksi berurutan pada
    // provider yang sama tidak lagi bergantung pada `eth_getTransactionCount`
    // yang bisa balapan.
    const dompet = new NonceManager(new Wallet(KUNCI, provider));
    const pabrik = new ContractFactory(art.abi, art.bytecode.object, dompet);
    const terpasang = await pabrik.deploy(ZeroAddress);
    await terpasang.waitForDeployment();
    const alamat = await terpasang.getAddress();
    console.log('kontrak  : ' + alamat + ' @ ' + RPC + '\n');

    const kontrak = new Contract(alamat, ac.ABI, dompet);

    // Catatan: `buatPenanda` melakukan pra-simulasi (staticCall) sebelum kirim,
    // jadi kasus revert tidak pernah benar-benar mengirim tx (tidak membakar
    // gas dan tidak menyisakan jarak nonce pada NonceManager). Urutan uji tetap
    // diatur sukses-dulu demi kejelasan.

    console.log('=== 1. anchor baru diterima (FR-5.3 jalur bahagia) ===');
    {
      const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
      const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: 'a'.repeat(64), supersedes_id: null });
      eq('ok', hasil.ok, true);
      ok('tx_hash berbentuk hash', /^0x[0-9a-f]{64}$/i.test(hasil.tx_hash || ''));
      eq('isAnchored(REC-1,1) = true', await kontrak.isAnchored('REC-1', 1), true);

      // categoryHash yang tertulis on-chain harus keccak256("Catin").
      const evs = await kontrak.queryFilter('DataAnchored', 0, 'latest');
      eq('tercatat 1 event DataAnchored', evs.length, 1);
      eq('categoryHash = keccak256("Catin")', evs[0].args.categoryHash, ac.hashKategori('Catin'));
      eq('version on-chain = 1', Number(evs[0].args.version), 1);
    }

    console.log('\n=== 2. jalur supersede diterima (F2.4) ===');
    {
      const tandai = ac.buatPenanda({
        kontrak,
        kategori: async () => 'Ibu Hamil',
        leluhur: async () => ({ record_id: 'REC-1', version: 1 }),
      });
      const hasil = await tandai({ record_id: 'REC-1', version: 2, commitment: 'c'.repeat(64), supersedes_id: '1' });
      eq('ok', hasil.ok, true);
      eq('isAnchored(REC-1,2) = true', await kontrak.isAnchored('REC-1', 2), true);

      const evs = await kontrak.queryFilter('RecordSuperseded', 0, 'latest');
      eq('tercatat 1 event RecordSuperseded', evs.length, 1);
      // `oldRecordId` ter-index (string) -> yang tersimpan adalah topik
      // keccak256(utf8(...)), bukan nilainya.
      eq('oldRecordId (topik) = keccak("REC-1")', evs[0].args.oldRecordId.hash, ac.hashKategori('REC-1'));
      eq('newVersion = 2', Number(evs[0].args.newVersion), 2);
    }

    console.log('\n=== 3. siapkan wallet tanpa peran (transaksi sukses terakhir) ===');
    const asing = new NonceManager(Wallet.createRandom().connect(provider));
    const alamatAsing = await asing.getAddress();
    await (await dompet.sendTransaction({ to: alamatAsing, value: parseEther('1') })).wait();
    ok('wallet asing berisi gas', (await provider.getBalance(alamatAsing)) > 0n);

    console.log('\n=== 4. peran ditolak (AccessControl) ===');
    {
      const kontrakAsing = new Contract(alamat, ac.ABI, asing);
      const tandai = ac.buatPenanda({ kontrak: kontrakAsing, kategori: async () => 'Catin' });
      const hasil = await tandai({ record_id: 'REC-3', version: 1, commitment: 'e'.repeat(64), supersedes_id: null });
      eq('ok=false', hasil.ok, false);
      ok('pesan menyebut AccessControlUnauthorizedAccount',
        /AccessControlUnauthorizedAccount|unauthorized/i.test(hasil.error || ''));
    }

    console.log('\n=== 5. duplikat (record_id, version) ditolak on-chain ===');
    {
      const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
      const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: 'b'.repeat(64), supersedes_id: null });
      eq('ok=false', hasil.ok, false);
      ok('pesan menyebut already anchored', /already anchored/.test(hasil.error || ''));
    }

    console.log('\n=== 6. leluhur belum di-anchor ditolak on-chain ===');
    {
      const tandai = ac.buatPenanda({
        kontrak,
        kategori: async () => 'Catin',
        leluhur: async () => ({ record_id: 'REC-BELUM', version: 1 }),
      });
      const hasil = await tandai({ record_id: 'REC-BELUM', version: 2, commitment: 'd'.repeat(64), supersedes_id: '1' });
      eq('ok=false', hasil.ok, false);
      ok('pesan menyebut old record not anchored', /old record not anchored/.test(hasil.error || ''));
    }
  } finally {
    bersihkan();
  }

  console.log('\n' + '='.repeat(60));
  console.log('lulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) {
    console.log('\nJEMBATAN CHAIN (LIVE) RUSAK.');
    process.exit(1);
  }
  console.log('SEMUA UJI LOLOS');
}

main().catch((e) => {
  const pesan = e && e.message ? e.message : String(e);
  if (/ENOENT|spawn anvil/.test(pesan)) {
    lewati('biner anvil tidak ditemukan (set ANVIL_BIN atau pasang Foundry)');
  }
  console.error('uji live jembatan chain gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
