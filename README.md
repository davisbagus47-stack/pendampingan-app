# Pendampingan App

Aplikasi formulir pendampingan keluarga untuk program penurunan stunting berdasarkan **SE BKKBN No. 12 Tahun 2024**. Digunakan oleh Tim Pendamping Keluarga (TPK) — Bidan, Kader PKK, dan Kader KB — untuk mencatat data kunjungan ke sasaran keluarga berisiko stunting.

## Tech Stack

| Komponen | Teknologi |
|----------|-----------|
| Frontend | React 19 (Create React App) |
| Backend | Node.js + Express 5 |
| Database | Google Sheets API v4 |
| Auth | Google Service Account |
| Deployment | Vercel (2 project terpisah) |

## Fitur Utama

- Formulir multi-section (A–I) lengkap untuk pencatatan data keluarga sasaran
- Pencarian sasaran otomatis berdasarkan NIK atau nama
- Auto-fill form dari data sebelumnya
- Validasi input sisi klien & server (NIK 16 digit, field wajib)
- Pemeriksaan kondisional berdasarkan jenis sasaran (Ibu Hamil, Catin, Ibu Nifas, Baduta)
- Auto-flag risiko stunting untuk Baduta (ASI tidak eksklusif, imunisasi terlambat, perkembangan terlambat)
- Data tersimpan otomatis ke Google Sheets

## Struktur Proyek

```
pendampingan-app/
├── backend/
│   ├── index.js              # Express server (API logic)
│   ├── package.json
│   ├── .env.example          # Template environment variable
│   └── print_creds.js        # Helper untuk export credentials
├── frontend/
│   ├── src/
│   │   ├── App.js
│   │   ├── pages/
│   │   │   ├── FormPendampingan.jsx   # Halaman formulir utama
│   │   │   └── FormPendampingan.css
│   │   └── index.js
│   ├── public/
│   └── package.json
└── README.md
```

## Instalasi & Menjalankan

### Prerequisites

- Node.js >= 18
- Akun Google Service Account dengan akses Google Sheets API
- Google Spreadsheet sebagai database

### Backend

```bash
cd backend
npm install
cp .env.example .env   # isi variabel yang diperlukan
npm start              # berjalan di http://localhost:3001
```

### Frontend

```bash
cd frontend
npm install
npm start              # berjalan di http://localhost:3000
```

## Environment Variables

### Backend

| Variable | Required | Deskripsi |
|----------|----------|-----------|
| `SHEET_ID` | Ya | ID Google Spreadsheet tempat data submit tersimpan |
| `SHEET_NAME` | Tidak | Nama tab sheet submit (default: `Sheet1`) |
| `REF_SHEET_ID` | Tidak | ID spreadsheet master (read-only) untuk pencarian sasaran & data TPK. Jika diisi, `GET /api/sasaran` membaca dari sini (bukan dari sheet submit) |
| `REF_SHEET_NAME` | Tidak | Nama tab spreadsheet master (default: `Form Responses 1`) |
| `GOOGLE_CREDENTIALS_JSON` | Tidak* | JSON service account dalam satu baris. Jika kosong, fallback ke `service_account.json` |
| `CORS_ORIGIN` | Tidak | Origin yang diizinkan CORS (default: `*`) |
| `PORT` | Tidak | Port server (default: `3001`) |

### Frontend

| Variable | Required | Deskripsi |
|----------|----------|-----------|
| `REACT_APP_API_URL` | Tidak | URL backend API. Default: `window.location.origin` |

> \* Untuk deployment di Vercel, gunakan `print_creds.js` untuk mengkonversi `service_account.json` ke format satu baris.

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/` | Health check |
| `GET` | `/api/sasaran` | Daftar sasaran unik (berdasarkan NIK) |
| `POST` | `/api/submit` | Submit formulir pendampingan |

## Deployment

Aplikasi ini di-deploy sebagai **2 project Vercel terpisah**:

1. **Backend** — Express server sebagai Vercel serverless function
2. **Frontend** — Static build React

### Backend (folder `backend/`)

Sudah ada `backend/api/index.js` (delegasi `index.js` sebagai serverless function) dan `backend/vercel.json` (rewrite semua rute ke fungsi tersebut). Project Vercel untuk backend cukup:

- **Framework Preset:** Other
- **Build:** tidak ada (default)
- **Output:** tidak ada (default)

Setelah connect repo ke Vercel, atur environment variable di dashboard:

| Variable | Deskripsi |
|----------|-----------|
| `GOOGLE_CREDENTIALS_JSON` | Wajib. JSON service account satu baris (jalankan `node print_creds.js` lokal). File `service_account.json` tidak ikut ter-deploy karena di-ignore git |
| `SHEET_ID` | ID spreadsheet tempat data submit |
| `REF_SHEET_ID` | ID spreadsheet master (read-only) untuk pencarian sasaran |
| `REF_SHEET_NAME` | Nama tab sheet master (default: `Form Responses 1`) |
| `CORS_ORIGIN` | Opsional, origin yang diizinkan CORS |

### Frontend (folder `frontend/`)

Project Vercel untuk frontend cukup:

- **Framework Preset:** Create React App (auto-detect)
- **Build Command:** `npm run build`
- **Output Directory:** `build`

Environment variable wajib di-build time:

| Variable | Deskripsi |
|----------|-----------|
| `REACT_APP_API_URL` | URL backend Vercel (mis. `https://backend-xxx.vercel.app`) |

### Alur auto-deploy

Setelah 2 project terhubung ke repo dan env diatur, setiap `git push` ke `main` otomatis mem-build & deploy tanpa perlu menyentuh dashboard Vercel. Nilai rahasia (`GOOGLE_CREDENTIALS_JSON`, `SHEET_ID`, `REF_SHEET_ID`, `REF_SHEET_NAME`) tidak pernah disimpan di GitHub — hanya di dashboard Vercel.

### Kolom yang dibaca dari sheet master (read-only)

Pertama kali dibuat untuk spreadsheet dengan header persis seperti di bawah (keluaran Google Form). Kolom lain diabaikan:

| Field form | Judul kolom di sheet master |
|-----------|------------------------------|
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

Nilai `Unsur TPK` diambil persis dari master (`Tenaga Kesehatan`, `PKK`, `Kader KB`) dan menjadi opsi dropdown "Peran/Jabatan dalam TPK" di form.

Field baru `timTPK`, `pendampinganKe`, `jenisKelamin`, `mbg3B` ditaruh di ujung `FIELD_ORDER`, sehingga kolom lama di sheet submit tidak bergeser. Jika header sheet master berubah, sesuaikan pemetaan `REF_FIELDS` di `backend/index.js`.

## Lisensi

Dikembangkan untuk kebutuhan internal program penurunan stunting BKKBN.
