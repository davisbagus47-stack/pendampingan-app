'use strict';

/**
 * Kunci uji live (advisory lock PostgreSQL) untuk tabel audit yang DIBAGI.
 *
 * Mengapa perlu
 * -------------
 * `access_log` bersifat global dan append-only, sedangkan `audit_anchor`
 * mengikat akar Merkle atas PREFIX posisi `[1..to_seq]`. Selama baris hanya
 * DITAMBAH di ujung, prefix lama tidak berubah dan bukti tetap sah. Yang
 * merusaknya adalah PENGHAPUSAN: uji live membersihkan baris benihnya sendiri
 * (`DELETE ... WHERE endpoint LIKE ...`), dan bila itu terjadi selagi uji lain
 * memegang bukti atas prefix yang memuat baris tersebut, akar yang dihitung
 * ulang tidak lagi cocok dengan akar yang tersimpan.
 *
 * Uji yang sekadar MENAMBAH baris (permintaan HTTP biasa) tidak berbahaya:
 * baris baru berada di ekor, di luar prefix. Yang berbahaya adalah uji yang
 * MENGHAPUS baris `access_log` atau baris `audit_anchor`. Uji-uji itulah yang
 * wajib mengambil kunci ini agar berjalan bergantian, bukan bersamaan.
 *
 * Pemakaian
 * ---------
 *   const kunci = require('./uji-live-lock.js');
 *   const pegangan = await kunci.ambil(process.env.DATABASE_URL);
 *   try { ... } finally { await kunci.lepas(pegangan); }
 *
 * Kunci diambil pada KONEKSI TERSENDIRI (bukan dari pool uji) supaya tidak
 * mengurangi kapasitas pool, dan dilepas pada koneksi yang sama. Bila proses
 * mati tanpa melepas, PostgreSQL melepas kunci saat koneksi tertutup.
 */

const { Client } = require('pg');

/** Kunci tunggal untuk semua uji live tabel audit. Nilai apa pun yang tetap. */
const KUNCI_UJI_AUDIT = 0x50454e44;

/**
 * Ambil kunci eksklusif; menunggu sampai tersedia.
 *
 * @param {string} connectionString
 * @returns {Promise<object>} pegangan (koneksi terkunci) untuk `lepas`
 */
async function ambil(connectionString) {
  const client = new Client({ connectionString });
  client.on('error', () => {});
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [KUNCI_UJI_AUDIT]);
  return client;
}

/**
 * Lepas kunci dan tutup koneksinya. Aman dipanggil berkali-kali.
 *
 * @param {object} pegangan hasil `ambil`
 * @returns {Promise<void>}
 */
async function lepas(pegangan) {
  if (!pegangan) return;
  try {
    await pegangan.query('SELECT pg_advisory_unlock($1)', [KUNCI_UJI_AUDIT]);
  } catch (e) {
    // Koneksi bisa sudah tertutup; membiarkannya diabaikan benar, karena
    // kunci otomatis lepas saat sesi berakhir.
  }
  try {
    await pegangan.end();
  } catch (e) {}
}

module.exports = { KUNCI_UJI_AUDIT, ambil, lepas };
