# Session Handoff: Chevrotain RD Engine Replacement

## Repository Layout

- **Chevrotain fork**: `/Users/matthew/git/oss/chevrotain` (branch: `rd-engine-replacement`)
- **Jess css-parser**: `/Users/matthew/git/oss/jess` (branch: `dev`)
- Jess links to Chevrotain via `pnpm overrides` in root `package.json`:
  `"chevrotain": "link:../chevrotain/packages/chevrotain"`

## What Was Done (Summary)

We're rewriting Chevrotain's parser engine from LL(k) precomputed lookahead
to speculative backtracking, modeled on `@jesscss/parser` (at
`/Users/matthew/git/oss/jess/packages/parser/src/parser.ts`). The work is
tracked in `RD_ENGINE_PLAN.md` (stages 0-8) and `BACKTRACKING_FIX.md`.

### Completed stages (all in `recognizer_engine.ts`):

- **Stage 0**: Token/IToken hidden-class shapes, MATCH_SET bitset
- **Stage 1**: SPEC_FAIL symbol, IS_SPECULATING boolean, 3-int savepoint
- **Stage 2**: Speculative backtracking OR/MANY/OPTION/AT_LEAST_ONE
- **Stage 3**: Skip GAST traversal during speculation
- **Stage 4a/4b/4c**: OR fast-dispatch map, watermark CST, fixed-shape nodes
- **Stage 5**: Recording phase hidden-class pollution fix
- **Stage 6**: performSelfAnalysis optional (lazy init)

### Key recent changes:

- **Auto-occurrence counting** (`_dslCounter`): single counter shared by ALL
  DSL methods, reset per rule. Eliminates need for OR1/OR2/CONSUME1/CONSUME2
  numbered variants. OR1-OR9 now just delegate to `this.OR(altsOrOpts)`.
- **Deep backtracking**: MANY saves full state (pos + errors + CST) per
  iteration, catches SPEC_FAIL. OR slow path uses first-success-wins (no
  bestProgress tracking). Matches @jesscss/parser model.
- **Ambiguity validation non-fatal**: AMBIGUOUS_ALTS and
  AMBIGUOUS_PREFIX_ALTS are recorded in definitionErrors but not thrown.
- **Jess css-parser fix**: Whitespace heuristic GATE on declaration alt
  disambiguates `color: red` (declaration) from `a:hover` (nested rule).
  69/97 tests passing (up from 51/94).

### Current test status:

- **Chevrotain**: 785 passing, 11 failing (all error recovery tests —
  documented in BACKTRACKING_FIX.md as known limitation)
- **Jess css-parser**: 69/97 passing (28 failures are pre-existing from
  Chevrotain migration, not from our changes)
- **Jess nested-pseudo**: 5/5 passing

### Current benchmark:

- JSON EmbeddedActionsParser: ~8,800 ops/sec (vs 14,776 v12.0.0 baseline)
- CSS EmbeddedActionsParser: ~2,100 ops/sec (vs 2,008 baseline — slight win)
- Baseline comparison: `npm pack chevrotain@12.0.0` → extract to `/tmp/package/`

## Key Files

| File                                           | What it does                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/parse/parser/traits/recognizer_engine.ts` | Core engine: orInternal, manyInternalLogic, consumeInternal, SPEC_FAIL, fast-dispatch maps |
| `src/parse/parser/traits/recognizer_api.ts`    | Public DSL: OR, CONSUME, SUBRULE, MANY etc. Auto-counting via `_dslCounter`                |
| `src/parse/parser/traits/gast_recorder.ts`     | GAST recording: topLevelRuleRecord, per-alt counter management                             |
| `src/parse/parser/parser.ts`                   | Parser base class, performSelfAnalysis, ambiguity filtering                                |
| `benchmark_web/benchmark.mjs`                  | CLI benchmark runner                                                                       |
| `RD_ENGINE_PLAN.md`                            | Full stage plan with checkboxes                                                            |
| `BACKTRACKING_FIX.md`                          | Deep backtracking analysis: what we keep, what we fixed, known limitations                 |

## What's Open

### 1. Committed dispatch for OR (the big perf question)

**Goal**: Skip try/catch on the OR fast path for LL(1) grammars.

**Why it matters**: V8 profile shows `orInternal` is ~5% of total parse time,
`tokenizeInternal` (lexer) is ~19%. The try/catch in orInternal's fast path
is a fraction of that 5%. So the max theoretical gain from committed dispatch
is small (~2-3%). The bigger win may be elsewhere.

**The blocker we hit**: The fast-dispatch map (`_orFastMaps`) is built from
runtime observations. An alt that succeeds for tokenTypeIdx X gets cached as
`X → altIdx`. But a DIFFERENT alt might also succeed for X (when the first
alt has an OPTION before its first CONSUME). Committed dispatch (no try/catch)
calls the cached alt directly — if it fails, there's no recovery.

**The approach we converged on**: Use GAST to statically compute ALL possible
first tokens per alt during recording (including tokens reachable after
OPTION/MANY prefixes). Pre-populate the fast map with this complete picture.
Mark any tokenTypeIdx reachable by multiple alts as ambiguous (-1). Then
committed dispatch is immediately safe for any non-ambiguous entry.

**Key code**: `getOrFirstTokenInfo` in `src/parse/grammar/lookahead.ts` and
`first()` in `src/parse/grammar/first.ts` already compute first-token sets
from GAST. These need to be wired into the fast-map pre-population.

**Critical insight from V8 profiling** (JSON benchmark, `--prof`):

```
19%  tokenizeInternal (lexer)
 9%  RegExp matching (part of lexer)
 6%  invokeRuleWithTryCst (rule wrapper try/catch)
 5%  orInternal
 3%  consumeInternal
 3%  SUBRULE2
 2%  optionInternalLogic
~8%  ALT callback functions
```

The 35% gap vs baseline is NOT concentrated in orInternal's try/catch —
it's spread across the entire call chain. Committed dispatch would save
maybe 2-3% of total time at best. The GAST-based approach is still the
RIGHT design, but the ROI is modest. Higher-impact targets:

- Mixin flattening (reducing prototype chain depth for all method calls)
- Rule wrapper overhead (invokeRuleWithTryCst at 6%)
- Function call overhead (each DSL call is a prototype method lookup)

### 2. 11 Failing recovery tests

**Root cause**: OR no longer re-runs a failed alt committed (bestProgress
removed). Error recovery requires a committed execution path where CONSUME
throws MismatchedTokenException (not SPEC_FAIL). @jesscss/parser solves this
by committing the LAST alt — but our attempt broke other tests.

**Fix approach**: When `recoveryEnabled === true` AND not speculating, the
last OR alt should run committed. When `recoveryEnabled === false` (the
common case), all alts remain speculative. This is documented in
BACKTRACKING_FIX.md.

### 3. Jess css-parser — Option 1 greedy fallback

The whitespace heuristic GATE handles 99% of cases (`color: red` vs
`a:hover`). For edge cases without whitespace (`a:b;` vs `a:b { }`),
the user wants a "greedy MANY with OR narrowing" approach:

- Start parsing tokens that are valid in BOTH declarations and selectors
- When an invalid-for-one token appears, narrow to the other interpretation
- At `{`, `;`, or `}`, construct the appropriate node

This is a **grammar-level change** in
`/Users/matthew/git/oss/jess/packages/css-parser/src/productions/selectors.ts`
(the `declarationList` function). The engine doesn't need changes.

### 4. Stage 7 — Mixin flattening

Replace `applyMixins` with a real class hierarchy:
`PerformanceTracer → LexerAdapter → ... → RecognizerApi → Parser`

Plan is in `RD_ENGINE_PLAN.md`. The architecture exploration agent
recommended Option E (linear abstract class chain). The key steps:

1. Extract constants from parser.ts to break import cycles
2. Chain traits as `abstract class X extends Y`
3. Remove `applyMixins`, simplify `MixedInParser` type
4. Remove `this: MixedInParser` from ~192 method signatures

### 5. Stage 8 — Benchmarks

Run JSON, CSS, ECMA5 against v12.0.0 baseline with both EmbeddedActionsParser
and CstParser modes.

## Important Rules

1. **NEVER git stash** — always commit first, even as WIP. The pre-commit
   hook's lint-staged does an internal stash that compounds the problem.
2. **Always consult @jesscss/parser** before writing speculative parsing code.
   The reference implementation is at
   `/Users/matthew/git/oss/jess/packages/parser/src/parser.ts`.
3. **Write failing tests first** before fixing bugs.
4. **Keep the Jess worktree** at `/tmp/jess-pre-chev` (commit 036d5f42) if
   you need to test the @jesscss/parser version. Build chain:
   `pnpm --filter @jesscss/awaitable-pipe build && pnpm --filter @jesscss/core compile && pnpm --filter @jesscss/parser build`
5. Tests that check internal implementation details should be updated or
   removed — test PUBLIC behavior.
6. **Stage exit**: update doc checklist → commit → push.

## Build & Test Commands

```bash
# Chevrotain
cd packages/chevrotain
bun run build          # compile + bundle
bun run unit-tests     # mocha tests
node benchmark_web/benchmark.mjs --iterations 5000 --parser json  # benchmark

# Jess css-parser
cd /Users/matthew/git/oss/jess
pnpm --filter @jesscss/css-parser test
pnpm --filter @jesscss/css-parser test -- -t "nested pseudo"  # specific test

# Baseline comparison
node benchmark_web/benchmark.mjs --lib /tmp/package/lib/chevrotain.mjs --iterations 5000
```

## @jesscss/parser Reference Implementation

The entire RD engine rewrite is modeled on `@jesscss/parser` at
`/Users/matthew/git/oss/jess/packages/parser/src/parser.ts`. This is the
authoritative reference for how each DSL method should behave. **Always
consult it before writing speculative parsing code.** (Note: @jesscss/parser
might actually have some bugs, so make sure it actually is PARSING and producing
AST output before you assume a particular path it takes is correct.)

### Method-by-method comparison

**CONSUME(expected)** — Our fork matches @jesscss/parser:

```
if token matches → advance pos, return token
if speculating   → throw SPEC_FAIL (Symbol, zero cost)
if recovery      → attempt insert/delete recovery
else             → throw MismatchedTokenError
```

Key: `IS_SPECULATING` propagates through ALL nested calls. No Error object
is EVER created during speculation.

**OR(alternatives)** — Our fork mostly matches, with fast-dispatch on top:

```
@jesscss/parser:                    Our fork:
for each alt:                       Fast-dispatch check first (our addition):
  GATE fails → skip                   _orFastMaps[mapKey][la1.tokenTypeIdx]
  last alt → COMMIT                   → direct call with try/catch
  GATE passed + recovery → COMMIT   Then slow path (matches @jesscss/parser):
  else → SPECULATE:                   for each alt:
    save state                          GATE fails → skip
    speculating = true                  speculating = true
    try alt                             try alt
    success → return (first wins)       success → return (first wins)
    SPEC_FAIL/ParseError → restore      SPEC_FAIL → restore, continue
all failed:                           all failed:
  speculating → throw SPEC_FAIL         speculating → throw SPEC_FAIL
  else → NoViableAltError               else → raiseNoAltException
```

Differences from @jesscss/parser (intentional — KEEP these):

- Fast-dispatch map layer before slow path (our optimization)
- GATED_OFFSET encoding for adaptive gate checks
- Auto-occurrence counter management (\_dslCounter, \_orCounterDeltas)

Differences from @jesscss/parser (bugs/gaps — FIX these):

- Our OR catches `SPEC_FAIL || isRecognitionException(e)` but @jesscss
  catches `SPEC_FAIL || e instanceof ParseError`. Recognition exceptions
  from committed sub-paths should be caught the same way.
- @jesscss/parser commits the LAST alt (no speculation). Our fork speculates
  ALL alts including the last. This breaks error recovery for
  `recoveryEnabled: true` parsers (the 11 failing tests).

**MANY(defOrOpts)** — Our fork now matches @jesscss/parser:

```
while true:
  if GATE fails → break
  save full state (pos + errors + CST)
  try DEF()
  on SPEC_FAIL → restore state, break
  if pos didn't advance → restore state, break (stuck guard)
```

Key: saves state BEFORE each iteration. Catches SPEC_FAIL to enable deep
backtracking — a MANY body that fails partway through a subrule chain is
unwound cleanly.

**AT_LEAST_ONE(defOrOpts)** — Matches @jesscss/parser:

```
First iteration: mandatory (let it throw/recover normally)
Subsequent iterations: same as MANY (save/restore/catch)
```

**OPTION(def)** — Our fork matches @jesscss/parser:

```
save full state
try DEF()
if pos didn't advance or errors increased → restore, return undefined
on SPEC_FAIL or recognition exception → restore, return undefined
```

**saveState / restoreState** — @jesscss/parser captures:

```
pos, errors.length, locationStack (slice), ruleStack (slice), usedSkippedMark
```

Our fork saves: `currIdx` (pos), `_errors.length`, `saveCstTop()` (watermark).
We don't copy ruleStack — it's self-correcting via `ruleFinallyStateUpdate`.

### What @jesscss/parser does that we should still port

1. **Last alt committed in OR**: @jesscss/parser line 574-576 runs the last
   alt WITHOUT setting `speculating = true`. This lets error recovery work
   for the fallback case. Our fork speculates all alts — the 11 recovery
   test failures are from this gap.

2. **`tryConsume()` for separators**: @jesscss/parser has a `tryConsume()`
   method that returns `undefined` on mismatch instead of throwing. Used in
   MANY_SEP/AT_LEAST_ONE_SEP for zero-allocation separator checks. Our fork
   still uses speculation for separator matching.

3. **Content assist mode**: @jesscss/parser has `assistMode` + `assistOffset`
   for IDE integration. Our fork doesn't have this yet.

### How to test with the @jesscss/parser version

A worktree at commit `036d5f42` has the working @jesscss/parser-based
css-parser. To recreate:

```bash
cd /Users/matthew/git/oss/jess
git worktree add /tmp/jess-pre-chev 036d5f42
cd /tmp/jess-pre-chev
pnpm install --frozen-lockfile
pnpm --filter @jesscss/awaitable-pipe build
pnpm --filter @jesscss/core compile
pnpm --filter @jesscss/parser build
pnpm --filter @jesscss/css-parser test  # 86 passing, 0 failing (excl. missing test data)
```

The nested-pseudo tests pass on this version (but return `value: undefined`
with 0 errors — a false positive. The @jesscss/parser silently drops
unparsed input when the outer MANY catches the error).

### Key finding: CSS nesting disambiguation

The `a:hover { }` vs `a: hover;` ambiguity is a GRAMMAR problem, not an
engine problem. Both @jesscss/parser and our Chevrotain fork handle
backtracking correctly — but the `declaration` rule consumes `a:hover` as
`a: hover` successfully, and no amount of backtracking can undo a
SUCCESSFUL alt.

Fix (implemented in Jess css-parser): whitespace heuristic GATE on the
declaration alt in `declarationList`. Space after `:` → declaration, no
space → nested rule selector. The user also wants an "Option 1" greedy
fallback for edge cases (no whitespace but is still a declaration).

## What NOT to Do

- Don't use bestProgress heuristic — it's fundamentally wrong (partial match
  beats full match). First success wins.
- Don't try to run all alts in the slow path for map population — side effects
  from alt bodies corrupt parser state.
- Don't use `_orMapComplete` boolean without a sound mechanism to determine
  completeness.
- Don't add try/catch to the committed dispatch path — that defeats the purpose.
- Don't treat the 11 recovery test failures as blocking — they're a separate
  concern from the core backtracking model.
