'use strict';

/**
 * Seed instansi operator data center (F1.1 varian form -> records).
 *
 * Form publik `POST /api/submit` tidak membawa kunci instansi, tetapi record
 * yang dihasilkannya WAJIB punya `institution_id` (NOT NULL REFERENCES
 * agencies.institution_key). Instansi itulah "pemilik" setiap record yang
 * masuk lewat form -- dan karenanya menjadi X pada
 * commitment_X = SHA256(record_hash || X) (ADR-3, FR-4.3).
 *
 * Perkakas ini membuat SATU instansi operator secara IDEMPOTEN: dijalankan
 * berkali-kali tidak menambah baris dan tidak mengubah `name`/`status` yang
 * sudah ada. Kunci bisnis `institution_key` sengaja TIDAK pernah diubah
 * setelah ada record, karena ia terikat ke dalam commitment.
 *
 * Kunci & nama dapat diganti lewat variabel lingkungan:
 *   FORM_INSTITUTION_KEY   (bawaan: operator-data-center)
 *   FORM_INSTITUTION_NAME  (bawaan: Operator Data Center)
 *
 * Jalankan:
 *   node tools/seed-operator.js
 */

require('dotenv').config();

const path = require('path');
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));

/**
 * Kunci bisnis instansi operator. Sama dengan yang dibaca index.js saat form
 * menulis record, jadi mengubah satu harus mengubah keduanya.
 */
const KUNCI = String(process.env.FORM_INSTITUTION_KEY || 'operator-data-center').trim();
const NAMA = String(process.env.FORM_INSTITUTION_NAME || 'Operator Data Center').trim();

async function main() {
  if (!db.urlDatabase()) {
    throw new Error('DATABASE_URL belum diset; seed butuh PostgreSQL.');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(KUNCI)) {
    throw new Error(
      'FORM_INSTITUTION_KEY tidak sah: ' + KUNCI +
      ' (harus slug huruf kecil: huruf, angka, tanda hubung)'
    );
  }

  // Peran `operator`: policy agencies_operator_insert mengizinkannya, dan
  // `agency` sengaja TIDAK dipakai supaya instansi tidak menulis dirinya
  // sendiri di luar prosedur.
  const baris = await db.transaksi({ role: 'operator' }, async (client) => {
    await client.query(
      'INSERT INTO agencies (institution_key, name, status)' +
      " VALUES ($1, $2, 'active')" +
      ' ON CONFLICT (institution_key) DO NOTHING',
      [KUNCI, NAMA]
    );
    // Tambah grant kategori untuk instansi operator (idempoten).
    for (const kat of ['Catin', 'Ibu Hamil', 'Ibu Nifas', 'Baduta', 'Balita']) {
      await client.query(
        'INSERT INTO agency_categories (agency_id, jenis_sasaran)' +
        ' SELECT id, $2 FROM agencies WHERE institution_key = $1' +
        ' ON CONFLICT (agency_id, jenis_sasaran) DO NOTHING',
        [KUNCI, kat]
      );
    }
    const res = await client.query(
      'SELECT id, institution_key, name, status FROM agencies WHERE institution_key = $1',
      [KUNCI]
    );
    return res.rows[0];
  });

  console.log('instansi operator siap:');
  console.log('  institution_key : ' + baris.institution_key);
  console.log('  name            : ' + baris.name);
  console.log('  status          : ' + baris.status + ' (id=' + baris.id + ')');
  console.log('\nForm publik akan memakai institution_key ini untuk setiap record.');
}

main()
  .catch((e) => {
    console.error('seed-operator gagal: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  })
  .finally(() => db.matikan());
