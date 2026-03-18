# CLI Benchmark: v12.0.0 vs rd-engine-replacement

Run with:

```bash
# Baseline (published v12.0.0)
node benchmark.mjs --lib /path/to/chevrotain-12.0.0/package/lib/chevrotain.mjs --iterations 5000

# Current build
node benchmark.mjs --iterations 5000
```

## Results (Node.js, warm mode, 5k iterations + 500 warmup)

### EmbeddedActionsParser (outputCst: false)

| Parser | v12.0.0 (baseline)            | rd-engine-replacement        | Delta               |
| ------ | ----------------------------- | ---------------------------- | ------------------- |
| JSON   | ~14,000 ops/sec (0.071 ms/op) | ~8,500 ops/sec (0.118 ms/op) | **-39%** regression |
| CSS    | ~1,980 ops/sec (0.505 ms/op)  | ~2,080 ops/sec (0.480 ms/op) | **+5%** improvement |

### CstParser (outputCst: true)

| Parser | v12.0.0 (baseline)           | rd-engine-replacement        | Delta               |
| ------ | ---------------------------- | ---------------------------- | ------------------- |
| JSON   | ~7,100 ops/sec (0.141 ms/op) | ~5,400 ops/sec (0.185 ms/op) | **-24%** regression |
| CSS    | ~2,040 ops/sec (0.491 ms/op) | ~2,100 ops/sec (0.475 ms/op) | **+3%** improvement |

## Summary

- **JSON**: Significant regression (~39% EmbeddedActionsParser, ~24% CstParser). JSON is a gate-free, unambiguous LL(1) grammar — the old engine's precomputed lookahead may be more efficient for this case.
- **CSS**: Slight improvement (~5% EmbeddedActionsParser, ~3% CstParser). CSS has more ORs and alternatives; the new speculative engine with lazy fast-path may be handling it well.

## Notes

- Baseline: `npm pack chevrotain@12.0.0` then extract to `/tmp/chevrotain-baseline/package/`
- Run date: 2025-03-18
- Environment: Node.js v24.x, macOS
