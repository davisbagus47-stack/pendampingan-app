/**
 * Verifikasi kredensial API instansi (F3.10a).
 *
 * Modul ini murni: ia tidak tahu apa itu database, hanya tahu bentuk
 * jawaban yang dia AMAZE dari `cariKunci`. Itu disengaja -- logika verifikasi
 * adalah tempat yang paling mudah salah diam-diam, dan logika yang bisa diuji
 * tanpa PostgreSQL bisa diuji dengan benar.
 *
 * ---------------------------------------------------------------------------
 * Dua hal yang paling mudah rusak di sini
 * ---------------------------------------------------------------------------
 *
 * 1. Kunci `standby` dan kunci `revoked` harus ditolak dengan alasan yang
 *    BERBEDA di log, padahal responsnya sama-sama 401. Kalau keduanya hanya
 *    "gagal", operator tidak akan pernah tahu kalau kunci yang dicabut masih
 *    dipakai klien -- dan itu justru informasi paling penting saat insiden.
 *    Karena itu `alasan` dikembalikan terpisah dari kode HTTP.
 *
 * 2. Verifikasi harus terjadi SEBELUM kuota dihitung. Kalau tidak, penyerang
 *    bisa mengirim kunci dicabut lalu memakai jatah-kuota instansi orang lain
 *    atau sebaliknya. Urutan di `pasang()` mengunci ini.
 */

const crypto = require('crypto');

const PREFIX_TOKEN = 'pa_sk_live_';

/** Kode mesin untuk setiap cara gagal. dippedakai respons DAN access_log. */
const KODE = {
  MISSING: 'MISSING_KEY',
  MALFORMED: 'MALFORMED_KEY',
  UNKNOWN: 'UNKNOWN_KEY',
  REVOKED: 'KEY_REVOKED',
  STANDBY: 'KEY_STANDBY',
  SCOPE: 'KEY_SCOPE_DENIED',
};

/**
 * Baca token dari header.
 *
 * `Authorization: Bearer <token>` adalah pilihan utama: itu standarnya, dan
 * tooling yang sudah ada (curl, Postman, axios) mengirimnya tanpa konfigurasi.
 * `x-api-key` diterima juga karena CORS-nya sederhana -- header kustom
 * memicu preflight, sementara `Authorization` tidak, jadi integrasi browser
 * butuh konfigurasi CORS tambahan. Keduanya dibaca supaya tidak perlu
 * memutuskan sekarang, tapi hanya satu yang dipakai.
 *
 * Mengembalikan null kalau tidak ada sama sekali, bukan string kosong: "tidak
 * kirim" dan "kirim yang salah" menghasilkan pesan berbeda, dan operator lebih
 * mudah memperbaiki kalau keduanya dibedakan.
 */
function bacaToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (auth) {
    const cocok = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
    if (cocok) return cocok[1].trim();
    // Ada header tapi formatnya salah. Ini lebih berguna dilaporkan sebagai
    // MALFORMED daripada diperlakukan sebagai tidak ada: "saya kirim kredensial
    // tapi ditolak" dan "saya tidak kirim apa-apa" punya penyebab berbeda.
    return { salahFormat: true };
  }
  const apiKey = req.headers && req.headers['x-api-key'];
  if (apiKey) return String(apiKey).trim();
  return null;
}

/**
 * Bentuk token yang benar.
 *
 * Dicek sebelum hash karena hashed yang salah bentuk menghasilkan hash yang
 * salah bentuk juga, dan barisnya tidak akan pernah ketemu di database. Hash
 * dulu baru sadar "ah, formatnya bukan begini" jauh lebih lambat.
 */
function bentukValid(token) {
  return typeof token === 'string'
    && token.startsWith(PREFIX_TOKEN)
    && token.length === PREFIX_TOKEN.length + 43
    && /^[A-Za-z0-9_-]+$/.test(token.slice(PREFIX_TOKEN.length));
}

/**
 * SHA-256 dari token tanpa prefix.
 *
 * Harus sama persis dengan `tools/api-keys.js` dan `lib/access-log.js`.
 * Kalau tidak, kunci yang diterbitkan CLI tidak akan pernah dikenali server --
 * dan gejalanya adalah 401 untuk semua kunci, yang terlihat seperti bug
 * identitas, bukan bug hashing.
 */
function hashToken(token) {
  const TANPA_PREFIX = token.startsWith(PREFIX_TOKEN)
    ? token.slice(PREFIX_TOKEN.length)
    : token;
  return crypto.createHash('sha256').update(TANPA_PREFIX, 'utf8').digest('hex');
}

/**
 * Verifikasi satu token.
 *
 * @param {object} o
 * @param {object|null} o.token   hasil bacaToken
 * @param {function} o.cariKunci  async (hash) => baris kunci atau null
 * @param {string} [o.diminta]   kategori yang diminta, untuk cek scope
 * @param {string} [o.dituju]    nama tabel/endpoint yang diminta
 * @returns {Promise<object>} selalu punya `ok`; kalau gagal, punya `kode` dan
 *   `alasan` yang bisa ditulis ke log tanpa membocorkan apa yang dikoreksi.
 */
async function verifikasi(o) {
  const { token, cariKunci, diminta, dituju } = o;

  if (token === null || token === undefined) {
    return { ok: false, kode: KODE.MISSING, alasan: 'tidak ada kredensial' };
  }
  if (typeof token === 'object' && token.salahFormat) {
    return { ok: false, kode: KODE.MALFORMED, alasan: 'format Authorization bukan "Bearer <token>"' };
  }
  if (!bentukValid(token)) {
    // Bentuknya dicatat, tapi tokennya sendiri TIDAK. Token yang salah bentuk
    // masih bisa jadi token asli yang salah ketik, dan menyalinnya ke log
    // berarti menyimpan ulang kredensial di tempat yang tidak dienkripsi.
    return {
      ok: false,
      kode: KODE.MALFORMED,
      alasan: 'bentuk token tidak dikenali',
      bentuk: PREFIX_TOKEN + String(token).slice(PREFIX_TOKEN.length, PREFIX_TOKEN.length + 8),
    };
  }

  const hash = hashToken(token);
  const baris = await cariKunci(hash);

  if (!baris) {
    return { ok: false, kode: KODE.UNKNOWN, alasan: 'tidak ada kunci cocok' };
  }
  if (baris.status === 'revoked') {
    return { ok: false, kode: KODE.REVOKED, alasan: 'kunci sudah dicabut', agencyId: baris.agency_id, keyId: baris.id };
  }
  if (baris.status === 'standby') {
    // Ini pesan yang paling penting untuk ditampilkan. Kunci cadangan ada,
    // tapi belum diaktifkan -- tanpa pesan ini operator akan mengira
    // penerbitan gagal dan menerbitkan yang baru, lalu tetap tidak bisa masuk.
    return { ok: false, kode: KODE.STANDBY, alasan: 'kunci cadangan belum diaktifkan', agencyId: baris.agency_id, keyId: baris.id };
  }

  const scope = cekScope(baris, diminta, dituju);
  if (!scope.boleh) {
    // 403, bukan 401: kredensialnya BENAR, kewenangannya yang tidak cukup.
    // Bedanya penting di log -- 401 berarti masalah klien, 403 berarti
    // operatorierequest kuncinya terlalu dibatasi dan perlu kuncinya diperluas.
    return {
      ok: false,
      kode: KODE.SCOPE,
      alasan: scope.alasan,
      agencyId: baris.agency_id,
      keyId: baris.id,
      status: 403,
    };
  }

  return {
    ok: true,
    agencyId: baris.agency_id,
    keyId: baris.id,
    category: baris.category || null,
    tableName: baris.table_name || null,
    keyPrefix: baris.key_prefix,
  };
}

/**
 * Apakah kunci ini boleh menyentuh kategori/tabel yang diminta.
 *
 * NULL berarti "semua". Kalau hanya salah satu yang diisi, itu ditolak di level
 * database (constraint agency_api_keys_scope_whole), tapi dicek lagi di sini:
 * baris yang sudah terlanjur ada di database bisa berasal dari INSERT lama
 * sebelum constraint dibuat, dan yang harus menegakkan aturan adalah kode.
 *
 * `agency_categories` juga sudah mengunci `category` dengan FK majemuk, jadi
 * kategori di sini dijamin kategori yang agency itu benar-benar DAPAT. Yang dicek
 * ulang di sini adalah kecocokannya dengan permintaan -- hal yang tidak bisa
 * dilakukan constraint, karena permintaan bukan data yang tersimpan.
 */
function cekScope(baris, diminta, dituju) {
  const kat = baris.category || null;
  const tbl = baris.table_name || null;

  if (!kat && !tbl) return { boleh: true };

  if (kat) {
    // `diminta` yang null berarti TIDAK ada filter kategori, yaitu "kembalikan
    // semua kategori". Kunci yang dibatasi ke satu kategori tidak boleh
    // mendapat itu: hasilnya termasuk kategori yang tidak diizinkan, dan tidak
    // ada penyaringan di hilir yang bisa memperbaikinya.
    //
    // Menolak di sini, bukan meloloskan lalu hoped-bisa-difilter, adalah pilihan
    // yang aman ketika tidak tahu apa yang dilakukan pemanggil berikutnya.
    if (!diminta) {
      return { boleh: false, alasan: 'kunci dibatasi ke kategori ' + kat + ', permintaan tanpa filter kategori' };
    }
    if (kat !== diminta) {
      return { boleh: false, alasan: 'kunci dibatasi ke kategori ' + kat + ', diminta ' + diminta };
    }
  }
  if (tbl && dituju && tbl !== dituju) {
    return { boleh: false, alasan: 'kunci dibatasi ke ' + tbl + ', diminta ' + dituju };
  }
  return { boleh: true };
}

/**
 * Respons 401/403 dengan kode mesin.
 *
 * Pesannya sengaja tidak menyebut status kunci, hash, atau agency mana yang
 * cocok. Server bukan tempat yang tepat untuk menebak-nebak kredensial; pesan cukup
 * untuk membuat klien memperbaiki, dan rinciannya ada di log server.
 */
function kirimUnauthorized(res, hasil) {
  const status = hasil.status || 401;
  const pesan = status === 403
    ? 'Kunci API tidak berwenang untuk sumber daya ini.'
    : 'Kredensial API tidak valid.';
  res.status(status).json({
    success: false,
    code: hasil.kode,
    message: pesan,
  });
}

module.exports = {
  PREFIX_TOKEN,
  KODE,
  bacaToken,
  bentukValid,
  hashToken,
  verifikasi,
  cekScope,
  kirimUnauthorized,
};