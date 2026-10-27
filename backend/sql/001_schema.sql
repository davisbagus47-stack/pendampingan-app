-- ============================================================================
-- Skema PostgreSQL - Data Center Sasaran Pendampingan
--
-- BERKAS INI DIHASILKAN. Jangan diedit manual.
-- Sumber: backend/index.js (FIELD_ORDER, LABELS)
--         frontend/src/pages/FormPendampingan.jsx (section A..I)
-- Regenerasi: node backend/tools/generate-schema.js
--
-- Jumlah kolom proyeksi : 72 (dari FIELD_ORDER)
-- Section di form        : 12 penanda untuk 9 section (F punya 4 varian)
-- Kolom wajib            : 7
--
-- Determinisme: TIDAK ada cap waktu di berkas ini. Kriteria keluar F1
-- mensyaratkan "menjalankan generator dua kali menghasilkan skema identik".
-- ============================================================================

BEGIN;

-- Ekstensi ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- FIELD_CATALOG - katalog kolom hasil turunan dari kode
-- Dipakai UI (daftar filter), validasi FR-4.20, dan dokumentasi.
-- ============================================================================
CREATE TABLE field_catalog (
  column_key   TEXT    NOT NULL PRIMARY KEY,
  form_field   TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL,
  data_type    TEXT    NOT NULL,
  form_pos     SMALLINT NOT NULL,
  sections     TEXT[]  NOT NULL,
  is_required  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT field_catalog_sections_known
    CHECK (sections <@ ARRAY['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])
);

COMMENT ON TABLE field_catalog IS
  'Katalog kolom yang dihasilkan dari FIELD_ORDER/LABELS di backend/index.js. Jangan diedit manual.';

-- ============================================================================
-- AGENCIES - instansi penerima dan haknya (FR-1.4, FR-1.5, FR-4.x)
-- ============================================================================
CREATE TABLE agencies (
  id          BIGSERIAL PRIMARY KEY,
  -- Kunci bisnis instansi. Inilah bentuk institution_X pada ADR-3,
  -- jadi nilainya terikat ke dalam commitment dan tidak boleh diubah
  -- setelah ada record. Format: slug huruf kecil, tanda hubung, angka
  -- (contoh "kota-bogor"). Kolom name boleh diganti tanpa membatalkan
  -- commitment; yang tidak boleh diganti adalah yang ini.
  institution_key TEXT    NOT NULL UNIQUE
               CHECK (institution_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        TEXT      NOT NULL UNIQUE,
  contact     TEXT,
  status      TEXT      NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- FR-4.2: kategori yang diizinkan. CHECK memuat lima kategori ADR-5.
-- PoC F0.6: Bidang KB diberi segmen "PUS" = lima kategori.
CREATE TABLE agency_categories (
  agency_id     BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  jenis_sasaran TEXT   NOT NULL CHECK (jenis_sasaran IN ('Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita')),
  PRIMARY KEY (agency_id, jenis_sasaran)
);

-- FR-4.17: wilayah yang diizinkan. Tabel kosong untuk satu agency = seluruh wilayah.
CREATE TABLE agency_desa_scope (
  agency_id      BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  nama_kecamatan TEXT   NOT NULL,
  nama_desa      TEXT   NOT NULL,
  PRIMARY KEY (agency_id, nama_kecamatan, nama_desa)
);

-- FR-4.20: kolom yang DIBLOKIR keras, ditegakkan RLS. Berbeda dari field
-- yang hanya disembunyikan (FR-4.10) -- lihat agency_config.hidden_fields.
CREATE TABLE agency_denied_columns (
  agency_id  BIGINT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  column_key TEXT   NOT NULL REFERENCES field_catalog(column_key) ON DELETE CASCADE,
  PRIMARY KEY (agency_id, column_key)
);

-- FR-4.9..4.12, FR-4.21: preferensi tampilan. TIDAK memengaruhi otorisasi.
CREATE TABLE agency_config (
  agency_id       BIGINT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  hidden_fields   TEXT[]   NOT NULL DEFAULT '{}',
  -- FR-4.9 "urutan kolom": urutan kolom yang diinginkan instansi di portal.
  -- Daftar kosong = pakai urutan bawaan FIELD_ORDER.
  column_order    TEXT[]   NOT NULL DEFAULT '{}',
  default_filters JSONB    NOT NULL DEFAULT '{}'::jsonb,
  default_format  TEXT     NOT NULL DEFAULT 'json' CHECK (default_format IN ('json', 'csv', 'xlsx')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);

-- Setiap elemen hidden_fields harus ada di field_catalog. Tidak bisa
-- jadi CHECK: PostgreSQL melarang subquery dalam CHECK. Trigger menjaga
-- invariant yang sama di lapisan database, sesuai pola F3.7: keabsahan
-- bukan tanggung jawab penulis api saja.
CREATE FUNCTION validasi_hidden_fields() RETURNS trigger AS $$
DECLARE
  tak_ada TEXT;
BEGIN
  SELECT c INTO tak_ada
    FROM unnest(NEW.hidden_fields) AS c
    WHERE NOT EXISTS (
      SELECT 1 FROM field_catalog f WHERE f.column_key = c
    )
    LIMIT 1;
  IF tak_ada IS NOT NULL THEN
    RAISE EXCEPTION 'hidden_fields memuat kolom yang tidak ada: %', tak_ada
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agency_config_hidden_fields
  BEFORE INSERT OR UPDATE OF hidden_fields ON agency_config
  FOR EACH ROW EXECUTE FUNCTION validasi_hidden_fields();

-- FR-4.5, AT-14: rate limit dan kuota per instansi.
--
-- Dipisah dari agency_config dengan sengaja. agency_config berisi
-- preferensi tampilan, sedangkan kuota membatasi Abuse -- kalau keduanya
-- satu tabel, "ubah preferensi" dan "ubah batas pemakaian" jadi satu izin
-- yang sama, dan perubahan kuota bisa lolos tanpa ditinjau.
--
-- NULL berarti pakai nilai bawaan aplikasi (lihat BAWAAN di
-- lib/rate-limit.js). Kolom tidak diisi berarti Agencies tidak diberi kuota
-- khusus, bukan kuota nol: nol berarti menolak semua permintaan, dan itu
-- keputusan yang harus ditulis eksplisit.
CREATE TABLE agency_rate_limit (
  agency_id    BIGINT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  kuota        INTEGER     CHECK (kuota > 0),
  jendela_ms   INTEGER     CHECK (jendela_ms >= 100),
  burst        INTEGER     CHECK (burst >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- Kuota hanya berarti kalau dihitung per instansi. Indeks ini membuat
-- pembacaan konfigurasi untuk satu Agencies tetap O(1) meski tabel
-- bertambah.
CREATE INDEX idx_agency_rate_limit_konfigurasi ON agency_rate_limit (agency_id);

CREATE TYPE agency_key_status AS ENUM ('primary', 'standby', 'revoked');
CREATE TABLE agency_api_keys (
  id            BIGSERIAL PRIMARY KEY,
  agency_id     BIGINT      NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  key_hash      TEXT        NOT NULL UNIQUE,
  key_prefix    TEXT        NOT NULL,
  status        agency_key_status NOT NULL DEFAULT 'primary',
  category      TEXT,
  table_name    TEXT,
  label         TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  CONSTRAINT agency_api_keys_scope_whole CHECK (category IS NOT NULL OR table_name IS NULL),
  CONSTRAINT agency_api_keys_category FOREIGN KEY (agency_id, category)
    REFERENCES agency_categories (agency_id, jenis_sasaran) ON DELETE CASCADE
);
CREATE INDEX idx_agency_api_keys_hash ON agency_api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_agency_api_keys_one_primary
  ON agency_api_keys (agency_id) WHERE status = 'primary';
CREATE UNIQUE INDEX idx_agency_api_keys_one_standby
  ON agency_api_keys (agency_id) WHERE status = 'standby';

-- ============================================================================
-- TPK_MEMBERS - daftar anggota TPK dari Surat Keputusan
-- ============================================================================
CREATE TABLE tpk_members (
  id              BIGSERIAL PRIMARY KEY,
  nik             TEXT NOT NULL UNIQUE CHECK (nik ~ '^[0-9]{16}$'),
  nama_lengkap    TEXT NOT NULL,
  id_tpk          TEXT,
  unsur           TEXT,
  tim             TEXT,
  daerah_binaan   TEXT,
  no_hp           TEXT,
  no_rek_jatim    TEXT,
  tempat_lahir    TEXT,
  tanggal_lahir   DATE,
  operator_hp     TEXT,
  pendidikan      TEXT,
  desa_kelurahan  TEXT,
  wallet_address  TEXT UNIQUE,
  wallet_created_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tpk_members_nama ON tpk_members (nama_lengkap);
CREATE INDEX idx_tpk_members_desa ON tpk_members (desa_kelurahan);

-- ============================================================================
-- RECORDS - system of record dengan versioning (ADR-1, ADR-4)
--
-- Kolom domain adalah PROYEKSI dari payload untuk keperluan filter
-- (FR-4.2 kategori, FR-4.17 wilayah, FR-4.20 kolom).
-- payload_json menyimpan nilai VERBATIM dari form karena record_hash dihitung
-- dari canonical_json(payload) -- parse ulang berisiko mengubah hash (mis. NIK
-- ber-0 depan).
--
-- Kebijakan parse kolom non-TEXT: kosong/"-"/"N/A" -> NULL; koma desimal
-- "70,00" -> 70.00; satuan ("70 kg") dibuang; gagal parse -> NULL, bukan galat.
-- Payloads yang gagal parse tetap utuh di payload_json.
-- ============================================================================
CREATE TABLE records (
  id              BIGSERIAL   PRIMARY KEY,
  record_id       TEXT        NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id   BIGINT      REFERENCES records(id),
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redacted')),
  payload_json    JSONB       NOT NULL,
  record_hash     TEXT        NOT NULL UNIQUE,
  schema_version  SMALLINT    NOT NULL DEFAULT 1,

  -- INSTANSI PEMILIK (ADR-3). Kolom ini tidak ada pada draf pertama.
  -- Tanpa itu FR-4.3 mustahil: commitment_X butuh institution_X, dan
  -- satu record bisa dibaca banyak instansi sehingga "X" tidak bisa
  -- ditentukan dari pemanggil. Karena pemanggil boleh berbeda-beda untuk
  -- record yang sama, memadcommitment dengan identitas pemanggil membuat
  -- tiap penerima mendapat nilai berbeda dan verifikasi independen
  -- (tujuan FR-4.3) justru rusak. X = pemilik.
  --
  -- Tipe TEXT, bukan agencies.id. id bersifat posisional: dump lalu restore
  -- dapat mengubah urutannya, dan karena institution_X masuk ke dalam
  -- commitment, itu membuat SEMUA commitment historis tidak lagi
  -- verifiable. Kunci teks tidak punya sifat itu.
  institution_id  TEXT        NOT NULL REFERENCES agencies(institution_key),

  -- taksonomi (ADR-5, FR-2.4). jenis_sasaran sengaja TIDAK dideklarasikan di
  -- sini karena jenis_sasaran juga ada di FIELD_ORDER; batasan nilainya
  -- dituliskan pada kolom proyeksinya agar tidak terdefinisi dua kali.
  -- Kategori (ADR-5): Catin, Ibu Hamil, Ibu Nifas, Baduta, Balita.
  -- Satu record dapat mengisi beberapa section:
  -- terpapar_rokok, catatan_tpk muncul di >1 section.
  -- Karena itu section disimpan sebagai larik, bukan satu nilai.
  sections        TEXT[]      NOT NULL DEFAULT '{}',
                 CHECK (sections <@ ARRAY['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']),

  -- kolom hasil turunan dari FIELD_ORDER
  -- section A (Data Petugas & Lokasi Kerja)
  nama_tpk            TEXT          NOT NULL,  -- Nama Petugas TPK
  peran_tpk           TEXT          NOT NULL,  -- Peran dalam TPK
  no_hp_tpk           TEXT         ,  -- No. HP Petugas
  nama_desa           TEXT          NOT NULL,  -- Desa/Kelurahan
  nama_kecamatan      TEXT         ,  -- Kecamatan
  rw                  TEXT         ,  -- RW
  rt                  TEXT         ,  -- RT
  -- section B (Biodata Sasaran Pendampingan)
  nik                 TEXT          NOT NULL,  -- NIK
  no_kk               TEXT         ,  -- No. KK
  nama_lengkap        TEXT          NOT NULL,  -- Nama Lengkap
  no_hp               TEXT         ,  -- No. HP/WA
  tanggal_lahir       DATE         ,  -- Tanggal Lahir
  usia                NUMERIC(4,1) ,  -- Usia (tahun)
  alamat              TEXT         ,  -- Alamat
  jenis_sasaran       TEXT          NOT NULL CHECK (jenis_sasaran IN ('Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita')),  -- Jenis Sasaran
  -- section C (Kondisi Rumah & Lingkungan)
  sumber_air          TEXT         ,  -- Akses Air Minum
  jamban              TEXT         ,  -- Fasilitas BAB (Jamban)
  -- section C, F (Kondisi Rumah & Lingkungan)
  terpapar_rokok      TEXT         ,  -- Terpapar Rokok
  -- section D (Faktor Risiko 4T)
  terlalu_muda        TEXT         ,  -- Terlalu Muda
  terlalu_tua         TEXT         ,  -- Terlalu Tua
  terlalu_dekat       TEXT         ,  -- Terlalu Dekat
  terlalu_banyak      TEXT         ,  -- Terlalu Banyak
  -- section E (Status KB & Jaminan Kesehatan)
  gunakan_kb          TEXT         ,  -- Status KB
  jenis_kb            TEXT         ,  -- Jenis/Alat KB
  rencana_kb          TEXT         ,  -- Rencana KB (Catin)
  rencana_kehamilan   TEXT         ,  -- Rencana Kehamilan (Catin)
  bpjs_aktif          TEXT         ,  -- BPJS Aktif
  jenis_bpjs          TEXT         ,  -- Jenis BPJS
  dtks                TEXT         ,  -- Terdaftar DTKS
  bansos_diterima     TEXT         ,  -- Bansos Diterima
  -- section F (Pemeriksaan Ibu Hamil)
  hpht                DATE         ,  -- HPHT
  usia_kehamilan      NUMERIC(4,1) ,  -- Usia Kehamilan (minggu)
  bb_sebelum_hamil    NUMERIC(5,1) ,  -- BB Sebelum Hamil (kg)
  bb_sekarang         NUMERIC(5,1) ,  -- BB Sekarang (kg)
  tb                  NUMERIC(5,1) ,  -- Tinggi Badan (cm)
  lila                NUMERIC(5,1) ,  -- LILA (cm)
  hb                  NUMERIC(5,1) ,  -- Hb (g/dl)
  tfu                 NUMERIC(5,1) ,  -- TFU (cm)
  tbj                 NUMERIC(8,1) ,  -- TBJ (gram)
  riwayat_penyakit    TEXT         ,  -- Riwayat Penyakit
  terima_ttd          TEXT         ,  -- Terima TTD
  akses_faskes        TEXT         ,  -- Akses Faskes
  hamil_kembar        TEXT         ,  -- Hamil Kembar
  tanggal_lahir_bayi  DATE         ,  -- Tanggal Melahirkan
  umur_bayi           NUMERIC(4,1) ,  -- Umur Bayi saat Lahir (minggu)
  bb_lahir            NUMERIC(5,1) ,  -- BB Lahir (kg)
  pb_lahir            NUMERIC(5,1) ,  -- PB Lahir (cm)
  cukup_bulan         TEXT         ,  -- Cukup Bulan
  asi_eksklusif       TEXT         ,  -- ASI Eksklusif
  sudah_imunisasi     TEXT         ,  -- Imunisasi Rutin
  kak                 TEXT         ,  -- Isi KAK
  stimulasi           TEXT         ,  -- Perkembangan Anak
  nama_ayah           TEXT         ,  -- Nama Ayah
  nik_ayah            TEXT         ,  -- NIK Ayah
  nama_ibu            TEXT         ,  -- Nama Ibu
  nik_ibu             TEXT         ,  -- NIK Ibu
  tanggal_lahir_ibu   DATE         ,  -- Tanggal Lahir Ibu
  -- section G (Kegiatan Pendampingan TPK pada Kunjungan Ini)
  kie_penyuluhan      TEXT         ,  -- KIE Penyuluhan
  jenis_kie           TEXT         ,  -- Jenis KIE
  fasilitasi_rujukan  TEXT         ,  -- Fasilitasi Rujukan
  rujukan_ke          TEXT         ,  -- Rujukan Ke
  rujukan_proses      TEXT         ,  -- Status Rujukan
  fasilitasi_bansos   TEXT         ,  -- Fasilitasi Bansos
  bansos_program      TEXT         ,  -- Program Bansos
  -- section H (Hasil Surveilans & Pemantauan)
  hadir_posyandu      TEXT         ,  -- Hadir Posyandu
  teridentifikasi_risiko TEXT         ,  -- Teridentifikasi Risiko
  -- section I (Data Kunjungan)
  tanggal_kunjungan   DATE          NOT NULL,  -- Tanggal Kunjungan
  -- section G, I (Kegiatan Pendampingan TPK pada Kunjungan Ini)
  catatan_tpk         TEXT         ,  -- Catatan TPK
  -- section A (Data Petugas & Lokasi Kerja)
  tim_tpk             TEXT         ,  -- Tim TPK
  -- section I (Data Kunjungan)
  pendampingan_ke     INTEGER      ,  -- Pendampingan Ke
  -- section B (Biodata Sasaran Pendampingan)
  jenis_kelamin       TEXT          CHECK (jenis_kelamin IN ('Laki-laki', 'Perempuan') OR jenis_kelamin = ''),  -- Jenis Kelamin
  -- section H (Hasil Surveilans & Pemantauan)
  mbg3b               TEXT         ,  -- Sudah Menerima MBG 3B

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT        NOT NULL DEFAULT 'operator',
  UNIQUE (record_id, version)
);

COMMENT ON COLUMN records.payload_json IS
  'Nilai form verbatim (semua string). Sumber tunggal untuk record_hash.';
COMMENT ON COLUMN records.sections IS
  'Huruf section A..I yang terisi pada record ini (FR-2.4).';
COMMENT ON COLUMN records.status IS
  'active = berlaku; redacted = dihapus secara logis. Penghapusan tidak membakar commit.';
COMMENT ON COLUMN records.institution_id IS
  'Instansi pemilik record. Inilah X pada commitment_X = SHA256(record_hash || X) (ADR-3, FR-4.3).';

INSERT INTO field_catalog
  (column_key, form_field, label, data_type, form_pos, sections, is_required) VALUES
  ('nama_tpk', 'namaTPK', 'Nama Petugas TPK', 'TEXT', 1, ARRAY['A']::TEXT[], true),
  ('peran_tpk', 'peranTPK', 'Peran dalam TPK', 'TEXT', 2, ARRAY['A']::TEXT[], true),
  ('no_hp_tpk', 'noHpTPK', 'No. HP Petugas', 'TEXT', 3, ARRAY['A']::TEXT[], false),
  ('nama_desa', 'namaDesa', 'Desa/Kelurahan', 'TEXT', 4, ARRAY['A']::TEXT[], true),
  ('nama_kecamatan', 'namaKecamatan', 'Kecamatan', 'TEXT', 5, ARRAY['A']::TEXT[], false),
  ('rw', 'rw', 'RW', 'TEXT', 6, ARRAY['A']::TEXT[], false),
  ('rt', 'rt', 'RT', 'TEXT', 7, ARRAY['A']::TEXT[], false),
  ('nik', 'nik', 'NIK', 'TEXT', 8, ARRAY['B']::TEXT[], true),
  ('no_kk', 'noKK', 'No. KK', 'TEXT', 9, ARRAY['B']::TEXT[], false),
  ('nama_lengkap', 'namaLengkap', 'Nama Lengkap', 'TEXT', 10, ARRAY['B']::TEXT[], true),
  ('no_hp', 'noHp', 'No. HP/WA', 'TEXT', 11, ARRAY['B']::TEXT[], false),
  ('tanggal_lahir', 'tanggalLahir', 'Tanggal Lahir', 'DATE', 12, ARRAY['B']::TEXT[], false),
  ('usia', 'usia', 'Usia (tahun)', 'NUMERIC(4,1)', 13, ARRAY['B']::TEXT[], false),
  ('alamat', 'alamat', 'Alamat', 'TEXT', 14, ARRAY['B']::TEXT[], false),
  ('jenis_sasaran', 'jenisSasaran', 'Jenis Sasaran', 'TEXT', 15, ARRAY['B']::TEXT[], true),
  ('sumber_air', 'sumberAir', 'Akses Air Minum', 'TEXT', 16, ARRAY['C']::TEXT[], false),
  ('jamban', 'jamban', 'Fasilitas BAB (Jamban)', 'TEXT', 17, ARRAY['C']::TEXT[], false),
  ('terpapar_rokok', 'terpaparRokok', 'Terpapar Rokok', 'TEXT', 18, ARRAY['C', 'F']::TEXT[], false),
  ('terlalu_muda', 'terlaluMuda', 'Terlalu Muda', 'TEXT', 19, ARRAY['D']::TEXT[], false),
  ('terlalu_tua', 'terlaluTua', 'Terlalu Tua', 'TEXT', 20, ARRAY['D']::TEXT[], false),
  ('terlalu_dekat', 'terlaluDekat', 'Terlalu Dekat', 'TEXT', 21, ARRAY['D']::TEXT[], false),
  ('terlalu_banyak', 'terlaluBanyak', 'Terlalu Banyak', 'TEXT', 22, ARRAY['D']::TEXT[], false),
  ('gunakan_kb', 'gunakanKB', 'Status KB', 'TEXT', 23, ARRAY['E']::TEXT[], false),
  ('jenis_kb', 'jenisKB', 'Jenis/Alat KB', 'TEXT', 24, ARRAY['E']::TEXT[], false),
  ('rencana_kb', 'rencanaKB', 'Rencana KB (Catin)', 'TEXT', 25, ARRAY['E']::TEXT[], false),
  ('rencana_kehamilan', 'rencanaKehamilan', 'Rencana Kehamilan (Catin)', 'TEXT', 26, ARRAY['E']::TEXT[], false),
  ('bpjs_aktif', 'bpjsAktif', 'BPJS Aktif', 'TEXT', 27, ARRAY['E']::TEXT[], false),
  ('jenis_bpjs', 'jenisBPJS', 'Jenis BPJS', 'TEXT', 28, ARRAY['E']::TEXT[], false),
  ('dtks', 'dtks', 'Terdaftar DTKS', 'TEXT', 29, ARRAY['E']::TEXT[], false),
  ('bansos_diterima', 'bansosDiterima', 'Bansos Diterima', 'TEXT', 30, ARRAY['E']::TEXT[], false),
  ('hpht', 'hpht', 'HPHT', 'DATE', 31, ARRAY['F']::TEXT[], false),
  ('usia_kehamilan', 'usiaKehamilan', 'Usia Kehamilan (minggu)', 'NUMERIC(4,1)', 32, ARRAY['F']::TEXT[], false),
  ('bb_sebelum_hamil', 'bbSebelumHamil', 'BB Sebelum Hamil (kg)', 'NUMERIC(5,1)', 33, ARRAY['F']::TEXT[], false),
  ('bb_sekarang', 'bbSekarang', 'BB Sekarang (kg)', 'NUMERIC(5,1)', 34, ARRAY['F']::TEXT[], false),
  ('tb', 'tb', 'Tinggi Badan (cm)', 'NUMERIC(5,1)', 35, ARRAY['F']::TEXT[], false),
  ('lila', 'lila', 'LILA (cm)', 'NUMERIC(5,1)', 36, ARRAY['F']::TEXT[], false),
  ('hb', 'hb', 'Hb (g/dl)', 'NUMERIC(5,1)', 37, ARRAY['F']::TEXT[], false),
  ('tfu', 'tfu', 'TFU (cm)', 'NUMERIC(5,1)', 38, ARRAY['F']::TEXT[], false),
  ('tbj', 'tbj', 'TBJ (gram)', 'NUMERIC(8,1)', 39, ARRAY['F']::TEXT[], false),
  ('riwayat_penyakit', 'riwayatPenyakit', 'Riwayat Penyakit', 'TEXT', 40, ARRAY['F']::TEXT[], false),
  ('terima_ttd', 'terimaTTD', 'Terima TTD', 'TEXT', 41, ARRAY['F']::TEXT[], false),
  ('akses_faskes', 'aksesFaskes', 'Akses Faskes', 'TEXT', 42, ARRAY['F']::TEXT[], false),
  ('hamil_kembar', 'hamilKembar', 'Hamil Kembar', 'TEXT', 43, ARRAY['F']::TEXT[], false),
  ('tanggal_lahir_bayi', 'tanggalLahirBayi', 'Tanggal Melahirkan', 'DATE', 44, ARRAY['F']::TEXT[], false),
  ('umur_bayi', 'umurBayi', 'Umur Bayi saat Lahir (minggu)', 'NUMERIC(4,1)', 45, ARRAY['F']::TEXT[], false),
  ('bb_lahir', 'bbLahir', 'BB Lahir (kg)', 'NUMERIC(5,1)', 46, ARRAY['F']::TEXT[], false),
  ('pb_lahir', 'pbLahir', 'PB Lahir (cm)', 'NUMERIC(5,1)', 47, ARRAY['F']::TEXT[], false),
  ('cukup_bulan', 'cukupBulan', 'Cukup Bulan', 'TEXT', 48, ARRAY['F']::TEXT[], false),
  ('asi_eksklusif', 'asiEksklusif', 'ASI Eksklusif', 'TEXT', 49, ARRAY['F']::TEXT[], false),
  ('sudah_imunisasi', 'sudahImunisasi', 'Imunisasi Rutin', 'TEXT', 50, ARRAY['F']::TEXT[], false),
  ('kak', 'kak', 'Isi KAK', 'TEXT', 51, ARRAY['F']::TEXT[], false),
  ('stimulasi', 'stimulasi', 'Perkembangan Anak', 'TEXT', 52, ARRAY['F']::TEXT[], false),
  ('nama_ayah', 'namaAyah', 'Nama Ayah', 'TEXT', 53, ARRAY['F']::TEXT[], false),
  ('nik_ayah', 'nikAyah', 'NIK Ayah', 'TEXT', 54, ARRAY['F']::TEXT[], false),
  ('nama_ibu', 'namaIbu', 'Nama Ibu', 'TEXT', 55, ARRAY['F']::TEXT[], false),
  ('nik_ibu', 'nikIbu', 'NIK Ibu', 'TEXT', 56, ARRAY['F']::TEXT[], false),
  ('tanggal_lahir_ibu', 'tanggalLahirIbu', 'Tanggal Lahir Ibu', 'DATE', 57, ARRAY['F']::TEXT[], false),
  ('kie_penyuluhan', 'kiePenyuluhan', 'KIE Penyuluhan', 'TEXT', 58, ARRAY['G']::TEXT[], false),
  ('jenis_kie', 'jenisKIE', 'Jenis KIE', 'TEXT', 59, ARRAY['G']::TEXT[], false),
  ('fasilitasi_rujukan', 'fasilitasiRujukan', 'Fasilitasi Rujukan', 'TEXT', 60, ARRAY['G']::TEXT[], false),
  ('rujukan_ke', 'rujukanKe', 'Rujukan Ke', 'TEXT', 61, ARRAY['G']::TEXT[], false),
  ('rujukan_proses', 'rujukanProses', 'Status Rujukan', 'TEXT', 62, ARRAY['G']::TEXT[], false),
  ('fasilitasi_bansos', 'fasilitasiBansos', 'Fasilitasi Bansos', 'TEXT', 63, ARRAY['G']::TEXT[], false),
  ('bansos_program', 'bansosProgram', 'Program Bansos', 'TEXT', 64, ARRAY['G']::TEXT[], false),
  ('hadir_posyandu', 'hadirPosyandu', 'Hadir Posyandu', 'TEXT', 65, ARRAY['H']::TEXT[], false),
  ('teridentifikasi_risiko', 'teridentifikasiRisiko', 'Teridentifikasi Risiko', 'TEXT', 66, ARRAY['H']::TEXT[], false),
  ('tanggal_kunjungan', 'tanggalKunjungan', 'Tanggal Kunjungan', 'DATE', 67, ARRAY['I']::TEXT[], true),
  ('catatan_tpk', 'catatanTPK', 'Catatan TPK', 'TEXT', 68, ARRAY['G', 'I']::TEXT[], false),
  ('tim_tpk', 'timTPK', 'Tim TPK', 'TEXT', 69, ARRAY['A']::TEXT[], false),
  ('pendampingan_ke', 'pendampinganKe', 'Pendampingan Ke', 'INTEGER', 70, ARRAY['I']::TEXT[], false),
  ('jenis_kelamin', 'jenisKelamin', 'Jenis Kelamin', 'TEXT', 71, ARRAY['B']::TEXT[], false),
  ('mbg3b', 'mbg3B', 'Sudah Menerima MBG 3B', 'TEXT', 72, ARRAY['H']::TEXT[], false);

-- Indeks filter umum (FR-4.1)
CREATE INDEX idx_records_kategori   ON records (jenis_sasaran, sections);
CREATE INDEX idx_records_wilayah    ON records (nama_kecamatan, nama_desa);
CREATE INDEX idx_records_kunjungan  ON records (tanggal_kunjungan);
CREATE INDEX idx_records_created    ON records (created_at);
CREATE INDEX idx_records_sections   ON records USING GIN (sections);
CREATE INDEX idx_records_payload    ON records USING GIN (payload_json jsonb_path_ops);
CREATE INDEX idx_records_institusi ON records (institution_id);

-- ============================================================================
-- ACCESS_LOG - append-only, termasuk permintaan yang DITOLAK (FR-4.4)
-- ============================================================================
CREATE TABLE access_log (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type    TEXT   NOT NULL CHECK (actor_type IN ('operator', 'agency', 'admin')),
  actor_id      BIGINT,
  category      TEXT   NOT NULL,
  params        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  result        TEXT   NOT NULL CHECK (result IN ('success', 'denied_category', 'denied_desa', 'denied_column', 'denied_auth', 'rate_limited', 'invalid_format', 'error')),
  response_rows INTEGER NOT NULL DEFAULT 0,
  ip            INET,
  endpoint      TEXT
);
CREATE INDEX idx_access_log_ts      ON access_log (ts DESC);
CREATE INDEX idx_access_log_actor   ON access_log (actor_type, actor_id, ts DESC);
CREATE INDEX idx_access_log_result  ON access_log (result, ts DESC);

-- Append-only: cabut hak ubah dan hapus dari semua role termasuk owner.
REVOKE UPDATE, DELETE ON access_log FROM PUBLIC;

-- ============================================================================
-- CHAIN_OUTBOX - transactional outbox (FR-3.1, FR-3.6, ADR-2)
-- UNIQUE (record_id, version) adalah idempotency key anti double-anchor (AT-05).
-- ============================================================================
CREATE TABLE chain_outbox (
  id            BIGSERIAL PRIMARY KEY,
  record_id     TEXT   NOT NULL,
  version       INTEGER NOT NULL,
  supersedes_id TEXT,
  commitment    TEXT   NOT NULL,
  chain_status  TEXT   NOT NULL DEFAULT 'pending' CHECK (chain_status IN ('pending', 'anchored', 'failed', 'skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  tx_hash       TEXT,
  anchored_at   TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_id, version)
);
CREATE INDEX idx_outbox_pending ON chain_outbox (next_retry_at) WHERE chain_status IN ('pending', 'failed');

-- ============================================================================
-- SHEETS_PENDING - async flush ke Google Sheets (hybrid bercabang)
-- Record disimpan dulu di DB, return cepat ke user; cron flush ke Sheets.
-- ============================================================================
CREATE TABLE sheets_pending (
  id            BIGSERIAL PRIMARY KEY,
  payload_json  JSONB   NOT NULL,
  row_data      JSONB   NOT NULL,  -- array baris untuk Sheets append
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at       TIMESTAMPTZ
);
CREATE INDEX idx_sheets_pending_pending ON sheets_pending (next_retry_at) WHERE status IN ('pending', 'failed');


-- ============================================================================
-- ROW LEVEL SECURITY
--
-- Peran diambil dari request.jwt.claims (Supabase). NULLIF dipakai agar setting
-- kosong menghasilkan NULL, bukan galat saat di-caste ke json.
-- FORCE dipakai agar RLS juga berlaku untuk pemilik tabel, sehingga kebijakan bisa
-- diuji di PostgreSQL biasa tanpa Supabase.
-- ============================================================================
-- @@FUNGSI_START
CREATE OR REPLACE FUNCTION jwt_role() RETURNS TEXT AS $fn$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    'anon')
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION jwt_agency_id() RETURNS BIGINT AS $fn$
  SELECT NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'agency_id',
    '')::BIGINT
$fn$ LANGUAGE sql STABLE;
-- @@FUNGSI_END

-- Helper: apakah agency boleh melihat satu record? Satu sumber kebenaran untuk
-- policy dan untuk pengujian, agar tidak ada logika yang terduplikasi.
-- SECURITY DEFINER diperlukan agar policy tetap bisa membaca tabel agency_*
-- yang juga memiliki RLS-nya sendiri.
-- @@FUNGSI_START
CREATE OR REPLACE FUNCTION agency_can_see(
  p_agency_id  BIGINT,
  p_kategori   TEXT,
  p_kecamatan  TEXT,
  p_desa       TEXT
) RETURNS BOOLEAN AS $fn$
  -- Instansi harus berstatus active (FR-4.15: penolakan harus eksplisit,
  -- bukan hasil kosong).
  SELECT EXISTS (SELECT 1 FROM agencies a
           WHERE a.id = p_agency_id AND a.status = 'active')
     AND EXISTS (SELECT 1 FROM agency_categories c
           WHERE c.agency_id = p_agency_id AND c.jenis_sasaran = p_kategori)
     AND (
       NOT EXISTS (SELECT 1 FROM agency_desa_scope s WHERE s.agency_id = p_agency_id)
       OR EXISTS (SELECT 1 FROM agency_desa_scope s
             WHERE s.agency_id = p_agency_id
               AND s.nama_kecamatan IS NOT DISTINCT FROM p_kecamatan
               AND s.nama_desa      IS NOT DISTINCT FROM p_desa)
     );
$fn$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION agency_can_see(BIGINT, TEXT, TEXT, TEXT) TO PUBLIC;
-- @@FUNGSI_END

ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records FORCE ROW LEVEL SECURITY;
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agencies FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_desa_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_desa_scope FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_denied_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_denied_columns FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_config FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_rate_limit FORCE ROW LEVEL SECURITY;
ALTER TABLE agency_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_log FORCE ROW LEVEL SECURITY;
ALTER TABLE chain_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_outbox FORCE ROW LEVEL SECURITY;

-- Operator/admin: seluruh tabel. RLS tidak mengecek kolom yang dirahasiakan
-- agency; kolom hanya relevan bagi pembaca agency.
CREATE POLICY records_operator_all ON records
  FOR ALL
  USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

-- Agency: hanya record sesuai kategori DAN wilayah. Perhatikan tanda kurung:
-- pada draf pertama policy ini ditulis A AND B AND C OR EXISTS(...) sehingga
-- cabang OR tidak memeriksa peran sama sekali.
CREATE POLICY records_agency_select ON records
  FOR SELECT
  USING (
    jwt_role() = 'agency'
    AND status = 'active'
    AND agency_can_see(jwt_agency_id(), jenis_sasaran, nama_kecamatan, nama_desa)
  );

-- Instansi menulis record MILIKNYA SENDIRI (F3.2, FR-3.2/FR-3.4).
--
-- Dua hal ditegakkan sekaligus, dan keduanya harus:
--   1. institution_id = instansi pemanggil. Tanpa ini, instansi A bisa
--      menulis atas nama instansi B dengan mengisi institution_id
--      sembarang, dan commitment_X yang dihasilkan akan terlihat sah untuk
--      X yang bukan pemilik sebenarnya (AT-09). Nilai X diambil dari
--      agencies lewat subquery, jadi tidak ada nilai dari body yang bisa
--      menggantikannya. Pengambilan subquery aman karena policy
--      agencies_own_select memang memperbolehkan instansi membaca barisnya
--      sendiri.
--   2. kategori + wilayah, lewat agency_can_see yang SAMA dengan policy
--      baca. Dua definisi "boleh" pasti menyimpang, dan yang menyimpang di
--      sini berarti instansi bisa menulis baris yang tidak bisa ia baca --
--      atau sebaliknya.
--
-- DROP + CREATE, bukan CREATE saja, supaya blok ini idempoten: `terapkan`
-- hanya menarik ulang blok bertanda @@FUNGSI di database yang tabelnya
-- sudah ada, dan policy baru harus bisa sampai ke sana tanpa memasang ulang
-- seluruh skema (yang akan gagal karena tabel sudah ada).
-- @@FUNGSI_START
DROP POLICY IF EXISTS records_agency_insert ON records;
CREATE POLICY records_agency_insert ON records
  FOR INSERT
  WITH CHECK (
    jwt_role() = 'agency'
    AND institution_id = (
      SELECT a.institution_key FROM agencies a
      WHERE a.id = jwt_agency_id() AND a.status = 'active'
    )
    AND agency_can_see(jwt_agency_id(), jenis_sasaran, nama_kecamatan, nama_desa)
  );
-- @@FUNGSI_END

CREATE POLICY agencies_own_select ON agencies
  FOR SELECT
  USING (id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));

-- FR-3.1 (keputusan 2026-10-06-7): konsol admin membuat instansi. Tanpa
-- policy INSERT ini, FORCE ROW LEVEL SECURITY menolak pembuatan instansi
-- dari peran non-bypass -- seeding hanya bisa lewat peran koneksi yang
-- melewati RLS, dan tidak ada policy yang menjelaskan jalan mana yang
-- sah. Pembuat dibatasi operator/admin; instansi sendiri tidak boleh
-- membuat instansi lain (karantina penyebaran).
CREATE POLICY agencies_operator_insert ON agencies
  FOR INSERT
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

CREATE POLICY agency_categories_own_select ON agency_categories
  FOR SELECT
  USING (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));

-- FR-4.2: kategori diizinkan ikut dibuat oleh yang sama yang membuat
-- instansi (operator/admin). Mirip agencies_operator_insert -- kategori
-- tanpa instansi induk tidak punya arti, dan konsol admin menyusun
-- keduanya dalam satu formulir.
CREATE POLICY agency_categories_operator_insert ON agency_categories
  FOR INSERT
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

CREATE POLICY agency_desa_scope_own_select ON agency_desa_scope
  FOR SELECT
  USING (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));

CREATE POLICY agency_denied_columns_own_select ON agency_denied_columns
  FOR SELECT
  USING (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));

CREATE POLICY agency_config_own_select ON agency_config
  FOR SELECT
  USING (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));

-- F3.10c (FR-4.9..4.12, FR-4.21): instansi MENGATUR SENDIRI preferensinya.
-- Sebelumnya agency_config hanya bisa dibaca (own_select); tanpa policy tulis,
-- FORCE RLS menolak UPSERT apa pun dari peran agency dan endpoint konfigurasi
-- tidak akan berarti. Kebolehannya dibatasi agency_id = jwt_agency_id():
-- mengubah preferensi instansi sendiri tidak pernah membuka data instansi lain.
-- Kolom kuota sengaja BUKAN di sini (lihat agency_rate_limit) supaya "ubah
-- tampilan" dan "naikkan kuota" bukan satu izin yang sama.
--
-- Ditaruh sebagai blok @@FUNGSI idempoten supaya `terapkan` bisa menarik policy
-- ini ke database yang sudah ada tanpa menjalankan ulang DDL tabel lain.
--
-- `column_order` ditambahkan lewat ALTER IF NOT EXISTS: tabel agency_config
-- sudah ada di database lama (Supabase), jadi CREATE TABLE saja tidak cukup.
-- @@FUNGSI_START
ALTER TABLE agency_config ADD COLUMN IF NOT EXISTS column_order TEXT[] NOT NULL DEFAULT '{}';
DROP POLICY IF EXISTS agency_config_own_write ON agency_config;
CREATE POLICY agency_config_own_write ON agency_config
  FOR ALL
  USING (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'))
  WITH CHECK (agency_id = jwt_agency_id() OR jwt_role() IN ('operator', 'admin'));
-- @@FUNGSI_END

-- Kuota hanya boleh diubah Admin/operator, tidak oleh instansi sendiri.
-- Instansi boleh MEMBACA kuotanya sendiri supaya bisa menampilkan sisa
-- kuota, tapi tidak boleh menaikkan sendiri -- kalau bisa, rate limit bukan
-- pembatas dan hanya hiasan.
CREATE POLICY agency_rate_limit_own_read ON agency_rate_limit
  FOR SELECT
  USING (agency_id = jwt_agency_id());

CREATE POLICY agency_rate_limit_operator_all ON agency_rate_limit
  FOR ALL
  USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

-- Kredensial API tidak pernah dibaca oleh role agency (kehasiaan).
CREATE POLICY agency_api_keys_operator_only ON agency_api_keys
  FOR ALL
  USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

CREATE POLICY chain_outbox_operator_only ON chain_outbox
  FOR ALL
  USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));

-- F3.3 (FR-3.6): instansi mengantrekan versi MILIKNYA SENDIRI ke outbox
-- dalam transaksi yang sama dengan INSERT records. Pengikat kepemilikan
-- adalah created_by = agency:<id> pada baris records yang sama
-- (record_id + version): instansi tidak punya cara lain untuk
-- membuktikan versi itu miliknya. Tanpa policy INSERT ini, FORCE ROW
-- LEVEL SECURITY menolak enqueue apa pun dari peran agency -- transaksi
-- tulis F3.2 yang sukses akan di-rollback di sini.
--
-- DROP + CREATE seperti policy agency lain, supaya `terapkan` bisa menarik
-- ulang versi terbaru ke database yang sudah ada.
-- @@FUNGSI_START
DROP POLICY IF EXISTS chain_outbox_agency_insert ON chain_outbox;
CREATE POLICY chain_outbox_agency_insert ON chain_outbox
  FOR INSERT
  WITH CHECK (
    jwt_role() = 'agency'
    AND EXISTS (
      SELECT 1 FROM records r
      WHERE r.record_id = chain_outbox.record_id
        AND r.version = chain_outbox.version
        AND r.created_by = 'agency:' || jwt_agency_id()
    )
  );
-- @@FUNGSI_END

-- ============================================================================
-- AUDIT_ANCHOR - akar pohon Merkle log akses yang di-anchor berkala (F4.3 / FR-8.1)
--
-- Satu baris = satu batch log [from_seq, to_seq] (1-based menurut urutan id).
-- `root` = akar pohon Merkle atas hash entri batch itu; `head_hash` =
-- entry_hash entri terakhir, supaya pemotongan ekor (F4.1) bisa ditolak lewat
-- expectedHead. `tx_hash` diisi oleh `tools/worker-audit-anchor.js` setelah
-- akar dicatat on-chain lewat `DataAnchor.anchorAuditRoot` (FR-7.4); bila
-- rantai belum dikonfigurasi ia NULL -- anchor off-chain tetap berlaku dan
-- cukup untuk membuktikan T1.
--
-- PENTING (keterbatasan yang ditulis jujur): anchor off-chain menyimpan akar
-- di database yang SAMA, jadi tidak tahan terhadap penyusup yang mengubah
-- tabel ini dan access_log sekaligus. Yang membuatnya bermakna adalah tx_hash
-- on-chain nanti; sebelum itu, bukti T1 hanya sekuat kepercayaan pada operator.
--
-- Diletakkan sebagai blok @@FUNGSI idempoten (CREATE ... IF NOT EXISTS + DROP
-- POLICY) supaya `terapkan` bisa membuat tabel BARU ini di database yang
-- sudah ada (mis. Supabase) tanpa menjalankan ulang DDL tabel lain. Tabel lain
-- dibuat sekali saat pemasangan pertama; tabel yang menyusul sesudah itu tidak
-- punya jalur sampai ke database lama kecuali lewat blok seperti ini.
-- @@FUNGSI_START
CREATE TABLE IF NOT EXISTS audit_anchor (
  id           BIGSERIAL PRIMARY KEY,
  from_seq     BIGINT  NOT NULL,
  to_seq       BIGINT  NOT NULL,
  leaf_count   INTEGER NOT NULL,
  root         TEXT    NOT NULL,
  head_hash    TEXT    NOT NULL,
  algorithm    TEXT    NOT NULL,
  tx_hash      TEXT,
  anchored_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_seq >= 1 AND to_seq >= from_seq),
  CHECK (leaf_count = to_seq - from_seq + 1)
);
CREATE INDEX IF NOT EXISTS idx_audit_anchor_to_seq ON audit_anchor (to_seq DESC);
ALTER TABLE audit_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_anchor_operator_all ON audit_anchor;
CREATE POLICY audit_anchor_operator_all ON audit_anchor
  FOR ALL
  USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));
-- @@FUNGSI_END

-- ============================================================================
-- FIELD_CATALOG dan RLS
--
-- field_catalog adalah turunan murni dari FIELD_ORDER/LABELS di kode: nama,
-- label, tipedata -- tidak pernah memuat data sasaran. Kendalanya: kalau RLS
-- ON tanpa policy (keadaan yang ditemukan di Supabase), SEMUA peran non-owner
-- melihat nol baris. Dampaknya bukan hanya UI: trigger `validasi_hidden_fields`
-- berjalan sebagai peran pemanggil (app_api), jadi katalog yang "kosong"
-- membuat SETIAP hidden_fields/column_order ditolak -- invariant database
-- yang hidup-buta di belakang nol baris.
--
-- Untuk menutupnya, katalog diberi policy SELECT publik yang eksplisit: siapa
-- pun boleh MEMBACA katalog, tidak ada yang boleh menulis lewat peran
-- aplikasi (tidak ada policy INSERT/UPDATE/DELETE), dan pemilik tetap bisa
-- mengisi katalog saat pemasangan karena RLS dipakai tanpa FORCE.
--
-- Dimuat sebagai blok @@FUNGSI idempoten supaya sampai ke database yang sudah
-- ada. ENABLE dijalankan berulang dengan aman (sudah ON tidak apa-apa).
-- @@FUNGSI_START
ALTER TABLE field_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_catalog_public_read ON field_catalog;
CREATE POLICY field_catalog_public_read ON field_catalog
  FOR SELECT
  USING (true);
-- @@FUNGSI_END

-- yang ditolak) dan role operator/admin boleh SELECT. Tidak boleh UPDATE/DELETE.
CREATE POLICY access_log_append ON access_log
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY access_log_read ON access_log
  FOR SELECT
  USING (jwt_role() IN ('operator', 'admin'));

-- ============================================================================
-- KOLOM YANG DIBLOKIR (FR-4.20)
--
-- Penegakan kolom tidak dilakukan lewat RLS: RLS hanya memfilter BARIS.
-- Query API menyusun daftar SELECT hanya dari kolom yang diizinkan, dan
-- mengembalikan FIELD_NOT_GRANTED bila klien meminta kolom terlarang
-- (FR-4.20a..4.20c). Kolom terlarang TIDAK diubah di penyimpanan: penegakannya
-- ada di lapisan kueri (proyeksi SELECT eksplisit), dengan penjaga kedua
-- `filterRows` sebelum respons dikirim -- bukan dengan men-NULL-kan kolom.
--
-- Kolom bawaan yang diblokir keras (PRD 6.4.1a): catatan_tpk, nik_ayah, nik_ibu, nama_ayah, nama_ibu.
--
-- Kelima nama itu ditulis di dalam fungsi, BUKAN disemai ke
-- agency_denied_columns. Alasannya: tabel itu hanya berisi tambahan pilihan
-- Admin per instansi, dan instantiate baru bisa datang dengan tabel kosong.
-- Kalau blokir bawaan ikut bergantung pada isi tabel, instansi yang belum
-- pernah menambah kolom terlarang akan otomatis dapat kelima kolom itu --
-- tepat hal yang paling tidak boleh terjadi, dan tanpa galat apa pun.
--
-- Menghapus agency_denied_columns untuk satu agency TIDAK dapat melepas
-- blokir bawaan: UNION di bawah selalu mengembalikannya.
-- ============================================================================
-- @@FUNGSI_START
CREATE OR REPLACE FUNCTION denied_columns(p_agency_id BIGINT) RETURNS TEXT[] AS $fn$
  SELECT ARRAY(
    SELECT column_key FROM (
      SELECT unnest(ARRAY['catatan_tpk', 'nik_ayah', 'nik_ibu', 'nama_ayah', 'nama_ibu']::TEXT[]) AS column_key
      UNION
      SELECT column_key FROM agency_denied_columns WHERE agency_id = p_agency_id
    ) AS gabung
  )
$fn$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION denied_columns(BIGINT) TO PUBLIC;
-- @@FUNGSI_END

GRANT EXECUTE ON FUNCTION denied_columns(BIGINT) TO PUBLIC;

-- ============================================================================
-- PENCARIAN KUNCI API (F3.10a)
--
-- Verifikasi kunci terjadi SEBELUM identitas pemanggil diketahui -- itulah
-- gunanya verifikasi. Kalau pencarian dibatasi policy agency_api_keys_operator
-- (operator/admin saja), sistem terjebak: permintaan pertama dari klien tidak
-- mungkin membuktikan dirinya operator, jadi RLS memastikan 401.
--
-- SECURITY DEFINER adalah jalan yang tepat, bukan pelonggaran policy:
-- fungsi ini berjalan sebagai pemilik (yang melewati RLS), tapi satu-satunya
-- hal yang bisa dicari oleh pemanggil adalah baris yang key_hash-nya PERSIS
-- sama dengan input. Hash adalah SHA-256 token, jadi pemanggil hanya bisa
-- menemukan baris yang token aslinya sudah ia pegang -- tidak ada baris apa
-- pun yang dibocorkan tanpa kredensial. Ini persis pola agency_can_see():
-- policy memanggil SECURITY DEFINER untuk membaca tabel agency_* yang juga
-- punya RLS sendiri.
--
-- Kolom yang dikembalikan cukup untuk verifikasi status dan scope di
-- lib/api-key-auth.js. key_hash dan revoked stuff tidak pernah dikembalikan.
-- ============================================================================
-- @@FUNGSI_START
CREATE OR REPLACE FUNCTION cari_kunci(p_key_hash TEXT)
RETURNS TABLE (
  id          BIGINT,
  agency_id   BIGINT,
  status      TEXT,
  category    TEXT,
  table_name  TEXT,
  key_prefix  TEXT
) AS $fn$
  SELECT k.id, k.agency_id, k.status::TEXT, k.category, k.table_name, k.key_prefix
  FROM agency_api_keys k
  WHERE k.key_hash = p_key_hash
  LIMIT 1
$fn$ LANGUAGE sql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION cari_kunci(TEXT) IS
  'Cari satu baris kunci API dari key_hash. SECURITY DEFINER: berjalan sebagai pemilik supaya verifikasi bisa terjadi sebelum identitas pemanggil diketahui. Tidak mengembalikan key_hash; pemanggil hanya bisa menemukan baris yang token aslinya ia pegang.';

GRANT EXECUTE ON FUNCTION cari_kunci(TEXT) TO PUBLIC;
-- @@FUNGSI_END

COMMIT;
