# Recursive Descent Engine Replacement Plan

Replace Chevrotain's LL(k) lookahead-based parser engine with a speculative
backtracking engine derived from `@jesscss/parser`. The public API is preserved
exactly. The `Lexer` and token utilities are untouched.

---

## Background

Chevrotain's current engine has three structural performance costs:

1. **Error allocation during backtracking.** `CONSUME()` failure throws
   `new MismatchedTokenException()` which extends `Error`. V8 always calls
   `Error.captureStackTrace()` on construction — it walks the entire JS call
   stack and serializes every frame to a string. This is O(call-stack depth)
   and creates GC pressure on every failed alternative inside `OR()`.

2. **Lookahead cache overhead.** Every `OR()`, `MANY()`, `OPTION()`, and
   `AT_LEAST_ONE()` call does a `Map.get()` keyed on a bit-encoded integer
   (`rule short name | method type | occurrence index`) to retrieve a
   pre-computed lookahead function, then invokes that function to decide which
   branch to take. This is a fixed per-production tax even when no backtracking
   is needed.

3. **Recording phase hidden-class pollution.** `enableRecording()` adds
   instance methods to the parser object; `disableRecording()` deletes them.
   In V8, adding/deleting own properties transitions the object to a new hidden
   class. Any inline cache (IC) that was optimized for the previous shape
   becomes polymorphic or megamorphic until the JIT re-optimizes — degrading
   all subsequent property accesses on the parser instance.

The replacement strategy:

- **SPEC_FAIL symbol** replaces Error-based backtracking. V8 does not call
  `captureStackTrace` for non-Error throws. A frozen Symbol throw+catch is
  essentially a non-local goto — zero allocation, branch-predictor friendly.
- **Speculative execution** replaces lookahead pre-computation. `OR()` tries
  alternatives in order; failed ones throw SPEC_FAIL, state is restored (a
  single integer + array length reset), the next alternative is tried. No Map,
  no lookahead functions, no key encoding.
- **Optional recording phase** means `performSelfAnalysis()` is a no-op by
  default. The recording mechanism is preserved for users who need GAST tooling
  (`serializeGrammar`, `generateCstDts`, `createSyntaxDiagramsCode`) but no
  longer runs unconditionally.

---

## What Is Preserved

| Item                                                                    | Status                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Full public API (`CstParser`, `EmbeddedActionsParser`, all DSL methods) | Unchanged                                             |
| `OR1`–`OR9`, `CONSUME1`–`CONSUME9`, all numbered variants               | Kept as aliases                                       |
| `Lexer` class and all token utilities                                   | Untouched                                             |
| `createToken`, `tokenMatcher`, `EOF`, error classes                     | Untouched                                             |
| `MismatchedTokenException` etc.                                         | Kept — still thrown for real (non-speculative) errors |
| `performSelfAnalysis()`                                                 | Kept — now a no-op unless GAST is requested           |
| `ILookaheadStrategy` / `LLkLookaheadStrategy`                           | Kept as deprecated no-ops                             |
| Grammar recording mechanism                                             | Kept — made opt-in                                    |
| `serializeGrammar`, `generateCstDts`, `createSyntaxDiagramsCode`        | Kept — require opt-in recording pass                  |

## What Is Deleted

| Item                                        | Reason                                |
| ------------------------------------------- | ------------------------------------- |
| `LooksAhead` trait                          | Replaced by speculative execution     |
| `lookAheadFuncsCache`                       | No longer needed                      |
| `preComputeLookaheadFunctions`              | No longer needed                      |
| `getKeyForAutomaticLookahead`               | No longer needed                      |
| `LLkLookaheadStrategy` implementation       | Replaced — interface stub kept        |
| `isBackTrackingStack: boolean[]`            | Replaced by `IS_SPECULATING: boolean` |
| `applyMixins` composition                   | Replaced by direct class hierarchy    |
| `RecognizerEngine` / `RecognizerApi` traits | Merged into new base class            |

---

## Architecture After Replacement

```
RecursiveDescentParser        ← new core (CONSUME, OR, MANY, state, SPEC_FAIL)
  └─ EmbeddedActionsParser    ← RULE(), ACTION() passthrough, performSelfAnalysis no-op
       └─ CstParser           ← CST stack, CONSUME/SUBRULE overrides, visitor constructors
```

The `Lexer` class and all token utilities sit beside this hierarchy, unchanged.

---

## Stages

---

### Stage 1 — Replace Error-based backtracking with SPEC_FAIL

**Goal:** Eliminate `Error.captureStackTrace` calls during speculative parsing.

#### What changes

- Add `const SPEC_FAIL = Object.freeze(Symbol('SPEC_FAIL'))` as the internal
  speculation sentinel.
- Add `IS_SPECULATING: boolean = false` to the parser state, mirroring the
  `RECORDING_PHASE` convention.
- In `consumeInternal()`: when `IS_SPECULATING === true` and the token does not
  match, throw `SPEC_FAIL` instead of `new MismatchedTokenException`.
- In `BACKTRACK()`: set `IS_SPECULATING = true` before the trial, restore it
  after, catch `SPEC_FAIL` as the failure signal.
- Replace all `isRecognitionException(e)` checks in catch blocks with
  `e === SPEC_FAIL` where appropriate.
- Remove `isBackTrackingStack: boolean[]` and `isBackTracking(): boolean`.
- `isBackTracking()` on the public API → returns `this.IS_SPECULATING` for
  backwards compat.

#### Exit criteria

- All existing tests pass unchanged.
- `BACKTRACK()` returns `false` on mismatch without allocating an Error.
- A micro-benchmark of `BACKTRACK` on a failing rule shows zero `Error`
  objects created (verifiable via `--expose-gc` + `gc()` count).

---

### Stage 2 — Replace lookahead pre-computation with speculative OR()

**Goal:** Remove `Map.get()` + lookahead function call from every production.

#### What changes

- Rewrite `orInternal()` to iterate alternatives speculatively:
  - Save state (`pos`, `errors.length`, stack lengths).
  - Set `IS_SPECULATING = true`.
  - Call `alt.ALT()`.
  - On `SPEC_FAIL`: restore state, try next alternative.
  - On success: restore `IS_SPECULATING`, return result.
  - Last alternative: call without speculation (errors surface normally).
  - If `alt.GATE` is provided and passes: commit without speculation.
- Rewrite `manyInternal()`, `optionInternal()`, `atLeastOneInternal()`,
  `manySepInternal()`, `atLeastOneSepInternal()` to use the same
  try-speculatively / catch-SPEC_FAIL / break pattern.
- Delete `preComputeLookaheadFunctions()`.
- Delete `lookAheadFuncsCache` and all key-encoding utilities
  (`getKeyForAutomaticLookahead`, `BITS_FOR_METHOD_TYPE`,
  `BITS_FOR_OCCURRENCE_IDX`).
- `LLkLookaheadStrategy`: keep the class but make `buildLookaheadForAlternation`
  and `buildLookaheadForOptional` return no-op functions. Emit a deprecation
  warning if a custom `lookaheadStrategy` is passed in config.
- `maxLookahead` config option: keep accepted (no-op), emit deprecation warning.

#### Exit criteria

- All existing tests pass unchanged.
- Parser construction time drops measurably (no lookahead pre-computation).
- A grammar with 9-alternative `OR()` and the correct alternative last parses
  correctly.
- `lookAheadFuncsCache` does not exist on parser instances.

---

### Stage 3 — Remove numbered DSL variants as real implementations

**Goal:** Make `OR1`–`OR9` etc. true aliases with no extra overhead.

#### What changes

The numbered variants exist solely to provide unique `idx` values for
`getKeyForAutomaticLookahead`. With the cache gone, `idx` is meaningless.

- In `recognizer_api.ts`, replace all `OR1`–`OR9` implementations with:
  ```ts
  OR1 = this.OR;
  OR2 = this.OR;
  // ... etc
  ```
  Same for `CONSUME1`–`CONSUME9`, `SUBRULE1`–`SUBRULE9`, `MANY1`–`MANY9`,
  `OPTION1`–`OPTION9`, `AT_LEAST_ONE1`–`AT_LEAST_ONE9`,
  `MANY_SEP1`–`MANY_SEP9`, `AT_LEAST_ONE_SEP1`–`AT_LEAST_ONE_SEP9`.
- Remove the `idx` / `occurrence` parameter threading from internal methods
  (`orInternal`, `consumeInternal`, etc.) where it was only used for cache
  key computation.
- Keep `idx` in GAST node construction (needed for Stage 5 recording pass).

#### Exit criteria

- All existing tests pass unchanged.
- A grammar using `OR1`, `OR3`, `OR7` in the same rule produces correct output.
- The `idx` parameter still threads through to GAST recording (verified by
  Stage 5 tests).

---

### Stage 4 — Decouple CST building from the recording phase

**Goal:** `CstParser` works correctly without `performSelfAnalysis()` having run.

#### What changes

Currently `TreeBuilder` depends on GAST having been constructed to know CST
child key names. Replace with runtime interception:

- `CstParser` overrides `consumeInternal()`:
  ```ts
  const tok = super.consumeInternal(tokenType, opts);
  const key = opts?.LABEL ?? tokenType.name;
  (this._cstStack.at(-1).children[key] ??= []).push(tok);
  return tok;
  ```
- `CstParser` overrides `subruleInternal()`:
  ```ts
  const node = super.subruleInternal(rule, opts) as CstNode;
  const key = opts?.LABEL ?? rule.ruleName;
  (this._cstStack.at(-1).children[key] ??= []).push(node);
  return node;
  ```
- `RULE()` in `CstParser` wraps the implementation to push/pop `_cstStack`
  and call `_finalizeLocation(node)` on exit.
- Location tracking (`nodeLocationTracking: "none" | "onlyOffset" | "full"`)
  handled by assigning the appropriate update method at construction time —
  same strategy as existing `TreeBuilder.initTreeBuilder()` but without GAST
  dependency.
- `getBaseCstVisitorConstructor()` uses the rule registry built by `RULE()`
  (rule names only — no GAST needed).
- Delete the GAST-derived CST field-name pre-computation from `TreeBuilder`.

#### Exit criteria

- `CstParser` produces identical CST output with and without
  `performSelfAnalysis()` having been called.
- All three `nodeLocationTracking` modes produce correct location info.
- `getBaseCstVisitorConstructor()` returns a valid base class with all rule
  names present.
- Existing CST-based tests pass unchanged.

---

### Stage 5 — Make recording phase opt-in

**Goal:** `performSelfAnalysis()` is a no-op by default. GAST tooling works
when explicitly requested.

#### What changes

- `performSelfAnalysis()` default behaviour: register rule names, return
  immediately. No recording, no lookahead computation.
- Add config option `{ buildGast: true }` (or call `performSelfAnalysis()`
  with a flag) to trigger the full recording pass.
- The recording mechanism in `GastRecorder` (`enableRecording()`,
  `disableRecording()`, `topLevelRuleRecord()`, sentinel tokens) is preserved
  exactly — it just no longer runs unconditionally.
- `RECORDING_PHASE` is `false` by default; `true` only during an explicit
  recording pass.
- `serializeGrammar()`, `generateCstDts()`, `createSyntaxDiagramsCode()`,
  `getLookaheadPaths()`: throw a clear error if called without a prior GAST
  build, with a message pointing to the opt-in flag.
- Grammar validation (left-recursion detection, ambiguity warnings) moves
  inside the opt-in recording pass.

#### Exit criteria

- Parser construction with no `performSelfAnalysis()` call does not mutate
  instance methods (no hidden class transitions after construction).
- `performSelfAnalysis({ buildGast: true })` produces identical GAST output
  to the current mandatory recording pass.
- `serializeGrammar()` works after opt-in, throws with a clear message without
  opt-in.
- `generateCstDts()` and `createSyntaxDiagramsCode()` work after opt-in.
- All grammar validation tests pass when opt-in is used.

---

### Stage 6 — Flatten mixin architecture

**Goal:** Replace `applyMixins` composition with a direct class hierarchy.
Clean up the call graph for V8's inliner.

#### What changes

- Collapse the 9 traits into the three-class hierarchy:
  ```
  RecursiveDescentParser      ← absorbs: RecognizerEngine, RecognizerApi,
                                          LexerAdapter, ErrorHandler,
                                          LooksAhead (stub), Recoverable
  EmbeddedActionsParser       ← absorbs: PerformanceTracer, GastRecorder (opt-in)
  CstParser                   ← absorbs: TreeBuilder (runtime version from Stage 4)
  ```
- Delete `applyMixins` and `parser_traits.ts` `MixedInParser` type.
- The `Parser` base class (currently just a deprecation shim) points to
  `EmbeddedActionsParser` and emits a console warning.
- All trait files (`recognizer_engine.ts`, `recognizer_api.ts`, etc.) are
  deleted or folded in. File structure becomes:
  ```
  src/parse/parser/
    recursive_descent_parser.ts
    embedded_actions_parser.ts
    cst_parser.ts
    gast_recorder.ts          ← unchanged, now only called opt-in
    recoverable.ts            ← unchanged
    perf_tracer.ts            ← unchanged
  ```

#### Exit criteria

- No `applyMixins` calls remain.
- `instanceof CstParser` and `instanceof EmbeddedActionsParser` work correctly.
- The `Parser` deprecated shim emits a warning and delegates correctly.
- All existing tests pass unchanged.
- Bundle size is measurably smaller (dead trait infrastructure removed).

---

### Stage 7 — Benchmarks

**Goal:** Quantify all gains with the existing benchmark infrastructure.

#### What changes

- Port the three existing `benchmark_web` grammars (JSON, CSS, ECMA5) to run
  against both the old engine (pinned at `v12.0.0`) and the new engine.
- Extend `bench_logic.js` to show three columns: `latest` (v12), `next` (this
  branch), `delta`.
- Add two separate benchmark modes:
  - **Init time**: parser construction only, no input parsed. Isolates recording
    phase + lookahead precomputation cost.
  - **Parse time**: construction amortized, measure repeated parse calls.
    Isolates per-parse engine cost.
- Document results in `benchmark_web/README.md` with the V8 cost explanations
  from this plan.

#### Exit criteria

- Init time is measurably lower for all three grammars with the new engine.
- Parse time is equal or better for all three grammars with the new engine.
- No correctness regressions: benchmark parsers produce identical output on
  the same input against both engines.
- Results are reproducible across three consecutive benchmark runs (Benchmark.js
  `minSamples: 25` default).

---

## Stage Dependencies

```
Stage 1 (SPEC_FAIL)
  └─ Stage 2 (speculative OR)
       └─ Stage 3 (numbered variant aliases)
            ├─ Stage 4 (runtime CST)
            │    └─ Stage 5 (opt-in recording)
            │         └─ Stage 6 (flatten mixins)
            └─ Stage 7 (benchmarks)  ← can start after Stage 2
```

Stages 4 and 5 can be developed in parallel once Stage 3 is done.
Stage 7 can begin as soon as Stage 2 is complete — early benchmark data is
useful for motivating Stages 4–6.

---

## Reference: Key Files

| File                                           | Role                            | Stage   |
| ---------------------------------------------- | ------------------------------- | ------- |
| `src/parse/parser/traits/recognizer_engine.ts` | Core engine — primary target    | 1, 2, 6 |
| `src/parse/parser/traits/looksahead.ts`        | Lookahead cache — deleted       | 2       |
| `src/parse/parser/traits/recognizer_api.ts`    | DSL API surface                 | 3       |
| `src/parse/parser/traits/tree_builder.ts`      | CST construction                | 4       |
| `src/parse/parser/traits/gast_recorder.ts`     | Recording phase                 | 5       |
| `src/parse/parser/utils/apply_mixins.ts`       | Mixin system — deleted          | 6       |
| `src/parse/parser/parser.ts`                   | Parser base + trait composition | 6       |
| `benchmark_web/lib/bench_logic.js`             | Benchmark runner                | 7       |
| `packages/types/api.d.ts`                      | Public types — unchanged        | —       |
