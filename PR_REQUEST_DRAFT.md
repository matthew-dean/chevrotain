# TL;DR

Chevrotain’s strict parser path is now materially faster than v12 in end-to-end warm reuse: `EmbeddedActionsParser` is `106%` of v12 on JSON and `107%` on CSS in the longer-run `10` median warm benchmark with `2` burn-in runs. `SmartParser` keeps the forgiving DX mode: no explicit `performSelfAnalysis()`, auto-occurrence for repeated plain DSL calls, speculative fallback for ambiguous or gated cases, and relaxed lookahead behavior for users who want convenience over strictness.

Current benchmark snapshot:

| Parser / phase       | v12 + PSA | Embedded + PSA  | Smart + PSA     | Smart - PSA     |
| -------------------- | --------- | --------------- | --------------- | --------------- |
| JSON constructor     | 1.45 ms   | 0.84 ms (173%)  | 0.86 ms (169%)  | 0.27 ms (537%)  |
| JSON parse-only      | 0.43 ms   | 0.45 ms (97%)   | 0.43 ms (102%)  | 1.07 ms (41%)   |
| JSON construct+parse | 1.89 ms   | 1.29 ms (147%)  | 1.28 ms (148%)  | 1.34 ms (141%)  |
| JSON lex-warm        | 23,329/s  | 23,384/s (100%) | 23,605/s (101%) | 24,433/s (105%) |
| JSON parse-warm      | 35,592/s  | 34,289/s (96%)  | 25,458/s (72%)  | 25,026/s (70%)  |
| JSON full-warm       | 13,086/s  | 13,920/s (106%) | 12,157/s (93%)  | 12,082/s (92%)  |
| CSS constructor      | 1.42 ms   | 0.82 ms (173%)  | 0.83 ms (171%)  | 0.25 ms (568%)  |
| CSS parse-only       | 0.87 ms   | 0.81 ms (106%)  | 1.03 ms (84%)   | 1.60 ms (54%)   |
| CSS construct+parse  | 2.28 ms   | 1.63 ms (140%)  | 1.86 ms (123%)  | 1.85 ms (123%)  |
| CSS lex-warm         | 1,974/s   | 2,130/s (108%)  | 2,133/s (108%)  | 2,137/s (108%)  |
| CSS parse-warm       | 83,399/s  | 83,816/s (101%) | 55,712/s (67%)  | 54,697/s (66%)  |
| CSS full-warm        | 1,931/s   | 2,065/s (107%)  | 2,037/s (105%)  | 2,045/s (106%)  |

# Summary

This change set separates the strict parser path from the forgiving parser path so the default `EmbeddedActionsParser` and `CstParser` can stay close to the upstream runtime shape, while the forgiving behavior lives in `SmartParser`.

The work is not just a file split. It also includes lexer/token object shaping changes that reduced lexer overhead, plus the cleanup needed to keep the forgiving parser’s adaptive behavior isolated from the strict path.

# What Changed

The parser codebase was restructured from a large monolith into a clearer split:

- `parser.ts` is now a facade.
- `parser_core.ts` holds the shared core and strict-compatible plumbing.
- `strict_parser.ts` owns `StrictParser`, `CstParser`, and `EmbeddedActionsParser`.
- `forgiving_parser.ts` owns `ForgivingParser` and `SmartParser`.

Behaviorally, the strict parser path keeps the fast, upstream-like DSL dispatch shape:

- direct numbered DSL wrappers for `CONSUME`, `SUBRULE`, `OPTION`, `OR`, `MANY`, `AT_LEAST_ONE`, and separator variants
- strict lookahead-driven `OPTION` and repetition paths
- strict `OR` dispatch without the forgiving speculative engine
- no forgiving-only bookkeeping on the strict steady-state path

`SmartParser` keeps the adaptive behavior:

- parsing without an explicit `performSelfAnalysis()`
- repeated plain DSL calls in the same rule
- ambiguous LL(1) fallback handled speculatively
- custom lookahead strategy reuse
- baseline restoration for parser reuse when lookahead caches are learned at runtime

# Why The Split

The original fork had mixed semantics in one class hierarchy. That made the default parser pay for optional behavior. The split makes the tradeoff explicit:

- strict parser classes optimize for speed and predictability
- SmartParser optimizes for developer convenience and forgiving grammar authoring

That separation matters because the default parser is the hot path used by most grammars, and the forgiving features are only useful for a smaller set of use cases.

# Performance Outcome

The strict path is ahead of v12 in the current same-session warm medians:

- JSON `EmbeddedActionsParser`: `13,988/s` vs v12 `13,302/s`
- CSS `EmbeddedActionsParser`: `2,198/s` vs v12 `2,056/s`

That is roughly:

- JSON warm: `105%` of v12
- CSS warm: `107%` of v12

The lexer also improved after slimming token object shapes:

- lexed tokens now avoid the fully normalized, always-present field set on the hot lexer path
- `createTokenInstance()` was also aligned to a leaner shape for full tokens

Those changes reduced the per-token object cost and recovered lexer throughput, which mattered especially for JSON.

# What Stayed Strict

The strict path intentionally keeps only the pieces that help the hot runtime:

- direct DSL wrapper calls without extra phase branching
- precomputed lookahead where it helps
- parser reuse fixes that avoid redoing cold work
- token-matching and recovery behavior needed for correctness

The forgiving-only cache learning, baseline restore, and speculative OR machinery live under `SmartParser` instead of polluting the default path.

# Validation

Validation was run at multiple levels:

- `bun run compile`
- focused parser/CST/Smart suites
- warm benchmark sanity checks for JSON and CSS
- same-session `EmbeddedActionsParser` vs v12 warm medians

The focused suite currently reports `805 passing, 2 pending`.

# Notes For Reviewers

The main review question is whether the split preserves the strict path’s performance while keeping SmartParser’s behavior intact. The answer appears to be yes:

- strict parsers stay fast and simpler to reason about
- SmartParser preserves the fork’s convenience features
- the benchmark deltas remain positive against v12 on the strict path

If you want to review the code change mechanically, start with:

- `packages/chevrotain/src/parse/parser/parser.ts`
- `packages/chevrotain/src/parse/parser/parser_core.ts`
- `packages/chevrotain/src/parse/parser/strict_parser.ts`
- `packages/chevrotain/src/parse/parser/forgiving_parser.ts`
- `packages/chevrotain/src/scan/lexer_public.ts`
- `packages/chevrotain/src/scan/tokens_public.ts`
