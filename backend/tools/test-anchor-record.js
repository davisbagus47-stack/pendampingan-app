/**
 * Uji `lib/anchor-record.js` (F3.4 lanjutan) -- anchor per-record SINKRON.
 *
 * Yang diuji bukan pemanggilan blockchain sungguhan (itu urusan
 * test-anchor-chain.js), melainkan sifat yang membuat modul ini aman dipakai
 * dari web server:
 *
 *   1. Pengiriman BERURUTAN. Dua panggilan bersamaan tidak boleh saling
 *      menimpa nonce; satu-satunya bukti soal itu adalah "berapa pengiriman
 *      yang berjalan pada saat yang sama".
 *   2. Kegagalan satu pengiriman tidak menghalangi pengiriman berikutnya.
 *   3. Pemilihan `anchor` vs `supersede` mengikuti `supersedes_id`.
 *   4. Chain yang belum dikonfigurasi menghasilkan `tersedia:false`, bukan
 *      lemparan galat -- supaya outbox tetap bisa dibiarkan `pending`.
 *
 * Kontrak palsu meniru bentuk ethers: `kontrak.anchor` adalah fungsi yang
 * punya properti `.staticCall`, dan nilainya punya `.wait()`.
 */

const anchorRecord = require('../lib/anchor-record.js');

let lulus = 0;
let gagal = 0;

function ok(nama, syarat, detail) {
  if (syarat) { console.log('lulus  ' + nama); lulus++; }
  else { console.log('GAGAL  ' + nama + (detail ? ' (' + detail + ')' : '')); gagal++; }
}

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

const ENV = {
  ANCHOR_RPC_URL: 'http://127.0.0.1:8545',
  ANCHOR_CONTRACT: '0x' + '1'.repeat(40),
  ANCHOR_PRIVATE_KEY: '0x' + '2'.repeat(64),
};

const KOMITMEN = 'a'.repeat(64);

/**
 * Kontrak palsu.
 *
 * @param {object} [o]
 * @param {number} [o.tunda] ms sebelum kirim "selesai" (untuk menguji antrean)
 * @param {string} [o.gagalAnchor] pesan galat staticCall untuk `anchor`
 */
function kontrakPalsu(o) {
  const opt = o || {};
  const log = { panggilan: [], aktif: 0, maksAktif: 0 };

  function buat(nama) {
    const fn = async (...args) => {
      log.panggilan.push({ nama, args });
      log.aktif++;
      log.maksAktif = Math.max(log.maksAktif, log.aktif);
      await new Promise((r) => setTimeout(r, opt.tunda || 0));
      log.aktif--;
      const hash = '0x' + (log.panggilan.length).toString(16).padStart(64, '0');
      return { hash, wait: async () => ({ hash }) };
    };
    fn.staticCall = async (...args) => {
      if (nama === 'anchor' && opt.gagalAnchor) {
        const e = new Error(opt.gagalAnchor);
        e.reason = opt.gagalAnchor;
        throw e;
      }
      return true;
    };
    return fn;
  }

  return {
    anchor: buat('anchor'),
    supersede: buat('supersede'),
    _log: log,
  };
}

function baris(o) {
  return Object.assign({
    record_id: '11111111-1111-1111-1111-111111111111',
    version: 1,
    commitment: KOMITMEN,
    jenis_sasaran: 'Catin',
    supersedes_id: null,
    old_record_id: null,
    old_version: null,
  }, o || {});
}

async function main() {
  // -------------------------------------------------------------------------
  console.log('=== 1. Chain belum dikonfigurasi: tersedia:false, bukan lemparan ===');

  anchorRecord.aturUlang();
  const h1 = await anchorRecord.anchorkan(baris(), { env: {} });
  eq('ok = false', h1.ok, false);
  eq('tersedia = false', h1.tersedia, false);
  ok('ada pesan galat', typeof h1.error === 'string' && h1.error.length > 0);

  // -------------------------------------------------------------------------
  console.log('=== 2. Sukses: memanggil anchor dan mengembalikan tx_hash ===');

  anchorRecord.aturUlang();
  const k2 = kontrakPalsu();
  const h2 = await anchorRecord.anchorkan(baris(), { env: ENV, kontrak: k2 });
  eq('ok = true', h2.ok, true);
  ok('tx_hash 32 byte', /^0x[0-9a-f]{64}$/.test(String(h2.tx_hash)));
  eq('memanggil anchor sekali', k2._log.panggilan.length, 1);
  eq('nama fungsi = anchor', k2._log.panggilan[0].nama, 'anchor');
  eq('argumen version', String(k2._log.panggilan[0].args[1]), '1');

  // -------------------------------------------------------------------------
  console.log('=== 3. Koreksi memakai supersede ===');

  anchorRecord.aturUlang();
  const k3 = kontrakPalsu();
  const h3 = await anchorRecord.anchorkan(baris({
    record_id: '22222222-2222-2222-2222-222222222222',
    version: 2,
    supersedes_id: '7',
    old_record_id: '11111111-1111-1111-1111-111111111111',
    old_version: 1,
  }), { env: ENV, kontrak: k3 });
  eq('ok = true', h3.ok, true);
  eq('nama fungsi = supersede', k3._log.panggilan[0].nama, 'supersede');
  eq('argumen old_record_id', k3._log.panggilan[0].args[0], '11111111-1111-1111-1111-111111111111');
  eq('argumen old_version', String(k3._log.panggilan[0].args[1]), '1');

  // -------------------------------------------------------------------------
  console.log('=== 4. Berurutan: dua kirim bersamaan tidak tumpang tindih ===');

  anchorRecord.aturUlang();
  const k4 = kontrakPalsu({ tunda: 40 });
  const [a4, b4] = await Promise.all([
    anchorRecord.anchorkan(baris({ record_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), { env: ENV, kontrak: k4 }),
    anchorRecord.anchorkan(baris({ record_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }), { env: ENV, kontrak: k4 }),
  ]);
  eq('keduanya ok', [a4.ok, b4.ok], [true, true]);
  eq('tidak pernah dua panggilan bersamaan', k4._log.maksAktif, 1);
  eq('dua tx diterbitkan', k4._log.panggilan.length, 2);
  ok('tx_hash berbeda', a4.tx_hash !== b4.tx_hash);

  // -------------------------------------------------------------------------
  console.log('=== 5. Kegagalan tidak menghentikan pengiriman berikutnya ===');

  anchorRecord.aturUlang();
  const k5 = kontrakPalsu({ gagalAnchor: 'execution reverted: jumlah' });
  const h5a = await anchorRecord.anchorkan(baris(), { env: ENV, kontrak: k5 });
  eq('yang gagal ok = false', h5a.ok, false);
  ok('pesan galat diringkas', /execution reverted/.test(String(h5a.error)));

  // Kirim berikutnya lewat kontrak sehat harus tetap jalan.
  const k5b = kontrakPalsu();
  const h5b = await anchorRecord.anchorkan(baris(), { env: ENV, kontrak: k5b });
  eq('yang berikutnya ok = true', h5b.ok, true);

  console.log('\nlulus: ' + lulus + '  gagal: ' + gagal);
  if (gagal === 0) console.log('SEMUA UJI LOLOS');
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('GALAT tak terduga:', e && e.stack ? e.stack : e);
  process.exit(1);
});
