'use strict';

/**
 * Pemasangan dan verifikasi keras database (F1.8a, F3.7).
 *
 * Satu perintah yang sama dipakai di PostgreSQL lokal dan di Supabase. Yang
 * membedakan hanya cara membaca URL koneksi; urutan langkah dan pemeriksaannya
 * identik, karena perbedaan itulah yang paling sering membuat pengujian RLS
 * "lulus" palsu.
 *
 * Kenapa ada verifikasi keras di sini, bukan sekadar memasang skema:
 *
 *   RLS adalah temuan inti riset ini. Tapi RLS bisa senyap-nyap tidak
 *   bekerja. Dua keadaan yang membuatnya tidak bekerja tanpa satu pun pesan
 *   galat:
 *
 *     1. Peran yang dipakai punya SUPERUSER atau BYPASSRLS. Keduanya
 *        melewati RLS apa adanya -- FORCE ROW LEVEL SECURITY pun tidak
 *        mengalahkannya. Query tetap jalan, baris tetap terbaca, dan semua
 *        pengujian isolasi tetap hijau karena tidak ada yang pernah
 *        menguji perannya.
 *
 *     2. Peran efektif berbeda dari yang diperiksa. `SET ROLE` yang gagal
 *        diam-diam, atau pemeriksaan dijalankan sebelum `SET ROLE`,
 *        membuat kita mengukur peran yang salah.
 *
 *   Karena itu skrip ini mengukur peran efektif SETELAH `SET ROLE`, lalu
 *   memeriksa atributnya di `pg_roles`, lalu membuktikannya dengan isolasi
 *   baris sungguhan: dua instansi, dua record, empat macam klaim JWT.
 *   Satu pun gagal -> keluar dengan kode 1.
 *
 * Peran aplikasi dibuat NOLOGIN dengan sengaja. Aplikasi terhubung memakai
 * `DATABASE_URL`, lalu menurunkan peran di dalam transaksi:
 *
 *     SET LOCAL ROLE app_api
 *
 * Satu URL, satu rahasia, dan tidak ada risiko lupa menurunkan peran pada
 * berkas konfigurasi kedua. `NOLOGIN` menutup kemungkinan seseorang
 * terhubung langsung sebagai peran itu dan mengira RLS berlaku padahal
 * tidak.
 *
 * Pemakaian:
 *   node tools/db-setup.js terapkan   -- buat peran, pasang skema, beri hak, verifikasi
 *   node tools/db-setup.js periksa    -- verifikasi saja, tidak mengubah apa pun
 *   node tools/db-setup.js kering     -- cetak SQL, tanpa koneksi
 *
 * Kode keluar: 0 semua pemeriksaan lulus, 1 ada yang gagal, 2 salah pakai.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PERAN_BAWAAN = 'app_api';
const SKEMA = path.join(__dirname, '..', 'sql', '001_schema.sql');

const BANTUAN = [
  'Pemasangan dan verifikasi keras database (F1.8a, F3.7).',
  '',
  'Pemakaian:',
  '  node tools/db-setup.js terapkan   Buat peran, pasang skema, beri hak, lalu verifikasi.',
  '  node tools/db-setup.js periksa    Verifikasi saja. Tidak mengubah apa pun.',
  '  node tools/db-setup.js kering     Cetak SQL yang akan dijalankan terapkan, tanpa koneksi.',
  '',
  'Pilihan:',
  '  --peran NAMA     Peran aplikasi (bawaan: app_api). Dibuat NOLOGIN,',
  '                   NOSUPERUSER, NOBYPASSRLS. Aplikasi menurunkan peran ini',
  '                   dengan `SET LOCAL ROLE` di dalam transaksi.',
  '  -h, --help       Bantuan ini.',
  '',
  'Verifikasi keras selalu memeriksa hal yang sama:',
  '  1. SET ROLE benar-benar mengubah peran efektif.',
  '  2. Peran efektif bukan superuser dan bukan BYPASSRLS.',
  '  3. Hak yang diperlukan ada, dan hak ubah pada access_log tidak ada.',
  '  4. Dua instansi hanya melihat record miliknya sendiri.',
  '  5. Tanpa klaim JWT tidak melihat apa pun.',
  '',
  'Kode keluar: 0 lulus, 1 ada yang gagal, 2 salah pakai.',
  '',
  'Lingkungan dibaca dari DATABASE_URL. Perintah ini tidak meminta URL lain.',
].join('\n');

// ---------------------------------------------------------------------------
// Argumen
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { perintah: null, peran: PERAN_BAWAAN, help: false };

  if (argv.length === 0) {
    throw new Error('perintah wajib: terapkan, periksa, atau kering');
  }

  let i = 0;
  if (!String(argv[0]).startsWith('-')) {
    o.perintah = String(argv[0]);
    i = 1;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--peran') {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) {
        throw new Error(a + ' butuh nilai');
      }
      o.peran = String(v);
      i++;
    } else if (a === '-h' || a === '--help') {
      o.help = true;
    } else {
      throw new Error('argumen tak dikenal: ' + a);
    }
  }

  if (o.perintah && ['terapkan', 'periksa', 'kering'].indexOf(o.perintah) < 0) {
    throw new Error('perintah tak dikenal: ' + o.perintah + ' (terapkan, periksa, atau kering)');
  }
  if (o.peran && !/^[a-z_][a-z0-9_]*$/.test(o.peran)) {
    throw new Error(
      'nama peran tidak sah: ' + o.peran +
      ' (huruf kecil, angka, dan garis bawah saja, diawali huruf atau garis bawah)'
    );
  }
  return o;
}

// ---------------------------------------------------------------------------
// Logika murni
//
// Semua fungsi di bagian ini tidak menyentuh jaringan maupun berkas. Uji unit
// di tools/test-db-setup.js menjalankannya langsung, jadi perilaku yang
// paling mahal -- "kapan skrip ini boleh keluar dengan kode 1" -- tetap
// teruji meski tidak ada database yang terpasang.
// ---------------------------------------------------------------------------

/**
 * Tebak lingkungan dari URL koneksi. Hanya untuk laporan; tidak satu pun
 * keputusan pengambilan yang bergantung pada hasilnya.
 *
 * Tujuannya bukan membedakan perilaku, tapi menulis di layar apa yang sedang
 * kita hadapi. Kalau hasilnya salah pun tidak ada yang rusak -- yang rusak
 * adalah mengira kita tahu padahal tidak.
 */
function deteksiLingkungan(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return 'tak dikenal';
  }
  const host = String(u.hostname || '').toLowerCase();
  if (host.indexOf('supabase') >= 0) return 'supabase';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return 'lokal';
  if (!host) return 'lokal';
  return 'lain';
}

/**
 * Bentuk aman URL untuk dicetak. Kata sandi tidak pernah ikut tercetak,
 * bukan karena sensitif terhadap mata yang sama-sama memegang berkas .env,
 * tapi karena jejak terminal sering disalin ke tiket dan percakapan.
 */
function ramahUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return '(URL tidak bisa dibaca)';
  }
  const akun = u.username ? u.username + ':***@' : '';
  return (u.protocol || '') + '//' + akun + (u.hostname || '') + (u.port ? ':' + u.port : '') + (u.pathname || '');
}

/**
 * Periksa atribut peran yang membuat RLS tidak berlaku.
 *
 * `null` berarti peran tidak ada -- gagal juga, karena peran yang tidak ada
 * tidak bisa dipakai SET ROLE, dan pesan galatnya jauh dari akar masalahnya.
 */
function periksaPeran(rol) {
  if (!rol) {
    return { lulus: false, alasan: 'peran tidak ditemukan di pg_roles' };
  }
  const masalah = [];
  if (rol.rolsuper) masalah.push('rolsuper = true');
  if (rol.rolbypassrls) masalah.push('rolbypassrls = true');
  if (masalah.length === 0) return { lulus: true, alasan: '' };
  return {
    lulus: false,
    alasan: masalah.join(', ') +
      ' -- keduanya melewati RLS termasuk FORCE ROW LEVEL SECURITY, jadi semua pengujian isolasi akan lulus palsu',
  };
}

/**
 * SQL pembuatan peran. Idempoten: `DO` hanya membuat kalau belum ada, dan
 * peran yang baru dibuat sudah memiliki semua atribut yang benar.
 *
 * SENG AJA TIDAK ADA `ALTER ROLE` di sini: di Supabase modern peran koneksi
 * (`postgres`) bukan superuser, dan `ALTER ROLE ... NOBYPASSRLS` menuntut
 * superuser -- sedangkan `CREATE ROLE` cukup berbekal CREATEROLE. Jadi untuk
 * peran yang baru dibuat, langkah perbaikan atribut yang mandiri (`ALTER`)
 * justru akan mematikan pemasangan yang sebenarnya sudah berhasil.
 *
 * Atribut ditulis eksplisit meski sebagian adalah nilai bawaan. Bawaan bisa
 * berubah antar versi, dan "kebetulan aman" bukan jaminan yang bisa
 * diverifikasi orang lain di kemudian hari.
 */
function sqlBuatPeran(peran) {
  return [
    'DO $$ BEGIN\n' +
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '" + peran + "') THEN\n" +
    '    CREATE ROLE ' + peran + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' +
    ' NOREPLICATION NOBYPASSRLS;\n' +
    '  END IF;\n' +
    'END $$;',
  ];
}

/**
 * SQL perbaikan peran yang sudah ada tetapi atributnya salah (misalnya sisa
 * percobaan sebelumnya yang membuatnya superuser).
 *
 * Dipisahkan dari `sqlBuatPeran` karena mengubah atribut peran menuntut hak
 * yang tidak dimiliki setiap koneksi: di Supabase modern, `postgres` bukan
 * superuser, jadi `ALTER ROLE ... NOBYPASSRLS` akan ditolak. Skrip hanya
 * menjalankan ini untuk peran yang memang terbukti salah, dan kalau tetap
 * gagal, pesan galatnya ditampilkan utuh -- bukan ditelan seperti yang akan
 * terjadi kalau `ALTER` digabung dalam alur pembuatan.
 */
function sqlUbahPeran(peran) {
  return 'ALTER ROLE ' + peran + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' +
    ' NOREPLICATION NOBYPASSRLS;';
}

/**
 * Hak aplikasi.
 *
 * Modelnya sengaja dibagi dua dan tidak dicampur:
 *
 *   HAK  = "boleh menyentuh tabel ini sama sekali". Kasar, hampir semua
 *          tabel dapat SELECT.
 *   RLS  = "baris mana". Sumber kebenaran otorisasi. Bahasa Inggrisnya
 *          row-level security, dan memang baris, bukan tabel.
 *
 * Kalau keduanya dicampur jadi satu daftar izin rinci, tidak ada satu pun
 * tempat yang bisa menjelaskan batas sebenarnya -- pembaca harus menebak
 * apakah baris yang terbaca itu terjadi karena hak atau karena policy.
 *
 * `access_log` hanya mendapat INSERT. Kabar baiknya, skema sudah memanggil
 * `REVOKE UPDATE, DELETE ... FROM PUBLIC`; daftar ini menegaskannya untuk
 * peran aplikasi sehingga tidak tergantung pada urutan eksekusi berkas skema.
 */
function sqlHak(peran) {
  return [
    'GRANT USAGE ON SCHEMA public TO ' + peran + ';',
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + peran + ';',
    'GRANT INSERT ON access_log TO ' + peran + ';',
    'GRANT INSERT, UPDATE ON records TO ' + peran + ';',
    'GRANT INSERT, UPDATE ON chain_outbox TO ' + peran + ';',
    // F4.3 + FR-7.4: anchor akar log ditulis operator/admin lewat `transaksi`.
    // Baris dibuat saat akar pertama kali dihitung (INSERT), lalu `tx_hash`
    // diisi menyusul setelah `DataAnchor.anchorAuditRoot` sukses (UPDATE) --
    // pemisahan itu yang membuat peng-angkuran on-chain bisa diulang tanpa
    // menggandakan baris. Karena itu UPDATE diperlukan, bukan opsional.
    'GRANT INSERT, UPDATE ON audit_anchor TO ' + peran + ';',
    'GRANT INSERT, UPDATE ON agency_rate_limit TO ' + peran + ';',
    'GRANT INSERT, UPDATE ON agency_config TO ' + peran + ';',
    // FR-3.1: konsol admin membuat instansi dan kategorinya lewat peran
    // aplikasi (SET ROLE app_api). Policy INSERT-nya sudah ada; GRANT ini
    // menyediakan hak tabel yang menjadi prasyarat policy itu.
    'GRANT INSERT ON agencies TO ' + peran + ';',
    'GRANT INSERT ON agency_categories TO ' + peran + ';',
    // F3.10a: penerbitan kunci API (operator/admin) lewat aplikasi. Policy
    // agency_api_keys_operator_only memakai WITH CHECK yang membatasi baris;
    // di sini hanya prasyarat hak tabelnya.
    'GRANT INSERT ON agency_api_keys TO ' + peran + ';',
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + peran + ';',
    // Supaya tabel yang dibuat setelah ini ikut mendapat hak yang sama.
    // Karena berlaku untuk objek buatan peran yang menjalankan, jalankan ulang
    // `terapkan` setelah menambah tabel.
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ' + peran + ';',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ' + peran + ';',
  ];
}

/**
 * Buang `BEGIN;` dan `COMMIT;` dari berkas skema.
 *
 * Berkas skema berdiri sendiri dan dibungkus transaksinya sendiri supaya bisa
 * dijalankan lewat psql. Berkas ini dijalankan lewat klien Node yang sudah
 * membuka transaksinya sendiri, jadi `BEGIN` di dalam transaksi akan
 * memunculkan peringatan dan `COMMIT` akan menutup transaksi lebih awal dari
 * yang kita kira. Dua transaksi yang tumpang tindih bukan cara yang jujur
 * untuk menerapkan skema.
 *
 * Dua jebakan yang harus dihindari, dan keduanya sudah teruji:
 *
 *   1. Mencocokkan `BEGIN;` di mana pun akan ikut menghapus pernyataan di
 *      dalam tubuh fungsi PL/pgSQL yang ditulis `$$ ... $$`. Kalau itu
 *      terjadi, fungsi yang belum lengkap tetap lolos parser dan gagal
 *      jauh belakangan dengan pesan yang tidak menunjuk ke sini.
 *   2. Menghapus `COMMIT;` yang bukan penutup akan memutus transaksi di
 *      tengah, sehingga separuh skema terpasang dan separuh tidak.
 *
 * Karena itu `BEGIN;` hanya dihapus kalau ia muncul sebelum pernyataan
 * pembuat pertama, dan `COMMIT;` hanya kalau ia baris terakhir yang berisi.
 * Di luar dua itu berkas dikembalikan apa adanya.
 */
function siapkanSkema(teks) {
  const baris = teks.split('\n');

  const pemBuat = /^(CREATE|ALTER|DROP|INSERT|GRANT|REVOKE|COMMENT|DO)\b/;
  const iAwal = baris.findIndex((b) => pemBuat.test(b.trim()));
  const iBegin = baris.findIndex((b) => /^[ \t]*BEGIN;[ \t]*$/.test(b));
  if (iBegin >= 0 && (iAwal === -1 || iBegin < iAwal)) {
    baris.splice(iBegin, 1);
  }

  for (let j = baris.length - 1; j >= 0; j--) {
    if (baris[j].trim() === '') continue;
    if (/^[ \t]*COMMIT;[ \t]*$/.test(baris[j])) baris.splice(j, 1);
    break;
  }

  return baris.join('\n');
}

/**
 * Nilai untuk `SET LOCAL request.jwt.claims = ...`.
 *
 * `SET` tidak menerima parameter ikat di PostgreSQL, jadi JSON harus
 * ditulis langsung ke pernyataan. `JSON.stringify` tidak pernah
 * mengeluarkan tanda kutip tunggal, jadi tidak ada yang perlu di-escape --
 * asumsi itu dipertegas di sini supaya ada satu tempat untuk diperiksa
 * kalau formatnya berubah.
 */
function nilaiKlaim(klaim) {
  if (klaim === null || klaim === undefined) return "''";
  const json = JSON.stringify(klaim);
  if (json.indexOf("'") >= 0) {
    throw new Error('klaim JWT mengandung tanda kutip tunggal, tidak aman ditulis langsung');
  }
  return "'" + json + "'";
}

/**
 * Nilai pembanding untuk seluruh pemeriksaan isolasi.
 *
 * Dikembalikan sebagai daftar pasangan, bukan dijalankan berurutan di sini,
 * supaya kegagalan satu pemeriksaan tidak menghentikan pemeriksaan lain.
 * Skrip ini ingin tahu semua yang rusak dalam satu kali jalan, bukan
 * yang paling kiri.
 */
function evaluasiIsolasi(h) {
  const daftar = [
    ['peran efektif setelah SET ROLE', h.peranEfektif, h.peran],
    ['peran efektif bukan superuser', h.rolsuper, false],
    ['peran efektif tanpa BYPASSRLS', h.rolbypassrls, false],
    ['hak SELECT pada records diberikan', h.bisaBacaRecords, true],
    ['hak INSERT pada access_log diberikan', h.bisaTulisLog, true],
    ['hak UPDATE pada access_log tidak diberikan', h.bisaUbahLog, false],
    ['hak INSERT pada audit_anchor diberikan', h.bisaTulisAnchor, true],
    ['hak UPDATE pada audit_anchor diberikan', h.bisaUbahAnchor, true],
    ['UPDATE access_log ditolak database', h.ubahLogDitolak, true],
    ['operator melihat kedua record uji', h.operator.n, 2],
    ['instansi A hanya melihat record A', h.agencyA.n, 1],
    ['record yang dilihat A milik instansi A', h.agencyA.pemilik, 'uji-a'],
    ['instansi B hanya melihat record B', h.agencyB.n, 1],
    ['record yang dilihat B milik instansi B', h.agencyB.pemilik, 'uji-b'],
    ['tanpa klaim JWT tidak melihat record uji', h.anon.n, 0],
  ];

  return daftar.map(function (baris) {
    const nama = baris[0];
    const aktual = baris[1];
    const diharapkan = baris[2];
    return {
      nama: nama,
      lulus: JSON.stringify(aktual) === JSON.stringify(diharapkan),
      aktual: aktual,
      diharapkan: diharapkan,
    };
  });
}

// ---------------------------------------------------------------------------
// PostgreSQL, dimuat malas
//
// Alasan sama dengan tools/mirror-sheets.js: `kering` dan uji unit tidak
// membutuhkan paket 'pg', dan tidak seharusnya gagal hanya karena
// dependensi jaringan belum ada.
// ---------------------------------------------------------------------------

let pgModule = null;
function pg() {
  if (pgModule === null) {
    try {
      pgModule = require('pg');
    } catch (e) {
      throw new Error(
        'Paket "pg" belum terpasang. Jalankan `npm install pg` di backend/ ' +
        'atau pakai `kering` untuk melihat SQL tanpa koneksi.'
      );
    }
  }
  return pgModule;
}

// ---------------------------------------------------------------------------
// Kueri
// ---------------------------------------------------------------------------

async function bacaPeran(client, peran) {
  const r = await client.query(
    'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1',
    [peran]
  );
  return r.rows[0] || null;
}

/**
 * Jalankan verifikasi keras. Semua pemeriksaan berjalan dalam satu
 * transaksi yang dibatalkan, jadi tidak ada data uji yang tertinggal --
 * termasuk kalau skripnya dihentikan di tengah.
 *
 * Urutan di dalam transaksi ini penting dan tidak bebas:
 *
 *   1. Penyiapan data dilakukan SEBELUM `SET ROLE`, karena membuat instansi
 *      adalah pekerjaan pengelola, dan `agencies` memang tidak punya policy
 *      INSERT. Itu disengaja: institusi ditambahkan oleh orang, bukan oleh
 *      aplikasi yang melayani permintaan.
 *   2. `SET ROLE` baru dijalankan sesudahnya, sehingga setiap pembacaan yang
 *      mengikuti benar-benar berada di bawah peran aplikasi.
 *   3. Pemeriksaan `UPDATE access_log` dibungkus savepoint. Galat di dalam
 *      transaksi mematikan seluruh transaksi, jadi tanpa savepoint semua
 *      pemeriksaan sesudahnya akan gagal dengan pesan yang menyesatkan.
 *   4. Isolasi baris dijalankan paling akhir dan hanya kalau benihnya ada.
 *      Tanpa benih, semua hitungan nol dan tujuh pemeriksaan itu akan
 *      terlihat sebagai tujuh temuan terpisah padahal satu akar masalah.
 */
async function verifikasiKeras(client, peran) {
  const hasil = { info: [], lulus: [], gagal: [] };
  const catat = function (nama, ok, aktual, diharapkan) {
    const entri = { nama: nama, aktual: aktual, diharapkan: diharapkan };
    if (ok) hasil.lulus.push(entri);
    else hasil.gagal.push(entri);
  };

  const koneksi = (await client.query(
    'SELECT current_user AS nama, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  )).rows[0];
  hasil.info.push(
    'koneksi sebagai ' + koneksi.nama +
    (koneksi.rolsuper ? ' (SUPERUSER)' : '') +
    (koneksi.rolbypassrls ? ' (BYPASSRLS)' : '')
  );

  const tanda = 'uji-' + crypto.randomBytes(4).toString('hex');

  await client.query('BEGIN');
  try {
    // --- penyiapan: sebagai peran koneksi, dengan klaim operator -----------
    await client.query('SET LOCAL request.jwt.claims = ' + nilaiKlaim({ role: 'operator' }));

    const siap = [
      "INSERT INTO agencies (institution_key, name)" +
      " VALUES ('uji-a','Uji Isolasi A'),('uji-b','Uji Isolasi B')" +
      ' ON CONFLICT DO NOTHING;',
      "INSERT INTO agency_categories (agency_id, jenis_sasaran)" +
      " SELECT a.id, 'Catin' FROM agencies a" +
      " WHERE a.institution_key IN ('uji-a','uji-b')" +
      " AND NOT EXISTS (SELECT 1 FROM agency_categories c" +
      " WHERE c.agency_id = a.id AND c.jenis_sasaran = 'Catin');",
      // FR-4.17: scope kosong berarti SELURUH wilayah. Benih ini sengaja
      // memberi masing-masing instansi scope desa yang berbeda, kalau tidak
      // kedua instansi yang sama-sama Catin akan sah melihat seluruh record
      // dan pengujian isolasi tidak punya sesuatu untuk dibuktikan -- bukan
      // karena RLS bocor, tapi karena benihnya tidak membedakan apa pun.
      // Kedua record bernama sama kategori (Catin); yang memisahkannya
      // HANYA scope wilayah, sehingga pemeriksaan benar-benar menguji
      // penegakan wilayah RLS, bukan kebetulan kategori yang berbeda.
      "INSERT INTO agency_desa_scope (agency_id, nama_kecamatan, nama_desa)" +
      " SELECT a.id, 'Kecamatan Uji'," +
      "   CASE WHEN a.institution_key = 'uji-a' THEN 'Desa A'" +
      "        ELSE 'Desa B' END" +
      " FROM agencies a" +
      " WHERE a.institution_key IN ('uji-a','uji-b')" +
      " ON CONFLICT DO NOTHING;",
      'INSERT INTO records (record_id, institution_id, payload_json, record_hash,' +
      ' nama_tpk, peran_tpk, nama_kecamatan, nama_desa, nik, nama_lengkap, jenis_sasaran, tanggal_kunjungan)' +
      " VALUES ('" + tanda + "-a','uji-a','{}'::jsonb,'" + tanda + "-a'," +
      " 'TPK A','Kader','Kecamatan Uji','Desa A','1111111111111111','Warga A','Catin','2026-01-01')," +
      " ('" + tanda + "-b','uji-b','{}'::jsonb,'" + tanda + "-b'," +
      " 'TPK B','Kader','Kecamatan Uji','Desa B','2222222222222222','Warga B','Catin','2026-01-01');",
    ];
    let gagalSiap = null;
    for (const s of siap) {
      try {
        await client.query(s);
      } catch (e) {
        gagalSiap = e.message;
        break;
      }
    }

    const idBaris = (await client.query(
      "SELECT institution_key, id FROM agencies WHERE institution_key IN ('uji-a','uji-b')"
    )).rows;
    const idA = (idBaris.filter((r) => r.institution_key === 'uji-a')[0] || {}).id;
    const idB = (idBaris.filter((r) => r.institution_key === 'uji-b')[0] || {}).id;

    if (gagalSiap) {
      hasil.info.push('id instansi uji terbaca: ' + idBaris.length);
    }

    // --- turunkan peran ---------------------------------------------------
    let setRoleGagal = null;
    try {
      await client.query('SET LOCAL ROLE "' + peran.replace(/"/g, '""') + '"');
    } catch (e) {
      setRoleGagal = e.message;
    }

    if (setRoleGagal) {
      catat('SET ROLE ' + peran + ' diterima database', false, setRoleGagal, 'tanpa galat');
      return hasil;
    }

    const efektif = (await client.query(
      'SELECT current_user AS nama, r.rolsuper, r.rolbypassrls' +
      ' FROM pg_roles r WHERE r.rolname = current_user'
    )).rows[0];

    // Pemeriksaan peran tidak bergantung pada data uji, jadi dijalankan dulu
    // dan selalu dilaporkan. Isolasi baris baru berarti kalau benihnya ada.
    const hak = async (tabel, izin) => {
      const r = await client.query(
        'SELECT has_table_privilege(current_user, $1, $2) AS b',
        [tabel, izin]
      );
      return r.rows[0].b;
    };

    const hitung = async (klaim) => {
      await client.query('SET LOCAL request.jwt.claims = ' + nilaiKlaim(klaim));
      const r = await client.query(
        'SELECT count(*)::int AS n, min(institution_id) AS pemilik FROM records' +
        " WHERE record_id LIKE '" + tanda + "%'"
      );
      return r.rows[0];
    };

    let ubahLogDitolak = null;
    let pesanUbah = '';
    const bisaBacaRecords = await hak('records', 'SELECT');
    const bisaTulisLog = await hak('access_log', 'INSERT');
    const bisaUbahLog = await hak('access_log', 'UPDATE');
    const bisaTulisAnchor = await hak('audit_anchor', 'INSERT');
    const bisaUbahAnchor = await hak('audit_anchor', 'UPDATE');

    // --- fungsi cari_kunci (F3.10a) ---------------------------------------
    // Kalau fungsi ini tidak terpasang, autentikasi kunci API jatuh senyap ke
    // mode lewat-identitas-legacy dan server terlihat "berfungsi" padahal
    // kunci API sungguhan tidak pernah diverifikasi -- persis jenjang "hijau
    // palsu" yang skema ini ada untuk singkirkan. Keberadaan, SECURITY
    // DEFINER, dan EXECUTE untuk PUBLIC dicek sekaligus.
    const adaCariKunci = (await client.query(
      "SELECT to_regprocedure('cari_kunci(text)') AS ada"
    )).rows[0].ada;
    let prosecdefCariKunci = null;
    if (adaCariKunci) {
      prosecdefCariKunci = (await client.query(
        "SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('cari_kunci(text)')"
      )).rows[0].prosecdef;
    }
    const eksekusiPublikCariKunci = (await client.query(
      "SELECT has_function_privilege('public', 'cari_kunci(text)', 'EXECUTE') AS b"
    )).rows[0].b;
    catat('fungsi cari_kunci terpasang', !!adaCariKunci, adaCariKunci, 'ada');
    catat('cari_kunci adalah SECURITY DEFINER', prosecdefCariKunci === true, prosecdefCariKunci, true);
    catat('EXECUTE cari_kunci untuk PUBLIC', eksekusiPublikCariKunci === true, eksekusiPublikCariKunci, true);

    // --- pemeriksaan terakhir, dengan savepoint ---------------------------
    await client.query('SAVEPOINT uji_ubah_log');
    try {
      await client.query("UPDATE access_log SET endpoint = 'x' WHERE false");
      await client.query("UPDATE access_log SET endpoint = 'x'");
      ubahLogDitolak = false;
    } catch (e) {
      ubahLogDitolak = true;
      pesanUbah = e.message;
    }
    await client.query('ROLLBACK TO SAVEPOINT uji_ubah_log');

    const dasar = {
      peran: peran,
      peranEfektif: efektif.nama,
      rolsuper: efektif.rolsuper,
      rolbypassrls: efektif.rolbypassrls,
      bisaBacaRecords: bisaBacaRecords,
      bisaTulisLog: bisaTulisLog,
      bisaUbahLog: bisaUbahLog,
      bisaTulisAnchor: bisaTulisAnchor,
      bisaUbahAnchor: bisaUbahAnchor,
      ubahLogDitolak: ubahLogDitolak,
    };
    if (pesanUbah && !ubahLogDitolak) {
      hasil.info.push('UPDATE access_log tidak ditolak: ' + pesanUbah);
    }

    // Tanpa benih, tujuh pemeriksaan isolasi hanya akan mengembalikan nol
    // untuk semuanya dan terlihat seperti tujuh temuan terpisah. Satu akar
    // masalah dilaporkan sekali, dengan jalan keluarnya.
    const benihGagal = gagalSiap || idA === undefined || idB === undefined;
    if (benihGagal) {
      const alasan = gagalSiap || 'instansi uji tidak terbaca setelah disisipkan';
      catat('penyiapan data uji untuk pengujian isolasi', false, alasan, 'tanpa galat');
      hasil.info.push(
        'pemeriksaan isolasi baris dilewati karena benihnya tidak ada. ' +
        'Penyebab paling umum: peran koneksi tidak punya hak INSERT pada ' +
        'agencies. Skema kini punya policy INSERT untuk operator/admin ' +
        '(keputusan FR-3.1), tapi hak tabel (GRANT) hanya diberikan kepada ' +
        'peran aplikasi, bukan peran koneksi. Jalankan `terapkan` ulang atau ' +
        'beri GRANT yang sesuai.'
      );
      return hasil;
    }

    const h = Object.assign({}, dasar, {
      operator: await hitung({ role: 'operator' }),
      agencyA: await hitung({ role: 'agency', agency_id: idA }),
      agencyB: await hitung({ role: 'agency', agency_id: idB }),
      anon: await hitung(null),
    });

    for (const uji of evaluasiIsolasi(h)) {
      catat(uji.nama, uji.lulus, uji.aktual, uji.diharapkan);
    }

    return hasil;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pemasangan
// ---------------------------------------------------------------------------

/**
 * Ambil blok fungsi idempoten dari berkas skema.
 *
 * Skema berisi campuran pernyataan: tabel/policy yang TIDAK boleh dijalankan
 * ulang, dan fungsi `CREATE OR REPLACE` yang AMAN dijalankan ulang. Generasi
 * menandai fungsi-fungsi itu dengan `-- @@FUNGSI_START`/`-- @@FUNGSI_END`.
 *
 * Kenapa dipisah: `terapkan` pada database yang sudah ada (mis. Supabase yang
 * ARSIPnya sudah pernah diisi) harus bisa menarik perubahan fungsi baru dari
 * generator tanpa memaksa menjalankan seluruh DDL (yang akan gagal saat tabel
 * sudah ada). Tanpa ini, fungsi yang ditambahkan di generator TIDAK PERNAH
 * sampai ke database yang sudah ada -- "hijau palsu" yang pernah terjadi pada
 * cari_kunci. Penerapan ulang aman karena semua blok bertanda adalah
 * `CREATE OR REPLACE`.
 */
function ambilBlokFungsi(teks) {
  const baris = teks.split('\n');
  const blok = [];
  let sedang = false;
  let mulai = null;
  for (let j = 0; j < baris.length; j++) {
    const b = baris[j].trim();
    if (b === '-- @@FUNGSI_START') { sedang = true; mulai = []; continue; }
    if (b === '-- @@FUNGSI_END') {
      if (sedang && mulai) blok.push(mulai.join('\n'));
      sedang = false;
      mulai = null;
      continue;
    }
    if (sedang && mulai) mulai.push(baris[j]);
  }
  return blok.join('\n');
}

async function pasangSkema(client, hasil) {
  const teks = fs.readFileSync(SKEMA, 'utf8');
  const ada = (await client.query("SELECT to_regclass('public.records') AS t")).rows[0].t;
  if (!ada) {
    const isi = siapkanSkema(teks);
    await client.query('BEGIN');
    try {
      await client.query(isi);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    hasil.info.push('skema dipasang dari ' + path.basename(SKEMA));
    return;
  }

  // Skema sudah ada: hanya fungsi idempoten yang ditarik ulang. Fungsi adalah
  // satu-satunya bagian skema yang boleh dijalankan ulang, dan perubahan pada
  // fungsi (mis. cari_kunci baru) tidak boleh tersangkut di generator tanpa
  // pernah sampai ke database.
  const fungsi = ambilBlokFungsi(teks);
  if (fungsi) {
    await client.query('BEGIN');
    try {
      await client.query(fungsi);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    hasil.info.push('fungsi idempoten ditarik ulang dari ' + path.basename(SKEMA));
  }
  hasil.info.push('skema sudah ada (records), struktur dilewati');
}

async function terapkan(client, o, hasil) {
  let rol = await bacaPeran(client, o.peran);
  if (!rol) {
    for (const s of sqlBuatPeran(o.peran)) {
      await client.query(s);
    }
    rol = await bacaPeran(client, o.peran);
    hasil.info.push('peran ' + o.peran + ' dibuat');
  } else {
    hasil.info.push('peran ' + o.peran + ' sudah ada, atribut diperiksa ulang');
  }

  if (!rol) {
    hasil.gagal.push({ nama: 'peran ' + o.peran + ' ada setelah dibuat', aktual: 'tidak ada', diharapkan: 'ada' });
    return;
  }

  // Perbaiki peran lama yang atributnya salah (misalnya sisa percobaan
  // sebelumnya). Peran yang baru dibuat tidak butuh ini -- atributnya sudah
  // benar dari CREATE -- dan di Supabase modern `ALTER ROLE` menuntut
  // superuser yang tidak dimiliki koneksi, jadi hanya dijalankan kalau
  // memang terbukti perlu.
  let cek = periksaPeran(rol);
  if (!cek.lulus) {
    try {
      await client.query(sqlUbahPeran(o.peran));
      rol = await bacaPeran(client, o.peran);
      cek = periksaPeran(rol);
      hasil.info.push('atribut peran diperbaiki lewat ALTER ROLE');
    } catch (e) {
      hasil.gagal.push({ nama: 'alternatif perbaikan atribut ' + o.peran, aktual: e.message, diharapkan: 'tanpa galat' });
      return;
    }
  }
  if (!cek.lulus) {
    hasil.gagal.push({ nama: 'atribut peran ' + o.peran, aktual: cek.alasan, diharapkan: 'tanpa masalah' });
    return;
  }

  const kini = (await client.query('SELECT current_user AS nama')).rows[0].nama;
  // Diperlukan supaya koneksi ini boleh `SET ROLE`. GRANT idempoten, jadi
  // aman dijalankan berulang.
  await client.query(
    'GRANT "' + o.peran + '" TO "' + String(kini).replace(/"/g, '""') + '"'
  );

  await pasangSkema(client, hasil);

  for (const s of sqlHak(o.peran)) {
    await client.query(s);
  }
  hasil.info.push('hak diberikan kepada ' + o.peran);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function cetakHasil(hasil) {
  for (const s of hasil.info) console.log('info : ' + s);
  for (const s of hasil.lulus) console.log('LULUS  ' + s.nama);
  for (const s of hasil.gagal) {
    console.log('GAGAL  ' + s.nama);
    console.log('        dapat      : ' + JSON.stringify(s.aktual));
    console.log('        diharapkan : ' + JSON.stringify(s.diharapkan));
  }
  console.log('');
  console.log('lulus: ' + hasil.lulus.length + '   gagal: ' + hasil.gagal.length);
}

/**
 * Muat `.env` kalau ada.
 *
 * `index.js` memanggil `require('dotenv').config()` di baris pertamanya, tapi
 * skrip ini berdiri sendiri -- tidak memuat aplikasi, tidak membuka port.
 * Tanpa langkah ini `DATABASE_URL` yang tertulis di `.env` tidak terbaca dan
 * skrip akan mengeluh "belum diset" padahal sudah, yang mengarahkan orang
 * ke jalan yang salah selama berjam-jam.
 *
 * Dibungkus try: `.env` memang opsional (bisa juga diset lewat lingkungan),
 * dan `kering` seharusnya tetap berjalan meski dotenv tidak terpasang.
 */
function muatEnv() {
  try {
    require('dotenv').config();
  } catch (e) {
    // Bukan penghalang: nilainya mungkin sudah ada di process.env.
  }
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error('Salah pakai: ' + e.message);
    console.error('');
    console.error(BANTUAN);
    return 2;
  }
  if (o.help) {
    console.log(BANTUAN);
    return 0;
  }

  if (o.perintah === 'kering') {
    console.log('-- peran: ' + o.peran);
    for (const s of sqlBuatPeran(o.peran)) console.log(s);
    console.log('-- alternatif perbaikan atribut (hanya untuk peran lama yang atributnya salah):');
    console.log(sqlUbahPeran(o.peran));
    console.log('');
    console.log('-- hak: ' + o.peran);
    for (const s of sqlHak(o.peran)) console.log(s);
    return 0;
  }

  muatEnv();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL belum diset. Setel dulu, misalnya di berkas .env.');
    return 2;
  }

  const Client = pg().Client;
  const client = new Client({ connectionString: url });
  const hasil = { info: [], lulus: [], gagal: [] };

  try {
    await client.connect();
  } catch (e) {
    console.error('Tidak bisa terhubung ke ' + ramahUrl(url) + ': ' + e.message);
    return 2;
  }

  let kode = 0;
  try {
    hasil.info.push('lingkungan: ' + deteksiLingkungan(url) + ' (' + ramahUrl(url) + ')');

    if (o.perintah === 'terapkan') {
      await terapkan(client, o, hasil);
    }

    if (hasil.gagal.length === 0) {
      const v = await verifikasiKeras(client, o.peran);
      hasil.info = hasil.info.concat(v.info);
      hasil.lulus = hasil.lulus.concat(v.lulus);
      hasil.gagal = hasil.gagal.concat(v.gagal);
    }
  } catch (e) {
    hasil.gagal.push({ nama: 'menjalankan ' + o.perintah, aktual: e.message, diharapkan: 'tanpa galat' });
  } finally {
    await client.end().catch(() => {});
  }

  cetakHasil(hasil);
  if (hasil.gagal.length > 0) {
    console.log('');
    console.log('ADA YANG GAGAL. Jangan andalkan isolasi data sebelum ini hijau.');
    kode = 1;
  } else {
    console.log('');
    console.log('SEMUA PEMERIKSAAN LOLOS');
  }
  return kode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((k) => { process.exit(k); });
}

module.exports = {
  parseArgs,
  deteksiLingkungan,
  ramahUrl,
  periksaPeran,
  sqlBuatPeran,
  sqlUbahPeran,
  sqlHak,
  siapkanSkema,
  nilaiKlaim,
  evaluasiIsolasi,
};
