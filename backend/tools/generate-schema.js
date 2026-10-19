/**
 * Generator DDL untuk Data Center Sasaran Pendampingan.
 *
 * Sumber kebenaran adalah kode aplikasi, bukan dokumen:
 *   - FIELD_ORDER dan LABELS  -> backend/index.js
 *   - section A..I            -> frontend/src/pages/FormPendampingan.jsx
 *
 * Aturan main: jangan tulis 72 kolom manual. Kolom, tipe, label, dan section
 * diturunkan dari kode di atas sehingga FIELD_ORDER yang berubah akan langsung
 * mengubah skema (mitigasi RK-3).
 *
 * Pemakaian:
 *   node tools/generate-schema.js            -> tulis ke ../sql/001_schema.sql
 *   node tools/generate-schema.js --stdout   -> cetak ke layar
 *   node tools/generate-schema.js --check    -> gagal kalau keluaran berbeda
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(BACKEND_DIR, '..');
const FORM_PATH = path.join(REPO_DIR, 'frontend', 'src', 'pages', 'FormPendampingan.jsx');
const DEFAULT_OUT = path.join(BACKEND_DIR, 'sql', '001_schema.sql');

// index.js mengekspor Express app beserta metadata skema. Membaca metadata lewat
// require (bukan regex) membuat generator gagal keras bila FIELD_ORDER hilang.
const app = require(path.join(BACKEND_DIR, 'index.js'));
const { FIELD_ORDER, LABELS } = app;
const { TYPES, FORCED_TEXT, snake, columnName } = require(path.join(BACKEND_DIR, 'lib', 'field-types.js'));
const { deriveSections } = require(path.join(BACKEND_DIR, 'lib', 'sections.js'));
const { DENIED_BAWAAN, deniedColumnKeys } = require(path.join(BACKEND_DIR, 'lib', 'column-grants.js'));

if (!Array.isArray(FIELD_ORDER) || !LABELS) {
  throw new Error('index.js tidak mengekspor FIELD_ORDER / LABELS. Generator berhenti.');
}
if (DENIED_BAWAAN.length === 0) {
  throw new Error('DENIED_BAWAAN kosong. Lima kolom terlarang akan tidak terblokir. Generator berhenti.');
}


/** Batasan nilai yang bisa dinyatakan sebagai CHECK. */
const ENUMS = {
  // ADR-5: lima kategori (Catin, Ibu Hamil, Ibu Nifas, Baduta, Balita).
  jenisSasaran: ['Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita'],
  jenisKelamin: ['Laki-laki', 'Perempuan'],
};

const SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/**
 * Metadata non-proyeksi pada tabel records. */
const REQUIRED_FIELDS = new Set(['namaTPK', 'peranTPK', 'namaDesa', 'namaLengkap', 'jenisSasaran', 'tanggalKunjungan', 'nik']);

/**
 * Lima kolom terlarang (PRD 6.4.1a) dalam bentuk nama kolom SQL.
 *
 * Daftar ini ditulis ulang di sini, bukan diambil dari lib/column-grants.js.
 * Semula ia diturunkan dari sana, tapi turunan begitu tidak bisa dijaga:
 * menghapus satu entri dari DENIED_BAWAAN akan ikut menghapus nama itu dari DDL,
 * dan generator tetap keluar 0 karena tidak ada yang tidak cocok. Yang hilang
 * justru blokir yang paling penting -- tanpa galat apa pun.
 *
 * Karena itu kedua daftar harus disimpan terpisah lalu DICOCOKKAN. Generator
 * berhenti kalau isinya berbeda, dan test-generate-schema.js membuktikan
 * bahwa mutasi di salah satunya benar-benar ditolak.
 */
const DENIED_BAWAAN_KEYS_HARFAP = [
  'catatan_tpk',
  'nik_ayah',
  'nik_ibu',
  'nama_ayah',
  'nama_ibu',
];

/** Nama kolom SQL yang harus diblokir, menurut lib/column-grants.js. */
const DENIED_BAWAAN_KEYS_DARI_MODUL = deniedColumnKeys(FIELD_ORDER);

for (const key of DENIED_BAWAAN_KEYS_HARFAP) {
  if (!DENIED_BAWAAN_KEYS_DARI_MODUL.includes(key)) {
    throw new Error(
      'Kolom terlarang "' + key + '" (PRD 6.4.1a) tidak ada di lib/column-grants.js. ' +
      'Daftar di DDL dan daftar yang dipatuhi aplikasi akan berbeda. Generator berhenti.'
    );
  }
}
if (DENIED_BAWAAN_KEYS_DARI_MODUL.length !== DENIED_BAWAAN_KEYS_HARFAP.length) {
  throw new Error(
    'Jumlah kolom terlarang berbeda: DDL ' + DENIED_BAWAAN_KEYS_HARFAP.length +
    ', module ' + DENIED_BAWAAN_KEYS_DARI_MODUL.length +
    ' (' + DENIED_BAWAAN_KEYS_DARI_MODUL.join(', ') + '). Generator berhenti.'
  );
}
const DENIED_BAWAAN_KEYS = DENIED_BAWAAN_KEYS_HARFAP;

/**
 * Kolom yang ditulis tangan di luar FIELD_ORDER. Tidak boleh boleh beririsan
 * dengan proyeksi -- bila iya, PostgreSQL menolak dengan "specified more than
 * once", dan kesalahan seperti ini harus tertangkap sebelum_skema dipakai.
 */
const MANUAL_COLUMNS = new Set([
  'id', 'record_id', 'version', 'supersedes_id', 'status', 'payload_json',
  'record_hash', 'schema_version', 'sections', 'created_at', 'created_by',
  'institution_id',
]);

/**
 * Bagian skema yang tidak boleh hilang diam-diam.
 *
 * institution_id adalah X pada commitment_X itu sendiri: FR-4.3 menghitung
 * commitment untuk setiap baris hasil, dan tanpa kolom ini tidak ada yang bisa
 * memberi tahu apakah commitment itu milik instansi mana. Menghapusnya tidak
 * merusak sintaks, tidak merusak generator, dan tidak merusak satu pun uji yang
 * ada -- ia hanya membuat FR-4.3 mustahil dipenuhi, lalu senyap sampai ada
 * yang meninjau ulang.
 *
 * Karena itu ia diperiksa di sini, bukan dengan mengandalkan disiplin.
 */
const REQUIRED_SCHEMA_MARKERS = [
  ['records', '  institution_id  TEXT        NOT NULL REFERENCES agencies(institution_key),'],
  ['agencies', '  institution_key TEXT    NOT NULL UNIQUE'],
];

// ---------------------------------------------------------------------------
// 1. Turunkan section dari form (FR-2.4: "berasal dari form yang ada")
//
// Implementasinya tinggal di lib/sections.js karena backfill memakai aturan yang
// sama. Duplikasi di sini berarti `records.sections` yang ditulis backfill bisa
// menyimpang dari `field_catalog.sections` tanpa galat.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. Susun katalog kolom
// ---------------------------------------------------------------------------
function buildCatalog() {
  const { map, titles, markCount } = deriveSections();

  const rows = FIELD_ORDER.map((field, i) => {
    const col = columnName(field);
    let type = TYPES[field];
    if (!type) type = FORCED_TEXT.has(field) ? 'TEXT' : 'TEXT';
    const sections = map[field] ? [...map[field]].sort() : [];
    return {
      pos: i + 1,
      field,
      column: col,
      type,
      label: LABELS[field],
      sections,
      required: REQUIRED_FIELDS.has(field),
    };
  });

  // --- pemeriksaan mandiri: jangan pernah hasilkan skema yang tidak lengkap ---
  const problems = [];
  const cols = new Set();
  for (const r of rows) {
    if (cols.has(r.column)) problems.push('Kolom kembar: ' + r.column);
    cols.add(r.column);
    if (!r.label) problems.push('Field tanpa label: ' + r.field);
    if (r.sections.length === 0) problems.push('Field tanpa section: ' + r.field);
    if (MANUAL_COLUMNS.has(r.column)) {
      problems.push('Kolom proyeksi "' + r.column + '" bentrok dengan kolom metadata yang ditulis tangan');
    }
    for (const s of r.sections) {
      if (!SECTIONS.includes(s)) problems.push('Section tak dikenal "' + s + '" pada ' + r.field);
    }
  }
  for (const f of REQUIRED_FIELDS) {
    if (!FIELD_ORDER.includes(f)) problems.push('Field wajib tidak ada di FIELD_ORDER: ' + f);
  }

  // Kolom terlarang harus benar-benar ada di FIELD_ORDER. Kalau nama camel di
  // DENIED_BAWAAN tidak ada di katalog, blokir yang dibangun dari nama itu
  // tidak akan pernah cocok dengan kolom yang benar -- dan blokir terlihat
  // aktif padahal tidak berlaku.
  for (const f of DENIED_BAWAAN) {
    if (!FIELD_ORDER.includes(f)) {
      problems.push('Kolom terlarang "' + f + '" tidak ada di FIELD_ORDER -- blokirnya tidak akan berlaku');
    }
  }
  const seen = new Set(rows.map((r) => r.field));
  if (seen.size !== FIELD_ORDER.length) problems.push('Ada field duplikat di FIELD_ORDER');
  if (problems.length > 0) {
    throw new Error('Pemeriksaan mandiri gagal:\n  - ' + problems.join('\n  - '));
  }

  return { rows, titles, markCount };
}

// ---------------------------------------------------------------------------
// 3. Emit SQL
// ---------------------------------------------------------------------------
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const dq = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function emit(catalog) {
  const { rows, titles, markCount } = catalog;
  const out = [];
  const w = (line = '') => out.push(line);

  w('-- ============================================================================');
  w('-- Skema PostgreSQL - Data Center Sasaran Pendampingan');
  w('--');
  w('-- BERKAS INI DIHASILKAN. Jangan diedit manual.');
  w('-- Sumber: backend/index.js (FIELD_ORDER, LABELS)');
  w('--         frontend/src/pages/FormPendampingan.jsx (section A..I)');
  w('-- Regenerasi: node backend/tools/generate-schema.js');
  w('--');
  w(`-- Jumlah kolom proyeksi : ${rows.length} (dari FIELD_ORDER)`);
  w(`-- Section di form        : ${markCount} penanda untuk ${SECTIONS.length} section (F punya 4 varian)`);
  w(`-- Kolom wajib            : ${rows.filter((r) => r.required).length}`);
  w('--');
  w('-- Determinisme: TIDAK ada cap waktu di berkas ini. Kriteria keluar F1');
  w('-- mensyaratkan "menjalankan generator dua kali menghasilkan skema identik".');
  w('-- ============================================================================');
  w();
  w('BEGIN;');
  w();
  w('-- Ekstensi ------------------------------------------------------------------');
  w('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  w();

  // --- tabel katalog kolom: hasil turunan, mendokumentasikan skema ke dirinya sendiri
  w('-- ============================================================================');
  w('-- FIELD_CATALOG - katalog kolom hasil turunan dari kode');
  w('-- Dipakai UI (daftar filter), validasi FR-4.20, dan dokumentasi.');
  w('-- ============================================================================');
  w('CREATE TABLE field_catalog (');
  w('  column_key   TEXT    NOT NULL PRIMARY KEY,');
  w('  form_field   TEXT    NOT NULL UNIQUE,');
  w('  label        TEXT    NOT NULL,');
  w('  data_type    TEXT    NOT NULL,');
  w('  form_pos     SMALLINT NOT NULL,');
  w('  sections     TEXT[]  NOT NULL,');
  w('  is_required  BOOLEAN NOT NULL DEFAULT false,');
  w('  CONSTRAINT field_catalog_sections_known');
  w('    CHECK (sections <@ ARRAY[' + SECTIONS.map(q).join(', ') + '])');
  w(');');
  w();
  w('COMMENT ON TABLE field_catalog IS');
  w('  ' + q('Katalog kolom yang dihasilkan dari FIELD_ORDER/LABELS di backend/index.js. Jangan diedit manual.') + ';');
  w();

  // --- agencies
  //
  // Draf pertama menaruh blok ini SESUDAH records. Aman selama tidak ada kolom
  // records yang merujuk tabel agencies -- tapi records.institution_id (ADR-3)
  // merujuk agencies(institution_key), jadi urutan itu sekarang salah dan
  // CREATE TABLE records akan gagal saat dijalankan. Urutan CREATE TABLE bukan
  // soal gaya: PostgreSQL butuh tabel yang dirujuk sudah ada.
  w('-- ============================================================================');
  w('-- AGENCIES - instansi penerima dan haknya (FR-1.4, FR-1.5, FR-4.x)');
  w('-- ============================================================================');
  w('CREATE TABLE agencies (');
  w('  id          BIGSERIAL PRIMARY KEY,');
  w('  -- Kunci bisnis instansi. Inilah bentuk institution_X pada ADR-3,');
  w('  -- jadi nilainya terikat ke dalam commitment dan tidak boleh diubah');
  w('  -- setelah ada record. Format: slug huruf kecil, tanda hubung, angka');
  w('  -- (contoh "kota-bogor"). Kolom name boleh diganti tanpa membatalkan');
  w('  -- commitment; yang tidak boleh diganti adalah yang ini.');
  w('  institution_key TEXT    NOT NULL UNIQUE');
  w('               CHECK (institution_key ~ ' + q('^[a-z0-9]+(-[a-z0-9]+)*$') + '),');
  w('  name        TEXT      NOT NULL UNIQUE,');
  w('  contact     TEXT,');
  w('  status      TEXT      NOT NULL DEFAULT ' + q('active') + ' CHECK (status IN (' + q('active') + ', ' + q('revoked') + ')),');
  w('  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  revoked_at  TIMESTAMPTZ');
  w(');');
  w();
  w('-- FR-4.2: kategori yang diizinkan. CHECK memuat lima kategori ADR-5.');
  w('-- PoC F0.6: Bidang KB diberi segmen "PUS" = lima kategori.');
  w('CREATE TABLE agency_categories (');
  w('  agency_id     BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  jenis_sasaran TEXT   NOT NULL CHECK (jenis_sasaran IN (' + ENUMS.jenisSasaran.map(q).join(', ') + ')),');
  w('  PRIMARY KEY (agency_id, jenis_sasaran)');
  w(');');
  w();
  w('-- FR-4.17: wilayah yang diizinkan. Tabel kosong untuk satu agency = seluruh wilayah.');
  w('CREATE TABLE agency_desa_scope (');
  w('  agency_id      BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  nama_kecamatan TEXT   NOT NULL,');
  w('  nama_desa      TEXT   NOT NULL,');
  w('  PRIMARY KEY (agency_id, nama_kecamatan, nama_desa)');
  w(');');
  w();
  w('-- FR-4.20: kolom yang DIBLOKIR keras, ditegakkan RLS. Berbeda dari field');
  w('-- yang hanya disembunyikan (FR-4.10) -- lihat agency_config.hidden_fields.');
  w('CREATE TABLE agency_denied_columns (');
  w('  agency_id  BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  column_key TEXT   NOT NULL REFERENCES field_catalog(column_key) ON DELETE CASCADE,');
  w('  PRIMARY KEY (agency_id, column_key)');
  w(');');
  w();
  w('-- FR-4.9..4.12, FR-4.21: preferensi tampilan. TIDAK memengaruhi otorisasi.');
  w('CREATE TABLE agency_config (');
  w('  agency_id       BIGINT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  hidden_fields   TEXT[]   NOT NULL DEFAULT ' + q('{}') + ',');
  w('  -- FR-4.9 "urutan kolom": urutan kolom yang diinginkan instansi di portal.');
  w('  -- Daftar kosong = pakai urutan bawaan FIELD_ORDER.');
  w('  column_order    TEXT[]   NOT NULL DEFAULT ' + q('{}') + ',');
  w('  default_filters JSONB    NOT NULL DEFAULT ' + q('{}') + '::jsonb,');
  w('  default_format  TEXT     NOT NULL DEFAULT ' + q('json') + ' CHECK (default_format IN (' + q('json') + ', ' + q('csv') + ', ' + q('xlsx') + ')),');
  w('  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  updated_by      TEXT');
  w(');');
  w();
  w('-- Setiap elemen hidden_fields harus ada di field_catalog. Tidak bisa');
  w('-- jadi CHECK: PostgreSQL melarang subquery dalam CHECK. Trigger menjaga');
  w('-- invariant yang sama di lapisan database, sesuai pola F3.7: keabsahan');
  w('-- bukan tanggung jawab penulis api saja.');
  w('CREATE FUNCTION validasi_hidden_fields() RETURNS trigger AS $$');
  w('DECLARE');
  w('  tak_ada TEXT;');
  w('BEGIN');
  w('  SELECT c INTO tak_ada');
  w('    FROM unnest(NEW.hidden_fields) AS c');
  w('    WHERE NOT EXISTS (');
  w('      SELECT 1 FROM field_catalog f WHERE f.column_key = c');
  w('    )');
  w('    LIMIT 1;');
  w('  IF tak_ada IS NOT NULL THEN');
  w('    RAISE EXCEPTION ' + q('hidden_fields memuat kolom yang tidak ada: %') + ', tak_ada');
  w('      USING ERRCODE = ' + q('23514') + ';');
  w('  END IF;');
  w('  RETURN NEW;');
  w('END;');
  w('$$ LANGUAGE plpgsql;');
  w();
  w('CREATE TRIGGER trg_agency_config_hidden_fields');
  w('  BEFORE INSERT OR UPDATE OF hidden_fields ON agency_config');
  w('  FOR EACH ROW EXECUTE FUNCTION validasi_hidden_fields();');
  w();
  w('-- FR-4.5, AT-14: rate limit dan kuota per instansi.');
  w('--');
  w('-- Dipisah dari agency_config dengan sengaja. agency_config berisi');
  w('-- preferensi tampilan, sedangkan kuota membatasi Abuse -- kalau keduanya');
  w('-- satu tabel, "ubah preferensi" dan "ubah batas pemakaian" jadi satu izin');
  w('-- yang sama, dan perubahan kuota bisa lolos tanpa ditinjau.');
  w('--');
  w('-- NULL berarti pakai nilai bawaan aplikasi (lihat BAWAAN di');
  w('-- lib/rate-limit.js). Kolom tidak diisi berarti Agencies tidak diberi kuota');
  w('-- khusus, bukan kuota nol: nol berarti menolak semua permintaan, dan itu');
  w('-- keputusan yang harus ditulis eksplisit.');
  w('CREATE TABLE agency_rate_limit (');
  w('  agency_id    BIGINT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  kuota        INTEGER     CHECK (kuota > 0),');
  w('  jendela_ms   INTEGER     CHECK (jendela_ms >= 100),');
  w('  burst        INTEGER     CHECK (burst >= 0),');
  w('  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  updated_by   TEXT');
  w(');');
  w();
  w('-- Kuota hanya berarti kalau dihitung per instansi. Indeks ini membuat');
  w('-- pembacaan konfigurasi untuk satu Agencies tetap O(1) meski tabel');
  w('-- bertambah.');
  w('CREATE INDEX idx_agency_rate_limit_konfigurasi ON agency_rate_limit (agency_id);');
  w();
  // FR-1.6, FR-4.16: kredensial API. Simpan hash, bukan plaintext -- begitu
  // baris masuk database, token aslinya hilang dan tidak bisa dipulihkan.
  //
  // Enam kolom tambahan di bawah answering keputusan F3.10a (2026-10-06) yang
  // tidak bisa ditebak dari bentuk lamanya:
  //
  //   status      primary | standby | revoked. Hanya `primary` yang boleh
  //               dipakai server. `standby` ada karena satu kunci cadangan
  //               wajib -- tanpa itu, kehilangan kunci primary berarti instansi
  //               tidak bisa diakses sama sekali. Tapi standby TIDAK aktif
  //               otomatis: promoting-nya harus disengaja, kalau tidak
  //               "revoke primary = semua akses berhenti" berubah jadi
  //               sekadar suggestion.
  //   key_prefix  8 karakter awal, untuk ditampilkan ke operator supaya kunci
  //               bisa diidentifikasi tanpa menyimpan token utuh.
  //   category    NULL = semua kategori. Mengisi keduanya dengan nilai NULL
  //   table_name    Cakupan tabel. NULL = semua tabel; diisi, kunci hanya boleh
  //               menyentuh satu tabel, tanpa perlu menebak lewat nama endpoint.
  //   last_used_at  jejak audit untuk melihat kunci yang sudah ditinggalkan.
  //
  // Dua index unik bersyarat di bawah menjaga invariant yang tidak bisa
  // ditegakkan dengan constraint biasa: lebih dari satu primary per instansi
  // berarti ada dua identitas aktif, dan itu lolos dari pemeriksaan manapun.
  w('CREATE TYPE agency_key_status AS ENUM (\'primary\', \'standby\', \'revoked\');');
  w('CREATE TABLE agency_api_keys (');
  w('  id            BIGSERIAL PRIMARY KEY,');
  w('  agency_id     BIGINT      NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,');
  w('  key_hash      TEXT        NOT NULL UNIQUE,');
  w('  key_prefix    TEXT        NOT NULL,');
  w('  status        agency_key_status NOT NULL DEFAULT \'primary\',');
  w('  category      TEXT,');
  w('  table_name    TEXT,');
  w('  label         TEXT,');
  w('  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  activated_at  TIMESTAMPTZ,');
  w('  last_used_at  TIMESTAMPTZ,');
  w('  revoked_at    TIMESTAMPTZ,');
  w('  revoked_by    TEXT,');
  // Setengah batasan scope tidak masuk akal: kunci yang boleh satu kategori
  // tapi tidak dibatasi tabel berarti "kategori ini, semua tabel" -- konvensi
  // yang hanya bisa disalahbaca.
  w('  CONSTRAINT agency_api_keys_scope_whole CHECK (category IS NOT NULL OR table_name IS NULL),');
  // FK majemuk, bukan satu kolom. `agency_categories` PK-nya
  // (agency_id, jenis_sasaran), jadi FK satu kolom ke sana tidak mungkin --
  // dan kalau dipaksakan dengan menambah UNIQUE pada jenis_sasaran, setiap
  // agency bisa punya kategori yang sama beberapa kali, yang justru membatalkan
  // makna kolom itu.
  //
  // Majemuk juga lebih kuat dari yang diminta: ia tidak hanya memeriksa bahwa
  // kategori itu ADA di taksonomi, tapi bahwa agency itu benar-benar
  // MENDAPATKAN kategori tersebut. Kunci yang dibatasi ke kategori yang tidak
  // di-grant ke instansinya akan ditolak database -- bukan sekadar tidak
  // berguna.
  //
  // MATCH SIMPLE (bawaan): kalau `category` NULL, FK tidak diperiksa sama sekali.
  // Itu yang diinginkan kunci tanpa batasan kategori, jadi tidak perlu PK
  // tambahan di agency_categories.
  w('  CONSTRAINT agency_api_keys_category FOREIGN KEY (agency_id, category)');
  w('    REFERENCES agency_categories (agency_id, jenis_sasaran) ON DELETE CASCADE');
  w(');');
  w('CREATE INDEX idx_agency_api_keys_hash ON agency_api_keys (key_hash) WHERE revoked_at IS NULL;');
  w('CREATE UNIQUE INDEX idx_agency_api_keys_one_primary');
  w('  ON agency_api_keys (agency_id) WHERE status = \'primary\';');
  w('CREATE UNIQUE INDEX idx_agency_api_keys_one_standby');
  w('  ON agency_api_keys (agency_id) WHERE status = \'standby\';');
  w();

  // --- records
  w('-- ============================================================================');
  w('-- RECORDS - system of record dengan versioning (ADR-1, ADR-4)');
  w('--');
  w('-- Kolom domain adalah PROYEKSI dari payload untuk keperluan filter');
  w('-- (FR-4.2 kategori, FR-4.17 wilayah, FR-4.20 kolom).');
  w('-- payload_json menyimpan nilai VERBATIM dari form karena record_hash dihitung');
  w('-- dari canonical_json(payload) -- parse ulang berisiko mengubah hash (mis. NIK');
  w('-- ber-0 depan).');
  w('--');
  w('-- Kebijakan parse kolom non-TEXT: kosong/"-"/"N/A" -> NULL; koma desimal');
  w('-- "70,00" -> 70.00; satuan ("70 kg") dibuang; gagal parse -> NULL, bukan galat.');
  w('-- Payloads yang gagal parse tetap utuh di payload_json.');
  w('-- ============================================================================');
  w('CREATE TABLE records (');
  w('  id              BIGSERIAL   PRIMARY KEY,');
  w('  record_id       TEXT        NOT NULL,');
  w('  version         INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),');
  w('  supersedes_id   BIGINT      REFERENCES records(id),');
  w('  status          TEXT        NOT NULL DEFAULT ' + q('active') + ' CHECK (status IN (' + q('active') + ', ' + q('redacted') + ')),');
  w('  payload_json    JSONB       NOT NULL,');
  w('  record_hash     TEXT        NOT NULL UNIQUE,');
  w('  schema_version  SMALLINT    NOT NULL DEFAULT 1,');
  w();
  w('  -- INSTANSI PEMILIK (ADR-3). Kolom ini tidak ada pada draf pertama.');
  w('  -- Tanpa itu FR-4.3 mustahil: commitment_X butuh institution_X, dan');
  w('  -- satu record bisa dibaca banyak instansi sehingga "X" tidak bisa');
  w('  -- ditentukan dari pemanggil. Karena pemanggil boleh berbeda-beda untuk');
  w('  -- record yang sama, memadcommitment dengan identitas pemanggil membuat');
  w('  -- tiap penerima mendapat nilai berbeda dan verifikasi independen');
  w('  -- (tujuan FR-4.3) justru rusak. X = pemilik.');
  w('  --');
  w('  -- Tipe TEXT, bukan agencies.id. id bersifat posisional: dump lalu restore');
  w('  -- dapat mengubah urutannya, dan karena institution_X masuk ke dalam');
  w('  -- commitment, itu membuat SEMUA commitment historis tidak lagi');
  w('  -- verifiable. Kunci teks tidak punya sifat itu.');
  w('  institution_id  TEXT        NOT NULL REFERENCES agencies(institution_key),');
  w();
  w('  -- taksonomi (ADR-5, FR-2.4). jenis_sasaran sengaja TIDAK dideklarasikan di');
  w('  -- sini karena jenis_sasaran juga ada di FIELD_ORDER; batasan nilainya');
  w('  -- dituliskan pada kolom proyeksinya agar tidak terdefinisi dua kali.');
  w('  -- Kategori (ADR-5): Catin, Ibu Hamil, Ibu Nifas, Baduta, Balita.');
  w('  -- Satu record dapat mengisi beberapa section:');
  w('  -- ' + columnsSpanningSections(rows).join(', ') + ' muncul di >1 section.');
  w('  -- Karena itu section disimpan sebagai larik, bukan satu nilai.');
  w('  sections        TEXT[]      NOT NULL DEFAULT ' + q('{}') + ',');
  w('                 CHECK (sections <@ ARRAY[' + SECTIONS.map(q).join(', ') + ']),');
  w();
  w('  -- kolom hasil turunan dari FIELD_ORDER');
  let sectionComment = null;
  for (const r of rows) {
    const key = r.sections.join('');
    if (key !== sectionComment) {
      sectionComment = key;
      w('  -- section ' + r.sections.join(', ') + (titles[r.sections[0]] ? ' (' + titles[r.sections[0]] + ')' : ''));
    }
    const constraints = [];
    if (r.required) constraints.push('NOT NULL');
    // Batas nilai ditambahkan pada kolomnya, bukan sebagai kolom terpisah.
    // Kolom enum yang OPSIONAL menerima '' juga: form mengirim '' untuk field
    // yang tidak diisi (semua kolom di sini string lewat tombol()), dan CHECK
    // yang menolak '' akan menjatuhkan baris sah -- ditemukan saat eksekusi
    // nyata F1.8 (records_jenis_kelamin_check). Nilai non-'' tetap harus salah
    // satu anggota enum.
    if (ENUMS[r.field]) {
      const izin = ENUMS[r.field].map(q).join(', ');
      const kunci = r.column;
      const pengecualian = r.required ? '' : ' OR ' + kunci + ' = ' + q('');
      constraints.push('CHECK (' + kunci + ' IN (' + izin + ')' + pengecualian + ')');
    }
    w('  ' + pad(r.column, 19) + ' ' + pad(r.type, 13) +
      (constraints.length > 0 ? ' ' + constraints.join(' ') : '') + ',  -- ' + r.label);
  }
  w();
  w('  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  created_by       TEXT        NOT NULL DEFAULT ' + q('operator') + ',');
  w('  UNIQUE (record_id, version)');
  w(');');
  w();
  w('COMMENT ON COLUMN records.payload_json IS');
  w('  ' + q('Nilai form verbatim (semua string). Sumber tunggal untuk record_hash.') + ';');
  w('COMMENT ON COLUMN records.sections IS');
  w('  ' + q('Huruf section A..I yang terisi pada record ini (FR-2.4).') + ';');
  w('COMMENT ON COLUMN records.status IS');
  w('  ' + q('active = berlaku; redacted = dihapus secara logis. Penghapusan tidak membakar commit.') + ';');
  w('COMMENT ON COLUMN records.institution_id IS');
  w('  ' + q('Instansi pemilik record. Inilah X pada commitment_X = SHA256(record_hash || X) (ADR-3, FR-4.3).') + ';');
  w();

  // --- isi katalog
  w('INSERT INTO field_catalog');
  w('  (column_key, form_field, label, data_type, form_pos, sections, is_required) VALUES');
  const values = rows.map((r) =>
    '  (' + [q(r.column), q(r.field), q(r.label), q(r.type), String(r.pos),
      'ARRAY[' + r.sections.map(q).join(', ') + ']::TEXT[]', String(r.required)].join(', ') + ')');
  w(values.join(',\n') + ';');
  w();

  w('-- Indeks filter umum (FR-4.1)');
  w('CREATE INDEX idx_records_kategori   ON records (jenis_sasaran, sections);');
  w('CREATE INDEX idx_records_wilayah    ON records (nama_kecamatan, nama_desa);');
  w('CREATE INDEX idx_records_kunjungan  ON records (tanggal_kunjungan);');
  w('CREATE INDEX idx_records_created    ON records (created_at);');
  w('CREATE INDEX idx_records_sections   ON records USING GIN (sections);');
  w('CREATE INDEX idx_records_payload    ON records USING GIN (payload_json jsonb_path_ops);');
  w('CREATE INDEX idx_records_institusi ON records (institution_id);');
  w();

  // --- access_log
  w('-- ============================================================================');
  w('-- ACCESS_LOG - append-only, termasuk permintaan yang DITOLAK (FR-4.4)');
  w('-- ============================================================================');
  w('CREATE TABLE access_log (');
  w('  id            BIGSERIAL PRIMARY KEY,');
  w('  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  actor_type    TEXT   NOT NULL CHECK (actor_type IN (' + q('operator') + ', ' + q('agency') + ', ' + q('admin') + ')),');
  w('  actor_id      BIGINT,');
  w('  category      TEXT   NOT NULL,');
  w('  params        JSONB  NOT NULL DEFAULT ' + q('{}') + '::jsonb,');
  w('  result        TEXT   NOT NULL CHECK (result IN (' + [
    q('success'), q('denied_category'), q('denied_desa'), q('denied_column'),
    q('denied_auth'), q('rate_limited'), q('invalid_format'), q('error'),
  ].join(', ') + ')),');
  w('  response_rows INTEGER NOT NULL DEFAULT 0,');
  w('  ip            INET,');
  w('  endpoint      TEXT');
  w(');');
  w('CREATE INDEX idx_access_log_ts      ON access_log (ts DESC);');
  w('CREATE INDEX idx_access_log_actor   ON access_log (actor_type, actor_id, ts DESC);');
  w('CREATE INDEX idx_access_log_result  ON access_log (result, ts DESC);');
  w();
  w('-- Append-only: cabut hak ubah dan hapus dari semua role termasuk owner.');
  w('REVOKE UPDATE, DELETE ON access_log FROM PUBLIC;');
  w();

  // --- chain_outbox
  w('-- ============================================================================');
  w('-- CHAIN_OUTBOX - transactional outbox (FR-3.1, FR-3.6, ADR-2)');
  w('-- UNIQUE (record_id, version) adalah idempotency key anti double-anchor (AT-05).');
  w('-- ============================================================================');
  w('CREATE TABLE chain_outbox (');
  w('  id            BIGSERIAL PRIMARY KEY,');
  w('  record_id     TEXT   NOT NULL,');
  w('  version       INTEGER NOT NULL,');
  w('  supersedes_id TEXT,');
  w('  commitment    TEXT   NOT NULL,');
  w('  chain_status  TEXT   NOT NULL DEFAULT ' + q('pending') + ' CHECK (chain_status IN (' +
    [q('pending'), q('anchored'), q('failed'), q('skipped')].join(', ') + ')),');
  w('  attempts      INTEGER NOT NULL DEFAULT 0,');
  w('  next_retry_at TIMESTAMPTZ,');
  w('  tx_hash       TEXT,');
  w('  anchored_at   TIMESTAMPTZ,');
  w('  last_error    TEXT,');
  w('  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  UNIQUE (record_id, version)');
  w(');');
  w('CREATE INDEX idx_outbox_pending ON chain_outbox (next_retry_at) WHERE chain_status IN (' +
    q('pending') + ', ' + q('failed') + ');');
  w();

  w('-- ============================================================================');
  w('-- SHEETS_PENDING - async flush ke Google Sheets (hybrid bercabang)');
  w('-- Record disimpan dulu di DB, return cepat ke user; cron flush ke Sheets.');
  w('-- ============================================================================');
  w('CREATE TABLE sheets_pending (');
  w('  id            BIGSERIAL PRIMARY KEY,');
  w('  payload_json  JSONB   NOT NULL,');
  w('  row_data      JSONB   NOT NULL,  -- array baris untuk Sheets append');
  w('  status        TEXT    NOT NULL DEFAULT ' + q('pending') + ' CHECK (status IN (' +
    [q('pending'), q('done'), q('failed')].join(', ') + ')),');
  w('  attempts      INTEGER NOT NULL DEFAULT 0,');
  w('  next_retry_at TIMESTAMPTZ,');
  w('  last_error    TEXT,');
  w('  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  done_at       TIMESTAMPTZ');
  w(');');
  w('CREATE INDEX idx_sheets_pending_pending ON sheets_pending (next_retry_at) WHERE status IN (' +
    q('pending') + ', ' + q('failed') + ');');
  w();

  w();

  // --- RLS
  w('-- ============================================================================');
  w('-- ROW LEVEL SECURITY');
  w('--');
  w('-- Peran diambil dari request.jwt.claims (Supabase). NULLIF dipakai agar setting');
  w('-- kosong menghasilkan NULL, bukan galat saat di-caste ke json.');
  w('-- FORCE dipakai agar RLS juga berlaku untuk pemilik tabel, sehingga kebijakan bisa');
  w('-- diuji di PostgreSQL biasa tanpa Supabase.');
  w('-- ============================================================================');
  w('-- @@FUNGSI_START');
  w('CREATE OR REPLACE FUNCTION jwt_role() RETURNS TEXT AS $fn$');
  w('  SELECT COALESCE(');
  w('    NULLIF(current_setting(' + q('request.jwt.claims') + ', true), ' + q('') + ')::json ->> ' + q('role') + ',');
  w('    ' + q('anon') + ')');
  w('$fn$ LANGUAGE sql STABLE;');
  w();
  w('CREATE OR REPLACE FUNCTION jwt_agency_id() RETURNS BIGINT AS $fn$');
  w('  SELECT NULLIF(');
  w('    NULLIF(current_setting(' + q('request.jwt.claims') + ', true), ' + q('') + ')::json ->> ' + q('agency_id') + ',');
  w('    ' + q('') + ')::BIGINT');
  w('$fn$ LANGUAGE sql STABLE;');
  w('-- @@FUNGSI_END');
  w();
  w('-- Helper: apakah agency boleh melihat satu record? Satu sumber kebenaran untuk');
  w('-- policy dan untuk pengujian, agar tidak ada logika yang terduplikasi.');
  w('-- SECURITY DEFINER diperlukan agar policy tetap bisa membaca tabel agency_*');
  w('-- yang juga memiliki RLS-nya sendiri.');
  w('-- @@FUNGSI_START');
  w('CREATE OR REPLACE FUNCTION agency_can_see(');
  w('  p_agency_id  BIGINT,');
  w('  p_kategori   TEXT,');
  w('  p_kecamatan  TEXT,');
  w('  p_desa       TEXT');
  w(') RETURNS BOOLEAN AS $fn$');
  w('  -- Instansi harus berstatus active (FR-4.15: penolakan harus eksplisit,');
  w('  -- bukan hasil kosong).');
  w('  SELECT EXISTS (SELECT 1 FROM agencies a');
  w('           WHERE a.id = p_agency_id AND a.status = ' + q('active') + ')');
  w('     AND EXISTS (SELECT 1 FROM agency_categories c');
  w('           WHERE c.agency_id = p_agency_id AND c.jenis_sasaran = p_kategori)');
  w('     AND (');
  w('       NOT EXISTS (SELECT 1 FROM agency_desa_scope s WHERE s.agency_id = p_agency_id)');
  w('       OR EXISTS (SELECT 1 FROM agency_desa_scope s');
  w('             WHERE s.agency_id = p_agency_id');
  w('               AND s.nama_kecamatan IS NOT DISTINCT FROM p_kecamatan');
  w('               AND s.nama_desa      IS NOT DISTINCT FROM p_desa)');
  w('     );');
  w('$fn$ LANGUAGE sql STABLE SECURITY DEFINER;');
  w();
  w('GRANT EXECUTE ON FUNCTION agency_can_see(BIGINT, TEXT, TEXT, TEXT) TO PUBLIC;');
  w('-- @@FUNGSI_END');
  w();
  for (const t of ['records', 'agencies', 'agency_categories', 'agency_desa_scope',
    'agency_denied_columns', 'agency_config', 'agency_rate_limit',
    'agency_api_keys', 'access_log', 'chain_outbox']) {
    w('ALTER TABLE ' + t + ' ENABLE ROW LEVEL SECURITY;');
    w('ALTER TABLE ' + t + ' FORCE ROW LEVEL SECURITY;');
  }
  w();
  w('-- Operator/admin: seluruh tabel. RLS tidak mengecek kolom yang dirahasiakan');
  w('-- agency; kolom hanya relevan bagi pembaca agency.');
  w('CREATE POLICY records_operator_all ON records');
  w('  FOR ALL');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- Agency: hanya record sesuai kategori DAN wilayah. Perhatikan tanda kurung:');
  w('-- pada draf pertama policy ini ditulis A AND B AND C OR EXISTS(...) sehingga');
  w('-- cabang OR tidak memeriksa peran sama sekali.');
  w('CREATE POLICY records_agency_select ON records');
  w('  FOR SELECT');
  w('  USING (');
  w('    jwt_role() = ' + q('agency') + '');
  w('    AND status = ' + q('active') + '');
  w('    AND agency_can_see(jwt_agency_id(), jenis_sasaran, nama_kecamatan, nama_desa)');
  w('  );');
  w();
  w('-- Instansi menulis record MILIKNYA SENDIRI (F3.2, FR-3.2/FR-3.4).');
  w('--');
  w('-- Dua hal ditegakkan sekaligus, dan keduanya harus:');
  w('--   1. institution_id = instansi pemanggil. Tanpa ini, instansi A bisa');
  w('--      menulis atas nama instansi B dengan mengisi institution_id');
  w('--      sembarang, dan commitment_X yang dihasilkan akan terlihat sah untuk');
  w('--      X yang bukan pemilik sebenarnya (AT-09). Nilai X diambil dari');
  w('--      agencies lewat subquery, jadi tidak ada nilai dari body yang bisa');
  w('--      menggantikannya. Pengambilan subquery aman karena policy');
  w('--      agencies_own_select memang memperbolehkan instansi membaca barisnya');
  w('--      sendiri.');
  w('--   2. kategori + wilayah, lewat agency_can_see yang SAMA dengan policy');
  w('--      baca. Dua definisi "boleh" pasti menyimpang, dan yang menyimpang di');
  w('--      sini berarti instansi bisa menulis baris yang tidak bisa ia baca --');
  w('--      atau sebaliknya.');
  w('--');
  w('-- DROP + CREATE, bukan CREATE saja, supaya blok ini idempoten: `terapkan`');
  w('-- hanya menarik ulang blok bertanda @@FUNGSI di database yang tabelnya');
  w('-- sudah ada, dan policy baru harus bisa sampai ke sana tanpa memasang ulang');
  w('-- seluruh skema (yang akan gagal karena tabel sudah ada).');
  w('-- @@FUNGSI_START');
  w('DROP POLICY IF EXISTS records_agency_insert ON records;');
  w('CREATE POLICY records_agency_insert ON records');
  w('  FOR INSERT');
  w('  WITH CHECK (');
  w('    jwt_role() = ' + q('agency') + '');
  w('    AND institution_id = (');
  w('      SELECT a.institution_key FROM agencies a');
  w('      WHERE a.id = jwt_agency_id() AND a.status = ' + q('active') + '');
  w('    )');
  w('    AND agency_can_see(jwt_agency_id(), jenis_sasaran, nama_kecamatan, nama_desa)');
  w('  );');
  w('-- @@FUNGSI_END');
  w();
  w('CREATE POLICY agencies_own_select ON agencies');
  w('  FOR SELECT');
  w('  USING (id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- FR-3.1 (keputusan 2026-10-06-7): konsol admin membuat instansi. Tanpa');
  w('-- policy INSERT ini, FORCE ROW LEVEL SECURITY menolak pembuatan instansi');
  w('-- dari peran non-bypass -- seeding hanya bisa lewat peran koneksi yang');
  w('-- melewati RLS, dan tidak ada policy yang menjelaskan jalan mana yang');
  w('-- sah. Pembuat dibatasi operator/admin; instansi sendiri tidak boleh');
  w('-- membuat instansi lain (karantina penyebaran).');
  w('CREATE POLICY agencies_operator_insert ON agencies');
  w('  FOR INSERT');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('CREATE POLICY agency_categories_own_select ON agency_categories');
  w('  FOR SELECT');
  w('  USING (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- FR-4.2: kategori diizinkan ikut dibuat oleh yang sama yang membuat');
  w('-- instansi (operator/admin). Mirip agencies_operator_insert -- kategori');
  w('-- tanpa instansi induk tidak punya arti, dan konsol admin menyusun');
  w('-- keduanya dalam satu formulir.');
  w('CREATE POLICY agency_categories_operator_insert ON agency_categories');
  w('  FOR INSERT');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('CREATE POLICY agency_desa_scope_own_select ON agency_desa_scope');
  w('  FOR SELECT');
  w('  USING (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('CREATE POLICY agency_denied_columns_own_select ON agency_denied_columns');
  w('  FOR SELECT');
  w('  USING (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('CREATE POLICY agency_config_own_select ON agency_config');
  w('  FOR SELECT');
  w('  USING (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- F3.10c (FR-4.9..4.12, FR-4.21): instansi MENGATUR SENDIRI preferensinya.');
  w('-- Sebelumnya agency_config hanya bisa dibaca (own_select); tanpa policy tulis,');
  w('-- FORCE RLS menolak UPSERT apa pun dari peran agency dan endpoint konfigurasi');
  w('-- tidak akan berarti. Kebolehannya dibatasi agency_id = jwt_agency_id():');
  w('-- mengubah preferensi instansi sendiri tidak pernah membuka data instansi lain.');
  w('-- Kolom kuota sengaja BUKAN di sini (lihat agency_rate_limit) supaya "ubah');
  w('-- tampilan" dan "naikkan kuota" bukan satu izin yang sama.');
  w('--');
  w('-- Ditaruh sebagai blok @@FUNGSI idempoten supaya `terapkan` bisa menarik policy');
  w('-- ini ke database yang sudah ada tanpa menjalankan ulang DDL tabel lain.');
  w('--');
  w('-- `column_order` ditambahkan lewat ALTER IF NOT EXISTS: tabel agency_config');
  w('-- sudah ada di database lama (Supabase), jadi CREATE TABLE saja tidak cukup.');
  w('-- @@FUNGSI_START');
  w('ALTER TABLE agency_config ADD COLUMN IF NOT EXISTS column_order TEXT[] NOT NULL DEFAULT ' + q('{}') + ';');
  w('DROP POLICY IF EXISTS agency_config_own_write ON agency_config;');
  w('CREATE POLICY agency_config_own_write ON agency_config');
  w('  FOR ALL');
  w('  USING (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (agency_id = jwt_agency_id() OR jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w('-- @@FUNGSI_END');
  w();
  w('-- Kuota hanya boleh diubah Admin/operator, tidak oleh instansi sendiri.');
  w('-- Instansi boleh MEMBACA kuotanya sendiri supaya bisa menampilkan sisa');
  w('-- kuota, tapi tidak boleh menaikkan sendiri -- kalau bisa, rate limit bukan');
  w('-- pembatas dan hanya hiasan.');
  w('CREATE POLICY agency_rate_limit_own_read ON agency_rate_limit');
  w('  FOR SELECT');
  w('  USING (agency_id = jwt_agency_id());');
  w();
  w('CREATE POLICY agency_rate_limit_operator_all ON agency_rate_limit');
  w('  FOR ALL');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- Kredensial API tidak pernah dibaca oleh role agency (kehasiaan).');
  w('CREATE POLICY agency_api_keys_operator_only ON agency_api_keys');
  w('  FOR ALL');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('CREATE POLICY chain_outbox_operator_only ON chain_outbox');
  w('  FOR ALL');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- F3.3 (FR-3.6): instansi mengantrekan versi MILIKNYA SENDIRI ke outbox');
  w('-- dalam transaksi yang sama dengan INSERT records. Pengikat kepemilikan');
  w('-- adalah created_by = agency:<id> pada baris records yang sama');
  w('-- (record_id + version): instansi tidak punya cara lain untuk');
  w('-- membuktikan versi itu miliknya. Tanpa policy INSERT ini, FORCE ROW');
  w('-- LEVEL SECURITY menolak enqueue apa pun dari peran agency -- transaksi');
  w('-- tulis F3.2 yang sukses akan di-rollback di sini.');
  w('--');
  w('-- DROP + CREATE seperti policy agency lain, supaya `terapkan` bisa menarik');
  w('-- ulang versi terbaru ke database yang sudah ada.');
  w('-- @@FUNGSI_START');
  w('DROP POLICY IF EXISTS chain_outbox_agency_insert ON chain_outbox;');
  w('CREATE POLICY chain_outbox_agency_insert ON chain_outbox');
  w('  FOR INSERT');
  w('  WITH CHECK (');
  w('    jwt_role() = ' + q('agency') + '');
  w('    AND EXISTS (');
  w('      SELECT 1 FROM records r');
  w('      WHERE r.record_id = chain_outbox.record_id');
  w('        AND r.version = chain_outbox.version');
  w('        AND r.created_by = ' + q('agency:') + ' || jwt_agency_id()');
  w('    )');
  w('  );');
  w('-- @@FUNGSI_END');
  w();
  w('-- ============================================================================');
  w('-- AUDIT_ANCHOR - akar pohon Merkle log akses yang di-anchor berkala (F4.3 / FR-8.1)');
  w('--');
  w('-- Satu baris = satu batch log [from_seq, to_seq] (1-based menurut urutan id).');
  w('-- `root` = akar pohon Merkle atas hash entri batch itu; `head_hash` =');
  w('-- entry_hash entri terakhir, supaya pemotongan ekor (F4.1) bisa ditolak lewat');
  w('-- expectedHead. `tx_hash` diisi oleh `tools/worker-audit-anchor.js` setelah');
  w('-- akar dicatat on-chain lewat `DataAnchor.anchorAuditRoot` (FR-7.4); bila');
  w('-- rantai belum dikonfigurasi ia NULL -- anchor off-chain tetap berlaku dan');
  w('-- cukup untuk membuktikan T1.');
  w('--');
  w('-- PENTING (keterbatasan yang ditulis jujur): anchor off-chain menyimpan akar');
  w('-- di database yang SAMA, jadi tidak tahan terhadap penyusup yang mengubah');
  w('-- tabel ini dan access_log sekaligus. Yang membuatnya bermakna adalah tx_hash');
  w('-- on-chain nanti; sebelum itu, bukti T1 hanya sekuat kepercayaan pada operator.');
  w('--');
  w('-- Diletakkan sebagai blok @@FUNGSI idempoten (CREATE ... IF NOT EXISTS + DROP');
  w('-- POLICY) supaya `terapkan` bisa membuat tabel BARU ini di database yang');
  w('-- sudah ada (mis. Supabase) tanpa menjalankan ulang DDL tabel lain. Tabel lain');
  w('-- dibuat sekali saat pemasangan pertama; tabel yang menyusul sesudah itu tidak');
  w('-- punya jalur sampai ke database lama kecuali lewat blok seperti ini.');
  w('-- @@FUNGSI_START');
  w('CREATE TABLE IF NOT EXISTS audit_anchor (');
  w('  id           BIGSERIAL PRIMARY KEY,');
  w('  from_seq     BIGINT  NOT NULL,');
  w('  to_seq       BIGINT  NOT NULL,');
  w('  leaf_count   INTEGER NOT NULL,');
  w('  root         TEXT    NOT NULL,');
  w('  head_hash    TEXT    NOT NULL,');
  w('  algorithm    TEXT    NOT NULL,');
  w('  tx_hash      TEXT,');
  w('  anchored_at  TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),');
  w('  CHECK (from_seq >= 1 AND to_seq >= from_seq),');
  w('  CHECK (leaf_count = to_seq - from_seq + 1)');
  w(');');
  w('CREATE INDEX IF NOT EXISTS idx_audit_anchor_to_seq ON audit_anchor (to_seq DESC);');
  w('ALTER TABLE audit_anchor ENABLE ROW LEVEL SECURITY;');
  w('ALTER TABLE audit_anchor FORCE ROW LEVEL SECURITY;');
  w('DROP POLICY IF EXISTS audit_anchor_operator_all ON audit_anchor;');
  w('CREATE POLICY audit_anchor_operator_all ON audit_anchor');
  w('  FOR ALL');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '))');
  w('  WITH CHECK (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w('-- @@FUNGSI_END');
  w();
  w('-- ============================================================================');
  w('-- FIELD_CATALOG dan RLS');
  w('--');
  w('-- field_catalog adalah turunan murni dari FIELD_ORDER/LABELS di kode: nama,');
  w('-- label, tipedata -- tidak pernah memuat data sasaran. Kendalanya: kalau RLS');
  w('-- ON tanpa policy (keadaan yang ditemukan di Supabase), SEMUA peran non-owner');
  w('-- melihat nol baris. Dampaknya bukan hanya UI: trigger `validasi_hidden_fields`');
  w('-- berjalan sebagai peran pemanggil (app_api), jadi katalog yang "kosong"');
  w('-- membuat SETIAP hidden_fields/column_order ditolak -- invariant database');
  w('-- yang hidup-buta di belakang nol baris.');
  w('--');
  w('-- Untuk menutupnya, katalog diberi policy SELECT publik yang eksplisit: siapa');
  w('-- pun boleh MEMBACA katalog, tidak ada yang boleh menulis lewat peran');
  w('-- aplikasi (tidak ada policy INSERT/UPDATE/DELETE), dan pemilik tetap bisa');
  w('-- mengisi katalog saat pemasangan karena RLS dipakai tanpa FORCE.');
  w('--');
  w('-- Dimuat sebagai blok @@FUNGSI idempoten supaya sampai ke database yang sudah');
  w('-- ada. ENABLE dijalankan berulang dengan aman (sudah ON tidak apa-apa).');
  w('-- @@FUNGSI_START');
  w('ALTER TABLE field_catalog ENABLE ROW LEVEL SECURITY;');
  w('DROP POLICY IF EXISTS field_catalog_public_read ON field_catalog;');
  w('CREATE POLICY field_catalog_public_read ON field_catalog');
  w('  FOR SELECT');
  w('  USING (true);');
  w('-- @@FUNGSI_END');
  w();
  w('-- yang ditolak) dan role operator/admin boleh SELECT. Tidak boleh UPDATE/DELETE.');
  w('CREATE POLICY access_log_append ON access_log');
  w('  FOR INSERT');
  w('  WITH CHECK (true);');
  w();
  w('CREATE POLICY access_log_read ON access_log');
  w('  FOR SELECT');
  w('  USING (jwt_role() IN (' + q('operator') + ', ' + q('admin') + '));');
  w();
  w('-- ============================================================================');
  w('-- KOLOM YANG DIBLOKIR (FR-4.20)');
  w('--');
  w('-- Penegakan kolom tidak dilakukan lewat RLS: RLS hanya memfilter BARIS.');
  w('-- Query API menyusun daftar SELECT hanya dari kolom yang diizinkan, dan');
  w('-- mengembalikan FIELD_NOT_GRANTED bila klien meminta kolom terlarang');
  w('-- (FR-4.20a..4.20c). Kolom terlarang TIDAK diubah di penyimpanan: penegakannya');
  w('-- ada di lapisan kueri (proyeksi SELECT eksplisit), dengan penjaga kedua');
  w('-- `filterRows` sebelum respons dikirim -- bukan dengan men-NULL-kan kolom.');
  w('--');
  w('-- Kolom bawaan yang diblokir keras (PRD 6.4.1a): ' + DENIED_BAWAAN_KEYS.join(', ') + '.');
  w('--');
  w('-- Kelima nama itu ditulis di dalam fungsi, BUKAN disemai ke');
  w('-- agency_denied_columns. Alasannya: tabel itu hanya berisi tambahan pilihan');
  w('-- Admin per instansi, dan instantiate baru bisa datang dengan tabel kosong.');
  w('-- Kalau blokir bawaan ikut bergantung pada isi tabel, instansi yang belum');
  w('-- pernah menambah kolom terlarang akan otomatis dapat kelima kolom itu --');
  w('-- tepat hal yang paling tidak boleh terjadi, dan tanpa galat apa pun.');
  w('--');
  w('-- Menghapus agency_denied_columns untuk satu agency TIDAK dapat melepas');
  w('-- blokir bawaan: UNION di bawah selalu mengembalikannya.');
  w('-- ============================================================================');
  w('-- @@FUNGSI_START');
  w('CREATE OR REPLACE FUNCTION denied_columns(p_agency_id BIGINT) RETURNS TEXT[] AS $fn$');
  w('  SELECT ARRAY(');
  w('    SELECT column_key FROM (');
  w('      SELECT unnest(ARRAY[' + DENIED_BAWAAN_KEYS.map(q).join(', ') + ']::TEXT[]) AS column_key');
  w('      UNION');
  w('      SELECT column_key FROM agency_denied_columns WHERE agency_id = p_agency_id');
  w('    ) AS gabung');
  w('  )');
w('$fn$ LANGUAGE sql STABLE;');
  w();
  w('GRANT EXECUTE ON FUNCTION denied_columns(BIGINT) TO PUBLIC;');
  w('-- @@FUNGSI_END');
  w();
  w('GRANT EXECUTE ON FUNCTION denied_columns(BIGINT) TO PUBLIC;');
  w();
  w('-- ============================================================================');
  w('-- PENCARIAN KUNCI API (F3.10a)');
  w('--');
  w('-- Verifikasi kunci terjadi SEBELUM identitas pemanggil diketahui -- itulah');
  w('-- gunanya verifikasi. Kalau pencarian dibatasi policy agency_api_keys_operator');
  w('-- (operator/admin saja), sistem terjebak: permintaan pertama dari klien tidak');
  w('-- mungkin membuktikan dirinya operator, jadi RLS memastikan 401.');
  w('--');
  w('-- SECURITY DEFINER adalah jalan yang tepat, bukan pelonggaran policy:');
  w('-- fungsi ini berjalan sebagai pemilik (yang melewati RLS), tapi satu-satunya');
  w('-- hal yang bisa dicari oleh pemanggil adalah baris yang key_hash-nya PERSIS');
  w('-- sama dengan input. Hash adalah SHA-256 token, jadi pemanggil hanya bisa');
  w('-- menemukan baris yang token aslinya sudah ia pegang -- tidak ada baris apa');
  w('-- pun yang dibocorkan tanpa kredensial. Ini persis pola agency_can_see():');
  w('-- policy memanggil SECURITY DEFINER untuk membaca tabel agency_* yang juga');
  w('-- punya RLS sendiri.');
  w('--');
  w('-- Kolom yang dikembalikan cukup untuk verifikasi status dan scope di');
  w('-- lib/api-key-auth.js. key_hash dan revoked stuff tidak pernah dikembalikan.');
  w('-- ============================================================================');
  w('-- @@FUNGSI_START');
  w('CREATE OR REPLACE FUNCTION cari_kunci(p_key_hash TEXT)');
  w('RETURNS TABLE (');
  w('  id          BIGINT,');
  w('  agency_id   BIGINT,');
  w('  status      TEXT,');
  w('  category    TEXT,');
  w('  table_name  TEXT,');
  w('  key_prefix  TEXT');
  w(') AS $fn$');
  w('  SELECT k.id, k.agency_id, k.status::TEXT, k.category, k.table_name, k.key_prefix');
  w('  FROM agency_api_keys k');
  w('  WHERE k.key_hash = p_key_hash');
  w('  LIMIT 1');
  w('$fn$ LANGUAGE sql STABLE SECURITY DEFINER;');
  w();
  w('COMMENT ON FUNCTION cari_kunci(TEXT) IS');
  w('  ' + q('Cari satu baris kunci API dari key_hash. SECURITY DEFINER: berjalan sebagai pemilik supaya verifikasi bisa terjadi sebelum identitas pemanggil diketahui. Tidak mengembalikan key_hash; pemanggil hanya bisa menemukan baris yang token aslinya ia pegang.') + ';');
  w();
  w('GRANT EXECUTE ON FUNCTION cari_kunci(TEXT) TO PUBLIC;');
  w('-- @@FUNGSI_END');
  w();
  w('COMMIT;');
  w();

  return out.join('\n');
}

/**
 * Pastikan bagian yang tidak boleh hilang benar-benar ada di SQL hasil emit.
 *
 * Dilakukan terhadap TEKS hasil, bukan terhadap daftar `problems` di atas,
 * karena bentuk yang hilang biasanya bukan "kolom bentrok" melainkan "blok ini
 * tidak ikut ter-emit". Memeriksa sumbernya hanya membuktikan niat, bukan
 * hasil.
 */
function assertRequiredMarkers(sql) {
  const hilang = [];
  for (const [where, marker] of REQUIRED_SCHEMA_MARKERS) {
    if (!sql.includes(marker)) {
      hilang.push('SQL tidak memuat ' + where + ': ' + marker.trim());
    }
  }
  if (hilang.length) {
    throw new Error(
      'Pemeriksaan penanda wajib gagal -- hasil emit tidak lengkap:\n  - ' +
      hilang.join('\n  - ') +
      '\n\nKalau ini memang sengaja dihapus, perbarui REQUIRED_SCHEMA_MARKERS ' +
      'di tools/generate-schema.js sekaligus catat alasannya di dokumen keputusan.'
    );
  }
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function columnsSpanningSections(rows) {
  return rows.filter((r) => r.sections.length > 1).map((r) => r.column);
}

// ---------------------------------------------------------------------------
// 4. CLI
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const catalog = buildCatalog();
  const sql = emit(catalog);
  assertRequiredMarkers(sql);

  if (args.includes('--stdout')) {
    process.stdout.write(sql);
    return;
  }

  if (args.includes('--check')) {
    if (!fs.existsSync(DEFAULT_OUT)) {
      console.error('BELUM ADA: ' + DEFAULT_OUT);
      process.exit(1);
    }
    const current = fs.readFileSync(DEFAULT_OUT, 'utf8');
    if (current !== sql) {
      console.error('SKEMA BEDA dari hasil generator. Jalankan: node tools/generate-schema.js');
      process.exit(1);
    }
    console.log('Skema identik dengan hasil generator.');
    return;
  }

  fs.mkdirSync(path.dirname(DEFAULT_OUT), { recursive: true });
  fs.writeFileSync(DEFAULT_OUT, sql, 'utf8');
  const { rows, markCount } = catalog;
  console.log('Ditulis: ' + DEFAULT_OUT);
  console.log('  kolom proyeksi : ' + rows.length);
  console.log('  section        : ' + markCount + ' penanda, ' + SECTIONS.length + ' huruf');
  console.log('  multi-section  : ' + columnsSpanningSections(rows).join(', '));
  console.log('  baris SQL      : ' + sql.split('\n').length);
}

if (require.main === module) main();

module.exports = { buildCatalog, emit, snake, columnName };
