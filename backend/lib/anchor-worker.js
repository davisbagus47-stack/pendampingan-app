'use strict';

/**
 * Anchor worker (F3.4) -- logika MURNI, tanpa database, tanpa blockchain.
 *
 * Yang dipegang modul ini hanyalah mesin status baris `chain_outbox`:
 * kapan sebuah baris pantas diproses, apa yang terjadi kalau percobaan
 * anchor berhasil, dan apa yang terjadi kalau gagal (jadwal ulang dengan
 * backoff, atau terminal `failed` setelah `MAKS_CUBA` percobaan). Semua
 * keputusan diuji tanpa prasarana; yang tidak bisa diuji di sini adalah
 * koneksi ke database dan panggilan ke contract -- keduanya di-suntik dari
 * luar, sehingga F3.4 maju meski Foundry (rantai) belum terpasang.
 *
 * ---------------------------------------------------------------------------
 * Model status (keputusan F3.4)
 * ---------------------------------------------------------------------------
 *
 *   pending   Belum pernah berhasil. `next_retry_at = NULL` berarti baru lahir
 *             dan boleh diproses sekarang; bukan NULL berarti menunggu jadwal.
 *             `pending` DENGAN `tx_hash` terisi = transaksi sudah DISIARKAN
 *             (mode hybrid) tetapi belum terkonfirmasi; worker memeriksa
 *             receipt, bukan mengirim ulang.
 *   anchored  Selesai: `tx_hash` + `anchored_at` terisi. Tidak pernah dipilih
 *             lagi. Idempotensi ganda (AT-05): kunci UNIQUE outbox menjamin
 *             satu baris per (record_id, version), pick hanya mengambil
 *             `pending`, dan contract (FR-5.3) menolak pasangan yang sudah
 *             pernah dicatat -- jadi dua pekerja yang saling berebut tidak
 *             akan menggandakan anchor, hanya satu yang menang.
 *   failed    Percobaan habis (attempts >= MAKS_CUBA). Terminal: dikeluarkan
 *             dari pemilihan, menunggu rekonsiliasi/peringatan dashboard
 *             (FR-R.2). `next_retry_at` dikosongkan supaya tidak pernah
 *             terpilih lagi.
 *   skipped   Tidak akan di-anchor (dipesankan untuk rekonsiliasi/redaksi di
 *             masa depan; tidak diisi oleh worker ini).
 *
 * Selama masa retry baris TETAP `pending`; `attempts` dan `next_retry_at`
 * yang mencatat riwayat. Itu yang membuat partial index `idx_outbox_pending`
 * tetap berguna: baris yang dijadwalkan ulang tidak perlu pindah status.
 *
 * ---------------------------------------------------------------------------
 * Backoff (keputusan F3.4)
 * ---------------------------------------------------------------------------
 *
 *   tunda(coba) = min(TUNDA_MAKS, TUNDA_AWAL * GANDA^(coba - 1))
 *
 * `coba` adalah urutan KEGAGALAN (1 untuk kegagalan pertama). Bawaan:
 * TUNDA_AWAL 30 detik, GANDA 2 (eksponensial), TUNDA_MAKS 1 jam, MAKS_CUBA 6.
 * Nilai yang sama dipakai PoC testnet; angka-angka ini bisa diubah per
 * instalasi lewat parameter tanpa mengubah logika.
 */

const BAWAAN = {
  MAKS_CUBA: 6,
  TUNDA_AWAL: 30 * 1000,
  GANDA: 2,
  TUNDA_MAKS: 60 * 60 * 1000,
  BATCH: 50,
  // Jeda sebelum memeriksa ulang receipt transaksi yang SUDAH disiarkan
  // (mode hybrid) tetapi belum masuk blok. Bukan kegagalan, jadi tidak
  // menambah `attempts`.
  JEDA_KONFIRMASI: 15 * 1000,
  // Panjang `last_error` dibatasi supaya baris database tidak menggembung
  // dengan pesan galat penuh yang biasanya sama berulang.
  LAST_ERROR_MAKS: 500,
};

function angka(nilai, bawaan) {
  const n = Number(nilai);
  return Number.isFinite(n) && n > 0 ? n : bawaan;
}

function aturanDari(o) {
  const k = o && typeof o === 'object' ? o : {};
  return {
    MAKS_CUBA: Math.floor(angka(k.MAKS_CUBA, BAWAAN.MAKS_CUBA)),
    TUNDA_AWAL: angka(k.TUNDA_AWAL, BAWAAN.TUNDA_AWAL),
    GANDA: angka(k.GANDA, BAWAAN.GANDA),
    TUNDA_MAKS: angka(k.TUNDA_MAKS, BAWAAN.TUNDA_MAKS),
    JEDA_KONFIRMASI: angka(k.JEDA_KONFIRMASI, BAWAAN.JEDA_KONFIRMASI),
    LAST_ERROR_MAKS: Math.floor(angka(k.LAST_ERROR_MAKS, BAWAAN.LAST_ERROR_MAKS)),
  };
}

/**
 * Berapa lama menunggu sebelum percobaan berikutnya, dalam milidetik.
 *
 * @param {number} coba urutan kegagalan (1 = kegagalan pertama)
 * @param {object} [aturan] penggantian nilai bawaan
 * @returns {number} milidetik tunggu
 */
function hitungTunda(coba, aturan) {
  const k = aturanDari(aturan);
  const c = Math.max(1, Math.floor(Number(coba) || 1));
  const n = k.TUNDA_AWAL * Math.pow(k.GANDA, c - 1);
  return Math.min(k.TUNDA_MAKS, n);
}

function waktuMs(nilai) {
  const n = Number(nilai);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

/**
 * Keputusan murni untuk satu baris outbox setelah satu percobaan anchor.
 *
 * Hasil anchor (`hasil`) adalah kontrak suntikan, bukan bentuk database:
 *   { ok: true, tx_hash }                    anchor diterima (receipt tergali)
 *   { ok: true, tx_hash, belum_konfirmasi }  disiarkan, receipt belum ada
 *   { ok: false, error }                     anchor ditolak/gagal
 *   { ok: false }                            gagal tanpa pesan (pesan bawaan)
 *
 * Baris yang sudah `anchored` ditolak defensif (seharusnya tidak pernah
 * terpilih). Untuk `belum_konfirmasi`, `tx_hash` DISIMPAN tetapi baris TETAP
 * `pending` dengan `next_retry_at` pendek (`JEDA_KONFIRMASI`): bukan kegagalan,
 * jadi `attempts` tidak dinaikkan -- worker/cron akan memeriksa receipt lagi.
 * Untuk kegagalan, `attempts` dinaikkan dan:
 *   - bila belum mencapai MAKS_CUBA: baris tetap `pending`, `next_retry_at`
 *     = sekarang + tunda(attempts);
 *   - bila sudah: `chain_status` menjadi `failed` terminal, `next_retry_at`
 *     dikosongkan.
 *
 * @param {object} baris baris outbox terpilih
 * @param {object} hasil jawaban panggilan anchor
 * @param {object} [o] `{ now, aturan }`
 * @returns {object} `{ putusan, kolom }` -- `kolom` berisi nilai versi baru
 *   yang boleh ditulis ke database; `putusan` salah satu dari
 *   `'diabaikan'`, `'anchored'`, `'menunggu'`, `'retry'`, `'failed'`.
 */
function putuskan(baris, hasil, o) {
  const b = baris || {};
  if (b.chain_status !== 'pending') {
    return { putusan: 'diabaikan', kolom: null };
  }
  const k = aturanDari(o && o.aturan);
  const ts = waktuMs(o && o.now);

  if (hasil && hasil.ok === true) {
    if (hasil.belum_konfirmasi && hasil.tx_hash) {
      // Disiarkan (mode kilat) atau sudah disiarkan & receipt belum ada:
      // simpan tx_hash, biarkan pending, jadwalkan pemeriksaan ulang.
      return {
        putusan: 'menunggu',
        kolom: {
          chain_status: 'pending',
          tx_hash: String(hasil.tx_hash).slice(0, 256),
          attempts: Number(b.attempts) || 0,
          next_retry_at: new Date(ts + k.JEDA_KONFIRMASI).toISOString(),
          last_error: null,
        },
      };
    }
    if (!hasil.tx_hash) {
      // Sukses tanpa tx_hash adalah cacat kontrak: meng-anchor berarti ada
      // bukti transaksi. Menandai anchored tanpa hash membuat ikatan on/off-
      // chain tidak bisa diverifikasi (FR-4.3). Perlakukan sebagai gagal.
      return {
        putusan: 'retry',
        kolom: {
          chain_status: 'pending',
          attempts: (Number(b.attempts) || 0) + 1,
          next_retry_at: new Date(ts + hitungTunda((Number(b.attempts) || 0) + 1, k)).toISOString(),
          last_error: 'anchor mengaku sukses tanpa tx_hash',
        },
      };
    }
    return {
      putusan: 'anchored',
      kolom: {
        chain_status: 'anchored',
        tx_hash: String(hasil.tx_hash).slice(0, 256),
        anchored_at: new Date(ts).toISOString(),
        last_error: null,
        next_retry_at: null,
        attempts: Number(b.attempts) || 0,
      },
    };
  }

  const coba = (Number(b.attempts) || 0) + 1;
  const galat = (hasil && hasil.error ? String(hasil.error) : 'anchor gagal')
    .slice(0, k.LAST_ERROR_MAKS);
  const terminal = coba >= k.MAKS_CUBA;
  return {
    putusan: terminal ? 'failed' : 'retry',
    kolom: {
      chain_status: terminal ? 'failed' : 'pending',
      attempts: coba,
      next_retry_at: terminal
        ? null
        : new Date(ts + hitungTunda(coba, k)).toISOString(),
      last_error: galat,
    },
  };
}

/**
 * Apakah baris pantas diproses sekarang (murni).
 *
 * `next_retry_at IS NULL` = baru lahir / sudah waktunya; bukan NULL = masih
 * menunggu. Baris `anchored`/`failed`/`skipped` tidak pernah pantas.
 *
 * @param {object} baris baris outbox
 * @param {number} [sekarang] ms, untuk pengujian tanpa Date.now()
 * @returns {boolean}
 */
function pantasDiproses(baris, sekarang) {
  const b = baris || {};
  if (b.chain_status !== 'pending') return false;
  const ts = waktuMs(sekarang);
  const jadwal = Number(b.next_retry_at);
  if (Number.isFinite(jadwal) && jadwal > 0) return jadwal <= ts;
  return true;
}

module.exports = {
  BAWAAN,
  aturanDari,
  hitungTunda,
  putuskan,
  pantasDiproses,
};