const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const M = require('../lib/merkle.js');

const REF = path.join(__dirname, 'merkle_reference.py');

// Daun tetap: byte ASCII, lalu di-hash sebagai daun. Nilai ini dibekukan di
// sini supaya perubahan kode tidak bisa diam-diam mengubah vektor.
//
// Panjang 20, bukan 8. Versi pertama hanya punya 8 daun, dan `slice(0, 17)`
// diam-diam mengembalikan 8 daun -- sehingga akar untuk n=8, n=9, n=16, dan
// n=17 keluar sama persis dan terlihat seperti bukti kebenaran. Justru itu
// gejalanya. Karena itu jumlah daun dijaga eksplisit di bawah.
const LEAF_COUNT = 20;
const leafInputs = Array.from({ length: LEAF_COUNT }, (_, i) => 'entry-' + String(i + 1).padStart(4, '0'));

function pythonRoot(leaves) {
  const tmp = path.join(__dirname, '_tmp_leaves.txt');
  fs.writeFileSync(tmp, leaves.join('\n'), 'utf8');
  try {
    return execFileSync('python', [REF, tmp], { encoding: 'utf8' }).trim();
  } finally {
    fs.unlinkSync(tmp);
  }
}

function pythonProof(leaves, index) {
  const tmp = path.join(__dirname, '_tmp_leaves.txt');
  fs.writeFileSync(tmp, leaves.join('\n'), 'utf8');
  try {
    const out = execFileSync('python', [REF, '--proof', tmp, String(index)], { encoding: 'utf8' });
    const lines = out.trim().split(/\r?\n/);
    return { root: lines[0], proof: lines.slice(1) };
  } finally {
    fs.unlinkSync(tmp);
  }
}

const leaves = leafInputs.map((s) => M.leafOf(s));
console.log('daun (hex64):');
leaves.forEach((h, i) => console.log('  ' + String(i).padStart(2) + ' ' + leafInputs[i].padEnd(12) + ' ' + h));

const cases = [];
for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 20]) {
  if (n > LEAF_COUNT) throw new Error('permintaan ' + n + ' daun, hanya ada ' + LEAF_COUNT);
  const set = leaves.slice(0, n);
  if (set.length !== n) throw new Error('slice tidak menghasilkan ' + n + ' daun');
  const js = M.buildTree(set).root;
  const py = pythonRoot(set);
  cases.push({ n, js, py, agree: js === py });
}
console.log('');
console.log('akar:');
cases.forEach((c) => {
  console.log('  n=' + String(c.n).padStart(3) + '  js=' + c.js + '  py=' + (c.agree ? '(sama)' : c.py) + (c.agree ? '' : '  BEDA!'));
});

// Akar yang sama untuk dua jumlah daun berbeda berarti ada bug: penambahan daun
// harus selalu mengubah akar. Ini penjaga terhadap data uji yang terlalu pendek.
const dupes = cases.map((c) => c.js);
const jumlahAkarUnik = new Set(dupes);
if (jumlahAkarUnik.size !== dupes.length) {
  console.log('');
  console.log('PERINGATAN: ada jumlah daun berbeda dengan akar sama.');
  const SudahDilaporkan = new Set();
  cases.forEach((c) => {
    const lain = cases.find((x) => x.js === c.js && x.n !== c.n);
    if (lain && !SudahDilaporkan.has(c.js)) {
      SudahDilaporkan.add(c.js);
      console.log('  n=' + c.n + ' sama dengan n=' + lain.n);
    }
  });
  process.exit(1);
}
console.log('');
console.log('semua ' + cases.length + ' akar berbeda satu sama lain (daun bertambah -> akar berubah).');

console.log('');
console.log('contoh bukti (n=5, daun ke-3):');
const sample = leaves.slice(0, 5);
const jsProof = M.inclusionProof(sample, 3);
const pyProof = pythonProof(sample, 3);
console.log('  js.leaf  = ' + jsProof.leaf);
console.log('  js.root  = ' + jsProof.root);
console.log('  js.proof = ' + JSON.stringify(jsProof.proof, null, 2).replace(/\n/g, '\n            '));
console.log('  py.root  = ' + pyProof.root);
console.log('  py.proof = ' + JSON.stringify(pyProof.proof, null, 2).replace(/\n/g, '\n            '));
console.log('  sama? ' + (jsProof.root === pyProof.root && JSON.stringify(jsProof.proof) === JSON.stringify(pyProof.proof)));
console.log('  verifikasi js: ' + M.verifyInclusion(jsProof.root, jsProof.leaf, jsProof.proof));

// Bekukan sebagai literal.
console.log('');
console.log('=== JSON untuk tests/merkle.vectors.json ===');
const vectors = {
  algorithm: M.MERKLE_ALGORITHM,
  note: 'Dihasilkan oleh tools/merkle_reference.py (Python, implementasi terpisah).',
  leafInputs,
  roots: cases.map((c) => ({ n: c.n, root: c.py })),
  proofs: [
    { n: 5, index: 3 },
    { n: 8, index: 0 },
    { n: 8, index: 7 },
    { n: 17, index: 16 },
  ].map(({ n, index }) => {
    const set = leaves.slice(0, n);
    const p = pythonProof(set, index);
    return { n, index, leaf: M.leafOf(leafInputs[index]), root: p.root, proof: p.proof };
  }),
};
fs.writeFileSync(path.join(__dirname, '..', 'tests', 'merkle.vectors.json'),
  JSON.stringify(vectors, null, 2) + '\n', 'utf8');
console.log('ditulis tests/merkle.vectors.json');
