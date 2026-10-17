'use strict';

/**
 * Job rekonsiliasi (F3.5, FR-5.8) -- pemanggil database + seam perbandingan
 * on-chain.
 *
 * Modul DB ini TIPIS seperti `tools/worker-anchor.js`: keputusan ada di
 * `lib/reconcil.js` yang murni, dan di sini hanya membaca database sebagai
 * peran `operator`, menjalankan keputusan, menulis hasilnya, lalu melaporkan.
 *
 * Satu pass (`sekali`) adalah:
 *
 *   1. Baca SEMUA `records` dan `chain_outbox` dalam satu transaksi peran
 *      `operator`. Peran dipilih karena `chain_outbox_operator_only` memberi
 *      operator hak apa pun atas outbox (F3.4 memakai alasan yang sama), dan
 *      `records_operator_all` memperbolehkan membaca seluruh records. Agen
 *      tidak bisa dipakai: ia hanya boleh melihat record miliknya sendiri,
 *      sedangkan rekonsiliasi harus melihat kehilangan outbox DI MANA PUN.
 *   2. Hitung kekurangan (`perluBackfill`) dan selisih (`periksa`) secara
 *      murni.
 *   3. Backfill baris outbox yang kurang -- `INSERT ... ON CONFLICT DO
 *      NOTHING`. Operator punya policy SELECT di `chain_outbox`, jadi resolusi
 *      konflik tidak ditolak RLS 42501 (kebalikan dari temuan F3.3 yang
 *      mengikat agen); `DO NOTHING` membuat job IDEMPOTEN saat dijalankan dua
 *      kali atau dua pekerja bersamaan.
 *   4. Laporkan: jumlah backfill, selisih per jenis, ringkasan status, dan
 *      hasil seam perbandingan on-chain.
 *
 * Perbandingan ke RANTAI (separuh FR-5.8 yang menuntut event on-chain) kini
 * TERSEDIA lewat `lib/reconcil-chain.js`: bila `ANCHOR_RPC_URL` dan
 * `ANCHOR_CONTRACT` terisi, pass membaca event `DataAnchored`/
 * `RecordSuperseded`, menyusun peta rantai, dan melaporkan selisih (hilang di
 * rantai, commitment menyimpang, ekstra di rantai). Kunci pribadi tidak
 * diperlukan untuk membaca. Seam `bandingkanRantai` tetap bisa disuntik
 * (dipakai uji live off-chain), dan bila prasarana baca belum ada, seam bawaan
 * menolak dengan jujur (bukan mengaku cocok).
 */

require('dotenv').config();

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const reconcil = require(path.join(__dirname, '..', 'lib', 'reconcil.js'));
const reconcilChain = require(path.join(__dirname, '..', 'lib', 'reconcil-chain.js'));

/**
 * Seam bercadangan: perbandingan on-chain TIDAK tersedia. Jujur menolak dan
 * menyebut alasan, BUKAN dilaporkan nol seperti andai sudah dibandingkan.
 *
 * @returns {Promise<{tersedia: boolean, catatan: string}>}
 */
async function bandingkanRantaiBawaan() {
  return {
    tersedia: false,
    catatan: 'perbandingan on-chain belum tersedia: isi ANCHOR_RPC_URL dan ANCHOR_CONTRACT',
  };
}

/**
 * Rakit pembanding rantai sungguhan dari variabel lingkungan, atau `null` bila
 * prasarana baca (RPC + alamat kontrak) belum lengkap. Kunci pribadi TIDAK
 * diperlukan: membaca event adalah operasi publik.
 *
 * Kegagalan MERAKIT (mis. alamat salah bentuk) tidak melempar ke pemanggil;
 * ia dikembalikan sebagai seam yang melaporkan `tersedia:false` beserta
 * alasannya, supaya separuh off-chain rekonsiliasi tetap berjalan dan laporan
 * tidak menyamar sebagai sukses.
 *
 * @param {object} [env]
 * @param {object} [deps] `{ provider, kontrak, dariBlok, sampaiBlok, krypto }`
 * @returns {function|null}
 */
function pembandingDariEnv(env, deps) {
  if (!reconcilChain.tersedia(env)) return null;
  try {
    return reconcilChain.buatPembandingDariEnv(env, deps);
  } catch (e) {
    const pesan = e && e.message ? e.message : String(e);
    return async () => ({
      tersedia: false,
      catatan: 'perbandingan on-chain gagal dirakit: ' + pesan,
    });
  }
}

/**
 * Panggil seam perbandingan dengan pengaman: kegagalan BACA rantai (RPC mati,
 * batas rentang log) tidak boleh menghapus laporan off-chain, tetapi juga tidak
 * boleh disembunyikan. Dikembalikan sebagai `tersedia:false` + pesan galat.
 *
 * @param {function} fn
 * @param {object[]} outbox
 * @returns {Promise<object>}
 */
async function panggilBandingkan(fn, outbox) {
  try {
    return await fn(outbox);
  } catch (e) {
    const pesan = e && e.message ? e.message : String(e);
    return {
      tersedia: false,
      catatan: 'baca rantai gagal: ' + pesan,
      galat: true,
    };
  }
}

/**
 * Jalankan satu pass rekonsiliasi terhadap PostgreSQL nyata.
 *
 * @param {object} [o]
 * @param {function} [o.bandingkanRantai] seam perbandingan event on-chain
 * @returns {Promise<object>} laporan pass
 */
async function sekali(o) {
  const bandingkanRantai = (o && typeof o.bandingkanRantai === 'function')
    ? o.bandingkanRantai
    : (pembandingDariEnv(process.env, o && o.deps) || bandingkanRantaiBawaan);

  return db.transaksi({ role: 'operator' }, async (client) => {
    const recs = (await client.query(
      'SELECT id, record_id, version, supersedes_id, record_hash, institution_id' +
      ' FROM records'
    )).rows.map((r) => ({
      id: r.id,
      record_id: r.record_id,
      version: Number(r.version),
      supersedes_id: r.supersedes_id === null ? null : r.supersedes_id,
      record_hash: r.record_hash,
      institution_id: r.institution_id,
    }));

    const outbox = (await client.query(
      'SELECT record_id, version, supersedes_id, commitment, chain_status' +
      ' FROM chain_outbox'
    )).rows.map((o) => ({
      record_id: o.record_id,
      version: Number(o.version),
      supersedes_id: o.supersedes_id === null ? null : String(o.supersedes_id),
      commitment: o.commitment,
      chain_status: o.chain_status,
    }));

    const kekurangan = reconcil.perluBackfill(recs, outbox);
    let dibackfill = 0;
    for (const rec of kekurangan) {
      const baris = reconcil.formulirBackfill(rec);
      const res = await client.query(
        'INSERT INTO chain_outbox (record_id, version, supersedes_id, commitment)' +
        ' VALUES ($1, $2, $3, $4)' +
        ' ON CONFLICT (record_id, version) DO NOTHING',
        [baris.record_id, baris.version, baris.supersedes_id, baris.commitment]
      );
      if (res.rowCount && res.rowCount > 0) dibackfill++;
    }

    const selisih = reconcil.periksa(recs, outbox);
    const status = reconcil.ringkas(outbox);
    // Baris outbox penuh diteruskan (bukan hanya record_id/version): pembanding
    // on-chain memerlukan commitment dan chain_status untuk mendeteksi
    // commitment yang menyimpang dan klaim `anchored` yang tak ada di rantai.
    const rantai = await panggilBandingkan(bandingkanRantai, outbox);

    return {
      records: recs.length,
      outbox: outbox.length,
      kekurangan: kekurangan.length,
      dibackfill,
      selisih,
      status,
      rantai,
    };
  });
}

if (require.main === module) {
  (async () => {
    try {
      const l = await sekali({});
      console.log('records        : ' + l.records);
      console.log('outbox         : ' + l.outbox);
      console.log('kekurangan     : ' + l.kekurangan);
      console.log('dibackfill     : ' + l.dibackfill);
      console.log('selisih yatim  : ' + l.selisih.yatim.length);
      console.log('selisih komitmen: ' + l.selisih.komitmen.length);
      console.log('selisih supers : ' + l.selisih.supersedes.length);
      console.log('status         : ' + JSON.stringify(l.status));
      if (l.rantai && l.rantai.tersedia) {
        console.log('rantai         : tersedia (blok ' + l.rantai.dariBlok + '..' + l.rantai.sampaiBlok +
          ', ' + l.rantai.jumlahEvent + ' event, ' + l.rantai.diRantai + ' versi unik)');
        console.log('  cocok        : ' + l.rantai.dicocokkan);
        console.log('  belum di rantai: ' + l.rantai.belumDiRantai);
        console.log('  selisih      : hilang=' + l.rantai.hilangDiRantai.length +
          ' komitmen=' + l.rantai.komitmen.length + ' ekstra=' + l.rantai.ekstraDiRantai.length +
          ' -> ' + (l.rantai.nihil ? 'NIHIL (M-3)' : 'ADA SELISIH'));
      } else {
        console.log('rantai         : ' + JSON.stringify(l.rantai));
      }
      if (l.selisih.yatim.length + l.selisih.komitmen.length + l.selisih.supersedes.length > 0) {
        console.log('\ncatatan selisih:');
        for (const y of l.selisih.yatim) {
          console.log('  yatim   ' + y.record_id + ' v' + y.version);
        }
        for (const k of l.selisih.komitmen) {
          console.log('  komitmen ' + k.record_id + ' v' + k.version + ' tersimpan=' +
            k.tersimpan.slice(0, 12) + ' dihitung=' + k.dihitung.slice(0, 12));
        }
        for (const s of l.selisih.supersedes) {
          console.log('  supers  ' + s.record_id + ' v' + s.version + ' tersimpan=' +
            s.tersimpan + ' dihitung=' + s.dihitung);
        }
      }
    } catch (e) {
      console.error('rekonsiliasi gagal: ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    } finally {
      await db.matikan();
    }
  })();
}

module.exports = { sekali, bandingkanRantaiBawaan, pembandingDariEnv, panggilBandingkan };