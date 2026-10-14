'use strict';

/**
 * Job rekonsiliasi (F3.5, FR-5.8) -- separuh off-chain yang bisa dibuktikan
 * tanpa Foundry.
 *
 * FR-5.8: "Job rekonsiliasi berjalan berkala dan membandingkan state off-chain
 * dengan event on-chain. Setiap selisih dilaporkan." M-3 menuntut selisih 0.
 * Perbandingan ke RANTAI belum bisa dibuktikan selama Foundry belum terpasang
 * (F2); titik itu dibiarkan sebagai seam `bandingkanRantai` di
 * `tools/worker-recon.js` dan dus dilaporkan "belum tersedia" -- bukan dihitung
 * palsu. Yang dibuktikan modul ini adalah separuh OFF-CHAIN:
 *
 *   1. Kekurangan: `records` yang tidak punya baris `chain_outbox`. Ini
 *      persis celah yang ditinggalkan hand-off F3.3 (backfill operator F3.8a
 *      tidak pernah mengantrekan outbox), dan "recon menangani" yang dimaksud
 *      catatan F3.3: rekonsiliasi yang mengisi ulang baris yang hilang.
 *   2. Yatim: baris outbox tanpa `records` yang cocok.
 *   3. Komitmen menyimpang: outbox yang commitment-nya tidak sama dengan
 *      perhitungan ulang `canonical.commitment(record_hash, institution_id)`.
 *   4. Supersedes menyimpang: outbox yang `supersedes_id` berbeda dari
 *      `records.supersedes_id` (sebagai TEXT).
 *
 * Modul ini murni: tidak membaca database, tidak menulis. Mengambil daftar
 * baris dan mengembalikan keputusan, agar bisa diuji tanpa PostgreSQL dan
 * dipakai `tools/worker-recon.js` sebagai lapisan database.
 */

const recordsWrite = require('./records-write.js');

/** Kunci logis satu versi: record_id dan version. */
function kunci(record_id, version) {
  return record_id + '\u0000' + String(version);
}

/**
 * Susun baris outbox untuk satu baris `records` yang sedang direkonsiliasi.
 *
 * Memakai `recordsWrite.barisOutbox` yang sama dengan route F3.2, dengan
 * `institutionKey` = `institution_id` baris DB (yang memang menyimpan
 * `agencies.institution_key` pemilik). Satu-satunya jalur perhitungan
 * commitment, supaya rekonsiliasi tidak punya fungsi kembar yang bisa
 * menyimpang sendiri.
 *
 * @param {object} rec baris `records` dari database
 * @returns {object} { record_id, version, supersedes_id, commitment }
 */
function formulirBackfill(rec) {
  return recordsWrite.barisOutbox(rec, rec.institution_id);
}

/**
 * Records yang belum punya baris outbox.
 *
 * @param {object[]} records baris `records`
 * @param {object[]} outbox baris `chain_outbox`
 * @returns {object[]} records yang kekurangan outbox (yang harus di-backfill)
 */
function perluBackfill(records, outbox) {
  const ada = new Set(outbox.map((o) => kunci(o.record_id, o.version)));
  return records.filter((r) => !ada.has(kunci(r.record_id, r.version)));
}

/** Normalisasi supersedes untuk perbandingan: null tetap null, angka jadi teks. */
function normalSupersedes(nilai) {
  if (nilai === null || nilai === undefined) return null;
  return String(nilai);
}

/**
 * Bandingkan setiap baris outbox dengan records yang bersangkutan.
 *
 * Pengembalian memisahkan tiga jenis selisih agar bisa dilaporkan berbeda:
 * `yatim` (tidak ada records sama sekali), `komitmen` (commitment tidak
 * cocok), dan `supersedes` (supersedes_id tidak cocok). Baris outbox yang
 * memenuhi semuanya dinyatakan sehat dan TIDAK ada di daftar mana pun.
 *
 * @param {object[]} records baris `records`
 * @param {object[]} outbox baris `chain_outbox`
 * @returns {{ yatim: object[], komitmen: object[], supersedes: object[] }}
 */
function periksa(records, outbox) {
  const peta = new Map(records.map((r) => [kunci(r.record_id, r.version), r]));
  const hasil = { yatim: [], komitmen: [], supersedes: [] };

  for (const o of outbox) {
    const rec = peta.get(kunci(o.record_id, o.version));
    if (!rec) {
      hasil.yatim.push({
        record_id: o.record_id,
        version: Number(o.version),
        supersedes_id: normalSupersedes(o.supersedes_id),
        commitment: o.commitment,
      });
      continue;
    }
    const ulang = recordsWrite.barisOutbox(rec, rec.institution_id);
    if (o.commitment !== ulang.commitment) {
      hasil.komitmen.push({
        record_id: o.record_id,
        version: Number(o.version),
        tersimpan: o.commitment,
        dihitung: ulang.commitment,
      });
    }
    if (normalSupersedes(o.supersedes_id) !== normalSupersedes(rec.supersedes_id)) {
      hasil.supersedes.push({
        record_id: o.record_id,
        version: Number(o.version),
        tersimpan: normalSupersedes(o.supersedes_id),
        dihitung: normalSupersedes(rec.supersedes_id),
      });
    }
  }

  return hasil;
}

/** Ringkasan jumlah baris outbox per status (untuk laporan berkala). */
function ringkas(outbox) {
  const c = { pending: 0, anchored: 0, failed: 0, skipped: 0 };
  for (const o of outbox) {
    if (Object.prototype.hasOwnProperty.call(c, o.chain_status)) c[o.chain_status]++;
  }
  return c;
}

module.exports = {
  formulirBackfill,
  perluBackfill,
  periksa,
  ringkas,
};