'use strict';

/**
 * Uji live F3.5 (job rekonsiliasi off-chain) terhadap PostgreSQL nyata.
 *
 * `tools/test-reconcil.js` membuktikan keputusan murni: mana record yang
 * kurang outbox, commitment/supersedes yang menyimpang, dan ringkasan status.
 * Yang TIDAK bisa dibuktikannya ada di sini:
 *
 *   1. Backfill benar-benar menulis baris `chain_outbox` untuk records tanpa
 *      outbox (celah hand-off F3.3: backfill operator F3.8a tidak pernah
 *      mengantrekan outbox), di bawah peran `operator` -- dan `INSERT ... ON
 *      CONFLICT DO NOTHING` DITERIMA peran operator (operator punya policy
 *      SELECT di chain_outbox), kontras dengan 42501 yang mengikat agen di
 *      F3.3.
 *   2. Selisih dideteksi dari database sungguhan: yatim (outbox tanpa
 *      records), komitmen menyimpang, supersedes menyimpang.
 *   3. Seam perbandingan on-chain tersambung: nilai yang disuntikkan ke
 *      `bandingkanRantai` sampai ke laporan pass.
 *   4. Job idempoten: baris outbox yang sudah ada (sehat) TIDAK digandakan.
 *
 * Kontrak sama dengan suite live lain:
 *   1. Tanpa `DATABASE_URL`, suite DILEWATI dengan exit 0 -- bukan bukti pass.
 *   2. Semua baris di-watermark `uji-f5w-<ts>-<rand>` dan dihapus lewat
 *      koneksi utama (BYPASSRLS) di `finally`, termasuk bila uji gagal
 *      di tengah.
 */

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const c = require(path.join(__dirname, '..', 'lib', 'canonical.js'));
const workerRecon = require(path.join(__dirname, '..', 'tools', 'worker-recon.js'));

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

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\nDLEWATI: tidak ada DATABASE_URL. Uji live tidak dijalankan (bukan bukti pass).');
    return;
  }

  const { Pool } = require('pg');
  const utama = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  utama.on('error', () => {});

  const tanda = 'uji-f5w-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const kim = tanda + '-a';

  try {
    // -----------------------------------------------------------------------
    // 0. Seed: satu instansi aktif; 4 record (tiga pemakai operator F1.8 dan
    //    satu yang sudah punya outbox sehat); satu outbox yatim tanpa records.
    //    Semua hash dibangun lewat `canonical` yang sama dengan produksi.
    // -----------------------------------------------------------------------
    await utama.query(
      'INSERT INTO agencies (institution_key, name, status) VALUES ($1, $2, $3)',
      [kim, 'Instansi uji F3.5', 'active']
    );

    const r1 = tanda + '-r1';
    const h1 = c.recordHash({ nik: '3273011234560001', namaLengkap: 'Uji F3.5 R1' });
    const h1v2 = c.recordHash({ nik: '3273011234560001', namaLengkap: 'Uji F3.5 R1', bbSekarang: '60,0' });
    // R1 versi 1 + koreksi versi 2, TANPA outbox: ini baris backfill operator
    // yang harus diisi job rekonsiliasi. created_by = 'operator' (bukan
    // 'agency:<id>') adalah penanda jalur F1.8.
    const id1 = (await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash,' +
      ' payload_json, sections, created_by, jenis_sasaran, nama_kecamatan, nama_desa,' +
      ' nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date)' +
      ' RETURNING id',
      [r1, 'active', kim, h1, JSON.stringify({ nik: '3273011234560001', namaLengkap: 'Uji F3.5 R1' }),
        [], 'operator', 'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK',
        '3273011234560001', 'Uji F3.5 R1', '2026-10-05']
    )).rows[0].id;

    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash,' +
      ' payload_json, sections, created_by, supersedes_id, jenis_sasaran,' +
      ' nama_kecamatan, nama_desa, nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::date)',
      [r1, 'active', kim, h1v2, JSON.stringify({ nik: '3273011234560001', namaLengkap: 'Uji F3.5 R1', bbSekarang: '60,0' }),
        [], 'operator', id1, 'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK',
        '3273011234560001', 'Uji F3.5 R1', '2026-10-05']
    );

    // R2: SUDAH punya outbox sehat -- recon tidak boleh menggandakannya.
    const r2 = tanda + '-r2';
    const h2 = c.recordHash({ nik: '3273011234560002', namaLengkap: 'Uji F3.5 R2' });
    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash,' +
      ' payload_json, sections, created_by, jenis_sasaran, nama_kecamatan, nama_desa,' +
      ' nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date)',
      [r2, 'active', kim, h2, JSON.stringify({ nik: '3273011234560002', namaLengkap: 'Uji F3.5 R2' }),
        [], 'agency:' + 1, 'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK',
        '3273011234560002', 'Uji F3.5 R2', '2026-10-05']
    );
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)',
      [r2, c.commitment(h2, kim), 'pending']
    );

    // R3: outbox ada tapi commitment DIPALSUKAN -- harus dilaporkan komitmen.
    const r3 = tanda + '-r3';
    const h3 = c.recordHash({ nik: '3273011234560003', namaLengkap: 'Uji F3.5 R3' });
    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash,' +
      ' payload_json, sections, created_by, jenis_sasaran, nama_kecamatan, nama_desa,' +
      ' nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date)',
      [r3, 'active', kim, h3, JSON.stringify({ nik: '3273011234560003', namaLengkap: 'Uji F3.5 R3' }),
        [], 'agency:' + 1, 'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK',
        '3273011234560003', 'Uji F3.5 R3', '2026-10-05']
    );
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)',
      [r3, '2'.repeat(64), 'pending']
    );

    // R4: outbox ada tapi supersedes_id salah -- harus dilaporkan supersedes.
    const r4 = tanda + '-r4';
    const h4 = c.recordHash({ nik: '3273011234560004', namaLengkap: 'Uji F3.5 R4' });
    await utama.query(
      'INSERT INTO records (record_id, version, status, institution_id, record_hash,' +
      ' payload_json, sections, created_by, jenis_sasaran, nama_kecamatan, nama_desa,' +
      ' nama_tpk, peran_tpk, nik, nama_lengkap, tanggal_kunjungan)' +
      ' VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date)',
      [r4, 'active', kim, h4, JSON.stringify({ nik: '3273011234560004', namaLengkap: 'Uji F3.5 R4' }),
        [], 'agency:' + 1, 'Baduta', 'Ciwaringin', 'Bantarjati', 'Siti Aminah', 'TPK',
        '3273011234560004', 'Uji F3.5 R4', '2026-10-05']
    );
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, $2, $3, $4)',
      [r4, '999999', c.commitment(h4, kim), 'pending']
    );

    // Yatim: outbox tanpa records sama sekali.
    await utama.query(
      'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment, chain_status)' +
      ' VALUES ($1, 1, NULL, $2, $3)',
      [tanda + '-yatim', 'e'.repeat(64), 'pending']
    );

    // -----------------------------------------------------------------------
    // 1. Jalankan satu pass rekonsiliasi dengan seam rantai tersuntik.
    // -----------------------------------------------------------------------
    console.log('=== 1. Satu pass job rekonsiliasi ===');
    const hasilSeam = { tersedia: false, catatan: 'suntikan uji: chain belum ada' };
    const laporan = await workerRecon.sekali({ bandingkanRantai: async () => hasilSeam });

    eq('records yang dibaca (R1 x2 + R2 + R3 + R4)', laporan.records, 5);
    eq('outbox yang dibaca (sebelum backfill: R2 + R3 + R4 + yatim)', laporan.outbox, 4);
    eq('kekurangan: R1 v1 + R1 v2', laporan.kekurangan, 2);
    eq('dibackfill: 2', laporan.dibackfill, 2);
    eq('selisih yatim: 1', laporan.selisih.yatim.length, 1);
    eq('selisih komitmen: 1 (R3)', laporan.selisih.komitmen.map((k) => k.record_id), [r3]);
    eq('selisih komitmen: dihitung ulang benar', laporan.selisih.komitmen[0].dihitung, c.commitment(h3, kim));
    eq('selisih supersedes: 1 (R4)', laporan.selisih.supersedes.map((v) => v.record_id), [r4]);
    eq('seam rantai tersambung ke laporan', laporan.rantai, hasilSeam);

    // -----------------------------------------------------------------------
    // 2. Baris hasil backfill di database: commitment/supersedes yang benar.
    // -----------------------------------------------------------------------
    console.log('\n=== 2. Baris backfill di chain_outbox ===');

    const obR1 = (await utama.query(
      'SELECT version, supersedes_id, commitment FROM chain_outbox WHERE record_id = $1 ORDER BY version ASC',
      [r1]
    )).rows.map((b) => ({
      version: Number(b.version),
      supersedes_id: b.supersedes_id === null || b.supersedes_id === undefined ? null : String(b.supersedes_id),
      commitment: b.commitment,
    }));
    eq('R1 kini punya dua baris outbox (v1, v2)', obR1.length, 2);
    eq('R1 v1: commitment pemilik', obR1[0].commitment, c.commitment(h1, kim));
    eq('R1 v1: supersedes null', obR1[0].supersedes_id, null);
    eq('R1 v2: commitment pemilik (hash v2)', obR1[1].commitment, c.commitment(h1v2, kim));
    eq('R1 v2: supersedes menunjuk id v1 (TEXT)', obR1[1].supersedes_id, String(id1));

    const obR2 = (await utama.query(
      'SELECT version, commitment, chain_status FROM chain_outbox WHERE record_id = $1',
      [r2]
    )).rows;
    eq('R2 (sudah sehat) tetap satu baris, tidak digandakan', obR2.length, 1);
    eq('R2 commitment tetap utuh', obR2[0].commitment, c.commitment(h2, kim));
    eq('R2 tetap pending', obR2[0].chain_status, 'pending');

    // -----------------------------------------------------------------------
    // 3. Idempotensi: jalankan pass kedua; tidak ada backfill tambahan.
    // -----------------------------------------------------------------------
    console.log('\n=== 3. Pass kedua (idempoten) ===');
    const ulang = await workerRecon.sekali({ bandingkanRantai: async () => hasilSeam });
    eq('pass kedua: kekurangan 0', ulang.kekurangan, 0);
    eq('pass kedua: dibackfill 0', ulang.dibackfill, 0);
    eq('pass kedua: selisih tidak berubah', ulang.selisih.yatim.length + ulang.selisih.komitmen.length + ulang.selisih.supersedes.length, 3);
  } finally {
    // chain_outbox dihapus lewat record_id ber-watermark SEBELUM records dan
    // agencies (outbox menunjuk record_id logis, bukan FK id).
    await utama.query(
      'DELETE FROM chain_outbox WHERE record_id LIKE $1', [tanda + '%']
    ).catch(() => {});
    await utama.query(
      'DELETE FROM records WHERE institution_id = $1', [kim]
    ).catch(() => {});
    await utama.query(
      'DELETE FROM agencies WHERE institution_key = $1', [kim]
    ).catch(() => {});
    await db.matikan();
    await utama.end().catch(() => {});
  }

  console.log('\nlulus: ' + passed + '   gagal: ' + failed);
  if (failed > 0) process.exit(1);
  console.log('\nSEMUA UJI LOLOS (live terhadap database)');
}

main().catch((e) => {
  console.error('\nUji live F3.5 gagal dijalankan: ' + (e && e.stack || e));
  try { require('../lib/db.js').matikan().catch(() => {}); } catch (e2) {}
  process.exit(1);
});