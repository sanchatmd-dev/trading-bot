-- GH2 hardening of check_bot_parent() (local candidate; applied offline and separately from schema 14).
-- Finding GH1-BOT-PARENT: the bot_parent_guard trigger function of schema.sql reads users by unqualified name under the caller's
-- search_path, and pg_temp is searched first for relations. A runtime role with the database TEMP privilege (the PUBLIC default)
-- could create a TEMP table named users and make a child of a non-top-level bot pass the guard.
-- Here the same logic is replaced with exactly one textual change, public. on the users relation, plus SECURITY INVOKER and a
-- pinned search_path. The condition and the error message are byte-for-byte unchanged.
-- CREATE OR REPLACE keeps the OID, owner, grants and the bot_parent_guard trigger. No grant changes.
-- Idempotent. The migration classifies the live definition first and writes only over the exact original.
-- Rollback: src/postgres/bot-parent-hardening-rollback.sql restores the original definition.

CREATE OR REPLACE FUNCTION public.check_bot_parent() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW.parent_user_id IS NOT NULL AND (NEW.bot_slot_index=1 OR NOT EXISTS(
  SELECT 1 FROM public.users WHERE id=NEW.parent_user_id AND parent_user_id IS NULL)) THEN
  RAISE EXCEPTION 'Invalid bot owner or slot';
  END IF;
  RETURN NEW;
END $fn$;
