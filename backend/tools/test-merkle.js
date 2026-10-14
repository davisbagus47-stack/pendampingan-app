'use strict';

/**
 * Uji pohon Merkle dan bukti inklusi (F4.2, F4.3).
 *
 * T1 adalah baseline yang wajib ada, jadi diuji seperti produk yang dikirim ke
 * pengguna sungguhan: bukan hanya "jalur bahagia lulus", tapi setiap cara
 * orang bisa menipu verifier.
 *
 * Bukti kebenaran datang dari tiga arah yang saling bebas:
 *   1. Vektor beku di tests/merkle.vectors.json, yang akarnya DIHITUNG oleh
 *      tools/merkle_reference.py (Python, implementasi terpisah).
 *   2. Sifat yang harus berlaku untuk semua masukan (setiap daun punya bukti
 *      yang valid, setiap pemalsuan ditolak).
 *   3. Cross-check langsung ke Python pada pohon acak.
 *
 * Kalau ketiganya lolos, bug haruslah yang lolos dari ketiga filter itu
 * sekaligus -- bukan "kedua implementasi salah dengan cara yang sama".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const M = require('../lib/merkle.js');

const REF = path.join(__dirname, 'merkle_reference.py');
const VECTORS = path.join(__dirname, '..', 'tests', 'merkle.vectors.json');

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    if (extra !== undefined) console.log('        ' + extra);
  }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        diharapkan: ' + b);
    console.log('        diterima  : ' + a);
  }
}

// PRNG determinis. Math.random() tidak bisa dipakai: kalau sebuah suite gagal,
// kita harus bisa mereproduksi masukan yang sama persis.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randomLeaf = (rnd) => crypto.createHash('sha256').update('leaf-' + rnd()).digest('hex');

function pythonRoot(leaves) {
  const tmp = path.join(__dirname, '_merkle_tmp.txt');
  fs.writeFileSync(tmp, leaves.join('\n'), 'utf8');
  try {
    return execFileSync('python', [REF, tmp], { encoding: 'utf8' }).trim();
  } finally {
    fs.unlinkSync(tmp);
  }
}

function pythonProof(leaves, index) {
  const tmp = path.join(__dirname, '_merkle_tmp.txt');
  fs.writeFileSync(tmp, leaves.join('\n'), 'utf8');
  try {
    const out = execFileSync('python', [REF, '--proof', tmp, String(index)], { encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    return { root: lines[0], proof: lines.slice(1) };
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ===========================================================================
console.log('=== 1. Vektor beku (akar dihitung Python) ===');

const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
const allLeaves = vectors.leafInputs.map((s) => M.leafOf(s));

eq('algoritma terkunci di vektor', vectors.algorithm, M.MERKLE_ALGORITHM);
ok('vektor punya cukup daun untuk semua kasus',
  allLeaves.length >= Math.max(...vectors.roots.map((r) => r.n)),
  'daun=' + allLeaves.length);

for (const { n, root } of vectors.roots) {
  const set = allLeaves.slice(0, n);
  eq('akar n=' + n + ' cocok dengan vektor beku', M.buildTree(set).root, root);
}

for (const { n, index, leaf, root, proof } of vectors.proofs) {
  const set = allLeaves.slice(0, n);
  const p = M.inclusionProof(set, index);
  eq('bukti n=' + n + ' indeks ' + index + ': daun cocok', p.leaf, leaf);
  eq('bukti n=' + n + ' indeks ' + index + ': akar cocok', p.root, root);
  eq('bukti n=' + n + ' indeks ' + index + ': isi bukti cocok', JSON.stringify(p.proof), JSON.stringify(proof));
  ok('bukti n=' + n + ' indeks ' + index + ': verifikasi lulus',
    M.verifyInclusion(p.root, p.leaf, p.proof));
}

// ===========================================================================
console.log('\n=== 2. Setiap daun punya bukti yang valid ===');

for (let n = 1; n <= 40; n++) {
  const rnd = mulberry32(1000 + n);
  const leaves = Array.from({ length: n }, () => randomLeaf(rnd));
  const tree = M.buildTree(leaves);
  let semuaLulus = true;
  const yangGagal = [];
  for (let i = 0; i < n; i++) {
    const p = M.inclusionProof(tree, i);
    if (!M.verifyInclusion(p.root, p.leaf, p.proof)) {
      semuaLulus = false;
      yangGagal.push(i);
    }
  }
  ok('n=' + n + ': semua ' + n + ' daun punya bukti valid', semuaLulus,
    yangGagal.length ? 'gagal di indeks ' + yangGagal.join(', ') : undefined);
}

// Bukti tidak boleh mengandung undefined. Kasus yang pernah merusak:
// daun terakhir pada level ganjil tidak punya saudara, sehingga "saudara"nya
// adalah dirinya sendiri. Kalau ini terlewat, verifikasi gagal untuk indeks
// tersebut saja -- sulit ditemukan karena mayoritas daun tetap benar.
console.log('\n=== 3. Kasus carry: daun terakhir pada level ganjil ===');

for (let n = 3; n <= 9; n++) {
  const rnd = mulberry32(2000 + n);
  const leaves = Array.from({ length: n }, () => randomLeaf(rnd));
  const tree = M.buildTree(leaves);
  const p = M.inclusionProof(tree, n - 1);
  ok('n=' + n + ' (ganjil): bukti daun terakhir tidak punya undefined',
    p.proof.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)));
  ok('n=' + n + ' (ganjil): bukti daun terakhir memverifikasi',
    M.verifyInclusion(p.root, p.leaf, p.proof));
}
{
  // Level ganjil berarti carry benar-benar terjadi. n=3 -> level0 punya 3 node.
  const leaves = allLeaves.slice(0, 3);
  const p = M.inclusionProof(leaves, 2);
  eq('n=3 daun ke-2: saudara di level 0 adalah dirinya sendiri', p.proof[0], leaves[2]);
  ok('n=3 daun ke-2: verifikasi lulus', M.verifyInclusion(p.root, p.leaf, p.proof));
}

// ===========================================================================
console.log('\n=== 4. Penolakan: semua cara menipu verifier ===');

{
  const rnd = mulberry32(7);
  const leaves = Array.from({ length: 11 }, () => randomLeaf(rnd));
  const tree = M.buildTree(leaves);
  const p = M.inclusionProof(tree, 5);
  const other = randomLeaf(rnd);

  ok('bukti asli lulus', M.verifyInclusion(p.root, p.leaf, p.proof));
  ok('daun yang diganti ditolak',
    !M.verifyInclusion(p.root, other, p.proof));
  ok('daun satu karakter berbeda ditolak',
    !M.verifyInclusion(p.root, flipOneChar(p.leaf), p.proof));

  ok('bukti dengan satu elemen diganti ditolak',
    !M.verifyInclusion(p.root, p.leaf, [randomLeaf(rnd), ...p.proof.slice(1)]));
  ok('bukti terpotong ditolak',
    !M.verifyInclusion(p.root, p.leaf, p.proof.slice(0, -1)));
  ok('bukti ditambah satu elemen ditolak',
    !M.verifyInclusion(p.root, p.leaf, [...p.proof, randomLeaf(rnd)]));
  ok('bukti kosong ditolak', !M.verifyInclusion(p.root, p.leaf, []));
  ok('akar salah ditolak',
    !M.verifyInclusion(randomLeaf(rnd), p.leaf, p.proof));
  // Bukti dari pohon yang benar-benar lain tidak boleh diterima, walaupun
  // semua elemen buktinya hex64 yang valid. Ini kasus yang paling mudah
  // terlewat kalau hanya menguji manipulasi satu elemen.
  const pohonLain = M.buildTree(leaves.slice(0, 10).concat(randomLeaf(rnd)));
  const buktiLain = M.inclusionProof(pohonLain, 5);
  ok('bukti dari pohon lain ditolak oleh akar pohon ini',
    !M.verifyInclusion(p.root, buktiLain.leaf, buktiLain.proof));
  ok('bukti dari pohon ini ditolak oleh akar pohon lain',
    !M.verifyInclusion(pohonLain.root, p.leaf, p.proof));
  ok('bukti pohon lain sendiri tetap valid terhadap akarnya',
    M.verifyInclusion(pohonLain.root, buktiLain.leaf, buktiLain.proof));

  // Bukti daun yang benar tapi indeksnya dipalsukan harus tetap ditolak,
  // karena isi bukti tidak cocok dengan jalur di pohon.
  ok('bukti daun indeks 5 dipakai sebagai bukti daun indeks 6 ditolak', (() => {
    const enam = M.inclusionProof(leaves, 6);
    return !M.verifyInclusion(p.root, p.leaf, enam.proof);
  })());
}

function flipOneChar(hex) {
  const c = hex[0] === 'a' ? 'b' : 'a';
  return c + hex.slice(1);
}

console.log('\n=== 5. Masukan rusak tidak boleh melempar error ===');

{
  const root = M.buildTree([M.leafOf('a'), M.leafOf('b')]).root;
  const leaf = M.leafOf('a');
  const p = M.inclusionProof([M.leafOf('a'), M.leafOf('b')], 0);

  ok('akar null ditolak', M.verifyInclusion(null, leaf, p.proof) === false);
  ok('akar bukan string ditolak', M.verifyInclusion(123, leaf, p.proof) === false);
  ok('akar terpotong ditolak', M.verifyInclusion('abc', leaf, p.proof) === false);
  ok('akar huruf besar ditolak', M.verifyInclusion(root.toUpperCase(), leaf, p.proof) === false);
  ok('daun null ditolak', M.verifyInclusion(root, null, p.proof) === false);
  ok('proof null ditolak', M.verifyInclusion(root, leaf, null) === false);
  ok('proof bukan array ditolak', M.verifyInclusion(root, leaf, 'bukan array') === false);
  ok('proof berisi non-hex ditolak', M.verifyInclusion(root, leaf, ['xyz', ...p.proof.slice(1)]) === false);
  ok('proof berisi null ditolak', M.verifyInclusion(root, leaf, [null]) === false);
  ok('proof kosong dengan akar tunggal ditolak',
    M.verifyInclusion(root, leaf, []) === false);
}

// buildTree dan inclusionProof SEDIAH melempar error untuk programmer salah.
console.log('\n=== 6. Masukan tidak valid ditolak dengan error jelas ===');

{
  const expectThrow = (name, fn) => {
    let n = 0;
    try { fn(); } catch (e) { n = 1; }
    ok(name, n === 1);
  };
  expectThrow('buildTree([]) melempar', () => M.buildTree([]));
  expectThrow('buildRow tanpa array melempar', () => M.buildTree('bukan array'));
  expectThrow('daun non-hex64 melempar', () => M.buildTree(['pendek']));
  expectThrow('daun huruf besar melempar', () => M.buildTree(['A'.repeat(64)]));
  expectThrow('indeks di luar jangkauan melempar',
    () => M.inclusionProof([M.leafOf('a')], 1));
  expectThrow('indeks negatif melempar',
    () => M.inclusionProof([M.leafOf('a')], -1));
  expectThrow('indeks bukan integer melempar',
    () => M.inclusionProof([M.leafOf('a'), M.leafOf('b')], 1.5));
  expectThrow('batchSize 0 melempar', () => M.batchRoots([M.leafOf('a')], 0));
  expectThrow('leafFromEntryHash non-hex melempar',
    () => M.leafFromEntryHash('bukan hex'));
}

// ===========================================================================
console.log('\n=== 7. Semuanya masuk batch (FR-8.1) ===');

{
  const rnd = mulberry32(99);
  const leaves = Array.from({ length: 250 }, () => randomLeaf(rnd));

  const batches = M.batchRoots(leaves, 100);
  eq('250 daun / 100 = 3 batch', batches.length, 3);
  eq('batch 1: 0..99', JSON.stringify([batches[0].from, batches[0].to]), '[0,99]');
  eq('batch 2: 100..199', JSON.stringify([batches[1].from, batches[1].to]), '[100,199]');
  eq('batch 3: 200..249', JSON.stringify([batches[2].from, batches[2].to]), '[200,249]');
  eq('total daun tercakup', batches.reduce((a, b) => a + b.count, 0), 250);
  ok('batch tidak tumpang tindih dan berurutan',
    batches.every((b, i) => i === 0 || b.from === batches[i - 1].to + 1));
  eq('akar batch = akar pohon yang sama',
    batches[0].root, M.buildTree(leaves.slice(0, 100)).root);

  ok('akar batch tidak sama antar batch (tidak bisa disamakan)',
    new Set(batches.map((b) => b.root)).size === 3);

  eq('batch tepat di batas menghasilkan 2 batch', M.batchRoots(leaves.slice(0, 200), 100).length, 2);
  eq('batch lebih besar dari jumlah daun menghasilkan 1 batch', M.batchRoots(leaves.slice(0, 5), 100).length, 1);
  eq('daftar kosong menghasilkan 0 batch', M.batchRoots([], 100).length, 0);
  eq('batch 1 daun menghasilkan 250 batch', M.batchRoots(leaves, 1).length, 250);
}

// ===========================================================================
console.log('\n=== 8. Daun dari hash entri log ===');

{
  const entryHash = crypto.createHash('sha256').update('entri-1', 'utf8').digest('hex');
  eq('leafFromEntryHash sama dengan leafOf(Buffer)',
    M.leafFromEntryHash(entryHash), M.leafOf(Buffer.from(entryHash, 'hex')));
  ok('bukan sama dengan leafOf(hex sebagai teks)',
    M.leafFromEntryHash(entryHash) !== M.leafOf(entryHash));
  eq('deterministik', M.leafFromEntryHash(entryHash), M.leafFromEntryHash(entryHash));
}

// ===========================================================================
console.log('\n=== 9. Cross-check dengan Python pada pohon acak ===');

{
  let beda = 0;
  const rincian = [];
  for (let s = 0; s < 20; s++) {
    const rnd = mulberry32(5000 + s);
    const n = 1 + Math.floor(rnd() * 40);
    const leaves = Array.from({ length: n }, () => randomLeaf(rnd));
    const js = M.buildTree(leaves);
    const pyRoot = pythonRoot(leaves);
    if (js.root !== pyRoot) {
      beda++;
      rincian.push('n=' + n + ' root js=' + js.root + ' py=' + pyRoot);
      continue;
    }
    const idx = Math.floor(rnd() * n);
    const jsP = M.inclusionProof(js, idx);
    const pyP = pythonProof(leaves, idx);
    if (jsP.proof.join(',') !== pyP.proof.join(',')) {
      beda++;
      rincian.push('n=' + n + ' idx=' + idx + ' bukti beda');
    }
  }
  ok('20 pohon acak: akar dan bukti sama dengan Python', beda === 0,
    rincian.length ? rincian.join(' | ') : undefined);
}

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nPOHON MERKLE ATAU BUKTI INKLUSI RUSAK.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
