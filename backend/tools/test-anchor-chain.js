'use strict';

/**
 * Uji murni jembatan chain (`lib/anchor-chain.js`).
 *
 * Yang diuji di sini adalah pengkodean argumen dan pemetaan jawaban -- TANPA
 * jaringan dan TANPA database. Kontrak ethers digantikan objek palsu yang
 * merekam panggilan, jadi kita bisa memeriksa persis apa yang akan dikirim
 * ke `DataAnchor`.
 *
 * Bukti kebenaran `categoryHash` datang dari Foundry (`cast keccak`), implementasi
 * keccak256 yang sepenuhnya terpisah dari `ethers`: vektor di bawah dibekukan
 * dari keluaran `cast`, bukan dari modul yang sedang diuji.
 *
 * Perilaku jaringan sungguhan (anvil + kontrak ter-deploy) diuji di
 * `tools/test-anchor-chain-live.js`.
 */

const path = require('path');
const ac = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

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

// Kontrak palsu: merekam panggilan kirim (`calls`) dan pra-simulasi
// (`simulasi`), mengembalikan tx dengan `wait()`.
function kontrakPalsu(hashTx, gagalDengan, opsi) {
  const rec = { calls: [], simulasi: [] };
  const opt = opsi || {};
  function buat(nama) {
    const tx = {
      hash: hashTx,
      wait: async () => (hashTx ? { hash: hashTx } : null),
    };
    const fn = (...args) => {
      rec.calls.push({ fn: nama, args });
      if (gagalDengan) throw gagalDengan;
      return tx;
    };
    if (!opt.tanpaSimulasi) {
      fn.staticCall = async (...args) => {
        rec.simulasi.push({ fn: nama, args });
        if (opt.gagalSimulasi) throw opt.gagalSimulasi;
        return '0x';
      };
    }
    return fn;
  }
  rec.anchor = buat('anchor');
  rec.supersede = buat('supersede');
  return rec;
}

const COM = 'a'.repeat(64);            // commitment tanpa 0x
const COM0X = '0x' + 'a'.repeat(64);

async function main() {
console.log('=== 1. normHex32 (commitment -> bytes32) ===');
{
  eq('tanpa 0x ditambah & dikecilkan', ac.normHex32('A'.repeat(64)), '0x' + 'a'.repeat(64));
  eq('sudah 0x dibiarkan', ac.normHex32(COM0X), COM0X);
  eq('spasi dipangkas', ac.normHex32('  ' + COM0X + '  '), COM0X);
  let tolak = false;
  try { ac.normHex32('0x' + 'a'.repeat(63)); } catch (e) { tolak = /commitment/.test(e.message); }
  ok('panjang salah ditolak dgn pesan jelas', tolak);
  let tolak2 = false;
  try { ac.normHex32('zz'.repeat(32)); } catch (e) { tolak2 = true; }
  ok('bukan heksadesimal ditolak', tolak2);
  let tolak3 = false;
  try { ac.normHex32(null); } catch (e) { tolak3 = true; }
  ok('null ditolak', tolak3);
}

console.log('\n=== 2. hashKategori (vektor beku dari `cast keccak`) ===');
{
  eq('Catin',
    ac.hashKategori('Catin'),
    '0xb67116ff6249d77c68a2af80b6dd275c782cfa7a4ce7ade3953605c8f8682ad4');
  eq('Ibu Hamil',
    ac.hashKategori('Ibu Hamil'),
    '0x44377596e672efc99c15cae022ad52823c341e6f609fac3654c41af23df26fb2');
  eq('kosong',
    ac.hashKategori(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  eq('null diperlakukan kosong', ac.hashKategori(null), ac.hashKategori(''));

  // Injeksi krypto membuktikan pemetaan keccak256(utf8(...)), bukan sekadar
  // fungsi apa pun yang kebetulan mengembalikan nilai benar.
  let terlihat = null;
  const krypto = {
    toUtf8Bytes: (s) => ({ utf8: s }),
    keccak256: (b) => { terlihat = b; return 'HASIL'; },
  };
  eq('memakai toUtf8Bytes lalu keccak256', ac.hashKategori('Remaja', krypto), 'HASIL');
  eq('utf8 yang dikirim', terlihat, { utf8: 'Remaja' });
}

console.log('\n=== 3. buatPenanda: jalur anchor ===');
{
  const kontrak = kontrakPalsu('0xTX1');
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
  const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: COM, supersedes_id: null });
  eq('jawaban sukses', hasil, { ok: true, tx_hash: '0xTX1' });
  eq('anchor dipanggil sekali', kontrak.calls.length, 1);
  eq('nama fungsi', kontrak.calls[0].fn, 'anchor');
  eq('argumen lengkap', kontrak.calls[0].args, ['REC-1', 1, COM0X, ac.hashKategori('Catin')]);
  eq('version jadi number', typeof kontrak.calls[0].args[1], 'number');
}

console.log('\n=== 4. buatPenanda: kategori tak tersedia -> keccak256("") ===');
{
  const kontrak = kontrakPalsu('0xTX2');
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => null });
  await tandai({ record_id: 'REC-2', version: 3, commitment: COM, supersedes_id: null });
  eq('categoryHash kosong', kontrak.calls[0].args[3], ac.hashKategori(''));
}

console.log('\n=== 5. buatPenanda: jalur supersede ===');
{
  const kontrak = kontrakPalsu('0xTX3');
  const tandai = ac.buatPenanda({
    kontrak,
    kategori: async () => 'Catin',
    leluhur: async (b) => ({ record_id: 'REC-1', version: 1 }),
  });
  const hasil = await tandai({ record_id: 'REC-1', version: 2, commitment: COM, supersedes_id: '77' });
  eq('sukses', hasil.ok, true);
  eq('supersede dipanggil', kontrak.calls[0].fn, 'supersede');
  eq('urutan argumen supersede',
    kontrak.calls[0].args,
    ['REC-1', 1, 'REC-1', 2, COM0X, ac.hashKategori('Catin')]);
}

console.log('\n=== 6. buatPenanda: supersedes_id ada tapi tanpa resolver -> anchor biasa ===');
{
  const kontrak = kontrakPalsu('0xTX4');
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
  await tandai({ record_id: 'REC-9', version: 2, commitment: COM, supersedes_id: '77' });
  eq('jatuh ke anchor', kontrak.calls[0].fn, 'anchor');
}

console.log('\n=== 7. buatPenanda: leluhur tidak ditemukan -> gagal jujur ===');
{
  const kontrak = kontrakPalsu('0xTX5');
  const tandai = ac.buatPenanda({
    kontrak,
    kategori: async () => 'Catin',
    leluhur: async () => null,
  });
  const hasil = await tandai({ record_id: 'REC-1', version: 2, commitment: COM, supersedes_id: '77' });
  eq('ditolak', hasil.ok, false);
  ok('pesan menyebut supersedes_id', /supersedes_id=77/.test(hasil.error));
  eq('kontrak tidak dipanggil', kontrak.calls.length, 0);
}

console.log('\n=== 8. buatPenanda: pemetaan galat ===');
{
  const kontrak = kontrakPalsu(null, { shortMessage: 'execution reverted: already anchored' });
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
  const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: COM });
  eq('gagal', hasil.ok, false);
  eq('pesan pendek dipakai', hasil.error, 'execution reverted: already anchored');
}
{
  const kontrak = kontrakPalsu('0xTX6');
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
  const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: 'bukan-hex' });
  eq('commitment rusak -> gagal', hasil.ok, false);
  ok('pesan menyebut commitment', /commitment/.test(hasil.error));
}
{
  // tx ada tapi wait() mengembalikan null dan tidak ada hash -> cacat kontrak.
  const kontrak = { anchor: () => ({ hash: null, wait: async () => null }) };
  const tandai = ac.buatPenanda({ kontrak, kategori: async () => 'Catin' });
  const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: COM });
  eq('tanpa hash ditolak', hasil.ok, false);
  ok('pesan menyebut hash', /hash/.test(hasil.error));
}
{
  eq('pesanGalat string apa adanya', ac.pesanGalat('boom'), 'boom');
  eq('pesanGalat reason', ac.pesanGalat({ reason: 'r' }), 'r');
  eq('pesanGalat kosong', ac.pesanGalat(null), 'anchor gagal tanpa pesan');
  eq('pesanGalat custom error revert',
    ac.pesanGalat({ revert: { name: 'AccessControlUnauthorizedAccount', args: ['0xabc', '0xdef'] } }),
    'execution reverted: AccessControlUnauthorizedAccount(0xabc, 0xdef)');
}

console.log('\n=== 8b. pra-simulasi (staticCall) sebelum kirim ===');
{
  const k1 = kontrakPalsu('0xTX8');
  const t1 = ac.buatPenanda({ kontrak: k1, kategori: async () => 'Catin' });
  const h1 = await t1({ record_id: 'R', version: 1, commitment: COM });
  eq('simulasi sukses lalu kirim', h1.ok, true);
  eq('staticCall dipanggil sekali', k1.simulasi.length, 1);
  eq('kirim sekali setelah simulasi', k1.calls.length, 1);

  // staticCall revert dengan custom error OZ -> TIDAK dikirim, pesan ter-decode.
  const k2 = kontrakPalsu('0xTX9', null, {
    gagalSimulasi: { revert: { name: 'AccessControlUnauthorizedAccount', args: [] } },
  });
  const t2 = ac.buatPenanda({ kontrak: k2, kategori: async () => 'Catin' });
  const h2 = await t2({ record_id: 'R', version: 1, commitment: COM });
  eq('gagal di pra-simulasi', h2.ok, false);
  ok('pesan memuat nama custom error', /AccessControlUnauthorizedAccount/.test(h2.error));
  eq('tx TIDAK dikirim (hemat gas)', k2.calls.length, 0);

  const k3 = kontrakPalsu('0xTXA');
  const t3 = ac.buatPenanda({ kontrak: k3, kategori: async () => 'Catin', praSimulasi: false });
  await t3({ record_id: 'R', version: 1, commitment: COM });
  eq('praSimulasi:false melewati staticCall', k3.simulasi.length, 0);

  const k4 = kontrakPalsu('0xTXB', null, { tanpaSimulasi: true });
  const t4 = ac.buatPenanda({ kontrak: k4, kategori: async () => 'Catin' });
  const h4 = await t4({ record_id: 'R', version: 1, commitment: COM });
  eq('runner tanpa staticCall tetap kirim', h4.ok, true);
}

console.log('\n=== 9. konfigurasi & tersedia ===');
{
  eq('kosong -> tidak tersedia', ac.tersedia({}), false);
  eq('sebagian -> tidak tersedia',
    ac.tersedia({ ANCHOR_RPC_URL: 'http://x', ANCHOR_CONTRACT: '0x1' }), false);
  const env = { ANCHOR_RPC_URL: 'http://x', ANCHOR_CONTRACT: '0x1', ANCHOR_PRIVATE_KEY: '0x2' };
  eq('lengkap -> tersedia', ac.tersedia(env), true);
  eq('konfigurasi dipangkas',
    ac.konfigurasi({ ANCHOR_RPC_URL: ' http://x ', ANCHOR_CONTRACT: ' 0x1', ANCHOR_PRIVATE_KEY: '0x2 ' }),
    { rpcUrl: 'http://x', alamat: '0x1', kunci: '0x2' });

  let tolak = false;
  try { ac.buatPenandaDariEnv({}); } catch (e) { tolak = /belum lengkap/.test(e.message); }
  ok('buatPenandaDariEnv tanpa env ditolak', tolak);

  // Dengan kontrak disuntik, tak perlu jaringan: env hanya dipakai untuk cek.
  const kontrak = kontrakPalsu('0xTX7');
  const tandai = ac.buatPenandaDariEnv(env, { kontrak, kategori: async () => 'Catin' });
  const hasil = await tandai({ record_id: 'REC-1', version: 1, commitment: COM });
  eq('penanda dari env (kontrak disuntik) jalan', hasil, { ok: true, tx_hash: '0xTX7' });
}

// Kontrak palsu untuk akar audit: merekam panggilan `anchorAuditRoot` dan
// pra-simulasinya. `isAuditRootAnchored` hanya perlu ada bila diuji.
function kontrakAkarPalsu(hashTx, gagalDengan, opsi) {
  const rec = { calls: [], simulasi: [] };
  const opt = opsi || {};
  const tx = { hash: hashTx, wait: async () => (hashTx ? { hash: hashTx } : null) };
  const fn = (...args) => {
    rec.calls.push(args);
    if (gagalDengan) throw gagalDengan;
    return tx;
  };
  if (opt.staticCall !== false) {
    fn.staticCall = async (...args) => {
      rec.simulasi.push(args);
      if (opt.gagalSimulasi) throw opt.gagalSimulasi;
      return true;
    };
  }
  rec.anchorAuditRoot = fn;
  return rec;
}

const ROOT = '0x' + '11'.repeat(32);
const HEAD = '0x' + '22'.repeat(32);

console.log('\n=== 10. buatPengirimAkar: jalur akar audit (FR-7.4) ===');
{
  const k = kontrakAkarPalsu('0xAKAR');
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  const hasil = await kirim({ to_seq: 5, root: ROOT, head_hash: HEAD });
  eq('jawaban sukses', hasil, { ok: true, tx_hash: '0xAKAR' });
  eq('kirim sekali', k.calls.length, 1);
  eq('argumen (to_seq, root, headHash)', k.calls[0], [5, ROOT, HEAD]);
  eq('toSeq jadi number', typeof k.calls[0][0], 'number');
  eq('pra-simulasi sekali', k.simulasi.length, 1);
}
{
  // to_seq string numerik (baris DB) harus di-Number; root/head tanpa 0x dinormalkan.
  const k = kontrakAkarPalsu('0xAKAR2');
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  await kirim({ to_seq: '7', root: '1'.repeat(64), head_hash: '2'.repeat(64) });
  eq('to_seq string -> number', k.calls[0][0], 7);
  eq('root/head dinormalkan', k.calls[0].slice(1), ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)]);
}
{
  const k = kontrakAkarPalsu('0xAKAR3');
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  const h0 = await kirim({ to_seq: 0, root: ROOT, head_hash: HEAD });
  eq('to_seq 0 ditolak', h0.ok, false);
  ok('pesan menyebut to_seq', /to_seq/.test(h0.error));
  const h1 = await kirim({ to_seq: 'abc', root: ROOT, head_hash: HEAD });
  eq('to_seq bukan angka ditolak', h1.ok, false);
  const h2 = await kirim({ to_seq: 2, root: 'bukan-hex', head_hash: HEAD });
  eq('root rusak ditolak', h2.ok, false);
  eq('kontrak tidak dipanggil saat argumen salah', k.calls.length, 0);
}
{
  const k = kontrakAkarPalsu(null, { shortMessage: 'execution reverted: audit root mismatch for toSeq' });
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  const hasil = await kirim({ to_seq: 9, root: ROOT, head_hash: HEAD });
  eq('gagal', hasil.ok, false);
  eq('pesan pendek dipakai', hasil.error, 'execution reverted: audit root mismatch for toSeq');
}
{
  const k = kontrakAkarPalsu('0xA', null, { gagalSimulasi: { revert: { name: 'AccessControlUnauthorizedAccount', args: [] } } });
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  const hasil = await kirim({ to_seq: 1, root: ROOT, head_hash: HEAD });
  eq('pra-simulasi revert -> gagal', hasil.ok, false);
  ok('nama custom error ter-decode', /AccessControlUnauthorizedAccount/.test(hasil.error));
  eq('tx tidak dikirim (hemat gas)', k.calls.length, 0);
}
{
  const k = kontrakAkarPalsu('0xB', null, { staticCall: false });
  const kirim = ac.buatPengirimAkar({ kontrak: k });
  const hasil = await kirim({ to_seq: 1, root: ROOT, head_hash: HEAD });
  eq('tanpa staticCall tetap kirim', hasil.ok, true);
}
{
  const kirim = ac.buatPengirimAkar({ kontrak: { isAuditRootAnchored: () => {} } });
  const hasil = await kirim({ to_seq: 1, root: ROOT, head_hash: HEAD });
  eq('kontrak tanpa anchorAuditRoot -> gagal', hasil.ok, false);
  ok('pesan menyebut anchorAuditRoot', /anchorAuditRoot/.test(hasil.error));
}
{
  let tolak = false;
  try { ac.buatPengirimAkar({}); } catch (e) { tolak = /kontrak/.test(e.message); }
  ok('tanpa kontrak ditolak saat rakit', tolak);

  const k = { anchorAuditRoot: () => ({ hash: null, wait: async () => null }) };
  const hasil = await ac.buatPengirimAkar({ kontrak: k })({ to_seq: 1, root: ROOT, head_hash: HEAD });
  eq('tx tanpa hash ditolak', hasil.ok, false);
  ok('pesan menyebut hash', /hash/.test(hasil.error));
}

console.log('\n=== 11. buatPengirimAkarDariEnv (FR-7.4) ===');
{
  let tolak = false;
  try { ac.buatPengirimAkarDariEnv({}); } catch (e) { tolak = /belum lengkap/.test(e.message); }
  ok('tanpa env ditolak', tolak);

  const env = { ANCHOR_RPC_URL: 'http://x', ANCHOR_CONTRACT: '0x1', ANCHOR_PRIVATE_KEY: '0x2' };
  const k = kontrakAkarPalsu('0xENV');
  const kirim = ac.buatPengirimAkarDariEnv(env, { kontrak: k });
  const hasil = await kirim({ to_seq: 3, root: ROOT, head_hash: HEAD });
  eq('pengirim akar dari env (kontrak disuntik) jalan', hasil, { ok: true, tx_hash: '0xENV' });
}
{
  ok('ABI memuat anchorAuditRoot', ac.ABI.some((x) => x.indexOf('anchorAuditRoot') >= 0));
  ok('ABI memuat isAuditRootAnchored', ac.ABI.some((x) => x.indexOf('isAuditRootAnchored') >= 0));
  ok('ABI memuat event AuditRootAnchored', ac.ABI.some((x) => x.indexOf('AuditRootAnchored') >= 0));
}

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nJEMBATAN CHAIN RUSAK.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
}

main().catch((e) => {
  console.error('uji jembatan chain gagal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
