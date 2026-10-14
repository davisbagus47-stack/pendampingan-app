'use strict';

/**
 * F4.4 (T2) -- pipa Groth16 untuk prototipe ZKP log tersembunyi.
 *
 * Perintah:
 *   node src/cli.js setup     kompilasi + trusted setup (ptau -> zkey -> vkey)
 *   node src/cli.js prove     baca input.json, tulis proof.json + public.json
 *   node src/cli.js verify    verifikasi proof.json terhadap vkey
 *   node src/cli.js demo      end-to-end kasus positif, cetak waktu & ukuran
 *
 * Perkakas:
 *   - circom 2.2.3 (binary Windows, diunduh ke zkp/bin/circom.exe)
 *   - snarkjs 0.7.6 + circomlib 2.0.5 (npm)
 *   - ptau dibangkitkan LOKAL (powersoftau new/contribute/prepare), tidak
 *     diunduh, supaya modul ini mandiri dan tidak bergantung pada URL pihak
 *     ketiga yang bisa mati (dua sumber ptau publik mengembalikan 403).
 *
 * CATATAN KEAMANAN: trusted setup PoC ini terpusat dan tidak tahan manipulasi;
 * `zkey` bersifat RAHASIA (siapa pun yang memilikinya dapat memalsukan proof).
 * Ini keterbatasan yang harus dinyatakan terbuka (PRD 6.8.5).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const snarkjs = require('snarkjs');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const BUILD = path.join(ROOT, 'build');
const PTAU_DIR = path.join(ROOT, 'ptau');
const CIRCOM = path.join(BIN, 'circom.exe');
const CIRCOMLIB = path.join(ROOT, 'node_modules', 'circomlib', 'circuits');
const SNARKJS_CLI = path.join(path.dirname(require.resolve('snarkjs')), 'cli.cjs');

const POWER = 13; // 2^13 = 8192 constraint; `no_match` (4 entri) butuh ~6600
const PTAU_FINAL = path.join(PTAU_DIR, 'pot' + POWER + '_final.ptau');

function jalurSirkuit(nama) {
  return { r1cs: path.join(BUILD, nama + '.r1cs'), sym: path.join(BUILD, nama + '.sym') };
}
function jalurWasm(nama) { return path.join(BUILD, nama + '_js', nama + '.wasm'); }
function jalurZkey(nama) { return path.join(BUILD, nama + '_final.zkey'); }
function jalurVkey(nama) { return path.join(BUILD, nama + '_verification_key.json'); }

function ada(p) { return fs.existsSync(p); }

function jalankanSnarkjs(args) {
  execFileSync(process.execPath, [SNARKJS_CLI, ...args], { cwd: ROOT, stdio: 'inherit' });
}

function entropy(label) {
  return crypto.randomBytes(32).toString('hex') + ':' + label;
}

/** Kompilasi satu sirkuit ke r1cs + wasm + sym. */
function kompilasi(nama, { force } = {}) {
  if (!ada(CIRCOM)) throw new Error('circom tidak ada: ' + CIRCOM + ' (unduh circom-windows-amd64.exe v2.2.3)');
  const { r1cs } = jalurSirkuit(nama);
  if (ada(r1cs) && !force) { console.log('  lewati kompilasi ' + nama + ' (sudah ada)'); return; }
  fs.mkdirSync(BUILD, { recursive: true });
  console.log('  circom ' + nama + '.circom ...');
  execFileSync(CIRCOM, [
    '--r1cs', '--wasm', '--sym', '-l', CIRCOMLIB, '-o', BUILD,
    path.join(ROOT, 'circuits', nama + '.circom'),
  ], { cwd: ROOT, stdio: 'inherit' });
}

/** Bangun ptau final lokal sekali (idempoten). */
function bangunPtau({ force } = {}) {
  if (ada(PTAU_FINAL) && !force) { console.log('  lewati ptau (sudah ada)'); return; }
  fs.mkdirSync(PTAU_DIR, { recursive: true });
  const p0 = path.join(PTAU_DIR, 'pot' + POWER + '_0000.ptau');
  const p1 = path.join(PTAU_DIR, 'pot' + POWER + '_0001.ptau');
  console.log('  powersoftau new bn128 ' + POWER + ' ...');
  jalankanSnarkjs(['powersoftau', 'new', 'bn128', String(POWER), p0]);
  console.log('  powersoftau contribute (satu kontribusi) ...');
  jalankanSnarkjs(['powersoftau', 'contribute', p0, p1, '--name=PoC pendampingan', '-e=' + entropy('ptau')]);
  console.log('  powersoftau prepare phase2 ...');
  jalankanSnarkjs(['powersoftau', 'prepare', 'phase2', p1, PTAU_FINAL]);
  for (const p of [p0, p1]) { try { fs.unlinkSync(p); } catch (e) {} }
}

/** Trusted setup Groth16 untuk satu sirkuit: zkey + verification key. */
function setupGroth16(nama, { force } = {}) {
  const { r1cs } = jalurSirkuit(nama);
  const zkey = jalurZkey(nama);
  const vkey = jalurVkey(nama);
  if (ada(zkey) && ada(vkey) && !force) { console.log('  lewati setup ' + nama + ' (sudah ada)'); return; }
  const z0 = path.join(BUILD, nama + '_0000.zkey');
  console.log('  groth16 setup ' + nama + ' ...');
  jalankanSnarkjs(['groth16', 'setup', r1cs, PTAU_FINAL, z0]);
  console.log('  zkey contribute ' + nama + ' ...');
  jalankanSnarkjs(['zkey', 'contribute', z0, zkey, '--name=PoC pendampingan', '-e=' + entropy('zkey:' + nama)]);
  console.log('  zkey export verificationkey ' + nama + ' ...');
  jalankanSnarkjs(['zkey', 'export', 'verificationkey', zkey, vkey]);
  try { fs.unlinkSync(z0); } catch (e) {}
}

function setupSemua(opts = {}) {
  console.log('== setup ZKP (F4.4) ==');
  const SIRKUIT = ['log_predicate', 'log_predicate_unsafe', 'no_match'];
  for (const nama of SIRKUIT) kompilasi(nama, opts);
  bangunPtau(opts);
  for (const nama of SIRKUIT) setupGroth16(nama, opts);
  const info = {
    r1cs: fs.statSync(jalurSirkuit('log_predicate').r1cs).size,
    zkey: fs.statSync(jalurZkey('log_predicate')).size,
    vkey: fs.statSync(jalurVkey('log_predicate')).size,
    ptau: fs.statSync(PTAU_FINAL).size,
  };
  console.log('== selesai == r1cs=' + info.r1cs + 'B zkey=' + info.zkey + 'B vkey=' + info.vkey + 'B ptau=' + info.ptau + 'B');
  return info;
}

async function buktikan(nama, input) {
  const wasm = jalurWasm(nama);
  const zkey = jalurZkey(nama);
  if (!ada(wasm) || !ada(zkey)) throw new Error('artefak ' + nama + ' belum ada; jalankan: node src/cli.js setup');
  const t0 = process.hrtime.bigint();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const t1 = process.hrtime.bigint();
  return { proof, publicSignals, ms: Number(t1 - t0) / 1e6 };
}

async function verifikasi(nama, proof, publicSignals) {
  const vkey = JSON.parse(fs.readFileSync(jalurVkey(nama), 'utf8'));
  const t0 = process.hrtime.bigint();
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const t1 = process.hrtime.bigint();
  return { ok, ms: Number(t1 - t0) / 1e6 };
}

async function demo() {
  setupSemua();
  const { poseidon2 } = require('./poseidon.js');
  const entryValue = 7n;
  const salt = 123456789n;
  const threshold = 5n;
  const commitment = await poseidon2(entryValue, salt);
  const input = {
    entryValue: entryValue.toString(),
    salt: salt.toString(),
    commitment,
    threshold: threshold.toString(),
  };
  const { proof, publicSignals, ms } = await buktikan('log_predicate', input);
  const v = await verifikasi('log_predicate', proof, publicSignals);
  const proofBytes = Buffer.byteLength(JSON.stringify(proof));
  console.log('\n== demo positif ==');
  console.log('commitment  : ' + commitment.slice(0, 24) + '...');
  console.log('publicSignals: ' + JSON.stringify(publicSignals));
  console.log('prove       : ' + ms.toFixed(0) + ' ms');
  console.log('verify      : ' + v.ms.toFixed(0) + ' ms  -> ' + v.ok);
  console.log('ukuran proof: ' + proofBytes + ' B (JSON snarkjs)');
  if (!v.ok) process.exitCode = 1;
}

async function main() {
  const cmd = process.argv[2] || 'demo';
  const force = process.argv.includes('--force');
  if (cmd === 'setup') { setupSemua({ force }); return; }
  if (cmd === 'demo') { await demo(); return; }
  if (cmd === 'prove' || cmd === 'verify') {
    const inFile = path.join(ROOT, 'input.json');
    if (!ada(inFile)) throw new Error('input.json tidak ada di ' + ROOT);
    const input = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const { proof, publicSignals, ms } = await buktikan('log_predicate', input);
    fs.writeFileSync(path.join(ROOT, 'proof.json'), JSON.stringify(proof, null, 2));
    fs.writeFileSync(path.join(ROOT, 'public.json'), JSON.stringify(publicSignals, null, 2));
    console.log('prove: ' + ms.toFixed(0) + ' ms; proof.json + public.json ditulis');
    if (cmd === 'verify') {
      const v = await verifikasi('log_predicate', proof, publicSignals);
      console.log('verify: ' + v.ms.toFixed(0) + ' ms -> ' + v.ok);
      if (!v.ok) process.exitCode = 1;
    }
    return;
  }
  console.error('Perintah tidak dikenal: ' + cmd + ' (setup|prove|verify|demo)');
  process.exitCode = 2;
}

if (require.main === module) {
  // Proses dipaksa keluar: snarkjs/ffjavascript menyisakan worker thread yang
  // membuat event loop hidup terus setelah pekerjaan selesai. Ini hanya untuk
  // pemakaian CLI; pemanggil `require` (test-zkp.js) memakai fungsinya langsung.
  main().then(() => process.exit(process.exitCode || 0))
    .catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = {
  ROOT, BUILD, CIRCOM, PTAU_FINAL,
  jalurWasm, jalurZkey, jalurVkey, jalurSirkuit,
  setupSemua, kompilasi, bangunPtau, setupGroth16,
  buktikan, verifikasi,
};
