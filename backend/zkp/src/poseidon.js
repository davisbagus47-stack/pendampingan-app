'use strict';

/**
 * Poseidon di luar sirkuit (JS), untuk menyiapkan input uji.
 *
 * T2 memakai Poseidon sebagai bentuk commitment DI DALAM sirkuit -- berbeda
 * dari commitment_X = SHA256(record_hash || institution_X) milik ADR-3. Kedua
 * sistem berdampingan dan tidak boleh disamakan. Nilai yang dihitung di sini
 * harus identik dengan `Poseidon(2)` di circom; uji `test-zkp.js` menutup
 * kemungkinan keduanya menyimpang.
 */

const { buildPoseidon } = require('circomlibjs');

let janji = null;

function dapatPoseidon() {
  if (!janji) janji = buildPoseidon();
  return janji;
}

/** Poseidon atas dua elemen field, dikembalikan sebagai string desimal. */
async function poseidon2(a, b) {
  const poseidon = await dapatPoseidon();
  const h = poseidon([BigInt(a), BigInt(b)]);
  return poseidon.F.toString(h);
}

module.exports = { poseidon2 };
