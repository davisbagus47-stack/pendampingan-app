'use strict';

/**
 * F4.4 / F4.4a -- uji prototipe ZKP (T2) atas log tersembunyi.
 *
 * Yang dibuktikan di sini BUKAN sekadar "positifnya lolos". Dua hal yang justru
 * menjadi inti temuan F0P.5 diuji sebagai regresi:
 *
 *   1. Sirkuit produksi (`log_predicate`) MENOLAK witness bohong: commitment
 *      salah dan predikat dilanggar keduanya gagal pada tahap witness.
 *   2. Pembanding `log_predicate_unsafe` (tanpa `valid === 1`) MENERIMA witness
 *      yang sama dan tetap lolos verifikasi -- inilah bom waktu yang wajib
 *      dicegah, jadi ketiadaannya di sirkuit produksi adalah sebuah properti
 *      yang dites, bukan sekadar komentar.
 *
 * Menjalankan: `node test-zkp.js` (dari folder `backend/zkp`). Setup dijalankan
 * otomatis bila artefak belum ada.
 */

const cli = require('./src/cli.js');
const { poseidon2 } = require('./src/poseidon.js');
const mp = require('./src/merkle-poseidon.js');

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

/** Kembalikan error bila pembuktian gagal, atau null bila berhasil. */
async function cobaBukti(nama, input) {
  try { await cli.buktikan(nama, input); return null; }
  catch (e) { return e; }
}

async function main() {
  console.log('\n=== 0. Setup (idempoten) ===');
  cli.setupSemua();

  const entryValue = 7n;
  const salt = 123456789n;
  const commitment = await poseidon2(entryValue, salt);
  const inputBenar = {
    entryValue: entryValue.toString(),
    salt: salt.toString(),
    commitment,
    threshold: '5',
  };

  console.log('\n=== 1. Poseidon (luar sirkuit) ===');
  const c2 = await poseidon2(entryValue, salt);
  eq('Poseidon deterministik', c2, commitment);
  ok('commitment berupa bilangan field desimal', /^[0-9]{20,}$/.test(commitment), commitment);

  console.log('\n=== 2. Positif: klaim benar dibuktikan & diverifikasi ===');
  const p = await cli.buktikan('log_predicate', inputBenar);
  ok('fullProve berhasil', !!p.proof);
  const v = await cli.verifikasi('log_predicate', p.proof, p.publicSignals);
  ok('verify = true', v.ok);
  eq('publicSignals = [commitment, threshold]', p.publicSignals, [commitment, '5']);
  console.log('        (prove ' + p.ms.toFixed(0) + ' ms, verify ' + v.ms.toFixed(0) +
    ' ms, proof ' + Buffer.byteLength(JSON.stringify(p.proof)) + ' B)');

  console.log('\n=== 3. Negatif (sirkuit produksi WAJIB menolak) ===');
  const inputSalah = Object.assign({}, inputBenar, { commitment: await poseidon2(entryValue, 999n) });
  ok('commitment salah ditolak pada tahap witness', (await cobaBukti('log_predicate', inputSalah)) !== null);

  const inputLanggar = {
    entryValue: '2', salt: salt.toString(),
    commitment: await poseidon2(2n, salt), threshold: '5',
  };
  ok('predikat dilanggar (2 < 5) ditolak pada tahap witness',
    (await cobaBukti('log_predicate', inputLanggar)) !== null);

  console.log('\n=== 4. Pembanding F4.4a: TANPA `=== 1`, bukti palsu LOLOS ===');
  const pUnsafe = await cli.buktikan('log_predicate_unsafe', inputSalah);
  ok('versi tanpa `=== 1` MENERIMA witness commitment-salah', !!pUnsafe.proof);
  const vUnsafe = await cli.verifikasi('log_predicate_unsafe', pUnsafe.proof, pUnsafe.publicSignals);
  ok('proof palsu itu lolos verify (inti temuan F0P.5)', vUnsafe.ok);
  ok('sinyal publik memuat valid = 0 (klaim justru tidak benar)',
    pUnsafe.publicSignals.includes('0'), JSON.stringify(pUnsafe.publicSignals));
  ok('witness yang sama DITOLAK oleh sirkuit produksi (bukti === 1 bekerja)',
    (await cobaBukti('log_predicate', inputSalah)) !== null);

  console.log('\n=== 5. F4.7: klaim NEGATIF atas jendela log tersembunyi ===');
  const entries = [[1, 10, 100], [2, 11, 101], [3, 12, 102], [4, 13, 103]];
  const daun = [];
  for (const e of entries) daun.push(await mp.daunDari(e));
  const pohon = await mp.pohonPoseidon(daun);
  const bukti = [];
  for (let i = 0; i < entries.length; i++) bukti.push(await mp.buktiInklusi(pohon, i));

  function inputNoMatch(target, opsional = {}) {
    return {
      cat: entries.map((e) => String(e[0])),
      inst: entries.map((e) => String(e[1])),
      date: entries.map((e, idx) => (opsional.ubah !== undefined && opsional.ubah === idx) ? String(opsional.tanggal) : String(e[2])),
      path: bukti.map((b) => b.path),
      sel: bukti.map((b) => b.sel),
      logRoot: opsional.root || pohon.root,
      targetCat: String(target[0]),
      targetInst: String(target[1]),
      targetDate: String(target[2]),
    };
  }

  const targetAbsen = [9, 99, 999];
  const pn = await cli.buktikan('no_match', inputNoMatch(targetAbsen));
  ok('fullProve berhasil untuk klaim negatif BENAR', !!pn.proof);
  const vn = await cli.verifikasi('no_match', pn.proof, pn.publicSignals);
  ok('verify = true', vn.ok);
  ok('publicSignals memuat akar & tuple target',
    pn.publicSignals.length === 4 && pn.publicSignals.includes(pohon.root) &&
    pn.publicSignals.includes('9') && pn.publicSignals.includes('99') && pn.publicSignals.includes('999'),
    JSON.stringify(pn.publicSignals));
  console.log('        (prove ' + pn.ms.toFixed(0) + ' ms, verify ' + vn.ms.toFixed(0) +
    ' ms, proof ' + Buffer.byteLength(JSON.stringify(pn.proof)) + ' B)');

  ok('tuple yang ADA di jendela ditolak (klaim negatif palsu)',
    (await cobaBukti('no_match', inputNoMatch(entries[2]))) !== null);
  ok('akar log dipalsukan ditolak (inklusi gagal)',
    (await cobaBukti('no_match', inputNoMatch(targetAbsen, { root: await poseidon2(1n, 2n) }))) !== null);
  ok('satu daun diubah tanpa memperbaiki akar ditolak',
    (await cobaBukti('no_match', inputNoMatch(targetAbsen, { ubah: 1, tanggal: '9999' }))) !== null);

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
