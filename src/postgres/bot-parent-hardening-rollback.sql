-- Rollback of src/postgres/bot-parent-hardening.sql. Restores the exact original definition of check_bot_parent() from
-- src/postgres/schema.sql: the body below is copied from that file unchanged, with no pinned search_path. CREATE OR REPLACE keeps
-- the OID, owner, grants and the trigger. No row is read or changed.
-- Rolling back removes the protection; use it only to return to the exact applied schema state.

CREATE OR REPLACE FUNCTION public.check_bot_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_user_id IS NOT NULL AND (NEW.bot_slot_index=1 OR NOT EXISTS(
  SELECT 1 FROM users WHERE id=NEW.parent_user_id AND parent_user_id IS NULL)) THEN
  RAISE EXCEPTION 'Invalid bot owner or slot';
  END IF;
  RETURN NEW;
END $$;
