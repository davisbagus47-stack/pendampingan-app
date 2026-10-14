'use strict';

/**
 * Contoh integrasi JavaScript (FR-4.15) + verifikasi commitment (FR-4.14).
 *
 * Skrip ini sengaja memakai hanya `fetch` bawaan Node (18+) dan modul kanonik
 * proyek, supaya bisa dijalankan apa adanya. Yang dikerjakan:
 *
 *   1. Menarik satu halaman `GET /api/v1/records` memakai kunci API instansi.
 *   2. Menangani penolakan (401/403/429/...) dengan membaca `code` mesinnya.
 *   3. Memverifikasi bahwa setiap baris konsisten dengan commitment-nya:
 *        SHA-256( hex(record_hash) + institution_id ) == commitment
 *   4. Bila `PA_PAYLOAD` diberikan, menghitung ulang `record_hash` dari payload
 *      instansi dan membandingkannya -- inilah yang membuktikan ISI data yang
 *      diterima identik dengan yang tercatat resmi (FR-4.14).
 *
 * Pemakaian (dari direktori `backend/`):
 *
 *   PA_BASE_URL=http://127.0.0.1:8080 PA_API_KEY=pa_sk_live_xxx PA_KATEGORI=Catin \
 *     node tools/contoh-integrasi-javascript.js
 *
 * Keluar dengan kode 0 bila berhasil, non-nol bila gagal. Ringkasan langkah
 * verifikasi ada di spesifikasi-api.md bagian 9 dan 10.
 */

const path = require('path');
const canonical = require(path.join(__dirname, '..', 'lib', 'canonical.js'));

const BASE_URL = (process.env.PA_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.PA_API_KEY || '';
const KATEGORI = process.env.PA_KATEGORI || '';
const PAYLOAD_RAW = process.env.PA_PAYLOAD || '';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Panduan singkat per kode error, supaya integrasi tahu harus berbuat apa. */
const PENANGANAN = {
  AUTH_REQUIRED: 'Kunci API tidak valid atau tidak terverifikasi.',
  MISSING_KEY: 'Kirim header Authorization: Bearer <token>.',
  MALFORMED_KEY: 'Format token salah; harus pa_sk_live_<43 karakter>.',
  UNKNOWN_KEY: 'Token tidak dikenal; minta kunci baru ke operator.',
  KEY_REVOKED: 'Kunci sudah dicabut; minta kunci baru.',
  KEY_STANDBY: 'Kunci cadangan belum diaktifkan.',
  KEY_SCOPE_DENIED: 'Kunci ini dibatasi ke kategori/tabel lain.',
  RATE_LIMITED: 'Tunggu Retry-After detik lalu coba lagi (backoff).',
  CATEGORY_NOT_GRANTED: 'Instansi tidak dihibahkan kategori ini.',
  DESA_NOT_GRANTED: 'Desa di luar wilayah instansi.',
  FIELD_NOT_GRANTED: 'Permintaan memuat kolom yang diblokir keras.',
  FIELD_UNKNOWN: 'Ada nama kolom yang tidak ada.',
  INVALID_PARAM: 'Perbaiki nilai parameter yang salah bentuk.',
  INVALID_FORMAT: 'Format harus json, csv, atau xlsx.',
  DB_UNAVAILABLE: 'Database sedang tidak tersedia; coba lagi nanti.',
};

function gagalKeluar(pesan, kode) {
  console.error('GAGAL: ' + pesan);
  process.exit(kode || 1);
}

async function utama() {
  if (!BASE_URL) gagalKeluar('PA_BASE_URL belum diisi.', 2);
  if (!API_KEY) gagalKeluar('PA_API_KEY belum diisi.', 2);

  let payload = null;
  if (PAYLOAD_RAW) {
    try {
      payload = JSON.parse(PAYLOAD_RAW);
    } catch (e) {
      gagalKeluar('PA_PAYLOAD bukan JSON yang sah: ' + e.message, 2);
    }
  }

  const jalur = '/api/v1/records' +
    (KATEGORI ? '?kategori_1=' + encodeURIComponent(KATEGORI) : '');
  const url = BASE_URL + jalur;
  console.log('Menarik: ' + url);

  const res = await fetch(url, { headers: { authorization: 'Bearer ' + API_KEY } });
  const teks = await res.text();
  let body = null;
  try { body = JSON.parse(teks); } catch (e) { /* biarkan null */ }

  if (!res.ok) {
    const kode = (body && body.code) || 'HTTP_' + res.status;
    console.error('Permintaan ditolak: ' + res.status + ' ' + kode +
      (body && body.message ? ' -- ' + body.message : ''));
    if (PENANGANAN[kode]) console.error('Penanganan: ' + PENANGANAN[kode]);
    process.exit(1);
  }

  const baris = (body && Array.isArray(body.data)) ? body.data : [];
  if (baris.length === 0) {
    console.log('Tidak ada baris untuk diverifikasi (instansi/hibah kosong).');
    return;
  }

  let ok = 0;
  let gagal = 0;
  for (const r of baris) {
    const id = String(r.record_id || '(tanpa id)');

    if (!HEX64.test(String(r.record_hash || ''))) {
      console.error('  GAGAL ' + id + ': record_hash bukan 64 hex.');
      gagal++;
      continue;
    }
    if (typeof r.institution_id !== 'string' || r.institution_id.trim() === '') {
      console.error('  GAGAL ' + id + ': institution_id kosong.');
      gagal++;
      continue;
    }

    // (2) Pasangan (record_hash, institution_id) harus menghasilkan commitment
    // baris itu. Menangkap perubahan commitment/institution_id.
    const ulang = canonical.commitment(r.record_hash, r.institution_id);
    if (ulang !== r.commitment) {
      console.error('  GAGAL ' + id + ': commitment tidak cocok.');
      console.error('        tercatat : ' + r.commitment);
      console.error('        dihitung : ' + ulang);
      gagal++;
      continue;
    }

    // (3) Bila payload lokal tersedia, buktikan ISINYA identik dengan yang
    // tercatat: record_hash yang dihitung ulang harus sama persis.
    if (payload && (!payload.record_id || String(payload.record_id) === String(r.record_id))) {
      const hashLokal = canonical.recordHash(payload);
      if (hashLokal !== r.record_hash) {
        console.error('  GAGAL ' + id + ': record_hash payload tidak cocok dengan yang tercatat.');
        console.error('        tercatat : ' + r.record_hash);
        console.error('        dihitung : ' + hashLokal);
        gagal++;
        continue;
      }
    }

    ok++;
  }

  console.log('Diverifikasi ' + ok + ' baris, gagal ' + gagal + ' baris.' +
    (payload ? ' (termasuk record_hash dari payload lokal)' : ''));
  if (gagal > 0) process.exit(1);
  console.log('OK: commitment setiap baris konsisten.');
}

utama().catch((e) => gagalKeluar(e && e.message ? e.message : String(e), 1));
