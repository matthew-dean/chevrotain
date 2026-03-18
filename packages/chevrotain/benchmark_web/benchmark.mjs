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

      this.performSelfAnalysis();
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

      this.performSelfAnalysis();
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
  for (let i = 0; i < WARMUP; i++) fn();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((ITERATIONS / elapsed) * 1000);
  const msPerOp = (elapsed / ITERATIONS).toFixed(3);
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

console.log(`\nChevrotain parser benchmark`);
console.log(`  lib:        ${libUrl}`);
console.log(`  parser type: ${useCst ? "CstParser" : "EmbeddedActionsParser"}`);
console.log(`  mode:       ${mode}`);
console.log(
  `  iterations: ${ITERATIONS.toLocaleString()} (+ ${WARMUP.toLocaleString()} warmup)`,
);
console.log(`  parsers:    ${factories.map((f) => f.name).join(", ")}\n`);

// Each mode runs in its own Node process (via --mode flag) to prevent JIT
// profile pollution between construction-heavy (cold) and parse-heavy (warm) runs.
// The "all" mode shows all phases for a quick overview.

if (mode === "construction" || mode === "all") {
  // Time only parser construction (performSelfAnalysis included).
  // Our engine skips lookahead precomputation; baseline pays that cost here.
  console.log(`Construction only (${REPS} reps each):`);
  for (const f of factories) {
    const ms = timeMs(() => f.make(), REPS);
    console.log(`  ${f.name.padEnd(8)} ${ms.toFixed(2)} ms`);
  }
  console.log();
}

if (mode === "cold" || mode === "all") {
  // Time construction + first parse (JIT-cold body).
  // Fair comparison: a user who creates a parser and immediately parses once.
  console.log(`Cold (construction + first parse, ${REPS} reps):`);
  for (const f of factories) {
    const ms = timeMs(() => {
      const p = f.make();
      p.run();
    }, REPS);
    console.log(`  ${f.name.padEnd(8)} ${ms.toFixed(2)} ms`);
  }
  console.log();
}

if (mode === "first-parse" || mode === "all") {
  // Time only the first parse after construction (JIT-cold parse body).
  // Isolates parse cost from construction cost — our engine pays zero
  // lookahead-precomputation overhead here; baseline already paid it during construction.
  console.log(`First parse only (post-construction, ${REPS} reps):`);
  for (const f of factories) {
    const ms =
      timeMs(() => {
        const p = f.make();
        p.run();
      }, REPS) - timeMs(() => f.make(), REPS);
    console.log(`  ${f.name.padEnd(8)} ${ms.toFixed(3)} ms`);
  }
  console.log();
}

if (mode === "warm" || mode === "all") {
  // Steady-state throughput. Parser constructed once, then run ITERATIONS times.
  // JIT-warm via the WARMUP phase in bench().
  console.log("Warm (steady-state throughput):");
  for (const f of factories) {
    const p = f.make();
    bench(f.name, () => p.run());
  }
  console.log();
}
