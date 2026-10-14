'use strict';

/**
 * Uji access log berantai hash (F4.1).
 *
 * Yang diuji, dalam urutan kepentingan:
 *   1. Entri yang tidak diubah apa pun selalu lolos.
 *   2. Setiap bentuk manipulasi terdeteksi.
 *   3. Batasanjing modul ini terdeteksi danDIKUTIPkan apa adanya.
 *
 * Poin 3 penting. Rantai hash tidak bisa melihat pemotongan di ujung. Uji ini
 * sengaja MEMBUKTIKAN bahwa rantai yang dipotong di ujung tetap lolos tanpa
 * `expectedHead`, supaya laporan tidak mengklaim kekuatan yang tidak ada.
 */

const crypto = require('crypto');
const A = require('../lib/audit-chain.js');
const M = require('../lib/merkle.js');

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    if (extra !== undefined) console.log('        ' + extra);
  }
}

function eq(name, a, b) {
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else { failed++; console.log('GAGAL  ' + name); console.log('        diharapkan: ' + b); console.log('        diterima  : ' + a); }
}

function throwsWith(name, fn, re) {
  let pesan = null;
  try { fn(); } catch (e) { pesan = e.message; }
  const cocok = pesan !== null && (!re || re.test(pesan));
  ok(name, cocok, pesan === null ? 'tidak melempar error' : 'pesan: ' + pesan);
}

// ===========================================================================
console.log('=== 1. Entri dasar ===');

const ENTRI = [
  { seq: 1, ts: '2026-10-01T08:00:00.000Z', actor: 'agency:kota-bogor', action: 'query',
    resource: 'records', outcome: 'allow', detail: { desa: null, limit: 100 } },
  { seq: 2, ts: '2026-10-01T08:00:01.000Z', actor: 'agency:kota-bogor', action: 'query',
    resource: 'records', outcome: 'allow', detail: { desa: 'Sukamaju', limit: 50 } },
  { seq: 3, ts: '2026-10-01T08:00:02.000Z', actor: 'agency:kab-ciilegon', action: 'query',
    resource: 'records', outcome: 'deny', detail: { reason: 'DESA_NOT_GRANTED' } },
  { seq: 4, ts: '2026-10-01T08:00:03.000Z', actor: 'anon', action: 'query',
    resource: 'records', outcome: 'deny', detail: { reason: 'NO_CREDENTIAL' } },
];

{
  const chain = A.buildChain(ENTRI);
  eq('panjang rantai sama dengan jumlah entri', chain.length, ENTRI.length);
  eq('entri pertama prev_hash = genesis', chain[0].prev_hash, A.GENESIS_PREV);
  eq('genesis adalah 64 nol', A.GENESIS_PREV, '0'.repeat(64));
  ok('setiap entry_hash hex64',
    chain.every((e) => /^[0-9a-f]{64}$/.test(e.entry_hash)));
  ok('prev_hash entri n = entry_hash entri n-1',
    chain.slice(1).every((e, i) => e.prev_hash === chain[i].entry_hash));
  ok('seq berurutan 1..n', chain.every((e, i) => e.seq === i + 1));
  eq('rantai utuh lolos verifikasi', A.verifyChain(chain).ok, true);
}

{
  // Determinisme: log yang sama harus menghasilkan hash yang sama di dua proses.
  const a = A.buildChain(ENTRI);
  const b = A.buildChain(ENTRI);
  eq('buildChain determinis', JSON.stringify(a), JSON.stringify(b));
  eq('head sama', a[a.length - 1].entry_hash, b[b.length - 1].entry_hash);
}

// ===========================================================================
console.log('\n=== 2. Setiap bentuk manipulasi terdeteksi ===');

const chain = A.buildChain(ENTRI);

function withEntry(i, patch) {
  const c = chain.map((e) => ({ ...e }));
  c[i] = { ...c[i], ...patch };
  return c;
}

for (const [nama, patch, field] of [
  ['ubah timestamp', { ts: '2026-10-01T09:00:00.000Z' }, 'ts'],
  ['ubah actor', { actor: 'agency:pengguna' }, 'actor'],
  ['ubah action', { action: 'export' }, 'action'],
  ['ubah resource', { resource: 'access_log' }, 'resource'],
  ['ubah outcome deny menjadi allow', { outcome: 'allow' }, 'outcome'],
  ['ubah detail', { detail: { desa: 'Sukamaju', limit: 999 } }, 'detail'],
  ['ubah seq', { seq: 99 }, 'seq'],
]) {
  const hasil = A.verifyChain(withEntry(2, patch));
  ok('entri ke-3, ' + nama + ': terdeteksi', hasil.ok === false && hasil.brokenAt === 2,
    'ok=' + hasil.ok + ' brokenAt=' + hasil.brokenAt);
}

{
  // Menambah kunci asing berarti ada data yang TIDAK masuk hitungan hash.
  // Kalau dibiarkan, entri log bisa menyimpan informasi yang jejaknya tidak
  // terikat ke rantai -- persis yang harus dilarang di log audit.
  const denganAsing = withEntry(2, { catatanPribadi: 'x' });
  const hasil = A.verifyChain(denganAsing);
  eq('kunci asing: ditolak', hasil.ok, false);
  ok('kunci asing: brokenAt menunjuk entri yang benar', hasil.brokenAt === 2);
  ok('kunci asing: alasan menyebut data tidak masuk hash',
    /tidak masuk hitungan hash/.test(hasil.reason || ''), hasil.reason);

  // append() sendiri membuang kunci asing, jadi entri rantai tidak pernah
  // bisa dibangun dengan kunci asing sejak awal.
  const built = A.append(null, {
    seq: 1, ts: 'x', actor: 'a', action: 'q', outcome: 'allow', Sneket: 'x',
  });
  ok('append() membuang kunci asing saat membangun entri',
    Object.keys(built).every((k) => A.CHAIN_KEYS.has(k)));

  // pickChainFields() adalah jalur untuk baris database, yang membawa kolom
  // tambahan. Setelah diproyeksi, baris itu boleh diverifikasi.
  const barisDb = { ...chain[1], id: 42, institution_id: 'kota-bogor', created_at: '2026-10-01T08:00:09Z' };
  ok('baris database mentah ditolak (ada kolom tambahan)',
    A.verifyChain([chain[0], barisDb]).ok === false);
  const diproyeksi = A.pickChainFields(barisDb);
  eq('baris database setelah diproyeksi: kunci asing hilang',
    Object.keys(diproyeksi).filter((k) => !A.CHAIN_KEYS.has(k)).length, 0);
  ok('baris database setelah diproyeksi: verifikasi lulus',
    A.verifyChain([chain[0], diproyeksi]).ok === true);
}

{
  // Mengubah isi entri TANPA mengubah entry_hash harus tetap terdeteksi,
  // karena hash dihitung ulang dari isi.
  const dipalsu = withEntry(1, { outcome: 'allow' });
  dipalsu[1].outcome = 'deny';
  dipalsu[1].entry_hash = chain[1].entry_hash;
  const hasil = A.verifyChain(dipalsu);
  ok('isi entri diubah tapi entry_hash dipalsukan: terdeteksi', hasil.ok === false,
    'ok=' + hasil.ok);
  ok('alasan menyebut entry_hash tidak cocok dengan isi',
    /entry_hash tidak cocok dengan isi/.test(hasil.reason || ''), hasil.reason);
}

{
  // Penghapusan entri di tengah.
  const dipotong = chain.filter((_, i) => i !== 1);
  const hasil = A.verifyChain(dipotong);
  ok('entri ke-2 dihapus: terdeteksi', hasil.ok === false && hasil.brokenAt === 1);
  ok('entri awal dihapus: terdeteksi',
    A.verifyChain(chain.slice(2)).ok === false);
}

{
  // Pengurutan ulang.
  const ditukar = [chain[0], chain[2], chain[1], chain[3]];
  ok('dua entri ditukar: terdeteksi', A.verifyChain(ditukar).ok === false);
  ok('log dibalik: terdeteksi', A.verifyChain(chain.slice().reverse()).ok === false);
}

{
  // Entri disisipkan di tengah tanpa prev_hash yang benar.
  const disisip = chain.slice();
  const palsu = { ...chain[1], actor: 'agency:penyusup' };
  disisip.splice(2, 0, palsu);
  const hasil = A.verifyChain(disisip);
  ok('entri asing disisipkan: terdeteksi', hasil.ok === false,
    'ok=' + hasil.ok + ' brokenAt=' + hasil.brokenAt);
}

{
  // Rantai yang sama, tetapi dua entri kembar: seq harusBEDA atau hashes beda.
  const kembar = chain.slice();
  kembar[2] = { ...kembar[1], seq: 3 };
  const hasil = A.verifyChain(kembar);
  ok('entri kembar tidak bisa menyamar', hasil.ok === false);
}

{
  // Rantai terputus: entri pertama dengan prev_hash Genesis tapi seq = 1,
  // sedangkan entri kedua hilang -> tautan tidak akan cocok.
  const separuh = chain.slice(0, 2);
  const digabung = [separuh[0], { ...separuh[1], prev_hash: A.GENESIS_PREV }];
  ok('prev_hash dipalsukan: terdeteksi', A.verifyChain(digabung).ok === false);
}

{
  // Mengubah prev_hash jadi milik entri lain.
  const salahPrev = chain.map((e) => ({ ...e }));
  salahPrev[2].prev_hash = chain[0].entry_hash;
  ok('prev_hash diganti dengan hash entri lain: terdeteksi',
    A.verifyChain(salahPrev).ok === false);
}

// ===========================================================================
console.log('\n=== 3. Batas yang jujur: pemotongan di ujung ===');

{
  const dipotong = chain.slice(0, 3);
  const tanpaAnchor = A.verifyChain(dipotong);
  ok('DOKUMENTASI: rantai terpotong di ujung LOLOS tanpa expectedHead',
    tanpaAnchor.ok === true,
    'ini batas yang diketahui, bukan bug');

  const denganAnchor = A.verifyChain(dipotong, {
    expectedHead: chain[chain.length - 1].entry_hash,
  });
  ok('DOKUMENTASI: expectedHead yang benar akan menolak rantai terpotong',
    denganAnchor.ok === false);
  ok('DOKUMENTASI: alasan menyebut head tidak cocok dengan anchor',
    /head tidak cocok dengan anchor/.test(denganAnchor.reason || ''),
    denganAnchor.reason);

  eq('DOKUMENTASI: expectedHead yang cocok tetap diterima',
    A.verifyChain(chain, { expectedHead: chain[chain.length - 1].entry_hash }).ok, true);

  // Inilah alasan anchor dibutuhkan: tanpa anchor, pemotongan terakhir tak terlihat.
  eq('DOKUMENTASI: 1 dari 2 entri terakhir bisa dihapus tanpa terdeteksi',
    A.verifyChain(chain.slice(0, 3)).ok, true);
  eq('DOKUMENTASI: seluruh entri bisa dihapus tanpa terdeteksi',
    A.verifyChain([]).ok, true);
  ok('DOKUMENTASI: tetapi chain kosong + anchor non-genesis ditolak',
    A.verifyChain([], { expectedHead: chain[0].entry_hash }).ok === false);
}

// ===========================================================================
console.log('\n=== 4. Entri yang salah input ditolak saat dirangkai ===');

{
  const dasar = { ts: 'x', actor: 'a', action: 'q', outcome: 'allow' };
  throwsWith('seq bukan integer ditolak', () => A.append(null, { ...dasar, seq: 1.5 }), /seq harus integer/);
  throwsWith('seq tidak dimulai dari 1 ditolak', () => A.append(null, { ...dasar, seq: 2 }), /seq harus 1/);
  throwsWith('ts kosong ditolak', () => A.append(null, { ...dasar, seq: 1, ts: '' }), /ts harus string/);
  throwsWith('actor kosong ditolak', () => A.append(null, { ...dasar, seq: 1, actor: '' }), /actor wajib/);
  throwsWith('action kosong ditolak', () => A.append(null, { ...dasar, seq: 1, action: '' }), /action wajib/);
  throwsWith('outcome kosong ditolak',
    () => A.append(null, { ts: 'x', actor: 'a', action: 'q', seq: 1 }), /outcome wajib/);
  throwsWith('celah seq ditolak',
    () => A.append({ ...chain[0], seq: 1 }, { ...dasar, seq: 5 }), /seq harus 2/);
  throwsWith('buildChain dari non-array ditolak', () => A.buildChain('bukan array'), /harus array/);
}

{
  const hasil = A.verifyChain('bukan array');
  ok('verifyChain non-array tidak melempar', hasil.ok === false);
  ok('verifyChain non-array memberi alasan', typeof hasil.reason === 'string');

  const denganNull = chain.slice();
  denganNull[2] = null;
  ok('entri null terdeteksi', A.verifyChain(denganNull).ok === false);
  ok('entri non-object terdeteksi', A.verifyChain([chain[0], 'bukan object']).ok === false);

  const hashRusak = chain.slice();
  hashRusak[1].entry_hash = 'bukan-hash';
  const h = A.verifyChain(hashRusak);
  ok('entry_hash rusak terdeteksi', h.ok === false && /entry_hash bukan hex64/.test(h.reason));
}

// ===========================================================================
console.log('\n=== 5. Rantai panjang dan Patroli Merkle ===');

{
  const banyak = [];
  for (let i = 1; i <= 1000; i++) {
    banyak.push({
      seq: i,
      ts: '2026-10-01T08:00:00.000Z',
      actor: 'agency:kota-bogor',
      action: 'query',
      resource: 'records',
      outcome: 'allow',
      detail: { halaman: Math.floor((i - 1) / 50) + 1, baris: (i - 1) % 50 + 1 },
    });
  }
  const panjang = A.buildChain(banyak);
  eq('1000 entri terangkai', panjang.length, 1000);
  ok('1000 entri utuh lolos', A.verifyChain(panjang).ok);

  // Salah satu entri di tengah dirusak: harus terdeteksi, dan harus menunjuk
  // posisi yang benar -- kalau tidak, operator tidak tahu mana yang dikoreksi.
  const rusak = panjang.map((e) => ({ ...e }));
  rusak[499] = { ...rusak[499], outcome: 'deny' };
  const hasil = A.verifyChain(rusak);
  eq('entri ke-500 dirusak: brokenAt tepat', hasil.brokenAt, 499);
  ok('entri ke-500 dirusak: ditolak', hasil.ok === false);

  // Patroli Merkle: akar dari 1000 entry_hash, dan tiap entry punya bukti.
  const daun = panjang.map((e) => M.leafFromEntryHash(e.entry_hash));
  const pohon = M.buildTree(daun);
  const bukti = M.inclusionProof(pohon, 499);
  ok('akar Merkle dari 1000 entri memuat entri ke-500',
    M.verifyInclusion(pohon.root, bukti.leaf, bukti.proof));

  // Daun yang berubah harus mengubah akar -- inilah yang membuat pemotongan
  // atau penyisipan terdeteksi oleh anchor, bukan hanya oleh rantai.
  const daunRusak = daun.slice();
  daunRusak[499] = M.leafOf('daun-palsu');
  ok('mengubah satu entri mengubah akar Merkle',
    M.buildTree(daunRusak).root !== pohon.root);
}

console.log('\n' + '='.repeat(60));
console.log('lulus: ' + passed + '   gagal: ' + failed);
if (failed > 0) {
  console.log('\nRANTAI HASH AUDIT RUSAK.');
  process.exit(1);
}
console.log('SEMUA UJI LOLOS');
