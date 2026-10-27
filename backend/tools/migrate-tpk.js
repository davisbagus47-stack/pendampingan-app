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
    await pool.query('ALTER TABLE tpk_members ADD COLUMN IF NOT EXISTS wallet_address TEXT');
    await pool.query('ALTER TABLE tpk_members ADD COLUMN IF NOT EXISTS wallet_created_at TIMESTAMPTZ');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_tpk_members_wallet_address ON tpk_members (wallet_address) WHERE wallet_address IS NOT NULL');
    await pool.query('GRANT SELECT ON tpk_members TO app_api');
    await pool.query('GRANT UPDATE (wallet_address, wallet_created_at) ON tpk_members TO app_api');
    await pool.query('ALTER TABLE tpk_members ENABLE ROW LEVEL SECURITY');
    await pool.query('ALTER TABLE tpk_members FORCE ROW LEVEL SECURITY');
    await pool.query('DROP POLICY IF EXISTS tpk_members_operator_all ON tpk_members');
    await pool.query("CREATE POLICY tpk_members_operator_all ON tpk_members FOR ALL USING (jwt_role() IN ('operator', 'admin')) WITH CHECK (jwt_role() IN ('operator', 'admin'))");
    console.log('Constraint tpk_members_nik_check updated.');
    const total = await pool.query('SELECT count(*)::int AS n FROM tpk_members');
    console.log(`Total tpk_members: ${total.rows[0].n}`);
    const security = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.tpk_members'::regclass");
    console.log(`RLS: ${JSON.stringify(security.rows[0])}`);
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
