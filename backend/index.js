const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
try {
  require('dotenv').config();
} catch (e) {}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const crypto = require('crypto');

const columnGrants = require('./lib/column-grants.js');
const rateLimit = require('./lib/rate-limit.js');
const xlsxExport = require('./lib/xlsx-export.js');
const accessLog = require('./lib/access-log.js');
const apiKeyAuth = require('./lib/api-key-auth.js');
const db = require('./lib/db.js');
const recordsQuery = require('./lib/records-query.js');
const recordsWrite = require('./lib/records-write.js');
const anchorRecord = require('./lib/anchor-record.js');
const canonical = require('./lib/canonical.js');
const auditLogChain = require('./lib/audit-log-chain.js');
const zkpAudit = require('./lib/zkp-audit.js');
const config = require('./lib/config.js');
const { columnName } = require('./lib/field-types');
const { deriveSections } = require('./lib/sections.js');

// Titik suntik untuk pencatatan `records`+`chain_outbox` dari jalur form publik
// (per-input audit). Bawaannya fungsi sungguhan `catatRecordForm`; uji yang
// menjalankan /api/submit sukses TANPA ingin menyentuh PostgreSQL mematikannya
// dengan `setCatatFormAudit(null)`. Pola ini sama dengan `setSheets` dan
// `setCariKunci`: perilaku ber-I/O ditukar eksplisit, bukan lewat env yang ada
// atau tidak ada.
let catatFormAudit = null;

// Titik suntik untuk anchor per-record SINKRON pada POST /api/v1/records.
// Bawaannya `anchorkanRecordDb` (menyentuh Sepolia sungguhan). Uji live jalur
// tulis yang tidak bermaksud menyiarkan transaksi menukarnya dengan stub,
// supaya DATABASE_URL+ANCHOR_* yang ada di .env tidak membakar gas saat uji.
let anchorkanRecord = null;

// Titik suntik penyapu outbox untuk endpoint cron serverless (GET
// /api/cron/anchor). Bawaannya `sapuAnchorDb` (memanggil `tools/worker-anchor`).
// Uji menukarnya dengan stub supaya bisa memeriksa kendali CRON_SECRET tanpa
// menyentuh database maupun menyiarkan transaksi.
let sapuAnchor = null;

// Taksonomi ADR-5. Record yang jenisnya di luar ini tidak boleh masuk jalur
// audit form; lebih baik dilewati dengan alasan jelas daripada menabrak CHECK
// database yang pesannya jauh dari route ini.
const TAKSONOMI_SASARAN = new Set(['Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita']);

// FR-4.4: setiap pemanggilan, berhasil maupun gagal, masuk satu log akses.
// Dipasang sebelum semua route, karena yang dipasang adalah responsnya --
// route yang lupa memanggil pencatatan tetap tercatat, dan tidak ada route
// baru yang bisa forgot karena tidak tahu soal ini.
//
// Sink bawaan menulis ke tabel `access_log` kalau `DATABASE_URL` diset
// (F1.8a, F3.9), dan JATUH ke satu baris JSON ke stdout kalau tidak ada --
// supaya aplikasi tetap jalan tanpa backend database, dan entri yang
// tidak terkirim terlihat di log platform. Pergantian sink cukup di sini.
let accessLogger = accessLog.buatLogger({
  sink: db.urlDatabase() ? db.sinkAccessLog : accessLog.sinkConsole,
});
accessLog.pasang(app, () => accessLogger);

// FR-4.5, AT-14: satu limiter untuk seluruh proses. Menyimpan state di dalam
// route akan menghitung kuota per permintaan, bukan per instansi.
const limiter = rateLimit.buatLimiter();

// ---------------------------------------------------------------------------
// F3.10a: identitas instansi.
//
// Urutan di sini mengunci satu aturan: VERIFIKASI SEBELUM KUOTA. Kalau quota
// dihitung lebih dulu, penyerang bisa mengirim kunci dicabut lalu memakai
// jatah kuota orang lain, dan 401-nya menyusul setelah jatahnya habis dipakai.
//
// `cariKunci` sengaja null sampai ada koneksi PostgreSQL (F1.8a). Selama itu
// null, sistem berjalan dalam MODE LEGACY dan membaca `x-agency-id`, dengan
// peringatan yang dicetak sekali. Mode legacy tidak diam-diam: kalau ia bisa
// aktif tanpa terlihat, dia akan ikut aktif di produksi dan tidak ada yang
// ingat Switch.
// ---------------------------------------------------------------------------

/** Sumber kunci API. Null = belum ada database (lihat catatan di atas). */
let cariKunci = null;

// F3.10a: begitu `DATABASE_URL` tersedia, pencarian kunci otomatis memakai
// PostgreSQL (fungsi SECURITY DEFINER `cari_kunci`). Tanpa database, tetap
// null dan sistem berjalan mode legacy. Satu sumber kebenaran untuk
// "apakah database aktif" sama dengan pemilihan sink access log.
if (db.urlDatabase()) {
  cariKunci = db.cariKunci;
}

const PERINGATAN_LEGACY = 'PERINGATAN: autentikasi kunci API nonaktif. ' +
  'Identitas dibaca dari header x-agency-id yang dikontrol klien. ' +
  'Jangan jalankan server ini di jaringan yang bisa diakses publik.';

let sudahPeringatLegacy = false;
function peringatanLegacy() {
  if (sudahPeringatLegacy) return;
  sudahPeringatLegacy = true;
  console.warn('[' + new Date().toISOString() + '] ' + PERINGATAN_LEGACY);
}

/**
 * Identitas instansi pada permintaan ini.
 *
 * Mengembalikan objek, bukan string, karena setelah F3.10a ada dua sumber yang
 * tidak setara: kunci terverifikasi (bisa dipercaya, punya agency_id numerik)
 * dan header legacy (tidak bisa dipercaya). Yang tidak bisa dipercaya harus
 * bisa dibedakan di mana pun dipakai -- kalau keduanya jadi string yang sama,
 * tidak ada yang bisa secara selektif melindungi sumber yang salah.
 */
function agencyIdDari(req) {
  if (cariKunci) {
    if (req.kunci && req.kunci.ok) {
      return { agencyId: req.kunci.agencyId, terverifikasi: true, keyId: req.kunci.keyId };
    }
    return { agencyId: '', terverifikasi: false, keyId: null };
  }
  const v = req.headers['x-agency-id'];
  return {
    agencyId: v === undefined || v === null ? '' : String(v),
    terverifikasi: false,
    keyId: null,
  };
}

/** Bentuk string untuk limiter dan untuk pesan log. */
function kunciKuota(identitas) {
  return identitas.terverifikasi ? 'id-' + identitas.agencyId : identitas.agencyId;
}

// ---------------------------------------------------------------------------
// Jalur yang melewati kunci API instansi (FR-4.4 vs FR-4.1).
//
// Dua alasan berbeda, satu mekanisme:
//   1. Form pendampingan adalah halaman publik: TPK membuka browser, mengisi
//      data kunjungan, lalu menutup. Halaman semacam itu TIDAK BISA menyimpan
//      kunci API dengan aman -- kunci yang disimpan di build front-end sama
//      dengan kunci yang dikirim ke setiap orang yang membuka form. Jadi
//      kewajiban kunci tidak masuk akal untuk dua endpoint yang dipakai form.
//   2. Cron serverless (Vercel Cron) juga tidak membawa kunci instansi; ia
//      mengautentikasi dirinya sendiri lewat CRON_SECRET di handler-nya.
//
// Daftarnya sengaja pendek, eksplisit, dan memuat METODE. Kalau hanya path
// yang didaftarkan, satu route baru yang menumpang path yang sama bisa ikut
// terbuka tanpa disadari. Route yang TIDAK ada di sini tetap wajib kunci
// secara default, termasuk route yang belum ditulis hari ini. Setiap entri
// yang ditambahkan WAJIB mengautentikasi dirinya sendiri di dalam handler.
// ---------------------------------------------------------------------------
const JALUR_PUBLIK = new Set([
  'GET /api/sasaran',
  'POST /api/submit',
  // Cron serverless (Vercel Cron) tidak membawa kunci API instansi; ia
  // mengautentikasi dirinya sendiri lewat CRON_SECRET di handler. Karena itu ia
  // harus melewati gerbang kunci API di sini -- kalau tidak, ia selalu 401.
  'GET /api/cron/anchor',
]);

function jalurPublik(req) {
  // `originalUrl` dipakai, bukan `req.path`: middleware ini dipasang di '/api',
  // jadi `req.url` sudah dipotong mount path dan bisa berbeda antar Express 4/5.
  const jalur = String((req && (req.originalUrl || req.url)) || '').split('?')[0];
  return JALUR_PUBLIK.has(String((req && req.method) || '') + ' ' + jalur);
}

// Identitas rate-limit untuk jalur publik.
//
// Limiter menolak permintaan tanpa identitas instansi (`rate-limit.js`), dan
// halaman TPK tidak mengirim `x-agency-id` maupun kunci. Tanpa kunci sintetis
// di sini, jalur publik selalu kena 429 -- "melindungi" sampai-sampai
// tidak ada yang bisa memakai form. Satu kunci bersama berarti semua
// pengunjung publik berbagi satu jatah, jadi kuotanya dibuat longgar: cukup
// untuk menahan lonjakan Google Sheets API tanpa menghambat operator sungguhan.
const KUNCI_PUBLIK = 'publik';

// Kuota jalur publik. Dibaca sekali saat modul dimuat; sifatnya "cukup longgar
// untuk form, tetap ada untuk menahan lonjakan". Nilai sengaja bukan BAWAAN
// (60/menit): BAWAAN dihitung per instansi, sedangkan di sini semua
// pengunjung publik berbagi satu kunci.
limiter.aturKonfigurasi(KUNCI_PUBLIK, { kuota: 600, jendelaMs: 60000, burst: 60 });

/**
 * Middleware autentikasi.
 *
 * Hanya menolak kalau `cariKunci` terpasang. Tanpa itu, sistem dalam mode
 * legacy dan behaved seperti sebelumnya: header dibaca, tidak diverifikasi.
 *
 * Jalur form publik (lihat JALUR_PUBLIK di atas) dilewati sepenuhnya: tanpa
 * key, tanpa identitas, dan tanpa `actor_id`. Ditekankan di sini karena ini
 * satu-satunya titik di mana "dilindungi" tidak berarti "untuk semua orang":
 * route yang tidak masuk daftar publik tetap ditutup rapat-rapat.
 *
 * Penolakan SELALU dicatat di access_log, termasuk kode alasan (`KEY_REVOKED`,
 * `KEY_STANDBY`, ...) yang tidak terkirim ke klien. Kalau tidak, "kunci dicabut
 * tapi masih dipakai" tidak akan pernah terlihat -- dan itu justru informasi
 * paling berharga saat insiden kebocoran.
 */
async function autentikasi(req, res, next) {
  if (jalurPublik(req)) {
    req.kunci = null;
    return next();
  }

  if (!cariKunci) {
    req.kunci = null;
    return next();
  }

  const token = apiKeyAuth.bacaToken(req);
  const diminta = req.query ? req.query.kategori_1 : undefined;
  const hasil = await apiKeyAuth.verifikasi({ token, cariKunci, diminta });

  if (!hasil.ok) {
    accessLog.tandai(res, {
      result: accessLog.HASIL.DENIED_AUTH,
      kode: hasil.kode,
      // Yang dicatat: kode, agency bila diketahui, dan bentuk token yang salah
      // bentuk. Yang TIDAK: token utuh. Token yang salah ketik masih bisa jadi
      // token asli, dan menyalinnya ke log berarti menyimpan ulang kredensial
      // di tempat yang tidak dienkripsi.
      params: {
        auth_code: hasil.kode,
        key_id: hasil.keyId === undefined ? undefined : hasil.keyId,
        agency_id: hasil.agencyId === undefined ? undefined : hasil.agencyId,
        token_shape: hasil.bentuk === undefined ? undefined : hasil.bentuk,
      },
    });
    // 429 belum dihitung di sini: permintaan ini tidak memakai jatah kuota
    // instansi mana pun, jadi menghitungnya akan mencuri jatah orang lain.
    return apiKeyAuth.kirimUnauthorized(res, hasil);
  }

  req.kunci = hasil;
  accessLog.tandai(res, {
    actorId: hasil.agencyId,
    actorType: 'agency',
    kode: 'OK',
  });
  return next();
}

/** Terapkan kuota dan tulis header hasil ke respons. */
function terapkanRateLimit(req, res) {
  const agencyId = agencyIdDari(req);
  // Kuota dihitung per agency_id yang sudah terverifikasi kalau kuncinya ada.
  // Dalam mode legacy `kunciKuota` mengembalikan isi header apa adanya, jadi
  // perilaku lama tidak berubah -- hanya sekarang dibedakan, bukan disamarkan.
  //
  // `|| KUNCI_PUBLIK` hanya berlaku kalau identitasnya KOSONG sama sekali: tanpa
  // itu jalur publik selalu kena 429 (rate-limit.js menolak identitas kosong).
  // Header legacy tetap menang lebih dulu, jadi per-isolasi per-instansi di
  // mode legacy tidak berubah -- dan route non-publik tanpa identitas tetap
  // ditolak seperti biasa.
  const kunci = kunciKuota(agencyId) || (jalurPublik(req) ? KUNCI_PUBLIK : '');
  const hasil = limiter.periksa(kunci);
  const headers = rateLimit.headerRateLimit(hasil);
  for (const k of Object.keys(headers)) res.set(k, headers[k]);
  return { agencyId: agencyId.agencyId, hasil };
}

/** Respons 429 dengan kode mesin yang sama dengan yang ada di access_log. */
function kirimRateLimit(res, agencyId, hasil) {
  // FR-4.4 + FR-4.5: penolakan kuota adalah akses yang terjadi, jadi harus
  // punya baris log dengan `rate_limited`. Kalau tidak, dari log tidak akan
  // terlihat bahwa instansi ini sedang rakus -- dan `access_log` justru
  // satu-satunya tempat yang bisa menunjukkan itu.
  accessLog.tandai(res, {
    result: accessLog.HASIL.RATE_LIMITED,
    params: { scope: hasil.scope, limit: hasil.limit, remaining: hasil.remaining, retry_after: hasil.retryAfter },
  });
  console.warn(
    `[${new Date().toISOString()}] Rate limit: agency=${agencyId || '(tidak dikenal)'} ` +
    `ditolak (${hasil.scope}), sisa ${hasil.remaining}/${hasil.limit}`
  );
  res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Kuota permintaan habis. Coba lagi nanti.',
    retry_after: hasil.retryAfter,
  });
}

// ---------------------------------------------------------------------------
// FF-4.20a/b: satu pintu untuk setiap respons yang memuat baris data.
//
// Setiap endpoint yang mengembalikan baris wajib lewat `kirimBaris`, bukan
// res.json langsung. Alasannya FR-4.20b berlaku untuk SEMUA format dan SEMUA
// endpoint: kalau setiap endpoint memfilternya sendiri, satu yang lupa berarti
// kebocoran di endpoint itu saja -- dan tidak ada yang menyadarinya.
//
// `kirimBaris` melakukan tiga hal sekaligus, berurutan:
//   1. tolak `fields` yang memuat kolom terlarang (403 FIELD_NOT_GRANTED),
//      dan tolak nama kolom asing (400 FIELD_UNKNOWN) -- keduanya lebih dulu,
//      sebelum query apa pun dijalankan, supaya permintaan terlarang tidak
//      pernah menyentuh data;
//   2. buang kolom terlarang dari setiap baris, menggunakan satu daftar
//      kolom yang sama untuk JSON, CSV, dan XLSX;
//   3. kirim dalam format yang diminta.
// ---------------------------------------------------------------------------

/**
 * Baca parameter `fields` dari query string.
 *
 * `?fields=nik,namaLengkap` dan `?fields=nik&fields=namaLengkap` sama-sama
 * diterima. Mengembalikan null berarti "semua kolom yang terlihat".
 */
function parseFields(req) {
  const q = req.query.fields;
  if (q === undefined || q === null || q === '') return null;
  const list = Array.isArray(q) ? q : [q];
  const hasil = [];
  for (const item of list) {
    for (const bagian of String(item).split(',')) {
      const nama = bagian.trim();
      if (nama !== '') hasil.push(nama);
    }
  }
  return hasil.length === 0 ? null : hasil;
}

/** Format yang diminta, default JSON (FR-4.8). */
function parseFormat(req) {
  const f = String((req.query && req.query.format) || 'json').toLowerCase();
  if (f === 'json' || f === 'csv' || f === 'xlsx') return f;
  const err = new Error('Format tidak didukung: ' + f + '. Gunakan json, csv, atau xlsx.');
  err.code = 'INVALID_FORMAT';
  err.status = 400;
  throw err;
}

/** Sel CSV. Koma, kutip, dan baris baru di dalam nilai harus di-escape. */
function selCsv(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Parameter yang masuk ke `params` pada log akses.
 *
 * Hanya parameter FR-4.1 yang dicatat, ditambah `format` dan `fields`.
 * Daftar ini bukan "salin semua query string": `params` dibaca auditor, dan
 * log yang memuat apa pun yang kebetulan dikirim klien berubah dari bukti
 * menjadi tempat kebocoran. Parameter yang tidak dikenal sengaja tidak ikut --
 * kalau suatu saat perlu dicatat, tambahkan ke sini supaya kelihatan saat
 * ditinjau.
 */
function paramsAkses(req, format, fields) {
  const q = (req && req.query) || {};
  const ambil = (k) => {
    const v = q[k];
    if (v === undefined || v === null || v === '') return undefined;
    return Array.isArray(v) ? v : String(v);
  };
  const params = {
    format,
    fields: fields || undefined,
    kategori_1: ambil('kategori_1'),
    kategori_2: ambil('kategori_2'),
    desa: ambil('desa'),
    tanggal_mulai: ambil('tanggal_mulai'),
    tanggal_selesai: ambil('tanggal_selesai'),
    limit: ambil('limit'),
    cursor: ambil('cursor'),
  };
  const out = {};
  for (const k of Object.keys(params)) if (params[k] !== undefined) out[k] = params[k];
  return out;
}

/**
 * Kirim baris data dalam format yang diminta, dengan kolom terlarang dibuang.
 *
 * Satu fungsi untuk JSON, CSV, dan XLSX. XLSX sudah ditulis sebagai berkas OOXML
 * asli oleh `lib/xlsx-export.js`.
 */
async function kirimBaris(req, res, baris, opsi) {
  const options = opsi || {};
  const denied = options.denied || null;
  const format = parseFormat(req);
  const fields = parseFields(req);

  // Penolakan harus terjadi sebelum data disentuh. Kalau urutan dibalik, satu
  // permintaan terlarang tetap bisa memicu pembacaan baris dari database.
  columnGrants.assertFieldsAllowed(fields, FIELD_ORDER, denied);

  const bersih = columnGrants.filterRows(baris, FIELD_ORDER, denied, fields);

  // FR-4.3: sebagian endpoint (Query API) mengembalikan metadata per baris --
  // `record_id`, `version`, `commitment`, dan kolom verifikasi lainnya. Metadata
  // itu BUKAN kolom payload, jadi `filterRows` di atas tidak mengenalnya. Tiga
  // opsi di bawah menambahkannya secara opsional; tanpa opsi ini, keluaran
  // identik dengan sebelumnya (dipakai `/api/sasaran`).
  //
  //   metaHeader  label kolom metadata untuk CSV/XLSX, di depan kolom payload
  //   metaRow     (barisMentah) => nilai sel untuk kolom metadata itu
  //   metaJson    (barisMentah) => objek metadata untuk respons JSON
  //   json        field tambahan pada objek respons JSON (mis. next_cursor)
  //
  // Metadata selalu ikut walau `fields` membatasi kolom payload: ia bukan
  // payload, jadi permintaan `fields=nik` tetap boleh mendapat `commitment`.
  const metaHeader = Array.isArray(options.metaHeader) ? options.metaHeader : null;
  const metaRow = typeof options.metaRow === 'function' ? options.metaRow : null;
  const metaJson = typeof options.metaJson === 'function' ? options.metaJson : null;

  // FR-4.4 + FR-4.8: jumlah baris dan format yang dipakai wajib masuk log.
  // Format dicatat karena hasil CSV dan XLSX bisa memuat data yang tidak pernah
  // terlihat di JSON. Menandai sebelum mengirim memastikan baris log tetap ada
  // meski proses mati tepat setelah respons dikirim.
  accessLog.tandai(res, {
    result: accessLog.HASIL.SUKSES,
    category: options.category || accessLog.KATEGORI_SEMUA,
    responseRows: bersih.length,
    params: paramsAkses(req, format, fields),
  });

  if (format === 'csv') {
    const header = (metaHeader || []).concat(
      columnGrants.exportHeader(FIELD_ORDER, LABELS, denied, fields)
    );
    const lines = [header.map(selCsv).join(',')];
    for (let i = 0; i < bersih.length; i++) {
      const depan = metaRow ? metaRow(baris[i]) : [];
      const sel = depan.concat(columnGrants.exportRow(bersih[i], FIELD_ORDER, denied, fields));
      lines.push(sel.map(selCsv).join(','));
    }
    res.status(200).type('text/csv; charset=utf-8').send(lines.join('\r\n') + '\r\n');
    return { format, count: bersih.length };
  }

  if (format === 'xlsx') {
    // F3.10b. Berkas XLSX asli, bukan CSV yang diberi nama .xlsx -- file kedua
    // akan terbuka dengan hasil salah, dan kolom terlarang bisa ikut terbaca
    // tanpa disadari. Semua nilai ditulis sebagai teks supaya isian operator
    // yang diawali `=` tidak dieksekusi sebagai formula; lihat lib/xlsx-export.js.
    const buf = await xlsxExport.bangunXlsx(
      (metaHeader || []).concat(columnGrants.exportHeader(FIELD_ORDER, LABELS, denied, fields)),
      bersih.map((row, i) =>
        (metaRow ? metaRow(baris[i]) : []).concat(
          columnGrants.exportRow(row, FIELD_ORDER, denied, fields)
        )
      )
    );
    res.status(200)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="sasaran.xlsx"')
      .send(Buffer.from(buf));
    return { format, count: bersih.length };
  }

  const keluaran = metaJson
    ? bersih.map((row, i) => Object.assign({}, metaJson(baris[i]), row))
    : bersih;
  res.status(200).json(Object.assign({ success: true, data: keluaran }, options.json || {}));
  return { format, count: bersih.length };
}

/**
 * Terjemahkan galat kolom terlarang/format jadi respons HTTP dengan kode mesin.
 *
 * Galat dari lib/column-grants.js sudah membawa `code` dan `status`, jadi
 * dipetakan apa adanya. Galat lain dibiarkan menjadi 500 tanpa detail --
 * pesan mentah dari database bisa memuat nama kolom atau nilai data.
 */
// Kode galat yang memang jawaban yang diminta PRD, bukan kegagalan internal.
// FR-4.6: `CATEGORY_NOT_GRANTED` (FR-4.2) dan `DESA_NOT_GRANTED` (FR-4.18)
// adalah penolakan eksplisit yang harus sampai ke klien apa adanya. Kode
// kursor/parameter menandai permintaan yang salah bentuk, juga bukan 500.
//
// Kode F3.2 (jalur tulis) ditambahkan di sini supaya penolakan yang sah --
// validasi, taksonomi di luar ADR-5, instansi tidak aktif, koreksi ke record
// yang tidak ada, bentrok versi/hash -- sampai ke klien dengan kode mesin,
// bukan menjadi `INTERNAL_ERROR` 500 yang menyembunyikan penyebabnya.
const KODE_GALAT_DIKENAL = [
  'FIELD_NOT_GRANTED', 'FIELD_UNKNOWN', 'INVALID_FORMAT',
  'CATEGORY_NOT_GRANTED', 'DESA_NOT_GRANTED',
  'INVALID_PARAM', 'INVALID_CURSOR',
  'VALIDATION_FAILED', 'JENIS_UNKNOWN',
  'AGENCY_UNKNOWN', 'AGENCY_INACTIVE', 'RECORD_NOT_PERMITTED',
  'RECORD_NOT_FOUND', 'VERSION_CONFLICT', 'DUPLICATE_HASH',
];

function kirimGalat(res, e) {
  if (e && KODE_GALAT_DIKENAL.includes(e.code)) {
    // FR-4.4: kode dari kode ini diteruskan mentah ke `result`, bukan
    // diterjemahkan di sini. `hasilDari` yang memetakan kode ke delapan nilai
    // yang diizinkan CHECK constraint, jadi kode baru yang tidak ada di sana
    // akan terlihat sebagai kegagalan uji -- bukan diam-diam tercatat `error`.
    accessLog.tandai(res, {
      kode: e.code,
      params: { fields: e.fields || undefined },
    });
    const badan = { success: false, code: e.code, message: e.message };
    if (e.fields) badan.fields = e.fields;
    res.status(e.status || 400).json(badan);
    return;
  }
  accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'INTERNAL_ERROR' });
  console.error(`[${new Date().toISOString()}] Galat tidak dikenal:`, (e && e.message) || e);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Galat internal.' });
}

const getCredentials = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  return require('./service_account.json');
};

const tombol = (v) => (v === '' || v === null || v === undefined ? '' : String(v));

// Urutan field yang disimpan ke Google Sheets (kolom B sampai akhir, kolom A = No)
const FIELD_ORDER = [
  'namaTPK', 'peranTPK', 'noHpTPK',
  'namaDesa', 'namaKecamatan', 'rw', 'rt',
  'nik', 'noKK', 'namaLengkap', 'noHp', 'tanggalLahir', 'usia', 'alamat',
  'jenisSasaran',
  'sumberAir', 'jamban', 'terpaparRokok',
  'terlaluMuda', 'terlaluTua', 'terlaluDekat', 'terlaluBanyak',
  'gunakanKB', 'jenisKB', 'rencanaKB', 'rencanaKehamilan',
  'bpjsAktif', 'jenisBPJS', 'dtks', 'bansosDiterima',
  'hpht', 'usiaKehamilan', 'bbSebelumHamil', 'bbSekarang', 'tb', 'lila', 'hb', 'tfu', 'tbj',
  'riwayatPenyakit', 'terimaTTD', 'aksesFaskes', 'hamilKembar',
  'tanggalLahirBayi', 'umurBayi', 'bbLahir', 'pbLahir', 'cukupBulan', 'asiEksklusif', 'sudahImunisasi', 'kak', 'stimulasi',
  'namaAyah', 'nikAyah', 'namaIbu', 'nikIbu', 'tanggalLahirIbu',
  'kiePenyuluhan', 'jenisKIE',
  'fasilitasiRujukan', 'rujukanKe', 'rujukanProses',
  'fasilitasiBansos', 'bansosProgram',
  'hadirPosyandu', 'teridentifikasiRisiko',
  'tanggalKunjungan', 'catatanTPK',
  'timTPK', 'pendampinganKe', 'jenisKelamin', 'mbg3B',
];

// Nama kolom SQL (snake_case) untuk setiap field. `field_catalog.column_key`
// menyimpan bentuk inilah, dan trigger `validasi_hidden_fields` membandingkan
// `agency_config.hidden_fields` dengan `column_key` -- jadi daftar yang dipakai
// validasi konfigurasi (F3.10c) harus bentuk yang sama, bukan FIELD_ORDER.
const KOLOM_KONFIG = FIELD_ORDER.map(columnName);

const LABELS = {
  namaTPK: 'Nama Petugas TPK', peranTPK: 'Peran dalam TPK', noHpTPK: 'No. HP Petugas',
  namaDesa: 'Desa/Kelurahan', namaKecamatan: 'Kecamatan', rw: 'RW', rt: 'RT',
  nik: 'NIK', noKK: 'No. KK', namaLengkap: 'Nama Lengkap', noHp: 'No. HP/WA',
  tanggalLahir: 'Tanggal Lahir', usia: 'Usia (tahun)', alamat: 'Alamat',
  jenisSasaran: 'Jenis Sasaran',
  sumberAir: 'Akses Air Minum', jamban: 'Fasilitas BAB (Jamban)', terpaparRokok: 'Terpapar Rokok',
  terlaluMuda: 'Terlalu Muda', terlaluTua: 'Terlalu Tua', terlaluDekat: 'Terlalu Dekat', terlaluBanyak: 'Terlalu Banyak',
  gunakanKB: 'Status KB', jenisKB: 'Jenis/Alat KB', rencanaKB: 'Rencana KB (Catin)', rencanaKehamilan: 'Rencana Kehamilan (Catin)',
  bpjsAktif: 'BPJS Aktif', jenisBPJS: 'Jenis BPJS', dtks: 'Terdaftar DTKS', bansosDiterima: 'Bansos Diterima',
  hpht: 'HPHT', usiaKehamilan: 'Usia Kehamilan (minggu)', bbSebelumHamil: 'BB Sebelum Hamil (kg)',
  bbSekarang: 'BB Sekarang (kg)', tb: 'Tinggi Badan (cm)', lila: 'LILA (cm)', hb: 'Hb (g/dl)',
  tfu: 'TFU (cm)', tbj: 'TBJ (gram)', riwayatPenyakit: 'Riwayat Penyakit', terimaTTD: 'Terima TTD',
  aksesFaskes: 'Akses Faskes', hamilKembar: 'Hamil Kembar',
  tanggalLahirBayi: 'Tanggal Melahirkan', umurBayi: 'Umur Bayi saat Lahir (minggu)',
  bbLahir: 'BB Lahir (kg)', pbLahir: 'PB Lahir (cm)', cukupBulan: 'Cukup Bulan',
  asiEksklusif: 'ASI Eksklusif', sudahImunisasi: 'Imunisasi Rutin', kak: 'Isi KAK', stimulasi: 'Perkembangan Anak',
  namaAyah: 'Nama Ayah', nikAyah: 'NIK Ayah', namaIbu: 'Nama Ibu', nikIbu: 'NIK Ibu', tanggalLahirIbu: 'Tanggal Lahir Ibu',
  kiePenyuluhan: 'KIE Penyuluhan', jenisKIE: 'Jenis KIE',
  fasilitasiRujukan: 'Fasilitasi Rujukan', rujukanKe: 'Rujukan Ke', rujukanProses: 'Status Rujukan',
  fasilitasiBansos: 'Fasilitasi Bansos', bansosProgram: 'Program Bansos',
  hadirPosyandu: 'Hadir Posyandu', teridentifikasiRisiko: 'Teridentifikasi Risiko',
  tanggalKunjungan: 'Tanggal Kunjungan', catatanTPK: 'Catatan TPK',
  timTPK: 'Tim TPK', pendampinganKe: 'Pendampingan Ke', jenisKelamin: 'Jenis Kelamin',
  mbg3B: 'Sudah Menerima MBG 3B',
};

const HEADERS = ['No', ...FIELD_ORDER.map(f => LABELS[f])];

const buildRow = (body) => FIELD_ORDER.map(f => tombol(body[f]));

const SHEET_NAME = () => process.env.SHEET_NAME || 'Sheet1';
const SHEET_ID = () => process.env.SHEET_ID;

// Kolom yang dibaca endpoint /api/sasaran pada mode fallback. Daftar ini
// menggantikan indeks kolom hardcode (F1.12): posisinya dicari lewat label,
// jadi menambah atau mengurutkan kolom di FIELD_ORDER tidak lagi merusak
// pembacaan. Urutan daftar dipertahankan agar isi respons tidak berubah.
const FIELDS_SASARAN = [
  'nik', 'namaLengkap', 'noKK', 'tanggalLahir', 'usia', 'noHp', 'alamat',
  'jenisSasaran', 'namaDesa', 'namaKecamatan', 'rw', 'rt',
  'namaTPK', 'peranTPK', 'noHpTPK',
  'sumberAir', 'jamban', 'terpaparRokok',
  'gunakanKB', 'jenisKB', 'rencanaKB', 'rencanaKehamilan',
  'bpjsAktif', 'jenisBPJS', 'dtks', 'bansosDiterima',
];

// Kolom terakhir dari HEADERS (contoh: 73 kolom = "BU")
const lastColumn = (len) => {
  let col = '';
  let n = len;
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
};

// Peta label header -> indeks kolom. Label duplikat memakai kemunculan pertama,
// sama seperti yang akan dilakukan manusia membaca sheet dari kiri ke kanan.
const headerToIndex = (headerRow) => {
  const map = new Map();
  (headerRow || []).forEach((label, i) => {
    const key = String(label === undefined || label === null ? '' : label).trim();
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
};

// Baris pertama hanya boleh dipakai sebagai peta kolom kalau memang terlihat
// seperti header. Sheet yang masih kosong, atau yang baris header-nya terhapus,
// tidak boleh membuat seluruh kolom bergeser diam-diam tanpa peringatan.
const looksLikeHeaderRow = (row) =>
  Array.isArray(row) && row.some((c) => String(c || '').trim() === LABELS.nik);

// Ambil satu field dari baris sheet berdasarkan labelnya, bukan indeks tetap.
// Kolom yang tidak ada di sheet menghasilkan undefined supaya bisa dilaporkan,
// bukan diam-diam diisi string kosong.
const pickField = (row, colIndex, field) => {
  const i = colIndex.get(LABELS[field]);
  if (i === undefined) return undefined;
  const v = row[i];
  return v === undefined || v === null ? '' : v;
};

// Penghitung pemanggilan sumber data, hanya untuk uji.
//
// Route_rate_limit harus menolak SEBELUM membaca spreadsheet. Membuktikan itu
// dari respons saja tidak mungkin: `kirimBaris` memvalidasi kolom terlarang juga,
// jadi responsnya sama baikpun urutannya benar atau salah. Yang membedakan
// keduanya adalah apakah `getSheets` pernah dipanggil.
let hitungSumberData = null;

// Titik injeksi untuk uji.
//
// Tanpa ini, satu-satunya cara menguji `POST /api/submit` adalah memanggil
// Google Sheets sungguhan -- dan itulah sebabnya jalur itu selama ini tanpa
// uji end-to-end: bukan malas, tapi tidak ada jalannya. `spyGetSheets` di bawah
// hanya menghitung panggilan, tidak menggantikan jawabannya, jadi `append`
// tetap akan memanggil jaringan.
//
// Sengaja dipisah dari `hitungSumberData`: satu menghitung, satu mengganti.
// Menyatukan keduanya berarti setiap spy yang hanya ingin menghitung akan
// diam-diam mengganti sumber data.
let pemasokSheets = null;
const setSheets = (fn) => { pemasokSheets = fn; };

const getSheets = async () => {
  if (hitungSumberData) hitungSumberData();
  if (pemasokSheets) return pemasokSheets();
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
};

// ===== Baca daftar sasaran dari spreadsheet master (read-only) =====
const REF_SHEET_ID = () => process.env.REF_SHEET_ID;
const REF_SHEET_NAME = () => process.env.REF_SHEET_NAME || 'Form Responses 1';

// Pemetaan: field form app -> judul kolom di spreadsheet master
const REF_FIELDS = {
  nik: 'NIK Sasaran',
  noKK: 'NIK KK',
  namaLengkap: 'Nama Sasaran',
  tanggalLahir: 'Tanggal Lahir',
  usia: 'Umur',
  satuanUsia: 'Satuan Umur',
  noHp: 'No HP',
  alamat: 'Alamat',
  jenisSasaran: 'Sasaran',
  bbSekarang: 'BB',
  tb: 'TB',
  jenisKelamin: 'JK',
  namaDesa: 'Desa',
  namaKecamatan: 'Kecamatan',
  namaTPK: 'Nama TPK',
  peranTPK: 'Unsur TPK',
  timTPK: 'Tim TPK',
  pendampinganKe: 'Pendampingan Ke',
  mbg3B: 'Sudah Menerima MBG 3B',
};

const NORMALIZE_SASARAN = {
  'calon pengantin': 'Catin',
  'calon pengantin / calon pus': 'Catin',
  'catin': 'Catin',
  'ibu hamil': 'Ibu Hamil',
  'hamil': 'Ibu Hamil',
  'ibu nifas': 'Ibu Nifas',
  'nifas': 'Ibu Nifas',
  'baduta': 'Baduta',
  'baduta 0-23 bulan': 'Baduta',
  'bayi 0-23 bulan': 'Baduta',
  'balita': 'Balita',
  'balita 24-59 bulan': 'Balita',
};

const normalizeNik = (v) => {
  const s = String(v || '').trim().replace(/\s+/g, '');
  if (s.indexOf('E') > -1) return ''; // nilai numerik ilmiah -> tidak bisa dipastikan, lewati
  return s.replace(/\D/g, '');
};

const getRefSheets = async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
};

const getSasaranFromRef = async () => {
  if (hitungSumberData) hitungSumberData();
  const sheets = await getRefSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REF_SHEET_ID(),
    range: `'${REF_SHEET_NAME()}'!A1:ZZ`,
  });

  const all = res.data.values || [];
  if (all.length === 0) return [];

  const header = all[0].map(h => String(h || '').trim());
  const colIndex = {};
  Object.entries(REF_FIELDS).forEach(([field, label]) => {
    const i = header.indexOf(label);
    if (i > -1) colIndex[field] = i;
  });

  const get = (row, field) => {
    const i = colIndex[field];
    return i !== undefined && row[i] !== undefined ? String(row[i]).trim() : '';
  };

  const sasaranMap = {};
  for (const row of all.slice(1)) {
    const nik = normalizeNik(get(row, 'nik'));
    if (nik.length !== 16) continue;

    // Ubah satuan umur (bulan/minggu/hari) jadi tahun bila dipakai
    let usia = get(row, 'usia');
    const satuan = get(row, 'satuanUsia').toLowerCase();
    const angkaUsia = parseFloat(usia);
    if (satuan && angkaUsia > 0) {
      if (satuan.indexOf('bulan') > -1 || satuan.indexOf('minggu') > -1) {
        usia = String(Math.max(1, Math.round(angkaUsia / 12)));
      } else if (satuan.indexOf('hari') > -1) {
        usia = String(Math.max(1, Math.round(angkaUsia / 365)));
      }
    }

    const jenisSasaran = get(row, 'jenisSasaran');
    const sasaran = NORMALIZE_SASARAN[jenisSasaran.toLowerCase()] || jenisSasaran;
    const peran = get(row, 'peranTPK');
    const angka = (v) => v ? String(v).replace(',', '.').trim() : ''; // dukungan angka "70,00"

    sasaranMap[nik] = {
      nik,
      namaLengkap: get(row, 'namaLengkap'),
      noKK: get(row, 'noKK'),
      tanggalLahir: get(row, 'tanggalLahir'),
      usia,
      noHp: get(row, 'noHp'),
      alamat: get(row, 'alamat'),
      jenisSasaran: sasaran,
      jenisKelamin: get(row, 'jenisKelamin'),
      namaDesa: get(row, 'namaDesa'),
      namaKecamatan: get(row, 'namaKecamatan'),
      namaTPK: get(row, 'namaTPK'),
      peranTPK: peran,
      noHpTPK: '',
      timTPK: get(row, 'timTPK'),
      pendampinganKe: get(row, 'pendampinganKe'),
      mbg3B: get(row, 'mbg3B'),
      bbSekarang: angka(get(row, 'bbSekarang')),
      tb: angka(get(row, 'tb')),
    };
  }
  return Object.values(sasaranMap);
};

// Tulis baris header bila belum ada (baris pertama masih kosong)
const ensureHeaders = async (sheets) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A1`,
  });
  const first = res.data.values && res.data.values[0] ? res.data.values[0][0] : '';
  if (first !== undefined && first !== null && String(first).trim() !== '') return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [HEADERS] },
  });
};

// Nomor urut berikutnya berdasarkan isi kolom A (data), header di baris 1 diabaikan
const nextNumber = async (sheets) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A2:A`,
  });
  const vals = res.data.values || [];
  const count = vals.filter(r => r && r[0] !== undefined && String(r[0]).trim() !== '').length;
  return count + 1;
};

// Placeholder nomor urut untuk async flush (tanpa panggil Sheets API).
// Pakai timestamp + counter lokal agar unik per request.
let _sheetSeq = 0;
const nextNumberPlaceholder = async () => {
  _sheetSeq = (_sheetSeq + 1) % 1000000;
  return Date.now() + _sheetSeq;
};

const validate = (body) => {
  const errors = [];
  if (!tombol(body.namaTPK)) errors.push('namaTPK');
  if (!tombol(body.peranTPK)) errors.push('peranTPK');
  if (!tombol(body.namaDesa)) errors.push('namaDesa');
  if (!tombol(body.namaLengkap)) errors.push('namaLengkap');
  if (!tombol(body.jenisSasaran)) errors.push('jenisSasaran');
  if (!tombol(body.tanggalKunjungan)) errors.push('tanggalKunjungan');
  const nik = tombol(body.nik);
  if (!nik) errors.push('nik');
  else if (!/^\d{16}$/.test(nik)) errors.push('nik (harus 16 digit angka)');
  return errors;
};

// Dipasang di sini, bukan di dalam setiap route: dengan begitu tidak ada
// route baru yang bisa lupa memanggilnya, dan route yang ditambahkan nanti
// otomatis ikut terlindungi. `app.use` juga menutup 404, yang kalau tidak
// akan lolos tanpa pernah dicek.
//
// Pengecualian tunggal: jalur form publik (JALUR_PUBLIK di atas). Sisanya,
// termasuk route yang belum ditulis, tetap wajib kunci.
app.use('/api', autentikasi);

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Backend Pendampingan Keluarga TPK', endpoints: ['POST /api/submit', 'GET /api/sasaran', 'GET /api/v1/records', 'POST /api/v1/records', 'GET /api/v1/audit/proof', 'GET /api/v1/audit/zkp-proof'] });
});

/**
 * Kesehatan penulisan log akses (FR-4.4).
 *
 * Keputusan 2026-10-06: penulisan log GAGAL TIDAK menjatuhkan permintaan
 * (fail-open). Logika ada di `lib/access-log.js` -- `finish` terjadi setelah
 * respons terkirim, jadi menjatuhkannya bukan lagi mungkin, dan memaksanya
 * berarti PostgreSQL down menjadi API down, yang merusak M-2.
 *
 * Tapi fail-open yang diam membuat dua situasi tak terbedakan: "permintaan
 * sukses tapi tidak tercatat" dan "memang tidak pernah ada permintaan". Endpoint
 * ini yang memisahkan keduanya, sehingga selisihnya bisa diukur dan dilaporkan
 * alih-alih disembunyikan.
 *
 * Sengaja bukan `boolean`: `gagal: 0` dan `gagal: 3 tapi sudah pulih` sama-sama
 * sehat, dan membedakannya berguna saat menyelidiki.
 */
app.get('/api/audit/status', (req, res) => {
  const s = accessLogger.status ? accessLogger.status() : null;
  res.json({
    // `tertahan` > 0 berarti ada entri menunggu pengiriman ulang.
    // `dibuang` > 0 berarti entri benar-benar hilang -- itulah angka yang
    // harus masuk laporan sebagai sisa ketidakpastian.
    log_akses: s,
    db: db.status(),
    sehat: !!s && s.dibuang === 0,
    catatan: s && s.dibuang > 0
      ? 'Sebagian entri log akses hilang dan tidak dapat dipulihkan.'
      : null,
  });
});

/**
 * F4.3: GET /api/v1/audit/proof?id=<access_log.id> -- bukti inklusi Merkle
 * (FR-8.1, FR-8.2).
 *
 * Menjawab pertanyaan auditor T1: "entri log ini termasuk dalam akar yang
 * di-anchor?". Yang dikembalikan HANYA satu entri (entri itu sendiri, plus
 * saudara-saudara hash di pohon), bukan log penuh -- itulah bedanya T1 dari
 * T0, dan angkanya diukur di F4.6.
 *
 * Pembacaan log dilakukan sebagai peran `operator`, karena hanya operator/
 * admin yang boleh melihat `access_log` (policy `access_log_read`). Auditor
 * tidak memegang identitas operator; bukti yang ia terima tidak memuat baris
 * lain. Batasan yang diakui: sampai kredensial auditor (FR-8.4) ada, endpoint
 * ini mewarisi autentikasi permintaan biasa seperti `/api/audit/status`, dan
 * membocorkan keberadaan satu id -- bukan isi log.
 *
 * Biaya: seluruh `access_log` dibaca dan rantai dihitung ulang setiap
 * permintaan. Cukup untuk PoC; pada log yang sangat besar, batch yang di-anchor
 * (`audit_anchor`) sudah membatasi pohon yang dipakai, dan yang perlu
 * diperbaiki kelak adalah memuat hanya prefix sampai `to_seq`.
 *
 * Kode galat: `INVALID_PARAM` (400), `AUDIT_ENTRY_NOT_FOUND` (404),
 * `DB_UNAVAILABLE` (503).
 */
app.get('/api/v1/audit/proof', async (req, res) => {
  try {
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Database tidak tersedia; bukti inklusi memerlukan access_log.',
      });
      return;
    }

    const id = Number(req.query ? req.query.id : undefined);
    if (!Number.isInteger(id) || id <= 0) {
      accessLog.tandai(res, { kode: 'INVALID_PARAM' });
      res.status(400).json({
        success: false,
        code: 'INVALID_PARAM',
        message: 'Parameter id wajib bilangan bulat positif (access_log.id).',
      });
      return;
    }

    const { bukti } = await db.transaksi({ role: 'operator' }, async (client) => {
      const rows = (await client.query(
        'SELECT id, ts, actor_type, actor_id, category, params, result,' +
        ' response_rows, endpoint' +
        ' FROM access_log ORDER BY id ASC'
      )).rows;
      const anchors = (await client.query(
        'SELECT id, from_seq, to_seq, leaf_count, root, head_hash, algorithm,' +
        ' tx_hash, anchored_at FROM audit_anchor ORDER BY to_seq DESC'
      )).rows;
      return { bukti: auditLogChain.buktiUntukId(rows, id, { anchors }) };
    });

    if (!bukti) {
      accessLog.tandai(res, { kode: 'AUDIT_ENTRY_NOT_FOUND' });
      res.status(404).json({
        success: false,
        code: 'AUDIT_ENTRY_NOT_FOUND',
        message: 'Entri log akses dengan id itu tidak ditemukan.',
      });
      return;
    }

    accessLog.tandai(res, {
      responseRows: 0,
      category: bukti.entry.detail.category === null ? undefined : bukti.entry.detail.category,
    });
    res.json(Object.assign(
      { success: true, verified_by_server: auditLogChain.verifikasiBukti(bukti) },
      bukti
    ));
  } catch (e) {
    console.error(
      '[' + new Date().toISOString() + '] Gagal membuat bukti inklusi:',
      e && e.message ? e.message : e
    );
    res.status(500).json({
      success: false,
      message: 'Gagal membuat bukti inklusi: ' + (e && e.message ? e.message : e),
    });
  }
});

/**
 * F4.7 (integrasi): GET /api/v1/audit/zkp-proof?ids=..&category=..&date=..
 *
 * Menyambungkan sirkuit `no_match` (F4.7) ke `access_log` sungguhan: memilih
 * jendela 4 entri log (id eksplisit), membangun Merkle Poseidon, lalu
 * membuktikan klaim negatif -- "tidak ada entri di jendela ini yang cocok
 * dengan tuple (kategori, instansi, tanggal)". Auditor menerima bukti tanpa
 * membuka isi log lain, dan dapat memverifikasinya mandiri dengan
 * `snarkjs.groth16.verify` terhadap verification key `no_match`.
 *
 * Keterbatasan yang diakui terbuka (lihat juga `lib/zkp-audit.js`):
 *   - Jendela adalah HIMPUNAN 4 id yang dipilih pemanggil, bukan seluruh
 *     riwayat; klaim hanya berlaku di dalam jendela.
 *   - `log_root` adalah akar Merkle POSEIDON atas jendela, BUKAN akar anchor
 *     SHA-256 milik F4.2/F4.3. Keduanya belum diikat.
 *   - Trusted setup PoC terpusat (`zkey` rahasia) -> tidak tahan-manipulasi.
 *
 * Kode galat: `INVALID_PARAM` (400), `AUDIT_ENTRY_NOT_FOUND` (404),
 * `ZKP_TIDAK_TERSEDIA` (503), `DB_UNAVAILABLE` (503).
 */
app.get('/api/v1/audit/zkp-proof', async (req, res) => {
  try {
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Database tidak tersedia; bukti ZKP memerlukan access_log.',
      });
      return;
    }

    const q = req.query || {};
    const ids = String(q.ids === undefined ? '' : q.ids)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
    if (ids.length !== zkpAudit.JUMLAH_ENTRI || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      accessLog.tandai(res, { kode: 'INVALID_PARAM' });
      res.status(400).json({
        success: false,
        code: 'INVALID_PARAM',
        message: 'Parameter ids wajib ' + zkpAudit.JUMLAH_ENTRI +
          ' bilangan bulat positif dipisah koma (mis. ids=11,12,13,14).',
      });
      return;
    }

    let hasil;
    try {
      const baris = await db.transaksi({ role: 'operator' }, async (client) => {
        const rows = (await client.query(
          'SELECT id, ts, category, actor_id FROM access_log WHERE id = ANY($1::bigint[])',
          [ids]
        )).rows;
        // Kembalikan dalam URUTAN permintaan ids supaya indeks sel/path konsisten.
        const peta = new Map(rows.map((r) => [Number(r.id), r]));
        return ids.map((id) => peta.get(id));
      });

      const hilang = ids.filter((id, i) => !baris[i]);
      if (hilang.length) {
        accessLog.tandai(res, { kode: 'AUDIT_ENTRY_NOT_FOUND' });
        res.status(404).json({
          success: false,
          code: 'AUDIT_ENTRY_NOT_FOUND',
          message: 'Entri log akses tidak ditemukan untuk id: ' + hilang.join(', '),
        });
        return;
      }

      if (!zkpAudit.tersedia()) {
        accessLog.tandai(res, { kode: 'ZKP_TIDAK_TERSEDIA' });
        res.status(503).json({
          success: false,
          code: 'ZKP_TIDAK_TERSEDIA',
          message: 'Artefak ZKP no_match belum tersedia (jalankan: node zkp/src/cli.js setup).',
        });
        return;
      }

      hasil = await zkpAudit.buktiKlaimNegatif({
        baris,
        target: { kategori: q.category, instansi: q.institution, tanggal: q.date },
      });
    } catch (e) {
      if (/category wajib|tanggal wajib|tanggal tidak valid|date wajib/.test(e && e.message ? e.message : '')) {
        accessLog.tandai(res, { kode: 'INVALID_PARAM' });
        res.status(400).json({
          success: false,
          code: 'INVALID_PARAM',
          message: e.message,
        });
        return;
      }
      throw e;
    }

    accessLog.tandai(res, { responseRows: 0, category: 'audit' });
    res.json(Object.assign(
      {
        success: true,
        klaim: 'tidak ada entri cocok dengan tuple target di dalam jendela',
        catatan: 'log_root adalah akar Merkle Poseidon atas jendela, bukan akar anchor SHA-256 (F4.2/F4.3); keduanya belum diikat.',
      },
      hasil
    ));
  } catch (e) {
    console.error(
      '[' + new Date().toISOString() + '] Gagal membuat bukti ZKP:',
      e && e.message ? e.message : e
    );
    res.status(500).json({
      success: false,
      message: 'Gagal membuat bukti ZKP: ' + (e && e.message ? e.message : e),
    });
  }
});

// ---------------------------------------------------------------------------
// F3.10c: GET/PUT /api/v1/config -- preferensi instansi (FR-4.9..4.12, FR-4.21).
//
// Dipisah dari data: konfigurasi TIDAK memengaruhi otorisasi (baca komentar
// skema). Identitas pengatur datang dari kunci API F3.10a, jadi instansi hanya
// bisa mengubah preferensinya sendiri -- RLS `agency_config_own_write`
// menegakkannya di lapisan database, bukan di sini.
//
// FR-4.11: setiap perubahan dicatat di log akses yang sama. Itu TIDAK dikerjakan
// dengan menulis baris kedua: middleware akses sudah mencatat SETIAP respons.
// Route cukup menandai lewat `accessLog.tandai` apa yang berubah, sehingga
// perubahan konfigurasi muncul sebagai entri `category: 'config'` di
// `access_log` yang sama -- bukan tabel log terpisah yang bisa menyimpang.
// ---------------------------------------------------------------------------

/**
 * Ambil identitas instansi terverifikasi untuk endpoint konfigurasi.
 * Mengembalikan { agencyIdNum } atau null setelah mengirim galat 401.
 */
function identitasKonfigurasi(req, res) {
  const identitas = agencyIdDari(req);
  const agencyIdNum = Number(identitas.agencyId);
  if (!identitas.terverifikasi || !Number.isInteger(agencyIdNum) || agencyIdNum <= 0) {
    accessLog.tandai(res, {
      result: accessLog.HASIL.DENIED_AUTH,
      kode: 'AUTH_REQUIRED',
    });
    res.status(401).json({
      success: false,
      code: 'AUTH_REQUIRED',
      message: 'Konfigurasi memerlukan kunci API instansi yang valid.',
    });
    return null;
  }
  return agencyIdNum;
}

const SELECT_KONFIG = 'SELECT hidden_fields, column_order, default_filters,' +
  ' default_format, updated_at, updated_by FROM agency_config WHERE agency_id = $1';

app.get('/api/v1/config', async (req, res) => {
  try {
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Konfigurasi membutuhkan PostgreSQL; DATABASE_URL belum diset.',
      });
      return;
    }

    const { hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyIdDari(req), hasil);
      return;
    }

    const agencyIdNum = identitasKonfigurasi(req, res);
    if (agencyIdNum === null) return;

    accessLog.tandai(res, { actorId: agencyIdNum, actorType: 'agency', category: 'config' });

    const data = await db.transaksi({ role: 'agency', agency_id: agencyIdNum }, async (client) => {
      const a = await client.query('SELECT id, name, contact FROM agencies WHERE id = $1', [agencyIdNum]);
      const c = await client.query(SELECT_KONFIG, [agencyIdNum]);
      return { agency: a.rows[0] || null, baris: c.rows[0] || null };
    });

    const b = data.baris;
    const prefs = b ? {
      hidden_fields: b.hidden_fields,
      column_order: b.column_order,
      default_filters: b.default_filters,
      default_format: b.default_format,
      updated_at: b.updated_at,
      updated_by: b.updated_by,
    } : Object.assign(config.lengkapi({}), { updated_at: null, updated_by: null });

    res.json({
      success: true,
      config: {
        agency_id: agencyIdNum,
        agency_name: data.agency ? data.agency.name : null,
        agency_contact: data.agency ? data.agency.contact : null,
        hidden_fields: prefs.hidden_fields,
        column_order: prefs.column_order,
        default_filters: prefs.default_filters,
        default_format: prefs.default_format,
        updated_at: prefs.updated_at,
        updated_by: prefs.updated_by,
      },
    });
  } catch (error) {
    kirimGalat(res, error);
  }
});

app.put('/api/v1/config', async (req, res) => {
  try {
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Konfigurasi membutuhkan PostgreSQL; DATABASE_URL belum diset.',
      });
      return;
    }

    const { hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyIdDari(req), hasil);
      return;
    }

    const agencyIdNum = identitasKonfigurasi(req, res);
    if (agencyIdNum === null) return;

    // Validasi bentuk lebih dulu, sebelum database disentuh. Galat validasi
    // membawa kode mesin dan ditangani `kirimGalat`; yang penting, barang
    // setengah jadi tidak pernah sampai ke UPSERT.
    const sebagian = config.normalisasi(req.body, { fieldOrder: KOLOM_KONFIG });
    const penuh = config.lengkapi(sebagian);

    // FR-4.11: yang dicatat adalah APA yang berubah (kunci + nilai tervalidasi),
    // bukan hanya "permintaan PUT". Nilai sudah lewat normalisasi, jadi tak ada
    // masukan mentah klien yang bocor ke log. `paramsBersih` hanya menerima
    // bentuk primitif/array, jadi tiap kunci dicatat datar: array string apa
    // adanya, objek kecil (default_filters) diserialkan agar tetap terbaca.
    const penuhLog = {};
    for (const ket of Object.keys(penuh)) {
      const nilai = penuh[ket];
      penuhLog[ket] = (typeof nilai === 'object' && nilai !== null && !Array.isArray(nilai))
        ? JSON.stringify(nilai)
        : nilai;
    }
    accessLog.tandai(res, {
      actorId: agencyIdNum,
      actorType: 'agency',
      category: 'config',
      result: accessLog.HASIL.SUKSES,
      params: Object.assign({ diubah: Object.keys(sebagian) }, penuhLog),
    });

    const disimpan = await db.transaksi({ role: 'agency', agency_id: agencyIdNum }, async (client) => {
      const r = await client.query(
        'INSERT INTO agency_config (agency_id, hidden_fields, column_order, default_filters, default_format, updated_at, updated_by)' +
        ' VALUES ($1, $2, $3, $4::jsonb, $5, now(), $6)' +
        ' ON CONFLICT (agency_id) DO UPDATE SET' +
        ' hidden_fields = EXCLUDED.hidden_fields,' +
        ' column_order = EXCLUDED.column_order,' +
        ' default_filters = EXCLUDED.default_filters,' +
        ' default_format = EXCLUDED.default_format,' +
        ' updated_at = now(),' +
        ' updated_by = EXCLUDED.updated_by' +
        ' RETURNING hidden_fields, column_order, default_filters, default_format, updated_at, updated_by',
        [
          agencyIdNum,
          penuh.hidden_fields,
          penuh.column_order,
          JSON.stringify(penuh.default_filters),
          penuh.default_format,
          'agency:' + agencyIdNum,
        ]
      );
      return r.rows[0];
    });

    res.json({
      success: true,
      config: {
        agency_id: agencyIdNum,
        hidden_fields: disimpan.hidden_fields,
        column_order: disimpan.column_order,
        default_filters: disimpan.default_filters,
        default_format: disimpan.default_format,
        updated_at: disimpan.updated_at,
        updated_by: disimpan.updated_by,
      },
    });
  } catch (error) {
    kirimGalat(res, error);
  }
});

/**
 * Periksa permintaan sebelum membaca data dari mana pun.
 *
 * `kirimBaris` juga memanggil validasi yang sama, tapi itu terlalu lambat untuk
 * HDR-4.20c di route: `sasaranList` sudah dibaca dari Google Sheets sebelum
 * `kirimBaris` dipanggil. Membaca dulu lalu menolak berarti permintaan
 * terlarang tetap menghabiskan kuota API dan, kalau sumbernya adalah sheet
 * berisi kolom terlarang, data itu sempat masuk ke memori proses Though tidak
 * pernah dikirim.
 *
 * Negatif ganda itu disengaja. `kirimBaris` tetap memvalidasinya karena ia juga
 * dipakai oleh endpoint lain, dan validasi ganda tidak mungkin meloloskan kolom
 * terlarang -- hanya menambah satu pemeriksaan yang murah.
 *
 * @throws {Error} dengan `code` FIELD_NOT_GRANTED/FIELD_UNKNOWN/INVALID_FORMAT
 */
function validasiPermintaan(req) {
  const format = parseFormat(req);
  const fields = parseFields(req);
  columnGrants.assertFieldsAllowed(fields, FIELD_ORDER, null);

  // Catatan asal-usul blok yang dulu ada di sini: XLSX pernah ditolak dengan
  // status 501 "belum ada pustaka spreadsheet". Alasannya menolak SEBELUM
  // membaca data tetap berlaku -- satu permintaan mustahil tidak boleh
  // menghabiskan kuota Sheet API -- tapi XLSX sekarang sudah didukung
  // (`lib/xlsx-export.js`, F3.10b), jadi tidak ada lagi yang mustahil untuk
  // ditolak. Menolaknya di sini membuat ekspor XLSX tidak bisa dijangkau
  // sama sekali, karena blok ini berjalan sebelum `kirimBaris`.
  return { format, fields };
}

app.get('/api/sasaran', async (req, res) => {
  try {
    // FR-4.5: kuota dicek lebih dulu, sebelum validasi kolom dan sebelum
    // membaca data. Urutannya penting: membaca spreadsheet lalu menolak
    // hanya membuang kuota Google tanpa memberi manfaat apa pun.
    const { agencyId, hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyId, hasil);
      return;
    }

    // FR-4.20c: penolakan sebelum sumber data disentuh. Lihat catatan
    // validasiPermintaan di atas.
    validasiPermintaan(req);

    let sasaranList;
    if (process.env.REF_SHEET_ID) {
      // Sumber utama: spreadsheet master (read-only)
      sasaranList = await getSasaranFromRef();
    } else {
      // Fallback: baca dari spreadsheet submit sendiri (perilaku lama).
      //
      // Header dan data diambil dalam SATU panggilan. kuota Google Sheets terbatas,
      // jadi tidak boleh menambah panggilan hanya untuk membaca header.
      const sheets = await getSheets();
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID(),
        range: `${SHEET_NAME()}!A1:${lastColumn(HEADERS.length)}`,
      });

      const all = result.data.values || [];
      const pakaiHeaderSheet = looksLikeHeaderRow(all[0]);
      const colIndex = headerToIndex(pakaiHeaderSheet ? all[0] : HEADERS);
      const rows = pakaiHeaderSheet ? all.slice(1) : all;

      if (all.length > 0 && !pakaiHeaderSheet) {
        console.warn(
          `[${new Date().toISOString()}] Baris header tidak dikenali di sheet "${SHEET_NAME()}". ` +
          'Menggunakan urutan kolom bawaan. Nilai bisa salah baca bila kolom di sheet ' +
          'sudah disusun ulang manual.'
        );
      }

      const kolomHilang = FIELDS_SASARAN.filter((f) => !colIndex.has(LABELS[f]));
      if (kolomHilang.length > 0) {
        console.warn(
          `[${new Date().toISOString()}] Kolom tidak ditemukan di sheet: ` +
          kolomHilang.map((f) => LABELS[f]).join(', ')
        );
      }

      const sasaranMap = {};

      for (const row of rows) {
        const nik = pickField(row, colIndex, 'nik') || '';
        if (!nik || nik.length !== 16) continue;

        if (!sasaranMap[nik]) {
          const entry = {};
          for (const f of FIELDS_SASARAN) {
            entry[f] = pickField(row, colIndex, f) || '';
          }
          sasaranMap[nik] = entry;
        }
      }

      sasaranList = Object.values(sasaranMap);
    }

    // FR-4.20b: baris data hanya boleh dikirim lewat kirimBaris. Sebelumnya
    // res.json di sini berarti kolom terlarang tidak pernah disaring -- dan
    // kolom itu bisa saja muncul kalau FIELDS_SASARAN suatu saat diperluas.
    await kirimBaris(req, res, sasaranList);
  } catch (error) {
    // Galat kolom terlarang, kolom asing, dan format bukan kegagalan internal:
    // itu jawaban yang diminta FR-4.6 dan FR-4.20a. Semuanya punya kode mesin.
    if (error && ['FIELD_NOT_GRANTED', 'FIELD_UNKNOWN', 'INVALID_FORMAT'].includes(error.code)) {
      kirimGalat(res, error);
      return;
    }
    console.error(`[${new Date().toISOString()}] Gagal mengambil data sasaran:`, error.message);
    res.status(500).json({ success: false, message: `Gagal mengambil data sasaran: ${error.message}` });
  }
});

// ---------------------------------------------------------------------------
// F3.6: GET /api/v1/records -- Query API (deliverable utama, ADR-6, FR-4.1..4.8).
//
// Urutan alur sengaja: kuota -> identitas -> bentuk permintaan -> hibah ->
// query. Setiap langkah menolak SEBELUM langkah berikutnya menyentuh data.
//
// Identitas WAJIB terverifikasi. Berbeda dari /api/sasaran yang masih boleh
// mode legacy (header `x-agency-id`), Query API membaca lewat RLS yang
// memerlukan `agency_id` sungguhan (`jwt_agency_id()`). Header yang dikontrol
// klien tidak bisa menjadi identitas RLS: kalau bisa, siapa pun membaca data
// instansi mana pun cukup dengan mengganti header.
// ---------------------------------------------------------------------------
app.get('/api/v1/records', async (req, res) => {
  try {
    // Query API tidak punya arti tanpa database; jangan menebak-nebak lewat
    // Sheets. 503, bukan 500: ini keadaan yang bisa diperbaiki operator.
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Query API membutuhkan PostgreSQL; DATABASE_URL belum diset.',
      });
      return;
    }

    // FR-4.5: kuota dicek dulu, sebelum validasi kolom dan sebelum menyentuh data.
    const { agencyId, hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyId, hasil);
      return;
    }

    const identitas = agencyIdDari(req);
    const agencyIdNum = Number(identitas.agencyId);
    if (!identitas.terverifikasi || !Number.isInteger(agencyIdNum) || agencyIdNum <= 0) {
      accessLog.tandai(res, {
        result: accessLog.HASIL.DENIED_AUTH,
        kode: 'AUTH_REQUIRED',
      });
      res.status(401).json({
        success: false,
        code: 'AUTH_REQUIRED',
        message: 'Query API memerlukan kunci API instansi yang valid.',
      });
      return;
    }

    // FR-4.1: bentuk permintaan. Nilai salah bentuk ditolak 400 di sini.
    const q = recordsQuery.parseQuery(req.query);
    // Format dan `fields` yang mustahil ditolak sebelum database disentuh.
    validasiPermintaan(req);

    accessLog.tandai(res, {
      actorId: agencyIdNum,
      actorType: 'agency',
      category: q.kategori_1 || accessLog.KATEGORI_SEMUA,
      params: paramsAkses(req, parseFormat(req), parseFields(req)),
    });

    // Seluruh pembacaan berjalan sebagai peran `agency` dengan klaim instansi
    // pemanggil, jadi RLS (kategori FR-4.2, wilayah FR-4.17) menegakkan
    // pembatasan di lapisan database -- bukan di aplikasi.
    const halaman = await db.transaksi({ role: 'agency', agency_id: agencyIdNum }, async (client) => {
      // Hibah dibaca SEBAGAI instansi itu sendiri, memakai policy own_select
      // yang sama dengan yang dipakai RLS. Tidak ada daftar kedua yang bisa
      // menyimpang dari yang benar-benar ditegakkan.
      const kats = await client.query(
        'SELECT jenis_sasaran FROM agency_categories WHERE agency_id = $1',
        [agencyIdNum]
      );
      const scope = await client.query(
        'SELECT nama_kecamatan, nama_desa FROM agency_desa_scope WHERE agency_id = $1',
        [agencyIdNum]
      );
      const deniedRes = await client.query('SELECT denied_columns($1) AS d', [agencyIdNum]);
      const denied = (deniedRes.rows[0] && deniedRes.rows[0].d) || [];

      // FR-4.6/FR-4.18: penolakan eksplisit sebelum query. RLS tetap menapis
      // baris, tapi ia tidak bisa membedakan "tidak berhak" dari "tidak ada".
      recordsQuery.validasiHibah(q, {
        categories: kats.rows.map((r) => r.jenis_sasaran),
        scope: scope.rows,
      });
      // FR-4.20a: permintaan eksplisit `fields` yang memuat kolom terlarang
      // (termasuk tambahan per instansi) ditolak, bukan dihapus diam-diam.
      columnGrants.assertFieldsAllowed(parseFields(req), FIELD_ORDER, denied);

      const rencana = recordsQuery.rencanaKueri({ q, fieldOrder: FIELD_ORDER, denied, fields: parseFields(req) });
      const baca = await client.query(rencana.sql, rencana.params);
      return { rows: baca.rows, denied };
    });

    // FR-4.7: `rencanaKueri` membaca `limit + 1` baris. Kehadiran baris
    // kelebihan itulah bukti halaman berikutnya ada -- tanpa query hitung kedua.
    const semua = halaman.rows;
    const adaLagi = semua.length > q.limit;
    const barisHalaman = adaLagi ? semua.slice(0, q.limit) : semua;
    const nextCursor = adaLagi && barisHalaman.length > 0
      ? recordsQuery.encodeCursor(barisHalaman[barisHalaman.length - 1])
      : null;

    // FR-4.20b: baris tetap lewat satu pintu `kirimBaris`. Metadata (FR-4.3)
    // ditambahkan lewat opsi, bukan jalur JSON terpisah.
    await kirimBaris(req, res, barisHalaman, {
      denied: halaman.denied,
      category: q.kategori_1 || accessLog.KATEGORI_SEMUA,
      metaHeader: recordsQuery.META_HEADER,
      metaRow: (r) => recordsQuery.metaRow(r),
      metaJson: (r) => recordsQuery.metaFor(r),
      json: {
        count: barisHalaman.length,
        has_more: adaLagi,
        next_cursor: nextCursor,
      },
    });
  } catch (error) {
    // Kode penolakan (kategori/wilayah/kolom/parameter/kursor) sudah membawa
    // status dan kode mesin; kirimGalat meneruskannya. Sisanya 500.
    kirimGalat(res, error);
  }
});

// ---------------------------------------------------------------------------
// F3.2: POST /api/v1/records -- jalur tulis dengan versioning (FR-3.2..FR-3.7).
//
// Tambahkan record baru, atau koreksi yang membuat VERSI BARU (FR-3.4): baris
// lama tidak pernah diubah, `supersedes_id` menunjuk baris lama, dan `version`
// bertambah satu. `record_hash` selalu dihitung ulang dari payload baru, jadi
// anchor lama tetap sah dan yang baru bisa diverifikasi terpisah.
//
// Identitas WAJIB terverifikasi (sama seperti Query API). `institution_id`
// diambil dari kunci API, BUKAN dari body. Policy `records_agency_insert`
// menegakkan hal yang sama di database: instansi hanya bisa menulis atas
// namanya sendiri, untuk kategori dan wilayah yang benar-benar dihibahkan.
//
// Yang belum ada di sini dan disengaja: PENGISIAN `chain_outbox` DILAKUKAN di
// sini, di dalam transaksi yang sama dengan INSERT (F3.3, FR-3.6). Keputusan
// "advisory" (on-chain gagal = backlog, bukan penolakan tulis): record dan
// baris outbox berkomitmen bersamaan atau tidak sama sekali. Proses on-chain
// (F3.4) memakai outbox ini sebagai antrean anchor, dan bila on-chain gagal
// ia hanya membiarkan baris tetap pending -- penyimpanan dan query tidak
// pernah diblokir. Policy `chain_outbox_agency_insert` menegakkan bahwa
// instansi hanya mengantrekan versi yang memang MILIKNYA (created_by).
// ---------------------------------------------------------------------------

/**
 * Terjemahkan galat PostgreSQL dari INSERT menjadi kode mesin.
 *
 * Dua kelas yang punya arti beda dan tidak boleh menyamar jadi 500:
 * pelanggaran UNIQUE (versi/hash sudah ada -> 409) dan penolakan RLS
 * (-> 403). Sisanya diteruskan apa adanya supaya menjadi 500.
 */
function galatTulisDariPg(e) {
  if (!e || typeof e !== 'object') return e;
  if (e.code === '23505') {
    const c = String(e.constraint || '');
    if (c.indexOf('record_hash') >= 0) {
      return recordsWrite.galat(
        recordsWrite.KODE.DUPLICATE_HASH,
        'Isi record ini sudah tercatat (record_hash sama).',
        409
      );
    }
    return recordsWrite.galat(
      recordsWrite.KODE.VERSION_CONFLICT,
      'Versi yang ingin ditulis sudah ada; muat ulang lalu koreksi versi terbaru.',
      409
    );
  }
  if (e.code === '42501' || /row-level security/i.test(String(e.message || ''))) {
    return recordsWrite.galat(
      recordsWrite.KODE.RECORD_NOT_PERMITTED,
      'Instansi tidak berwenang menulis record ini.',
      403
    );
  }
  return e;
}

/**
 * Anchor SATU record, lalu tandai baris outbox-nya (F3.4 lanjutan).
 *
 * Dua mode:
 *   - SINKRON (bawaan): tunggu receipt, tandai `anchored`. Dipakai jalur tulis
 *     ber-kunci instansi (`POST /api/v1/records`), yang volumenya terkendali.
 *   - KILAT (`opsi.kilat`): siarkan lalu balas `status: 'submitted'` TANPA
 *     menunggu receipt. Baris outbox menyimpan `tx_hash` sambil TETAP `pending`;
 *     worker/cron memeriksa receipt lalu menandainya `anchored`. Dipakai form
 *     publik (`POST /api/submit`) supaya balasan cepat, tetap per input.
 *
 * Anchor bersifat "advisory": kegagalan chain TIDAK menggagalkan penulisan.
 * Record dan baris outbox sudah commit; yang tersisa hanyalah menandai. Bila
 * gagal, baris tetap `pending` dan worker (`tools/worker-anchor.js`) akan
 * menyapunya nanti.
 *
 * @param {object} opsi `{ kilat }`
 * @returns {Promise<{status:string, tx_hash?:string, error?:string}>}
 */
async function anchorkanRecordDb(ringkas, meta, opsi) {
  const kilat = !!(opsi && opsi.kilat);
  const hasil = await anchorRecord.anchorkan({
    record_id: ringkas.record_id,
    version: ringkas.version,
    commitment: ringkas.commitment,
    jenis_sasaran: meta && meta.jenis_sasaran,
    supersedes_id: ringkas.supersedes_id,
    old_record_id: meta && meta.old_record_id,
    old_version: meta && meta.old_version,
  }, undefined, { kilat });

  if (!hasil.ok) {
    return { status: 'pending', error: hasil.error || null };
  }

  // Penanda outbox dijalankan peran `operator`: policy chain_outbox_operator_only
  // mengizinkan UPDATE, sementara INSERT-nya tadi dilakukan peran `agency`/`operator`.
  // Kegagalan di sini tidak fatal -- anchor on-chain sudah terjadi/disiarkan.
  if (kilat && hasil.belum_konfirmasi) {
    // Disiarkan tapi belum terkonfirmasi: simpan tx_hash, biarkan `pending`.
    await db.transaksi({ role: 'operator' }, async (client) => {
      await client.query(
        'UPDATE chain_outbox SET tx_hash = $1, last_error = NULL' +
        " WHERE record_id = $2 AND version = $3 AND chain_status = 'pending'",
        [hasil.tx_hash, ringkas.record_id, ringkas.version]
      );
    }).catch(() => {});
    return { status: 'submitted', tx_hash: hasil.tx_hash };
  }

  await db.transaksi({ role: 'operator' }, async (client) => {
    await client.query(
      "UPDATE chain_outbox SET chain_status = 'anchored', tx_hash = $1," +
      ' anchored_at = now(), last_error = NULL' +
      " WHERE record_id = $2 AND version = $3 AND chain_status = 'pending'",
      [hasil.tx_hash, ringkas.record_id, ringkas.version]
    );
  }).catch(() => {});

  return { status: 'anchored', tx_hash: hasil.tx_hash };
}

// Pasang implementasi sungguhan sebagai bawaan titik suntik anchor.
anchorkanRecord = anchorkanRecordDb;

/**
 * Catat satu kiriman form publik sebagai `records` + `chain_outbox` (F3.3),
 * lalu ANCHOR per input mode KILAT (F3.4 hybrid).
 *
 * Form tidak membawa kunci instansi, jadi penulisan berjalan peran `operator`
 * dengan `institution_id` = instansi operator yang di-seed
 * (`tools/seed-operator.js`). Penulisan dan panggilan chain DIPISAH: baris
 * `records` + `chain_outbox` di-COMMIT lebih dulu, baru anchor dijalankan --
 * panggilan RPC tidak boleh terjadi di dalam transaksi database yang terbuka
 * (bisa lambat).
 *
 * Mode KILAT: transaksi disiarkan (dapat `tx_hash`) lalu dibalas `submitted`
 * TANPA menunggu receipt ~12 detik. Baris outbox menyimpan `tx_hash` sambil
 * TETAP `pending`; worker/cron memeriksa receipt lalu menandainya `anchored`
 * (idempoten: outbox di-update dengan penjaga `chain_status`). Bila siaran
 * gagal, baris tetap `pending` tanpa `tx_hash` dan worker menyapunya nanti.
 *
 * Selalu mengembalikan objek ringkas (tidak pernah melempar untuk kondisi
 * wajar): DB tidak ada, instansi belum di-seed, atau jenis di luar taksonomi
 * hanya menghasilkan `status: 'skipped'` dengan alasan, dan penulisan Sheets
 * yang sudah sukses tetap sukses.
 *
 * @param {object} body payload form
 * @returns {Promise<{status:string, record_id?:string, commitment?:string, tx_hash?:string, error?:string, reason?:string}>}
 */
async function catatRecordForm(body) {
  if (!db.urlDatabase()) {
    return { status: 'skipped', reason: 'DB_UNAVAILABLE' };
  }
  const kunci = String(process.env.FORM_INSTITUTION_KEY || 'operator-data-center').trim();
  const { map: sectionMap } = deriveSections();

  const hasilTulis = await db.transaksi({ role: 'operator' }, async (client) => {
    const ag = (await client.query(
      'SELECT institution_key FROM agencies WHERE institution_key = $1',
      [kunci]
    )).rows[0];
    if (!ag) {
      return { skipped: true, reason: 'INSTITUTION_NOT_SEEDED', institution_key: kunci };
    }

    const rec = recordsWrite.bangunRecord({
      body,
      fieldOrder: FIELD_ORDER,
      institutionId: ag.institution_key,
      sectionMap,
      normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
      normalizeNik,
      recordId: crypto.randomUUID(),
      version: 1,
      supersedesId: null,
    });

    const jenis = rec.payload_json.jenisSasaran;
    if (!TAKSONOMI_SASARAN.has(jenis)) {
      return { skipped: true, reason: 'JENIS_UNKNOWN', jenis: jenis || null };
    }

    const { columns, values } = recordsWrite.kolomDanNilai(rec, FIELD_ORDER, 'form-publik');
    const tempat = values.map((_, i) => '$' + (i + 1)).join(', ');
    await client.query(
      'INSERT INTO records (' + columns.join(', ') + ') VALUES (' + tempat + ')',
      values
    );

    const outbox = recordsWrite.barisOutbox(rec, ag.institution_key);
    await client.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
      ' VALUES ($1, $2, $3, $4)',
      [outbox.record_id, outbox.version, outbox.supersedes_id, outbox.commitment]
    );

    return {
      record_id: rec.record_id,
      version: 1,
      commitment: outbox.commitment,
      jenis_sasaran: jenis,
      supersedes_id: null,
    };
  });

  if (hasilTulis && hasilTulis.skipped) {
    return { status: 'skipped', reason: hasilTulis.reason, institution_key: hasilTulis.institution_key, jenis: hasilTulis.jenis };
  }

  // Anchor per input mode KILAT, di LUAR transaksi tulis yang sudah commit:
  // transaksi disiarkan lalu dibalas cepat (`submitted`), finalisasi (`anchored`)
  // oleh worker/cron yang memeriksa receipt.
  let anchor;
  try {
    anchor = typeof anchorkanRecord === 'function'
      ? await anchorkanRecord(hasilTulis, { jenis_sasaran: hasilTulis.jenis_sasaran }, { kilat: true })
      : { status: 'pending', error: 'ANCHOR_DISABLED' };
  } catch (e) {
    anchor = { status: 'pending', error: e && e.message ? e.message : String(e) };
  }

  return {
    status: anchor.status || 'pending',
    record_id: hasilTulis.record_id,
    commitment: hasilTulis.commitment,
    tx_hash: anchor.tx_hash || null,
    error: anchor.error || null,
  };
}

// Pasang implementasi sungguhan sebagai bawaan titik suntik.
catatFormAudit = catatRecordForm;

app.post('/api/v1/records', async (req, res) => {
  try {
    if (!db.urlDatabase()) {
      accessLog.tandai(res, { kode: 'DB_UNAVAILABLE' });
      res.status(503).json({
        success: false,
        code: 'DB_UNAVAILABLE',
        message: 'Jalur tulis membutuhkan PostgreSQL; DATABASE_URL belum diset.',
      });
      return;
    }

    // Kuota lebih dulu, seperti Query API: verifikasi sebelum kuota sudah
    // dijamin middleware autentikasi.
    const { agencyId, hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyId, hasil);
      return;
    }

    const identitas = agencyIdDari(req);
    const agencyIdNum = Number(identitas.agencyId);
    if (!identitas.terverifikasi || !Number.isInteger(agencyIdNum) || agencyIdNum <= 0) {
      accessLog.tandai(res, { result: accessLog.HASIL.DENIED_AUTH, kode: 'AUTH_REQUIRED' });
      res.status(401).json({
        success: false,
        code: 'AUTH_REQUIRED',
        message: 'Jalur tulis memerlukan kunci API instansi yang valid.',
      });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw recordsWrite.galat(
        recordsWrite.KODE.INVALID_PARAM,
        'Body harus objek JSON berisi field form.',
        400
      );
    }

    // Bentuk permintaan ditolak sebelum database disentuh.
    const kontrol = recordsWrite.parseKontrol(body);
    if (kontrol.error) throw kontrol.error;

    // Kolom wajib (FR-3.2). Daftar ini dari `WAJIB` di lib/backfill.js, jadi
    // sama dengan yang ditegakkan DDL -- bukan daftar kedua yang bisa
    // menyimpang.
    const primer = recordsWrite.validasi(body, normalizeNik);
    if (primer.errors.length > 0) {
      const e = recordsWrite.galat(
        recordsWrite.KODE.VALIDATION_FAILED,
        'Data tidak lengkap atau tidak valid.',
        400
      );
      e.fields = primer.errors.map((x) => x.field);
      throw e;
    }

    accessLog.tandai(res, {
      actorId: agencyIdNum,
      actorType: 'agency',
      category: String(body.jenisSasaran || accessLog.KATEGORI_SEMUA),
      params: kontrol.mode === 'correct'
        ? { record_id: kontrol.recordId, version: kontrol.supersededVersion }
        : undefined,
    });

    const { map: sectionMap } = deriveSections();

    // Metadata untuk anchor on-chain; diisi di dalam transaksi, dipakai setelah
    // commit (panggilan RPC tidak boleh berjalan di dalam transaksi DB terbuka).
    let metaRantai = null;

    // Seluruh penulisan berjalan sebagai peran `agency` dengan klaim instansi
    // pemanggil, jadi RLS `records_agency_insert` menegakkan kepemilikan
    // (institution_id) sekaligus hibah kategori/wilayah di lapisan database.
    const ringkas = await db.transaksi({ role: 'agency', agency_id: agencyIdNum }, async (client) => {
      const barisAgency = (await client.query(
        'SELECT institution_key, status FROM agencies WHERE id = $1',
        [agencyIdNum]
      )).rows[0];
      if (!barisAgency) {
        throw recordsWrite.galat(recordsWrite.KODE.AGENCY_UNKNOWN, 'Instansi tidak ditemukan.', 403);
      }
      if (barisAgency.status !== 'active') {
        throw recordsWrite.galat(recordsWrite.KODE.AGENCY_INACTIVE, 'Instansi tidak aktif.', 403);
      }

      const recordId = kontrol.mode === 'create' ? crypto.randomUUID() : kontrol.recordId;
      const rec = recordsWrite.bangunRecord({
        body,
        fieldOrder: FIELD_ORDER,
        institutionId: barisAgency.institution_key,
        sectionMap,
        normalizeSasaran: (v) => NORMALIZE_SASARAN[String(v).trim().toLowerCase()] || v,
        normalizeNik,
        recordId,
        version: 1,
        supersedesId: null,
      });

      const jenis = rec.payload_json.jenisSasaran;
      if (!jenis) {
        throw recordsWrite.galat(
          recordsWrite.KODE.JENIS_UNKNOWN,
          'jenisSasaran tidak dipetakan ke taksonomi.',
          400
        );
      }

      // FR-4.2 + FR-4.17: penolakan eksplisit sebelum INSERT supaya klien tahu
      // pembatasan mana yang bekerja. RLS mengulang pemeriksaan ini.
      const kat = await client.query(
        'SELECT 1 FROM agency_categories WHERE agency_id = $1 AND jenis_sasaran = $2',
        [agencyIdNum, jenis]
      );
      if (!kat.rows[0]) {
        throw recordsWrite.galat(
          recordsWrite.KODE.CATEGORY_NOT_GRANTED,
          'Instansi tidak berhak atas kategori "' + jenis + '".',
          403
        );
      }
      const adaScope = await client.query(
        'SELECT 1 FROM agency_desa_scope WHERE agency_id = $1 LIMIT 1',
        [agencyIdNum]
      );
      if (adaScope.rows[0]) {
        const cocok = await client.query(
          'SELECT 1 FROM agency_desa_scope WHERE agency_id = $1' +
          ' AND nama_kecamatan IS NOT DISTINCT FROM $2' +
          ' AND nama_desa IS NOT DISTINCT FROM $3 LIMIT 1',
          [agencyIdNum, rec.payload_json.namaKecamatan || '', rec.payload_json.namaDesa || '']
        );
        if (!cocok.rows[0]) {
          throw recordsWrite.galat(
            recordsWrite.KODE.DESA_NOT_GRANTED,
            'Instansi tidak berhak atas wilayah desa ini.',
            403
          );
        }
      }

      // FR-3.4: koreksi menunjuk versi yang digantikan. Baris lamanya dibaca
      // lebih dulu untuk mengambil `id` (yang menjadi `supersedes_id`) dan
      // untuk menolak koreksi ke versi yang tidak ada/tidak terlihat.
      if (kontrol.mode === 'correct') {
        const lama = (await client.query(
          'SELECT id, version FROM records WHERE record_id = $1 AND version = $2',
          [kontrol.recordId, kontrol.supersededVersion]
        )).rows[0];
        if (!lama) {
          throw recordsWrite.galat(
            recordsWrite.KODE.RECORD_NOT_FOUND,
            'Record versi ' + kontrol.supersededVersion + ' tidak ditemukan atau tidak dapat diakses.',
            404
          );
        }
        rec.version = Number(lama.version) + 1;
        rec.supersedes_id = Number(lama.id);
      }

      const { columns, values } = recordsWrite.kolomDanNilai(rec, FIELD_ORDER, 'agency:' + agencyIdNum);
      const tempat = values.map((_, i) => '$' + (i + 1)).join(', ');
      try {
        await client.query(
          'INSERT INTO records (' + columns.join(', ') + ') VALUES (' + tempat + ')',
          values
        );
      } catch (e) {
        throw galatTulisDariPg(e);
      }

      // F3.3 (FR-3.6): enqueue outbox dalam transaksi yang SAMA dengan INSERT
      // records, jadi keduanya berkomitmen bersama atau tidak sama sekali.
      //
      // Sengaja INSERT polos, BUKAN `ON CONFLICT DO NOTHING`: UNIQUE
      // (record_id, version) pada chain_outbox adalah idempotency key (AT-05),
      // dan menerapkan ON CONFLICT berarti PostgreSQL harus MEMBACA baris yang
      // sudah ada untuk menyelesaikan arbiter -- tanpa policy SELECT untuk
      // agency, pembacaan itu ditolak RLS (42501). Duplikat outbox tidak
      // mungkin datang dari route ini: retry koreksi akan berhenti lebih dulu
      // di UNIQUE records (VERSION_CONFLICT), dan create selalu memakai
      // record_id baru. Kalau UNIQUE outbox terpaksa menolak, itu galat nyata
      // yang harus terlihat, bukan dimakan diam-diam.
      const outbox = recordsWrite.barisOutbox(rec, barisAgency.institution_key);
      await client.query(
        'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
        ' VALUES ($1, $2, $3, $4)',
        [outbox.record_id, outbox.version, outbox.supersedes_id, outbox.commitment]
      );

      metaRantai = {
        jenis_sasaran: rec.payload_json.jenisSasaran,
        old_record_id: kontrol.mode === 'correct' ? kontrol.recordId : null,
        old_version: kontrol.mode === 'correct' ? kontrol.supersededVersion : null,
      };

      return {
        record_id: rec.record_id,
        version: rec.version,
        supersedes_id: rec.supersedes_id,
        record_hash: rec.record_hash,
        commitment: outbox.commitment,
      };
    });

    // Anchor sinkron: setelah commit, di luar transaksi. Kegagalannya tidak
    // menggagalkan penulisan (lihat `anchorkanRecordDb`).
    const anchorRingkas = await anchorkanRecord(ringkas, metaRantai);

    const status = kontrol.mode === 'create' ? 201 : 200;
    accessLog.tandai(res, { result: accessLog.HASIL.SUKSES, responseRows: 1 });
    res.status(status).json(Object.assign({ success: true }, ringkas, { anchor: anchorRingkas }));
  } catch (error) {
    kirimGalat(res, error);
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    // FR-4.5: kuota dulu, seperti /api/sasaran. Route ini sengaja masuk
    // JALUR_PUBLIK (TPK tidak bisa menyimpan kunci), jadi TANPA baris ini
    // penulisan akan terbuka lebar tanpa jatah sama sekali -- dan penulisan
    // mengisi Google Sheets, bukan sekali baca. Kuotanya memakai kunci bersama
    // 'publik' karena pengirim form tidak punya identitas instansi.
    const { agencyId, hasil } = terapkanRateLimit(req, res);
    if (!hasil.allowed) {
      kirimRateLimit(res, agencyId, hasil);
      return;
    }

    const body = req.body || {};
    const errors = validate(body);

    // FR-4.4: pencatatan dan pembacaan masuk log akses yang sama. Kategori
    // diambil dari `jenisSasaran` mentah, bukan dari nilai yang sudah
    // dinormalisasi: kalau normalisasi menolak atau memetakan ke luar
    // taksonomi, yang perlu terlihat di log adalah apa yang benar-benar
    // dikirim, bukan apa yang dianggap diterima.
    accessLog.tandai(res, {
      actorType: 'operator',
      category: String((body && body.jenisSasaran) || accessLog.KATEGORI_SEMUA),
      params: paramsAkses(req, 'json', null),
    });

if (errors.length > 0) {
      accessLog.tandai(res, { result: accessLog.HASIL.ERROR, params: Object.assign({}, res.locals.accessLog.params, { fields_invalid: errors.length }) });
      return res.status(400).json({ success: false, message: `Data tidak lengkap atau tidak valid: ${errors.join(', ')}`, errors });
    }

    // Build row data for Sheets (async flush)
    const no = await nextNumberPlaceholder();
    const rowData = [no, ...buildRow(body)];

    // Simpan ke sheets_pending (async flush ke Sheets via cron)
    if (db.urlDatabase()) {
      try {
        await db.transaksi({ role: 'operator' }, async (client) => {
          await client.query(
            `INSERT INTO sheets_pending (payload_json, row_data) VALUES ($1, $2)`,
            [JSON.stringify(body), JSON.stringify(rowData)]
          );
        });
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Gagal simpan sheets_pending:`, e.message);
      }
    }

    // Per-input audit: catat `records` + `chain_outbox` + anchor hybrid (kilat).
    // Respons memuat `status: 'submitted'` + tx_hash; finalisasi `anchored` oleh
    // worker/cron. Bila siaran gagal, baris tetap `pending` dan worker/cron
    // menyapunya nanti.
    let auditForm;
    try {
      auditForm = typeof catatFormAudit === 'function'
        ? await catatFormAudit(body)
        : { status: 'skipped', reason: 'DISABLED' };
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Gagal mencatat record form:`, e.message);
      auditForm = { status: 'error' };
    }

    accessLog.tandai(res, { result: accessLog.HASIL.SUKSES, responseRows: 1 });
    res.status(200).json({
      success: true,
      message: 'Data berhasil disimpan ke Google Sheets',
      anchor: auditForm,
    });
  } catch (error) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'INTERNAL_ERROR' });
    console.error(`[${new Date().toISOString()}] Gagal menyimpan data:`, error.message);
    res.status(500).json({ success: false, message: `Gagal menyimpan data ke Google Sheets: ${error.message}` });
  }
});

// Penyapu outbox per-record untuk lingkungan serverless, tempat tidak ada
// proses pekerja yang hidup terus. Vercel Cron memanggil GET /api/cron/anchor
// berkala (lihat `crons` di vercel.json); satu panggilan = satu pass worker.
// Batch dibatasi kecil supaya muat dalam batas durasi fungsi.
async function sapuAnchorDb(batas) {
  const worker = require('./tools/worker-anchor.js');
  return worker.sekali({ batas: batas });
}
sapuAnchor = sapuAnchorDb;

app.get('/api/cron/anchor', async (req, res) => {
  // Vercel Cron menyisipkan `Authorization: Bearer <CRON_SECRET>` bila variabel
  // lingkungan CRON_SECRET diset. Bila TIDAK diset, endpoint MENOLAK: endpoint
  // yang menyiarkan transaksi berbayar tidak boleh terbuka hanya karena env lupa
  // diisi. Ini juga menutup penyalahgunaan saat pengembangan.
  const rahasia = String(process.env.CRON_SECRET || '').trim();
  if (!rahasia) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'CRON_SECRET_UNSET' });
    return res.status(503).json({
      success: false,
      message: 'CRON_SECRET belum diset; endpoint cron dimatikan demi keamanan.',
    });
  }
  if (String(req.get('authorization') || '') !== 'Bearer ' + rahasia) {
    accessLog.tandai(res, { result: accessLog.HASIL.DENIED_AUTH, kode: 'CRON_UNAUTHORIZED' });
    return res.status(401).json({ success: false, message: 'Tidak berwenang.' });
  }
  if (!db.urlDatabase()) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'DB_UNAVAILABLE' });
    return res.status(503).json({ success: false, message: 'DATABASE_URL belum diset.' });
  }

  const batas = Math.max(1, Math.min(50, Number(process.env.ANCHOR_CRON_BATCH) || 5));
  try {
    const ringkasan = typeof sapuAnchor === 'function'
      ? await sapuAnchor(batas)
      : { dibaca: 0, anchored: 0, retry: 0, failed: 0, diabaikan: 0, galat: 0, rincian: [] };
    accessLog.tandai(res, { actorType: 'operator', result: accessLog.HASIL.SUKSES });
res.status(200).json({ success: true, batas, ringkasan });
  } catch (error) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'CRON_ANCHOR_ERROR' });
    console.error(`[${new Date().toISOString()}] cron anchor gagal:`, error.message);
    res.status(500).json({ success: false, message: `Penyapuan anchor gagal: ${error.message}` });
  }
});

// ============================================================================
// Cron flush async ke Google Sheets (GET /api/cron/sheets-flush)
// Dipanggil berkala oleh Vercel Cron (lihat vercel.json). Butuh CRON_SECRET.
// ============================================================================
app.get('/api/cron/sheets-flush', async (req, res) => {
  const rahasia = String(process.env.CRON_SECRET || '').trim();
  if (!rahasia) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'CRON_SECRET_UNSET' });
    return res.status(503).json({
      success: false,
      message: 'CRON_SECRET belum diset; endpoint cron dimatikan demi keamanan.',
    });
  }
  if (String(req.get('authorization') || '') !== 'Bearer ' + rahasia) {
    accessLog.tandai(res, { result: accessLog.HASIL.DENIED_AUTH, kode: 'CRON_UNAUTHORIZED' });
    return res.status(401).json({ success: false, message: 'Tidak berwenang.' });
  }
  if (!db.urlDatabase()) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'DB_UNAVAILABLE' });
    return res.status(503).json({ success: false, message: 'DATABASE_URL belum diset.' });
  }

  try {
    const worker = require('./tools/worker-sheets.js');
    const batch = Math.max(1, Math.min(100, Number(process.env.SHEETS_FLUSH_BATCH) || 50));
    const ringkasan = await worker.flushOnce({ batch });
    accessLog.tandai(res, { actorType: 'operator', result: accessLog.HASIL.SUKSES });
    res.status(200).json({ success: true, batch, ringkasan });
  } catch (error) {
    accessLog.tandai(res, { result: accessLog.HASIL.ERROR, kode: 'CRON_SHEETS_ERROR' });
    console.error(`[${new Date().toISOString()}] cron sheets-flush gagal:`, error.message);
    res.status(500).json({ success: false, message: `Penyapuan Sheets gagal: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}

module.exports = app;

// Metadata skema diekspor agar generator DDL (tools/generate-schema.js) memakai
// satu sumber kebenaran dengan aplikasi. Menempelkan pada objek app menjaga
// module.exports tetap berbentuk Express app untuk konsumen yang sudah ada.
module.exports.FIELD_ORDER = FIELD_ORDER;
module.exports.LABELS = LABELS;
module.exports.REF_FIELDS = REF_FIELDS;
module.exports.NORMALIZE_SASARAN = NORMALIZE_SASARAN;

// Diekspor supaya uji round-trip (F1.9) memakai jalur tulis yang sama persis
// dengan produksi, bukan salinan yang bisa ikut menyimpang tanpa ketahuan.
module.exports.HEADERS = HEADERS;
module.exports.buildRow = buildRow;
module.exports.tombol = tombol;
module.exports.normalizeNik = normalizeNik;

// Diekspor untuk uji F1.12. Fungsinya murni, tanpa I/O, jadi bisa diuji tanpa
// Google Sheets.
module.exports.FIELDS_SASARAN = FIELDS_SASARAN;
module.exports.headerToIndex = headerToIndex;
module.exports.looksLikeHeaderRow = looksLikeHeaderRow;
module.exports.pickField = pickField;

// Jalur output baris data (FR-4.20a/b) diekspor agar diuji langsung, bukan
// lewat server yang harus hidup. Uji yang benar-benar memanggil HTTP memerlukan
// port dan proses terpisah; yang diuji di sini adalah keputusan kolomnya, dan
// itu yang perlu dijaga.
module.exports.parseFields = parseFields;
module.exports.parseFormat = parseFormat;
module.exports.selCsv = selCsv;
module.exports.kirimBaris = kirimBaris;
module.exports.kirimGalat = kirimGalat;
module.exports.validasiPermintaan = validasiPermintaan;
module.exports.limiter = limiter;
module.exports.agencyIdDari = agencyIdDari;
module.exports.terapkanRateLimit = terapkanRateLimit;
module.exports.spyGetSheets = (fn) => { hitungSumberData = fn; };
// Menggantikan jawaban getSheets (bukan sekadar menghitung panggilan).
// Ini yang membuat POST /api/submit bisa diuji end-to-end tanpa jaringan.
module.exports.setSheets = setSheets;
// Mengaktifkan verifikasi kunci API dengan fungsi pencarian. Sengaja eksplisit:
// menyalakan atau mematikan autentikasi tidak boleh terjadi karena variabel
// lingkungan yang ada/tidak ada.
module.exports.setCariKunci = (fn) => { cariKunci = fn; };
// Titik suntik per-input audit jalur form. `null` mematikannya, supaya uji
// /api/submit sukses tidak menulis ke PostgreSQL meski DATABASE_URL diset.
module.exports.setCatatFormAudit = (fn) => { catatFormAudit = fn; };
// Titik suntik anchor sinkron POST /api/v1/records. Stub `async () => ({ status:
// 'pending', error: '...' })` mematikan penyiaran nyata tanpa mengubah bentuk
// respons.
module.exports.setAnchorkanRecord = (fn) => { anchorkanRecord = fn; };
// Titik suntik penyapu outbox endpoint cron. `null` mengembalikan ringkasan kosong
// (tanpa menyentuh database/chain), supaya uji kendali CRON_SECRET tidak menyiarkan.
module.exports.setSapuAnchor = (fn) => { sapuAnchor = fn; };
module.exports.autentikasi = autentikasi;
module.exports.kunciKuota = kunciKuota;
module.exports.PERINGATAN_LEGACY = PERINGATAN_LEGACY;

// F3.9. Logger log akses ditukar agar uji bisa menangkap entri tanpa menulis
// ke stdout dan tanpa database. Yang ditukar hanya logger; middleware-nya tetap
// terpasang, jadi "setiap respons punya entri" tetap diuji melalui HTTP sungguhan.
//
// Argumennya LOGGER itu sendiri, bukan fungsi yang menghasilkannya. Middleware
// sudah membungkus `accessLogger` dalam provider, jadi membungkus lagi di sini
// akan membuat `ambilLogger()` mengembalikan fungsi yang tidak punya `.catat` --
// dan gejalanya muncul sebagai "entri dilewati" pada request pertama, jauh dari
// tempat kesalahannya.
module.exports.gantiAccessLogger = (loggerBaru) => {
  accessLogger = loggerBaru;
  return accessLogger;
};
module.exports.accessLog = accessLog;
module.exports.db = db;
