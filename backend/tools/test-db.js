/**
 * Uji logika murni lib/db.js.
 *
 * Tidak ada koneksi database yang dibuka. Yang diuji adalah keputusan yang
 * terjadi SEBELUM `pg` dimuat dan koneksi dibuka -- persis bagian yang paling
 * mudah salah sambil tetap membuat uji deterministik tanpa jaringan:
 *
 *   1. `validasiIp`. Satu entri dengan IP aneh (hostname lokal, `::ffff:` yang
 *      tidak valid, teks bebas) cukup untuk membuat INSERT `access_log` gagal
 *      dan menyeret perjalanan antrean retry. Pemutusan harus terjadi di sini,
 *      di fungsi murni, bukan pada INSERT.
 *
 *   2. `status()` dan `urlDatabase()`. Status endpoint audit tidak boleh
 *      memicu koneksi atau memuat `pg` -- kalau itu terjadi, `GET
 *      /api/audit/status` punya efek samping, dan yang seharusnya "pemeriksaan
 *      kesehatan" jadi "pembangkit kegagalan".
 *
 *   3. Kesimpulan sink: tanpa `DATABASE_URL`, `sinkAccessLog` menolak lebih
 *      dulu sebelum menyentuh `pg`, karena menuntut koneksi tanpa URL akan
 *      selalu gagal.
 */

const db = require('../lib/db.js');

let passed = 0;
let failed = 0;

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat      : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

// ---------------------------------------------------------------------------
// 1. validasiIp
// ---------------------------------------------------------------------------
function ujiValidasiIp() {
  console.log('=== 1. validasiIp: pemutusan IP aneh sebelum INSERT ===');

  eq('IPv4 normal dipertahankan', db.validasiIp('192.168.1.10'), '192.168.1.10');
  eq('IPv4 10.x dipertahankan', db.validasiIp('10.0.0.7'), '10.0.0.7');
  eq('IPv4 dengan spasi dipangkas', db.validasiIp(' 203.0.113.5 '), '203.0.113.5');
  eq('IPv6 ringkas dipertahankan', db.validasiIp('::1'), '::1');
  eq('IPv6 penuh dipertahankan', db.validasiIp('2001:db8::2:1'), '2001:db8::2:1');
  eq('hostname lokal diubah null', db.validasiIp('localhost'), null);
  eq('hostname dns diubah null', db.validasiIp('server.internal'), null);
  eq('teks bebas diubah null', db.validasiIp('bukan-ip'), null);
  eq('nomor di luar jangkauan diubah null', db.validasiIp('999.1.1.1'), null);
  eq('salah segmen IPv4 diubah null', db.validasiIp('192.168.1.999'), null);
  eq('undefined diubah null', db.validasiIp(undefined), null);
  eq('null diubah null', db.validasiIp(null), null);
  eq('string kosong diubah null', db.validasiIp(''), null);
  eq('netmask /prefix ditolak', db.validasiIp('192.168.1.0/24'), null);
  eq('kolom 0-255 inklusif', db.validasiIp('0.0.0.0'), '0.0.0.0');
  eq('kolom 0-255 inklusif atas', db.validasiIp('255.255.255.255'), '255.255.255.255');
}

// ---------------------------------------------------------------------------
// 2. status/urlDatabase tidak memicu koneksi
// ---------------------------------------------------------------------------
async function ujiStatusTanpaEfek() {
  console.log('=== 2. status dan urlDatabase ===');

  const sebelum = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    eq('urlDatabase kosong tanpa URL', db.urlDatabase(), null);
    const st = db.status();
    eq('status.url null', st.url, null);
    eq('status.terpasang false', st.terpasang, false);
    eq('status.pool null', st.pool, null);
    eq('status.peran adalah app_api', st.peran, 'app_api');
  } finally {
    if (sebelum !== undefined) process.env.DATABASE_URL = sebelum;
  }

  process.env.DATABASE_URL = 'postgresql://pengguna:rahasia@host:5432/db';
  try {
    const st = db.status();
    ok('status.url dibuat saat URL ada', !!st.url && st.url.indexOf('host') >= 0);
    ok('status.url menyembunyikan kata sandi', st.url.indexOf('rahasia') < 0, st.url);
  } finally {
    if (sebelum !== undefined) process.env.DATABASE_URL = sebelum;
    else delete process.env.DATABASE_URL;
  }
}

// ---------------------------------------------------------------------------
// 3. sinkAccessLog tanpa DATABASE_URL
// ---------------------------------------------------------------------------
async function ujiSinkTanpaUrl() {
  console.log('=== 3. sinkAccessLog tanpa DATABASE_URL ditolak ===');

  const sebelum = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    let galat = null;
    try { await db.sinkAccessLog({ endpoint: '/api/sasaran' }); }
    catch (e) { galat = e; }
    ok('sink menolak tanpa URL', !!galat, galat && galat.message);
    ok('galat menyebut DATABASE_URL', !!galat && galat.message.indexOf('DATABASE_URL') >= 0);
  } finally {
    if (sebelum !== undefined) process.env.DATABASE_URL = sebelum;
  }
}

async function main() {
  ujiValidasiIp();
  await ujiStatusTanpaEfek();
  await ujiSinkTanpaUrl();

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log('\nSEMUA UJI LOLOS');
}

main().catch((e) => {
  console.error('Uji db.js gagal dijalankan:', e.message);
  process.exit(1);
});