'use strict';

/**
 * Pohon Merkle untuk log audit (F4.2) dan bukti inklusi (F4.3).
 *
 * Keputusan yang dikunci di sini:
 *
 *  1. SHA-256, bukan keccak256. ADR-3 sudah mengunci commitment sebagai
 *     SHA-256, dan F0.4 mengunci `record_hash` sebagai SHA-256. Kalau pohon
 *     memakai fungsi hash ketiga, instansi lain butuh satu pustaka lagi
 *     (pysha3/eth-hash) dan satu differential test lagi, tanpa tambahan nilai
 *     ilmiah. Karena blockchain bersifat advisory -- bukan gerbang akses --
 *     tidak ada kebutuhan kompatibilitas Ethereum untuk membuktikan inklusi.
 *  2. Pasangan diurutkan (Bitcoin-style). Verifier tidak perlu tahu node mana
 *     yang kiri dan mana yang kanan; ia cukup mengurutkan lagi. Bukti yang lebih
 *     pendek dan lebih sulit disalahbaca.
 *  3. Pemisahan domain byte 0x00 (leaf) dan 0x01 (node), gaya RFC 6962.
 *     Tanpa ini, daun yang isinya 64 byte hash bisa bertabrakan dengan node
 *     internal dan membuka serangan second-preimage.
 *
 * Semua yang keluar dari modul ini adalah heksadesimal huruf kecil, 64 karakter.
 * Tidak ada satu pun fungsi di sini yang menyentuh database atau jaringan, jadi
 * seluruhnya bisa diuji tanpa PostgreSQL.
 */

const crypto = require('crypto');

/** Penanda versi. Naikkan hanya kalau algoritma berubah, bukan kalau bug diperbaiki. */
const MERKLE_ALGORITHM = 'sha256-sorted-pairs-v1';

/** Hash awal rantai: 64 karakter nol. */
const ZERO_HASH = '0'.repeat(64);

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Leaf: data mentah apa pun. */
function hashLeaf(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return sha256(LEAF_PREFIX, buf);
}

/** Node internal: gabungan dua anak yang sudah diurutkan. */
function hashNode(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  // Urutkan sebagai byte, bukan leksikografis string heksa -- keduanya memberi
  // hasil sama untuk hex lowercase, tapi Buffer membuat niatnya eksplisit.
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(NODE_PREFIX, lo, hi);
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

function toBuffer(hex) {
  if (!isHex64(hex)) throw new TypeError('harus hex64 huruf kecil: ' + hex);
  return Buffer.from(hex, 'hex');
}

/**
 * Bangun pohon lengkap dari daftar hash daun (sudah hex64).
 *
 * Bentuk yang dikembalikan:
 *   { algorithm, leafCount, root, levels }
 * dengan `levels[0]` = daun, `levels[n-1]` = akar. Setiap level punya
 * `ceil(len/2)` elemen; level terakhir yang ganjil mengulang hash terakhirnya
 * sendiri, persis seperti Bitcoin.
 *
 * `levels` sengaja dikembalikan: hanya diperlukan untuk membuat bukti inklusi
 * pada pohon yang sama, tanpa membangun ulang.
 */
function buildTree(leafHashes) {
  if (!Array.isArray(leafHashes)) throw new TypeError('leafHashes harus array');
  for (const h of leafHashes) {
    if (!isHex64(h)) throw new TypeError('daun bukan hex64: ' + h);
  }

  if (leafHashes.length === 0) {
    throw new RangeError('pohon tanpa daun tidak punya akar');
  }

  const levels = [leafHashes.map((h) => h.toLowerCase())];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const up = [];
    for (let i = 0; i < below.length; i += 2) {
      const left = below[i];
      // Node terakhir yang ganjil diulang dengan dirinya sendiri.
      const right = i + 1 < below.length ? below[i + 1] : left;
      up.push(hashNode(left, right).toString('hex'));
    }
    levels.push(up);
  }

  return {
    algorithm: MERKLE_ALGORITHM,
    leafCount: leafHashes.length,
    root: levels[levels.length - 1][0],
    levels,
  };
}

/** Benar kalau objek ini hasil `buildTree`, bukan daftar daun mentah. */
function isTree(x) {
  return Boolean(x) && Array.isArray(x.levels) && Number.isInteger(x.leafCount);
}

/**
 * Bukti inklusi untuk daun pada indeks tertentu.
 *
 * Menerima daftar daun mentah atau pohon yang sudah dibangun. Menerima pohon
 * penting untuk pengukuran: membangun ulang pohon untuk setiap daun pada log
 * beribu-ribu entri akan jadi mahal, dan `levels` sudah tersedia gratis.
 *
 * Bukti adalah daftar hash saudara pada setiap level, dari bawah ke atas --
 * cukup untuk menghitung ulang akar tanpa perlu daun lain.
 */
function inclusionProof(leafHashesOrTree, index) {
  const tree = isTree(leafHashesOrTree) ? leafHashesOrTree : buildTree(leafHashesOrTree);

  if (!Number.isInteger(index) || index < 0 || index >= tree.leafCount) {
    throw new RangeError('indeks di luar jangkauan: ' + index);
  }

  const proof = [];
  let i = index;
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const row = tree.levels[level];
    let siblingIndex;
    if (i % 2 === 0) {
      // Level ganjil: node terakhir tidak punya saudara dan diulang saat
      // membangun level di atasnya. Saudaranya adalah dirinya sendiri.
      siblingIndex = i + 1 < row.length ? i + 1 : i;
    } else {
      siblingIndex = i - 1;
    }
    proof.push(row[siblingIndex]);
    i = Math.floor(i / 2);
  }

  return {
    algorithm: MERKLE_ALGORITHM,
    leaf: tree.levels[0][index],
    index,
    proof,
    root: tree.root,
    leafCount: tree.leafCount,
  };
}

/**
 * Verifikasi bukti inklusi. Mengembalikan true/false, tidak pernah melempar
 * error untuk masukan rusak -- pemanggil yang memutuskan apa yang dilakukan.
 */
function verifyInclusion(root, leaf, proof) {
  if (!isHex64(root) || !isHex64(leaf)) return false;
  if (!Array.isArray(proof)) return false;

  let acc = leaf;
  for (const sibling of proof) {
    if (!isHex64(sibling)) return false;
    acc = hashNode(acc, sibling).toString('hex');
  }
  return acc === root;
}

/** Bentukkan hash daun dari isi mentah apa pun. */
function leafOf(data) {
  return hashLeaf(data).toString('hex');
}

/**
 * Hash daun dari satu entri log yang sudah punya `entry_hash` sendiri.
 * Daun pohon adalah rantai hash, bukan isi mentah, supaya apa yang di-anchor
 * persis apa yang sudah diverifikasi chaining.
 */
function leafFromEntryHash(entryHashHex) {
  return hashLeaf(toBuffer(entryHashHex)).toString('hex');
}

/**
 * Pecah daftar hash daun menjadi batch dan hitung akar tiap batch.
 * Ini yang di-anchor secara berkala (FR-8.1): jumlah anchored root tetap kecil
 * dan tidak perlu membocorkan ukuran log.
 */
function batchRoots(leafHashes, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize harus integer >= 1');
  }
  const out = [];
  for (let i = 0; i < leafHashes.length; i += batchSize) {
    const batch = leafHashes.slice(i, i + batchSize);
    out.push({ from: i, to: i + batch.length - 1, count: batch.length, root: buildTree(batch).root });
  }
  return out;
}

module.exports = {
  MERKLE_ALGORITHM,
  ZERO_HASH,
  hashLeaf,
  hashNode,
  buildTree,
  inclusionProof,
  verifyInclusion,
  leafOf,
  leafFromEntryHash,
  batchRoots,
};
