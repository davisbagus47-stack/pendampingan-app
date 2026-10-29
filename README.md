# Pendampingan App

Aplikasi formulir pendampingan keluarga untuk program penurunan stunting berdasarkan **SE BKKBN No. 12 Tahun 2024**.

> Dokumentasi ini mengikuti implementasi aktif di backend, frontend, skema PostgreSQL, dan konfigurasi Vercel. Jenis sasaran yang didukung: `Catin`, `Ibu Hamil`, `Ibu Nifas`, `Baduta`, dan `Balita`.

Aplikasi formulir pendampingan keluarga untuk program penurunan stunting berdasarkan **SE BKKBN No. 12 Tahun 2024**. Digunakan oleh Tim Pendamping Keluarga (TPK) — Bidan, Kader PKK, dan Kader KB — untuk mencatat data kunjungan ke sasaran keluarga berisiko stunting.

## Arsitektur Sistem

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Frontend   │────▶│     Backend      │────▶│  PostgreSQL     │
│  (React)    │     │  (Express/VC)    │     │  (Supabase)     │
└─────────────┘     └────────┬─────────┘     └────────┬────────┘
                             │                      │
                    ┌────────▼────────┐     ┌────────▼────────┐
                    │  Google Sheets  │     │  Sepolia Chain  │
                    │   (Audit Trail) │     │  (Anchoring)    │
                    └─────────────────┘     └─────────────────┘
                             ▲                      ▲
                    ┌────────┴────────┐     ┌────────┴────────┐
                    │  Vercel Cron    │     │  Smart Contract │
                    │  (Penyapu)      │     │  (Foundry)      │
                    └─────────────────┘     └─────────────────┘
```

**Alur data:**
1. TPK isi form di frontend → `POST /api/submit`
2. Backend memvalidasi lalu menyimpan record kanonik ke **PostgreSQL** dan antrean `sheets_pending`; flush ke **Google Sheets** dilakukan oleh cron
3. Backend **broadcast tx ke Sepolia** (mode hybrid: balas cepat `submitted` + `tx_hash`)
4. **Vercel Cron** memanggil `GET /api/cron/anchor` → worker menyapu `chain_outbox` → cek receipt → update `anchored`; cron kedua memanggil `/api/cron/sheets-flush`
5. Record terverifikasi on-chain via `isAnchored(record_id)`

Setiap submit form ditandatangani wallet kader. Backend mencocokkan alamat penanda tangan ke `tpk_members`, lalu menyimpan `writer_nik`, `writer_name`, dan `writer_wallet_address` pada record Supabase. NIK kader tidak ditambahkan sebagai field/event blockchain; transaksi anchor tetap ditandatangani relayer backend dan hanya mengirim commitment hash.

## Tech Stack

| Komponen | Teknologi |
|---|---|
| Frontend | React 19 (Create React App) |
| Backend | Node.js 20 + Express 5 (Vercel Serverless) |
| Database | **PostgreSQL (Supabase)** + **Google Sheets API v4** (dual-write) |
| Blockchain | **Sepolia (Ethereum testnet)** via **Foundry** smart contract |
| Anchoring | `lib/anchor-chain.js` + `lib/anchor-record.js` + `lib/anchor-worker.js` |
| Cron | Vercel Cron: `0 17 * * *` → `/api/cron/anchor`; `0 18 * * *` → `/api/cron/sheets-flush` |
| ZKP | `lib/zkp-audit.js` + `zkp/` (circom/snarkjs) |
| Deployment | Vercel (2 project: backend + frontend) |
| Auth/Rate Limit | API Key per agency + `agency_categories` grant + rate limit |

## Fitur Utama

- Formulir multi-section (A–I) lengkap untuk pencatatan data keluarga sasaran
- Pencarian sasaran otomatis berdasarkan NIK atau nama (dari spreadsheet master read-only)
- Auto-fill form dari data sebelumnya (reconciliation)
- Validasi input sisi klien & server (NIK 16 digit, field wajib)
- **Pemeriksaan kondisional berdasarkan 5 jenis sasaran** (Ibu Hamil, Catin, Ibu Nifas, Baduta 0-23 bln, **Balita 24-59 bln**)
- Auto-flag risiko stunting untuk Baduta (ASI tidak eksklusif, imunisasi terlambat, perkembangan terlambat)
- **Dual-write**: data tersimpan ke Google Sheets (audit) + PostgreSQL (record canonical)
- **Anchor hybrid**: respons form cepat (`status: submitted` + `tx_hash`), finalisasi `anchored` oleh worker/cron
- **Anchor verification**: `GET /api/v1/audit/proof` mengembalikan Merkle proof + receipt on-chain
- **ZKP proof** (opsional): `GET /api/v1/audit/zkp-proof`
- **API key agency**: verifikasi `X-Agency-Key`, status key (`primary`/`standby`/`revoked`), grant kategori, dan cakupan desa/kecamatan
- **Query API terkontrol**: filter kategori/wilayah/tanggal, cursor pagination, pemilihan `fields`, dan output `json`/`csv`/`xlsx`
- **Koreksi berversi**: record lama tidak ditimpa; versi baru ditautkan melalui `supersedes_id`
- **Audit log**: seluruh request, penolakan auth, rate limit, format output, dan jumlah baris dicatat ke `access_log`
- **Konfigurasi agency**: kolom tersembunyi, urutan kolom, filter bawaan, dan format bawaan
- **Login TPK dan wallet**: verifikasi TPK, pembuatan wallet, serta pendanaan otomatis opsional dari treasury Sepolia
- Rate limit per agency + category grant via `agency_categories`

## Struktur Proyek

```
pendampingan-app/
├── backend/
│   ├── api/index.js              # Vercel serverless entry (delegasi ke index.js)
│   ├── index.js                  # Express app utama (route, middleware, anchor)
│   ├── lib/
│   │   ├── anchor-chain.js       # Kirim tx ke Sepolia, cek receipt, hash kategori
│   │   ├── anchor-record.js      # Antrean serial nonce per institusi
│   │   ├── anchor-worker.js      # Logika penyapu outbox (cek receipt, update status)
│   │   ├── backfill.js           # Import massal dari spreadsheet lama
│   │   ├── canonical.js          # Kanonikalisasi payload → record_hash (SHA-256 JCS)
│   │   ├── column-grants.py      # Field-level access control (FR-4.9–4.12)
│   │   ├── db.js                 # Pool pg + transaksi + peran (operator/agency/admin)
│   │   ├── field-types.js        # Tipe kolom & skala desimal
│   │   ├── records-query.js      # Query records dengan grant, filter, cursor, dan format
│   │   ├── records-write.js      # Bangun record + payload_json + hash + versioning
│   │   ├── access-log.js         # Audit log setiap request dan hasil respons
│   │   ├── api-key-auth.js       # Verifikasi X-Agency-Key dan scope kategori
│   │   ├── rate-limit.js         # Rate limit per agency dan jalur publik
│   │   ├── tpk-identity.js       # Verifikasi signature wallet kader
│   │   ├── config.js             # Konfigurasi agency (kolom, filter, format)
│   │   ├── tpk-funding.js        # Pembuatan dan pendanaan wallet TPK
│   │   ├── worker-sheets.js      # Flush antrean sheets_pending ke Google Sheets
│   │   ├── zkp-audit.js          # ZKP proof generation (circom/snarkjs)
│   │   └── ... (sections, sheets-mirror, xlsx-export)
│   ├── sql/
│   │   ├── 001_schema.sql        # DDL lengkap + @@FUNGSI migrasi idempoten
│   │   └── 002_tpk_writer_identity.sql # Kolom audit identitas kader per record
│   ├── tools/
│   │   ├── db-setup.js           # Terapkan skema & seed (terapkan/cek/seed)
│   │   ├── seed-operator.js      # Seed instansi operator + grant kategori
│   │   ├── generate-schema.js    # Generate DDL dari ENUMS + FIELD_ORDER
│   │   ├── lock-vectors.js       # Bekukan vektor hash (tests/vectors.json)
│   │   ├── test-*.js             # Suite uji (unit + live + integrasi)
│   │   ├── worker-anchor.js      # CLI penyapu outbox (manual/scheduler)
│   │   └── ... (backfill, lint-text, vercel-config)
│   ├── contracts/                # Foundry smart contract (DataAnchor.sol)
│   ├── zkp/                      # Circom circuits + verifier
│   ├── index.js                  # Express app
│   ├── vercel.json               # Rewrites, maxDuration, dan dua jadwal cron
│   ├── .env.example              # Template env
│   └── package.json
├── frontend/
│   ├── src/pages/FormPendampingan.jsx   # Halaman formulir + login/wallet TPK
│   ├── src/pages/FormPendampingan.css
│   └── package.json
├── docs/
│   └── prosedur-kunci.md       # Prosedur kunci manual (manual review F2.6)
└── README.md
```

## Instalasi & Menjalankan (Lokal)

### Prerequisites

- Node.js >= 20
- PostgreSQL (Supabase lokal/remote) — `DATABASE_URL`
- Google Service Account + Google Sheets API — `GOOGLE_CREDENTIALS_JSON`
- Sepolia RPC + Private Key — `ANCHOR_RPC_URL`, `ANCHOR_PRIVATE_KEY`, `ANCHOR_CONTRACT`
- (Opsional) Foundry untuk kontrak — `forge build`
- (Opsional) Circom/snarkjs untuk ZKP — `zkp/`

### Backend

```bash
cd backend
npm install
cp .env.example .env   # isi semua variabel (lihat bagian Environment)
npm start              # http://localhost:3001
```

### Frontend

```bash
cd frontend
npm install
# Pastikan REACT_APP_API_URL di .env.local menunjuk ke backend lokal
npm start              # http://localhost:3000
```

### Database & Migrasi

```bash
cd backend
# Terapkan skema penuh (CREATE TABLE, fungsi, policy, seed operator)
node tools/db-setup.js terapkan

# Cek status skema (dry-run)
node tools/db-setup.js cek

# Regenerasi skema dari ENUMS/FIELD_ORDER
node tools/generate-schema.js
```

Untuk database yang sudah berisi skema, jalankan [002_tpk_writer_identity.sql](backend/sql/002_tpk_writer_identity.sql) setelah skema utama. Migrasi ini menambahkan kolom atribusi wallet kader ke `records`. Untuk alur pemulihan wallet, jalankan juga [003_tpk_wallet_reset.sql](backend/sql/003_tpk_wallet_reset.sql).

Panel lokal **Funding Admin TPK** menyediakan tombol **Buat secret reset** untuk membuat secret operator acak, menyimpannya secara lokal, menyinkronkannya sebagai secret Vercel Production, lalu men-deploy ulang backend. Secret hanya ditampilkan sekali; simpan di pengelola kata sandi dan jangan bagikan kepada kader. Lihat [panduan reset wallet](backend/TPK_WALLET_RESET.md).

### Uji & Verifikasi

```bash
# Suite utama (unit + hash + canonical)
node tools/test-roundtrip.js
node tools/test-canonical.js
node tools/test-canonical.js --vectors   # cek vektor beku

# Uji live (butuh DB + Anvil/chain)
node tools/test-per-input-audit-live.js
node tools/test-anchor-worker.js
node tools/lock-vectors.js --check       # CI check vektor beku

# Lint teks
node tools/lint-text.js
```

### Smart Contract (Foundry)

```bash
cd backend
forge build
forge test
# Deploy ke Sepolia (butuh RPC + private key)
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC --broadcast
```

## Environment Variables (Backend)

| Variable | Required | Deskripsi |
|---|---|---|
| `DATABASE_URL` | Ya | PostgreSQL connection string (Supabase) |
| `GOOGLE_CREDENTIALS_JSON` | Ya | JSON service account (satu baris) |
| `SHEET_ID` | Ya | ID spreadsheet untuk audit trail (submit) |
| `SHEET_NAME` | Tidak | Tab sheet submit (default: `Sheet1`) |
| `REF_SHEET_ID` | Tidak | Spreadsheet master read-only (pencarian sasaran) |
| `REF_SHEET_NAME` | Tidak | Tab master (default: `Form Responses 1`) |
| `ANCHOR_RPC_URL` | Ya | Sepolia RPC endpoint (publicnode/Alchemy) |
| `ANCHOR_PRIVATE_KEY` | Ya | Private key wallet anchor (tanpa `0x`) |
| `ANCHOR_CONTRACT` | Ya | Alamat kontrak `DataAnchor` di Sepolia |
| `TPK_AUTO_FUND_ENABLED` | Tidak | Set `true` untuk mengirim ETH otomatis ke wallet TPK baru |
| `TPK_FUNDING_PRIVATE_KEY` | Tidak | Private key treasury Sepolia khusus pendanaan TPK; jangan gunakan di frontend |
| `TPK_FUNDING_RPC_URL` | Tidak | RPC pendanaan TPK (default `ANCHOR_RPC_URL` atau PublicNode Sepolia) |
| `TPK_FUNDING_AMOUNT_ETH` | Tidak | Jumlah per wallet baru (default `0.1`) |
| `TPK_WALLET_RESET_ADMIN_KEY` | Tidak | Secret operator untuk menerbitkan kode reset wallet kader; jangan pasang di frontend |
| `ANCHOR_FROM_BLOCK` | Tidak | Block mulai sinkronisasi event (default: deploy block) |
| `ANCHOR_CRON_BATCH` | Tidak | Batch size per cron run (default: `5`) |
| `CRON_SECRET` | Ya | Bearer token untuk `GET /api/cron/anchor` |
| `SHEETS_FLUSH_BATCH` | Tidak | Jumlah item antrean yang dikirim ke Google Sheets per cron (default: `50`) |
| `FORM_INSTITUTION_KEY` | Tidak | Kunci instansi form publik (default: `operator-data-center`) |
| `PORT` | Tidak | Port lokal (default: `3001`) |
| `CORS_ORIGIN` | Tidak | Origin CORS (default: `*`) |

> **Catatan**: Untuk Vercel, gunakan `node tools/print_creds.js` untuk mengkonversi `service_account.json` → satu baris `GOOGLE_CREDENTIALS_JSON`. File `service_account.json` **tidak di-commit** (di-ignore git).

### Frontend

| Variable | Required | Deskripsi |
|---|---|---|
| `REACT_APP_API_URL` | Ya (build time) | URL backend Vercel (mis. `https://backend-xxx.vercel.app`) |

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/` | Health check |
| `GET` | `/api/sasaran` | Daftar sasaran unik (NIK + nama) dari master sheet |
| `POST` | `/api/submit` | **Form publik** → Sheets + PostgreSQL + anchor hybrid (balas cepat `submitted` + `tx_hash`) |
| `POST` | `/api/auth/tpk/verify` | Verifikasi NIK TPK dan membuat sesi form |
| `POST` | `/api/auth/tpk/wallet` | Membuat/mengambil wallet TPK dan pendanaan Sepolia opsional |
| `GET` | `/api/v1/records` | Query record ber-auth dengan filter, grant kategori/wilayah, cursor, `fields`, dan format `json`/`csv`/`xlsx` |
| `POST` | `/api/v1/records` | Tambah record atau koreksi versi sebelumnya; memerlukan agency key dan grant |
| `GET` | `/api/v1/config` | Membaca konfigurasi tampilan agency |
| `PUT` | `/api/v1/config` | Memperbarui konfigurasi tampilan agency yang diizinkan |
| `GET` | `/api/audit/status` | Status audit/anchoring aplikasi |
| `GET` | `/api/v1/audit/proof` | Merkle proof + receipt on-chain untuk `record_id` |
| `GET` | `/api/v1/audit/zkp-proof` | ZKP proof untuk record |
| `GET` | `/api/cron/anchor` | Penyapu `chain_outbox`; wajib `Authorization: Bearer <CRON_SECRET>` |
| `GET` | `/api/cron/sheets-flush` | Mengirim `sheets_pending` ke Google Sheets; wajib `CRON_SECRET` |

**Auth API ber-auth (`/api/v1/*`)**: kirim header `X-Agency-Key: <token>` untuk key yang aktif. Scope akses ditentukan oleh `agency_categories`, `agency_desa_scope`, dan `agency_denied_columns`.
**Rate limit**: default 30 req/menit per agency; dapat dikonfigurasi melalui `agency_rate_limit`. Jalur form publik memakai kuota bersama yang lebih longgar.

### Query dan koreksi record

`GET /api/v1/records` mendukung `kategori_1`, `kategori_2`, `desa`, `tanggal_mulai`, `tanggal_selesai`, `limit`, `cursor`, `fields`, dan `format`. `format` dapat berupa `json`, `csv`, atau `xlsx`; kolom yang tidak mendapat grant akan ditolak dan tidak dikirim.

`POST /api/v1/records` membuat `version = 1` jika `record_id` dan `version` tidak dikirim. Untuk koreksi, kirim keduanya; backend membuat versi baru dan mengisi `supersedes_id`, sehingga riwayat record tetap utuh.

### Cron dan antrean

- `/api/cron/anchor` memproses `chain_outbox`, memeriksa receipt Sepolia, dan melakukan retry transaksi yang masih tertunda.
- `/api/cron/sheets-flush` memproses `sheets_pending` secara asinkron ke Google Sheets. Keduanya menolak request jika `CRON_SECRET` belum diatur atau bearer token tidak cocok.

## Deployment (Vercel)

### 1. Backend (folder `backend/`)
- Framework Preset: **Other**
- Build Command: *(kosong)*
- Output Directory: *(kosong)*
- `vercel.json` sudah menyediakan: rewrite semua rute ke `api/index.js`, `maxDuration: 60`, dan dua cron: `0 17 * * *` untuk anchor serta `0 18 * * *` untuk flush Google Sheets

Env di dashboard Vercel (Settings → Environment Variables):
- `DATABASE_URL`, `GOOGLE_CREDENTIALS_JSON`, `SHEET_ID`, `REF_SHEET_ID`, `REF_SHEET_NAME`
- `ANCHOR_RPC_URL`, `ANCHOR_PRIVATE_KEY`, `ANCHOR_CONTRACT`, `ANCHOR_FROM_BLOCK`, `ANCHOR_CRON_BATCH`, `SHEETS_FLUSH_BATCH`
- `TPK_AUTO_FUND_ENABLED`, `TPK_FUNDING_PRIVATE_KEY`, `TPK_FUNDING_RPC_URL`, `TPK_FUNDING_AMOUNT_ETH`
- `CRON_SECRET`, `FORM_INSTITUTION_KEY`, `CORS_ORIGIN`

### 2. Frontend (folder `frontend/`)
- Framework Preset: **Create React App** (auto-detect)
- Build Command: `npm run build`
- Output Directory: `build`

Env di dashboard Vercel:
- `REACT_APP_API_URL` = URL backend Vercel (mis. `https://pendampingan-app-mvbo.vercel.app`)

### Setup funding wallet TPK

Untuk mengisi saldo wallet TPK baru secara otomatis, jalankan tool lokal dari PowerShell:

```powershell
cd backend
.\tools\setup-tpk-funding.ps1
```

Tool meminta private key treasury secara tersembunyi, memperbarui `.env` lokal, dan tidak menampilkan private key. Untuk mengirim variable yang sama ke Vercel sekaligus melakukan redeploy Production tanpa push GitHub, pasang serta login Vercel CLI, link project backend, lalu jalankan:

```powershell
npm install --global vercel
vercel login
vercel link --project pendampingan-app-mvbo
.\tools\setup-tpk-funding.ps1 -SyncVercel
```

Gunakan wallet treasury Sepolia khusus. Jangan gunakan private key wallet TPK pengguna dan jangan commit file `backend/.env`. Tool otomatis mengecualikan `.env`, data lokal, dan file sementara dari deployment.

Untuk melihat daftar nama TPK dari Supabase dan membuka tombol konfigurasi melalui panel lokal:

```powershell
cd backend
npm run funding:admin
```

Buka URL localhost yang dicetak di terminal. URL tersebut memiliki token akses sementara dan hanya dapat diakses dari komputer lokal.

### Auto-deploy
Setelah 2 project terhubung ke repo GitHub & env diatur, setiap `git push main` otomatis build & deploy. Rahasia **tidak pernah** di-commit ke GitHub — hanya di dashboard Vercel.

### Migrasi DB di Produksi (Supabase)
Setelah push kode yang mengubah skema (mis. tambah kategori Balita):
```bash
# Lokal (butuh DATABASE_URL produksi di .env)
node tools/db-setup.js terapkan
```
Perintah ini menjalankan blok `@@FUNGSI` di `sql/001_schema.sql` (idempoten: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, policy, fungsi). **Wajib dijalankan sebelum kode baru di-deploy** agar CHECK constraint ter-update.

## Master Spreadsheet (Read-only)

Kolom yang dibaca untuk pencarian sasaran & data TPK (header persis keluaran Google Form):

| Field form | Judul kolom di sheet master |
|---|---|
| NIK | `NIK Sasaran` |
| No. KK | `NIK KK` |
| Nama Lengkap | `Nama Sasaran` |
| Tanggal Lahir | `Tanggal Lahir` |
| Usia (tahun) | `Umur` (+ `Satuan Umur`) |
| No. HP | `No HP` |
| Alamat | `Alamat` |
| Jenis Sasaran | `Sasaran` |
| BB Sekarang | `BB` |
| TB | `TB` |
| Desa | `Desa` |
| Kecamatan | `Kecamatan` |
| Nama Petugas TPK | `Nama TPK` |
| Peran TPK | `Unsur TPK` |
| Tim TPK | `Tim TPK` |
| Pendampingan Ke | `Pendampingan Ke` |
| Jenis Kelamin | `JK` |
| Sudah Menerima MBG 3B | `Sudah Menerima MBG 3B` |

Nilai `Unsur TPK` diambil persis dari master (`Tenaga Kesehatan`, `PKK`, `Kader KB`) → opsi dropdown "Peran/Jabatan dalam TPK" di form.
Field `timTPK`, `pendampinganKe`, `jenisKelamin`, `mbg3B` ditaruh di ujung `FIELD_ORDER` agar kolom lama di sheet submit tidak bergeser.
Jika header sheet master berubah, sesuaikan pemetaan `REF_FIELDS` di `backend/index.js`.

## Prosedur Manual (F2.6)

Lihat [`docs/prosedur-kunci.md`](docs/prosedur-kunci.md) untuk:
- Manual review kunci rahasia (FR-5.3)
- Rotasi kunci anchor
- Prosedur insiden (reorg, nonce gap, dsb)

## Lisensi

Dikembangkan untuk kebutuhan internal program penurunan stunting BKKBN.

## Diagram Alur Input dan Integrasi Antarinstansi

Dokumentasi diagram alur input formulir, penyimpanan Google Sheets dan Supabase, anchoring Sepolia, serta integrasi baca/tulis antarinstansi tersedia di [docs/diagram-alur-input-integrasi.md](docs/diagram-alur-input-integrasi.md).
