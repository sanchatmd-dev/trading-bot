import {createHash} from 'node:crypto';
import {hash} from './source.js';

// RD-MP-12 option A: the exit version is never stored on a deployment. It is
// derived from the integrated Pine artifact that snapshot.artifact_hash pins.
// Pure: no database, file, clock or network access, never throws on bad input,
// and is wired into nothing yet.

// Every exit version the template has emitted: bridge-exit-v1 (commit c89922b)
// and bridge-exit-v2. This function reports the version the artifact carries; it
// does not decide whether that version is supported. Admission is a separate rule
// outside this function: the package gates support v2 only, and member-set
// admission refuses unsupported versions (RD-MP-14). Never derive this list from
// snapshot.instruction_versions.template, which is the template revision label
// (bridge-exit-v3), not the exit contract.
export const KNOWN_EXIT_VERSIONS = Object.freeze(['bridge-exit-v1', 'bridge-exit-v2']);

const FIELD = 'deployment.exit_version';
// The template appends this opening after the user's source bytes (assemble in
// template.js). Only text from here on is Bridge-emitted and parsed.
const BLOCK_OPEN = '\n\n// Robot Trade bridge-exit-v';
const HEADER = /^\/\/ Robot Trade (bridge-exit-v[^\s.]*)\./;
// The prefix sits inside a Pine string literal, so quotes are backslash-escaped.
const PREFIX = /\{\\"schema_version\\":\\"([^\\"\r\n]*)\\",\\"deployment_id\\":\\"([^\\"\r\n]*)\\"/g;

const refuse = reason => Object.freeze({ok: false, code: 'MP_INPUT_INVALID', field: FIELD, reason});

// Index where the Bridge block starts: the user source before it must hash to the
// snapshot source_hash, so user text that imitates the opening cannot move it.
function bridgeBlockStart(artifact, sourceHash) {
  // One running SHA-256 over the artifact; copy() digests each candidate prefix
  // without rehashing from byte 0, so many imitated openings stay linear.
  const running = createHash('sha256');
  let done = 0;
  for (let i = artifact.indexOf(BLOCK_OPEN); i !== -1; i = artifact.indexOf(BLOCK_OPEN, i + 1)) {
    running.update(artifact.slice(done, i));
    done = i;
    if (running.copy().digest('hex') === sourceHash) return i;
  }
  return -1;
}

export function deploymentExitVersion(artifact, snapshot, deploymentId) {
  try {
    if (typeof artifact !== 'string' || artifact.length === 0 || !artifact.isWellFormed()) return refuse('ARTIFACT_NOT_STRING');
    if (typeof deploymentId !== 'string' || deploymentId.length === 0) return refuse('DEPLOYMENT_ID_INVALID');
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return refuse('SNAPSHOT_MISSING');
    const pinned = snapshot.artifact_hash;
    if (typeof pinned !== 'string' || pinned.length === 0) return refuse('ARTIFACT_HASH_MISSING');
    if (hash(artifact) !== pinned) return refuse('ARTIFACT_HASH_MISMATCH');
    const sourceHash = snapshot.source_hash;
    if (typeof sourceHash !== 'string' || sourceHash.length === 0) return refuse('SOURCE_HASH_MISSING');
    const start = bridgeBlockStart(artifact, sourceHash);
    if (start === -1) return refuse('SOURCE_HASH_MISMATCH');
    const block = artifact.slice(start);

    const headers = block.split('\n').map(line => HEADER.exec(line.endsWith('\r') ? line.slice(0, -1) : line)).filter(Boolean);
    if (headers.length === 0) return refuse('EXIT_HEADER_MISSING');
    if (headers.length > 1) return refuse('EXIT_HEADER_DUPLICATE');

    const prefixes = [...block.matchAll(PREFIX)];
    if (prefixes.length === 0) return refuse('ALERT_PREFIX_MISSING');
    if (prefixes.length > 1) return refuse('ALERT_PREFIX_DUPLICATE');
    if (prefixes[0][2] !== deploymentId) return refuse('ALERT_PREFIX_DEPLOYMENT_MISMATCH');

    const version = headers[0][1];
    if (prefixes[0][1] !== version) return refuse('EXIT_VERSION_DISAGREE');
    if (!KNOWN_EXIT_VERSIONS.includes(version)) return refuse('EXIT_VERSION_UNKNOWN');
    return Object.freeze({ok: true, exit_version: version});
  } catch {
    return refuse('EXIT_VERSION_UNDERIVABLE');
  }
}
