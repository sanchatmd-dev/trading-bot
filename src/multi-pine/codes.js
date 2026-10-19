import {MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER} from '../quant-library/package-gates.js';

/*
 * F11-01 S1 constants (docs/MULTI_PINE_CONTRACT.md sections 3, 5.5 and 8; root decisions RD-MP-1 option A, 2026-10-19).
 * The contract version and the capability blocker are owned by package-gates.js and re-exported here, never redefined.
 * Pure data: no I/O, no clock, no randomness.
 */
export {MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER};
/** OD-MP-1: at most three members in one multi-Pine Bot for F11-01. */
export const MP_MAX_MEMBERS=3;
/** A multi-Pine set has at least two members (section 3.2). */
export const MP_MIN_MEMBERS=2;
/** RD-MP-1: version of the member set record. It sits inside the record, so inside set_hash and content_digest. */
export const MP_MEMBER_SET_VERSION='mp-member-set-v1';
/** RD-MP-1: combined Paper evaluator id (used by later slices; reserved here so the name is frozen in one place). */
export const MP_COMBINED_EVALUATOR='mp-combined-paper-v1';
/** OD-MP-2, RD-MP-1: same-bar order across members. The member set record carries it (RC-MP-1 content_digest covers it). */
export const MP_SAME_BAR_ORDER='exit-first-ordinal-v1';
/** Bridge ATR period is versioned configuration, not a dimension (section 4). */
export const MP_BRIDGE_ATR_PERIOD=14;
export const MP_MODE='MULTI_PINE';
export const MP_CODE_PATTERN=/^[A-Z][A-Z0-9_]{1,63}$/;

/** Section 8.2: every new code of the contract, in table order. The S1 builder emits the subset marked in MP_S1_CODES. */
export const MP_CODES=Object.freeze({
  MEMBERSHIP_EMPTY:'MP_MEMBERSHIP_EMPTY',
  MEMBER_COUNT_EXCEEDED:'MP_MEMBER_COUNT_EXCEEDED',
  MEMBER_DUPLICATE_LOGIC:'MP_MEMBER_DUPLICATE_LOGIC',
  MEMBER_FOREIGN_BOT:'MP_MEMBER_FOREIGN_BOT',
  MEMBER_DEPLOYMENT_MISSING:'MP_MEMBER_DEPLOYMENT_MISSING',
  MEMBER_DEPLOYMENT_AMBIGUOUS:'MP_MEMBER_DEPLOYMENT_AMBIGUOUS',
  MEMBER_DEPLOYMENT_NOT_ELIGIBLE:'MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE',
  MEMBER_EVIDENCE_MISSING:'MP_MEMBER_EVIDENCE_MISSING',
  MEMBER_SET_STALE:'MP_MEMBER_SET_STALE',
  BRIDGE_PAIR_DIVERGENT:'MP_BRIDGE_PAIR_DIVERGENT',
  MARKET_MIXED:'MP_MARKET_MIXED',
  EXIT_VERSION_MIXED:'MP_EXIT_VERSION_MIXED',
  EXECUTION_MODEL_MIXED:'MP_EXECUTION_MODEL_MIXED',
  SOURCE_SLOTS_FORBIDDEN:'MP_SOURCE_SLOTS_FORBIDDEN',
  MEMBER_QUANT_UNSUPPORTED:'MP_MEMBER_QUANT_UNSUPPORTED',
  MEMBER_NO_SIGNALS:'MP_MEMBER_NO_SIGNALS',
  EVENT_ORDER_UNDEFINED:'MP_EVENT_ORDER_UNDEFINED',
  MEMBER_PARITY_SCOPE_MISMATCH:'MP_MEMBER_PARITY_SCOPE_MISMATCH',
  COMBINED_BASELINE_FAILED:'MP_COMBINED_BASELINE_FAILED',
  CROSS_SOURCE_TARGET:'MP_CROSS_SOURCE_TARGET',
  FIXTURE_ONLY:'MP_FIXTURE_ONLY',
  OWNER_FACING_FORBIDDEN:'MP_OWNER_FACING_FORBIDDEN',
  /** S1 additions, not in contract 8.2 (reported to root): the pure builder must fail closed on malformed or non-multi input. */
  INPUT_INVALID:'MP_INPUT_INVALID',
  NOT_MULTI_PINE:'MP_NOT_MULTI_PINE'
});
export const MP_CODE_LIST=Object.freeze(Object.values(MP_CODES));

/**
 * Codes the S1 member-set module can return. T-M4 and the negation tests pin this list.
 * MP_MARKET_MIXED is not here: root ruling M4 refuses every market except binance-global BTCUSDT 1m with MP_INPUT_INVALID
 * (field market.unsupported) before members can be compared, so two members can never bind different markets.
 */
export const MP_S1_CODES=Object.freeze([
  MP_CODES.INPUT_INVALID,MP_CODES.FIXTURE_ONLY,MP_CODES.MEMBER_FOREIGN_BOT,MP_CODES.MEMBERSHIP_EMPTY,MP_CODES.NOT_MULTI_PINE,
  MP_CODES.MEMBER_COUNT_EXCEEDED,MP_CODES.MEMBER_DUPLICATE_LOGIC,MP_CODES.MEMBER_DEPLOYMENT_MISSING,MP_CODES.MEMBER_DEPLOYMENT_AMBIGUOUS,
  MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,MP_CODES.MEMBER_EVIDENCE_MISSING,MP_CODES.MEMBER_SET_STALE,MP_CODES.BRIDGE_PAIR_DIVERGENT,
  MP_CODES.EXIT_VERSION_MIXED,MP_CODES.EXECUTION_MODEL_MIXED
]);
