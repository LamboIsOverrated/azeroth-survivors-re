-- CMaNGOS Classic de8f7299 GameEventMgr::Initialize reads the previous events,
-- then issues TRUNCATE TABLE game_event_status before rebuilding active rows.
-- MariaDB requires DROP for TRUNCATE. Grant only on this transient status table.
-- Review with the operator; this file is not automatically executed.
-- Bootstrap must retain this statement after its REVOKE ALL / schema DML grants.
GRANT DROP ON `classiccharacters`.`game_event_status` TO 'mangos'@'%';
