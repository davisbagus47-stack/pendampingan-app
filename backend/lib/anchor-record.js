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
 *   { ok: true,  tx_hash }                    transaksi terkirim & receipt tergali
 *   { ok: true,  tx_hash, belum_konfirmasi }  disiarkan (mode kilat) atau sudah
 *                                             disiarkan & receipt belum ada;
 *                                             finalisasi oleh worker/cron
 *   { ok: false, error, ... }                 gagal; `tersedia:false` berarti
 *                                             belum dikonfigurasi (outbox tetap
 *                                             `pending`, worker bisa menyapu nanti)
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

/**
 * Penanda mode KILAT (hybrid): menyiarkan tanpa menunggu receipt. Dipisah dari
 * `penanda` supaya jalur sinkron (harus konfirmasi) dan jalur kilat (balas
 * cepat, finalisasi oleh worker) tidak saling mengubah perilaku. Keduanya
 * tetap lewat `berantre` yang sama, jadi nonce tetap aman.
 */
let penandaKilat = null;

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
 * @param {object} d `{ kontrak, krypto, kilat }`
 * @returns {function}
 */
function penandaDariKontrak(d) {
  return anchorChain.buatPenanda({
    kontrak: d.kontrak,
    krypto: d.krypto,
    kategori: penolongKategori,
    leluhur: penolongLeluhur,
    kilat: d.kilat,
    praSimulasi: d.praSimulasi,
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

/**
 * Ambil penanda mode kilat, atau bangun dari env bila belum ada.
 *
 * @param {object} env variabel lingkungan
 * @param {object} d `{ kontrak, provider, krypto }`
 */
function ambilPenandaKilat(env, d) {
  if (d.kontrak) return penandaDariKontrak(Object.assign({}, d, { kilat: true }));
  if (!penandaKilat) {
    penandaKilat = anchorChain.buatPenandaDariEnv(env, {
      provider: d.provider,
      krypto: d.krypto,
      kategori: penolongKategori,
      leluhur: penolongLeluhur,
      kilat: true,
    });
  }
  return penandaKilat;
}

/** Apakah prasarana chain cukup lengkap untuk meng-anchor. */
function tersedia(env) {
  return anchorChain.tersedia(env || process.env);
}

/**
 * Anchor satu record sekarang, berurutan terhadap pengiriman lain.
 *
 * @param {object} baris `{ record_id, version, commitment, jenis_sasaran,
 *   supersedes_id, old_record_id, old_version, tx_hash }`
 * @param {object} [deps] `{ env, kontrak, provider, krypto }`
 * @param {object} [opsi] `{ kilat }` -- kilat: siarkan tanpa menunggu receipt
 * @returns {Promise<{ok:boolean, tx_hash?:string, belum_konfirmasi?:boolean, error?:string, tersedia?:boolean}>}
 */
async function anchorkan(baris, deps, opsi) {
  const d = deps || {};
  const env = d.env || process.env;
  const kilat = !!(opsi && opsi.kilat);
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
    tanda = kilat ? ambilPenandaKilat(env, d) : ambilPenanda(env, d);
  } catch (e) {
    return { ok: false, tersedia: true, error: e && e.message ? e.message : String(e) };
  }
  return berantre(() => tanda(baris));
}

/** Kosongkan penanda & antrean. Untuk uji; tidak dipanggil alur produksi. */
function aturUlang() {
  penanda = null;
  penandaKilat = null;
  rantai = Promise.resolve();
}

module.exports = {
  tersedia,
  anchorkan,
  berantre,
  aturUlang,
  penandaDariKontrak,
};
