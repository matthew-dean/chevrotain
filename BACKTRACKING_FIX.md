# Deep Backtracking Fix: Aligning Chevrotain with @jesscss/parser

## The Failure

The Chevrotain fork's speculative engine was built with an incorrect
assumption: that `OR()` should track "bestProgress" (tokens consumed) and
re-run the best-matching alternative committed. This is wrong because:

1. A partially-matching alt (e.g., `declaration` consuming `a:hover` as
   `a: hover`) can consume MORE tokens than the correct alt (`qualifiedRule`
   consuming `a:hover` as a selector) at the OR level — but the partial
   match fails LATER (at `{` instead of `;`).

2. The "committed re-run" of the best-progress alt produces a hard error
   that cannot be recovered from, instead of trying the next alt.

3. `MANY` did not catch recognition exceptions from committed sub-paths,
   preventing deep backtracking where an entire MANY iteration (containing
   SUBRULEs that call OR which calls more SUBRULEs) is unwound.

## Why @jesscss/parser Works

@jesscss/parser has 5 DSL methods with a consistent, simple model:

### CONSUME(expected)

```
if token matches → advance pos, return token
if speculating   → throw SPEC_FAIL (Symbol, zero cost — no Error object)
if recovery      → attempt insert/delete recovery
else             → throw MismatchedTokenError (real Error for error reporting)
```

Key: `speculating` flag propagates through ALL nested calls. No
MismatchedTokenException is EVER created during speculation.

### OR(alternatives)

```
for each alt:
  if alt.GATE fails → skip
  if last alt       → COMMIT (call directly, inheriting outer speculating)
  if GATE passed + recovery + not speculating → COMMIT
  else              → SPECULATE:
    save full state
    set speculating = true
    try alt.ALT()
    on success → restore speculating, return result (FIRST SUCCESS WINS)
    on SPEC_FAIL or ParseError → restore state, continue to next alt

if all failed:
  if speculating → throw SPEC_FAIL (bubble up to outer OR/MANY)
  else           → throw NoViableAltError
```

Key differences from our fork:

- **First success wins** — no bestProgress tracking
- **Last alt committed** — no speculation overhead for the fallback
- **Catches ParseError too** — committed sub-paths that throw real errors
  are caught and treated as "alt failed" from the OR's perspective
- **No fast-dispatch map consulted** — pure sequential try

### MANY(defOrOpts)

```
while true:
  if GATE fails → break
  save full state
  try DEF()
  on ParseError or SPEC_FAIL → restore state, break
  if pos didn't advance → restore state, break (stuck guard)
```

Key: saves state BEFORE each iteration. Catches ALL parse errors
(not just SPEC_FAIL). This enables deep backtracking — if DEF() calls
a subrule chain that eventually fails at a committed CONSUME deep inside,
the error propagates back and MANY catches it, restoring to before the
iteration started.

### AT_LEAST_ONE(defOrOpts)

```
DEF()  ← first iteration mandatory (throws on failure)
then same as MANY for subsequent iterations
```

### OPTION(def)

```
save full state
try DEF()
if pos didn't advance or errors increased → restore, return undefined
on ParseError or SPEC_FAIL → restore, return undefined
```

### saveState / restoreState

```
saveState() captures: pos, errors.length, locationStack (slice),
                      ruleStack (slice), usedSkippedMark
restoreState() restores all of the above
```

## What Our Fork Does Right (KEEP THESE)

### 1. Lazy LL(1) Fast-Dispatch Map (`_orFastMaps`)

Our fork builds a `tokenTypeIdx → altIdx` direct map lazily from slow-path
observations. After warmup, most OR calls resolve with a single property
lookup — zero speculation. @jesscss/parser tries alts sequentially every
time. This is a **genuine performance win** for LL(1) grammars (JSON, CSS).

**Keep**: `_orFastMaps`, `addOrFastMapEntry`, the fast-dispatch path at the
top of `orInternal`.

**Modify**: When the fast-dispatched alt fails (try/catch catches), fall
through to the slow path which tries remaining alts. Currently the
fast-dispatch failure falls through correctly — this just needs to stay
working after the slow-path fix.

### 2. GATED_OFFSET Encoding for Adaptive Gate Dispatch

Fast-map entries with preceding gated alts are encoded as `altIdx + 256`.
The fast path decodes this and checks preceding gates at dispatch time.
Gate-free grammars pay zero cost (`>= 256` check is a single integer
compare). This lets gated grammars progressively adopt the fast path.

**Keep**: GATED_OFFSET encoding, the adaptive gate-check loop.

### 3. Auto-Occurrence Counting (`_dslCounter`)

Single counter shared across all DSL methods, reset per rule. Eliminates
the need for numbered variants (OR1, OR2, CONSUME1, CONSUME2, etc.).
Users just write `$.OR(...)` and `$.CONSUME(...)` — the engine auto-assigns
unique occurrence IDs per call site.

**Keep**: `_dslCounter`, `_dslCounterStack`, `_orCounterDeltas`,
`_orAltCounterStarts`, counter management in `ruleInvocationStateUpdate` /
`ruleFinallyStateUpdate` / `topLevelRuleRecord`.

### 4. SPEC_FAIL Symbol (Zero-Cost Backtracking)

Already matches @jesscss/parser exactly. `SPEC_FAIL` is a frozen Symbol
thrown instead of Error objects during speculation. V8 does not capture
stack traces for non-Error throws. This is the foundation of the 15x
speedup.

**Keep**: `SPEC_FAIL`, `IS_SPECULATING` flag, the `consumeInternal`
three-tier dispatch (match → SPEC_FAIL → recovery/error).

### 5. Ambiguity Validation as Non-Fatal

`AMBIGUOUS_ALTS` and `AMBIGUOUS_PREFIX_ALTS` errors are recorded in
`definitionErrors` but not thrown. The speculative engine resolves
ambiguity at runtime. Real grammar bugs (empty non-last alts, infinite
loops) still throw.

**Keep**: The filtering in `performSelfAnalysis` and
`ensureGastProductionsCachePopulated`.

## What Our Fork Does Wrong (Method by Method)

### CONSUME — Correct ✅

Already throws SPEC_FAIL when IS_SPECULATING. No Error allocation during
speculation. Matches @jesscss/parser.

### OR (orInternal) — Slow Path Broken ❌

1. Tries ALL alts speculatively — ✅ correct
2. On first success, returns immediately — ✅ correct
3. On failure, tracks bestProgress — ❌ WRONG
4. After all alts fail, re-runs best-progress alt committed — ❌ WRONG
5. Fast-dispatch map on top — ✅ correct optimization (KEEP)

Fix needed:

- Remove bestProgress/bestAltIdx/uniqueBest tracking from slow loop
- Remove the "re-run committed" block after the slow loop
- When all alts fail: if IS_SPECULATING → throw SPEC_FAIL; else → raiseNoAltException
- Fast-dispatch path stays as-is (optimization layer)

### MANY (manyInternalLogic) — Broken ❌

1. Saves only lexer position per iteration — ❌ needs full state (pos + errors + CST)
2. Catches SPEC_FAIL but NOT recognition exceptions — ❌ needs both
3. Does not save/restore CST or errors — ❌

Fix needed:

- Save full state before each iteration (pos, errors.length, saveCstTop)
- Catch `SPEC_FAIL || isRecognitionException(e)` → restore full state, break
- Matches @jesscss/parser's MANY exactly

### OPTION (optionInternalLogic) — Correct ✅

Already saves full state, catches both SPEC_FAIL and recognition exceptions,
restores on failure. Matches @jesscss/parser.

### AT_LEAST_ONE — Partially Correct ⚠️

First iteration is mandatory (correct). Subsequent iterations need the same
fix as MANY (save full state, catch all errors).

## The Plan (Atomic Steps)

### Step 1: Fix MANY to save/restore full state and catch all parse errors

Changes to `manyInternalLogic` in `recognizer_engine.ts`:

- ⬜ Before each iteration: save `iterLexPos`, `iterErrors`, `iterCstSave`
- ⬜ Catch block: `if (e === SPEC_FAIL || isRecognitionException(e))` →
  restore all three, break
- ⬜ Remove the old `if (isRecognitionException) throw e` re-throw

Verification:

- ⬜ Write a Chevrotain test: MANY containing an OR with two alts where
  alt 1 partially matches then fails deep in a SUBRULE — verify MANY
  unwinds cleanly
- ⬜ Verify all existing MANY tests pass
- ⬜ Run Jess css-parser nested-pseudo tests → expect improvement

### Step 2: Fix AT_LEAST_ONE subsequent iterations similarly

- ⬜ Same save/restore/catch pattern for the loop after the first mandatory
  iteration

Verification:

- ⬜ Existing AT_LEAST_ONE tests pass

### Step 3: Remove bestProgress from OR slow path

Changes to `orInternal` slow loop:

- ⬜ Remove `bestProgress`, `bestAltIdx`, `uniqueBest` variables
- ⬜ In the catch block: just restore state and continue (no progress
  tracking)
- ⬜ After the loop: if IS_SPECULATING → throw SPEC_FAIL; else →
  raiseNoAltException with `occurrence` and `errMsg`
- ⬜ Remove the entire "All alts failed / bestProgress > 0" committed
  re-run block
- ⬜ Keep gated-prefix tracking (for fast-dispatch map population)

Verification:

- ⬜ All existing OR tests pass
- ⬜ Jess nested-pseudo tests pass
- ⬜ JSON benchmark ≥ 9,500 ops/sec

### Step 4: Verify full test suite and benchmarks

- ⬜ All 793+ Chevrotain tests pass (some recovery tests may need updating
  if they relied on bestProgress behavior)
- ⬜ All 5 Jess nested-pseudo tests pass
- ⬜ Jess css-parser ≥ 51 tests pass
- ⬜ JSON EmbeddedActionsParser benchmark ≥ 9,500 ops/sec
- ⬜ CSS benchmark ≥ 2,100 ops/sec

## How to Determine Success

### Correctness

- ⬜ All Chevrotain unit tests pass (793+ currently)
- ⬜ All 5 Jess nested-pseudo tests pass (currently 0)
- ⬜ Jess css-parser total: ≥ 51 tests passing (current level, ideally more)

### Performance

- ⬜ JSON EmbeddedActionsParser: ≥ 9,500 ops/sec (current level)
- ⬜ CSS EmbeddedActionsParser: ≥ 2,100 ops/sec (current level)
- ⬜ No regression from the backtracking fix

### Behavioral Proof

The CSS nesting test case must work:

```
.parent { a:hover { color: red; } }
```

- `declarationList` MANY iterates
- OR tries `declaration` → parses `a: hover` → succeeds
- MANY continues → next OR sees `{` → all alts fail
- MANY catches error, restores to before iteration
- Error propagates to outer MANY which also catches and restores
- Outer OR tries next alt or re-parses with `qualifiedRule` for `a:hover`
  as a selector

**IMPORTANT FINDING**: Logging and AST inspection at commit 036d5f42 in the
Jess repo revealed that @jesscss/parser does NOT actually parse `a:hover`
as a nested rule either. The parse returns `value: undefined` with 0 errors
— the entire input is silently dropped. The `nested-pseudo.test.ts` tests
only check `errors.length === 0` and don't verify the AST, so they pass
by accident (false positive).

The CSS nesting ambiguity (`a:hover` as declaration vs selector) requires a
**grammar-level fix** — adding a GATE on the `declaration` alt that checks
whether `{` follows the value (indicating a nested rule, not a declaration).
This is NOT an engine issue — both @jesscss/parser and our Chevrotain fork
handle backtracking correctly; the grammar just doesn't disambiguate.

## What Final Success Looks Like

After all 4 steps:

1. The backtracking model matches @jesscss/parser: first-success-wins OR,
   full-state-save MANY, deep error propagation/catch
2. The fast-dispatch optimization layer (`_orFastMaps`, GATED_OFFSET) works
   on TOP of the correct backtracking, giving LL(1) grammars committed
   dispatch performance
3. Auto-occurrence counting (`_dslCounter`) eliminates numbered variants
4. All tests pass, performance at or above current levels
5. Jess css-parser can parse nested CSS selectors correctly
