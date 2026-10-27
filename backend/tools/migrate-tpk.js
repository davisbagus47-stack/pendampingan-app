'use strict';

require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const bad = await pool.query("SELECT count(*)::int AS n FROM tpk_members WHERE nik !~ '^[0-9]{16}$'");
    console.log(`Invalid existing NIK: ${bad.rows[0].n}`);
    await pool.query('ALTER TABLE tpk_members DROP CONSTRAINT IF EXISTS tpk_members_nik_check');
    await pool.query("ALTER TABLE tpk_members ADD CONSTRAINT tpk_members_nik_check CHECK (nik ~ '^[0-9]{16}$')");
    console.log('Constraint tpk_members_nik_check updated.');
    const total = await pool.query('SELECT count(*)::int AS n FROM tpk_members');
    console.log(`Total tpk_members: ${total.rows[0].n}`);
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
