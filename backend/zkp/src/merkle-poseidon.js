'use strict';

/**
 * Merkle Poseidon (JS) untuk menyiapkan input sirkuit `no_match.circom` (F4.7).
 *
 * Daun = Poseidon(3)([kategori, instansi, tanggal]) -- HARUS identik dengan
 * `Poseidon(3)` di sirkuit. Struktur pohon biner: induk = Poseidon(2)([kiri,
 * kanan]); `sel[j] = 0` berarti node saat itu anak kiri. Pohon dibangun
 * bottom-up dan bukti inklusi diambil per indeks.
 *
 * Jangan menyamakan hash Poseidon ini dengan SHA-256 milik ADR-3 / `lib/merkle.js`;
 * keduanya dipakai untuk tujuan berbeda dan tidak boleh dicampur.
 */

const { buildPoseidon } = require('circomlibjs');

let janji = null;
function dapatPoseidon() {
  if (!janji) janji = buildPoseidon();
  return janji;
}

/** Daun dari satu tuple [kategori, instansi, tanggal] -> string desimal. */
async function daunDari(tuple) {
  const poseidon = await dapatPoseidon();
  const h = poseidon([BigInt(tuple[0]), BigInt(tuple[1]), BigInt(tuple[2])]);
  return poseidon.F.toString(h);
}

/** Bangun pohon dari daftar daun (panjang wajib pangkat dua). */
async function pohonPoseidon(daun) {
  const poseidon = await dapatPoseidon();
  const F = poseidon.F;
  if (daun.length < 2 || (daun.length & (daun.length - 1)) !== 0) {
    throw new Error('jumlah daun harus pangkat dua dan >= 2: ' + daun.length);
  }
  let lapis = daun.map((d) => F.e(BigInt(d)));
  const semua = [lapis.slice()];
  while (lapis.length > 1) {
    const atas = [];
    for (let i = 0; i < lapis.length; i += 2) {
      atas.push(poseidon([lapis[i], lapis[i + 1]]));
    }
    lapis = atas;
    semua.push(lapis.slice());
  }
  return { root: F.toString(lapis[0]), lapis: semua };
}

/** Bukti inklusi (path sibling + bit sel) untuk indeks tertentu. */
async function buktiInklusi(pohon, idx) {
  const poseidon = await dapatPoseidon();
  const F = poseidon.F;
  const { lapis } = pohon;
  const path = [];
  const sel = [];
  let i = idx;
  for (let l = 0; l < lapis.length - 1; l++) {
    const sib = (i % 2 === 0) ? i + 1 : i - 1;
    path.push(F.toString(lapis[l][sib]));
    sel.push(String(i % 2));
    i = Math.floor(i / 2);
  }
  return { path, sel };
}

module.exports = { daunDari, pohonPoseidon, buktiInklusi };
