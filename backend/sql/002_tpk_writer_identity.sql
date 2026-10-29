BEGIN;

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS writer_nik TEXT,
  ADD COLUMN IF NOT EXISTS writer_name TEXT,
  ADD COLUMN IF NOT EXISTS writer_wallet_address TEXT;

COMMENT ON COLUMN records.writer_nik IS
  'NIK anggota TPK yang menandatangani payload; tetap hanya di database.';
COMMENT ON COLUMN records.writer_name IS
  'Nama anggota TPK yang dipetakan dari tpk_members saat submit.';
COMMENT ON COLUMN records.writer_wallet_address IS
  'Wallet anggota TPK yang menandatangani payload; bukan wallet relayer on-chain.';

CREATE INDEX IF NOT EXISTS idx_records_writer_nik ON records (writer_nik);
CREATE INDEX IF NOT EXISTS idx_records_writer_wallet ON records (lower(writer_wallet_address))
  WHERE writer_wallet_address IS NOT NULL;

COMMIT;
