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
| `SHEET_ID` | Ya | ID Google Spreadsheet |
| `SHEET_NAME` | Tidak | Nama tab sheet (default: `Sheet1`) |
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

Pastikan `GOOGLE_CREDENTIALS_JSON` dan `SHEET_ID` diatur sebagai environment variable di dashboard Vercel.

## Lisensi

Dikembangkan untuk kebutuhan internal program penurunan stunting BKKBN.
