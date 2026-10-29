-- CMaNGOS Classic de8f7299 GameEventMgr::Initialize reads the previous events,
-- then issues TRUNCATE TABLE game_event_status before rebuilding active rows.
-- World.cpp:2328 also truncates character_queststatus_weekly during weekly reset.
-- These are the two CharacterDatabase cleanup TRUNCATE sites in this exact pin.
-- Optional WorldDatabase zone-generation TRUNCATE paths receive no new grant.
-- Grant only on the two transient bookkeeping tables, never on the schema.
-- Review with the operator; this file is not automatically executed.
-- Bootstrap must retain this statement after its REVOKE ALL / schema DML grants.
GRANT DROP ON `classiccharacters`.`game_event_status` TO 'mangos'@'%';
GRANT DROP ON `classiccharacters`.`character_queststatus_weekly` TO 'mangos'@'%';
