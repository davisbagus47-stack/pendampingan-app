'use strict';

/**
 * Anchor per-record SINKRON (F3.4 lanjutan).
 *
 * `lib/anchor-chain.js` menghasilkan `tandai(baris)` yang benar untuk satu
 * record, tetapi punya dua sifat yang aman untuk worker CLI dan berbahaya
 * untuk web server:
 *
 *   1. Ia membangun `Wallet` tanpa pengelolaan nonce bersama. Worker CLI
 *      memproses satu baris demi satu, jadi nonce selalu berurutan. Dua
 *      permintaan HTTP yang tiba bersamaan akan membaca nonce yang sama dan
 *      salah satunya ditolak node.
 *   2. Setiap panggilan membuat provider+kontrak baru; itu mahal untuk
 *      server yang hidup lama.
 *
 * Modul ini menutup keduanya:
 *
 *   - `penanda` (provider + wallet + kontrak) dibangun SEKALI dan dipakai
 *     ulang, dan
 *   - semua pengiriman lewat `berantre`, sebuah antrean serial. Selama satu
 *     transaksi dijalankan sampai `wait()`, tidak ada pengiriman lain, jadi
 *     nonce tidak pernah bentrok.
 *
 * `tandai` dari `anchor-chain` sudah menangani normalisasi commitment,
 * hash kategori, `staticCall` pra-simulasi, pemilihan `anchor`/`supersede`,
 * dan peringkasan galat. Modul ini sengaja tidak mengulang satu pun dari itu;
 * ia hanya menambahkan penjadwalan.
 *
 * Kontrak `anchorkan`:
 *   { ok: true,  tx_hash }        transaksi terkirim dan receipt tergali
 *   { ok: false, error, ... }     gagal; `tersedia:false` berarti belum
 *                                 dikonfigurasi (outbox tetap `pending`,
 *                                 worker bisa menyapunya nanti)
 */

const anchorChain = require('./anchor-chain');

/**
 * Rantai promise yang membuat pengiriman berurutan.
 *
 * `berantre(fn)` mengembalikan hasil/rejection `fn` apa adanya kepada
 * pemanggil, tetapi rantai internalnya selalu "pulih" (resolve) supaya satu
 * kegagalan tidak menghentikan pengiriman berikutnya.
 */
let rantai = Promise.resolve();

/**
 * Penanda bersama. Dibangun malas pada pengiriman pertama; `deps.kontrak`
 * (jalur uji) tidak pernah di-cache supaya tiap uji memakai kontraknya sendiri.
 */
let penanda = null;

/** Jalankan `fn` setelah semua pengiriman sebelumnya selesai. */
function berantre(fn) {
  const hasil = rantai.then(() => fn());
  rantai = hasil.then(() => undefined, () => undefined);
  return hasil;
}

/** Callback `kategori`/`leluhur` yang membaca nilainya dari baris itu sendiri. */
function penolongKategori(b) {
  return (b && b.jenis_sasaran) || null;
}

function penolongLeluhur(b) {
  if (!b || !b.old_record_id) return null;
  return { record_id: String(b.old_record_id), version: Number(b.old_version) };
}

/**
 * Rakit penanda dari kontrak yang sudah ada (tanpa env).
 *
 * @param {object} d `{ kontrak, krypto }`
 * @returns {function}
 */
function penandaDariKontrak(d) {
  return anchorChain.buatPenanda({
    kontrak: d.kontrak,
    krypto: d.krypto,
    kategori: penolongKategori,
    leluhur: penolongLeluhur,
  });
}

/**
 * Ambil penanda bersama, atau bangun dari env bila belum ada.
 *
 * @param {object} env variabel lingkungan
 * @param {object} d `{ kontrak, provider, krypto }`
 */
function ambilPenanda(env, d) {
  if (d.kontrak) return penandaDariKontrak(d);
  if (!penanda) {
    penanda = anchorChain.buatPenandaDariEnv(env, {
      provider: d.provider,
      krypto: d.krypto,
      kategori: penolongKategori,
      leluhur: penolongLeluhur,
    });
  }
  return penanda;
}

/** Apakah prasarana chain cukup lengkap untuk meng-anchor. */
function tersedia(env) {
  return anchorChain.tersedia(env || process.env);
}

/**
 * Anchor satu record sekarang, berurutan terhadap pengiriman lain.
 *
 * @param {object} baris `{ record_id, version, commitment, jenis_sasaran,
 *   supersedes_id, old_record_id, old_version }`
 * @param {object} [deps] `{ env, kontrak, provider, krypto }`
 * @returns {Promise<{ok:boolean, tx_hash?:string, error?:string, tersedia?:boolean}>}
 */
async function anchorkan(baris, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  if (!anchorChain.tersedia(env)) {
    return {
      ok: false,
      tersedia: false,
      error: 'chain belum dikonfigurasi ' +
        '(ANCHOR_RPC_URL, ANCHOR_CONTRACT, ANCHOR_PRIVATE_KEY)',
    };
  }
  let tanda;
  try {
    tanda = ambilPenanda(env, d);
  } catch (e) {
    return { ok: false, tersedia: true, error: e && e.message ? e.message : String(e) };
  }
  return berantre(() => tanda(baris));
}

/** Kosongkan penanda & antrean. Untuk uji; tidak dipanggil alur produksi. */
function aturUlang() {
  penanda = null;
  rantai = Promise.resolve();
}

module.exports = {
  tersedia,
  anchorkan,
  berantre,
  aturUlang,
  penandaDariKontrak,
};
