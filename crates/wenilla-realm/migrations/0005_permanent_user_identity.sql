-- Run on the dedicated migration connection with foreign_keys disabled, before serving.
-- Rebuild only the parent table: preserve every ID and every dependent ownership row.
CREATE TABLE users_permanent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'player')),
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO users_permanent SELECT id,username,display_name,role,created_at,disabled FROM users;
DROP TABLE users;
ALTER TABLE users_permanent RENAME TO users;
