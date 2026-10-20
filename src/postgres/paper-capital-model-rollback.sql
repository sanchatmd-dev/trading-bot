-- Rollback of src/postgres/paper-capital-model.sql. Drops only the objects that file creates.
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- Dropping a table drops its triggers; the functions follow after both tables.
-- The whole rollback is ONE DO block, so it is atomic also when this file runs outside the migration tool (psql -f in autocommit mode):
-- the block locks the declaration table ACCESS EXCLUSIVE first, then refuses while any declaration row exists, then drops every object
-- under the same lock. A writer that holds an uncommitted declaration makes the lock wait; after that writer commits, the count sees the
-- row and the block refuses. This file has no BEGIN or COMMIT: the migration tool runs it inside its own transaction.
DO $$
BEGIN
 LOCK TABLE public.paper_capital_models IN ACCESS EXCLUSIVE MODE;
 IF EXISTS (SELECT 1 FROM public.paper_capital_models) THEN
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
