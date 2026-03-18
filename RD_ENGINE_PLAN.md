# Recursive Descent Engine Replacement Plan

Replace Chevrotain's LL(k) lookahead-based parser engine with a speculative
backtracking engine derived from `@jesscss/parser`. The public API is preserved
exactly. The `Lexer` is improved but its interface is unchanged.

## Stage Checklist

- ✅ Stage 0 — Token/IToken hidden-class shapes, JSDoc, MATCH_SET bitset
  - ✅ `createToken()` pre-declares all fields with sentinel values (one hidden class from birth)
  - ✅ `MATCH_SET` (Uint32Array bitset) replaces `categoryMatches` + `categoryMatchesMap`
  - ✅ `tokenStructuredMatcher` uses bitwise AND instead of object property lookup
  - ✅ `augmentTokenTypes()` overwrites sentinels instead of adding new properties
  - ✅ Single `IToken` factory replaces three position-tracking variants
  - ✅ `isInsertedInRecovery` pre-declared as `false` (no post-hoc property addition)
  - ✅ Lexer `cloneEmptyGroups` replaced with reset-by-truncation
- ✅ Stage 1 — `SPEC_FAIL` symbol, `IS_SPECULATING` boolean, `IParserSavepoint` (3-int savepoint)
  - ✅ `SPEC_FAIL` symbol replaces `Error`-based backtracking (no `captureStackTrace`)
  - ✅ `IS_SPECULATING` boolean replaces `isBackTrackingStack: boolean[]`
  - ✅ `saveRecogState()` returns 3 integers instead of cloning arrays
  - ✅ `consumeInternal()` throws `SPEC_FAIL` instead of `new MismatchedTokenException` when speculating
  - ✅ `flattenFollowSet()` returns `Set` instead of triple-allocation `.map().flat()`
  - ✅ `findReSyncTokenType()` uses `Set.has()` instead of `.find()`
- ✅ Stage 2 — Replace LL(k) precomputed lookahead with speculative backtracking engine
  - ✅ `orInternal()` tries alternatives speculatively with SPEC_FAIL
  - ✅ `manyInternal()`, `optionInternal()`, `atLeastOneInternal()` use speculative pattern
  - ✅ `preComputeLookaheadFunctions()` deleted
  - ✅ `lookAheadFuncsCache` and key-encoding utilities deleted
  - ✅ `LLkLookaheadStrategy` kept as deprecated no-op stub
- ✅ Stage 3 — Skip GAST traversal in `raiseNoAltException`/`raiseEarlyExitException` when `IS_SPECULATING=true`
  - ✅ GAST traversal skipped in error-building paths during speculation
- ✅ Stage 4a — Eliminate savepoint objects and add lazy LL(1) fast-dispatch for OR
  - ✅ `orInternal()` saves state as plain integer locals (no savepoint object allocation)
  - ✅ `_orFastMaps` lazy LL(1) cache: maps `tokenTypeIdx → altIndex[]` (multi-candidate) per OR site
  - ✅ Fast-dispatched alts try candidates in declaration order with gate checks
  - ✅ `manyInternalLogic` reverted to speculative-body approach with integer locals
  - ✅ CST save/restore via `saveCstTop()`/`restoreCstTop()` (array cloning — to be replaced by watermarks)
- ✅ Stage 4a.1 — Fix OR gate correctness + multi-candidate fast-dispatch
  - ✅ **Bug fix**: fast-dispatch cache now stores candidate _list_ per LA(1) token, not single alt index
  - ✅ Gates checked on fast path: each candidate's GATE evaluated before dispatch (context-sensitive)
  - ✅ Gated alts preceding an observed candidate are added to the candidate list (their gates may have been closed during observation)
  - ✅ Failed alts with progress > 0 added to candidate list (they matched LA(1) but failed later — may succeed with different context/continuation)
  - ✅ Candidates never removed on failure (internal gated OPTIONs can change between calls)
  - ✅ `addOrCandidate()` helper maintains sorted candidate list per `(mapKey, tokenTypeIdx)`
  - ✅ **Gated-prefix tracking**: alts with gated OPTION/MANY/AT_LEAST_ONE before first CONSUME are excluded from token-based caching
    - ✅ `_orAltHasGatedPrefix` flag set by `optionInternalLogic`, `manyInternalLogic`, `atLeastOneInternalLogic` when gate fires before first CONSUME
    - ✅ `_orGatedPrefixAlts[mapKey]` records per-OR alt indices with gate-dependent first-token sets
    - ✅ Fast-path merges token-based candidates with gated-prefix alts in declaration order
    - ✅ Gate-free grammars (JSON, CSS) see zero overhead (`_orGatedPrefixAlts` is undefined)
  - ✅ **Bug fix**: nested OR (via SUBRULE) no longer corrupts outer OR's `_orAltStartLexPos`/`_orAltHasGatedPrefix` — save/restore at `orInternal` entry/exit
  - ✅ **Bug fix**: `_orGatedPrefixAlts` kept sorted after each push (cross-call discovery order could produce unsorted lists, breaking merge iteration)
  - ✅ Test: gated alt takes priority when gate opens after gate-free alt was cached
  - ✅ Test: gated OPTION inside alt body — candidate survives fast-path failure
  - ✅ Test: failed alt with progress cached (verified via `_orFastMaps` inspection)
  - ✅ Test: non-gated OPTION at start of ALT is stable in cache
  - ✅ Test: gated OPTION nested inside SUBRULE handled correctly
  - ✅ Test: gated OPTION closed on first run, open on later run — alt still tried (correctness bug demo)
  - ✅ Test: nested OR must not corrupt outer OR gated-prefix tracking (inspects `_orFastMaps`/`_orGatedPrefixAlts` per mapKey)
  - ✅ Test: `_orGatedPrefixAlts` remains sorted across multiple calls with out-of-order discovery
- ✅ Stage 4b — Watermark-based CST save/restore (replace array cloning)
  - ✅ `saveCstTopImpl()` records children array `.length` values instead of `.slice()` cloning
  - ✅ `restoreCstTopImpl()` truncates arrays via `.length = savedLen` instead of replacing children object
  - ✅ Verify error recovery tests still pass (recovery disabled during speculation via `!this.isBackTracking()` guard)
  - ✅ Benchmark CstParser before/after to measure save/restore allocation reduction
- ✅ Stage 4c — CST allocation fixes
  - ✅ `cstInvocationStateUpdate()` uses fixed-shape `createCstNode()` factory (pre-declares `location: undefined`)
  - ✅ `CstNodeLocation` objects use fixed-shape per-mode factories (`createCstLocationOnlyOffset`, `createCstLocationFull`)
  - ✅ `addTerminalToCst` / `addNoneTerminalToCst` use `??= []` push pattern instead of `[token]` single-element array
- ✅ Stage 5 — Recording phase: remove hidden-class pollution from `enableRecording`/`disableRecording`
  - ✅ All DSL methods in `recognizer_api.ts` check `this.RECORDING_PHASE` and route to `*InternalRecord` methods
  - ✅ `enableRecording()` simplified to `this.RECORDING_PHASE = true` (no instance method assignment loop)
  - ✅ `disableRecording()` simplified to `this.RECORDING_PHASE = false` (no `delete` loop — eliminates ~80 hidden-class transitions)
- ⬜ Stage 6 — Flatten mixin architecture
- ⬜ Stage 7 — Flatten mixin architecture

---

## Background

### Structural engine costs

1. **Error allocation during backtracking.** `CONSUME()` failure throws
   `new MismatchedTokenException()` which extends `Error`. V8 always calls
   `Error.captureStackTrace()` on construction — it walks the entire JS call
   stack and serializes every frame to a string. This is O(call-stack depth)
   and creates GC pressure on every failed alternative inside `OR()`.

2. **Lookahead cache overhead.** Every `OR()`, `MANY()`, `OPTION()`, and
   `AT_LEAST_ONE()` call does a `Map.get()` keyed on a bit-encoded integer
   (`rule short name | method type | occurrence index`) to retrieve a
   pre-computed lookahead function, then invokes that function. This is a fixed
   per-production tax even when no backtracking is needed.

3. **Recording phase hidden-class pollution.** `enableRecording()` adds
   instance methods to the parser object; `disableRecording()` deletes them
   (~80 `delete` calls). In V8, adding/deleting own properties transitions the
   object to a new hidden class. Any inline cache (IC) that was optimized for
   the previous shape becomes polymorphic or megamorphic until the JIT
   re-optimizes. Fix (Stage 5): stop shadowing prototype methods with instance
   properties entirely — check `RECORDING_PHASE` inside the prototype methods
   themselves so no `delete` is ever needed.

### Additional allocation costs found in audit

4. **State save/restore clones the errors array.** `saveRecogState()` calls
   `this.errors` (which may return a clone) and `this.RULE_STACK.slice()` on
   every backtrack point. With speculative parsing, the save should be three
   integers (position, errors length, stack depth) — no allocation at all.

5. **Token and IToken object shapes are not fixed at creation.**
   `createToken()` sets optional fields conditionally, so tokens with different
   config have different hidden classes. `augmentTokenTypes()` then adds four
   more fields — a shape transition on every token object. IToken has three
   different factory functions (`createOffsetOnlyToken`, `createStartOnlyToken`,
   `createFullToken`) producing three hidden classes; call sites accessing token
   properties become polymorphic. `isInsertedInRecovery` is added to recovery
   tokens after creation — another transition.

6. **Category matching uses two redundant structures.** `categoryMatchesMap`
   (object) and `categoryMatches` (array) both exist on every token type and
   encode the same information. A `Uint32Array` bitset replaces both with O(1)
   bitwise AND matching and eliminates two of the four fields added by
   `augmentTokenTypes()`.

7. **Lexer clones group structure on every `tokenize()` call.**
   `cloneEmptyGroups()` is called at the start of each tokenization to reset
   the result groups. It iterates all group definitions and creates new arrays.
   Groups are static metadata — only the result arrays need resetting, not the
   structure.

8. **CST building allocates a new object and location object per rule.**
   `cstInvocationStateUpdate()` calls `Object.create(null)` for each rule's
   children dictionary and allocates a fresh location object with six `NaN`
   fields. With deep grammars this is thousands of allocations per parse.
   Additionally `addTerminalToCst` creates a single-element array `[token]`
   for the first occurrence of each token type in a rule, causing hidden class
   transitions on the children arrays.

### Replacement strategies

- **SPEC_FAIL symbol** replaces Error-based backtracking. V8 does not call
  `captureStackTrace` for non-Error throws. A Symbol throw+catch is a non-local
  goto — zero allocation, branch-predictor friendly.
- **Speculative execution** replaces lookahead pre-computation. `OR()` tries
  alternatives in order; failed ones throw SPEC_FAIL, state is restored via
  three integer assignments, the next alternative is tried.
- **Fixed object shapes** from construction — all fields pre-declared with
  sentinel values so V8 sees one hidden class per object type from birth.
- **Bitset token matching** replaces `categoryMatchesMap` and `categoryMatches`
  with a `Uint32Array` MATCH_SET, computed once in `augmentTokenTypes()`.
- **performSelfAnalysis** always runs recording and validation; GAST APIs
  lazily populate cache when empty (no fail if performSelfAnalysis was skipped).

---

## What Is Preserved

| Item                                                                    | Status                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Full public API (`CstParser`, `EmbeddedActionsParser`, all DSL methods) | Unchanged                                                                            |
| `OR1`–`OR9`, `CONSUME1`–`CONSUME9`, all numbered variants               | Kept as aliases                                                                      |
| `Lexer` class interface                                                 | Unchanged                                                                            |
| `createToken`, `tokenMatcher`, `EOF`, error classes                     | Unchanged                                                                            |
| `MismatchedTokenException` etc.                                         | Kept — still thrown for real (non-speculative) errors                                |
| `performSelfAnalysis()`                                                 | Kept — always runs recording and validation                                          |
| `ILookaheadStrategy` / `LLkLookaheadStrategy`                           | Kept as deprecated no-ops                                                            |
| Grammar recording mechanism                                             | Kept — runs in performSelfAnalysis; lazy fallback for GAST APIs                      |
| `serializeGrammar`, `generateCstDts`, `createSyntaxDiagramsCode`        | Kept — use cache; lazy populate via `ensureGastProductionsCachePopulated` when empty |

## Candidate Exports for Removal

TypeScript `export`s that do not appear in `packages/types/api.d.ts` are
internal implementation details leaked through module boundaries. As each stage
restructures the code, audit these exports and delete any that are no longer
needed by the new architecture. Do not keep an export just because it exists —
if it isn't part of the public API contract and isn't consumed by another
internal module, remove it.

---

## What Is Deleted

| Item                                        | Reason                                |
| ------------------------------------------- | ------------------------------------- |
| `LooksAhead` trait                          | Replaced by speculative execution     |
| `lookAheadFuncsCache`                       | No longer needed                      |
| `preComputeLookaheadFunctions`              | No longer needed                      |
| `getKeyForAutomaticLookahead`               | No longer needed                      |
| `LLkLookaheadStrategy` implementation       | Replaced — interface stub kept        |
| `isBackTrackingStack: boolean[]`            | Replaced by `IS_SPECULATING: boolean` |
| `categoryMatches: number[]`                 | Replaced by `MATCH_SET` bitset        |
| `categoryMatchesMap: object`                | Replaced by `MATCH_SET` bitset        |
| `applyMixins` composition                   | Replaced by direct class hierarchy    |
| `RecognizerEngine` / `RecognizerApi` traits | Merged into new base class            |

---

## Architecture After Replacement

```
RecursiveDescentParser        ← new core (CONSUME, OR, MANY, state, SPEC_FAIL)
  └─ EmbeddedActionsParser    ← RULE(), ACTION() passthrough, performSelfAnalysis no-op
       └─ CstParser           ← CST stack, CONSUME/SUBRULE overrides, visitor constructors
```

The `Lexer` class sits beside this hierarchy with an improved but
interface-compatible implementation.

---

## Stages

---

### Stage 0 — Settle token and IToken object shapes

**Goal:** Fix all hidden class instability in the token layer. All token objects
share one hidden class from birth; no shape transitions after construction.
This stage must land before Stage 1 — the new engine accesses `MATCH_SET`,
`isParent`, and other augmented fields unconditionally. Without a guaranteed
shape, every access would require `?.` or null checks throughout the engine.

#### What changes

**`TokenType` — pre-declare all fields in `createToken()`:**

```ts
function createToken(config: ITokenConfig): TokenType {
  return {
    name: config.name,
    PATTERN: config.PATTERN ?? undefined,
    LABEL: config.LABEL ?? undefined,
    GROUP: config.GROUP ?? undefined,
    PUSH_MODE: config.PUSH_MODE ?? undefined,
    POP_MODE: config.POP_MODE ?? false,
    LONGER_ALT: config.LONGER_ALT ?? undefined,
    LINE_BREAKS: config.LINE_BREAKS ?? undefined,
    START_CHARS_HINT: config.START_CHARS_HINT ?? undefined,
    CATEGORIES: config.CATEGORIES ? [...config.CATEGORIES] : [],
    // augmented — sentinel values, filled in by augmentTokenTypes()
    tokenTypeIdx: 0,
    isParent: false,
    MATCH_SET: null, // ← new; replaces categoryMatches + categoryMatchesMap
  };
}
```

- `categoryMatches` and `categoryMatchesMap` are removed entirely.
  `tokenMatcher()` and all internal category checks switch to bitset AND:
  ```ts
  function tokenStructuredMatcher(token: IToken, expected: TokenType): boolean {
    return (
      token.tokenTypeIdx === expected.tokenTypeIdx ||
      (expected.isParent &&
        !!(
          expected.MATCH_SET![token.tokenTypeIdx >> 5] &
          (1 << (token.tokenTypeIdx & 31))
        ))
    );
  }
  ```
- `augmentTokenTypes()` computes `MATCH_SET` (Uint32Array, one bit per possible
  tokenTypeIdx) and assigns `tokenTypeIdx` and `isParent`. No new properties
  are added — only sentinel values are overwritten. No hidden class transition.

**`IToken` — one shape for all position-tracking modes:**

```ts
// Single factory — positionTracking controls which fields get real values,
// not whether the fields exist
function createToken(...): IToken {
  return {
    image:                '',
    startOffset:          0,
    endOffset:            0,
    startLine:            0,
    endLine:              0,
    startColumn:          0,
    endColumn:            0,
    tokenTypeIdx:         0,
    tokenType:            tokType,
    payload:              undefined,
    isInsertedInRecovery: false,
  }
}
```

- `createOffsetOnlyToken`, `createStartOnlyToken`, `createFullToken` are
  replaced by a single factory. The position-tracking mode controls which
  fields are filled, not which fields exist.
- `isInsertedInRecovery` pre-declared as `false` — no longer added post-hoc
  during recovery. Recovery just sets it to `true`.
- `payload` pre-declared as `undefined` — no longer conditionally added.

**Lexer — fix `cloneEmptyGroups()` on every `tokenize()` call:**

- Pre-allocate a `resultGroups` structure in the Lexer instance at construction
  time with empty arrays for each group.
- On `reset()` between calls, truncate each array to length 0 instead of
  cloning the whole structure. Arrays retain their allocated capacity.

**`createTokenInstance` — direct call, not dynamically assigned property:**

- Currently `this.createTokenInstance` is a property assigned at lexer init
  pointing to one of the three factory variants. Call sites must go through a
  property lookup + indirect call — V8 cannot inline this reliably.
- With a single factory, replace with a direct call. The `if/else` for tracking
  mode happens inside the factory, which V8 can inline and optimize.

**Sentinel padding — replace push/pop loops with length assignment:**

`onBeforeParse` pads `tokVector` with `maxLookahead + 1` EOF sentinels using a
`.push()` loop, triggering array growth on every parse call. `onAfterParse`
removes them with a `.at(-1).pop()` loop (polyfill overhead). Replace both with
direct length manipulation:

```ts
// onBeforeParse
const sentinelCount = this.maxLookahead + 1;
this.tokVector.length = baseLength + sentinelCount; // no per-element cost
this.tokVector.fill(END_OF_FILE, baseLength);

// onAfterParse
this.tokVector.length -= sentinelCount; // single assignment
```

**Trivial lexer cleanup:**

`push_mode` (lexer_public.ts) assigns `currModePatternsLength` twice
consecutively — the second assignment is a dead write. Delete it.

#### Exit criteria

- All `TokenType` objects have identical shape regardless of `createToken()`
  config (verifiable via `%HaveSameMap` in V8 with `--allow-natives-syntax`).
- All `IToken` objects have identical shape regardless of lexer
  `positionTracking` mode.
- `categoryMatches` and `categoryMatchesMap` do not appear on any token type.
- `tokenMatcher()` produces identical results to the previous implementation
  for all token/category combinations (existing tests pass).
- `cloneEmptyGroups` is deleted; lexer uses reset-by-truncation.

---

### Stage 1 — Replace Error-based backtracking with SPEC_FAIL

**Goal:** Eliminate `Error.captureStackTrace` calls during speculative parsing,
and eliminate all heap allocation from the save/restore path.

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

**Fix `saveRecogState()` — replace array cloning with integer snapshots:**

Currently `saveRecogState()` clones the errors array and slices the rule stack.
With SPEC_FAIL, speculative failures never produce real errors, so save state is
just three integers:

```ts
saveRecogState(): ParserSavepoint {
  return {
    pos:               this.currIdx,
    errorsLength:      this.errors.length,
    ruleStackDepth:    this.RULE_STACK_IDX,
  }
}

reloadRecogState(saved: ParserSavepoint): void {
  this.currIdx        = saved.pos
  this.errors.length  = saved.errorsLength       // truncate, no allocation
  this.RULE_STACK_IDX = saved.ruleStackDepth     // depth counter reset
}
```

No array copies, no slice. The savepoint object itself is three integers — V8
will often stack-allocate or scalar-replace this entirely in a hot loop.

**Fix `delete e.partialCstResult` in `recognizer_engine.ts`:** ✅

`subruleInternalError()` (and equivalent paths) now use `e.partialCstResult =
undefined` instead of `delete`, avoiding hidden-class transitions on the
exception object.

**Fix `findReSyncTokenType()` — O(n²) → O(n):**

Currently `flattenFollowSet()` builds a flat array of token types and
`findReSyncTokenType()` scans it with `.find()` per lookahead position —
O(follow set size) per token checked. Replace the array with a `Set`:

```ts
// flattenFollowSet returns Set<TokenType> instead of TokenType[]
const reSyncSet = this.flattenFollowSet(); // build once
while (true) {
  if (reSyncSet.has(nextToken.tokenType)) return nextToken.tokenType;
  nextToken = this.LA_FAST(k++);
}
```

Also switch the inner `LA(k)` call to `LA_FAST(k)` — the loop already guards
against going past EOF via the sentinel padding.

**Fix `flattenFollowSet()` — triple allocation → single pass:**

```ts
// Current: buildFullFollowKeyStack().map(...).flat() — three allocations
// Replacement: push directly into one Set
flattenFollowSet(): Set<TokenType> {
  const result = new Set<TokenType>()
  for (const key of this.buildFullFollowKeyStack()) {
    for (const tokType of this.getFollowSetFromFollowKey(key)) {
      result.add(tokType)
    }
  }
  return result
}
```

Note: `buildFullFollowKeyStack()` uses `shortRuleNameToFull` which is going
away in Stage 6. After Stage 6, `RULE_STACK` stores rule names directly,
eliminating the integer → string lookup and the follow key string concatenation
(`ruleName + idx + IN + inRule`) entirely.

#### Exit criteria

- All existing tests pass unchanged.
- `BACKTRACK()` returns `false` on mismatch without allocating an Error.
- A micro-benchmark of `BACKTRACK` on a failing rule shows zero `Error`
  objects created (verifiable via `--expose-gc` + `gc()` count).
- `saveRecogState()` does not call `.slice()` or create array copies.

---

### Stage 2 — Replace lookahead pre-computation with speculative OR()

**Goal:** Remove `Map.get()` + lookahead function call from every production.

#### What changes

- Rewrite `orInternal()` to iterate alternatives speculatively:
  - Save state (`pos`, `errors.length`, stack depth) — three integers.
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

### Stage 3 — Skip GAST traversal and error building during speculation

**Goal:** Eliminate all expensive work (GAST traversal, Error object
construction) from the hot speculative path.

#### What changed

**`raiseNoAltException` / `raiseEarlyExitException`:**

- When `IS_SPECULATING === true`, throw `SPEC_FAIL` immediately without
  traversing the GAST to build error context. The error is never visible to
  the user (speculation rolls back), so constructing it is pure waste.

**CST node building skipped during speculation:**

- `cstInvocationStateUpdate` / `cstFinallyStateUpdate` / `cstPostTerminal` /
  `cstPostNonTerminal` are no-ops when `IS_SPECULATING === true`. Nodes built
  during a failed speculative attempt are immediately garbage — no point
  allocating them.

**Error building skipped during speculation:**

- `consumeInternal` already throws `SPEC_FAIL` directly. No
  `MismatchedTokenException` is constructed. Combined with the above, zero
  heap allocation occurs on the speculative failure path.

#### Note: "numbered variant aliases" analysis

The original Stage 3 plan was to make `OR1`–`OR9` etc. true aliases.
Analysis showed this is not viable:

- `_orFastMaps` key = `currRuleShortName | occurrence` — aliasing all variants
  to `occurrence=0` would collapse the cache for rules with multiple OR calls.
- `CONSUME`/`SUBRULE` indices are needed for error recovery follow sets and
  `RULE_OCCURRENCE_STACK`.
- All variants need distinct indices for GAST recording accuracy.
  The one-liner wrappers are trivially inlined by V8; no action needed.

---

### Stage 4b — Watermark-based CST save/restore

**Goal:** Eliminate `.slice()` array cloning in `saveCstTopImpl()`. Speculative
OR attempts pay only O(k) integer writes instead of O(k) array copies.

#### What changed

`saveCstTopImpl()` now records the `.length` of each existing children array
as plain integers. `restoreCstTopImpl()` truncates via `.length = savedLen`.
No array copies. New keys added during a failed alt remain as empty arrays
(semantically equivalent to absent for `.length`-checking consumers).

This is safe because recovery is disabled during speculation
(`!this.isBackTracking()` guard in `invokeRuleCatch`), so partial CST nodes
from failed alts are never consumed by recovery logic.

#### Exit criteria

- `saveCstTopImpl` does not call `.slice()` or allocate array copies.
- Existing CST-based tests pass unchanged.

---

### Stage 4c — CST allocation fixes

**Goal:** Every `CstNode` and `CstNodeLocation` object shares one V8 hidden
class from birth. Child array push uses the IC-friendly `??=` pattern.

#### What changed

**`createCstNode(name)`:** pre-declares `location: undefined` so assignment by
`setInitialNodeLocation` writes to an existing property (no hidden-class
transition).

**`createCstLocationOnlyOffset()` / `createCstLocationFull()`:** two separate
fixed-shape factories — one per location-tracking mode. All objects in a mode
share one hidden class.

**`addTerminalToCst` / `addNoneTerminalToCst`:** use `??= []` push instead of
`= [token]` on first occurrence. Avoids the internal V8 transition from empty
array to single-element array (which breaks monomorphic child-array access).

#### Exit criteria

- All `CstNodeLocation` objects in a given mode share a single hidden class.
- Existing CST-based tests pass unchanged.

---

### Stage 4a.1 — Fix OR gate correctness + multi-candidate fast-dispatch

**Goal:** The `_orFastMaps` fast-dispatch cache correctly handles GATE
functions and LL(1)-ambiguous grammars. Gates are context-sensitive (they can
return different values between calls), so the cache must store all _possible_
candidates per LA(1) token, and gates must be evaluated at dispatch time.

#### What changed

**Multi-candidate fast map (replaces single-alt cache):**

The original fast map stored `tokenTypeIdx → single altIndex`, marking
ambiguous entries as `-1` (disabling the fast path entirely). This had two
correctness issues:

1. **Gate bypass**: A gate-free alt cached for LA(1)=A would be dispatched
   directly, even when a higher-priority gated alt's gate was now open.
2. **Lost candidates**: If two alts could match the same LA(1) token, the
   fast path was disabled (`-1`), even though both candidates could be tried
   in order.

The new design stores `tokenTypeIdx → number[]` — an array of candidate alt
indices, sorted by declaration order. At dispatch time:

1. Iterate candidates for this LA(1) token.
2. Check each candidate's GATE (if any). Skip if gate fails.
3. Try the first candidate whose gate passes. On failure, try the next.
4. If all candidates fail or are gated out, fall through to the full
   speculative loop (there may be alts not yet observed for this LA(1)).

For gate-free, unambiguous LL(1) grammars (e.g. JSON, CSS) the candidate
list is always length 1 and there are no gates to check — zero overhead
compared to the original single-alt design.

**`addOrCandidate()` helper:**

Extracted the fast-map population logic into a standalone function. Called
from both the success path and the failure-with-progress path in the slow
speculative loop. On each call it:

- Adds the observed alt index to the candidate list (if not already present).
- Adds any preceding gated alts to the candidate list (their gates may have
  been closed during the slow loop, but they could match this token when
  their gates open on a future call).
- Keeps the list sorted by declaration order.

**Failure-with-progress caching:**

When an alt fails in the slow loop but consumed tokens (`progress > 0`), it
is now added to the fast-map candidate list for its LA(1) token. This is
important for alts with internal context-dependent behavior (e.g. gated
OPTIONs, parametrized rules) — the alt matched this token type but failed
for context-specific reasons, and may succeed on a future call.

**Candidate stability:**

Candidates are never removed from the fast-map list on failure. An alt that
fails on the fast path (e.g. because an internal gated OPTION was closed)
stays in the candidate list. On a future call where the gate opens, it will
succeed again. This is correct because error recovery is disabled during
speculation (`!this.isBackTracking()` guard), so transient fast-path
failures are safe to retry.

**Gated-prefix tracking (`_orAltHasGatedPrefix` / `_orGatedPrefixAlts`):**

An alt whose body starts with a gated OPTION/MANY/AT_LEAST_ONE (before any
CONSUME) has a gate-dependent first-token set: which LA(1) tokens it can
match changes depending on gate state. These alts cannot be cached by LA(1)
alone — they must always be speculated.

Example: `{ ALT: () => { OPTION({ GATE: flag, DEF: CONSUME(A) }); CONSUME(B); } }`

- When `flag=true`: matches LA(1)=A (OPTION takes A, then B) or LA(1)=B
- When `flag=false`: matches LA(1)=B only (OPTION skipped)

If the first observation has `flag=false`, alt 0 only matches LA(1)=B. The
token-based cache records it for B but not A. On a later call with `flag=true`
and LA(1)=A, the cache has no entry for alt 0 — wrong result.

Implementation:

- `_orAltStartLexPos`: lexer position at the start of the current OR alt.
- `_orAltHasGatedPrefix`: set to `true` by `optionInternalLogic`,
  `manyInternalLogic`, or `atLeastOneInternalLogic` when they encounter a
  gate and `exportLexerState() === _orAltStartLexPos` (no tokens consumed yet).
- `_orGatedPrefixAlts[mapKey]`: per-OR list of alt indices with gated
  prefixes. These alts are NOT added to `_orFastMaps` — instead they are
  always speculated on the fast path.
- Fast-path merge: iterates both `candidates` (token-based, from
  `_orFastMaps`) and `gatedPrefixAlts` in declaration order, trying each.
  For gate-free grammars, `gatedPrefixAlts` is `undefined` — zero overhead.
- **Save/restore around `orInternal`**: `_orAltStartLexPos` and
  `_orAltHasGatedPrefix` are saved at entry and restored at every exit
  point of `orInternal` (success return, post-loop error paths). This
  prevents nested ORs (reached via SUBRULEs) from corrupting the outer
  OR's gated-prefix tracking.
- **`_orGatedPrefixAlts` kept sorted**: after each `push`, the list is
  sorted by alt index. Without this, cross-call discovery order (e.g.
  alt 2 discovered on call 1, alt 0 on call 2) would produce an unsorted
  list, breaking the fast-path merge iteration which assumes sorted order.

#### Key invariants

1. **Gates evaluated at dispatch time, never at cache time.** The candidate
   list records which alts _can possibly_ match a given LA(1) token. Gates
   further restrict the list on each call.
2. **Candidates are never invalidated.** Internal gating state (gated
   OPTIONs, parametrized rules) can change between calls, so a failing
   candidate may succeed next time.
3. **Gated-prefix alts are always speculated.** Alts with gate-dependent
   first-token sets are never in the token-based cache — they appear in
   `_orGatedPrefixAlts` and are tried on every fast-path invocation.
4. **Recovery is disabled during speculation.** Partial CST nodes from failed
   fast-path attempts are never consumed by recovery logic.

#### Exit criteria

- All existing predicate/gate tests pass unchanged.
- New tests cover: gated alt priority, gated OPTION inside alt body, gated
  OPTION nested in SUBRULE, failure-with-progress caching (with `_orFastMaps`
  inspection), non-gated OPTION stability, gated OPTION closed on first run
  then open on later run (correctness regression test).
- Gate-free unambiguous grammars (JSON, CSS) show no performance regression.
- 776 tests passing, 0 new failures.

---

### Stage 5 — performSelfAnalysis optional (not required)

**Goal:** `performSelfAnalysis()` is **optional** instead of required. If called,
it runs recording and validation. If not called, the first use (set `input` or
call GAST APIs) runs the work lazily — do not fail.

#### Strategy

1. **`performSelfAnalysis()`** — optional. When called, runs full flow:
   recording, resolve, validation, follow sets when `recoveryEnabled`.

2. **`input` setter** — when `selfAnalysisDone` is false, call
   `ensureGastProductionsCachePopulated()` instead of throwing. Lazy init on
   first parse.

3. **`getSerializedGastProductions()` and `getGAstProductions()`** — call
   `ensureGastProductionsCachePopulated()` before returning. Works when
   `performSelfAnalysis` was never invoked.

4. **`ensureGastProductionsCachePopulated()`** — when cache empty: record,
   resolve, validate, follow sets (when `recoveryEnabled`), set
   `selfAnalysisDone`. Idempotent when cache already populated.

#### What changes

- Input setter: no longer throws when `performSelfAnalysis` was not called;
  instead runs `ensureGastProductionsCachePopulated()`.
- `ensureGastProductionsCachePopulated()`: sets `selfAnalysisDone`, runs
  `computeAllProdsFollows` when `recoveryEnabled`.
- Docs: `performSelfAnalysis` is recommended but optional.

#### Exit criteria

- Parser works without calling `performSelfAnalysis` (lazy init on first `input`
  set or GAST API call).
- All grammar validation tests pass.

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

- Run the three existing `benchmark_web` grammars (JSON, CSS, ECMA5) unchanged
  against both the old engine (pinned at `v12.0.0`) and the new engine.
  No grammar changes should be required — identical source code is the
  backwards-compatibility proof.
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

## Development Process

### Running tests

**Run the full test suite before every commit.** Each stage ends with a green
test suite. The standard commands are:

```bash
# From the repo root — compile + bundle + test the chevrotain package
cd packages/chevrotain && bun run ci

# Quick iteration during development (compile + mocha, no bundle step)
cd packages/chevrotain && bun run build && bun run unit-tests

# Full repo CI (format check + all subpackages)
bun run ci
```

`bun run ci` in the `packages/chevrotain` directory expands to
`bun run build test`, i.e. `clean → compile → bundle → coverage`.

### JSDoc

Every function, method, or non-trivial field added or meaningfully changed in a
stage gets a JSDoc comment explaining **what it does and why** — not restatements
of the type signature. Focus on the performance rationale or contract that isn't
obvious from the name alone.

Good:

```ts
/**
 * Bitset membership test replacing the old categoryMatchesMap object lookup.
 * One bitwise AND instead of a property read + coercion — stays monomorphic
 * because MATCH_SET is always a Uint32Array (or null for leaf tokens).
 */
```

Avoid:

```ts
/** Returns true if the token matches the constructor. */ // obvious from the name
```

Rule of thumb: if you'd need to read the Background section of this plan to
understand _why_ the code is written the way it is, that explanation belongs in
a JSDoc on the code itself.

### Commit format

This repo uses [Conventional Commits](https://www.conventionalcommits.org/).
The commit-msg hook enforces it via `commitlint`. Use one of:

```
feat: <summary>          ← new capability visible to users
fix: <summary>           ← bug fix
perf: <summary>          ← performance improvement with no API change
refactor: <summary>      ← internal restructuring, no behaviour change
test: <summary>          ← test-only change
chore: <summary>         ← build / tooling / meta change
```

Each stage lands as one commit (or a small series of `refactor:`/`perf:`
commits if the diff is large). The commit message body should reference the
relevant stage from this plan and state what exit criteria it satisfies.

Example commit for Stage 0:

```
perf: settle TokenType and IToken hidden-class shapes (stage 0)

- createToken() pre-declares all fields with sentinel values so every
  TokenType object shares a single V8 hidden class from birth.
- Three IToken factory variants unified: all produce the same property
  set; positionTracking mode controls values, not shape.
- MATCH_SET (Uint32Array bitset) replaces categoryMatchesMap for O(1)
  category membership checks in tokenStructuredMatcher.
- Lexer group-key caching replaces Object.keys() call per tokenize().
- Dead write in push_mode removed.

Exits: Stage 0 exit criteria — all existing tests pass.
```

---

## Stage Dependencies

```
Stage 0 (token/IToken shapes)  ← prerequisite for everything
  └─ Stage 1 (SPEC_FAIL + saveRecogState)
       └─ Stage 2 (speculative OR)
            └─ Stage 3 (numbered variant aliases)
                 ├─ Stage 4 (runtime CST + CST allocation fixes)
                 │    └─ Stage 5 (performSelfAnalysis + lazy GAST fallback)
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
| `src/scan/tokens_public.ts`                    | `createToken()` factory         | 0       |
| `src/scan/tokens.ts`                           | `augmentTokenTypes()`, matching | 0       |
| `src/scan/lexer_public.ts`                     | Lexer, IToken factories         | 0       |
| `src/parse/parser/traits/recognizer_engine.ts` | Core engine — primary target    | 1, 2, 6 |
| `src/parse/parser/traits/looksahead.ts`        | Lookahead cache — deleted       | 2       |
| `src/parse/parser/traits/recognizer_api.ts`    | DSL API surface                 | 3       |
| `src/parse/parser/traits/tree_builder.ts`      | CST construction                | 4       |
| `src/parse/cst/cst.ts`                         | CST helpers                     | 4       |
| `src/parse/parser/traits/gast_recorder.ts`     | Recording phase                 | 5       |
| `src/parse/parser/utils/apply_mixins.ts`       | Mixin system — deleted          | 6       |
| `src/parse/parser/parser.ts`                   | Parser base + trait composition | 6       |
| `benchmark_web/lib/bench_logic.js`             | Benchmark runner                | 7       |
| `packages/types/api.d.ts`                      | Public types — unchanged        | —       |
