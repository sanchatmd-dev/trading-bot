-- F09 builder slice S2: insert-only Best Inputs package tables, guards and marker (local candidate; applied offline and separately
-- from the version-1 extensions; docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md sections 3, 4, 5, 6.1 and 8, root rulings RC-12 to RC-24).
-- One insert-only table per record kind. No route, worker or product write path uses them yet.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (shared function bi_freeze, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (the same meaning as the exposure register
--          guard: a writer reads and appends under one snapshot; trigger bi_require_serializable, named *_00_serializable so it fires first);
--   QR004  an INSERT that breaks the package rules is refused (insert guards below; the application maps it to BI_TRANSITION_INVALID).
-- Insert guards never need UPDATE privilege and never lock a bi row: where a read-then-insert check needs serialization they take
-- pg_advisory_xact_lock(hashtextextended('robot:bi:' || export_id, 0)) first, and the primary and unique keys catch the rest. Every writer
-- is SERIALIZABLE, so a second writer that waited for the lock still reads its own snapshot: every such race ends 40001 or a guard or
-- unique code, never a row the committed state would refuse. A terminal status event reads the four candidate-record tables of its export
-- (full counts), so a record writer that raced it fails with 40001 too. The application retries 40001 from the start of its transaction.
--
-- Insert order of one export (every step is one transaction unless noted):
--   1. bi_blobs               content of every package file (content-addressed; hash, size and the 16 MiB cap are CHECKs)
--   2. bi_exports             parent run must be SUCCEEDED with the same owner and Bot; fixture=false is refused for the engineering scope
--   3. bi_package_files       12 package paths, before the first status event, the sum of bytes per export capped at 16 MiB
--   4. bi_status_events       seq 1 EXPORT_CANDIDATE in the SAME transaction as step 2; a DEFERRABLE INITIALLY DEFERRED constraint
--                             trigger refuses a commit where a new export has no such event or lacks any of the 12 package files
--                             (quant-data/manifest.json included; package_hash is the canonical manifest digest, not the file hash,
--                             so the download re-verifies the bytes and no hash is tied here)
--   5. bi_trace_reproductions, bi_compile_records, bi_evidence_records, bi_clearances
--                             only while the latest status is EXPORT_CANDIDATE (the build transaction writes the trace reproductions)
--   6. per validation attempt (5 at most, only while the latest status is EXPORT_CANDIDATE and no earlier attempt passed):
--        bi_attempts          attempt_no = count + 1, package_hash = the export package_hash; none after a passing attempt or after an
--                             attempt that holds a non-retryable code (bi_retryable_codes, pinned to RETRYABLE_CODES of the gate module);
--                             attempt n + 1 needs a status event that names attempt n (one status event per attempt)
--        ql4c_validation      only for a passing attempt, same package_hash, binding_hash, validator hash and fixture flag
--        bi_status_events     seq = last + 1 through the edges of contract 6.1 only; EXPORT_VALIDATED needs a ql4c_validation row and a
--                             passing attempt, EXPORT_INTERNAL a passing attempt of an internal export; EXPORT_CANDIDATE after a failure
--                             needs retryable-only attempt codes, attempt_no < 5 and the same codes; EXPORT_REFUSED needs a non-retryable
--                             attempt code, or attempt 5 with retryable-only codes and BI_ATTEMPTS_EXHAUSTED; the event codes of a
--                             failure equal the attempt codes (plus BI_ATTEMPTS_EXHAUSTED on, and only on, the retryable fifth failure);
--                             nothing after a terminal status
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the
-- guards and needs a superuser with --disable-triggers, and logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like a package
-- object can never be used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- This file is not idempotent by itself: src/postgres/best-inputs-package-migration.js classifies the live catalog first and runs it only
-- over ABSENT. Rollback: src/postgres/best-inputs-package-rollback.sql drops exactly the objects created here.
-- Requires the base users table and the version-1 research extension (quant_jobs).

CREATE TABLE public.bi_package_schema(
 version INTEGER NOT NULL,
 CONSTRAINT bi_package_schema_pkey PRIMARY KEY(version),
 CONSTRAINT bi_package_schema_version_check CHECK(version=1)
);
INSERT INTO public.bi_package_schema VALUES(1);

CREATE TABLE public.bi_blobs(
 sha256 TEXT NOT NULL,
 size BIGINT NOT NULL,
 content BYTEA NOT NULL,
 CONSTRAINT bi_blobs_pkey PRIMARY KEY(sha256),
 CONSTRAINT bi_blobs_sha256_size_key UNIQUE(sha256,size),
 CONSTRAINT bi_blobs_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_blobs_size_check CHECK(size>=0 AND size<=16777216),
 CONSTRAINT bi_blobs_size_content_check CHECK(pg_catalog.octet_length(content)=size),
 CONSTRAINT bi_blobs_hash_content_check CHECK(pg_catalog.encode(pg_catalog.sha256(content),'hex')=sha256)
);

CREATE TABLE public.bi_exports(
 export_id UUID NOT NULL,
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 parent_export_id UUID,
 mode TEXT NOT NULL,
 internal BOOLEAN NOT NULL,
 fixture BOOLEAN NOT NULL,
 gate_version TEXT NOT NULL,
 library_versions JSONB NOT NULL,
 binding JSONB NOT NULL,
 binding_hash TEXT NOT NULL,
 package_hash TEXT NOT NULL,
 b0 JSONB NOT NULL,
 created_at BIGINT NOT NULL,
 created_at_utc TEXT NOT NULL,
 CONSTRAINT bi_exports_pkey PRIMARY KEY(export_id),
 CONSTRAINT bi_exports_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT bi_exports_bot_id_fkey FOREIGN KEY(bot_id) REFERENCES public.users(id),
 CONSTRAINT bi_exports_run_id_fkey FOREIGN KEY(run_id) REFERENCES public.quant_jobs(run_id),
 CONSTRAINT bi_exports_owner_run_key UNIQUE(owner_id,run_id),
 CONSTRAINT bi_exports_export_package_key UNIQUE(export_id,package_hash),
 CONSTRAINT bi_exports_parent_check CHECK(parent_export_id IS NULL),
 CONSTRAINT bi_exports_mode_check CHECK(mode IN ('ONE_PINE','MULTI_PINE')),
 CONSTRAINT bi_exports_internal_check CHECK(internal=(mode='MULTI_PINE')),
 CONSTRAINT bi_exports_gate_version_check CHECK(pg_catalog.length(gate_version)>0),
 CONSTRAINT bi_exports_library_versions_check CHECK(pg_catalog.jsonb_typeof(library_versions)='object'),
 CONSTRAINT bi_exports_binding_check CHECK(pg_catalog.jsonb_typeof(binding)='object'),
 CONSTRAINT bi_exports_binding_ties_check CHECK(COALESCE(binding->>'owner_id'=owner_id AND binding->>'bot_id'=bot_id AND binding->>'run_id'=run_id
  AND binding->>'mode'=mode AND binding->'fixture'=pg_catalog.to_jsonb(fixture) AND binding->>'created_at'=created_at_utc,false)),
 CONSTRAINT bi_exports_b0_check CHECK(pg_catalog.jsonb_typeof(b0)='object'),
 CONSTRAINT bi_exports_binding_hash_check CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_exports_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_exports_created_at_check CHECK(created_at>=0 AND created_at<=253402300799999),
 CONSTRAINT bi_exports_created_at_utc_check CHECK(created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.bi_package_files(
 export_id UUID NOT NULL,
 path TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 bytes BIGINT NOT NULL,
 CONSTRAINT bi_package_files_pkey PRIMARY KEY(export_id,path),
 CONSTRAINT bi_package_files_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_package_files_blob_fkey FOREIGN KEY(sha256,bytes) REFERENCES public.bi_blobs(sha256,size),
 CONSTRAINT bi_package_files_path_check CHECK(path IN ('inputs.json','indicator.pine','indicator.json','risk-profile.json','setup-guide.md','validation.html',
  'quant-data/manifest.json','quant-data/metrics.json','quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv','quant-data/validation.json')),
 CONSTRAINT bi_package_files_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_package_files_bytes_check CHECK(bytes>=0 AND bytes<=16777216)
);

CREATE TABLE public.bi_attempts(
 export_id UUID NOT NULL,
 attempt_no INTEGER NOT NULL,
 attempt_id TEXT NOT NULL,
 package_hash TEXT NOT NULL,
 pass BOOLEAN NOT NULL,
 codes TEXT[] NOT NULL,
 gate_results JSONB NOT NULL,
 evidence_refs JSONB NOT NULL,
 validator_engine_hash TEXT NOT NULL,
 validated_at_ms BIGINT NOT NULL,
 validated_at_utc TEXT NOT NULL,
 CONSTRAINT bi_attempts_pkey PRIMARY KEY(export_id,attempt_no),
 CONSTRAINT bi_attempts_attempt_id_key UNIQUE(attempt_id),
 CONSTRAINT bi_attempts_export_package_fkey FOREIGN KEY(export_id,package_hash) REFERENCES public.bi_exports(export_id,package_hash),
 CONSTRAINT bi_attempts_attempt_no_check CHECK(attempt_no>=1 AND attempt_no<=5),
 CONSTRAINT bi_attempts_attempt_id_check CHECK(pg_catalog.length(attempt_id)>0),
 CONSTRAINT bi_attempts_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_attempts_pass_check CHECK(pass=(pg_catalog.cardinality(codes)=0)),
 CONSTRAINT bi_attempts_codes_check CHECK(pg_catalog.cardinality(codes)=0 OR (pg_catalog.array_ndims(codes)=1 AND pg_catalog.array_position(codes,NULL::text) IS NULL
  AND pg_catalog.array_to_string(codes,',') ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$')),
 CONSTRAINT bi_attempts_gate_results_check CHECK(pg_catalog.jsonb_typeof(gate_results)='array'),
 CONSTRAINT bi_attempts_evidence_refs_check CHECK(pg_catalog.jsonb_typeof(evidence_refs)='object'),
 CONSTRAINT bi_attempts_validator_hash_check CHECK(validator_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_attempts_validated_at_ms_check CHECK(validated_at_ms>=0 AND validated_at_ms<=253402300799999),
 CONSTRAINT bi_attempts_validated_at_utc_check CHECK(validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.bi_status_events(
 export_id UUID NOT NULL,
 seq INTEGER NOT NULL,
 status TEXT NOT NULL,
 codes TEXT[] NOT NULL,
 attempt_no INTEGER,
 at_ms BIGINT NOT NULL,
 at_utc TEXT NOT NULL,
 CONSTRAINT bi_status_events_pkey PRIMARY KEY(export_id,seq),
 CONSTRAINT bi_status_events_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_status_events_attempt_fkey FOREIGN KEY(export_id,attempt_no) REFERENCES public.bi_attempts(export_id,attempt_no),
 CONSTRAINT bi_status_events_attempt_key UNIQUE(export_id,attempt_no),
 CONSTRAINT bi_status_events_seq_check CHECK(seq>=1),
 CONSTRAINT bi_status_events_status_check CHECK(status IN ('EXPORT_CANDIDATE','EXPORT_INTERNAL','EXPORT_VALIDATED','EXPORT_REFUSED')),
 CONSTRAINT bi_status_events_first_check CHECK((seq=1 AND status='EXPORT_CANDIDATE' AND attempt_no IS NULL) OR (seq>1 AND attempt_no IS NOT NULL)),
 CONSTRAINT bi_status_events_codes_check CHECK(pg_catalog.cardinality(codes)=0 OR (pg_catalog.array_ndims(codes)=1 AND pg_catalog.array_position(codes,NULL::text) IS NULL
  AND pg_catalog.array_to_string(codes,',') ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$')),
 CONSTRAINT bi_status_events_codes_status_check CHECK((status IN ('EXPORT_INTERNAL','EXPORT_VALIDATED') AND pg_catalog.cardinality(codes)=0)
  OR (status='EXPORT_REFUSED' AND pg_catalog.cardinality(codes)>0) OR status='EXPORT_CANDIDATE'),
 CONSTRAINT bi_status_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999),
 CONSTRAINT bi_status_events_at_utc_check CHECK(at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.ql4c_validation(
 export_id UUID NOT NULL,
 package_hash TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 gate_results JSONB NOT NULL,
 validator_engine_hash TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 validated_at_ms BIGINT NOT NULL,
 validated_at_utc TEXT NOT NULL,
 CONSTRAINT ql4c_validation_pkey PRIMARY KEY(export_id),
 CONSTRAINT ql4c_validation_export_package_key UNIQUE(export_id,package_hash),
 CONSTRAINT ql4c_validation_export_package_fkey FOREIGN KEY(export_id,package_hash) REFERENCES public.bi_exports(export_id,package_hash),
 CONSTRAINT ql4c_validation_attempt_id_fkey FOREIGN KEY(attempt_id) REFERENCES public.bi_attempts(attempt_id),
 CONSTRAINT ql4c_validation_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT ql4c_validation_binding_hash_check CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT ql4c_validation_gate_results_check CHECK(pg_catalog.jsonb_typeof(gate_results)='array'),
 CONSTRAINT ql4c_validation_validator_hash_check CHECK(validator_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT ql4c_validation_validated_at_ms_check CHECK(validated_at_ms>=0 AND validated_at_ms<=253402300799999),
 CONSTRAINT ql4c_validation_validated_at_utc_check CHECK(validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.bi_compile_records(
 compile_id UUID NOT NULL DEFAULT gen_random_uuid(),
 export_id UUID NOT NULL,
 indicator_sha256 TEXT NOT NULL,
 pine_version TEXT NOT NULL,
 errors JSONB NOT NULL,
 warnings JSONB NOT NULL,
 unresolved_references INTEGER NOT NULL,
 collisions INTEGER NOT NULL,
 duplicate_bindings INTEGER NOT NULL,
 mapping_check JSONB NOT NULL,
 compiled_at_ms BIGINT NOT NULL,
 compiled_at_utc TEXT NOT NULL,
 operator_role TEXT NOT NULL,
 method TEXT NOT NULL,
 CONSTRAINT bi_compile_records_pkey PRIMARY KEY(compile_id),
 CONSTRAINT bi_compile_records_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_compile_records_indicator_check CHECK(indicator_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_compile_records_pine_version_check CHECK(pg_catalog.length(pine_version)>0),
 CONSTRAINT bi_compile_records_errors_check CHECK(pg_catalog.jsonb_typeof(errors)='array'),
 CONSTRAINT bi_compile_records_warnings_check CHECK(pg_catalog.jsonb_typeof(warnings)='array'),
 CONSTRAINT bi_compile_records_counts_check CHECK(unresolved_references>=0 AND collisions>=0 AND duplicate_bindings>=0),
 CONSTRAINT bi_compile_records_mapping_check CHECK(pg_catalog.jsonb_typeof(mapping_check)='array'),
 CONSTRAINT bi_compile_records_compiled_at_ms_check CHECK(compiled_at_ms>=0 AND compiled_at_ms<=253402300799999),
 CONSTRAINT bi_compile_records_compiled_at_utc_check CHECK(compiled_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'),
 CONSTRAINT bi_compile_records_operator_role_check CHECK(pg_catalog.length(operator_role)>0),
 CONSTRAINT bi_compile_records_method_check CHECK(pg_catalog.length(method)>0)
);
CREATE INDEX bi_compile_records_export ON public.bi_compile_records(export_id);

CREATE TABLE public.bi_evidence_records(
 evidence_id UUID NOT NULL DEFAULT gen_random_uuid(),
 export_id UUID NOT NULL,
 kind TEXT NOT NULL,
 record JSONB NOT NULL,
 evidence_hash TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT bi_evidence_records_pkey PRIMARY KEY(evidence_id),
 CONSTRAINT bi_evidence_records_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_evidence_records_unique_key UNIQUE(export_id,kind,evidence_hash),
 CONSTRAINT bi_evidence_records_kind_check CHECK(kind IN ('dataset_alignment','native_parity','bridge_parity','repaint','quant_baseline')),
 CONSTRAINT bi_evidence_records_record_check CHECK(pg_catalog.jsonb_typeof(record)='object'),
 CONSTRAINT bi_evidence_records_hash_check CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_evidence_records_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

CREATE TABLE public.bi_clearances(
 export_id UUID NOT NULL,
 blocker TEXT NOT NULL,
 run_id TEXT NOT NULL,
 parameter_hash TEXT NOT NULL,
 evidence_hash TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT bi_clearances_pkey PRIMARY KEY(export_id,blocker,evidence_hash),
 CONSTRAINT bi_clearances_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_clearances_run_id_fkey FOREIGN KEY(run_id) REFERENCES public.quant_jobs(run_id),
 CONSTRAINT bi_clearances_blocker_check CHECK(blocker IN ('VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED')),
 CONSTRAINT bi_clearances_parameter_hash_check CHECK(parameter_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_clearances_evidence_hash_check CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_clearances_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

CREATE TABLE public.bi_trace_reproductions(
 export_id UUID NOT NULL,
 path TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 steps_digest TEXT NOT NULL,
 holdout_digest TEXT NOT NULL,
 trace_engine_hash TEXT NOT NULL,
 run_engine_hash TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT bi_trace_reproductions_pkey PRIMARY KEY(export_id,path),
 CONSTRAINT bi_trace_reproductions_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.bi_exports(export_id),
 CONSTRAINT bi_trace_reproductions_path_check CHECK(path IN ('quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv')),
 CONSTRAINT bi_trace_reproductions_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_trace_reproductions_steps_check CHECK(steps_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_trace_reproductions_holdout_check CHECK(holdout_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_trace_reproductions_trace_engine_check CHECK(trace_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_trace_reproductions_run_engine_check CHECK(run_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT bi_trace_reproductions_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

CREATE FUNCTION public.bi_package_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'best-inputs-package-v1'::text $fn$;

-- The retryable missing-evidence codes of contract 6.1 (RETRYABLE_CODES of src/quant-library/package-gates.js; a test pins the two together).
CREATE FUNCTION public.bi_retryable_codes() RETURNS TEXT[]
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT ARRAY['BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_WARNINGS_UNREVIEWED','BI_NATIVE_ALERT_ISOLATION_UNPROVEN','BI_DATASET_ALIGNMENT_MISSING','BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']::text[] $fn$;

CREATE FUNCTION public.bi_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Best Inputs package records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a package table must run in a SERIALIZABLE transaction (QR003, as for the exposure register).
CREATE FUNCTION public.bi_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Best Inputs package writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- Serializes the writers of one export (status events, attempts, files and evidence rows), without locking any bi row.
CREATE FUNCTION public.bi_lock_export(p_export UUID) RETURNS void
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('robot:bi:' || p_export::text, 0));
END $fn$;

-- The status of the highest seq, or NULL while the export has no status event. VOLATILE so the planner never caches it; a SERIALIZABLE
-- writer reads its transaction snapshot after bi_lock_export.
CREATE FUNCTION public.bi_latest_status(p_export UUID) RETURNS text
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE found_status TEXT;
BEGIN
 SELECT e.status INTO found_status FROM public.bi_status_events e WHERE e.export_id = p_export ORDER BY e.seq DESC LIMIT 1;
 RETURN found_status;
END $fn$;

CREATE FUNCTION public.bi_guard_export() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE run_row RECORD;
BEGIN
 SELECT j.owner_id, j.bot_id, j.status, j.contract ->> 'scope' AS scope INTO run_row FROM public.quant_jobs j WHERE j.run_id = NEW.run_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Best Inputs export needs an existing research run' USING ERRCODE = 'QR004';
 END IF;
 IF run_row.status IS DISTINCT FROM 'SUCCEEDED' THEN
  RAISE EXCEPTION 'Best Inputs export needs a SUCCEEDED research run' USING ERRCODE = 'QR004';
 END IF;
 IF run_row.owner_id IS DISTINCT FROM NEW.owner_id OR run_row.bot_id IS DISTINCT FROM NEW.bot_id THEN
  RAISE EXCEPTION 'Best Inputs export owner and Bot must equal the research run owner and Bot' USING ERRCODE = 'QR004';
 END IF;
 IF run_row.scope IS NULL OR run_row.scope OPERATOR(pg_catalog.!~) '^[A-Z][A-Z0-9_]{1,63}$' THEN
  RAISE EXCEPTION 'Best Inputs export needs a research run whose contract names a well-formed scope' USING ERRCODE = 'QR004';
 END IF;
 IF NEW.fixture IS NOT TRUE AND run_row.scope IS NOT DISTINCT FROM 'SPT_CUSTOM_ENGINEERING_ONLY' THEN
  RAISE EXCEPTION 'An engineering-scope research run can only have a fixture export' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.bi_guard_export_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.bi_status_events e WHERE e.export_id = NEW.export_id AND e.seq = 1 AND e.status = 'EXPORT_CANDIDATE') THEN
  RAISE EXCEPTION 'A Best Inputs export needs its EXPORT_CANDIDATE status event in the same transaction' USING ERRCODE = 'QR004';
 END IF;
 -- The path CHECK allows 12 paths and the primary key one row per path, so 12 rows are exactly the package files.
 IF (SELECT pg_catalog.count(*) FROM public.bi_package_files f WHERE f.export_id = NEW.export_id) IS DISTINCT FROM 12
    OR NOT EXISTS (SELECT 1 FROM public.bi_package_files f WHERE f.export_id = NEW.export_id AND f.path = 'quant-data/manifest.json') THEN
  RAISE EXCEPTION 'A Best Inputs export needs all 12 package files, quant-data/manifest.json included, in the same transaction' USING ERRCODE = 'QR004';
 END IF;
 RETURN NULL;
END $fn$;

CREATE FUNCTION public.bi_guard_package_file() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE used BIGINT;
BEGIN
 PERFORM public.bi_lock_export(NEW.export_id);
 IF public.bi_latest_status(NEW.export_id) IS NOT NULL THEN
  RAISE EXCEPTION 'Package files cannot be added after the first status event' USING ERRCODE = 'QR004';
 END IF;
 SELECT COALESCE(pg_catalog.sum(f.bytes), 0) INTO used FROM public.bi_package_files f WHERE f.export_id = NEW.export_id;
 IF used + NEW.bytes > 16777216 THEN
  RAISE EXCEPTION 'Package files of one export exceed 16 MiB' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.bi_guard_status_event() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_seq INTEGER; last_status TEXT; is_internal BOOLEAN; latest RECORD; retryable_only BOOLEAN; expected_codes TEXT[];
BEGIN
 PERFORM public.bi_lock_export(NEW.export_id);
 SELECT e.seq, e.status INTO last_seq, last_status FROM public.bi_status_events e WHERE e.export_id = NEW.export_id ORDER BY e.seq DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.seq IS DISTINCT FROM 1 OR NEW.status IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
   RAISE EXCEPTION 'The first status event must be seq 1 EXPORT_CANDIDATE' USING ERRCODE = 'QR004';
  END IF;
  RETURN NEW;
 END IF;
 IF last_status IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'No status event may follow a terminal status' USING ERRCODE = 'QR004';
 END IF;
 IF NEW.seq IS DISTINCT FROM last_seq + 1 THEN
  RAISE EXCEPTION 'A status event must have seq = last + 1' USING ERRCODE = 'QR004';
 END IF;
 SELECT x.internal INTO is_internal FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 SELECT a.attempt_no, a.attempt_id, a.pass, a.codes INTO latest FROM public.bi_attempts a WHERE a.export_id = NEW.export_id ORDER BY a.attempt_no DESC LIMIT 1;
 IF NOT FOUND OR latest.attempt_no IS DISTINCT FROM NEW.attempt_no THEN
  RAISE EXCEPTION 'A status event must follow the latest validation attempt' USING ERRCODE = 'QR004';
 END IF;
 -- A terminal event also reads the four candidate-record tables of the export (full counts, no early stop), so a SERIALIZABLE record writer
 -- that waited for the lock before this event commits gets 40001 instead of landing a row after the terminal status.
 IF NEW.status <> 'EXPORT_CANDIDATE' THEN
  PERFORM pg_catalog.count(*) FROM public.bi_evidence_records r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.bi_compile_records r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.bi_clearances r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.bi_trace_reproductions r WHERE r.export_id = NEW.export_id;
 END IF;
 IF NEW.status = 'EXPORT_VALIDATED' THEN
  IF is_internal IS DISTINCT FROM false OR latest.pass IS DISTINCT FROM true
     OR NOT EXISTS (SELECT 1 FROM public.ql4c_validation v WHERE v.export_id = NEW.export_id AND v.attempt_id = latest.attempt_id) THEN
   RAISE EXCEPTION 'EXPORT_VALIDATED needs a one-Pine export, a passing attempt and its ql4c_validation row' USING ERRCODE = 'QR004';
  END IF;
 ELSIF NEW.status = 'EXPORT_INTERNAL' THEN
  IF is_internal IS DISTINCT FROM true OR latest.pass IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'EXPORT_INTERNAL needs an internal export and a passing attempt' USING ERRCODE = 'QR004';
  END IF;
 ELSE
  IF latest.pass IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'A passing attempt can only lead to EXPORT_VALIDATED or EXPORT_INTERNAL' USING ERRCODE = 'QR004';
  END IF;
  -- Any other status value meets the status CHECK.
  IF NEW.status IN ('EXPORT_CANDIDATE', 'EXPORT_REFUSED') THEN
   retryable_only := latest.codes OPERATOR(pg_catalog.<@) public.bi_retryable_codes();
   IF NEW.status = 'EXPORT_CANDIDATE' THEN
    IF NOT retryable_only THEN
     RAISE EXCEPTION 'A non-retryable code can only lead to EXPORT_REFUSED' USING ERRCODE = 'QR004';
    END IF;
    IF NEW.attempt_no >= 5 THEN
     RAISE EXCEPTION 'The fifth failed attempt must end EXPORT_REFUSED' USING ERRCODE = 'QR004';
    END IF;
    expected_codes := latest.codes;
   ELSE
    IF retryable_only AND NEW.attempt_no <> 5 THEN
     RAISE EXCEPTION 'EXPORT_REFUSED needs a non-retryable code, or the fifth failed attempt with BI_ATTEMPTS_EXHAUSTED' USING ERRCODE = 'QR004';
    END IF;
    expected_codes := CASE WHEN retryable_only THEN latest.codes OPERATOR(pg_catalog.||) ARRAY['BI_ATTEMPTS_EXHAUSTED']::text[] ELSE latest.codes END;
   END IF;
   IF NOT (NEW.codes OPERATOR(pg_catalog.@>) expected_codes) THEN
    RAISE EXCEPTION 'A status event after a failed attempt must carry the codes of that attempt (and BI_ATTEMPTS_EXHAUSTED on the retryable fifth failure)' USING ERRCODE = 'QR004';
   END IF;
   IF NOT (NEW.codes OPERATOR(pg_catalog.<@) expected_codes) THEN
    RAISE EXCEPTION 'A status event after a failed attempt must carry exactly the codes of that attempt (BI_ATTEMPTS_EXHAUSTED only on the retryable fifth failure)' USING ERRCODE = 'QR004';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.bi_guard_attempt() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_package TEXT; attempts INTEGER; any_pass BOOLEAN; any_hard BOOLEAN;
BEGIN
 PERFORM public.bi_lock_export(NEW.export_id);
 IF public.bi_latest_status(NEW.export_id) IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'A validation attempt needs the latest status EXPORT_CANDIDATE' USING ERRCODE = 'QR004';
 END IF;
 SELECT x.package_hash INTO export_package FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.package_hash IS DISTINCT FROM export_package THEN
  RAISE EXCEPTION 'A validation attempt must name the export package_hash' USING ERRCODE = 'QR004';
 END IF;
 IF NEW.codes OPERATOR(pg_catalog.@>) ARRAY['BI_ATTEMPTS_EXHAUSTED']::text[] THEN
  RAISE EXCEPTION 'BI_ATTEMPTS_EXHAUSTED is a status code, never an attempt code' USING ERRCODE = 'QR004';
 END IF;
 SELECT pg_catalog.count(*)::integer, COALESCE(pg_catalog.bool_or(a.pass), false),
   COALESCE(pg_catalog.bool_or(NOT a.pass AND NOT (a.codes OPERATOR(pg_catalog.<@) public.bi_retryable_codes())), false)
   INTO attempts, any_pass, any_hard FROM public.bi_attempts a WHERE a.export_id = NEW.export_id;
 IF any_pass THEN
  RAISE EXCEPTION 'No validation attempt may follow a passing attempt' USING ERRCODE = 'QR004';
 END IF;
 IF any_hard THEN
  RAISE EXCEPTION 'No validation attempt may follow an attempt with a non-retryable code' USING ERRCODE = 'QR004';
 END IF;
 IF attempts >= 5 OR NEW.attempt_no IS DISTINCT FROM attempts + 1 THEN
  RAISE EXCEPTION 'attempt_no must be the attempt count + 1, at most 5' USING ERRCODE = 'QR004';
 END IF;
 IF attempts > 0 AND NOT EXISTS (SELECT 1 FROM public.bi_status_events e WHERE e.export_id = NEW.export_id AND e.attempt_no = attempts) THEN
  RAISE EXCEPTION 'A validation attempt needs the status event of the previous attempt' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.bi_guard_validation() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_row RECORD; attempt_row RECORD;
BEGIN
 PERFORM public.bi_lock_export(NEW.export_id);
 IF public.bi_latest_status(NEW.export_id) IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'A validation record needs the latest status EXPORT_CANDIDATE' USING ERRCODE = 'QR004';
 END IF;
 SELECT x.package_hash, x.binding_hash, x.fixture INTO export_row FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.package_hash IS DISTINCT FROM export_row.package_hash OR NEW.binding_hash IS DISTINCT FROM export_row.binding_hash
    OR NEW.fixture IS DISTINCT FROM export_row.fixture THEN
  RAISE EXCEPTION 'A validation record must match the export package_hash, binding_hash and fixture flag' USING ERRCODE = 'QR004';
 END IF;
 SELECT a.pass, a.package_hash, a.validator_engine_hash INTO attempt_row FROM public.bi_attempts a WHERE a.export_id = NEW.export_id AND a.attempt_id = NEW.attempt_id;
 IF NOT FOUND OR attempt_row.pass IS DISTINCT FROM true OR attempt_row.package_hash IS DISTINCT FROM NEW.package_hash
    OR attempt_row.validator_engine_hash IS DISTINCT FROM NEW.validator_engine_hash THEN
  RAISE EXCEPTION 'A validation record needs a passing attempt of this export with the same package_hash and validator hash' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

-- Compile records, evidence records, clearances and trace reproductions (every one of them has export_id).
CREATE FUNCTION public.bi_guard_candidate_record() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 PERFORM public.bi_lock_export(NEW.export_id);
 IF public.bi_latest_status(NEW.export_id) IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'Evidence rows need the latest status EXPORT_CANDIDATE' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.bi_guard_clearance() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_run TEXT; proof_kind TEXT;
BEGIN
 SELECT x.run_id INTO export_run FROM public.bi_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.run_id IS DISTINCT FROM export_run THEN
  RAISE EXCEPTION 'A clearance must name the run of its export' USING ERRCODE = 'QR004';
 END IF;
 -- The evidence record a clearance of that blocker must carry (the gate module names the same pairs); an unknown blocker meets the CHECK.
 proof_kind := CASE NEW.blocker WHEN 'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED' THEN 'native_parity' WHEN 'CUSTOM_REPAINT_EVIDENCE_REQUIRED' THEN 'repaint' ELSE NULL END;
 IF proof_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bi_evidence_records r
    WHERE r.export_id = NEW.export_id AND r.kind = proof_kind AND r.evidence_hash = NEW.evidence_hash) THEN
  RAISE EXCEPTION 'A clearance needs an evidence record of its export with the same evidence_hash and the kind of its blocker' USING ERRCODE = 'QR004';
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER bi_package_schema_no_change BEFORE UPDATE OR DELETE ON public.bi_package_schema FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_package_schema_no_truncate BEFORE TRUNCATE ON public.bi_package_schema FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_blobs_no_change BEFORE UPDATE OR DELETE ON public.bi_blobs FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_blobs_no_truncate BEFORE TRUNCATE ON public.bi_blobs FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_exports_no_change BEFORE UPDATE OR DELETE ON public.bi_exports FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_exports_no_truncate BEFORE TRUNCATE ON public.bi_exports FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_package_files_no_change BEFORE UPDATE OR DELETE ON public.bi_package_files FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_package_files_no_truncate BEFORE TRUNCATE ON public.bi_package_files FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_attempts_no_change BEFORE UPDATE OR DELETE ON public.bi_attempts FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_attempts_no_truncate BEFORE TRUNCATE ON public.bi_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_status_events_no_change BEFORE UPDATE OR DELETE ON public.bi_status_events FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_status_events_no_truncate BEFORE TRUNCATE ON public.bi_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER ql4c_validation_no_change BEFORE UPDATE OR DELETE ON public.ql4c_validation FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER ql4c_validation_no_truncate BEFORE TRUNCATE ON public.ql4c_validation FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_compile_records_no_change BEFORE UPDATE OR DELETE ON public.bi_compile_records FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_compile_records_no_truncate BEFORE TRUNCATE ON public.bi_compile_records FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_evidence_records_no_change BEFORE UPDATE OR DELETE ON public.bi_evidence_records FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_evidence_records_no_truncate BEFORE TRUNCATE ON public.bi_evidence_records FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_clearances_no_change BEFORE UPDATE OR DELETE ON public.bi_clearances FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_clearances_no_truncate BEFORE TRUNCATE ON public.bi_clearances FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_trace_reproductions_no_change BEFORE UPDATE OR DELETE ON public.bi_trace_reproductions FOR EACH ROW EXECUTE FUNCTION public.bi_freeze();
CREATE TRIGGER bi_trace_reproductions_no_truncate BEFORE TRUNCATE ON public.bi_trace_reproductions FOR EACH STATEMENT EXECUTE FUNCTION public.bi_freeze();

CREATE TRIGGER bi_package_schema_00_serializable BEFORE INSERT ON public.bi_package_schema FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_blobs_00_serializable BEFORE INSERT ON public.bi_blobs FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_exports_00_serializable BEFORE INSERT ON public.bi_exports FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_package_files_00_serializable BEFORE INSERT ON public.bi_package_files FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_attempts_00_serializable BEFORE INSERT ON public.bi_attempts FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_status_events_00_serializable BEFORE INSERT ON public.bi_status_events FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER ql4c_validation_00_serializable BEFORE INSERT ON public.ql4c_validation FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_compile_records_00_serializable BEFORE INSERT ON public.bi_compile_records FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_evidence_records_00_serializable BEFORE INSERT ON public.bi_evidence_records FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_clearances_00_serializable BEFORE INSERT ON public.bi_clearances FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_trace_reproductions_00_serializable BEFORE INSERT ON public.bi_trace_reproductions FOR EACH ROW EXECUTE FUNCTION public.bi_require_serializable();
CREATE TRIGGER bi_exports_guard BEFORE INSERT ON public.bi_exports FOR EACH ROW EXECUTE FUNCTION public.bi_guard_export();
CREATE CONSTRAINT TRIGGER bi_exports_complete AFTER INSERT ON public.bi_exports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bi_guard_export_complete();
CREATE TRIGGER bi_package_files_guard BEFORE INSERT ON public.bi_package_files FOR EACH ROW EXECUTE FUNCTION public.bi_guard_package_file();
CREATE TRIGGER bi_status_events_guard BEFORE INSERT ON public.bi_status_events FOR EACH ROW EXECUTE FUNCTION public.bi_guard_status_event();
CREATE TRIGGER bi_attempts_guard BEFORE INSERT ON public.bi_attempts FOR EACH ROW EXECUTE FUNCTION public.bi_guard_attempt();
CREATE TRIGGER ql4c_validation_guard BEFORE INSERT ON public.ql4c_validation FOR EACH ROW EXECUTE FUNCTION public.bi_guard_validation();
CREATE TRIGGER bi_compile_records_guard BEFORE INSERT ON public.bi_compile_records FOR EACH ROW EXECUTE FUNCTION public.bi_guard_candidate_record();
CREATE TRIGGER bi_evidence_records_guard BEFORE INSERT ON public.bi_evidence_records FOR EACH ROW EXECUTE FUNCTION public.bi_guard_candidate_record();
CREATE TRIGGER bi_clearances_guard BEFORE INSERT ON public.bi_clearances FOR EACH ROW EXECUTE FUNCTION public.bi_guard_clearance();
CREATE TRIGGER bi_clearances_candidate BEFORE INSERT ON public.bi_clearances FOR EACH ROW EXECUTE FUNCTION public.bi_guard_candidate_record();
CREATE TRIGGER bi_trace_reproductions_guard BEFORE INSERT ON public.bi_trace_reproductions FOR EACH ROW EXECUTE FUNCTION public.bi_guard_candidate_record();

ALTER TABLE public.bi_package_schema ENABLE ALWAYS TRIGGER bi_package_schema_no_change;
ALTER TABLE public.bi_package_schema ENABLE ALWAYS TRIGGER bi_package_schema_no_truncate;
ALTER TABLE public.bi_blobs ENABLE ALWAYS TRIGGER bi_blobs_no_change;
ALTER TABLE public.bi_blobs ENABLE ALWAYS TRIGGER bi_blobs_no_truncate;
ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_no_change;
ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_no_truncate;
ALTER TABLE public.bi_package_files ENABLE ALWAYS TRIGGER bi_package_files_no_change;
ALTER TABLE public.bi_package_files ENABLE ALWAYS TRIGGER bi_package_files_no_truncate;
ALTER TABLE public.bi_attempts ENABLE ALWAYS TRIGGER bi_attempts_no_change;
ALTER TABLE public.bi_attempts ENABLE ALWAYS TRIGGER bi_attempts_no_truncate;
ALTER TABLE public.bi_status_events ENABLE ALWAYS TRIGGER bi_status_events_no_change;
ALTER TABLE public.bi_status_events ENABLE ALWAYS TRIGGER bi_status_events_no_truncate;
ALTER TABLE public.ql4c_validation ENABLE ALWAYS TRIGGER ql4c_validation_no_change;
ALTER TABLE public.ql4c_validation ENABLE ALWAYS TRIGGER ql4c_validation_no_truncate;
ALTER TABLE public.bi_compile_records ENABLE ALWAYS TRIGGER bi_compile_records_no_change;
ALTER TABLE public.bi_compile_records ENABLE ALWAYS TRIGGER bi_compile_records_no_truncate;
ALTER TABLE public.bi_evidence_records ENABLE ALWAYS TRIGGER bi_evidence_records_no_change;
ALTER TABLE public.bi_evidence_records ENABLE ALWAYS TRIGGER bi_evidence_records_no_truncate;
ALTER TABLE public.bi_clearances ENABLE ALWAYS TRIGGER bi_clearances_no_change;
ALTER TABLE public.bi_clearances ENABLE ALWAYS TRIGGER bi_clearances_no_truncate;
ALTER TABLE public.bi_trace_reproductions ENABLE ALWAYS TRIGGER bi_trace_reproductions_no_change;
ALTER TABLE public.bi_trace_reproductions ENABLE ALWAYS TRIGGER bi_trace_reproductions_no_truncate;
ALTER TABLE public.bi_package_schema ENABLE ALWAYS TRIGGER bi_package_schema_00_serializable;
ALTER TABLE public.bi_blobs ENABLE ALWAYS TRIGGER bi_blobs_00_serializable;
ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_00_serializable;
ALTER TABLE public.bi_package_files ENABLE ALWAYS TRIGGER bi_package_files_00_serializable;
ALTER TABLE public.bi_attempts ENABLE ALWAYS TRIGGER bi_attempts_00_serializable;
ALTER TABLE public.bi_status_events ENABLE ALWAYS TRIGGER bi_status_events_00_serializable;
ALTER TABLE public.ql4c_validation ENABLE ALWAYS TRIGGER ql4c_validation_00_serializable;
ALTER TABLE public.bi_compile_records ENABLE ALWAYS TRIGGER bi_compile_records_00_serializable;
ALTER TABLE public.bi_evidence_records ENABLE ALWAYS TRIGGER bi_evidence_records_00_serializable;
ALTER TABLE public.bi_clearances ENABLE ALWAYS TRIGGER bi_clearances_00_serializable;
ALTER TABLE public.bi_trace_reproductions ENABLE ALWAYS TRIGGER bi_trace_reproductions_00_serializable;
ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_guard;
ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_complete;
ALTER TABLE public.bi_package_files ENABLE ALWAYS TRIGGER bi_package_files_guard;
ALTER TABLE public.bi_status_events ENABLE ALWAYS TRIGGER bi_status_events_guard;
ALTER TABLE public.bi_attempts ENABLE ALWAYS TRIGGER bi_attempts_guard;
ALTER TABLE public.ql4c_validation ENABLE ALWAYS TRIGGER ql4c_validation_guard;
ALTER TABLE public.bi_compile_records ENABLE ALWAYS TRIGGER bi_compile_records_guard;
ALTER TABLE public.bi_evidence_records ENABLE ALWAYS TRIGGER bi_evidence_records_guard;
ALTER TABLE public.bi_clearances ENABLE ALWAYS TRIGGER bi_clearances_guard;
ALTER TABLE public.bi_clearances ENABLE ALWAYS TRIGGER bi_clearances_candidate;
ALTER TABLE public.bi_trace_reproductions ENABLE ALWAYS TRIGGER bi_trace_reproductions_guard;
