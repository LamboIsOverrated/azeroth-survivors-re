-- Install only during reviewed maintenance, before running the patched core.
-- Never convert characters automatically: reject if its existing engine is not InnoDB.
CREATE TABLE IF NOT EXISTS realm_bridge_inflight (
 operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 payload VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS realm_bridge_receipts (
 operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 payload VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 state ENUM('applied','rejected') NOT NULL,
 before_money INT UNSIGNED NOT NULL,
 after_money INT UNSIGNED NOT NULL,
 reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;
