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
  - ✅ `_orFastMaps` lazy LL(1) cache: maps `tokenTypeIdx → altIndex` per OR site
  - ✅ Fast-dispatched alts skip `IS_SPECULATING`, save/restore, and try/catch entirely
  - ✅ `manyInternalLogic` reverted to speculative-body approach with integer locals
  - ✅ CST save/restore via `saveCstTop()`/`restoreCstTop()` (array cloning — to be replaced by watermarks)
- ⬜ Stage 4b — Watermark-based CST save/restore (replace array cloning)
  - ⬜ `saveCstTopImpl()` records children array `.length` values instead of `.slice()` cloning
  - ⬜ `restoreCstTopImpl()` truncates arrays via `.length = savedLen` instead of replacing children object
  - ⬜ Verify error recovery tests still pass (recovery disabled during speculation via `!this.isBackTracking()` guard)
  - ⬜ Benchmark CstParser before/after to measure save/restore allocation reduction
- ⬜ Stage 4c — CST allocation fixes
  - ⬜ `cstInvocationStateUpdate()` uses fixed-shape `createCstNode()` factory
  - ⬜ `CstNodeLocation` objects use fixed-shape `createCstLocation()` factory
  - ⬜ `addTerminalToCst` uses `??= []` push pattern instead of `[token]` single-element array
- ⬜ Stage 5 — Recording phase: remove hidden-class pollution from `enableRecording`/`disableRecording`

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
- **Optional recording phase** means `performSelfAnalysis()` is a no-op by
  default. The recording mechanism is preserved for GAST tooling.

---

## What Is Preserved

| Item                                                                    | Status                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Full public API (`CstParser`, `EmbeddedActionsParser`, all DSL methods) | Unchanged                                             |
| `OR1`–`OR9`, `CONSUME1`–`CONSUME9`, all numbered variants               | Kept as aliases                                       |
| `Lexer` class interface                                                 | Unchanged                                             |
| `createToken`, `tokenMatcher`, `EOF`, error classes                     | Unchanged                                             |
| `MismatchedTokenException` etc.                                         | Kept — still thrown for real (non-speculative) errors |
| `performSelfAnalysis()`                                                 | Kept — now a no-op unless GAST is requested           |
| `ILookaheadStrategy` / `LLkLookaheadStrategy`                           | Kept as deprecated no-ops                             |
| Grammar recording mechanism                                             | Kept — made opt-in                                    |
| `serializeGrammar`, `generateCstDts`, `createSyntaxDiagramsCode`        | Kept — require opt-in recording pass                  |

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

**Fix `delete e.partialCstResult` in `recognizer_engine.ts`:**

`cstPostRule()` calls `delete e.partialCstResult` after consuming the partial
result from an in-flight exception. `delete` causes a hidden-class transition on
the exception object. Replace with assignment to `undefined`:

```ts
// Before:
delete e.partialCstResult;
// After:
e.partialCstResult = undefined;
```

Cold path, but eliminates the transition.

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

**Goal:** `CstParser` works correctly without `performSelfAnalysis()` having
run, and CST construction minimises per-rule allocation. Speculative OR
attempts do not pay for CST save/restore array cloning.

#### What changes

**Watermark-based CST save/restore (replaces array cloning):**

The current `saveCstTopImpl()` clones every children array on the top CST node
before each speculative OR attempt. This is the dominant allocation cost during
OR slow-path speculation. Replace with a watermark strategy:

- `saveCstTop()`: record the `.length` of each existing children array as
  plain integers. No `.slice()`, no `Object.create(null)`, no allocation
  beyond a small watermark object.
- `restoreCstTop()`: truncate each children array back to its saved length
  via `.length = savedLen`. New keys added during the failed alt are left as
  empty arrays (semantically harmless — the key exists with `[]`, equivalent
  to absent for CST consumers who check `.length`).

```ts
saveCstTopImpl(): CstTopSave {
  const top = this.CST_STACK[this.CST_STACK.length - 1];
  if (top === undefined) return null;
  const watermarks: [string, number][] = [];
  const src = top.children;
  for (const key of Object.keys(src)) {
    watermarks.push([key, src[key].length]);
  }
  return {
    watermarks,
    location: top.location !== undefined
      ? ({ ...top.location } as Record<string, number>)
      : undefined,
  };
}

restoreCstTopImpl(save: CstTopSave): void {
  if (save === null) return;
  const top = this.CST_STACK[this.CST_STACK.length - 1];
  if (top === undefined) return;
  // Truncate existing arrays back to their pre-speculation lengths.
  for (const [key, len] of save.watermarks) {
    top.children[key].length = len;
  }
  // New keys added during the failed alt now have entries but length 0.
  // This is semantically correct — no need to delete (which would cause
  // hidden-class transitions on the children object).
  if (save.location !== undefined) {
    (top as any).location = save.location;
  }
}
```

This is safe because recovery is disabled during speculation
(`!this.isBackTracking()` guard in `invokeRuleCatch`), so the partial CST
from a failed speculative alt is never consumed by recovery logic. Child
CstNodes created by SUBRULEs inside a failed alt become garbage naturally.

**Runtime CST interception (replaces GAST-derived field names):**

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
- `getBaseCstVisitorConstructor()` uses the rule registry built by `RULE()`
  (rule names only — no GAST needed).
- Delete the GAST-derived CST field-name pre-computation from `TreeBuilder`.

**Fix CstNode allocation — pre-declared fixed shape:**

`cstInvocationStateUpdate()` currently calls `Object.create(null)` for each
rule's children dict, which creates a new object every invocation. Replace with
a fixed-shape CstNode created via a factory that declares all fields upfront:

```ts
function createCstNode(name: string): CstNode {
  return {
    name,
    children: Object.create(null),
    recoveredNode: false,
    location: undefined, // filled in if location tracking enabled
  };
}
```

The `location` object is also pre-declared with a fixed shape:

```ts
function createCstLocation(): CstNodeLocation {
  return {
    startOffset: NaN,
    startLine: NaN,
    startColumn: NaN,
    endOffset: NaN,
    endLine: NaN,
    endColumn: NaN,
  };
}
```

This is allocated once per rule entry and overwritten — same number of objects
but fixed shape so all location objects share one hidden class.

**Fix `addTerminalToCst` single-element array creation:**

```ts
// Current — creates new single-element array on first occurrence:
node.children[key] = [token];

// Replacement — pre-allocate with capacity hint, or use ??= push pattern:
(node.children[key] ??= []).push(token);
```

The `??=` pattern is already inline-cache-friendly and avoids the hidden class
transition that `[token]` causes (empty array → 1-element array have different
internal representations in V8).

**Location tracking:**

`nodeLocationTracking: "none" | "onlyOffset" | "full"` handled by assigning
the appropriate update method at construction time — same strategy as existing
`TreeBuilder.initTreeBuilder()` but without GAST dependency.

#### Future exploration: fully deferred CST creation

The watermark approach still creates child CstNodes during failed speculative
attempts (they become garbage). A more aggressive optimisation would defer all
CST object creation until an alt is committed — collecting tokens and child
references into lightweight frame-buffer arrays during speculation, and only
materializing `CstNode` objects on success. This would eliminate all GC
pressure from failed alts. The key invariant that makes this safe: recovery
mode is disabled during speculation (`!this.isBackTracking()`), so partial
CST nodes are never needed during speculative attempts.

#### Exit criteria

- `CstParser` produces identical CST output with and without
  `performSelfAnalysis()` having been called.
- All three `nodeLocationTracking` modes produce correct location info.
- `getBaseCstVisitorConstructor()` returns a valid base class with all rule
  names present.
- All `CstNodeLocation` objects share a single hidden class (verifiable via
  `%HaveSameMap`).
- `saveCstTopImpl` does not call `.slice()` or allocate array copies.
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
- `serializeGrammar()` works after opt-in, throws with a clear message without.
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

Each stage ends with a green test suite. The standard commands are:

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
