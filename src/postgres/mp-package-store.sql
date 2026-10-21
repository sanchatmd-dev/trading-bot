-- F11-01 internal multi-Pine package store, slice R6-3 (local candidate; applied offline and separately from the other extensions; docs/MULTI_PINE_CONTRACT.md
-- RD-MP-36 package store, RD-MP-37 validation record, RD-MP-41 evidence records, RD-MP-39 trace record, RD-MP-42 isolation). One insert-only table per record kind
-- of a multi-Pine export. No store function, builder, service, route or reader ships with this file (slice R6-4 and later).
--
-- Why an extension of its own: the Best Inputs package tables (best-inputs-package-schema.sql) carry foreign keys onto quant_jobs, bi_exports and bi_attempts, and
-- the one-Pine builder (RC-20) stays unchanged. A multi-Pine export therefore lives here, with the mode fixed to MULTI_PINE and no EXPORT_VALIDATED status.
--
-- Isolation (RD-MP-42):
--   * No foreign key names any run-store table, any bi_ table or any quant_ table. Foreign keys go only to users and between package-store tables. The run-store
--     classifier (mp-run-store-migration.js) reads a foreign key from a table outside the run store as OTHER (REFERENCED_BY), and it has no allowlist, so one
--     foreign key onto mp_research_runs would make the run store read OTHER (judgement J1). run_id of an export is a plain UUID column; the export guard reads the
--     run by SELECT instead. Run rows and events are insert-only and the run-store rollback refuses while any row exists, so the tie it reads stays stable.
--   * The runtime role holds no privilege on these tables (scripts/grant-postgres-runtime.sql category internal_only: the default category would hand runtime DML
--     to any table missing from that array, so every table below is listed there in the same slice). A separate fixture role writes them in isolated clusters only
--     (scripts/grant-postgres-mp-package-fixture.sql).
--   * No bi_ table, bi_ trigger, run-store object or member-set object changes. The foreign keys onto users add PostgreSQL-internal referential-integrity triggers
--     to users, as the run store does.
--
-- Database guards, for any role that cannot disable triggers or change a table owner:
--   QR002  UPDATE, DELETE and TRUNCATE are refused on every table of this file (function mp_package_store_freeze, ENABLE ALWAYS);
--   QR003  an INSERT outside a SERIALIZABLE transaction is refused on every table of this file (function mp_package_store_require_serializable; the triggers are
--          named *_00_serializable so they fire first);
--   QR004  an INSERT that breaks a package rule is refused. Each QR004 is raised with CONSTRAINT = the name of the guard trigger that raised it, so the writer maps
--          the guard that fired:
--            mp_package_exports_guard            export insert: the run (read by SELECT from the run store) does not exist, has another owner or Bot, another pine_count,
--                                                another contract version than ql3a-research-job-multi-v1, a last event other than SUCCEEDED, or a result without
--                                                holdout_evaluated true and completion_reason RESEARCH_CANDIDATE_PENDING_ACCEPTANCE;
--            mp_package_exports_complete         commit: the export has no seq 1 EXPORT_CANDIDATE event, or its package files are not exactly the 10 + 3 * pine_count
--                                                of the layout (deferred constraint trigger);
--            mp_package_files_guard              file insert: the export is missing, a status event exists, the member ordinal exceeds pine_count, or the sum of bytes
--                                                of the export exceeds 16 MiB;
--            mp_package_status_events_guard      status event insert: the status graph (below);
--            mp_package_attempts_guard           attempt insert: not the next attempt number (5 at most), the export is not an open candidate, a passing or hard-failed
--                                                attempt exists, or the previous attempt has no status event;
--            mp_package_validations_guard        validation insert: the export is not an open candidate, or no passing attempt of this export with the same hashes;
--            mp_package_compile_records_guard    compile record insert: the export is not an open candidate, the ordinal exceeds pine_count, or indicator_sha256 is not
--                                                the SHA-256 of the file members/<ordinal>/indicator.pine of the export;
--            mp_package_evidence_records_guard   evidence record insert: the export is not an open candidate or the ordinal exceeds pine_count;
--            mp_package_clearances_guard         clearance insert: the export is not an open candidate, the ordinal exceeds pine_count, the run is not the run of the
--                                                export, or no evidence record of the blocker kind, ordinal and evidence_hash exists;
--            mp_package_trace_records_guard      trace record insert: the export is not an open candidate, the sha256 is not the SHA-256 of that trace file of the export,
--                                                or run_engine_hash is not the engine_hash of the run.
-- Status graph (no EXPORT_VALIDATED: the status CHECK does not allow it): seq 1 EXPORT_CANDIDATE, written in the transaction that writes the export; each later
-- event follows exactly one validation attempt. A failed attempt with retryable codes only leads to EXPORT_CANDIDATE (attempt 1 to 4) or, on the fifth failure,
-- to EXPORT_REFUSED with the attempt codes plus BI_ATTEMPTS_EXHAUSTED; a failed attempt with any non-retryable code leads to EXPORT_REFUSED with exactly the
-- attempt codes; a passing attempt with its mp_package_validations row leads to EXPORT_INTERNAL (terminal, never READY). Nothing follows a terminal status.
-- Candidate records (compile, evidence, clearance, trace) are accepted only while the latest status is EXPORT_CANDIDATE; a terminal event reads the four record
-- tables of its export (full counts), so a SERIALIZABLE record writer that raced it ends 40001 instead of landing a row after the terminal status.
-- Insert guards never need UPDATE privilege and never lock a package row: they take pg_advisory_xact_lock(hashtextextended('robot:mp-package:' || export_id, 0))
-- first, and the primary and unique keys catch the rest. The application retries 40001 from the start of its transaction.
-- Layout: the path CHECK allows exactly the 19 paths of a three-member package; with the primary key (one row per path) and the ordinal guard, 10 + 3 * pine_count
-- rows are exactly the files of the layout of docs/MULTI_PINE_CONTRACT.md 6.2.
-- The database does not recompute any package or binding hash: the application does (a hash is a tie and never an authorization).
-- Restore limits: a full pg_restore works (data loads before the post-data triggers). A data-only restore into installed tables replays the guards and needs a
-- superuser with --disable-triggers, and logical replication of these tables is not supported.
-- Every function is SECURITY INVOKER, qualifies each name and pins search_path, so a session TEMP table or function named like an extension object can never be
-- used in its place. All triggers are ENABLE ALWAYS, so session_replication_role=replica skips none.
-- Dependency: the run-store extension (mp_run_store_schema version 1) must be INSTALLED, because the export guard reads its tables. This extension holds no foreign
-- key onto it, so the run-store rollback does not fail while this extension is installed: roll this extension back first (its rollback refuses while any row
-- exists). This file is not idempotent by itself: src/postgres/mp-package-store-migration.js classifies the live catalog first and runs it only over ABSENT.
-- Rollback: src/postgres/mp-package-store-rollback.sql drops exactly the objects created here.

CREATE TABLE public.mp_package_store_schema(
 version INTEGER NOT NULL,
 CONSTRAINT mp_package_store_schema_pkey PRIMARY KEY(version),
 CONSTRAINT mp_package_store_schema_version_check CHECK(version=1)
);
INSERT INTO public.mp_package_store_schema VALUES(1);

CREATE TABLE public.mp_package_blobs(
 sha256 TEXT NOT NULL,
 size BIGINT NOT NULL,
 content BYTEA NOT NULL,
 CONSTRAINT mp_package_blobs_pkey PRIMARY KEY(sha256),
 CONSTRAINT mp_package_blobs_sha256_size_key UNIQUE(sha256,size),
 CONSTRAINT mp_package_blobs_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_blobs_size_check CHECK(size>=0 AND size<=16777216),
 CONSTRAINT mp_package_blobs_size_content_check CHECK(pg_catalog.octet_length(content)=size),
 CONSTRAINT mp_package_blobs_hash_content_check CHECK(pg_catalog.encode(pg_catalog.sha256(content),'hex')=sha256)
);

CREATE TABLE public.mp_package_exports(
 export_id UUID NOT NULL,
 owner_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 run_id UUID NOT NULL,
 mode TEXT NOT NULL,
 pine_count SMALLINT NOT NULL,
 fixture BOOLEAN NOT NULL,
 gate_version TEXT NOT NULL,
 library_versions JSONB NOT NULL,
 binding JSONB NOT NULL,
 binding_hash TEXT NOT NULL,
 package_hash TEXT NOT NULL,
 b0 JSONB NOT NULL,
 created_at BIGINT NOT NULL,
 created_at_utc TEXT NOT NULL,
 CONSTRAINT mp_package_exports_pkey PRIMARY KEY(export_id),
 CONSTRAINT mp_package_exports_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id),
 CONSTRAINT mp_package_exports_bot_id_fkey FOREIGN KEY(bot_id) REFERENCES public.users(id),
 CONSTRAINT mp_package_exports_owner_run_key UNIQUE(owner_id,run_id),
 CONSTRAINT mp_package_exports_export_package_key UNIQUE(export_id,package_hash),
 CONSTRAINT mp_package_exports_mode_check CHECK(mode='MULTI_PINE'),
 CONSTRAINT mp_package_exports_pine_count_check CHECK(pine_count>=2 AND pine_count<=3),
 CONSTRAINT mp_package_exports_fixture_check CHECK(fixture),
 CONSTRAINT mp_package_exports_gate_version_check CHECK(pg_catalog.length(gate_version)>0),
 CONSTRAINT mp_package_exports_library_versions_check CHECK(pg_catalog.jsonb_typeof(library_versions)='object'),
 CONSTRAINT mp_package_exports_binding_check CHECK(pg_catalog.jsonb_typeof(binding)='object'),
 CONSTRAINT mp_package_exports_binding_ties_check CHECK(COALESCE(binding->>'owner_id'=owner_id AND binding->>'bot_id'=bot_id AND binding->>'run_id'=run_id::text
  AND binding->>'mode'=mode AND binding->'pine_count'=pg_catalog.to_jsonb(pine_count) AND binding->'fixture'=pg_catalog.to_jsonb(fixture) AND binding->>'created_at'=created_at_utc,false)),
 CONSTRAINT mp_package_exports_b0_check CHECK(pg_catalog.jsonb_typeof(b0)='object'),
 CONSTRAINT mp_package_exports_binding_hash_check CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_exports_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_exports_created_at_check CHECK(created_at>=0 AND created_at<=253402300799999),
 CONSTRAINT mp_package_exports_created_at_utc_check CHECK(created_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.mp_package_files(
 export_id UUID NOT NULL,
 path TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 bytes BIGINT NOT NULL,
 CONSTRAINT mp_package_files_pkey PRIMARY KEY(export_id,path),
 CONSTRAINT mp_package_files_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_files_blob_fkey FOREIGN KEY(sha256,bytes) REFERENCES public.mp_package_blobs(sha256,size),
 CONSTRAINT mp_package_files_path_check CHECK(path ~ '^(inputs\.json|risk-profile\.json|setup-guide\.md|validation\.html|quant-data/(manifest|metrics|validation)\.json|quant-data/(equity|trades|decisions)\.csv|members/[1-3]/indicator\.(pine|json)|quant-data/members/[1-3]/parity\.json)$'),
 CONSTRAINT mp_package_files_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_files_bytes_check CHECK(bytes>=0 AND bytes<=16777216)
);

CREATE TABLE public.mp_package_attempts(
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
 CONSTRAINT mp_package_attempts_pkey PRIMARY KEY(export_id,attempt_no),
 CONSTRAINT mp_package_attempts_attempt_id_key UNIQUE(attempt_id),
 CONSTRAINT mp_package_attempts_export_package_fkey FOREIGN KEY(export_id,package_hash) REFERENCES public.mp_package_exports(export_id,package_hash),
 CONSTRAINT mp_package_attempts_attempt_no_check CHECK(attempt_no>=1 AND attempt_no<=5),
 CONSTRAINT mp_package_attempts_attempt_id_check CHECK(pg_catalog.length(attempt_id)>0),
 CONSTRAINT mp_package_attempts_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_attempts_pass_check CHECK(pass=(pg_catalog.cardinality(codes)=0)),
 CONSTRAINT mp_package_attempts_codes_check CHECK(pg_catalog.cardinality(codes)=0 OR (pg_catalog.array_ndims(codes)=1 AND pg_catalog.array_position(codes,NULL::text) IS NULL
  AND pg_catalog.array_to_string(codes,',') ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$')),
 CONSTRAINT mp_package_attempts_gate_results_check CHECK(pg_catalog.jsonb_typeof(gate_results)='array'),
 CONSTRAINT mp_package_attempts_evidence_refs_check CHECK(pg_catalog.jsonb_typeof(evidence_refs)='object'),
 CONSTRAINT mp_package_attempts_validator_hash_check CHECK(validator_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_attempts_validated_at_ms_check CHECK(validated_at_ms>=0 AND validated_at_ms<=253402300799999),
 CONSTRAINT mp_package_attempts_validated_at_utc_check CHECK(validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

CREATE TABLE public.mp_package_status_events(
 export_id UUID NOT NULL,
 seq INTEGER NOT NULL,
 status TEXT NOT NULL,
 codes TEXT[] NOT NULL,
 attempt_no INTEGER,
 at_ms BIGINT NOT NULL,
 at_utc TEXT NOT NULL,
 CONSTRAINT mp_package_status_events_pkey PRIMARY KEY(export_id,seq),
 CONSTRAINT mp_package_status_events_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_status_events_attempt_fkey FOREIGN KEY(export_id,attempt_no) REFERENCES public.mp_package_attempts(export_id,attempt_no),
 CONSTRAINT mp_package_status_events_attempt_key UNIQUE(export_id,attempt_no),
 CONSTRAINT mp_package_status_events_seq_check CHECK(seq>=1),
 CONSTRAINT mp_package_status_events_status_check CHECK(status IN ('EXPORT_CANDIDATE','EXPORT_INTERNAL','EXPORT_REFUSED')),
 CONSTRAINT mp_package_status_events_first_check CHECK((seq=1 AND status='EXPORT_CANDIDATE' AND attempt_no IS NULL) OR (seq>1 AND attempt_no IS NOT NULL)),
 CONSTRAINT mp_package_status_events_codes_check CHECK(pg_catalog.cardinality(codes)=0 OR (pg_catalog.array_ndims(codes)=1 AND pg_catalog.array_position(codes,NULL::text) IS NULL
  AND pg_catalog.array_to_string(codes,',') ~ '^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$')),
 CONSTRAINT mp_package_status_events_codes_status_check CHECK((status='EXPORT_INTERNAL' AND pg_catalog.cardinality(codes)=0)
  OR (status='EXPORT_REFUSED' AND pg_catalog.cardinality(codes)>0) OR status='EXPORT_CANDIDATE'),
 CONSTRAINT mp_package_status_events_at_ms_check CHECK(at_ms>=0 AND at_ms<=253402300799999),
 CONSTRAINT mp_package_status_events_at_utc_check CHECK(at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

-- RD-MP-37: the validation record of the internal path. Never written to ql4c_validation (its foreign keys name bi_exports and bi_attempts).
CREATE TABLE public.mp_package_validations(
 export_id UUID NOT NULL,
 package_hash TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 gate_results JSONB NOT NULL,
 validator_engine_hash TEXT NOT NULL,
 fixture BOOLEAN NOT NULL,
 mode TEXT NOT NULL,
 validated_at_ms BIGINT NOT NULL,
 validated_at_utc TEXT NOT NULL,
 CONSTRAINT mp_package_validations_pkey PRIMARY KEY(export_id),
 CONSTRAINT mp_package_validations_export_package_key UNIQUE(export_id,package_hash),
 CONSTRAINT mp_package_validations_export_package_fkey FOREIGN KEY(export_id,package_hash) REFERENCES public.mp_package_exports(export_id,package_hash),
 CONSTRAINT mp_package_validations_attempt_id_fkey FOREIGN KEY(attempt_id) REFERENCES public.mp_package_attempts(attempt_id),
 CONSTRAINT mp_package_validations_package_hash_check CHECK(package_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_validations_binding_hash_check CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_validations_gate_results_check CHECK(pg_catalog.jsonb_typeof(gate_results)='array'),
 CONSTRAINT mp_package_validations_validator_hash_check CHECK(validator_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_validations_fixture_check CHECK(fixture),
 CONSTRAINT mp_package_validations_mode_check CHECK(mode='MULTI_PINE'),
 CONSTRAINT mp_package_validations_validated_at_ms_check CHECK(validated_at_ms>=0 AND validated_at_ms<=253402300799999),
 CONSTRAINT mp_package_validations_validated_at_utc_check CHECK(validated_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$')
);

-- RD-MP-41: one compile record per member indicator.pine, bound to that file's SHA-256 (fixture evidence in F11-01).
CREATE TABLE public.mp_package_compile_records(
 compile_id UUID NOT NULL DEFAULT gen_random_uuid(),
 export_id UUID NOT NULL,
 ordinal SMALLINT NOT NULL,
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
 CONSTRAINT mp_package_compile_records_pkey PRIMARY KEY(compile_id),
 CONSTRAINT mp_package_compile_records_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_compile_records_ordinal_check CHECK(ordinal>=1 AND ordinal<=3),
 CONSTRAINT mp_package_compile_records_indicator_check CHECK(indicator_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_compile_records_pine_version_check CHECK(pg_catalog.length(pine_version)>0),
 CONSTRAINT mp_package_compile_records_errors_check CHECK(pg_catalog.jsonb_typeof(errors)='array'),
 CONSTRAINT mp_package_compile_records_warnings_check CHECK(pg_catalog.jsonb_typeof(warnings)='array'),
 CONSTRAINT mp_package_compile_records_counts_check CHECK(unresolved_references>=0 AND collisions>=0 AND duplicate_bindings>=0),
 CONSTRAINT mp_package_compile_records_mapping_check CHECK(pg_catalog.jsonb_typeof(mapping_check)='array'),
 CONSTRAINT mp_package_compile_records_compiled_at_ms_check CHECK(compiled_at_ms>=0 AND compiled_at_ms<=253402300799999),
 CONSTRAINT mp_package_compile_records_compiled_at_utc_check CHECK(compiled_at_utc ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'),
 CONSTRAINT mp_package_compile_records_operator_role_check CHECK(pg_catalog.length(operator_role)>0),
 CONSTRAINT mp_package_compile_records_method_check CHECK(pg_catalog.length(method)>0)
);
CREATE INDEX mp_package_compile_records_export ON public.mp_package_compile_records(export_id);

-- RD-MP-41: per-member evidence records; kind quant_baseline does not exist here (the combined baseline lives in the run result).
CREATE TABLE public.mp_package_evidence_records(
 evidence_id UUID NOT NULL DEFAULT gen_random_uuid(),
 export_id UUID NOT NULL,
 ordinal SMALLINT NOT NULL,
 kind TEXT NOT NULL,
 record JSONB NOT NULL,
 evidence_hash TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT mp_package_evidence_records_pkey PRIMARY KEY(evidence_id),
 CONSTRAINT mp_package_evidence_records_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_evidence_records_unique_key UNIQUE(export_id,ordinal,kind,evidence_hash),
 CONSTRAINT mp_package_evidence_records_ordinal_check CHECK(ordinal>=1 AND ordinal<=3),
 CONSTRAINT mp_package_evidence_records_kind_check CHECK(kind IN ('dataset_alignment','native_parity','bridge_parity','repaint')),
 CONSTRAINT mp_package_evidence_records_record_check CHECK(pg_catalog.jsonb_typeof(record)='object'),
 CONSTRAINT mp_package_evidence_records_hash_check CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_evidence_records_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

-- RD-MP-41: one clearance per (candidate blocker, ordinal).
CREATE TABLE public.mp_package_clearances(
 export_id UUID NOT NULL,
 blocker TEXT NOT NULL,
 ordinal SMALLINT NOT NULL,
 run_id UUID NOT NULL,
 parameter_hash TEXT NOT NULL,
 evidence_hash TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT mp_package_clearances_pkey PRIMARY KEY(export_id,blocker,ordinal,evidence_hash),
 CONSTRAINT mp_package_clearances_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_clearances_blocker_check CHECK(blocker IN ('VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED')),
 CONSTRAINT mp_package_clearances_ordinal_check CHECK(ordinal>=1 AND ordinal<=3),
 CONSTRAINT mp_package_clearances_parameter_hash_check CHECK(parameter_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_clearances_evidence_hash_check CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_clearances_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

-- RD-MP-39: one record per trace file derived from the stored HOLDOUT decisions (stored, never re-evaluated).
CREATE TABLE public.mp_package_trace_records(
 export_id UUID NOT NULL,
 path TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 decisions_hash TEXT NOT NULL,
 steps_digest TEXT NOT NULL,
 holdout_digest TEXT NOT NULL,
 run_engine_hash TEXT NOT NULL,
 producer_closure_hash TEXT NOT NULL,
 method TEXT NOT NULL,
 recorded_at_ms BIGINT NOT NULL,
 CONSTRAINT mp_package_trace_records_pkey PRIMARY KEY(export_id,path),
 CONSTRAINT mp_package_trace_records_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id),
 CONSTRAINT mp_package_trace_records_path_check CHECK(path IN ('quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv')),
 CONSTRAINT mp_package_trace_records_sha256_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_decisions_check CHECK(decisions_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_steps_check CHECK(steps_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_holdout_check CHECK(holdout_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_run_engine_check CHECK(run_engine_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_closure_check CHECK(producer_closure_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT mp_package_trace_records_method_check CHECK(method='stored-holdout-decisions-v1'),
 CONSTRAINT mp_package_trace_records_recorded_at_check CHECK(recorded_at_ms>=0 AND recorded_at_ms<=253402300799999)
);

CREATE FUNCTION public.mp_package_store_version() RETURNS TEXT
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT 'mp-package-store-v1-schema'::text $fn$;

-- The retryable missing-evidence codes of PKG 6.1 (RETRYABLE_CODES of src/quant-library/package-gates.js; a test pins the two together).
CREATE FUNCTION public.mp_package_store_retryable_codes() RETURNS TEXT[]
 LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT ARRAY['BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_WARNINGS_UNREVIEWED','BI_NATIVE_ALERT_ISOLATION_UNPROVEN','BI_DATASET_ALIGNMENT_MISSING','BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']::text[] $fn$;

CREATE FUNCTION public.mp_package_store_freeze() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 RAISE EXCEPTION 'Multi-Pine package store records are insert-only' USING ERRCODE = 'QR002';
END $fn$;

-- Every INSERT into a package-store table must run in a SERIALIZABLE transaction (QR003, as for the run store).
CREATE FUNCTION public.mp_package_store_require_serializable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'Multi-Pine package store writes require a SERIALIZABLE transaction' USING ERRCODE = 'QR003';
 END IF;
 RETURN NEW;
END $fn$;

-- Serializes the writers of one export (status events, attempts, files and evidence rows), without locking any package row.
CREATE FUNCTION public.mp_package_store_lock_export(p_export UUID) RETURNS void
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('robot:mp-package:' || p_export::text, 0));
END $fn$;

-- The status of the highest seq, or NULL while the export has no status event. A SERIALIZABLE writer reads its transaction snapshot after the lock.
CREATE FUNCTION public.mp_package_store_latest_status(p_export UUID) RETURNS text
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE found_status TEXT;
BEGIN
 SELECT e.status INTO found_status FROM public.mp_package_status_events e WHERE e.export_id = p_export ORDER BY e.seq DESC LIMIT 1;
 RETURN found_status;
END $fn$;

-- The common opening of the candidate-record guards: take the export lock, then require the latest status EXPORT_CANDIDATE. p_guard is the trigger name.
CREATE FUNCTION public.mp_package_store_require_candidate(p_export UUID, p_guard TEXT) RETURNS void
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 PERFORM public.mp_package_store_lock_export(p_export);
 IF public.mp_package_store_latest_status(p_export) IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'The export needs the latest status EXPORT_CANDIDATE' USING ERRCODE = 'QR004', CONSTRAINT = p_guard;
 END IF;
END $fn$;

-- Export insert: the run is read by SELECT (no foreign key onto the run store, judgement J1).
CREATE FUNCTION public.mp_package_store_guard_export() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE run_row RECORD; last_event RECORD;
BEGIN
 SELECT r.owner_id, r.bot_id, r.pine_count, r.contract_version INTO run_row FROM public.mp_research_runs r WHERE r.run_id = NEW.run_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A package export needs an existing multi-Pine research run' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 IF run_row.owner_id IS DISTINCT FROM NEW.owner_id OR run_row.bot_id IS DISTINCT FROM NEW.bot_id THEN
  RAISE EXCEPTION 'A package export owner and Bot must equal the research run owner and Bot' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 IF run_row.pine_count IS DISTINCT FROM NEW.pine_count THEN
  RAISE EXCEPTION 'A package export pine_count must equal the pine_count of its research run' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 IF run_row.contract_version IS DISTINCT FROM 'ql3a-research-job-multi-v1' THEN
  RAISE EXCEPTION 'A package export needs a research run of contract version ql3a-research-job-multi-v1' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 SELECT e.status, e.result INTO last_event FROM public.mp_research_run_events e WHERE e.run_id = NEW.run_id ORDER BY e.seq DESC LIMIT 1;
 IF NOT FOUND OR last_event.status IS DISTINCT FROM 'SUCCEEDED' THEN
  RAISE EXCEPTION 'A package export needs a research run whose last event is SUCCEEDED' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 IF (last_event.result OPERATOR(pg_catalog.->) 'holdout_evaluated'::text) IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'A package export needs a research run whose result has holdout_evaluated true' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 IF (last_event.result OPERATOR(pg_catalog.->) 'completion_reason'::text) IS DISTINCT FROM '"RESEARCH_CANDIDATE_PENDING_ACCEPTANCE"'::jsonb THEN
  RAISE EXCEPTION 'A package export needs a research run with completion_reason RESEARCH_CANDIDATE_PENDING_ACCEPTANCE' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_guard';
 END IF;
 RETURN NEW;
END $fn$;

-- Deferred to commit: an export commits only with its seq 1 EXPORT_CANDIDATE event and exactly the 10 + 3 * pine_count files of the layout.
CREATE FUNCTION public.mp_package_store_guard_export_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.mp_package_status_events e WHERE e.export_id = NEW.export_id AND e.seq = 1 AND e.status = 'EXPORT_CANDIDATE') THEN
  RAISE EXCEPTION 'A package export needs its EXPORT_CANDIDATE status event in the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_complete';
 END IF;
 -- The path CHECK allows 19 paths, the primary key one row per path and the file guard refuses an ordinal above pine_count, so 10 + 3 * pine_count rows are exactly the layout.
 IF (SELECT pg_catalog.count(*) FROM public.mp_package_files f WHERE f.export_id = NEW.export_id) IS DISTINCT FROM (10 OPERATOR(pg_catalog.+) (3 OPERATOR(pg_catalog.*) NEW.pine_count))
    OR NOT EXISTS (SELECT 1 FROM public.mp_package_files f WHERE f.export_id = NEW.export_id AND f.path = 'quant-data/manifest.json') THEN
  RAISE EXCEPTION 'A package export needs exactly its 10 + 3 * pine_count package files, quant-data/manifest.json included, in the same transaction' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_exports_complete';
 END IF;
 RETURN NULL;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_file() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE used BIGINT; export_count SMALLINT; member_text TEXT;
BEGIN
 PERFORM public.mp_package_store_lock_export(NEW.export_id);
 SELECT x.pine_count INTO export_count FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A package file needs its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_files_guard';
 END IF;
 IF public.mp_package_store_latest_status(NEW.export_id) IS NOT NULL THEN
  RAISE EXCEPTION 'Package files cannot be added after the first status event' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_files_guard';
 END IF;
 member_text := pg_catalog.substring(NEW.path, '^(?:members|quant-data/members)/([1-3])/');
 IF member_text IS NOT NULL AND member_text::integer OPERATOR(pg_catalog.>) export_count THEN
  RAISE EXCEPTION 'A member file ordinal cannot exceed the pine_count of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_files_guard';
 END IF;
 SELECT COALESCE(pg_catalog.sum(f.bytes), 0) INTO used FROM public.mp_package_files f WHERE f.export_id = NEW.export_id;
 IF (used OPERATOR(pg_catalog.+) NEW.bytes) OPERATOR(pg_catalog.>) 16777216 THEN
  RAISE EXCEPTION 'Package files of one export exceed 16 MiB' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_files_guard';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_status() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE last_seq INTEGER; last_status TEXT; latest RECORD; retryable_only BOOLEAN; expected_codes TEXT[];
BEGIN
 PERFORM public.mp_package_store_lock_export(NEW.export_id);
 IF NOT EXISTS (SELECT 1 FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id) THEN
  RAISE EXCEPTION 'A status event needs its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
 END IF;
 SELECT e.seq, e.status INTO last_seq, last_status FROM public.mp_package_status_events e WHERE e.export_id = NEW.export_id ORDER BY e.seq DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.seq IS DISTINCT FROM 1 OR NEW.status IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
   RAISE EXCEPTION 'The first status event must be seq 1 EXPORT_CANDIDATE' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
  END IF;
  RETURN NEW;
 END IF;
 IF last_status IS DISTINCT FROM 'EXPORT_CANDIDATE' THEN
  RAISE EXCEPTION 'No status event may follow a terminal status' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
 END IF;
 IF NEW.seq IS DISTINCT FROM (last_seq OPERATOR(pg_catalog.+) 1) THEN
  RAISE EXCEPTION 'A status event must have seq = last + 1' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
 END IF;
 SELECT a.attempt_no, a.attempt_id, a.pass, a.codes INTO latest FROM public.mp_package_attempts a WHERE a.export_id = NEW.export_id ORDER BY a.attempt_no DESC LIMIT 1;
 IF NOT FOUND OR latest.attempt_no IS DISTINCT FROM NEW.attempt_no THEN
  RAISE EXCEPTION 'A status event must follow the latest validation attempt' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
 END IF;
 -- A terminal event also reads the four candidate-record tables of the export (full counts, no early stop), so a SERIALIZABLE record writer that waited for the lock
 -- before this event commits gets 40001 instead of landing a row after the terminal status.
 IF NEW.status <> 'EXPORT_CANDIDATE' THEN
  PERFORM pg_catalog.count(*) FROM public.mp_package_evidence_records r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.mp_package_compile_records r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.mp_package_clearances r WHERE r.export_id = NEW.export_id;
  PERFORM pg_catalog.count(*) FROM public.mp_package_trace_records r WHERE r.export_id = NEW.export_id;
 END IF;
 IF NEW.status = 'EXPORT_INTERNAL' THEN
  IF latest.pass IS DISTINCT FROM true
     OR NOT EXISTS (SELECT 1 FROM public.mp_package_validations v WHERE v.export_id = NEW.export_id AND v.attempt_id = latest.attempt_id) THEN
   RAISE EXCEPTION 'EXPORT_INTERNAL needs a passing attempt and its mp_package_validations row' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
  END IF;
 ELSE
  IF latest.pass IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'A passing attempt can only lead to EXPORT_INTERNAL' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
  END IF;
  -- Any other status value meets the status CHECK (EXPORT_VALIDATED does not exist in this store).
  IF NEW.status IN ('EXPORT_CANDIDATE', 'EXPORT_REFUSED') THEN
   retryable_only := latest.codes OPERATOR(pg_catalog.<@) public.mp_package_store_retryable_codes();
   IF NEW.status = 'EXPORT_CANDIDATE' THEN
    IF NOT retryable_only THEN
     RAISE EXCEPTION 'A non-retryable code can only lead to EXPORT_REFUSED' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
    END IF;
    IF NEW.attempt_no >= 5 THEN
     RAISE EXCEPTION 'The fifth failed attempt must end EXPORT_REFUSED' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
    END IF;
    expected_codes := latest.codes;
   ELSE
    IF retryable_only AND NEW.attempt_no <> 5 THEN
     RAISE EXCEPTION 'EXPORT_REFUSED needs a non-retryable code, or the fifth failed attempt with BI_ATTEMPTS_EXHAUSTED' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
    END IF;
    expected_codes := CASE WHEN retryable_only THEN latest.codes OPERATOR(pg_catalog.||) ARRAY['BI_ATTEMPTS_EXHAUSTED']::text[] ELSE latest.codes END;
   END IF;
   IF NOT (NEW.codes OPERATOR(pg_catalog.@>) expected_codes) THEN
    RAISE EXCEPTION 'A status event after a failed attempt must carry the codes of that attempt (and BI_ATTEMPTS_EXHAUSTED on the retryable fifth failure)' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
   END IF;
   IF NOT (NEW.codes OPERATOR(pg_catalog.<@) expected_codes) THEN
    RAISE EXCEPTION 'A status event after a failed attempt must carry exactly the codes of that attempt (BI_ATTEMPTS_EXHAUSTED only on the retryable fifth failure)' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_status_events_guard';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_attempt() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_package TEXT; attempts INTEGER; any_pass BOOLEAN; any_hard BOOLEAN;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_attempts_guard');
 SELECT x.package_hash INTO export_package FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.package_hash IS DISTINCT FROM export_package THEN
  RAISE EXCEPTION 'A validation attempt must name the export package_hash' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 IF NEW.codes OPERATOR(pg_catalog.@>) ARRAY['BI_ATTEMPTS_EXHAUSTED']::text[] THEN
  RAISE EXCEPTION 'BI_ATTEMPTS_EXHAUSTED is a status code, never an attempt code' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 SELECT pg_catalog.count(*)::integer, COALESCE(pg_catalog.bool_or(a.pass), false),
   COALESCE(pg_catalog.bool_or(NOT a.pass AND NOT (a.codes OPERATOR(pg_catalog.<@) public.mp_package_store_retryable_codes())), false)
   INTO attempts, any_pass, any_hard FROM public.mp_package_attempts a WHERE a.export_id = NEW.export_id;
 IF any_pass THEN
  RAISE EXCEPTION 'No validation attempt may follow a passing attempt' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 IF any_hard THEN
  RAISE EXCEPTION 'No validation attempt may follow an attempt with a non-retryable code' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 IF attempts >= 5 OR NEW.attempt_no IS DISTINCT FROM (attempts OPERATOR(pg_catalog.+) 1) THEN
  RAISE EXCEPTION 'attempt_no must be the attempt count + 1, at most 5' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 IF attempts > 0 AND NOT EXISTS (SELECT 1 FROM public.mp_package_status_events e WHERE e.export_id = NEW.export_id AND e.attempt_no = attempts) THEN
  RAISE EXCEPTION 'A validation attempt needs the status event of the previous attempt' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_attempts_guard';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_validation() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_row RECORD; attempt_row RECORD;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_validations_guard');
 SELECT x.package_hash, x.binding_hash, x.fixture INTO export_row FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.package_hash IS DISTINCT FROM export_row.package_hash OR NEW.binding_hash IS DISTINCT FROM export_row.binding_hash
    OR NEW.fixture IS DISTINCT FROM export_row.fixture THEN
  RAISE EXCEPTION 'A validation record must match the export package_hash, binding_hash and fixture flag' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_validations_guard';
 END IF;
 SELECT a.pass, a.package_hash, a.validator_engine_hash INTO attempt_row FROM public.mp_package_attempts a WHERE a.export_id = NEW.export_id AND a.attempt_id = NEW.attempt_id;
 IF NOT FOUND OR attempt_row.pass IS DISTINCT FROM true OR attempt_row.package_hash IS DISTINCT FROM NEW.package_hash
    OR attempt_row.validator_engine_hash IS DISTINCT FROM NEW.validator_engine_hash THEN
  RAISE EXCEPTION 'A validation record needs a passing attempt of this export with the same package_hash and validator hash' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_validations_guard';
 END IF;
 RETURN NEW;
END $fn$;

-- Compile record: the ordinal is a member of the export and the record is bound to the SHA-256 of that member's indicator.pine.
CREATE FUNCTION public.mp_package_store_guard_compile() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_count SMALLINT; file_hash TEXT;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_compile_records_guard');
 SELECT x.pine_count INTO export_count FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.ordinal OPERATOR(pg_catalog.>) export_count THEN
  RAISE EXCEPTION 'A compile record ordinal cannot exceed the pine_count of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_compile_records_guard';
 END IF;
 SELECT f.sha256 INTO file_hash FROM public.mp_package_files f WHERE f.export_id = NEW.export_id AND f.path = 'members/' || NEW.ordinal::text || '/indicator.pine';
 IF NOT FOUND OR file_hash IS DISTINCT FROM NEW.indicator_sha256 THEN
  RAISE EXCEPTION 'A compile record must name the SHA-256 of the member indicator.pine of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_compile_records_guard';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_evidence() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_count SMALLINT;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_evidence_records_guard');
 SELECT x.pine_count INTO export_count FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.ordinal OPERATOR(pg_catalog.>) export_count THEN
  RAISE EXCEPTION 'An evidence record ordinal cannot exceed the pine_count of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_evidence_records_guard';
 END IF;
 RETURN NEW;
END $fn$;

CREATE FUNCTION public.mp_package_store_guard_clearance() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE export_row RECORD; proof_kind TEXT;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_clearances_guard');
 SELECT x.run_id, x.pine_count INTO export_row FROM public.mp_package_exports x WHERE x.export_id = NEW.export_id;
 IF NEW.run_id IS DISTINCT FROM export_row.run_id THEN
  RAISE EXCEPTION 'A clearance must name the run of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_clearances_guard';
 END IF;
 IF NEW.ordinal OPERATOR(pg_catalog.>) export_row.pine_count THEN
  RAISE EXCEPTION 'A clearance ordinal cannot exceed the pine_count of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_clearances_guard';
 END IF;
 -- The evidence record a clearance of that blocker must carry, for the same member; an unknown blocker meets the CHECK.
 proof_kind := CASE NEW.blocker WHEN 'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED' THEN 'native_parity' WHEN 'CUSTOM_REPAINT_EVIDENCE_REQUIRED' THEN 'repaint' ELSE NULL END;
 IF proof_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.mp_package_evidence_records r
    WHERE r.export_id = NEW.export_id AND r.ordinal = NEW.ordinal AND r.kind = proof_kind AND r.evidence_hash = NEW.evidence_hash) THEN
  RAISE EXCEPTION 'A clearance needs an evidence record of its export and member with the same evidence_hash and the kind of its blocker' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_clearances_guard';
 END IF;
 RETURN NEW;
END $fn$;

-- Trace record: the SHA-256 is the one of that trace file of the export, and the engine hash is the one of the run (RD-MP-39: the stored steps are not re-evaluated).
CREATE FUNCTION public.mp_package_store_guard_trace() RETURNS trigger
 LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE file_hash TEXT; run_engine TEXT;
BEGIN
 PERFORM public.mp_package_store_require_candidate(NEW.export_id, 'mp_package_trace_records_guard');
 SELECT f.sha256 INTO file_hash FROM public.mp_package_files f WHERE f.export_id = NEW.export_id AND f.path = NEW.path;
 IF NOT FOUND OR file_hash IS DISTINCT FROM NEW.sha256 THEN
  RAISE EXCEPTION 'A trace record must name the SHA-256 of that trace file of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_trace_records_guard';
 END IF;
 SELECT r.engine_hash INTO run_engine FROM public.mp_package_exports x JOIN public.mp_research_runs r ON r.run_id = x.run_id WHERE x.export_id = NEW.export_id;
 IF NOT FOUND OR run_engine IS DISTINCT FROM NEW.run_engine_hash THEN
  RAISE EXCEPTION 'A trace record run_engine_hash must equal the engine_hash of the run of its export' USING ERRCODE = 'QR004', CONSTRAINT = 'mp_package_trace_records_guard';
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER mp_package_store_schema_no_change BEFORE UPDATE OR DELETE ON public.mp_package_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_store_schema_no_truncate BEFORE TRUNCATE ON public.mp_package_store_schema FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_blobs_no_change BEFORE UPDATE OR DELETE ON public.mp_package_blobs FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_blobs_no_truncate BEFORE TRUNCATE ON public.mp_package_blobs FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_exports_no_change BEFORE UPDATE OR DELETE ON public.mp_package_exports FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_exports_no_truncate BEFORE TRUNCATE ON public.mp_package_exports FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_files_no_change BEFORE UPDATE OR DELETE ON public.mp_package_files FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_files_no_truncate BEFORE TRUNCATE ON public.mp_package_files FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_status_events_no_change BEFORE UPDATE OR DELETE ON public.mp_package_status_events FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_status_events_no_truncate BEFORE TRUNCATE ON public.mp_package_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_attempts_no_change BEFORE UPDATE OR DELETE ON public.mp_package_attempts FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_attempts_no_truncate BEFORE TRUNCATE ON public.mp_package_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_validations_no_change BEFORE UPDATE OR DELETE ON public.mp_package_validations FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_validations_no_truncate BEFORE TRUNCATE ON public.mp_package_validations FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_compile_records_no_change BEFORE UPDATE OR DELETE ON public.mp_package_compile_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_compile_records_no_truncate BEFORE TRUNCATE ON public.mp_package_compile_records FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_evidence_records_no_change BEFORE UPDATE OR DELETE ON public.mp_package_evidence_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_evidence_records_no_truncate BEFORE TRUNCATE ON public.mp_package_evidence_records FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_clearances_no_change BEFORE UPDATE OR DELETE ON public.mp_package_clearances FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_clearances_no_truncate BEFORE TRUNCATE ON public.mp_package_clearances FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_trace_records_no_change BEFORE UPDATE OR DELETE ON public.mp_package_trace_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze();
CREATE TRIGGER mp_package_trace_records_no_truncate BEFORE TRUNCATE ON public.mp_package_trace_records FOR EACH STATEMENT EXECUTE FUNCTION public.mp_package_store_freeze();

CREATE TRIGGER mp_package_store_schema_00_serializable BEFORE INSERT ON public.mp_package_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_blobs_00_serializable BEFORE INSERT ON public.mp_package_blobs FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_exports_00_serializable BEFORE INSERT ON public.mp_package_exports FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_files_00_serializable BEFORE INSERT ON public.mp_package_files FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_status_events_00_serializable BEFORE INSERT ON public.mp_package_status_events FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_attempts_00_serializable BEFORE INSERT ON public.mp_package_attempts FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_validations_00_serializable BEFORE INSERT ON public.mp_package_validations FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_compile_records_00_serializable BEFORE INSERT ON public.mp_package_compile_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_evidence_records_00_serializable BEFORE INSERT ON public.mp_package_evidence_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_clearances_00_serializable BEFORE INSERT ON public.mp_package_clearances FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();
CREATE TRIGGER mp_package_trace_records_00_serializable BEFORE INSERT ON public.mp_package_trace_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_require_serializable();

CREATE TRIGGER mp_package_exports_guard BEFORE INSERT ON public.mp_package_exports FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_export();
CREATE CONSTRAINT TRIGGER mp_package_exports_complete AFTER INSERT ON public.mp_package_exports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_export_complete();
CREATE TRIGGER mp_package_files_guard BEFORE INSERT ON public.mp_package_files FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_file();
CREATE TRIGGER mp_package_status_events_guard BEFORE INSERT ON public.mp_package_status_events FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_status();
CREATE TRIGGER mp_package_attempts_guard BEFORE INSERT ON public.mp_package_attempts FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_attempt();
CREATE TRIGGER mp_package_validations_guard BEFORE INSERT ON public.mp_package_validations FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_validation();
CREATE TRIGGER mp_package_compile_records_guard BEFORE INSERT ON public.mp_package_compile_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_compile();
CREATE TRIGGER mp_package_evidence_records_guard BEFORE INSERT ON public.mp_package_evidence_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_evidence();
CREATE TRIGGER mp_package_clearances_guard BEFORE INSERT ON public.mp_package_clearances FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_clearance();
CREATE TRIGGER mp_package_trace_records_guard BEFORE INSERT ON public.mp_package_trace_records FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_trace();

ALTER TABLE public.mp_package_store_schema ENABLE ALWAYS TRIGGER mp_package_store_schema_no_change;
ALTER TABLE public.mp_package_store_schema ENABLE ALWAYS TRIGGER mp_package_store_schema_no_truncate;
ALTER TABLE public.mp_package_blobs ENABLE ALWAYS TRIGGER mp_package_blobs_no_change;
ALTER TABLE public.mp_package_blobs ENABLE ALWAYS TRIGGER mp_package_blobs_no_truncate;
ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_no_change;
ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_no_truncate;
ALTER TABLE public.mp_package_files ENABLE ALWAYS TRIGGER mp_package_files_no_change;
ALTER TABLE public.mp_package_files ENABLE ALWAYS TRIGGER mp_package_files_no_truncate;
ALTER TABLE public.mp_package_status_events ENABLE ALWAYS TRIGGER mp_package_status_events_no_change;
ALTER TABLE public.mp_package_status_events ENABLE ALWAYS TRIGGER mp_package_status_events_no_truncate;
ALTER TABLE public.mp_package_attempts ENABLE ALWAYS TRIGGER mp_package_attempts_no_change;
ALTER TABLE public.mp_package_attempts ENABLE ALWAYS TRIGGER mp_package_attempts_no_truncate;
ALTER TABLE public.mp_package_validations ENABLE ALWAYS TRIGGER mp_package_validations_no_change;
ALTER TABLE public.mp_package_validations ENABLE ALWAYS TRIGGER mp_package_validations_no_truncate;
ALTER TABLE public.mp_package_compile_records ENABLE ALWAYS TRIGGER mp_package_compile_records_no_change;
ALTER TABLE public.mp_package_compile_records ENABLE ALWAYS TRIGGER mp_package_compile_records_no_truncate;
ALTER TABLE public.mp_package_evidence_records ENABLE ALWAYS TRIGGER mp_package_evidence_records_no_change;
ALTER TABLE public.mp_package_evidence_records ENABLE ALWAYS TRIGGER mp_package_evidence_records_no_truncate;
ALTER TABLE public.mp_package_clearances ENABLE ALWAYS TRIGGER mp_package_clearances_no_change;
ALTER TABLE public.mp_package_clearances ENABLE ALWAYS TRIGGER mp_package_clearances_no_truncate;
ALTER TABLE public.mp_package_trace_records ENABLE ALWAYS TRIGGER mp_package_trace_records_no_change;
ALTER TABLE public.mp_package_trace_records ENABLE ALWAYS TRIGGER mp_package_trace_records_no_truncate;
ALTER TABLE public.mp_package_store_schema ENABLE ALWAYS TRIGGER mp_package_store_schema_00_serializable;
ALTER TABLE public.mp_package_blobs ENABLE ALWAYS TRIGGER mp_package_blobs_00_serializable;
ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_00_serializable;
ALTER TABLE public.mp_package_files ENABLE ALWAYS TRIGGER mp_package_files_00_serializable;
ALTER TABLE public.mp_package_status_events ENABLE ALWAYS TRIGGER mp_package_status_events_00_serializable;
ALTER TABLE public.mp_package_attempts ENABLE ALWAYS TRIGGER mp_package_attempts_00_serializable;
ALTER TABLE public.mp_package_validations ENABLE ALWAYS TRIGGER mp_package_validations_00_serializable;
ALTER TABLE public.mp_package_compile_records ENABLE ALWAYS TRIGGER mp_package_compile_records_00_serializable;
ALTER TABLE public.mp_package_evidence_records ENABLE ALWAYS TRIGGER mp_package_evidence_records_00_serializable;
ALTER TABLE public.mp_package_clearances ENABLE ALWAYS TRIGGER mp_package_clearances_00_serializable;
ALTER TABLE public.mp_package_trace_records ENABLE ALWAYS TRIGGER mp_package_trace_records_00_serializable;
ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_guard;
ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_complete;
ALTER TABLE public.mp_package_files ENABLE ALWAYS TRIGGER mp_package_files_guard;
ALTER TABLE public.mp_package_status_events ENABLE ALWAYS TRIGGER mp_package_status_events_guard;
ALTER TABLE public.mp_package_attempts ENABLE ALWAYS TRIGGER mp_package_attempts_guard;
ALTER TABLE public.mp_package_validations ENABLE ALWAYS TRIGGER mp_package_validations_guard;
ALTER TABLE public.mp_package_compile_records ENABLE ALWAYS TRIGGER mp_package_compile_records_guard;
ALTER TABLE public.mp_package_evidence_records ENABLE ALWAYS TRIGGER mp_package_evidence_records_guard;
ALTER TABLE public.mp_package_clearances ENABLE ALWAYS TRIGGER mp_package_clearances_guard;
ALTER TABLE public.mp_package_trace_records ENABLE ALWAYS TRIGGER mp_package_trace_records_guard;
