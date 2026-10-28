-- Reviewed maintenance upgrade for an earlier 001 schema with VARCHAR(16).
-- Fresh installations use the current 001 schema and do not need this statement.
ALTER TABLE realm_bridge_receipts
 MODIFY reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
