'use strict';

/**
 * Anchor worker log audit (F4.3, FR-8.1) -- titik penyimpanan akar Merkle.
 *
 * Ringkas: baca SELURUH `access_log` (urut `id`), rangkai rantai hash (F4.1),
 * bangun pohon Merkle (F4.2), lalu simpan satu baris `audit_anchor`
 * `[1, n]` berisi akar + `head_hash`. Bukti inklusi (endpoint F4.3) nanti
 * dipotong ke batch ini supaya akarnya sama dengan yang tersimpan.
 *
 * Keterbatasan yang harus ditulis jujur
 * -------------------------------------
 * Selama Foundry belum ada, `tx_hash` selalu NULL: akar hanya tersimpan di
 * database yang SAMA dengan log. Jadi anchor off-chain ini membuktikan
 * "tidak diubah sejak di-anchor" relatif terhadap operator -- bukan relatif
 * terhadap pihak ketiga yang tidak mempercayai operator. Itu baru datang
 * ketika akar benar-benar dicatat on-chain (FR-7.4). Yang SEDANG dibuktikan di
 * sini adalah mekanisme T1 (bukti inklusi) berjalan end-to-end tanpa chain.
 *
 * Idempoten: kalau anchor terakhir sudah menutupi seluruh log dengan akar
 * yang sama, tidak ada baris baru ditulis.
 */

require('dotenv').config();

const path = require('path');

const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const auditLogChain = require(path.join(__dirname, '..', 'lib', 'audit-log-chain.js'));

const SQL_BACA = 'SELECT id, ts, actor_type, actor_id, category, params, result,' +
  ' response_rows, endpoint FROM access_log ORDER BY id ASC';

/**
 * Satu pass anchoring.
 *
 * @returns {Promise<{dilewati:boolean, alasan:string, jumlah_entri:number, anchor:object|null}>}
 */
async function sekali() {
  return db.transaksi({ role: 'operator' }, async (client) => {
    const rows = (await client.query(SQL_BACA)).rows;

    if (rows.length === 0) {
      return { dilewati: true, alasan: 'log kosong', jumlah_entri: 0, anchor: null };
    }

    const akar = auditLogChain.akarDariBaris(rows);
    const n = rows.length;

    const terakhirRes = await client.query(
      'SELECT id, from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at' +
      ' FROM audit_anchor ORDER BY to_seq DESC, id DESC LIMIT 1'
    );
    const terakhir = terakhirRes.rows[0] || null;

    if (terakhir && Number(terakhir.to_seq) === n && terakhir.root === akar.root) {
      return { dilewati: true, alasan: 'sudah ter-anchor dengan akar yang sama', jumlah_entri: n, anchor: terakhir };
    }

    const ins = await client.query(
      'INSERT INTO audit_anchor (from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at)' +
      ' VALUES (1, $1, $2, $3, $4, $5, NULL, now())' +
      ' RETURNING id, from_seq, to_seq, leaf_count, root, head_hash, algorithm, tx_hash, anchored_at',
      [n, akar.leaf_count, akar.root, akar.head_hash, akar.algorithm]
    );

    return { dilewati: false, alasan: null, jumlah_entri: n, anchor: ins.rows[0] };
  });
}

if (require.main === module) {
  (async () => {
    try {
      const ringkasan = await sekali();
      if (ringkasan.dilewati) {
        console.log('dilewati : ' + ringkasan.alasan);
        console.log('entri    : ' + ringkasan.jumlah_entri);
      } else {
        console.log('entri    : ' + ringkasan.jumlah_entri);
        console.log('akar     : ' + ringkasan.anchor.root);
        console.log('head     : ' + ringkasan.anchor.head_hash);
        console.log('anchor id: ' + ringkasan.anchor.id);
        console.log('tx_hash  : (NULL -- Foundry belum tersedia, anchor off-chain)');
      }
    } catch (e) {
      console.error('anchor log audit gagal: ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    } finally {
      await db.matikan();
    }
  })();
}

module.exports = { sekali, SQL_BACA };
