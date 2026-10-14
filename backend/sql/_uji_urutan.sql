CREATE TABLE records (
  id BIGSERIAL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES agencies(institution_key)
);
CREATE TABLE agencies (
  institution_key TEXT NOT NULL PRIMARY KEY
);
