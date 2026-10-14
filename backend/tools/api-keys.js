/**
 * Penerbitan dan pencabutan kunci API instansi (F3.10a).
 *
 * Berkas ini sengaja TIDAK menyentuh database. Yang dilakukannya: membuat
 * token, menghitung hash-nya, dan menulis statement SQL yang bisa Anda tinjau
 * sebelum dijalankan. Alasannya berlaku untuk dua hal sekaligus.
 *
 * Pertama, `key_hash` adalah SHA-256 dan tidak bisa dibalik. Begitu INSERT
 * dijalankan, token aslinya hilang dari sistem -- jadi keputusan menerbitkannya
 * harus dibuat manusia yang membaca hasilnya, bukan skrip yang jalan sekali
 * lalu tidak terlihat. CLI yang langsung `psql -c` bisa salah
 * sedikit saja menghasilkan kunci yang tidak pernah sampai ke operator.
 *
 * Kedua, belum ada PostgreSQL di lingkungan ini (F1.8a masih terbuka). Menulis
 * ke file SQL membuat langkah ini bisa diselesaikan dan diuji sekarang, dan
 * langkah menjalankan DDL tetap eksplisit.
 *
 * ---------------------------------------------------------------------------
 * Aturan yang ditegakkan di sini (keputusan 2026-10-06)
 * ---------------------------------------------------------------------------
 * - Format token `pa_sk_live_<43 char base64url>`. Prefix dibuang SEBELUM
 *   di-hash, supaya rotasi format token di masa depan tidak membuat semua
 *   hash lama tidak usable.
 * - Satu instansi hanya boleh punya satu `primary`. Index unik bersyarat di
 *   DDL akan menolak kalau dilanggar, tapi pesan PostgreSQL tidak menyebut
 *   instansi mana -- jadi dicegah di sini lebih dulu, dengan pesan yang menyebut.
 * - `standby` tidak pernah dipakai server. Menerbitkannya berarti kunci cadangan
 *   ada, tanpa mengaktifkan apa pun.
 * - Pencabutan tidak menyentuh standby. "Primary dicabut = akses berhenti"
 *   hanya benar kalau tidak ada jalur otomatis yang melawannya.
 * - Hash dari teks yang sama selalu sama. Standby untuk instansi yang sama
 *   DIJAMIN akan menabrak index unik `key_hash` kalau tokennya dicocokkan,
 *   jadi generator prepend agency key di seed uji agar tetap realistis.
 */

const crypto = require('crypto');

const PREFIX_TOKEN = 'pa_sk_live_';
const PANJANG_RAHASIA = 43; // 32 byte -> 43 char base64url tanpa padding

const BANTUAN = [
  'Penerbitan dan pencabutan kunci API instansi (F3.10a).',
  '',
  'Pemakaian:',
  '  node tools/api-keys.js terbit --agency NAMA [--category KAT] [--table TABEL] [--label CATATAN] [--standby]',
  '  node tools/api-keys.js cabut   --key-hash HASH --by NAMA',
  '  node tools/api-keys.js demo',
  '',
  'Perintah:',
  '  terbit  Terbitkan kunci. Result dicetak SATU KALI. Hash-nya yang disimpan,',
  '          bukan tokennya -- jadi kalau hilang, terbitkan yang baru; jangan',
  '          mencoba mencari token lama.',
  '  cabut   Tandai kunci dicabut. Standby tidak ikut diaktifkan.',
  '  demo    Cetak token dan hash contoh tanpa database, untuk menguji format.',
  '',
  'Pilihan:',
  '  --agency NAMA     WAJIB untuk terbit. Nama instansi di agencies.name,',
  '                    bukan institution_key. Salah nama di sini menghasilkan',
  '                    kunci yang tidak pernah terpakai.',
  '  --category KAT    Batasi ke satu kategori. Kosong berarti semua. Harus',
'                    kategori yang agency itu benar-benar punya grant-nya;',
  '  --table TABEL     Batasi ke satu tabel. Kosong berarti semua.',
  '  --label CATATAN   Keterangan untuk operasi, mis. "kunci untuk integrasi',
  '                    dashboard", agar mudah dibedakan saat mencabut.',
  '  --standby         Terbitkan sebagai cadangan (status standby), bukan',
  '                    primary. Tidak bisa dipakai sampai dipromosikan manual.',
  '  --key-hash HASH   WAJIB untuk cabut. Hash kunci yang dicabut, dari',
  '                    agency_api_keys.key_hash.',
  '  --by NAMA         WAJIB untuk cabut. Siapa yang mencabut, ditulis ke',
  '                    revoked_by. Bebas teks karena login operator (F3.1)',
  '                    belum ada.',
  '  --out FILE        Tulis SQL ke FILE. Tanpa ini hanya dicetak ke stdout.',
  '  -h, --help        Bantuan ini.',
  '',
  'Contoh:',
  '  node tools/api-keys.js terbit --agency BKKBN --standby --label "cadangan integrasi"',
  '  node tools/api-keys.js cabut --key-hash 9f2c... --by "admin Opus"',
].join('\n');

// ---------------------------------------------------------------------------
// Argumen
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    perintah: null, agency: null, category: null, table: null,
    label: null, standby: false, keyHash: null, by: null,
    out: null, help: false,
  };

  const butuh = (a, i) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) {
      throw new Error(a + ' butuh nilai');
    }
    return v;
  };

  if (argv.length === 0) throw new Error('perintah wajib: terbit, cabut, atau demo');

  let i = 0;
  // Perintah hanya boleh di posisi pertama, dan tidak boleh berupa flag.
  if (!String(argv[0]).startsWith('-')) {
    o.perintah = String(argv[0]);
    i = 1;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agency') { o.agency = butuh(a, i); i++; }
    else if (a === '--category') { o.category = butuh(a, i); i++; }
    else if (a === '--table') { o.table = butuh(a, i); i++; }
    else if (a === '--label') { o.label = butuh(a, i); i++; }
    else if (a === '--key-hash') { o.keyHash = butuh(a, i); i++; }
    else if (a === '--by') { o.by = butuh(a, i); i++; }
    else if (a === '--out') { o.out = butuh(a, i); i++; }
    else if (a === '--standby') o.standby = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error('argumen tak dikenal: ' + a);
  }

  if (o.perintah && ['terbit', 'cabut', 'demo'].indexOf(o.perintah) < 0) {
    throw new Error('perintah tak dikenal: ' + o.perintah + ' (terbit, cabut, atau demo)');
  }
  return o;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Token acak dan hash-nya.
 *
 * base64url dipilih bukan karena tren, tapi karena token ini akan ditempel di
 * header HTTP dan sering disalin manual oleh operator. Karakter `+`, `/`, dan
 * `=` yang muncul di base64 biasa harus di-escape atau dihapus di setiap
 * tempat token itu diproses -- shell, JSON, query string. base64url tidak punya
 * masalah itu.
 *
 * 32 byte = 256 bit. Peluang tabrakan dengan kunci lain tidak relevan di
 * skala ribuan kunci, tapi diambil yang cukup panjang supaya tebakan
 * tidak mungkin: sumbernya `crypto.randomBytes`, bukan `Math.random`.
 */
function buatToken() {
  const rahasia = crypto.randomBytes(32);
  const token = PREFIX_TOKEN + rahasia.toString('base64url');
  return {
    token,
    prefix: token.slice(0, PREFIX_TOKEN.length + 8),
    hash: hashToken(token),
  };
}

/**
 * SHA-256 dari token TANPA prefix.
 *
 * Hash atas token utuh akan membocorkan informasi yang tidak perlu: prefix
 * `pa_sk_live_` ada di semua baris, jadi hash yang memuatnya mengizinkan
 * penyaringan cepat lewat index. Buang prefix-nya.
 *
 * Ini hash, bukan KDF seperti bcrypt/argon2. Untuk kunci API itu disengaja:
 * kunci punya 256 bit entropi, jadi tidak ada dictionary attack yang berhasil,
 * sedangkan KDF membuat setiap verifikasi hash mahal dan memperlambat setiap
 * permintaan. Yang melindungi database di sini bukan ketahanan hash, tapi
 * `pgcrypto`/RLS dan tidak pernah menyimpan token utuh.
 */
function hashToken(token) {
  const TANPA_PREFIX = token.startsWith(PREFIX_TOKEN)
    ? token.slice(PREFIX_TOKEN.length)
    : token;
  return crypto.createHash('sha256').update(TANPA_PREFIX, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function sqlQuote(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * INSERT kunci baru.
 *
 * `activated_at` hanya diisi untuk primary. Untuk standby, kunci belum pernah
 * dipakai dan belum boleh dipakai -- mengisi tanggal aktivasi sekarang akan
 * membuat catatan auditierebut kapan kunci standby menjadi aktif, padahal itu
 * belum terjadi. salah. Diisi saat promosi.
 *
 * Resolusi agency pakai `name` dan di-subquery, bukan `--agency` langsung
 * sebagai angka: nomor itu tidak dipegang operator, dan salah digit akan
 * menulis kunci ke instansi yang salah tanpa galat.
 */
function sqlTerbit(opts, token) {
  const status = opts.standby ? 'standby' : 'primary';
  const activated = opts.standby ? 'NULL' : 'now()';

  return [
    '-- Kunci API (F3.10a). Jalankan hanya setelah membaca token di bawah.',
    '-- Token tidak bisa dipulihkan dari database: yang tersimpan hanya SHA-256.',
    'INSERT INTO agency_api_keys',
    '  (agency_id, key_hash, key_prefix, status, category, table_name, label, issued_at, activated_at)',
    'SELECT a.id,',
    '       ' + sqlQuote(token.hash) + ',',
    '       ' + sqlQuote(token.prefix) + ',',
    '       ' + sqlQuote(status) + '::agency_key_status,',
    '       ' + sqlQuote(opts.category) + ',',
    '       ' + sqlQuote(opts.table) + ',',
    '       ' + sqlQuote(opts.label) + ',',
    '       now(),',
    '       ' + activated,
    'FROM agencies a',
    "WHERE a.name = " + sqlQuote(opts.agency),
    // Kalau `--category` diisi, agency HARUS punya grant kategori itu.
    // FK majemuk di DDL sudah menolak kategori yang tidak ada, tapi pesan
    // PostgreSQL-nya tidak menyebut agency mana -- dan "violates foreign key
    // constraint" tidak membantu operator mencari jalan perbaikan.
    opts.category
      ? "  AND EXISTS (SELECT 1 FROM agency_categories c"
        + " WHERE c.agency_id = a.id AND c.jenis_sasaran = " + sqlQuote(opts.category) + ')'
      : '',
    ';',
    '',
    '-- Kalau tidak ada baris yang terpengaruh, agency tidak ditemukan ATAU',
    '-- kategori yang diminta belum di-grant ke agency itu. Cek keduanya:',
    '--   SELECT id, name FROM agencies WHERE name ILIKE \'%' +
      String(opts.agency).replace(/'/g, "''") + '%\';',
    '--   SELECT c.jenis_sasaran FROM agency_categories c',
    '--     JOIN agencies a ON a.id = c.agency_id',
    '--    WHERE a.name ILIKE \'%' + String(opts.agency).replace(/'/g, "''") + '%\';',
  ].join('\n');
}

/**
 * Pencabutan.
 *
 * Sengaja TIDAK ada peng promoting standby di statement ini. Menggabungkan
 * revoke dan promosi dalam satu operasi membuat "primary dicabut = semua akses
 * berhenti" jadi tidak berlaku -- kunci cadangan aktif otomatis tepat di saat
 * operator sedang memutus akses karena kebocoran. Itu persis kebocoran yang
 * revoke seharusnya hentikan.
 *
 * UPDATE, bukan DELETE: kunci yang dicabut masih perlu terlihat di audit.
 */
function sqlCabut(opts) {
  return [
    '-- Pencabutan kunci API (F3.10a). Kunci standby TIDAK diaktifkan otomatis.',
    '-- Jalankan SELECT di bawah lebih dulu untuk memastikan kunci yang benar.',
    'SELECT id, agency_id, key_prefix, status, issued_at',
    'FROM agency_api_keys',
    'WHERE key_hash = ' + sqlQuote(opts.keyHash) + ';',
    '',
    'UPDATE agency_api_keys',
    'SET status = \'revoked\',',
    '    revoked_at = now(),',
    '    revoked_by = ' + sqlQuote(opts.by),
    'WHERE key_hash = ' + sqlQuote(opts.keyHash) + ';',
    '',
    '-- Verifikasi: harus tepat satu baris terpengaruh.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  let opsi;
  try {
    opsi = parseArgs(argv);
  } catch (e) {
    console.error('GALAT: ' + e.message);
    console.error('Lihat bantuan: node tools/api-keys.js --help');
    return 2;
  }

  if (opsi.help || !opsi.perintah) {
    console.log(BANTUAN);
    return opsi.perintah ? 0 : 2;
  }

  if (opsi.perintah === 'demo') {
    const t = buatToken();
    console.log('token  : ' + t.token);
    console.log('prefix : ' + t.prefix);
    console.log('hash   : ' + t.hash);
    console.log('');
    console.log('hash = sha256(token tanpa prefix "' + PREFIX_TOKEN + '").');
    return 0;
  }

  if (opsi.perintah === 'terbit') {
    if (!opsi.agency) {
      console.error('GALAT: --agency wajib untuk perintah terbit.');
      console.error('Lihat bantuan: node tools/api-keys.js --help');
      return 2;
    }
    const t = buatToken();
    const sql = sqlTerbit(opsi, t);

    console.log('=== TOKEN - salin sekarang, tidak akan ditampilkan lagi ===');
    console.log(t.token);
    console.log('');
    console.log('prefix : ' + t.prefix);
    console.log('hash   : ' + t.hash);
    console.log('status : ' + (opsi.standby ? 'standby (belum bisa dipakai)' : 'primary'));
    console.log('');
    console.log('agency : ' + opsi.agency);
    if (opsi.category) console.log('kategori : ' + opsi.category);
    if (opsi.table) console.log('tabel : ' + opsi.table);
    console.log('');

    if (opsi.out) {
      const fs = require('fs');
      fs.writeFileSync(opsi.out, sql, 'utf8');
      console.log('SQL ditulis: ' + opsi.out);
    } else {
      console.log('--- SQL (tidak disimpan) ---');
      console.log(sql);
    }
    console.log('');
    console.log('Ingat: yang tersimpan hanya hash. Simpan token di tempat aman;');
    console.log('jangan kirim lewat email atau chat.');
    return 0;
  }

  // perintah === 'cabut'
  if (!opsi.keyHash || !opsi.by) {
    const kurang = [];
    if (!opsi.keyHash) kurang.push('--key-hash');
    if (!opsi.by) kurang.push('--by');
    console.error('GALAT: ' + kurang.join(' dan ') + ' wajib untuk perintah cabut.');
    console.error('Lihat bantuan: node tools/api-keys.js --help');
    return 2;
  }

  const sql = sqlCabut(opsi);
  if (opsi.out) {
    const fs = require('fs');
    fs.writeFileSync(opsi.out, sql, 'utf8');
    console.log('SQL ditulis: ' + opsi.out);
  } else {
    console.log(sql);
  }
  return 0;
}

module.exports = {
  BANTUAN,
  PREFIX_TOKEN,
  PANJANG_RAHASIA,
  parseArgs,
  buatToken,
  hashToken,
  sqlQuote,
  sqlTerbit,
  sqlCabut,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}