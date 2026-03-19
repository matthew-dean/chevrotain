/**
 * Node.js CLI benchmark for the Chevrotain parser engine.
 *
 * Usage:
 *   node benchmark.mjs                        # our local build
 *   node benchmark.mjs --lib <path>           # compare a different build
 *   node benchmark.mjs --parser json|css      # select parser (default: all)
 *   node benchmark.mjs --cst                  # use CstParser (default: EmbeddedActionsParser)
 *   node benchmark.mjs --iterations 5000      # override iteration count
 *
 * To compare against the published npm version:
 *   npm pack chevrotain@latest -o /tmp/chevrotain-baseline.tgz
 *   tar -xzf /tmp/chevrotain-baseline.tgz -C /tmp/
 *   node benchmark.mjs --lib /tmp/package/lib/chevrotain.mjs
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : defaultVal;
}

const libPath = getArg(
  "--lib",
  new URL("../lib/chevrotain.mjs", import.meta.url).href,
);
const mode = getArg("--mode", "warm"); // "warm" | "cold" | "first-parse" | "construction" | "all"
const selectedParser = getArg("--parser", "all");
const useCst = args.includes("--cst");
const quiet = args.includes("--quiet");
// --no-psa: construct parsers WITHOUT calling performSelfAnalysis().
// Our fork supports this (lazy-build path). v12 requires performSelfAnalysis().
const noPsa = args.includes("--no-psa");
const ITERATIONS = parseInt(getArg("--iterations", "5000"), 10);
const WARMUP = Math.max(100, Math.floor(ITERATIONS * 0.1));

// ---------------------------------------------------------------------------
// Load chevrotain
// ---------------------------------------------------------------------------
const libUrl =
  libPath.startsWith("http") || libPath.startsWith("file:")
    ? libPath
    : pathToFileURL(path.resolve(process.cwd(), libPath)).href;

const chevrotain = await import(libUrl);
const { createToken, Lexer, EmbeddedActionsParser, CstParser } = chevrotain;
const ParserBase = useCst ? CstParser : EmbeddedActionsParser;
const parserConfig = useCst ? {} : { outputCst: false };

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------
function makeJsonParser() {
  const True = createToken({ name: "True", pattern: "true" });
  const False = createToken({ name: "False", pattern: "false" });
  const Null = createToken({ name: "Null", pattern: "null" });
  const LCurly = createToken({ name: "LCurly", pattern: "{" });
  const RCurly = createToken({ name: "RCurly", pattern: "}" });
  const LSquare = createToken({ name: "LSquare", pattern: "[" });
  const RSquare = createToken({ name: "RSquare", pattern: "]" });
  const Comma = createToken({ name: "Comma", pattern: "," });
  const Colon = createToken({ name: "Colon", pattern: ":" });
  const StringLiteral = createToken({
    name: "StringLiteral",
    pattern: /"(?:[^\\"]|\\(?:[bfnrtv"\\/]|u[0-9a-fA-F]{4}))*"/,
  });
  const NumberLiteral = createToken({
    name: "NumberLiteral",
    pattern: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
  });
  const WhiteSpace = createToken({
    name: "WhiteSpace",
    pattern: /[ \n\r\t]+/,
    group: Lexer.SKIPPED,
  });

  const jsonTokens = [
    WhiteSpace,
    StringLiteral,
    NumberLiteral,
    Comma,
    Colon,
    LCurly,
    RCurly,
    LSquare,
    RSquare,
    True,
    False,
    Null,
  ];

  const lexer = new Lexer(jsonTokens, { positionTracking: "onlyOffset" });

  class JsonParser extends ParserBase {
    constructor() {
      super(jsonTokens, parserConfig);

      const $ = this;

      $.RULE("json", () => {
        $.OR([
          { ALT: () => $.SUBRULE($.object) },
          { ALT: () => $.SUBRULE($.array) },
        ]);
      });

      $.RULE("object", () => {
        $.CONSUME(LCurly);
        $.OPTION(() => {
          $.SUBRULE($.objectItem);
          $.MANY(() => {
            $.CONSUME(Comma);
            $.SUBRULE2($.objectItem);
          });
        });
        $.CONSUME(RCurly);
      });

      $.RULE("objectItem", () => {
        $.CONSUME(StringLiteral);
        $.CONSUME(Colon);
        $.SUBRULE($.value);
      });

      $.RULE("array", () => {
        $.CONSUME(LSquare);
        $.OPTION(() => {
          $.SUBRULE($.value);
          $.MANY(() => {
            $.CONSUME(Comma);
            $.SUBRULE2($.value);
          });
        });
        $.CONSUME(RSquare);
      });

      $.RULE("value", () => {
        $.OR(
          ($.c1 ??= [
            { ALT: () => $.CONSUME(StringLiteral) },
            { ALT: () => $.CONSUME(NumberLiteral) },
            { ALT: () => $.SUBRULE($.object) },
            { ALT: () => $.SUBRULE($.array) },
            { ALT: () => $.CONSUME(True) },
            { ALT: () => $.CONSUME(False) },
            { ALT: () => $.CONSUME(Null) },
          ]),
        );
      });

      if (!noPsa) this.performSelfAnalysis();
    }
  }

  const parser = new JsonParser();

  // ~40 KB of JSON (1000 records)
  const sample = JSON.stringify(
    Array.from({ length: 50 }, (_, i) => ({
      _id: `id${i}`,
      index: i,
      guid: `xxxxxxxx-${i}`,
      isActive: i % 2 === 0,
      balance: `$${(1000 + i * 13.37).toFixed(2)}`,
      name: `Person ${i}`,
      tags: [`tag${i % 5}`, `tag${(i + 1) % 5}`, `tag${(i + 2) % 5}`],
      address: `${i * 100} Main St`,
      about: `This is a somewhat longer description field for person ${i}.`,
    })),
  );

  return {
    name: "JSON",
    run() {
      const { tokens } = lexer.tokenize(sample);
      parser.input = tokens;
      parser.json();
    },
  };
}

// ---------------------------------------------------------------------------
// CSS parser
// ---------------------------------------------------------------------------
function makeCssParser() {
  const Identifier = createToken({
    name: "Identifier",
    pattern: /[a-zA-Z]\w*/,
  });
  const Dot = createToken({ name: "Dot", pattern: "." });
  const Hash = createToken({ name: "Hash", pattern: "#" });
  const Colon = createToken({ name: "Colon", pattern: ":" });
  const Semicolon = createToken({ name: "Semicolon", pattern: ";" });
  const LCurly = createToken({ name: "LCurly", pattern: "{" });
  const RCurly = createToken({ name: "RCurly", pattern: "}" });
  const LParen = createToken({ name: "LParen", pattern: "(" });
  const RParen = createToken({ name: "RParen", pattern: ")" });
  const Comma = createToken({ name: "Comma", pattern: "," });
  const Star = createToken({ name: "Star", pattern: "*" });
  const At = createToken({ name: "At", pattern: "@" });
  const StringLiteral = createToken({
    name: "StringLiteral",
    pattern: /"[^"]*"|'[^']*'/,
  });
  const NumberLiteral = createToken({
    name: "NumberLiteral",
    pattern: /\d+(\.\d+)?(px|em|rem|%|vh|vw|pt)?/,
  });
  const WhiteSpace = createToken({
    name: "WhiteSpace",
    pattern: /[ \t\n\r]+/,
    group: Lexer.SKIPPED,
  });
  const Comment = createToken({
    name: "Comment",
    pattern: /\/\*[^*]*\*+([^/*][^*]*\*+)*\//,
    group: Lexer.SKIPPED,
  });
  const Other = createToken({ name: "Other", pattern: /[^\s{}();:,.#*@"']+/ });

  const cssTokens = [
    WhiteSpace,
    Comment,
    StringLiteral,
    NumberLiteral,
    Identifier,
    LCurly,
    RCurly,
    LParen,
    RParen,
    Semicolon,
    Colon,
    Comma,
    Dot,
    Hash,
    Star,
    At,
    Other,
  ];

  const lexer = new Lexer(cssTokens, { positionTracking: "onlyOffset" });

  class CssParser extends ParserBase {
    constructor() {
      super(cssTokens, parserConfig);
      const $ = this;

      $.RULE("stylesheet", () => {
        $.MANY(() => $.SUBRULE($.rule));
      });

      $.RULE("rule", () => {
        $.SUBRULE($.selector);
        $.CONSUME(LCurly);
        $.MANY(() => $.SUBRULE($.declaration));
        $.CONSUME(RCurly);
      });

      $.RULE("selector", () => {
        $.SUBRULE($.selectorPart);
        $.MANY(() => {
          $.OPTION(() => $.CONSUME(Comma));
          $.SUBRULE2($.selectorPart);
        });
      });

      $.RULE("selectorPart", () => {
        $.AT_LEAST_ONE(() => {
          $.OR([
            { ALT: () => $.CONSUME(Identifier) },
            { ALT: () => $.CONSUME(Dot) },
            { ALT: () => $.CONSUME(Hash) },
            { ALT: () => $.CONSUME(Star) },
            {
              ALT: () => {
                $.CONSUME(Colon);
                $.CONSUME2(Identifier);
              },
            },
          ]);
        });
      });

      $.RULE("declaration", () => {
        $.CONSUME(Identifier);
        $.CONSUME(Colon);
        $.SUBRULE($.value);
        $.OPTION(() => $.CONSUME(Semicolon));
      });

      $.RULE("value", () => {
        $.AT_LEAST_ONE(() => {
          $.OR([
            { ALT: () => $.CONSUME(Identifier) },
            { ALT: () => $.CONSUME(NumberLiteral) },
            { ALT: () => $.CONSUME(StringLiteral) },
            {
              ALT: () => {
                $.CONSUME(LParen);
                $.SUBRULE($.value);
                $.CONSUME(RParen);
              },
            },
            { ALT: () => $.CONSUME(Other) },
          ]);
        });
      });

      if (!noPsa) this.performSelfAnalysis();
    }
  }

  const parser = new CssParser();

  const sample = Array.from(
    { length: 100 },
    (_, i) => `
.class${i} {
  color: red;
  font-size: 14px;
  margin: 0;
  padding: 8px 16px;
  background-color: white;
  border: 1px solid #ccc;
  display: flex;
  align-items: center;
}
.class${i}:hover {
  color: blue;
  background-color: #f5f5f5;
}
`,
  ).join("\n");

  return {
    name: "CSS",
    run() {
      const { tokens } = lexer.tokenize(sample);
      parser.input = tokens;
      parser.stylesheet();
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------
const REPS = 50; // repetitions for construction/cold timing

function timeMs(fn, reps = REPS) {
  fn(); // throwaway: ensure module cached
  const start = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - start) / reps;
}

function bench(name, fn) {
  // Warmup: give V8 time to JIT-compile all paths before measuring.
  for (let i = 0; i < WARMUP; i++) fn();
  // Collect SAMPLES timed windows and take the median to suppress outliers
  // caused by GC pauses, OS scheduling jitter, and CPU frequency scaling.
  const SAMPLES = 7;
  const SAMPLE_ITERS = Math.ceil(ITERATIONS / SAMPLES);
  const rates = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = performance.now();
    for (let i = 0; i < SAMPLE_ITERS; i++) fn();
    rates.push((SAMPLE_ITERS / (performance.now() - start)) * 1000);
  }
  rates.sort((a, b) => a - b);
  const median = rates[Math.floor(SAMPLES / 2)];
  const opsPerSec = Math.round(median);
  const msPerOp = (1000 / median).toFixed(3);
  console.log(
    `  ${name.padEnd(8)} ${opsPerSec.toLocaleString().padStart(10)} ops/sec   (${msPerOp} ms/op)`,
  );
  return opsPerSec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const factories = [];
if (selectedParser === "all" || selectedParser === "json")
  factories.push({ name: "JSON", make: makeJsonParser });
if (selectedParser === "all" || selectedParser === "css")
  factories.push({ name: "CSS", make: makeCssParser });

if (!quiet) {
  console.log(`\nChevrotain parser benchmark`);
  console.log(`  lib:        ${libUrl}`);
  console.log(
    `  parser type: ${useCst ? "CstParser" : "EmbeddedActionsParser"}`,
  );
  console.log(`  mode:       ${mode}`);
  console.log(
    `  iterations: ${ITERATIONS.toLocaleString()} (+ ${WARMUP.toLocaleString()} warmup)`,
  );
  console.log(`  parsers:    ${factories.map((f) => f.name).join(", ")}`);
  console.log(`  psa:        ${noPsa ? "SKIP (lazy-build path)" : "yes"}\n`);
}

// ---------------------------------------------------------------------------
// "all" mode: spawn a fresh V8 process for each phase so JIT profiles from
// construction-heavy phases don't pollute the warm steady-state measurement.
// ---------------------------------------------------------------------------
if (mode === "all") {
  const { execFileSync } = await import("node:child_process");
  const selfPath = new URL(import.meta.url).pathname;
  // Forward CLI args, replacing --mode all with each specific mode.
  const baseArgs = process.argv
    .slice(2)
    .filter((a, i, arr) => a !== "--mode" && arr[i - 1] !== "--mode");
  for (const phase of ["construction", "cold", "first-parse", "warm"]) {
    const childArgs = [selfPath, "--mode", phase, ...baseArgs, "--quiet"];
    try {
      const output = execFileSync(process.execPath, childArgs, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      // Print only non-empty lines from the child.
      for (const l of output.split("\n")) {
        if (l.trim()) console.log(l);
      }
    } catch (e) {
      console.error(`Phase "${phase}" failed:`, e.message);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// "compare" mode: run all phases for v12, our+psa, our-psa side-by-side.
//
// Usage:
//   node benchmark.mjs --mode compare --v12 /tmp/chevrotain-v12/package/lib/chevrotain.mjs
// ---------------------------------------------------------------------------
if (mode === "compare") {
  const { execFileSync } = await import("node:child_process");
  const selfPath = new URL(import.meta.url).pathname;
  const ourLib = new URL("../lib/chevrotain.mjs", import.meta.url).href;
  const v12Lib = getArg(
    "--v12",
    "/tmp/chevrotain-v12/package/lib/chevrotain.mjs",
  );

  function runPhase(phase, extraArgs) {
    const childArgs = [
      "--expose-gc",
      selfPath,
      "--mode",
      phase,
      "--json",
      "--quiet",
      ...extraArgs,
    ];
    try {
      const out = execFileSync(process.execPath, childArgs, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      // Find the JSON line (last non-empty line in case of warnings)
      const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
      return null;
    }
  }

  const phases = ["construction", "cold", "first-parse", "warm"];
  const configs = [
    { label: "v12 + psa", args: ["--lib", v12Lib] },
    { label: "ours + psa", args: ["--lib", ourLib] },
    { label: "ours - psa", args: ["--lib", ourLib, "--no-psa"] },
  ];

  // Collect results: results[phase][configLabel][parserName] = value
  const results = {};
  const parserNames = ["JSON", "CSS"];
  for (const phase of phases) {
    results[phase] = {};
    process.stderr.write(`  running ${phase}...`);
    for (const cfg of configs) {
      const data = runPhase(phase, cfg.args);
      results[phase][cfg.label] = data;
    }
    process.stderr.write(" done\n");
  }

  // Print table
  const isWarm = (phase) => phase === "warm";
  const fmt = (phase, val) =>
    val == null
      ? "  ERROR  "
      : isWarm(phase)
        ? `${Math.round(val).toLocaleString().padStart(8)}/s`
        : `${val.toFixed(2).padStart(7)} ms`;

  const ratio = (phase, ourVal, v12Val) => {
    if (ourVal == null || v12Val == null) return "";
    const r = isWarm(phase) ? ourVal / v12Val : v12Val / ourVal;
    return `(${(r * 100).toFixed(0)}%)`;
  };

  console.log(
    "\n╔══════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║             Chevrotain benchmark: ours vs v12                    ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════════╣",
  );

  for (const parser of parserNames) {
    console.log(
      `║  ${parser}                                                               ║`.slice(
        0,
        69,
      ) + "║",
    );
    console.log(
      `║  Phase          v12 + psa    ours + psa    ours - psa           ║`,
    );
    console.log(
      `║  ─────────────────────────────────────────────────────────────  ║`,
    );
    for (const phase of phases) {
      const v12Val = results[phase][configs[0].label]?.[parser];
      const psaVal = results[phase][configs[1].label]?.[parser];
      const nopsaVal = results[phase][configs[2].label]?.[parser];
      const r1 = ratio(phase, psaVal, v12Val);
      const r2 = ratio(phase, nopsaVal, v12Val);
      const phasePad = phase.padEnd(13);
      console.log(
        `║  ${phasePad}  ${fmt(phase, v12Val)}  ${fmt(phase, psaVal)} ${r1.padEnd(6)}  ${fmt(phase, nopsaVal)} ${r2.padEnd(6)}  ║`,
      );
    }
    if (parser !== parserNames[parserNames.length - 1]) {
      console.log(
        "╠══════════════════════════════════════════════════════════════════╣",
      );
    }
  }
  console.log(
    "╚══════════════════════════════════════════════════════════════════╝",
  );
  console.log(
    "  ratios: higher = better for warm (ops/s), lower = better for ms phases",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Single-phase modes: each runs in its own V8 process (clean JIT state).
// ---------------------------------------------------------------------------
const jsonOutput = args.includes("--json");

if (mode === "construction") {
  const results = {};
  for (const f of factories) {
    results[f.name] = parseFloat(timeMs(() => f.make(), REPS).toFixed(2));
  }
  if (jsonOutput) {
    console.log(JSON.stringify(results));
  } else {
    console.log(`Construction only (${REPS} reps each):`);
    for (const [k, v] of Object.entries(results))
      console.log(`  ${k.padEnd(8)} ${v.toFixed(2)} ms`);
  }
}

if (mode === "cold") {
  const results = {};
  for (const f of factories) {
    results[f.name] = parseFloat(
      timeMs(() => {
        const p = f.make();
        p.run();
      }, REPS).toFixed(2),
    );
  }
  if (jsonOutput) {
    console.log(JSON.stringify(results));
  } else {
    console.log(`Cold (construction + first parse, ${REPS} reps):`);
    for (const [k, v] of Object.entries(results))
      console.log(`  ${k.padEnd(8)} ${v.toFixed(2)} ms`);
  }
}

if (mode === "first-parse") {
  const results = {};
  for (const f of factories) {
    const ms =
      timeMs(() => {
        const p = f.make();
        p.run();
      }, REPS) - timeMs(() => f.make(), REPS);
    results[f.name] = parseFloat(ms.toFixed(3));
  }
  if (jsonOutput) {
    console.log(JSON.stringify(results));
  } else {
    console.log(`First parse only (post-construction, ${REPS} reps):`);
    for (const [k, v] of Object.entries(results))
      console.log(`  ${k.padEnd(8)} ${v.toFixed(3)} ms`);
  }
}

if (mode === "warm") {
  const results = {};
  for (const f of factories) {
    const p = f.make();
    results[f.name] = bench(f.name, () => p.run());
  }
  if (jsonOutput && quiet) {
    console.log(JSON.stringify(results));
  }
}
