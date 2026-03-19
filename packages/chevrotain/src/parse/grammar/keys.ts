// Lookahead keys are 32Bit integers in the form
// RRRRRRRRRRRRRRRRRRRRRR-MMM-XXXX
// XXXX -> Occurrence Index bitmap (4 bits, 0-15).
// MMM  -> DSL Method Type bitmap (3 bits, 0-7).
// RRR... -> Rule short Index bitmap (remaining bits).
// Keys are kept small (max ~12k for 100 rules) so V8 can store them
// as dense array elements rather than dictionary hash entries.

export const BITS_FOR_METHOD_TYPE = 3;
export const BITS_FOR_OCCURRENCE_IDX = 5;
export const BITS_FOR_RULE_IDX = 8;
// TODO: validation, this means that there may at most 2^8 --> 256 alternatives for an alternation.
export const BITS_FOR_ALT_IDX = 8;

// Method-type offsets in bits 5-7 (values 32, 64, 96, 128, 160, 192).
export const OR_IDX = 1 << BITS_FOR_OCCURRENCE_IDX;
export const OPTION_IDX = 2 << BITS_FOR_OCCURRENCE_IDX;
export const MANY_IDX = 3 << BITS_FOR_OCCURRENCE_IDX;
export const AT_LEAST_ONE_IDX = 4 << BITS_FOR_OCCURRENCE_IDX;
export const MANY_SEP_IDX = 5 << BITS_FOR_OCCURRENCE_IDX;
export const AT_LEAST_ONE_SEP_IDX = 6 << BITS_FOR_OCCURRENCE_IDX;

// this actually returns a number, but it is always used as a string (object prop key)
export function getKeyForAutomaticLookahead(
  ruleIdx: number,
  dslMethodIdx: number,
  occurrence: number,
): number {
  return occurrence | dslMethodIdx | ruleIdx;
}

const BITS_START_FOR_ALT_IDX = 32 - BITS_FOR_ALT_IDX;
