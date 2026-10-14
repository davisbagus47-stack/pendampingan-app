'use strict';

/**
 * Kanonikalisasi dan hash record.
 *
 * Rantai yang dikunci di `keputusan-kanonikalisasi.md` (F0.4):
 *
 *     record_hash = SHA-256( bytes_of_ UTF8( JCS( normalize(payload) ) ) )
 *
 * Normalisasi dan JCS adalah dua langkah terpisah. Melewatkan salah satunya
 * adalah bug, bukan penyederhanaan.
 *
 * Prinsip yang mendominasi semua pilihan di bawah: nilai yang masuk ke hash
 * adalah nilai yang benar-benar dilihat pengguna, bukan proyeksi ke kolom
 * bertipe. Kolom `NUMERIC` di database adalah hasil parse; `payload_json`
 * menyimpan nilai verbatim dan itulah sumber tunggal `record_hash`.
 */

const crypto = require('crypto');
const { canonicalize } = require('./jcs');
const { TYPES, NUMERIC_FIELDS, FORCED_TEXT } = require('./field-types');

/**
 * Naikkan `schema_version` setiap kali algoritma kanonikalisasi berubah.
 * Hash lama tetap dapat diverifikasi selama versi lamanya masih tersedia.
 */
const SCHEMA_VERSION = 1;

/** Skala desimal yang diizinkan untuk sebuah kolom, dari deklarasi tipenya. */
function scaleOf(field) {
  const t = TYPES[field];
  if (!t) return null;
  if (t === 'INTEGER') return 0;
  const m = /^NUMERIC\(\d+,\s*(\d+)\)$/.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * Brenaikan satu nilai pengukuran ke satu-satunya bentuk STRING yang sah.
 *
 * Sengaja hanya berlaku untuk field yang deklarasinya bertipe numerik di
 * `lib/field-types.js`. Menormalkan "semua string yang tampak angka" akan
 * merusak NIK (nol di depan hilang) dan menyamakan "007" dengan "7".
 *
 * Mengembalikan nilai string aslinya bila tidak bisa dibaca sebagai angka.
 * `null` tidak pernah muncul dari sini: "-" dan "N/A" adalah isi form yang
 * sah, dan membacanya sebagai null akan menyamakan "tidak berlaku" dengan
 * "belum diisi" -- dua hal yang PRD bedahi secara sengaja (FR-2.5).
 */
function normalizeNumberString(raw, field) {
  const trimmed = String(raw).trim();
  if (trimmed === '') return trimmed;

  const scale = scaleOf(field);
  // Ambil bagian numerik saja; buang satuan seperti "kg", "cm", "kali".
  // Tanda minus dan titik desimal dipertahankan.
  const m = /^([+-]?[0-9]*[.,]?[0-9]+)\s*[a-zA-Z%]*$/.exec(trimmed);
  if (!m) return trimmed;

  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return trimmed;

  // Bulatkan ke skala kolom supaya 0.1 + 0.2 tidak bocor sebagai
  // "0.30000000000000004" dan memicu hash yang berbeda untuk data yang sama.
  const factor = Math.pow(10, scale);
  const rounded = Math.round(n * factor) / factor;

  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Normalisasi satu nilai menjadi bentuk yang siap di-JCS.
 *
 * Aturan:
 *  - `undefined` -> `undefined` (kunci dibuang nanti)
 *  - `null`      -> `null`      (harus tetap berbeda dari "")
 *  - string      -> di-trim
 *  - angka/boolean -> `String(v)`, meniru `tombol()` di index.js
 *  - field numerik -> satu representasi numerik
 */
function normalizeScalar(field, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (FORCED_TEXT.has(field)) {
    // NIK, No. KK, RW, RT: tanda baca dan nol di depan adalah bagian dari
    // identitas, jadi tidak boleh disentuh selain trim.
    return String(value).trim();
  }

  if (NUMERIC_FIELDS.has(field)) {
    return normalizeNumberString(value, field);
  }

  return String(value).trim();
}

/**
 * Normalisasi satu payload record.
 *
 * Field yang tidak ada di payload tidak ikut dibuat: sebuah field tidak
 * berlaku untuk varian sasaran itu harus absen, bukan `""`.
 */
function normalizeRecord(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('normalizeRecord: payload harus object biasa');
  }
  const out = {};
  for (const key of Object.keys(payload)) {
    const v = normalizeScalar(key, payload[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Bentuk kanonik payload: teks RFC 8785 tanpa whitespace. */
function canonicalJson(payload) {
  return canonicalize(payload);
}

/** `record_hash` untuk payload yang SUDAH ternormalisasi. */
function hashNormalized(normalized) {
  return crypto.createHash('sha256').update(canonicalize(normalized), 'utf8').digest('hex');
}

/**
 * `record_hash` untuk payload mentah apa pun yang datang dari form.
 *
 * Fungsi tunggal yang harus dipakai di seluruh proyek: menormalkan lalu
 * meng-JCS dalam satu panggilan, supaya tidak ada jalur yang lupa satu
 * langkah.
 */
function recordHash(payload) {
  return hashNormalized(normalizeRecord(payload));
}

/**
 * `commitment_X = SHA-256( record_hash || institution_X )`.
 *
 * Kedua operand adalah string heksadesimal/ASCII yang disambung, lalu
 * di-UTF8-kan sebagai satu byte. Dipilih daripada 32 byte mentah
 * supaya(instansi mana pun, di bahasa apa pun) cukup meng-encode string dan
 * tidak perlu meniru struktur hash internal byte-per-byte.
 *
 * institution_X adalah `agencies.institution_key` -- kunci bisnis bertipe
 * TEXT, bukan agencies.id. Alasannyasee catatan ADR-3: id bersifat posisional,
 * sehingga dump lalu restore dapat mengubahnya dan commitment historis ikut
 * berubah. Kunci teks tidak punya sifat itu.
 *
 * X adalah INSTANSI PEMILIK record, bukan instansi pemanggil. Frasa "untuk
 * instansi pemanggil" pernah muncul di FR-4.3, tapi pembacaan itu salah dengan
 * dua alasan, dan keduanya checked di catatan keputusan ADR-3:
 *
 *   1. Konsekuensinya bertentangan dengan tujuan FR-4.3 itu sendiri. Tujuannya
 *      "penerima dapat memverifikasi keaslian setiap baris secara independen".
 *      Kalau operandnya identitas pemanggil, setiap penerima menghitung nilai
 *      berbeda untuk baris yang sama, sehingga tidak ada yang bisa diverifikasi
 *      silang.
 *   2. AT-09 tidak tertutup. ADR-3 meng-anchor recordId apa adanya, jadi dua
 *      instansi yang menarik record sama memunculkan recordId yang sama on-chain
 *      dan bisa dikorelasikan siapa pun. Salt pada commitment tidak menolong
 *      karena yang bocor bukan commitment-nya, melainkan recordId-nya.
 *
 * X = pemilik memberi satu anchor per record, jadi tidak ada korelasi lintas
 * instansi, dan semua penerima sah menghitung nilai commitment yang sama.
 *
 * @param {string} institutionKey agencies.institution_key. Wajib berupa string
 *   yang tidak hanya berisi spasi.
 *
 *   Penjaga di bawah sengaja menolak null dan undefined, bukan hanya string
 *   kosong. Alasannya: String(null) adalah "null" dan String(undefined) adalah
 *   "undefined", keduanya lolos uji "tidak kosong" lalu menghasilkan commitment
 *   yang terikat ke literal itu. Itu lebih buruk daripada melempar galat,
 *   karena sebuah instansi yang kebetulan bernama "null" akan menghasilkan hash
 *   yang sama persis dengan pemanggilan yang gagal mengisi parameter.
 */
function commitment(recordHashHex, institutionKey) {
  if (typeof institutionKey !== 'string' || institutionKey.trim() === '') {
    throw new Error(
      'institution_key wajib berupa string yang tidak kosong: commitment tanpa identitas instansi ' +
      'tidak terikat ke instansi mana pun (AT-09)'
    );
  }
  // record_hash_hex harus hex 64 karakter, bukan "apa pun yang bisa diubah jadi
  // string". Tanpa pemeriksaan ini, `commitment(payload, key)` -- kesalahan yang
  // sangat mudah terjadi karena `commitmentFor` ada persis untuk itu -- akan
  // menghasilkan commitment berbentuk 64 hex yang terlihat sah. Kesalahan
  // seperti itu tidak akan ketahuan sampai membandingkan dengan ledger, dan
  // yang sudah salah di sana tidak bisa ditarik kembali.
  if (typeof recordHashHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(recordHashHex.trim())) {
    throw new Error(
      'record_hash_hex harus string hex 64 karakter; ' +
      'kalau Anda punya payload, pakai commitmentFor(payload, institutionKey) ' +
      'atau hitung recordHash(payload) lebih dulu'
    );
  }
  // Huruf besar-hex adalah hash yang sama, hanya beda presentasi, jadi
  // commitment-nya harus sama. `institution_key` tidak dinormalisasi: di situ
  // huruf besar memang nilai yang berbeda.
  const material = recordHashHex.trim().toLowerCase() + institutionKey;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Bentukkan metadata commit yang disimpan di kolom `*_hash`. */
function commitmentFor(payload, institutionKey) {
  return commitment(recordHash(payload), institutionKey);
}

module.exports = {
  SCHEMA_VERSION,
  normalizeScalar,
  normalizeNumberString,
  normalizeRecord,
  canonicalJson,
  hashNormalized,
  recordHash,
  commitment,
  commitmentFor,
};
