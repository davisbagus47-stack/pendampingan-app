/**
 * Uji rate limit per instansi (FR-4.5, AT-14).
 *
 * Waktu dikontrol pemanggil. Tidak ada `Date.now()` di dalam limiter, jadi
 * setiap kasus di sini benar-benar menguji perilaku yang akan terjadi saat
 * dijalankan -- bukan perilaku yang berbeda karena jam berjalan lebih cepat
 * atau lambat di mesin ini.
 */

const rl = require('../lib/rate-limit.js');

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

function ok(name, kondisi) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); }
}

/** Limiter dengan jam yang bisa digeser manual. */
function limiter(opsi) {
  let jam = 1700000000000;
  const l = rl.buatLimiter(Object.assign({ sekarang: () => jam }, opsi || {}));
  return {
    l,
   majat(ms) { jam += ms; },
    jam() { return jam; },
  };
}

console.log('=== 1. Kuota per instansi ditegakkan ===');

{
  const { l, majat } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 3, burst: 0 });

  eq('permintaan 1 diizinkan', l.periksa('a1').allowed, true);
  eq('permintaan 2 diizinkan', l.periksa('a1').allowed, true);
  eq('permintaan 3 diizinkan', l.periksa('a1').allowed, true);

  const keempat = l.periksa('a1');
  eq('permintaan 4 ditolak', keempat.allowed, false);
  eq('alasan penolakan kuota', keempat.scope, 'kuota');
  eq('sisa bernilai nol', keempat.remaining, 0);
  ok('Retry-After ada saat ditolak', keempat.retryAfter > 0);
}

console.log('\n=== 2. Kuota dihitung terpisah per instansi ===');

{
  const { l } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 2, burst: 0 });
  l.aturKonfigurasi('a2', { kuota: 2, burst: 0 });

  l.periksa('a1');
  l.periksa('a1');
  eq('a1 sudah habis', l.periksa('a1').allowed, false);

  // Ini inti dari "per instansi": instansi lain tidak boleh ikut kena.
  eq('a2 tidak terpengaruh oleh a1', l.periksa('a2').allowed, true);
  eq('a2 masih punya sisa', l.periksa('a2').remaining, 0);

  // Satu Agencies rakus tidak boleh menguras instansinya sendiri lewat jalur
  // lain: id yang sama dengan konfigurasi berbeda harus tetap honoring kuota.
  eq('a1 tetap HABIS', l.periksa('a1').allowed, false);
}

console.log('\n=== 3. Jendela kuota berganti setelah waktunya ===');

{
  const { l, majat } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 2, burst: 0, jendelaMs: 60000 });

  l.periksa('a1');
  l.periksa('a1');
  eq('habis di dalam jendela', l.periksa('a1').allowed, false);

  majat(59999);
  eq('belum keluar jendela, masih ditolak', l.periksa('a1').allowed, false);

  majat(2);
  eq('sudah keluar jendela, diizinkan lagi', l.periksa('a1').allowed, true);
  eq('sisa dihitung dari nol', l.periksa('a1').remaining, 0);
}

console.log('\n=== 4. Burst dibatasi per detik ===');

{
  // Kuota longgar, burst ketat: inilah kondisi yang tidak bisa ditangkap
  // limiter kuota saja.
  const { l } = limiter({ burst: 3 });
  l.aturKonfigurasi('a1', { kuota: 100, burst: 3 });

  eq('burst 1', l.periksa('a1').allowed, true);
  eq('burst 2', l.periksa('a1').allowed, true);
  eq('burst 3', l.periksa('a1').allowed, true);

  const keempat = l.periksa('a1');
  eq('burst ke-4 ditolak', keempat.allowed, false);
  eq('alasan penolakan burst', keempat.scope, 'burst');
  eq('burst tunggu satu detik', keempat.retryAfter, 1);
  eq('kuota belum habis', keempat.remaining, 97);
}

console.log('\n=== 5. Burst meluncur sendiri setelah satu detik ===');

{
  const { l, majat } = limiter({ burst: 3 });
  l.aturKonfigurasi('a1', { kuota: 100, burst: 3 });

  l.periksa('a1'); l.periksa('a1'); l.periksa('a1');
  eq('burst sedang penuh', l.periksa('a1').allowed, false);

  majat(999);
  eq('masih dalam detik yang sama', l.periksa('a1').allowed, false);

  majat(2);
  eq('sudah lewat satu detik', l.periksa('a1').allowed, true);
  eq('dan bisa lagi', l.periksa('a1').allowed, true);
}

console.log('\n=== 6. Kuota tidak bocor ke instansi lain lewat burst ===');

{
  const { l } = limiter({ burst: 2 });
  l.aturKonfigurasi('a1', { kuota: 100, burst: 2 });
  l.aturKonfigurasi('a2', { kuota: 100, burst: 2 });

  l.periksa('a1'); l.periksa('a1');
  eq('a1 burst penuh', l.periksa('a1').allowed, false);
  eq('a2 burst sendiri', l.periksa('a2').allowed, true);
  eq('a2 burst sendiri lagi', l.periksa('a2').allowed, true);
}

console.log('\n=== 7. Instansi tanpa identitas tidak dapat di-limit dengan aman ===');

{
  const { l } = limiter({ burst: 0 });
  const tanpaId = l.periksa(undefined);
  eq('tanpa agency_id ditolak', tanpaId.allowed, false);
  eq('alasannya jelas', tanpaId.reason, 'agency-tidak-dikenali');

  // Ini yang berbahaya kalau diizinkan: Agency kosong jadi tempat semua request
  // yang tidak terautentikasi menumpuk, dan quota-nyabisa dikuras.
  eq('string kosong juga ditolak', l.periksa('').allowed, false);
  eq('tidak ada kuota tak terbatas', l.periksa(null).limit, 0);
}

console.log('\n=== 8. Konfigurasi per Agencies bisa berbeda ===');

{
  const { l } = limiter({ burst: 0 });
  l.aturKonfigurasi('kecil', { kuota: 1, burst: 0 });
  l.aturKonfigurasi('besar', { kuota: 10, burst: 0 });

  eq('instansi kecil: 1 boleh', l.periksa('kecil').allowed, true);
  eq('instansi kecil: ke-2 tidak', l.periksa('kecil').allowed, false);
  eq('instansi besar: ke-1 boleh', l.periksa('besar').allowed, true);
  eq('instansi besar: ke-2 boleh', l.periksa('besar').allowed, true);
}

console.log('\n=== 9. Tanpa konfigurasi dipakai nilai bawaan ===');

{
  const { l } = limiter({ burst: 0 });
  eq('bawaan berlaku', l.periksa('baru').limit, rl.BAWAAN.kuota);
  ok('bawaanKUATA positif', rl.BAWAAN.kuota > 0);
}

console.log('\n=== 10. Mengubah konfigurasi membuang state lama ===');

{
  const { l } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 2, burst: 0 });
  l.periksa('a1');
  l.periksa('a1');
  eq('habis dengan kuota lama', l.periksa('a1').allowed, false);

  // Menaikkan kuota harus langsung berlaku. Kalau state lama dipakai, permintaan
  // ini masih ditolak padahal kuota baru jauh lebih besar.
  l.aturKonfigurasi('a1', { kuota: 10, burst: 0 });
  eq('kuota baru langsung berlaku', l.periksa('a1').allowed, true);
  eq('sisa mengikuti kuota baru', l.periksa('a1').remaining, 8);

  // Menurunkan kuota juga harus berlaku, kalau tidak remarked an Agencies bisa
  // melewati kuota yang baru diperketat.
  l.aturKonfigurasi('a1', { kuota: 1, burst: 0 });
  eq('kuota kecil berlaku', l.periksa('a1').allowed, true);
  eq('dan langsung habis', l.periksa('a1').allowed, false);
}

console.log('\n=== 11. Permintaan yang DITOLAK tidak menambah kuota ===');

{
  const { l, majat } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 2, burst: 0 });

  l.periksa('a1');
  l.periksa('a1');
  eq('habis', l.periksa('a1').allowed, false);

  // Kalau permintaan yang ditolak ikut menambah penghitung, jendela berakhir
  // dengan pemakaian yang lebih besar dari kuota -- states bisausch jadi
  //yjumlah sebenarnya lebih banyak dari yang diizinkan.
  majat(1000);
  eq('sudah ditolak 3x, kuota tetap 2', l.periksa('a1').allowed, false);

  majat(60000);
  eq('jendela baru benar-benar kosong', l.periksa('a1').allowed, true);
  eq('sisa = kuota - 1', l.periksa('a1').remaining, 0);
}

console.log('\n=== 12. Header respons ===');

{
  const { headerRateLimit } = rl;
  const { l } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 2, burst: 0 });

  const pertama = l.periksa('a1');
  const h1 = headerRateLimit(pertama);
  eq('batas terkirim', h1['RateLimit-Limit'], '2');
  eq('sisa terkirim', h1['RateLimit-Remaining'], '1');
  ok('Retry-After tidak ada saat diizinkan', !('Retry-After' in h1));

  l.periksa('a1');
  const ditolak = l.periksa('a1');
  const h2 = headerRateLimit(ditolak);
  eq('sisa nol saat ditolak', h2['RateLimit-Remaining'], '0');
  ok('Retry-After wajib ada saat ditolak', 'Retry-After' in h2);
  ok('Retry-After bernilai positif', Number(h2['Retry-After']) > 0);
}

console.log('\n=== 13. Waktu yang tidak monoton tidak menambah kuota ===');

{
  // Jam server bisa melompat mundur (NTP, restart VM). Kalau penghitung
  //angers ke belakang, satu Agencies bisa mendapat kuota tak terbatas.
  const jam = [1000000, 1000000, 999000, 999000, 998000];
  let i = 0;
  const l = rl.buatLimiter({ burst: 0, sekarang: () => jam[Math.min(i++, jam.length - 1)] });
  l.aturKonfigurasi('a1', { kuota: 3, burst: 0 });

  const hasil = [];
  for (let n = 0; n < 5; n++) hasil.push(l.periksa('a1').allowed);
  ok('tidak ada yang diizinkan melebihi kuota', hasil.filter(Boolean).length <= 3);
  eq('tepat tiga diizinkan', hasil.filter(Boolean).length, 3);
}

console.log('\n=== 14. Fungsi lupa dan reset ===');

{
  const { l } = limiter({ burst: 0 });
  l.aturKonfigurasi('a1', { kuota: 1, burst: 0 });
  l.periksa('a1');
  eq('habis', l.periksa('a1').allowed, false);

  l.lupakan('a1');
  eq('setelah dilupakan, tersedia lagi', l.periksa('a1').allowed, true);

  l.periksa('a1');
  l.reset();
  eq('reset mengosongkan semua', l.periksa('a1').allowed, true);
}

console.log('\nlulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nADA YANG RUSAK. Rate limit ini belum bisa dipakai.');
  process.exit(1);
} else {
  console.log('\nSEMUA UJI LOLOS');
}
