/**
 * Uji live lib/db.js terhadap PostgreSQL sungguhan (F1.8a, F3.9).
 *
 * Berbeda dari test-db.js (murni, tanpa koneksi), suite ini butuh
 * `DATABASE_URL` dan MENULISNYA ke Supabase. Jadi ada dua keputusan desain:
 *
 *   1. Tanpa `DATABASE_URL`, suite ini DILEWATI dengan exit 0 -- regresi murni
 *      tetap hijau di lingkungan tanpa database. Tapi hasil pass-nya harus
 *      dibaca saksama: "DLEWATI" tidak pernah menjadi bukti bahwa sink menulis.
 *
 *   2. `access_log` adalah append-only (REVOKE UPDATE, DELETE dari peran
 *      aplikasi). Uji yang HANYA INSERT tanpa membersihkan akan menumpuk baris
 *      di tabel produksi setiap kali dijalankan. Maka pembuktian memakai dua
 *      lapis:
 *        - Jalur produksi sungguhan: `sinkAccessLog` INSERT sebagai `app_api`
 *          (lewat `SET LOCAL ROLE`, persis yang dipakai aplikasi), lalu
 *          dibaca ulang. Ini membuktikan hak INSERT, policy append, DAN
 *          rangkaian penyusunan transaksi.
 *        - Pembersihan lewat koneksi utama (peran `postgres`, BYPASSRLS) --
 *          satu-satunya yang diizinkan menghapus, dan bukan pengganti
 *          identitas aplikasi. Baris uji ditandai `endpoint = __uji_datalib__`
 *          supaya pembersihan tidak pernah menyentuh data lain.
 *
 *   3. Pembersihan MENGHAPUS baris `access_log`. Karena itu uji ini mengambil
 *      advisory lock bersama (tools/uji-live-lock.js) supaya tidak berjalan
 *      bersamaan dengan uji live lain yang meng-anchor seluruh `access_log` --
 *      menghapus baris di dalam prefix yang di-anchor akan merusak akarnya.
 *
 * Yang TIDAK diuji di sini (menunggu suite penerimaan server): row-level
 * isolation dan policy lain -- itu sudah diuji `db-setup.js periksa` 13/13.
 */

const db = require('../lib/db.js');
const ujiLiveLock = require('./uji-live-lock.js');

// DATABASE_URL dibaca dari .env (atau lingkungan), pola sama db-setup.js:
// dotenv dimuat malas supaya skrip tetap berjalan kalau paketnya tidak ada.
try {
  require('dotenv').config();
} catch (e) {}

let passed = 0;
let failed = 0;
let berjalan = false;

function ok(name, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }
  berjalan = true;

  // ---------------------------------------------------------------------------
  // 0. Jembatan verifikasi & pembersihan sebagai peran koneksi (postgres).
  //    Dipakai SEMPAT, lalu dilepas: aplikasi tidak pernah memakai ini.
  // ---------------------------------------------------------------------------
  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  // Serialkan dengan uji live lain (lihat tools/uji-live-lock.js): pembersihan
  // di bawah MENGHAPUS baris access_log, yang bila berada di dalam prefix yang
  // sedang di-anchor uji lain akan merusak akar mereka. Diisi di dalam try
  // supaya `finally` selalu melepas kunci.
  let peganganKunci = null;

  const tanda = '__uji_datalib__' + Date.now() + '_' + Math.floor(Math.random() * 1e6);

  try {
    peganganKunci = await ujiLiveLock.ambil(process.env.DATABASE_URL);

    // -------------------------------------------------------------------------
    // 1. Jalur produksi: sink menulis sebagai app_api.
    // -------------------------------------------------------------------------
    console.log('=== 1. sinkAccessLog menulis ke access_log via app_api ===');

    const entri = {
      actor_type: 'operator',
      actor_id: 7,
      category: 'Catin',
      params: { jenis: 'uji-live', keyBersih: '~' },
      result: 'success',
      response_rows: 3,
      ip: '203.0.113.42',
      endpoint: tanda,
    };
    let galat = null;
    try { await db.sinkAccessLog(entri); }
    catch (e) { galat = e; }
    ok('INSERT via sinkAccessLog tidak melempar', !galat, galat && galat.message);

    if (galat) throw galat;

    const cek = await utama.query(
      'SELECT actor_type, actor_id, category, params, result, response_rows,' +
      ' host(ip) AS ip, endpoint, ts,' +
      " (now() - ts) < interval '1 minute' AS ts_baru_sekarang" +
      ' FROM access_log WHERE endpoint = $1',
      [tanda]
    );
    const r = cek.rows[0];
    ok('satu baris tersimpan', cek.rows.length === 1, JSON.stringify(cek.rows));
    if (cek.rows.length === 1) {
      eqIsh(r.actor_type, entri.actor_type);
      eqIsh(String(r.actor_id), String(entri.actor_id));
      eqIsh(r.category, entri.category);
      eqIsh(r.result, entri.result);
      eqIsh(Number(r.response_rows), entri.response_rows);
      // `ip` diketik INET dan dinormalisasi ke bentuk /32 oleh database;
      // host(ip) mengembalikan alamat tanpa netmask.
      eqIsh(r.ip, entri.ip);
      eqIsh(r.endpoint, entri.endpoint);
      const params = typeof r.params === 'string' ? JSON.parse(r.params) : r.params;
      ok('params JSONB tersimpan', !!params && params.jenis === 'uji-live', JSON.stringify(params));
      ok('params tetap menyimpan apikey tersembunyi', !params.apikey, JSON.stringify(params));

      // ts diisi database (BUKAN aplikasi) lewat DEFAULT now(). Kontrak
      // penting: aplikasi tidak boleh mempercayai jam klien dalam audit.
      // Umur dihitung di sisi database (now() DB), bukan jam lokal klien --
      // Supabase di zona waktu berbeda.
      ok('ts diisi database, bukan klien', r.ts_baru_sekarang === true, new Date(r.ts).toISOString());
    }

    // -------------------------------------------------------------------------
    // 2. Verifikasi RLS hidup (bukan bukti sink, tapi konteks). Query langsung
    //    anon terhadap access_log TIDAK boleh mengembalikan apa pun: policy
    //    access_log_read hanya untuk operator/admin. RLS MENYARING baris,
    //    bukan menolak query -- error (count 0, bukan error) adalah perilaku
    //    yang benar dan justru yang dibuktikan: kalau RLS tidak bekerja,
    //    anon akan melihat baris uji.
    // -------------------------------------------------------------------------
    console.log('=== 2. anon tidak melihat baris access_log (RLS) ===');

    const anon = await db.transaksi(null, async (client) => {
      const res = await client.query('SELECT COUNT(*)::int AS n FROM access_log WHERE endpoint = $1', [tanda]);
      return res.rows[0].n;
    });
    ok('anon (tanpa klaim) tidak melihat baris uji', anon === 0, 'dapat ' + anon);

    // -------------------------------------------------------------------------
    // 3. F3.10a: cari_kunci (SECURITY DEFINER) berfungsi tanpa identitas.
    //    Ini satu-satunya jalan yang SAH untuk membaca agency_api_keys sebelum
    //    identitas pemanggil diketahui. Pembuktian menyeluruh:
    //      a. INSERT instansi + kategori + kunci uji sebagai app_api dengan
    //         klaim operator (policy agencies_operator_insert).
    //      b. cariKunci(hash) menemukannya -- sebagai anon, tanpa klaim.
    //      c. apiKeyAuth.verifikasi terhadap token asli lolos sampai status.
    //      d. hash yang tidak ada mengembalikan null.
    // -------------------------------------------------------------------------
    console.log('=== 3. F3.10a: cari_kunci memecah chicken-and-egg auth ===');

    const apiKeyAuth = require('../lib/api-key-auth.js');
    const tokenUji = apiKeyAuth.PREFIX_TOKEN + 'u2i9fweUDYy0iHjlYcHP4Z2v52GHCRBMDoONQNRfVZs'; // 43 char base64url
    const hashUji = apiKeyAuth.hashToken(tokenUji);
    // institution_key hanya boleh [a-z0-9-] (CHECK di skema). Dipakai juga
    // sebagai pola pembersihan, jadi dibentuk dengan tanggal agar unik.
    const namaInstansi = 'uji-f310a-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

    let agencyId = null;
    try {
      agencyId = await db.transaksi(
        { role: 'operator', agency_id: null },
        async (client) => {
          const a = await client.query(
            'INSERT INTO agencies (institution_key, name)' +
            ' VALUES ($1, $2) RETURNING id',
            [namaInstansi, 'Instansi ' + namaInstansi]
          );
          const idA = a.rows[0].id;
          await client.query(
            'INSERT INTO agency_categories (agency_id, jenis_sasaran) VALUES ($1, $2)',
            [idA, 'Catin']
          );
          await client.query(
            'INSERT INTO agency_api_keys (agency_id, key_hash, key_prefix, status)' +
            ' VALUES ($1, $2, $3, $4)' +
            '   ON CONFLICT (key_hash) DO NOTHING',
            [idA, hashUji, tokenUji.slice(0, 10), 'primary']
          );
          return idA;
        }
      );
      ok('INSERT instansi + kategori + kunci sebagai operator jalan', !!agencyId, String(agencyId));
    } catch (e) {
      ok('INSERT instansi + kategori + kunci sebagai operator jalan', false, e.message);
    }

    if (agencyId) {
      const kunci1 = await db.cariKunci(hashUji);
      ok('cariKunci menemukan baris dari hash (anon)', !!kunci1, JSON.stringify(kunci1));
      if (kunci1) {
        eqIsh(String(kunci1.agency_id), String(agencyId));
        eqIsh(kunci1.status, 'primary');
        eqIsh(kunci1.category, null);
      }

      const hasilVerifikasi = await apiKeyAuth.verifikasi({
        token: tokenUji,
        cariKunci: db.cariKunci,
        diminta: 'Catin',
      });
      ok('apiKeyAuth.verifikasi lolos dengan token asli', hasilVerifikasi.ok === true, JSON.stringify(hasilVerifikasi));
      if (hasilVerifikasi.ok) {
        eqIsh(String(hasilVerifikasi.agencyId), String(agencyId));
      }

      const hasilSalah = await apiKeyAuth.verifikasi({
        token: apiKeyAuth.PREFIX_TOKEN + 'A'.repeat(43),
        cariKunci: db.cariKunci,
        diminta: 'Catin',
      });
      ok('token dengan hash tak dikenal -> UNKNOWN_KEY', hasilSalah.kode === 'UNKNOWN_KEY', hasilSalah.kode);

      const kunciNull = await db.cariKunci('zz'.repeat(32));
      ok('cariKunci null untuk hash tak dikenal', kunciNull === null, JSON.stringify(kunciNull));
    }

    // Terakhir, konfirmasi anon sendiri BISA memanggil fungsi (bukan menuntut
    // menjadi operator) -- justru inti dari SECURITY DEFINER.
    const lewatFungsi = await db.cariKunci(hashUji);
    ok('anon bisa memanggil cari_kunci (SECURITY DEFINER)', lewatFungsi !== null, JSON.stringify(lewatFungsi));

    // -------------------------------------------------------------------------
    // 4. Status bisa dibaca dan tidak memuat kata sandi.
    // -------------------------------------------------------------------------
    console.log('=== 4. status() ===');
    ok('status().terpasang true setelah koneksi pertama', db.status().terpasang === true);
    ok('status().peran benar', db.status().peran === 'app_api');
    const stUrl = db.status().url;
    ok('status().url menyembunyikan kata sandi', !!stUrl && stUrl.indexOf('***') >= 0, stUrl);
  } finally {
    // Pembersihan mutlak: baris uji dibuang lewat koneksi utama (BYPASSRLS).
    // Kalau pembuktian di atas gagal di tengah, baris tetap tidak menumpuk.
    await utama.query('DELETE FROM access_log WHERE endpoint LIKE $1', ['__uji_datalib__%']).catch(() => {});
    await utama.query(
      'DELETE FROM agencies WHERE institution_key LIKE $1',
      ['uji-f310a-%']
    ).catch(() => {});
    await db.matikan();
    await utama.end().catch(() => {});
    await ujiLiveLock.lepas(peganganKunci);
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log(berjalan ? '\nSEMUA UJI LOLOS (live terhadap database)' : '\nDILEWATI (tidak ada bukti)');
}

function eqIsh(aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  const nama = 'nilai tersimpan benar (' + a + ')';
  if (a === b) { passed++; console.log('LULUS  ' + nama); }
  else { failed++; console.log('GAGAL  ' + nama + ' vs diharapkan ' + b); }
}

main().catch((e) => {
  console.error('\nUji live db.js gagal dijalankan: ' + e.message);
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});