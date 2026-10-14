'use strict';

/**
 * Access log berantai hash (F4.1, FR-7.3).
 *
 * Tujuannya sempit dan tidak ambisius: membuktikan bahwa riwayat permintaan
 * tidak pernah diubah diam-diam. Setiap entri memuat `prev_hash` dari entri
 * sebelumnya, jadi mengubah satu entri di tengah merusak semua entri setelahnya.
 *
 *     entry_hash[n] = SHA-256( JCS( { ...bidang entri, prev_hash, chain_version} ) )
 *
 * Kolom `entry_hash` dan `prev_hash` di tabel `access_log` menyimpan nilai ini.
 * Tabelnya sendiri sudah append-only di sisi database (F1.5), dan RLS
 * menolak UPDATE/DELETE. Modul ini adalah lapisan kedua: ia tidak bergantung
 * pada database sama sekali, jadi tetap berguna sebagai bukti yang bisa
 * dihitung ulang oleh pihak ketiga dari salinan log.
 *
 * --- Batasan yang harus ditulis jujur di laporan ---
 *
 * Rantai hash TIDAK bisa mendeteksi pemotongan di ujung. Menghapus 10 entri
 * terakhir dari rantai yang utuh menghasilkan rantai yang tetap valid, karena
 * tidak ada yang tersisa untuk bertentangan. Yang menutup celah ini adalah
 * `expectedHead` -- akar yang sudah di-anchor secara berkala (F4.2). Tanpa
 * anchor, rantai hash hanya membuktikan "tidak diubah di tengah", bukan
 * "tidak ada yang dihapus".
 *
 * Modul ini sengaja tidak menyentuh database. Seluruhnya bisa diuji tanpa
 * PostgreSQL.
 */

const crypto = require('crypto');
const { canonicalize } = require('./jcs');

/** Naikkan hanya kalau algoritma berubah, bukan kalau bug diperbaiki. */
const AUDIT_CHAIN_VERSION = 1;

/** `prev_hash` entri pertama: 64 karakter nol. */
const GENESIS_PREV = '0'.repeat(64);

/**
 * Bidang yang ikut dihitung hash. Daftar ini eksplisit dan berurutan; JCS
 * sudah mengurutkan kunci, tapi menyebutkannya di sini membuat jelas bidang
 * apa saja yang menentukan integritas, dan apa yang tidak.
 *
 * `detail` ikut di-hash dan boleh berupa objek bersarang. Kredensial tidak
 * boleh masuk ke sini -- lihat catatan di `lib/audit-chain.js` pada FR-4.4.
 */
const HASHED_FIELDS = ['seq', 'ts', 'actor', 'action', 'resource', 'outcome', 'detail'];

/** Kunci yang boleh ada pada entri rantai. Selain itu, data tidak terautentikasi. */
const CHAIN_KEYS = new Set([...HASHED_FIELDS, 'prev_hash', 'entry_hash']);

/**
 * Bentuk kanonik satu entri: hanya kunci yang masuk hash.
 *
 * Dipakai saat memverifikasi baris yang diambil dari database, karena baris
 * database membawa kolom tambahan (`id`, `institution_id`, `created_at`, ...)
 * yang memang tidak masuk hitungan hash. Memproyeksikan dulu membuat
 * `verifyChain` bisa menolak kunci asing dengan tegas.
 */
function pickChainFields(row) {
  const out = {};
  for (const f of HASHED_FIELDS) out[f] = row[f] === undefined ? null : row[f];
  out.prev_hash = row.prev_hash;
  out.entry_hash = row.entry_hash;
  return out;
}

/** Hash satu entri diberikan `prev_hash`. Fungsi murni, tanpa efek samping. */
function computeEntryHash(entry, prevHash) {
  const material = { chain_version: AUDIT_CHAIN_VERSION, prev_hash: prevHash };
  for (const f of HASHED_FIELDS) {
    const v = entry[f];
    material[f] = v === undefined ? null : v;
  }
  return crypto.createHash('sha256').update(canonicalize(material), 'utf8').digest('hex');
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * Rangkai satu entri baru pada ujung log.
 *
 * `prevEntry` boleh null (entri pertama) atau entri yang sudah dirangkai.
 * `entry.seq` TIDAK ditebak di sini: pemanggil yang tahu urutan karena
 * retrieving dan menghitung nomor urut adalah pekerjaan database, bukan
 * pekerjaan hashing. Yang diperiksa modul ini hanya bahwa `seq` benar-benar
 * satu setelah `prevEntry.seq`, supaya celah urutan tidak bisa diam-diam
 * disisipkan.
 */
function append(prevEntry, entry) {
  const prevHash = prevEntry ? prevEntry.entry_hash : GENESIS_PREV;
  const expectedSeq = prevEntry ? prevEntry.seq + 1 : 1;

  if (!Number.isInteger(entry.seq)) {
    throw new TypeError('seq harus integer');
  }
  if (entry.seq !== expectedSeq) {
    throw new RangeError(
      'seq harus ' + expectedSeq + ', dapat ' + entry.seq + ' (celah urutan tidak diperbolehkan)'
    );
  }
  if (!entry.ts || typeof entry.ts !== 'string') {
    throw new TypeError('ts harus string ISO-8601');
  }
  if (!entry.actor || typeof entry.actor !== 'string') {
    throw new TypeError('actor wajib diisi');
  }
  if (!entry.action || typeof entry.action !== 'string') {
    throw new TypeError('action wajib diisi');
  }
  if (entry.outcome === undefined || entry.outcome === null) {
    throw new TypeError('outcome wajib diisi');
  }

  const out = {};
  for (const f of HASHED_FIELDS) out[f] = entry[f] === undefined ? null : entry[f];
  out.prev_hash = prevHash;
  out.entry_hash = computeEntryHash(out, prevHash);
  return out;
}

/** Bangun seluruh log dari daftar entri mentah (tanpa `prev_hash`/`entry_hash`). */
function buildChain(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries harus array');
  const chain = [];
  let prev = null;
  for (const e of entries) {
    const chained = append(prev, e);
    chain.push(chained);
    prev = chained;
  }
  return chain;
}

/**
 * Periksa sebuah rantai.
 *
 * Mengembalikan objek hasil, tidak pernah melempar error: pemanggil yang
 * memutuskan apa yang dilakukan dengan laporan.
 *
 *   { ok, length, brokenAt, reason, head }
 *
 * `expectedHead` opsional. Bila diberikan, rantai yang dipotong di ujung akan
 * terdeteksi -- itu satu-satunya cara mendeteksi pemotongan tanpa anchor.
 */
function verifyChain(chain, options) {
  const opts = options || {};

  if (!Array.isArray(chain)) {
    return { ok: false, length: 0, brokenAt: 0, reason: 'chain harus array', head: null };
  }
  if (chain.length === 0) {
    if (opts.expectedHead && opts.expectedHead !== GENESIS_PREV) {
      return { ok: false, length: 0, brokenAt: 0, reason: 'chain kosong tapi head diharapkan bukan genesis', head: null };
    }
    return { ok: true, length: 0, brokenAt: -1, reason: null, head: GENESIS_PREV };
  }

  let prevHash = GENESIS_PREV;
  let prevSeq = 0;

  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];

    if (!e || typeof e !== 'object') {
      return { ok: false, length: chain.length, brokenAt: i, reason: 'entri bukan object', head: prevHash };
    }

    // Kunci di luar whitelist berarti ada data yang tidak masuk hitungan hash.
    // Kalau dibiarkan, seseorang bisa menitipkan informasi pada entri log
    // tanpa membuat jejaknya terikat ke rantai.
    const asing = Object.keys(e).filter((k) => !CHAIN_KEYS.has(k));
    if (asing.length > 0) {
      return {
        ok: false, length: chain.length, brokenAt: i,
        reason: 'kunci tidak dikenal pada entri: ' + asing.join(', ') +
          ' (data ini tidak masuk hitungan hash)',
        head: prevHash,
      };
    }

    if (e.prev_hash !== prevHash) {
      return {
        ok: false, length: chain.length, brokenAt: i,
        reason: 'prev_hash tidak cocok: diharapkan ' + prevHash + ', dapat ' + e.prev_hash,
        head: prevHash,
      };
    }
    if (e.seq !== prevSeq + 1) {
      return {
        ok: false, length: chain.length, brokenAt: i,
        reason: 'seq melompat: diharapkan ' + (prevSeq + 1) + ', dapat ' + e.seq,
        head: prevHash,
      };
    }
    if (!isHex64(e.entry_hash)) {
      return { ok: false, length: chain.length, brokenAt: i, reason: 'entry_hash bukan hex64', head: prevHash };
    }

    // Hash dihitung ulang dari isi entri. Inilah yang membuat perubahan pada
    // `actor`, `ts`, atau `detail` terdeteksi, bukan hanya perubahan pada
    // kolom prev_hash.
    const recomputed = computeEntryHash(e, prevHash);
    if (recomputed !== e.entry_hash) {
      return {
        ok: false, length: chain.length, brokenAt: i,
        reason: 'entry_hash tidak cocok dengan isi entri: diharapkan ' + recomputed + ', dapat ' + e.entry_hash,
        head: prevHash,
      };
    }

    prevHash = e.entry_hash;
    prevSeq = e.seq;
  }

  if (opts.expectedHead && opts.expectedHead !== prevHash) {
    return {
      ok: false, length: chain.length, brokenAt: chain.length - 1,
      reason: 'head tidak cocok dengan anchor: diharapkan ' + opts.expectedHead + ', dapat ' + prevHash,
      head: prevHash,
    };
  }

  return { ok: true, length: chain.length, brokenAt: -1, reason: null, head: prevHash };
}

module.exports = {
  AUDIT_CHAIN_VERSION,
  GENESIS_PREV,
  HASHED_FIELDS,
  CHAIN_KEYS,
  pickChainFields,
  computeEntryHash,
  append,
  buildChain,
  verifyChain,
};
