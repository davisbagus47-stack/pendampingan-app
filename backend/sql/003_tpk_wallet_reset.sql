BEGIN;

CREATE TABLE IF NOT EXISTS tpk_wallet_reset_codes (
  id          BIGSERIAL PRIMARY KEY,
  nik         TEXT NOT NULL REFERENCES tpk_members(nik) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpk_wallet_reset_codes_nik
  ON tpk_wallet_reset_codes (nik, expires_at);
ALTER TABLE tpk_wallet_reset_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpk_wallet_reset_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tpk_wallet_reset_codes_operator_all ON tpk_wallet_reset_codes;
CREATE POLICY tpk_wallet_reset_codes_operator_all ON tpk_wallet_reset_codes
  FOR ALL USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON tpk_wallet_reset_codes TO app_api;
GRANT USAGE, SELECT ON SEQUENCE tpk_wallet_reset_codes_id_seq TO app_api;
GRANT SELECT, UPDATE ON tpk_members TO app_api;

CREATE TABLE IF NOT EXISTS tpk_wallet_history (
  id                  BIGSERIAL PRIMARY KEY,
  nik                 TEXT NOT NULL,
  old_wallet_address  TEXT NOT NULL,
  new_wallet_address  TEXT NOT NULL,
  reset_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpk_wallet_history_nik
  ON tpk_wallet_history (nik, reset_at);
ALTER TABLE tpk_wallet_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpk_wallet_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tpk_wallet_history_operator_all ON tpk_wallet_history;
CREATE POLICY tpk_wallet_history_operator_all ON tpk_wallet_history
  FOR ALL USING (jwt_role() IN ('operator', 'admin'))
  WITH CHECK (jwt_role() IN ('operator', 'admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON tpk_wallet_history TO app_api;
GRANT USAGE, SELECT ON SEQUENCE tpk_wallet_history_id_seq TO app_api;

COMMIT;
