'use strict';

/**
 * Anchor worker (F3.4) -- pemanggil database + titik suntik panggilan chain.
 *
 * Modul ini TIPIS dengan sengaja: mesin status ada di `lib/anchor-worker.js`
 * yang murni dan teruji; database client dan panggilan ke contract di-suntik
 * dari sini sampai di luar, supaya F3.4 bisa dibuktikan ke Supabase sungguhan
 * tanpa memerlukan Foundry terpasang.
 *
 * Satu pass pekerjaan (fungsi `sekali`) adalah:
 *
 *   1. Klaim batch: `SELECT ... FOR UPDATE SKIP LOCKED` terhadap baris
 *      `chain_status = 'pending'` yang `next_retry_at` NULL atau sudah lewat,
 *      di transaksi peran `operator`. Kunci itu menghindari dua pekerja yang
 *      berjalan bersamaan mengambil baris yang sama. Setelah COMMIT, kunci
 *      dilepas -- panggilan ke contract TIDAK boleh terjadi dalam transaksi
 *      database yang terbuka (panggilan RPC bisa lambat).
 *   2. Untuk setiap baris, panggil `tandai(baris)` -- satu-satunya titik yang
 *      bersentuhan dengan blockchain. Kontrak jawaban:
 *        { ok: true, tx_hash } | { ok: false, error }
 *   3. Tulis ulang per baris berdasarkan `anchorWorker.putuskan`, dengan
 *      penjaga `WHERE id = $1 AND chain_status = 'pending'`. Andai pekerja
 *      runtuh setelah klaim, baris tidak pernah di-mark, pekerja berikut
 *      mengambilnya lagi; andai dua pekerja memproses baris yang sama, hanya
 *      satu UPDATE yang cocok dengan penjaga (idempotensi AT-05).
 *
 * Panggilan dari CLI (`node tools/worker-anchor.js`) memakai penanda bawaan
 * yang SELALU gagal dengan pesan yang menjelaskan diri -- supaya orang tidak
 * salah mengira outbox sudah di-anchor padahal belum ada contract yang
 * disuntikkan.
 */

require('dotenv').config();

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const anchorWorker = require(path.join(__dirname, '..', 'lib', 'anchor-worker.js'));
const anchorChain = require(path.join(__dirname, '..', 'lib', 'anchor-chain.js'));

/**
 * Penanda bawaan: rantai belum tersedia. Gagal dengan pesan yang jujur dan
 * berhenti di situ, BUKAN diam-diam mengabaikan baris.
 *
 * @param {object} baris baris outbox terpilih
 * @returns {Promise<{ok: boolean, error: string}>}
 */
async function penandaBawaan(baris) {
  return {
    ok: false,
    error: 'penanda chain belum dikonfigurasi (isi ANCHOR_RPC_URL, ' +
      'ANCHOR_CONTRACT, ANCHOR_PRIVATE_KEY) untuk ' +
      'record_id=' + baris.record_id + ' version=' + baris.version,
  };
}

/**
 * Ambil jenis sasaran (kategori) sebuah record dari tabel `records` untuk
 * diikat on-chain. Versi terbaru dimenangkan.
 *
 * @param {object} baris baris outbox
 * @returns {Promise<string|null>}
 */
async function kategoriDariDb(baris) {
  const rows = await db.transaksi({ role: 'operator' }, async (client) => {
    const res = await client.query(
      'SELECT jenis_sasaran FROM records WHERE record_id = $1' +
      ' ORDER BY version DESC LIMIT 1',
      [baris.record_id]
    );
    return res.rows;
  });
  return rows.length ? rows[0].jenis_sasaran : null;
}

/**
 * Resolusi leluhur untuk baris koreksi: `supersedes_id` menyimpan `records.id`
 * baris lama (BIGINT sebagai teks), kita perlu `record_id` + `version`-nya
 * supaya bisa memanggil `supersede(...)`.
 *
 * @param {object} baris baris outbox
 * @returns {Promise<{record_id: string, version: number}|null>}
 */
async function leluhurDariDb(baris) {
  const id = baris && baris.supersedes_id;
  if (id == null || !/^\d+$/.test(String(id))) return null;
  const rows = await db.transaksi({ role: 'operator' }, async (client) => {
    const res = await client.query(
      'SELECT record_id, version FROM records WHERE id = $1',
      [String(id)]
    );
    return res.rows;
  });
  if (!rows.length) return null;
  return { record_id: String(rows[0].record_id), version: Number(rows[0].version) };
}

/**
 * Pilih penanda: sungguhan bila konfigurasi chain lengkap, selain itu penanda
 * bawaan yang gagal dengan pesan menjelaskan.
 *
 * @param {object} [env] bawaan `process.env`
 * @returns {function}
 */
function pilihPenanda(env) {
  const e = env || process.env;
  if (anchorChain.tersedia(e)) {
    return anchorChain.buatPenandaDariEnv(e, {
      kategori: kategoriDariDb,
      leluhur: leluhurDariDb,
    });
  }
  return penandaBawaan;
}

/**
 * Jalankan KLAIM (ambil batch terpilih) saja. Dipisah supaya uji live bisa
 * memeriksa apa yang "akan diproses" tanpa memprosesnya.
 *
 * @param {object} o
 * @param {function} o.tandai panggilan chain
 * @param {number} [o.batas] ukuran batch
 * @returns {Promise<{rows: Array, klaim: number}>}
 */
async function klaim(o) {
  const batas = Number.isFinite(Number(o && o.batas)) ? Math.max(1, Number(o.batas)) : anchorWorker.BAWAAN.BATCH;
  const tandai = (o && typeof o.tandai === 'function') ? o.tandai : penandaBawaan;
  const rows = await db.transaksi({ role: 'operator' }, async (client) => {
    const res = await client.query(
      'SELECT id, record_id, version, supersedes_id, commitment, chain_status,' +
      ' attempts, next_retry_at, last_error, created_at' +
      ' FROM chain_outbox' +
      ' WHERE chain_status = $1' +
      '   AND (next_retry_at IS NULL OR next_retry_at <= now())' +
      ' ORDER BY next_retry_at NULLS FIRST, id' +
      ' LIMIT $2' +
      ' FOR UPDATE SKIP LOCKED',
      ['pending', batas]
    );
    return res.rows.map((r) => {
      // BIGINT boleh melebihi Number; record_id/version dipakai sebagai kunci
      // logis, bukan angka. attempts dijaga sebagai Number.
      return {
        id: r.id,
        record_id: r.record_id,
        version: Number(r.version),
        supersedes_id: r.supersedes_id === null || r.supersedes_id === undefined
          ? null : String(r.supersedes_id),
        commitment: r.commitment,
        chain_status: r.chain_status,
        attempts: Number(r.attempts) || 0,
        next_retry_at: r.next_retry_at === null ? null : new Date(r.next_retry_at).getTime(),
        last_error: r.last_error,
        created_at: r.created_at,
      };
    });
  });
  return { rows, klaim: rows.length, tandai };
}

/**
 * Satu pass anchor worker terhadap Supabase.
 *
 * @param {object} [o]
 * @param {function} [o.tandai] panggilan chain; bawaan `penandaBawaan`
 * @param {object} [o.aturan] penggantian nilai backoff/MAKS_CUBA
 * @param {number} [o.now] ms, untuk uji live tanpa menunggu backoff asli
 * @returns {Promise<object>} ringkasan pass
 */
async function sekali(o) {
  const opt = Object.assign({}, o);
  if (!opt.tandai) opt.tandai = pilihPenanda(process.env);
  const { rows, tandai } = await klaim(opt);
  const ringkasan = { dibaca: rows.length, anchored: 0, retry: 0, failed: 0, diabaikan: 0, galat: 0, rincian: [] };

  for (const baris of rows) {
    let hasil;
    try {
      hasil = await tandai(baris);
    } catch (e) {
      hasil = { ok: false, error: e && e.message ? e.message : String(e) };
    }

    const keputusan = anchorWorker.putuskan(baris, hasil, { now: o && o.now, aturan: o && o.aturan });
    if (keputusan.putusan === 'diabaikan') {
      ringkasan.diabaikan++;
      ringkasan.rincian.push({ record_id: baris.record_id, version: baris.version, putusan: 'diabaikan' });
      continue;
    }

    try {
      await db.transaksi({ role: 'operator' }, async (client) => {
        const res = await client.query(
          'UPDATE chain_outbox SET chain_status = $2, attempts = $3,' +
          ' next_retry_at = $4, last_error = $5, tx_hash = $6, anchored_at = $7' +
          ' WHERE id = $1 AND chain_status = $8',
          [
            baris.id,
            keputusan.kolom.chain_status,
            keputusan.kolom.attempts,
            keputusan.kolom.next_retry_at, // ISO string; PostgreSQL menerima timestamptz
            keputusan.kolom.last_error,
            keputusan.kolom.tx_hash || null,
            keputusan.kolom.anchored_at || null,
            'pending',
          ]
        );
        // rowCount 0 berarti baris sudah tidak pending (proses lain menang).
        if (res.rowCount === 1) ringkasan[keputusan.putusan]++;
        else ringkasan.diabaikan++;
      });
      ringkasan.rincian.push({
        record_id: baris.record_id,
        version: baris.version,
        putusan: keputusan.putusan,
      });
    } catch (e) {
      ringkasan.galat++;
      ringkasan.rincian.push({
        record_id: baris.record_id,
        version: baris.version,
        putusan: 'galat-update',
        pesan: e && e.message ? e.message : String(e),
      });
    }
  }

  return ringkasan;
}

if (require.main === module) {
  (async () => {
    try {
      const konf = anchorChain.konfigurasi(process.env);
      console.log('chain    : ' + (anchorChain.tersedia(process.env)
        ? konf.alamat + ' @ ' + konf.rpcUrl
        : 'belum dikonfigurasi (mode gagal-jujur)'));
      const ringkasan = await sekali({});
      console.log('dibaca   : ' + ringkasan.dibaca);
      console.log('anchored : ' + ringkasan.anchored);
      console.log('retry    : ' + ringkasan.retry);
      console.log('failed   : ' + ringkasan.failed);
      console.log('diabaikan: ' + ringkasan.diabaikan);
      console.log('galat    : ' + ringkasan.galat);
      if (ringkasan.rincian.length) {
        console.log('\ncatatan:');
        for (const r of ringkasan.rincian) {
          console.log('  ' + r.record_id + ' v' + r.version + ' -> ' + r.putusan +
            (r.pesan ? ' (' + r.pesan.slice(0, 120) + ')' : ''));
        }
      }
    } catch (e) {
      console.error('anchor worker gagal: ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    } finally {
      await db.matikan();
    }
  })();
}

module.exports = { sekali, klaim, penandaBawaan, pilihPenanda, kategoriDariDb, leluhurDariDb };