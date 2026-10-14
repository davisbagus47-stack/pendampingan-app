'use strict';

/**
 * Jalur tulis `records` (F3.2, FR-3.2..FR-3.7).
 *
 * Modul ini murni: tidak menyentuh database, jaringan, maupun berkas. Semua
 * keputusan yang mudah salah diam-diam ada di sini dan diuji tanpa
 * infrastruktur apa pun -- persis alasan `lib/backfill.js` dan
 * `lib/records-query.js` juga murni.
 *
 * ## Satu sumber hash dengan backfill
 *
 * `record_hash` dihitung dengan `canonical.recordHash()` yang sama, dari
 * `payload_json` verbatim yang sama, memakai `payloadFromRow`-nya sendiri yang
 * meniru `tombol()` di index.js. Kalau jalur ini menghitung hash dengan cara
 * berbeda, record yang dikirim form sekarang tidak akan cocok dengan record
 * hasil backfill untuk isi yang sama -- dan perbedaannya tidak terlihat tanpa
 * membandingkan hash secara manual.
 *
 * ## Versioning (FR-3.4)
 *
 * Koreksi TIDAK mengubah baris lama. Ia membuat baris baru dengan `version`
 * satu lebih besar dan `supersedes_id` menunjuk `records.id` baris lama.
 * Karena itu `record_id` tetap sama, sementara payload barunya menghasilkan
 * `record_hash` baru. Riwayat tetap utuh dan anchor lama tetap sah.
 *
 * ## Batas dengan F3.3 (transactional outbox)
 *
 * Modul ini hanya menyusun BARIS yang akan ditulis. Enqueue `chain_outbox`
 * tetap dieksekusi oleh route di index.js -- parsial ini penting karena
 * eksekusi itu berada dalam transaksi yang SAMA dengan INSERT `records`, di
 * bawah peran `agency`, dan itulah yang membuatnya transaksional (FR-3.6).
 * Yang murni dan diuji di sini adalah nilai baris outbox yang disusun
 * `barisOutbox`: ia menurunkan `commitment` dengan `canonical.commitment`
 * yang sama dengan yang dikembalikan route, jadi klien dan outbox harus
 * menerima nilai yang identik.
 */

const {
  SCHEMA_VERSION,
  recordHash,
  commitment,
} = require('./canonical');
const { sectionsFor } = require('./sections');
const { NUMERIC_FIELDS, DATE_FIELDS, columnName } = require('./field-types');
const {
  WAJIB,
  tombol,
  proyeksi,
} = require('./backfill');

/**
 * Kode galat jalur tulis.
 *
 * Sama seperti kode Query API, tiap kode membawa `status` supaya `kirimGalat`
 * di index.js bisa meneruskannya apa adanya. Kode yang tidak dikenal CHECK
 * constraint `access_log.result` akan jatuh ke `error` lewat `hasilDari`,
 * jadi menambah kode baru memaksa keputusan di `lib/access-log.js`, bukan
 * diam-diam terlewat.
 */
const KODE = Object.freeze({
  INVALID_PARAM: 'INVALID_PARAM',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  JENIS_UNKNOWN: 'JENIS_UNKNOWN',
  AGENCY_UNKNOWN: 'AGENCY_UNKNOWN',
  AGENCY_INACTIVE: 'AGENCY_INACTIVE',
  CATEGORY_NOT_GRANTED: 'CATEGORY_NOT_GRANTED',
  DESA_NOT_GRANTED: 'DESA_NOT_GRANTED',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  RECORD_NOT_PERMITTED: 'RECORD_NOT_PERMITTED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_HASH: 'DUPLICATE_HASH',
});

/**
 * Kolom metadata yang ditulis tangan, di luar kolom hasil turunan FIELD_ORDER.
 *
 * Urutannya harus cocok dengan urutan `nilai` yang dibangun `kolomDanNilai`.
 * `created_by` ikut ditulis eksplisit supaya provenance penulis terlihat
 * (`agency:<id>`), bukan jatuh ke default `operator` yang akan menyamarkan
 * jalur tulis instansi sebagai tulisan operator.
 */
const KOLOM_METADATA = Object.freeze([
  'record_id', 'version', 'supersedes_id', 'status', 'schema_version',
  'institution_id', 'record_hash', 'payload_json', 'sections', 'created_by',
]);

/** Buat galat ber-kode yang bisa diteruskan `kirimGalat`. */
function galat(kode, message, status) {
  const e = new Error(message);
  e.code = kode;
  e.status = status || 400;
  return e;
}

/**
 * Pisahkan permintaan create dari koreksi (FR-3.4).
 *
 * `record_id` dan `version` adalah field kendali, BUKAN bagian payload form:
 * keduanya tidak ada di FIELD_ORDER, jadi tidak mungkin bentrok dengan kolom
 * payload. Aturannya sengaja keras -- harus dikirim bersama atau tidak sama
 * sekali:
 *
 *   - tidak keduanya  -> create, `version` = 1, `record_id` baru
 *   - keduanya        -> koreksi, `version` = versi yang DIKOREKSI
 *   - hanya satu      -> 400. Menganggap "record_id ada, version tidak" sebagai
 *     create akan membuat koreksi yang salah ketik masuk sebagai record BARU
 *     dengan `record_id` yang dikirim klien -- yaitu duplikat yang tidak
 *     terdeteksi, hal terburuk yang bisa terjadi pada ledger.
 *
 * @returns {{mode:string, recordId:string|null, supersededVersion:number}|{error:Error}}
 */
function parseKontrol(body) {
  const b = body || {};
  const adaId = b.record_id !== undefined && b.record_id !== null && String(b.record_id).trim() !== '';
  const adaVersi = b.version !== undefined && b.version !== null && String(b.version).trim() !== '';

  if (!adaId && !adaVersi) {
    return { mode: 'create', recordId: null, supersededVersion: null };
  }

  if (adaId !== adaVersi) {
    return {
      error: galat(
        KODE.INVALID_PARAM,
        'record_id dan version harus dikirim bersama-sama: keduanya menandai koreksi, ' +
        'tanpa keduanya dianggap record baru.',
        400
      ),
    };
  }

  const id = String(b.record_id).trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return { error: galat(KODE.INVALID_PARAM, 'record_id harus berbentuk UUID.', 400) };
  }

  const versi = Number(b.version);
  if (!Number.isInteger(versi) || versi < 1) {
    return { error: galat(KODE.INVALID_PARAM, 'version harus bilangan bulat >= 1.', 400) };
  }

  return { mode: 'correct', recordId: id, supersededVersion: versi };
}

/**
 * Validasi kolom wajib (FR-3.2, kolom NOT NULL di DDL).
 *
 * Memakai `WAJIB` dari `lib/backfill.js`, bukan daftar kedua yang bisa
 * menyimpang dari DDL. Field yang gagal dikembalikan sebagai daftar
 * `{field, code}` supaya klien tahu kolom mana yang perlu diperbaiki.
 *
 * @returns {{errors: Array<{field:string, code:string}>, nik:string}}
 */
function validasi(body, normalizeNik) {
  const b = body || {};
  const errors = [];

  for (const f of WAJIB) {
    if (tombol(b[f]).trim() === '') errors.push({ field: f, code: 'FIELD_REQUIRED' });
  }

  const nik = String((normalizeNik ? normalizeNik(tombol(b.nik)) : tombol(b.nik)) || '').trim();
  if (nik !== '' && !/^\d{16}$/.test(nik)) {
    errors.push({ field: 'nik', code: 'NIK_INVALID' });
  }

  return { errors, nik };
}

/**
 * Susun satu baris `records` dari body form.
 *
 * `institutionId` WAJIB berasal dari instansi pemanggil (dibaca dari kunci API
 * yang terverifikasi), BUKAN dari body. Policy `records_agency_insert` di
 * database mengulang pemeriksaan itu; dua lapis ini disengaja supaya cacat di
 * aplikasi tidak cukup untuk menulis atas nama instansi lain.
 *
 * @returns {object} baris siap-INSERT (tanpa kolom `created_by`/typed yang
 *   dirakit `kolomDanNilai`)
 */
function bangunRecord(opsi) {
  const {
    body, fieldOrder, institutionId, sectionMap,
    normalizeSasaran = (v) => v,
    normalizeNik = (v) => String(v || '').replace(/\D/g, ''),
    recordId, version, supersedesId,
  } = opsi;

  if (typeof institutionId !== 'string' || institutionId.trim() === '') {
    throw galat(KODE.AGENCY_UNKNOWN, 'institution_id tidak bisa dikosongkan.', 403);
  }

  const payload = {};
  for (const f of fieldOrder) payload[f] = tombol(body[f]);

  const jenis = normalizeSasaran(String(payload.jenisSasaran || '').trim().toLowerCase());
  payload.jenisSasaran = jenis;
  payload.nik = String(normalizeNik(payload.nik) || '').trim();

  const proy = proyeksi(payload, fieldOrder);

  return {
    record_id: recordId,
    version,
    supersedes_id: supersedesId,
    status: 'active',
    schema_version: SCHEMA_VERSION,
    institution_id: institutionId,
    record_hash: recordHash(payload),
    payload_json: payload,
    sections: sectionsFor(sectionMap, payload),
    proyeksi: proy,
  };
}

/**
 * Nilai kolom hasil turunan, dengan kebijakan yang sama seperti
 * `tools/backfill.js` (`nilaiKolom`): kolom bertipe ditulis hasil parse (atau
 * NULL), kolom TEXT ditulis apa adanya.
 *
 * Bedanya bentuk: di sini nilai JS, bukan potongan SQL. Parameter ikat
 * PostgreSQL menangani escaping, jadi tidak ada `sqlQuote` -- dan tidak ada
 * kesempatan salah mengutip.
 */
function nilaiProyeksi(record, fieldOrder) {
  const proy = record.proyeksi || {};
  const payload = record.payload_json || {};
  return fieldOrder.map((f) => {
    if (NUMERIC_FIELDS.has(f)) {
      const v = proy[f];
      return v === null || v === undefined ? null : v;
    }
    if (DATE_FIELDS.has(f)) {
      const v = proy[f];
      return v === null || v === undefined ? null : v;
    }
    const t = payload[f];
    return t === undefined || t === null ? '' : t;
  });
}

/**
 * Rakit daftar kolom dan nilai untuk satu INSERT berparameter.
 *
 * `payload_json` di-stringify di sini dan dikirim sebagai teks; `pg` menulisnya
 * ke kolom JSONB. `sections` dikirim sebagai array Teks, yang dipetakan `pg`
 * ke `TEXT[]` tanpa perakitan `ARRAY[...]` manual.
 *
 * @returns {{columns:string[], values:Array<unknown>}}
 */
function kolomDanNilai(record, fieldOrder, createdBy) {
  const columns = KOLOM_METADATA.concat(fieldOrder.map((f) => columnName(f)));
  const values = [
    record.record_id,
    record.version,
    record.supersedes_id,
    record.status,
    record.schema_version,
    record.institution_id,
    record.record_hash,
    JSON.stringify(record.payload_json),
    record.sections,
    createdBy,
  ].concat(nilaiProyeksi(record, fieldOrder));
  return { columns, values };
}

/**
 * Susun baris `chain_outbox` untuk satu record (F3.3, FR-3.6).
 *
 * Outbox dicatat dalam transaksi yang SAMA dengan INSERT `records`, supaya
 * kegagalan on-chain (F3.4) tidak pernah memblokir penyimpanan maupun query
 * (FR-3.6). Baris ini hanya disusun di modul murni: eksekusinya tetap milik
 * route, karena eksekusi itu harus ikut dalam transaksi yang sama dengan
 * INSERT records di bawah peran `agency`.
 *
 * `commitment` dihitung dengan `canonical.commitment` yang sama seperti yang
 * dikembalikan route ke klien, jadi outbox dan klien melihat nilai yang
 * identik -- bukan dua perhitungan yang bisa menyimpang.
 *
 * @returns {object} baris siap-INSERT ke `chain_outbox`
 */
function barisOutbox(rec, institutionKey) {
  return {
    record_id: rec.record_id,
    version: rec.version,
    supersedes_id: rec.supersedes_id === null ? null : String(rec.supersedes_id),
    commitment: commitment(rec.record_hash, institutionKey),
  };
}

module.exports = {
  KODE,
  KOLOM_METADATA,
  galat,
  parseKontrol,
  validasi,
  bangunRecord,
  nilaiProyeksi,
  kolomDanNilai,
  barisOutbox,
};
