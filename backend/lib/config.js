'use strict';

/**
 * Validasi preferensi instansi (F3.10c, FR-4.9..4.12, FR-4.21).
 *
 * Modul ini SENGAJA murni: tidak menyentuh database dan tidak tahu HTTP. Yang
 * diuji di sini adalah satu-satunya hal yang boleh dipercaya tentang masukan
 * klien -- bentuk dan nilainya -- sehingga sisanya (RLS, trigger
 * `validasi_hidden_fields`) bisa fokus pada invariant lapisan database.
 *
 * Kenapa divalidasi di aplikasi padahal ada trigger:
 *   - Trigger hanya menjaga `hidden_fields` terhadap `field_catalog`, dan
 *     melempar galat SQL mentah. Pengguna portal butuh kode mesin yang stabil
 *     (`FIELD_UNKNOWN`, `INVALID_FORMAT`) supaya bisa ditangani, bukan pesan
 *     `23514`.
 *   - `column_order` dan `default_filters` tidak dijaga trigger sama sekali;
 *     tanpa validasi aplikasi, nilai apa pun bisa tersimpan dan baru meledak
 *     saat dipakai membaca.
 *
 * Preferensi TIDAK memengaruhi otorisasi (lihat catatan skema): menyembunyikan
 * kolom di sini berbeda dari memblokirnya (FR-4.20). Karena itu validasi di
 * sini hanya soal bentuk, bukan kewenangan -- kewenangan tetap di RLS.
 */

/** Kunci puncak yang boleh dikirim ke endpoint konfigurasi. */
const KUNCI_DIIZINKAN = Object.freeze([
  'hidden_fields', 'column_order', 'default_filters', 'default_format',
]);

/** Format ekspor bawaan yang sah (FR-4.8). */
const FORMAT_IZIN = Object.freeze(['json', 'csv', 'xlsx']);

/**
 * Parameter filter yang boleh dipakai sebagai filter bawaan (FR-4.21).
 *
 * Daftarnya dipersempit ke parameter FR-4.1 yang benar-benar ada di Query API.
 * Menerima kunci sembarang akan membuat satu kesalahan ketik tersimpan diam
 * dan baru terlihat ketika portal membuka halaman dengan filter yang tidak
 * pernah dijalankan.
 */
const FILTER_IZIN = Object.freeze([
  'kategori_1', 'kategori_2', 'kecamatan', 'desa', 'tanggal_mulai', 'tanggal_selesai',
]);

const MAKS_NILAI = 200;
const MAKS_DAFTAR = 40;

function galat(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  return e;
}

/**
 * Validasi satu daftar nama kolom (`hidden_fields` / `column_order`).
 *
 * Setiap elemen wajib nama kolom yang ada di `fieldOrder`. Duplikat dibuang
 * dengan mempertahankan kemunculan pertama -- urutan adalah makna pada
 * `column_order`, jadi membuang duplikat tidak boleh mengacak urutan.
 */
function daftarField(nilai, nama, fieldOrder) {
  if (!Array.isArray(nilai)) {
    throw galat('VALIDATION_FAILED', nama + ' harus berupa daftar nama kolom.');
  }
  const terpakai = new Set();
  const out = [];
  for (const x of nilai) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw galat('VALIDATION_FAILED', nama + ' harus berisi nama kolom berupa teks.');
    }
    const k = x.trim();
    if (!fieldOrder.includes(k)) {
      throw galat('FIELD_UNKNOWN', 'Kolom tidak dikenal: ' + k + '.');
    }
    if (!terpakai.has(k)) { terpakai.add(k); out.push(k); }
  }
  return out;
}

/**
 * Validasi `default_filters`.
 *
 * Nilai boleh skalar (teks/angka/boolean) atau daftar teks. Bentuk lain
 * (mis. objek bersarang) ditolak: ia tidak punya arti sebagai parameter query,
 * dan menerimanya berarti menyimpan data yang tidak bisa dipakai.
 */
function objekFilter(nilai) {
  if (nilai === null || typeof nilai !== 'object' || Array.isArray(nilai)) {
    throw galat('VALIDATION_FAILED', 'default_filters harus berupa objek.');
  }
  const out = {};
  for (const k of Object.keys(nilai)) {
    if (!FILTER_IZIN.includes(k)) {
      throw galat('VALIDATION_FAILED', 'Filter tidak dikenal: ' + k + '.');
    }
    const v = nilai[k];
    if (v === undefined || v === null || v === '') continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      if (String(v).length > MAKS_NILAI) {
        throw galat('VALIDATION_FAILED', 'Nilai filter terlalu panjang: ' + k + '.');
      }
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      if (v.length > MAKS_DAFTAR) {
        throw galat('VALIDATION_FAILED', 'Terlalu banyak nilai untuk filter: ' + k + '.');
      }
      out[k] = v;
    } else {
      throw galat('VALIDATION_FAILED', 'Bentuk nilai filter tidak didukung: ' + k + '.');
    }
  }
  return out;
}

/**
 * Normalisasi badan permintaan konfigurasi.
 *
 * Mengembalikan hanya kunci yang benar-benar dikirim, sudah divalidasi. Badan
 * kosong atau tanpa kunci yang dikenal ditolak: permintaan yang tidak mengubah
 * apa pun lebih baik gagal jelas daripada menulis ulang baris tanpa alasan.
 *
 * @param {*} masukan badan JSON yang sudah di-parse
 * @param {object} opsi `{ fieldOrder: string[] }`
 * @returns {object} sebagian konfigurasi yang tervalidasi
 */
function normalisasi(masukan, opsi) {
  const o = opsi || {};
  const fieldOrder = Array.isArray(o.fieldOrder) ? o.fieldOrder : [];
  if (masukan === null || typeof masukan !== 'object' || Array.isArray(masukan)) {
    throw galat('VALIDATION_FAILED', 'Badan permintaan harus berupa objek JSON.');
  }
  for (const k of Object.keys(masukan)) {
    if (!KUNCI_DIIZINKAN.includes(k)) {
      throw galat('VALIDATION_FAILED', 'Kunci konfigurasi tidak dikenal: ' + k + '.');
    }
  }
  const hasil = {};
  if (Object.prototype.hasOwnProperty.call(masukan, 'hidden_fields')) {
    hasil.hidden_fields = daftarField(masukan.hidden_fields, 'hidden_fields', fieldOrder);
  }
  if (Object.prototype.hasOwnProperty.call(masukan, 'column_order')) {
    hasil.column_order = daftarField(masukan.column_order, 'column_order', fieldOrder);
  }
  if (Object.prototype.hasOwnProperty.call(masukan, 'default_filters')) {
    hasil.default_filters = objekFilter(masukan.default_filters);
  }
  if (Object.prototype.hasOwnProperty.call(masukan, 'default_format')) {
    const f = String(masukan.default_format).toLowerCase();
    if (!FORMAT_IZIN.includes(f)) {
      throw galat('INVALID_FORMAT', 'Format tidak didukung: ' + masukan.default_format + '.');
    }
    hasil.default_format = f;
  }
  if (Object.keys(hasil).length === 0) {
    throw galat('VALIDATION_FAILED', 'Tidak ada perubahan pada konfigurasi.');
  }
  return hasil;
}

/**
 * Lengkapi nilai yang tidak dikirim dengan nilai bawaan, untuk UPSERT ganti-utuh.
 *
 * PUT berarti "inilah konfigurasi sekarang": kunci yang tidak dikirim kembali
 * ke bawaan. Tanpa pelengkapan ini, UPSERT akan menuliskan `undefined` dan
 * menggagalkan NOT NULL -- atau, lebih buruk, menyimpan sebagian dengan makna
 * yang tidak jelas.
 */
function lengkapi(sebagian) {
  const s = sebagian || {};
  return {
    hidden_fields: Array.isArray(s.hidden_fields) ? s.hidden_fields : [],
    column_order: Array.isArray(s.column_order) ? s.column_order : [],
    default_filters: s.default_filters && typeof s.default_filters === 'object' ? s.default_filters : {},
    default_format: FORMAT_IZIN.includes(s.default_format) ? s.default_format : 'json',
  };
}

module.exports = {
  normalisasi,
  lengkapi,
  daftarField,
  objekFilter,
  KUNCI_DIIZINKAN,
  FORMAT_IZIN,
  FILTER_IZIN,
};
