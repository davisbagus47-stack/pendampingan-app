/**
 * Uji verifikasi kredensial API (F3.10a).
 *
 * Semua di sini murni: `cariKunci` adalah fungsi yang dibuat uji ini sendiri,
 * jadi tidak ada PostgreSQL yang dibutuhkan dan tidak ada yang bisa gagal karena
 * koneksi.
 *
 * Yang paling dijaga di sini adalah pemisahan antara "kode yang sampai ke klien"
 * dan "alasan yang masuk ke log". Kalau keduanya dicampur, respons jadi
 * membocorkan informasi -- dan kalau dipisah salah, operator tidak akan pernah
 * tahu kunci dicabut masih dipakai.
 */

const {
  PREFIX_TOKEN, KODE,
  bacaToken, bentukValid, hashToken, verifikasi, cekScope, kirimUnauthorized,
} = require('../lib/api-key-auth.js');
const { buatToken } = require('./api-keys.js');

let lulus = 0;
let gagal = 0;

function eq(nama, dapat, harap) {
  const a = JSON.stringify(dapat);
  const b = JSON.stringify(harap);
  if (a === b) { console.log('lulus  ' + nama); lulus++; }
  else {
    console.log('GAGAL  ' + nama);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
    gagal++;
  }
}

function ok(nama, syarat) {
  if (syarat) { console.log('lulus  ' + nama); lulus++; }
  else { console.log('GAGAL  ' + nama); gagal++; }
}

function lemparThrows(nama, fn, pola) {
  try {
    fn();
    console.log('GAGAL  ' + nama + ' (tidak melempar)');
    gagal++;
  } catch (e) {
    if (!pola || String(e.message).includes(pola)) { console.log('lulus  ' + nama); lulus++; }
    else {
      console.log('GAGAL  ' + nama);
      console.log('        dapat     : ' + e.message);
      gagal++;
    }
  }
}

const req = (headers) => ({ headers: headers || {} });

/** Pabrik untuk `cariKunci` dengan satu baris kunci. */
function cariDengan(baris) {
  return async (hash) => (baris && baris.key_hash === hash ? baris : null);
}

const KUNCI_AKTIF = {
  id: 7, agency_id: 42, key_hash: 'x', key_prefix: 'pa_sk_live_ABCDEFGH',
  status: 'primary', category: null, table_name: null,
};

// ---------------------------------------------------------------------------
console.log('=== 1. Baca header ===');

eq('Authorization Bearer dibaca', bacaToken(req({ authorization: 'Bearer abc123' })), 'abc123');
eq('Bearer case-insensitive', bacaToken(req({ authorization: 'bearer abc123' })), 'abc123');
eq('spasi berlebih di Bearer', bacaToken(req({ authorization: 'Bearer   abc123  ' })), 'abc123');
eq('x-api-key dibaca sebagai alternatif', bacaToken(req({ 'x-api-key': 'abc123' })), 'abc123');
eq('Authorization menang dari x-api-key', bacaToken(req({ authorization: 'Bearer dariAuth', 'x-api-key': 'dariApiKey' })), 'dariAuth');
eq('tidak ada header = null', bacaToken(req({})), null);

// Header ada tapi salah format harus BEDA dari tidak ada. Kalau sama, operator
// akan melihat "kredensial tidak ada" padahal dia sudah mengirimnya.
eq('Authorization tanpa Bearer ditandai salah format',
  bacaToken(req({ authorization: 'abc123' })). salahFormat, true);
eq('hanya Basic ditandai salah format',
  bacaToken(req({ authorization: 'Basic YWJjOmRlZg==' })). salahFormat, true);
eq('header kosong = null', bacaToken(req({ authorization: '' })), null);
eq('req tanpa headers tidak melempar', bacaToken({}), null);

// ---------------------------------------------------------------------------
console.log('=== 2. Bentuk token ===');

const t = buatToken();
eq('token valid dari CLI dikenali', bentukValid(t.token), true);
eq('tanpa prefix ditolak', bentukValid(t.token.slice(PREFIX_TOKEN.length)), false);
eq('prefix salah ditolak', bentukValid('pb_sk_live_' + t.token.slice(PREFIX_TOKEN.length)), false);
eq('terlalu pendek ditolak', bentukValid(PREFIX_TOKEN + 'A'.repeat(42)), false);
eq('terlalu panjang ditolak', bentukValid(PREFIX_TOKEN + 'A'.repeat(44)), false);
eq('karakter base64 yang perlu escape ditolak', bentukValid(PREFIX_TOKEN + 'A'.repeat(42) + '+'), false);
eq('non-string ditolak', bentukValid(null), false);
eq('angka ditolak', bentukValid(12345), false);

// Hash harus sama dengan yang dipakai CLI dan generator token. Kalau tidak,
// kunci yang diterbitkan tidak akan pernah dikenali server.
eq('hash sama dengan tools/api-keys.js', hashToken(t.token), t.hash);
ok('hash mengabaikan prefix', hashToken(t.token) === hashToken(t.token.slice(PREFIX_TOKEN.length)));

// ---------------------------------------------------------------------------
console.log('=== 3. Kontrak hashToken dengan CLI ===');

// `--help` di CLI tidak boleh bisa menghasilkan hash berbeda dari server. Ini satu
// titik kegagalan yang gejalanya sangat menyesatkan: 401 untuk semua kunci,
// yang terlihat seperti bug identitas.
const toolsApiKeys = require('./api-keys.js');
eq('hash tools/api-keys.js sama dengan lib',
  toolsApiKeys.hashToken(t.token), hashToken(t.token));

// ---------------------------------------------------------------------------
console.log('=== 4. Tolak yang harus ditolak ===');

(async () => {
  const h = t.hash;
  const aktif = Object.assign({}, KUNCI_AKTIF, { key_hash: h });

  const r0 = await verifikasi({ token: null, cariKunci: cariDengan(aktif) });
  eq('tanpa kredensial', r0.kode, KODE.MISSING);
  eq('tanpa kredensial = 401', r0.status, undefined);

  const r1 = await verifikasi({ token: { salahFormat: true }, cariKunci: cariDengan(aktif) });
  eq('format header salah', r1.kode, KODE.MALFORMED);

  const r2 = await verifikasi({ token: 'tokenNgawur', cariKunci: cariDengan(aktif) });
  eq('bentuk token salah', r2.kode, KODE.MALFORMED);
  // Token salah bentuk dicatat sebagai bentuk, bukan utuh.
  ok('token salah bentuk TIDAK ikut masuk hasil', JSON.stringify(r2).indexOf('tokenNgawur') < 0);
  ok('bentuk tetap dilaporkan untuk diagnosis', typeof r2.bentuk === 'string');

  const r3 = await verifikasi({ token: t.token, cariKunci: async () => null });
  eq('kunci tidak dikenal', r3.kode, KODE.UNKNOWN);

  const r4 = await verifikasi({
    token: t.token,
    cariKunci: cariDengan(Object.assign({}, aktif, { status: 'revoked' })),
  });
  eq('kunci dicabut ditolak', r4.kode, KODE.REVOKED);
  eq('kunci dicabut tetap menyertakan agencyId', r4.agencyId, 42);

  const r5 = await verifikasi({
    token: t.token,
    cariKunci: cariDengan(Object.assign({}, aktif, { status: 'standby' })),
  });
  eq('kunci cadangan ditolak', r5.kode, KODE.STANDBY);
  ok('alasan standby menyebut belum diaktifkan', /belum diaktifkan/.test(r5.alasan));
  ok('alasan revoked menyebut dicabut', /dicabut/.test(r4.alasan));

  // -------------------------------------------------------------------------
  console.log('=== 5. Terima yang harus diterima ===');

  const r6 = await verifikasi({ token: t.token, cariKunci: cariDengan(aktif) });
  ok('kunci primary diterima', r6.ok === true);
  eq('agencyId diteruskan', r6.agencyId, 42);
  eq('keyId diteruskan', r6.keyId, 7);
  eq('scope kosong berarti semua kategori', r6.category, null);
  eq('keyPrefix diteruskan untuk audit', r6.keyPrefix, 'pa_sk_live_ABCDEFGH');

  // -------------------------------------------------------------------------
  console.log('=== 6. Scope kategori dan tabel ===');

  eq('tanpa batasan = semua lolos', cekScope(KUNCI_AKTIF, 'a', 'b').boleh, true);

  const kat = Object.assign({}, KUNCI_AKTIF, { category: 'a' });
  eq('kategori sama = boleh', cekScope(kat, 'a', 'b').boleh, true);
  eq('kategori berbeda = ditolak', cekScope(kat, 'c', 'b').boleh, false);
  // Tidak ada kategori di query berarti semua diminta: kunci yang dibatasi
  // kategori tidak boleh untuk query tanpa filter, karena itu berarti
  // "kembalikan semua termasuk kategori yang tidak diizinkan".
  eq('kunci berkategori ditolak saat kategori tidak dipersempit',
    cekScope(kat, null, 'b').boleh, false);
  ok('alasan scope menyebut kedua kategori', /kategori a/.test(cekScope(kat, 'c').alasan));

  const tbl = Object.assign({}, KUNCI_AKTIF, { table_name: 'records' });
  eq('tabel sama = boleh', cekScope(tbl, 'a', 'records').boleh, true);
  eq('tabel berbeda = ditolak', cekScope(tbl, 'a', 'chain_outbox').boleh, false);

  // -------------------------------------------------------------------------
  console.log('=== 7. Scope menghasilkan 403, bukan 401 ===');

  const r7 = await verifikasi({
    token: t.token,
    cariKunci: cariDengan(Object.assign({}, aktif, { category: 'a' })),
    diminta: 'c',
    dituju: 'b',
  });
  ok('scope ditolak', r7.ok === false);
  eq('kode scope', r7.kode, KODE.SCOPE);
  // 401 = kredensial salah (perbaiki klien). 403 = kredensial benar tapi
  // kewenangannya kurang (perluasan kunci). Bedanya menentukan siapa yang
  // harus bertindak.
  eq('scope = 403', r7.status, 403);

  const r8 = await verifikasi({ token: t.token, cariKunci: cariDengan(aktif) });
  eq('kunci tidak dikenal tetap 401 (tanpa status eksplisit)', r8.status, undefined);

  // -------------------------------------------------------------------------
  console.log('=== 8. Tidak ada kebocoran lewat pesan ===');

  // Pesan ke klien tidak boleh menyebut hash, agency, atau status kunci.
  const ditangkap = [];
  let statusTerakhir = 0;
  const resPalsu = {
    status(s) { statusTerakhir = s; return this; },
    json(body) { ditangkap.push({ status: statusTerakhir, body }); return this; },
  };
  kirimUnauthorized(resPalsu, r4);
  kirimUnauthorized(resPalsu, r7);

  eq('revoked -> 401', ditangkap[0].status, 401);
  eq('scope -> 403', ditangkap[1].status, 403);
  // Pesannya boleh menyebut kode mesin -- itu memang untuk dibaca mesin klien.
  // Yang dilarang adalah membocorkan FAKTA tentang kunci: hash, agency, atau
  // kunci ini sebenarnya pernah ada. Kode `KEY_REVOKED` tidak membocorkan apa pun:
  // klien sudah memegang token itu, jadi statusnya bisa diketahui dengan cara
  // lain, dan menyamarkannya hanya menambah pekerjaan tanpa menambah keamanan.
  //
  // Yang diuji di sini: tidak ada nilai dari database yang ikut terbawa. Kalau
  // suatu saat `res.json(hasil)` ikut dipanggil, seluruh objek termasuk agencyId
  // dan alasan akan bocor.
  const badan0 = JSON.stringify(ditangkap[0].body);
  ok('body 401 tidak memuat agency_id', badan0.indexOf('agency_id') < 0);
  ok('body 401 tidak memuat alasan internal', badan0.indexOf('dicabut') < 0 && badan0.indexOf('belum diaktifkan') < 0);
  ok('body 401 tidak memuat alasan apa pun dari server',
    Object.keys(ditangkap[0].body).every((k) => ['success', 'code', 'message'].indexOf(k) >= 0));
  eq('body 403 juga hanya tiga field',
    Object.keys(ditangkap[1].body).sort(), ['code', 'message', 'success']);
  ok('body 403 tidak menyebut kategori yang dibatasi',
    JSON.stringify(ditangkap[1].body).indexOf('kategori') < 0);
  ok('pesan tidak menyebut agency',
    JSON.stringify(ditangkap[0].body).indexOf('42') < 0);
  ok('pesan tidak menyebut hash',
    JSON.stringify(ditangkap[0].body).indexOf(t.hash) < 0);
  eq('body selalu punya success false', ditangkap[0].body.success, false);
  ok('body punya kode mesin', ditangkap[0].body.code === KODE.REVOKED);

  // -------------------------------------------------------------------------
  console.log('=== 9. Urutan: verifikasi sebelum kuota ===');

  // Ini yang ditegakkan oleh pasang() di index.js, dan diuji di situ. Di sini
  // hanya memastikan `cariKunci` tidak dipanggil untuk token cacat -- kalau
  // dipanggil, satu token salah ketik sudah membebani database.
  let dipanggil = 0;
  const hitung = async () => { dipanggil++; return null; };
  await verifikasi({ token: 'cacat', cariKunci: hitung });
  await verifikasi({ token: null, cariKunci: hitung });
  await verifikasi({ token: { salahFormat: true }, cariKunci: hitung });
  eq('cariKunci tidak dipanggil untuk token yang pasti gagal', dipanggil, 0);

  await verifikasi({ token: t.token, cariKunci: hitung });
  eq('cariKunci dipanggil sekali untuk token berbentuk benar', dipanggil, 1);

  // -------------------------------------------------------------------------
  console.log('=== 10. Kode mesin stabil ===');

  // Kode ini ditulis ke access_log dan dibaca operasi. Mengubahnya tanpa
  // migration akan membuat log lama tidak bisa ditafsirkan.
  eq('jumlah kode', Object.keys(KODE).length, 6);
  eq('MISSING', KODE.MISSING, 'MISSING_KEY');
  eq('MALFORMED', KODE.MALFORMED, 'MALFORMED_KEY');
  eq('UNKNOWN', KODE.UNKNOWN, 'UNKNOWN_KEY');
  eq('REVOKED', KODE.REVOKED, 'KEY_REVOKED');
  eq('STANDBY', KODE.STANDBY, 'KEY_STANDBY');
  eq('SCOPE', KODE.SCOPE, 'KEY_SCOPE_DENIED');

  // Semua kode yang bisa muncul di respons harus punya nilai yang diizinkan
  // oleh CHECK constraint access_log, kalau tidak entri log gagal ditulis.
  //
  // Semuanya `denied_auth`, termasuk scope dan termasuk tidak ada kredensial.
  // Itu bukan kebosanan:
  //
  //   - Tidak ada kredensial itu kondisi NORMAL (klien belum punya kunci), bukan
  //     kegagalan internal. Kalau dicatat `error`, dashboard akan_IsError menampilkan
  //     semua setiap ada klien baru yang belum mengirim kunci, dan
  //    -operator berhenti mempercayai nilai `error`.
  //   - Scope kunci juga `denied_auth`, BUKAN `denied_category`.
  //     `denied_category` milik layer RLS (`agency_categories`): "instansi ini
  //     tidak punya grant untuk kategori itu". Scope kunci adalah masalah
  //     KREDENSIAL: kuncinya benar, kewenangannya tidak cukup. Bedanya membuat
  //     operasi bisa membedakan dua kegagalan yang perbaikannya sama sekali berbeda --
  //     satu minta grant baru, satu minta penerbitan kunci baru.
  const accessLog = require('../lib/access-log.js');
  const hasilDari = accessLog.hasilDari;
  eq('MISSING -> denied_auth', hasilDari({ status: 401, kode: KODE.MISSING }), accessLog.HASIL.DENIED_AUTH);
  eq('MALFORMED -> denied_auth', hasilDari({ status: 401, kode: KODE.MALFORMED }), accessLog.HASIL.DENIED_AUTH);
  eq('UNKNOWN -> denied_auth', hasilDari({ status: 401, kode: KODE.UNKNOWN }), accessLog.HASIL.DENIED_AUTH);
  eq('REVOKED -> denied_auth', hasilDari({ status: 401, kode: KODE.REVOKED }), accessLog.HASIL.DENIED_AUTH);
  eq('STANDBY -> denied_auth', hasilDari({ status: 401, kode: KODE.STANDBY }), accessLog.HASIL.DENIED_AUTH);

  // Scope SANGAT TIDAK boleh jadi denied_category, meski statusnya 403 sama
  // dengan penolakan kategori. Pernah tercampur, operator akan melihat
  // "kategori ditolak" lalu memodifikasi grant, padahal masalahnya kunci.
  eq('SCOPE 403 -> denied_auth, bukan denied_category',
    hasilDari({ status: 403, kode: KODE.SCOPE }), accessLog.HASIL.DENIED_AUTH);
  ok('scope tidak tercampur dengan penolakan kategori',
    hasilDari({ status: 403, kode: KODE.SCOPE }) !== accessLog.HASIL.DENIED_CATEGORY);
  eq('kategori RLS tetap denied_category (tidak berubah)',
    hasilDari({ status: 403, kode: 'CATEGORY_NOT_GRANTED' }), accessLog.HASIL.DENIED_CATEGORY);

  console.log('\nlulus: ' + lulus + '  gagal: ' + gagal);
  if (gagal === 0) console.log('SEMUA UJI LOLOS');
  process.exit(gagal === 0 ? 0 : 1);
})();