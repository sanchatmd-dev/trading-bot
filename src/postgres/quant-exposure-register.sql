-- QR-3 S2a exposure register (local candidate; applied offline and separately from the version-1 extensions).
-- One insert-only table records every evaluation window a QR-3 comparison or a QR-4 selection has exposed, so a later holdout,
-- comparison or selection can be refused when its window overlaps one. Windows are half-open [start_ms, end_ms) in epoch ms.
-- Database guards, for any role that cannot disable triggers or change the table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused (insert-only evidence row);
--   QR003  INSERT is refused unless the transaction is SERIALIZABLE (a register writer must read and append under one snapshot).
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into an installed register, and
-- logical-replication apply (READ COMMITTED), fail with QR003; a data-only restore needs a superuser and --disable-triggers, and
-- logical replication of this table is not supported without a design change.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like a
-- register object can never be used in its place. The triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- This file is not idempotent by itself: src/postgres/quant-exposure-register-migration.js classifies the live catalog first and
-- runs it only over ABSENT. Rollback: src/postgres/quant-exposure-register-rollback.sql drops exactly the objects created here.

CREATE TABLE public.quant_exposure_register_schema(
 version INTEGER NOT NULL,
 CONSTRAINT quant_exposure_register_schema_pkey PRIMARY KEY(version),
 CONSTRAINT quant_exposure_register_schema_version_check CHECK(version=1)
);
INSERT INTO public.quant_exposure_register_schema VALUES(1);

CREATE TABLE public.quant_exposure_register(
 exposure_id UUID NOT NULL DEFAULT gen_random_uuid(),
 kind TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 broker TEXT NOT NULL,
 symbol TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 start_ms BIGINT NOT NULL,
 end_ms BIGINT NOT NULL,
 comparison_id TEXT,
 participant_run_id TEXT,
 source_hash TEXT,
 selection_id TEXT,
 at_ms BIGINT NOT NULL,
 CONSTRAINT quant_exposure_register_pkey PRIMARY KEY(exposure_id),
 CONSTRAINT quant_exposure_register_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT quant_exposure_register_kind_check CHECK(kind IN ('QR3_COMPARISON','QR4_SELECTION')),
 CONSTRAINT quant_exposure_register_broker_check CHECK(length(broker)>0),
 CONSTRAINT quant_exposure_register_symbol_check CHECK(length(symbol)>0),
 CONSTRAINT quant_exposure_register_timeframe_check CHECK(length(timeframe)>0),
 CONSTRAINT quant_exposure_register_start_ms_check CHECK(start_ms>=0 AND start_ms%60000=0),
 CONSTRAINT quant_exposure_register_end_ms_check CHECK(end_ms>start_ms AND end_ms%60000=0 AND end_ms<=253402300800000),
 CONSTRAINT quant_exposure_register_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999),
 CONSTRAINT quant_exposure_register_kind_fields_check CHECK(COALESCE(
  (kind='QR3_COMPARISON' AND comparison_id IS NOT NULL AND length(comparison_id)>0 AND participant_run_id IS NOT NULL AND length(participant_run_id)>0
   AND source_hash IS NOT NULL AND source_hash ~ '^[0-9a-f]{64}$' AND selection_id IS NULL)
  OR (kind='QR4_SELECTION' AND selection_id IS NOT NULL AND length(selection_id)>0
   AND comparison_id IS NULL AND participant_run_id IS NULL AND source_hash IS NULL),false)),
 CONSTRAINT quant_exposure_register_qr3_unique UNIQUE(comparison_id,participant_run_id,start_ms,end_ms)
);
CREATE UNIQUE INDEX quant_exposure_register_qr4_unique ON public.quant_exposure_register(selection_id) WHERE kind='QR4_SELECTION';
CREATE INDEX quant_exposure_register_lookup ON public.quant_exposure_register(owner_id,broker,symbol,timeframe,start_ms);

CREATE FUNCTION public.quant_exposure_register_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'quant-exposure-register-v1'::text $fn$;

CREATE FUNCTION public.quant_exposure_register_insert_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Quant exposure register rows are insert-only' USING ERRCODE = 'QR002';
END $fn$;

CREATE FUNCTION public.quant_exposure_register_serializable_insert() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Quant exposure register writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER quant_exposure_register_no_change BEFORE UPDATE OR DELETE ON public.quant_exposure_register
 FOR EACH ROW EXECUTE FUNCTION public.quant_exposure_register_insert_only();
CREATE TRIGGER quant_exposure_register_no_truncate BEFORE TRUNCATE ON public.quant_exposure_register
 FOR EACH STATEMENT EXECUTE FUNCTION public.quant_exposure_register_insert_only();
CREATE TRIGGER quant_exposure_register_serializable BEFORE INSERT ON public.quant_exposure_register
 FOR EACH ROW EXECUTE FUNCTION public.quant_exposure_register_serializable_insert();
ALTER TABLE public.quant_exposure_register ENABLE ALWAYS TRIGGER quant_exposure_register_no_change;
ALTER TABLE public.quant_exposure_register ENABLE ALWAYS TRIGGER quant_exposure_register_no_truncate;
ALTER TABLE public.quant_exposure_register ENABLE ALWAYS TRIGGER quant_exposure_register_serializable;
