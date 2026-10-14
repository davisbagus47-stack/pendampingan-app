'use strict';

/**
 * Jembatan `access_log` -> rantai hash (F4.1, `lib/audit-chain.js`) -> pohon
 * Merkle (F4.2, `lib/merkle.js`): bukti inklusi T1 untuk satu entri log
 * (F4.3, FR-8.1 dan FR-8.2).
 *
 * Kenapa ada modul ini
 * --------------------
 * Rantai audit sengaja ditulis terhadap bentuk entri generik
 * `{seq, ts, actor, action, resource, outcome, detail}` supaya bisa diuji
 * tanpa database. Tabel `access_log` menyimpan bentuk yang berbeda
 * (`actor_type`, `actor_id`, `params`, `result`, `endpoint`, ...). Tanpa satu
 * pemetaan yang eksplisit, dua pihak yang "menghitung ulang" rantai akan
 * memakai aturan berbeda dan tidak ada bukti yang cocok. Pemetaan itu ada di
 * `bidangDariBaris()` -- satu-satunya tempat diubahnya, dan alasannya dicatat
 * di situ.
 *
 * Yang di-hash, dan yang TIDAK
 * ----------------------------
 * `id` baris access_log ikut masuk `detail.access_log_id` supaya identitas
 * baris benar-benar terikat ke `entry_hash` -- kalau tidak, bukti hanya
 * membuktikan "ada entri berbentuk ini", bukan "baris dengan id X ada". Kolom
 * yang tidak ikut (mis. `ip`) sengaja dibuang dari hash karena ia bergantung
 * jaringan, bukan tindakan; dan kolom baru yang ditambahkan ke tabel tidak
 * boleh diam-diam mengubah hash entri lama.
 *
 * Keterbatasan yang harus ditulis jujur (lihat juga F4.1 batasan)
 * ---------------------------------------------------------------
 * Modul ini membuktikan bahwa sebuah daun (= hash dari `entry_hash`) berada
 * dalam pohon. Ia TIDAK membuktikan bahwa rantai prefix yang menghasilkan
 * `entry_hash` itu lengkap atau tidak dipotong di ekor; itu tugas `expectedHead`
 * di F4.1 dan akar yang di-anchor (F4.2, `audit_anchor`). `anchor` yang
 * diberikan di sini hanya mempersempit pohon ke batch yang sudah di-anchor,
 * supaya akar bukti sama dengan akar yang tersimpan.
 *
 * Seluruh modul ini murni: tidak menyentuh database maupun jaringan. Pemetaan
 * SQL ada di pemanggil (route / tools).
 */

const A = require('./audit-chain.js');
const M = require('./merkle.js');

/** Nilai `action` untuk setiap entri log akses. Konstan: satu tabel = satu aksi. */
const AKSI_AKSES = 'access';

function keIso(ts) {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string' && ts !== '') return ts;
  return new Date(ts).toISOString();
}

function keAngka(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "agency:12", atau "agency:anon" bila actor_id kosong. */
function aktorDariBaris(row) {
  const tipe = row.actor_type === null || row.actor_type === undefined
    ? 'anon' : String(row.actor_type);
  const id = keAngka(row.actor_id);
  return tipe + ':' + (id === null ? 'anon' : String(id));
}

/**
 * Pemetaan satu baris `access_log` -> bidang entri rantai.
 *
 * Dipakai saat membangun rantai untuk membuktikan inklusi DAN saat verifikasi
 * di sisi klien, jadi satu-satunya sumber kebenaran bentuk. Bila kolom tabel
 * berubah, ubah di sini dan naikkan `AUDIT_CHAIN_VERSION` -- mengubah mapping
 * tanpa menaikkan versi membuat entri lama "tidak cocok dengan isi".
 */
function bidangDariBaris(row) {
  return {
    ts: keIso(row.ts),
    actor: aktorDariBaris(row),
    action: AKSI_AKSES,
    resource: row.endpoint === null || row.endpoint === undefined ? '' : String(row.endpoint),
    outcome: row.result === null || row.result === undefined ? 'error' : String(row.result),
    detail: {
      access_log_id: keAngka(row.id),
      category: row.category === null || row.category === undefined ? null : String(row.category),
      response_rows: keAngka(row.response_rows) || 0,
      params: row.params && typeof row.params === 'object' && !Array.isArray(row.params)
        ? row.params : {},
    },
  };
}

/**
 * Rangkai seluruh baris (sudah urut `id ASC`) menjadi rantai.
 *
 * `seq` adalah POSISI 1-based, bukan `id`: BIGSERIAL bisa punya celah karena
 * transaksi yang di-rollback, sedangkan `append()` di F4.1 mewajibkan seq
 * berurutan tanpa celah. Posisi tetap stabil selama baris hanya ditambah di
 * ujung (tabel append-only), jadi bukti yang dibuat hari ini tetap sah nanti.
 */
function entriMentahDariBaris(rows) {
  return rows.map((row, i) => Object.assign({ seq: i + 1 }, bidangDariBaris(row)));
}

function daunDariRantai(chain) {
  return chain.map((e) => M.leafFromEntryHash(e.entry_hash));
}

/** Posisi (indeks 0-based) tiap `id` baris dalam daftar. */
function posisiId(rows) {
  const m = new Map();
  rows.forEach((row, i) => {
    const id = keAngka(row.id);
    if (id !== null) m.set(id, i);
  });
  return m;
}

/**
 * Akar pohon log + ringkasan, untuk menyimpan `audit_anchor` (FR-8.1).
 *
 * @param {object[]} rows baris access_log urut `id ASC`
 * @returns {{algorithm:string, leaf_count:number, root:string, head_hash:string}}
 */
function akarDariBaris(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RangeError('tidak bisa meng-anchor log kosong');
  }
  const chain = A.buildChain(entriMentahDariBaris(rows));
  const tree = M.buildTree(daunDariRantai(chain));
  return {
    algorithm: M.MERKLE_ALGORITHM,
    leaf_count: tree.leafCount,
    root: tree.root,
    head_hash: chain[chain.length - 1].entry_hash,
  };
}

/**
 * Pilih anchor yang menutupi posisi target.
 *
 * `anchors` adalah baris `audit_anchor` dengan `from_seq`/`to_seq` posisi
 * (1-based). Yang dipilih: anchor dengan `to_seq` terbesar yang masih menutupi
 * posisi, supaya bukti dipotong ke batch terbaru yang akarnya tersimpan.
 */
function pilihAnchor(anchors, pos1) {
  let terbaik = null;
  for (const a of anchors || []) {
    const dari = keAngka(a.from_seq);
    const sampai = keAngka(a.to_seq);
    if (dari === null || sampai === null) continue;
    if (pos1 >= dari && pos1 <= sampai) {
      if (!terbaik || sampai > keAngka(terbaik.to_seq)) terbaik = a;
    }
  }
  return terbaik;
}

/**
 * Bukti inklusi untuk satu `access_log.id`.
 *
 * @param {object[]} rows baris access_log LENGKAP urut `id ASC`
 * @param {number|string} id `access_log.id` yang diminta
 * @param {object} [opsi]
 * @param {object[]} [opsi.anchors] baris `audit_anchor`
 * @returns {object|null} bukti, atau null bila id tidak ada
 */
function buktiUntukId(rows, id, opsi) {
  const opts = opsi || {};
  const target = keAngka(id);
  if (target === null || !Array.isArray(rows)) return null;

  const peta = posisiId(rows);
  const pos0 = peta.has(target) ? peta.get(target) : -1;
  if (pos0 < 0) return null;
  const pos1 = pos0 + 1;

  const anchor = pilihAnchor(opts.anchors, pos1);
  const potong = anchor ? keAngka(anchor.to_seq) : rows.length;
  const prefix = rows.slice(0, potong);

  const chain = A.buildChain(entriMentahDariBaris(prefix));
  const tree = M.buildTree(daunDariRantai(chain));
  const proof = M.inclusionProof(tree, pos0);
  const entri = chain[pos0];

  return {
    algorithm: M.MERKLE_ALGORITHM,
    access_log_id: target,
    seq: pos1,
    entry: {
      seq: entri.seq,
      ts: entri.ts,
      actor: entri.actor,
      action: entri.action,
      resource: entri.resource,
      outcome: entri.outcome,
      detail: entri.detail,
      prev_hash: entri.prev_hash,
      entry_hash: entri.entry_hash,
    },
    leaf: proof.leaf,
    index: proof.index,
    proof: proof.proof,
    root: proof.root,
    leafCount: proof.leafCount,
    anchor: anchor || null,
    anchored: !!anchor,
  };
}

/**
 * Verifikasi bukti dari `buktiUntukId()` (atau dari endpoint).
 *
 * Urutan pemeriksaan mengikuti rantai kepercayaan: (1) `entry_hash` cocok
 * dengan isi entri + `prev_hash`, lalu (2) daun cocok dengan `entry_hash`,
 * baru (3) bukti Merkle menggiring daun itu ke `root`. Bila langkah 1
 * dilewati, entri palsu dengan `leaf`/`root` konsisten tetap akan lolos.
 *
 * @returns {boolean}
 */
function verifikasiBukti(hasil) {
  if (!hasil || typeof hasil !== 'object' || !hasil.entry) return false;
  const e = hasil.entry;
  if (typeof e.entry_hash !== 'string' || typeof e.prev_hash !== 'string') return false;

  const dihitung = A.computeEntryHash(e, e.prev_hash);
  if (dihitung !== e.entry_hash) return false;

  // (2) Bila bukti diklaim ter-anchor, akarnya harus sama dengan akar yang
  // tersimpan. Tanpa pemeriksaan ini, entri yang diubah menghasilkan pohon
  // baru yang tetap "verifyInclusion true terhadap dirinya sendiri" -- bukti
  // yang lolos verifikasi tapi tidak tertaut ke anchor mana pun.
  if (hasil.anchored && hasil.anchor && hasil.anchor.root !== hasil.root) return false;

  const daun = M.leafFromEntryHash(e.entry_hash);
  if (daun !== hasil.leaf) return false;

  return M.verifyInclusion(hasil.root, daun, hasil.proof);
}

module.exports = {
  AKSI_AKSES,
  bidangDariBaris,
  entriMentahDariBaris,
  posisiId,
  akarDariBaris,
  pilihAnchor,
  buktiUntukId,
  verifikasiBukti,
};
