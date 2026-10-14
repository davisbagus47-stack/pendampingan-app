'use strict';

/**
 * Gerbang tunggal koneksi PostgreSQL untuk aplikasi (F1.8a, F3.9).
 *
 * Satu aturan yang menentukan bentuk berkas ini: APLIKASI TIDAK PERNAH
 * BERBICARA KEPADA DATABASE SEBAGAI PERAN KONEKSI. Koneksi memakai `postgres`
 * (di Supabase, ini satu-satunya peran yang boleh login), lalu setiap
 * transaksi menurunkan ke `app_api` melalui `SET LOCAL ROLE`. Satu URL, satu
 * rahasia, dan tidak ada peran kedua di berkas konfigurasi yang bisa lupa
 * diturunkan -- persis alasan yang dicatat di `tools/db-setup.js`.
 *
 * Semua yang dijalankan lewat `transaksi()` berjalan di bawah RLS yang
 * sesungguhnya. Kebenaran yang diuji `tools/db-setup.js` (peran efektif
 * bukan superuser/BYPASSRLS) berlaku di sini juga; targetnya sama, dan klien
 * yang sama, jadi tidak tercipta celah "uji jalan di sini, produksi lewat
 * sana".
 */

const BAWAAN = {
  PERAN: process.env.DB_ROLE || 'app_api',
  // Batas koneksi sengaja kecil: PoC memakai pooler Session, dan 10 koneksi
  // sudah jauh di atas 60 permintaan/menit per instansi.
  MAKS_KONEKSI: Number.isFinite(Number(process.env.DB_POOL_MAX)) ? Number(process.env.DB_POOL_MAX) : 10,
  BUKA_TIMEOUT: Number.isFinite(Number(process.env.DB_BUKA_TIMEOUT)) ? Number(process.env.DB_BUKA_TIMEOUT) : 5000,
};

let pg = null;
let pool = null;
let pemuatan = null;

/**
 * Muat `pg` sekali dan masukkan hasilnya ke `pg`. Malas dan cache:
 * `pg` tidak dibutuhkan kalau `DATABASE_URL` kosong (aplikasi masih jalan
 * dengan Google Sheets saja), dan memuatnya di setiap pemanggilan akan
 * membuat Node mem-parsing modul itu berulang.
 */
function muatPg() {
  if (pg) return pg;
  if (!pemuatan) {
    pemuatan = new Promise((resolve, reject) => {
      try {
        pg = require('pg');
        resolve(pg);
      } catch (e) {
        pg = null;
        pemuatan = null;
        reject(e);
      }
    });
  }
  return pemuatan;
}

/**
 * URL database, atau null.
 *
 * Dipisah supaya pemanggil bisa memutuskan apakah akan memakai sink database
 * tanpa perlu mencoba koneksi. Cek dilakukan di titik ini, bukan di tengah
 * alur menulis log.
 */
function urlDatabase() {
  return process.env.DATABASE_URL || null;
}

/**
 * Buat pool pertama kali dan cache. Dipanggil di titik koneksi pertama, bukan
 * saat berkas dimuat -- proses yang tidak pernah menulis database tidak perlu
 * memegang koneksi.
 *
 * @returns {Promise<Pool>}
 */
async function bukaPool() {
  if (pool) return pool;
  const pgModul = await muatPg();
  const url = urlDatabase();
  if (!url) throw new Error('DATABASE_URL belum diset');
  pool = new pgModul.Pool({
    connectionString: url,
    max: BAWAAN.MAKS_KONEKSI,
    connectionTimeoutMillis: BAWAAN.BUKA_TIMEOUT,
    idleTimeoutMillis: 30000,
  });
  // Kegagalan koneksi yang tidak tertangkap pada klien idle mematikan proses.
  pool.on('error', () => {
    // Dilaporkan lewat status; menuliskannya ke stderr setiap kali akan
    // mengisi log dengan hal yang sama berulang.
  });
  return pool;
}

/** Tutup pool dari luar, misalnya saat pengujian atau penutupan server. */
async function matikan() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

/**
 * Jalankan `fn(client)` dalam satu transaksi sebagai peran aplikasi.
 *
 * Urutan di dalam transaksi tidak bebas:
 *   1. `SET LOCAL ROLE` dulu, baru `SET LOCAL request.jwt.claims`. Nilai
 *      klaim hanya bermakna untuk peran aplikasi, dan `SET LOCAL ROLE`
 *      mereset state sesi lain yang mungkin dibawa klien.
 *   2. `fn` dijalankan, lalu `COMMIT`. Galat apa pun memutar kembali dan
 *      diteruskan -- pemanggil yang memutuskan apakah galat itu fatal.
 *
 * `klaim` boleh null (tanpa identitas: peran anon). Pemanggil TIDAK boleh
 * memakai ini untuk menaikkan hak; ia hanya memilih identitas yang akan
 * dilihat RLS, dan `SET ROLE` tetap membatasinya ke `app_api`.
 *
 * @param {object|null} [klaim] identitas yang dilihat RLS
 * @param {function} fn `async (client) => ...`
 * @returns {Promise<*>} nilai balik `fn`
 */
async function transaksi(klaim, fn) {
  const p = await bukaPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE "' + BAWAAN.PERAN.replace(/"/g, '""') + '"');
    // `SET LOCAL` hanya dijalankan bila ada klaim; kosong membuat JSON string
    // ganda (`''''`) yang diterjemahkan jadi satu karakter kutip -- bukan JSON
    // kosong, dan query apa pun yang membaca claims lalu meng-cast ke json
    // langsung gagal "invalid input syntax for type json".
    if (klaim && typeof klaim === 'object') {
      const nilai = JSON.stringify(klaim).replace(/'/g, "''");
      await client.query("SET LOCAL request.jwt.claims = '" + nilai + "'");
    }
    const hasil = await fn(client);
    await client.query('COMMIT');
    return hasil;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Sink access_log untuk `lib/access-log.js`.
 *
 * Bentuknya sink: menerima satu entri, mengembalikan Promise, dan KEGAGALAN
 * DITERUSKAN ke logger -- logger itulah yang menahan entri dan mencoba ulang
 * (kegagalan asinkron di-retry sampai `maksCoba`, sinkron langsung dianggap
 * hilang). Sink tidak boleh menelan kegagalannya sendiri, kalau tidak
 * `GET /api/audit/status` tidak akan pernah melihat `dibuang > 0`.
 *
 * Kolom dicocokkan EKSPLISIT satu-satu, bukan `INSERT ... SELECT *`. Urutan
 * kolom DDL bisa berubah tanpa mengubah kontrak ini.
 *
 * @param {object} entri entri dari `bangunEntri`
 * @returns {Promise<void>}
 */
async function sinkAccessLog(entri) {
  const e = entri || {};
  return transaksi(null, async (client) => {
    await client.query(
      'INSERT INTO access_log (actor_type, actor_id, category, params, result,' +
      ' response_rows, ip, endpoint)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        e.actor_type || null,
        e.actor_id === undefined || e.actor_id === null ? null : Number(e.actor_id),
        e.category === undefined || e.category === null ? null : String(e.category),
        e.params === undefined || e.params === null ? {} : e.params,
        e.result || null,
        Number.isFinite(Number(e.response_rows)) ? Math.floor(Number(e.response_rows)) : 0,
        // Kolom INET lenient; nilai yang bukan alamat (local jaringan, hostname)
        // diubah null supaya INSERT tidak gagal pada satu entri yang menyeret
        // antrean di belakangnya.
        validasiIp(e.ip),
        e.endpoint || null,
      ]
    );
  });
}

/** INET bernilai tunggal: IPv4 atau IPv6, tanpa netmask. */
function validasiIp(nilai) {
  if (nilai === undefined || nilai === null) return null;
  const s = String(nilai).trim();
  if (s === '') return null;
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(s)) {
    const ok = s.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
    return ok ? s : null;
  }
  if (s.indexOf(':') >= 0 && /^[0-9a-fA-F:]+$/.test(s)) {
    return s;
  }
  return null;
}

/**
 * Cari baris kunci dari hash (F3.10a).
 *
 * Ini bentuk yang diharapkan `lib/api-key-auth.js` sebagai `o.cariKunci`:
 * `async (hash) => baris atau null`. Pencarian dilakukan lewat fungsi
 * `cari_kunci(hash)` di database -- SECURITY DEFINER, jadi pembacaan tabel
 * `agency_api_keys` (yang punya RLS operator/admin) bisa terjadi SEBELUM
 * identitas pemanggil diketahui. Tanpa itu sistem terjebak: verifikasi yang
 * butuh identitas untuk membaca kunci, dan identitas yang butuh kunci untuk
 * diverifikasi.
 *
 * Panggil lewat `transaksi(null, ...)` karena klaim kosong: pada titik ini
 * klaim memang belum ada, dan `cari_kunci` sendiri yang menjadi jembatan.
 *
 * @param {string} hash SHA-256 hex dari token tanpa prefix
 * @returns {Promise<object|null>} baris kunci, atau null kalau tidak cocok
 */
async function cariKunci(hash) {
  if (!hash || typeof hash !== 'string') return null;
  return transaksi(null, async (client) => {
    const res = await client.query('SELECT * FROM cari_kunci($1)', [hash]);
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      agency_id: r.agency_id,
      status: r.status,
      category: r.category,
      table_name: r.table_name,
      key_prefix: r.key_prefix,
    };
  });
}

/**
 * Status koneksi untuk `GET /api/audit/status`.
 *
 * `idle`/`waiting` dibaca dari pool (kalau sudah dibuka). Jangan memicu
 * koneksi dari sini -- endpoint status tidak boleh membuat efek samping.
 */
function status() {
  const url = urlDatabase();
  return {
    url: url ? ramahUrl(url) : null,
    terpasang: !!pg && !!pool,
    peran: BAWAAN.PERAN,
    pool: pool
      ? { total: pool.totalCount, idle: pool.idleCount, menunggu: pool.waitingCount }
      : null,
  };
}

/** Sembunyikan kredensial dari URL untuk tampilan. */
function ramahUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch (e) {
    return url;
  }
}

module.exports = {
  urlDatabase,
  transaksi,
  sinkAccessLog,
  cariKunci,
  status,
  matikan,
  validasiIp,
  BAWAAN,
};