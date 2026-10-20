-- Rollback of src/postgres/paper-capital-model.sql. Drops only the objects that file creates.
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- Dropping a table drops its triggers; the functions follow after both tables.
-- The whole rollback is ONE DO block, so it is atomic also when this file runs outside the migration tool (psql -f in autocommit mode):
-- the block locks the declaration table ACCESS EXCLUSIVE first, then refuses while any declaration row exists, then drops every object
-- under the same lock. A writer that holds an uncommitted declaration makes the lock wait; after that writer commits, the count sees the
-- row and the block refuses. This file has no BEGIN or COMMIT: the migration tool runs it inside its own transaction.
-- O12 confirmed rollback (S4-3): rows are dropped only when the setting paper_capital_model.rollback_confirm_rows has the form <rows>:<xact id>
-- and both parts equal the number of rows counted under the lock and the id of the current transaction (pg_current_xact_id). Only
-- rollbackPaperCapitalModel sets it, inside its own transaction, after it has matched the row count AND the canonical sha256 of an earlier export
-- against the live rows under the same lock. A value from ALTER DATABASE or ROLE ... SET, PGOPTIONS or a session SET carries no valid
-- transaction id, so without the tool (psql -f, autocommit) any row refuses, as before S4-3.
DO $$
DECLARE
 found_rows bigint;
 confirmed_text text;
 confirmed boolean := false;
BEGIN
 LOCK TABLE public.paper_capital_models IN ACCESS EXCLUSIVE MODE;
 SELECT pg_catalog.count(*) INTO found_rows FROM public.paper_capital_models;
 confirmed_text := NULLIF(pg_catalog.current_setting('paper_capital_model.rollback_confirm_rows', true), '');
 IF confirmed_text ~ '^[0-9]{1,18}:[0-9]{1,20}$' THEN
  confirmed := pg_catalog.split_part(confirmed_text, ':', 1)::bigint = found_rows
   AND pg_catalog.split_part(confirmed_text, ':', 2) = pg_catalog.pg_current_xact_id()::text;
 END IF;
 IF found_rows > 0 AND NOT confirmed THEN
  RAISE EXCEPTION 'Paper capital model rollback refused: declaration rows exist' USING ERRCODE = 'P0001';
 END IF;
 DROP TABLE public.paper_capital_models;
 DROP TABLE public.paper_capital_model_schema;
 DROP FUNCTION public.paper_capital_model_guard();
 DROP FUNCTION public.paper_capital_model_stamp();
 DROP FUNCTION public.paper_capital_model_require_serializable();
 DROP FUNCTION public.paper_capital_model_freeze();
 DROP FUNCTION public.paper_capital_model_now_ms();
 DROP FUNCTION public.paper_capital_model_version();
END $$;
