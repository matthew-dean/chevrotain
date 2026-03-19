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

- **Chevrotain**: 796 passing, 0 failing (all 11 recovery tests fixed)
- **Jess css-parser**: in flux (Jess-side parser rewrite in progress)

### Current benchmark (JSON EmbeddedActionsParser, isolated V8 per phase):

| Phase            | v12.0.0 baseline | Our fork      | Ratio           |
| ---------------- | ---------------- | ------------- | --------------- |
| **Construction** | 1.29 ms          | **0.48 ms**   | **2.7x faster** |
| **Cold parse**   | 1.69 ms          | **1.04 ms**   | **1.6x faster** |
| **First parse**  | 0.56 ms          | 0.60 ms       | ~parity         |
| **Warm**         | 14,347 ops/sec   | 9,874 ops/sec | **69%**         |

Baseline: `npm pack chevrotain@12.0.0` → extract to `/tmp/package/`

## Key Files

| File                             | What it does                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/parse/parser/parser.ts`     | **THE parser** — all 9 traits absorbed (Stage 7). Contains orInternal, manyInternalLogic, consumeInternal, RULE, OR, MANY, OPTION, CONSUME, SUBRULE, CST building, recovery, GAST recording, performSelfAnalysis, prePopulateOrFastMaps, LL(k) lookahead. ~5000 lines. |
| `src/parse/grammar/lookahead.ts` | LL(k) lookahead path computation: buildAlternativesLookAheadFunc, buildSingleAlternativeLookaheadFunction, getLookaheadPathsForOr/OptionalProd                                                                                                                         |
| `src/parse/grammar/first.ts`     | GAST first-token set computation                                                                                                                                                                                                                                       |
| `benchmark_web/benchmark.mjs`    | CLI benchmark runner (isolated V8 per phase in --mode all)                                                                                                                                                                                                             |
| `RD_ENGINE_PLAN.md`              | Full stage plan with checkboxes                                                                                                                                                                                                                                        |
| `BACKTRACKING_FIX.md`            | Deep backtracking analysis + recovery fix documentation                                                                                                                                                                                                                |

## What's Done

### ~~Committed dispatch for OR~~ — DONE

Three-tier OR dispatch in `orInternal`:

1. **Ultra-fast inline LL(1)**: direct hash map → committed call (JSON hot path)
2. **LL(k) precomputed closure**: `buildAlternativesLookAheadFunc` from GAST
3. **Speculative slow path**: try each alt with `IS_SPECULATING=true`

### ~~Recovery tests~~ — DONE (796/796)

OR committed re-run + MANY recognition exception handling + CST save/restore.

### ~~Stage 7 — Mixin flattening~~ — DONE

All 9 traits absorbed into Parser. `applyMixins` removed. `MixedInParser`
type removed. ~196 `this: MixedInParser` annotations removed.

### ~~Precomputed lookahead~~ — DONE

During `performSelfAnalysis()`:

- OR: `buildAlternativesLookAheadFunc` → LL(k) closures in `_orLookahead`
- MANY/OPTION: `buildSingleAlternativeLookaheadFunction` → LL(k) closures in `_prodLookahead`
- Fast-dispatch maps (`_orFastMaps`) pre-populated from GAST first-token sets

### Bug fixes — DONE

- tokenMatcher category selection moved after `augmentTokenTypes()`
- Dynamic alts identity check (`_orFastMapAltsRef`) prevents fast-map corruption
- Committed dispatch guarded by `_orCommittable` structural analysis

## What's Open

### 1. Zero-cost CST speculation

During speculative execution, CST nodes are created then discarded on
failure. Defer CST creation during speculation to eliminate allocation
overhead. Use a stack/marker system to replay CST building when committing.

### 2. Delete old trait files

The absorbed trait files still exist on disk with dead code:
`perf_tracer.ts`, `looksahead.ts`, `lexer_adapter.ts`, `error_handler.ts`,
`gast_recorder.ts`, `recognizer_engine.ts`, `recoverable.ts`,
`recognizer_api.ts`, `tree_builder.ts`, `apply_mixins.ts`, `parser_traits.ts`.

### 3. Remaining warm performance gap (~31%)

V8 profile (JSON warm):

```
18.4%  tokenizeInternal (lexer) — not in scope
 9.0%  RegExp matching (lexer)
 7.4%  invokeRuleWithTryCst — try/catch per rule call (structural, shared with upstream)
 6.1%  orInternal — counter management, map lookups
 3.3%  manyInternalLogic — committed path is slim; speculative path has overhead
 0.6%  optionInternalLogic — mostly committed via LL(k) closure
```

The `invokeRuleWithTryCst` try/catch (7.4%) is needed for correct error
handling and can't be removed without breaking error semantics. The remaining
gap is from auto-occurrence counter management (`_dslCounter` save/restore,
`_orCounterDeltas` lookup) per DSL call.

### 4. Jess css-parser

The Jess css-parser is being rewritten separately. Key Chevrotain issues
that affect it:

- Dynamic alternatives (same rule, different alt arrays) — fixed with
  identity check
- Token category matching — fixed with tokenMatcher ordering
- LL(k) disambiguation for CSS nesting — now available via precomputed
  lookahead

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

Differences from @jesscss/parser (intentional design divergence):

- @jesscss/parser commits the LAST alt (no speculation). Our fork speculates
  ALL alts, then uses a **committed re-run** via the fast-dispatch map when
  all alts fail. This is more general than last-alt-commits because it
  identifies the LL(1)-correct alt (not just the last one) and works for
  both recovery-enabled and recovery-disabled parsers. For ambiguous
  entries (-1), raises NoViableAltException directly.

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

1. ~~**Last alt committed in OR**~~: FIXED via committed re-run mechanism
   (see section 2 above). Our approach is more general — uses the
   fast-dispatch map to identify the LL(1)-correct alt rather than
   always committing the last one.

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
