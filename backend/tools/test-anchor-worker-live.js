'use strict';

/**
 * Uji live F3.4 (anchor worker) terhadap PostgreSQL nyata.
 *
 * `tools/test-anchor-worker.js` membuktikan mesin status yang murni (backoff,
 * putuskan, pantasDiproses) TANPA database dan TANPA blockchain. Yang TIDAK
 * bisa dibuktikannya ada di sini: klaim batch (`FOR UPDATE SKIP LOCKED`),
 * penjaga UPDATE (`WHERE chain_status = 'pending'`), dan alur nyata -- baris
 * pending diterima, baris yang belum waktunya tidak, baris anchored tidak
 * pernah disentuh lagi, dan percobaan yang habis berakhir terminal `failed`.
 *
 * Panggilan ke contract di-suntik sebagai `tandai` (bawaan worker adalah
 * penolak jujur "Foundry belum tersedia"); jadi pengujian ini membuktikan
 * kontrak suntikan terhadap Supabase, bukan isi contract yang menunggu F2.
 *
 * Kontrak:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0 -- bukan bukti pass.
 *   2. Semua baris di-watermark `uji-f4w-<ts>-<rand>` (record_id) dan dihapus
 *      lewat koneksi utama (BYPASSRLS) di `finally`.
 *   3. `chain_outbox` tidak punya FK ke `records`, jadi baris uji bisa dibuat
 *      langsung tanpa menumbuhkan records sungguhan.
 */

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const worker = require(path.join(__dirname, '..', 'tools', 'worker-anchor.js'));

try { require('dotenv').config(); } catch (e) {}

let passed = 0;
let failed = 0;

function ok(name, kondisi, detail) {
  if (kondisi) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name + (detail === undefined ? '' : '   [' + detail + ']'));
  }
}

function eq(name, aktual, diharapkan) {
  const a = JSON.stringify(aktual);
  const b = JSON.stringify(diharapkan);
  if (a === b) { passed++; console.log('LULUS  ' + name); }
  else {
    failed++;
    console.log('GAGAL  ' + name);
    console.log('        dapat     : ' + a);
    console.log('        diharapkan : ' + b);
  }
}

async function satu(tanda) {
  const res = await db.transaksi({ role: 'operator' }, async (client) => {
    return client.query(
      'SELECT id, record_id, version, chain_status, attempts, next_retry_at,' +
      ' last_error, tx_hash, anchored_at' +
      ' FROM chain_outbox WHERE record_id = $1',
      [tanda]
    );
  });
  // `tanda` di sini adalah record_id LENGKAP (sudah ber-prefix watermark), dan
  // setiap baris uji punya record_id sendiri, jadi tepat satu baris kembali.
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    record_id: r.record_id,
    version: Number(r.version),
    chain_status: r.chain_status,
    attempts: Number(r.attempts) || 0,
    next_retry_at: r.next_retry_at === null ? null : new Date(r.next_retry_at).getTime(),
    last_error: r.last_error,
    tx_hash: r.tx_hash,
    anchored_at: r.anchored_at === null ? null : new Date(r.anchored_at).getTime(),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return 1;
  }

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  // Bergantian: status uji maju walau akar isian waktu dibohongi. Gunakan
  // aturan kecil supaya jadwal ulang bisa terjadi tanpa menunggu menit.
  const aturan = { MAKS_CUBA: 2, TUNDA_AWAL: 1000, GANDA: 2, TUNDA_MAKS: 100000 };

  const tanda = 'uji-f4w-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const nama = (x) => tanda + '-' + x;

  try {
    const ins = [
      // A: sukses sekali -> anchored.
      { rec: nama(0), status: 'pending', retry: null },
      // B: belum waktunya -> tidak dipilih pass ini.
      { rec: nama(1), status: 'pending', retry: '2199-12-31T23:59:59Z' },
      // C: gagal dua kali (MAKS=2) -> retry lalu failed terminal.
      { rec: nama(2), status: 'pending', retry: null },
      // D: sudah anchored -> tidak boleh disentuh lagi.
      { rec: nama(3), status: 'anchored', retry: null },
    ];
    for (const i of ins) {
      await utama.query(
        'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment,' +
        ' chain_status, next_retry_at, tx_hash)' +
        ' VALUES ($1, 1, NULL, $2, $3, $4, $5)',
        [i.rec, 'c' + i.rec, i.status, i.retry, i.status === 'anchored' ? '0xseed' : null]
      );
    }

    // -----------------------------------------------------------------------
    // Pass 1: A -> anchored (tandai sukses), B tidak dipilih (belum waktunya),
    // C -> retry (tandai gagal), D diabaikan (anchored).
    // -----------------------------------------------------------------------
    console.log('\n=== Pass 1 ===');
    const r1 = await worker.sekali({
      aturan,
      batas: 10,
      now: Date.parse('2026-10-09T00:00:00Z'),
      tandai: async (baris) => {
        if (baris.record_id === nama(0)) return { ok: true, tx_hash: '0xhash-' + baris.record_id.slice(-6) };
        return { ok: false, error: 'RPC ke Anvil tidak menjawab' };
      },
    });
    const putA = r1.rincian.find((r) => r.record_id === nama(0));
    const putC = r1.rincian.find((r) => r.record_id === nama(2));
    ok('A sukses -> anchored', !!putA && putA.putusan === 'anchored');
    ok('C gagal -> retry', !!putC && putC.putusan === 'retry');
    ok('hanya 2 baris terproses (A dan C), B/D tidak', r1.dibaca === 2);

    const A = await satu(nama(0));
    const B = await satu(nama(1));
    const C = await satu(nama(2));
    const D = await satu(nama(3));

    eq('A menadi anchored', A.chain_status, 'anchored');
    ok('A punya tx_hash', A.tx_hash === '0xhash-' + nama(0).slice(-6));
    ok('A punya anchored_at', A.anchored_at !== null);
    eq('B masih pending (belum waktunya)', B.chain_status, 'pending');
    ok('B tidak pernah diproses (attempts 0)', B.attempts === 0);
    eq('C tetap pending (retry)', C.chain_status, 'pending');
    eq('C attempts menjadi 1', C.attempts, 1);
    ok('C next_retry_at terisi (masa depan)', C.next_retry_at !== null);
    ok('C last_error menjelaskan', (C.last_error || '').indexOf('RPC') >= 0);
    eq('D anchored tetap anchored (tidak disentuh)', D.chain_status, 'anchored');
    eq('D tx_hash tetap seed', D.tx_hash, '0xseed');

    // Coba anchor lagi untuk baris yang SUDAH anchored: tandai menjawab
    // "sudah tercatat" (kasus retry di sisi chain, AT-05). Worker menghormati
    // idempotensi: karena C sudah lanjut, hanya baris pending yang diproses.
    // -----------------------------------------------------------------------
    // Pass 2: jadwal C dimajukan (simulasi waktu berlalu) -> gagal lagi,
    // attempts 2 = MAKS_CUBA -> failed terminal.
    // -----------------------------------------------------------------------
    console.log('\n=== Pass 2 ===');
    await utama.query(
      'UPDATE chain_outbox SET next_retry_at = NULL WHERE record_id = $1',
      [nama(2)]
    );
    const r2 = await worker.sekali({
      aturan,
      batas: 10,
      now: Date.parse('2026-10-09T00:01:00Z'),
      tandai: async () => ({ ok: false, error: 'RPC ke Anvil tidak menjawab' }),
    });
    ok('C gagal lagi -> failed', !!r2.rincian.find((r) => r.record_id === nama(2)));
    const C2 = await satu(nama(2));
    eq('C2 status failed', C2.chain_status, 'failed');
    eq('C2 attempts 2', C2.attempts, 2);
    ok('C2 next_retry_at dikosongkan (terminal)', C2.next_retry_at === null);
    ok('C2 last_error berisi pesan RPC', (C2.last_error || '').indexOf('Anvil') >= 0);

    // -----------------------------------------------------------------------
    // Pass 3: tidak ada yang boleh terpilih lagi -- A, D anchored; C failed
    // terminal; B belum waktunya.
    // -----------------------------------------------------------------------
    console.log('\n=== Pass 3 ===');
    const r3 = await worker.klaim({ aturan, batas: 10 });
    ok('tidak ada baris tersisa yang dipilih', r3.rows.length === 0);

    console.log('\nRegresi: ' + passed + ' lulus, ' + failed + ' gagal.');
    return failed > 0 ? 1 : 0;
  } finally {
    // chain_outbox tidak punya FK ke records; bersihkan lewat record_id
    // ber-watermark (koneksi utama BYPASSRLS).
    await utama.query('DELETE FROM chain_outbox WHERE record_id LIKE $1', [tanda + '%']).catch(() => {});
    await utama.end().catch(() => {});
    await db.matikan();
  }
}

main().then((kode) => { process.exit(kode); });
