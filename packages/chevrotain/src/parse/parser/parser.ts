import { timer, toFastProperties } from "@chevrotain/utils";
import { computeAllProdsFollows } from "../grammar/follow.js";
import {
  addNoneTerminalToCst,
  addTerminalToCst,
  setNodeLocationFull,
  setNodeLocationOnlyOffset,
} from "../cst/cst.js";
import {
  createBaseSemanticVisitorConstructor,
  createBaseVisitorConstructorWithDefaults,
} from "../cst/cst_visitor.js";
import {
  createToken,
  createTokenInstance,
  EOF,
} from "../../scan/tokens_public.js";
import {
  defaultGrammarValidatorErrorProvider,
  defaultParserErrorProvider,
} from "../errors_public.js";
import {
  EarlyExitException,
  isRecognitionException,
  MismatchedTokenException,
  NoViableAltException,
  NotAllInputParsedException,
} from "../exceptions_public.js";
import {
  getLookaheadPathsForOptionalProd,
  getLookaheadPathsForOr,
  PROD_TYPE,
} from "../grammar/lookahead.js";
import {
  resolveGrammar,
  validateGrammar,
} from "../grammar/gast/gast_resolver_public.js";
import {
  AtLeastOneSepMethodOpts,
  ConsumeMethodOpts,
  CstNode,
  CstNodeLocation,
  DSLMethodOpts,
  DSLMethodOptsWithErr,
  GrammarAction,
  IOrAlt,
  IParserConfig,
  IParserErrorMessageProvider,
  IProduction,
  ICstVisitor,
  IRecognitionException,
  IRuleConfig,
  ISerializedGast,
  IToken,
  ITokenGrammarPath,
  ManySepMethodOpts,
  nodeLocationTrackingOptions,
  OrMethodOpts,
  ParserMethod,
  SubruleMethodOpts,
  TokenType,
  TokenTypeDictionary,
  TokenVocabulary,
} from "@chevrotain/types";
import {
  AbstractNextTerminalAfterProductionWalker,
  IFirstAfterRepetition,
  NextAfterTokenWalker,
  NextTerminalAfterAtLeastOneSepWalker,
  NextTerminalAfterAtLeastOneWalker,
  NextTerminalAfterManySepWalker,
  NextTerminalAfterManyWalker,
} from "../grammar/interpreter.js";
import { IN } from "../constants.js";
import { ILookaheadStrategy } from "@chevrotain/types";
import { LLkLookaheadStrategy } from "../grammar/llk_lookahead.js";
// TreeBuilder absorbed into Parser (Stage 7)
// LexerAdapter absorbed into Parser (Stage 7)
// RecognizerApi absorbed into Parser (Stage 7)
// RecognizerEngine absorbed into Parser (Stage 7)

// ErrorHandler absorbed into Parser (Stage 7)
import { MixedInParser } from "./traits/parser_traits.js";
// GastRecorder absorbed into Parser (Stage 7)
import { applyMixins } from "./utils/apply_mixins.js";
import { IParserDefinitionError } from "../grammar/types.js";
import {
  Alternation,
  Alternative,
  NonTerminal,
  Option,
  Repetition,
  RepetitionMandatory,
  RepetitionMandatoryWithSeparator,
  RepetitionWithSeparator,
  Rule,
  serializeGrammar,
  Terminal,
} from "@chevrotain/gast";
import { Lexer } from "../../scan/lexer_public.js";
import {
  augmentTokenTypes,
  hasShortKeyProperty,
  isTokenType,
  tokenStructuredMatcher,
  tokenStructuredMatcherNoCategories,
} from "../../scan/tokens.js";
import { IParserConfigInternal, ParserMethodInternal } from "./types.js";
import {
  AT_LEAST_ONE_IDX,
  AT_LEAST_ONE_SEP_IDX,
  BITS_FOR_METHOD_TYPE,
  BITS_FOR_OCCURRENCE_IDX,
  getKeyForAutomaticLookahead,
  MANY_IDX,
  MANY_SEP_IDX,
} from "../grammar/keys.js";
import {
  validateLookahead,
  validateRuleIsOverridden,
} from "../grammar/checks.js";

export const END_OF_FILE = createTokenInstance(
  EOF,
  "",
  NaN,
  NaN,
  NaN,
  NaN,
  NaN,
  NaN,
);
Object.freeze(END_OF_FILE);

export type TokenMatcher = (token: IToken, tokType: TokenType) => boolean;

export const DEFAULT_PARSER_CONFIG: Required<
  Omit<IParserConfigInternal, "lookaheadStrategy">
> = Object.freeze({
  recoveryEnabled: false,
  maxLookahead: 3,
  dynamicTokensEnabled: false,
  outputCst: true,
  errorMessageProvider: defaultParserErrorProvider,
  nodeLocationTracking: "none",
  traceInitPerf: false,
  skipValidations: false,
});

export const DEFAULT_RULE_CONFIG: Required<IRuleConfig<any>> = Object.freeze({
  recoveryValueFunc: () => undefined,
  resyncEnabled: true,
});

export enum ParserDefinitionErrorType {
  INVALID_RULE_NAME = 0,
  DUPLICATE_RULE_NAME = 1,
  INVALID_RULE_OVERRIDE = 2,
  DUPLICATE_PRODUCTIONS = 3,
  UNRESOLVED_SUBRULE_REF = 4,
  LEFT_RECURSION = 5,
  NONE_LAST_EMPTY_ALT = 6,
  AMBIGUOUS_ALTS = 7,
  CONFLICT_TOKENS_RULES_NAMESPACE = 8,
  INVALID_TOKEN_NAME = 9,
  NO_NON_EMPTY_LOOKAHEAD = 10,
  AMBIGUOUS_PREFIX_ALTS = 11,
  TOO_MANY_ALTS = 12,
  CUSTOM_LOOKAHEAD_VALIDATION = 13,
}

export interface IParserDuplicatesDefinitionError extends IParserDefinitionError {
  dslName: string;
  occurrence: number;
  parameter?: string;
}

export interface IParserEmptyAlternativeDefinitionError extends IParserDefinitionError {
  occurrence: number;
  alternative: number;
}

export interface IParserAmbiguousAlternativesDefinitionError extends IParserDefinitionError {
  occurrence: number | string;
  alternatives: number[];
}

export interface IParserUnresolvedRefDefinitionError extends IParserDefinitionError {
  unresolvedRefName: string;
}

export interface IParserState {
  errors: IRecognitionException[];
  lexerState: any;
  RULE_STACK: number[];
  CST_STACK: CstNode[];
}

/**
 * Lightweight snapshot used by saveRecogState/reloadRecogState.
 * Three integers instead of array clones — V8 can scalar-replace this
 * entirely in a hot BACKTRACK() loop.
 */
export interface IParserSavepoint {
  pos: number;
  errorsLength: number;
  ruleStackDepth: number;
}

export type Predicate = () => boolean;

export function EMPTY_ALT(): () => undefined;
export function EMPTY_ALT<T>(value: T): () => T;
export function EMPTY_ALT(value: any = undefined) {
  return function () {
    return value;
  };
}

// --- Recoverable module-level constants (absorbed from trait) ---

export const EOF_FOLLOW_KEY: any = {};

export interface IFollowKey {
  ruleName: string;
  idxInCallingRule: number;
  inRule: string;
}

export const IN_RULE_RECOVERY_EXCEPTION = "InRuleRecoveryException";

export class InRuleRecoveryException extends Error {
  constructor(message: string) {
    super(message);
    this.name = IN_RULE_RECOVERY_EXCEPTION;
  }
}

export function attemptInRepetitionRecovery(
  this: MixedInParser,
  prodFunc: Function,
  args: any[],
  lookaheadFunc: () => boolean,
  dslMethodIdx: number,
  prodOccurrence: number,
  nextToksWalker: typeof AbstractNextTerminalAfterProductionWalker,
  notStuck?: boolean,
): void {
  const key = getKeyForAutomaticLookahead(
    this.currRuleShortName,
    dslMethodIdx,
    prodOccurrence,
  );
  let firstAfterRepInfo = this.firstAfterRepMap[key];
  if (firstAfterRepInfo === undefined) {
    const currRuleName = this.getCurrRuleFullName();
    const ruleGrammar = this.getGAstProductions()[currRuleName];
    const walker: AbstractNextTerminalAfterProductionWalker =
      new nextToksWalker(ruleGrammar, prodOccurrence);
    firstAfterRepInfo = walker.startWalking();
    this.firstAfterRepMap[key] = firstAfterRepInfo;
  }

  let expectTokAfterLastMatch = firstAfterRepInfo.token;
  let nextTokIdx = firstAfterRepInfo.occurrence;
  const isEndOfRule = firstAfterRepInfo.isEndOfRule;

  // special edge case of a TOP most repetition after which the input should END.
  // this will force an attempt for inRule recovery in that scenario.
  if (
    this.RULE_STACK_IDX === 0 &&
    isEndOfRule &&
    expectTokAfterLastMatch === undefined
  ) {
    expectTokAfterLastMatch = EOF;
    nextTokIdx = 1;
  }

  // We don't have anything to re-sync to...
  // this condition was extracted from `shouldInRepetitionRecoveryBeTried` to act as a type-guard
  if (expectTokAfterLastMatch === undefined || nextTokIdx === undefined) {
    return;
  }

  if (
    this.shouldInRepetitionRecoveryBeTried(
      expectTokAfterLastMatch,
      nextTokIdx,
      notStuck,
    )
  ) {
    // TODO: performance optimization: instead of passing the original args here, we modify
    // the args param (or create a new one) and make sure the lookahead func is explicitly provided
    // to avoid searching the cache for it once more.
    this.tryInRepetitionRecovery(
      prodFunc,
      args,
      lookaheadFunc,
      expectTokAfterLastMatch,
    );
  }
}

// --- RecognizerEngine module-level constants (absorbed from trait) ---

/**
 * Thrown instead of MismatchedTokenException during speculative parsing
 * (IS_SPECULATING === true). A Symbol throw has zero allocation cost — V8
 * never calls Error.captureStackTrace for non-Error throws, so every failed
 * BACKTRACK() alternative costs nothing in GC pressure.
 */
export const SPEC_FAIL = Symbol("SPEC_FAIL");

// Entries >= GATED_OFFSET encode "altIdx + GATED_OFFSET" meaning the alt is
// correct but preceding gated alts must be checked first. Decoding is just
// `entry - GATED_OFFSET`. For gate-free grammars all entries are 0-255 so
// the check `>= GATED_OFFSET` is a single integer comparison — zero cost.
export const GATED_OFFSET = 256;

/**
 * Records that `altIdx` matched when LA(1) had `tokenTypeIdx`. When a
 * preceding alt has a GATE, stores `altIdx + GATED_OFFSET` so the fast
 * path knows to check gates adaptively. True ambiguity (two non-gated
 * alts) is marked as -1.
 */
function addOrFastMapEntry(
  orFastMaps: Record<number, Record<number, number>>,
  mapKey: number,
  tokenTypeIdx: number,
  altIdx: number,
  alts: IOrAlt<any>[],
): void {
  let map = orFastMaps[mapKey];
  if (map === undefined) {
    map = Object.create(null);
    orFastMaps[mapKey] = map;
  }
  // Check if any preceding alt has a GATE.
  let hasGatedPredecessor = false;
  for (let g = 0; g < altIdx; g++) {
    if (alts[g].GATE !== undefined) {
      hasGatedPredecessor = true;
      break;
    }
  }
  const encodedAlt = hasGatedPredecessor ? altIdx + GATED_OFFSET : altIdx;
  const existing = map[tokenTypeIdx];
  if (existing === undefined) {
    map[tokenTypeIdx] = encodedAlt;
  } else if (existing >= 0) {
    const existingAlt =
      existing >= GATED_OFFSET ? existing - GATED_OFFSET : existing;
    if (existingAlt !== altIdx) {
      const existingGated = alts[existingAlt].GATE !== undefined;
      const newGated = alts[altIdx].GATE !== undefined;
      if (existingGated && !newGated) {
        map[tokenTypeIdx] = encodedAlt;
      } else if (!existingGated && newGated) {
        // keep existing non-gated, but mark gated if new has predecessor
        if (hasGatedPredecessor && existing < GATED_OFFSET) {
          map[tokenTypeIdx] = existing + GATED_OFFSET;
        }
      } else if (!existingGated && !newGated) {
        map[tokenTypeIdx] = -1; // true ambiguity
      }
    }
  }
}

/**
 * Thrown by `consumeInternal` when `_earlyExitLookahead` is true and a token
 * successfully matches. This aborts the action immediately after the first
 * successful CONSUME, preventing embedded-action side effects from executing
 * inside `makeSpecLookahead`. The caller catches this and returns `true`.
 */
const FIRST_TOKEN_MATCH = Symbol("FIRST_TOKEN_MATCH");

// --- GastRecorder module-level constants (absorbed from trait) ---
type ProdWithDef = IProduction & { definition?: IProduction[] };
const RECORDING_NULL_OBJECT = {
  description: "This Object indicates the Parser is during Recording Phase",
};
Object.freeze(RECORDING_NULL_OBJECT);

const HANDLE_SEPARATOR = true;
const MAX_METHOD_IDX = Math.pow(2, BITS_FOR_OCCURRENCE_IDX) - 1;

const RFT = createToken({ name: "RECORDING_PHASE_TOKEN", pattern: Lexer.NA });
augmentTokenTypes([RFT]);
const RECORDING_PHASE_TOKEN = createTokenInstance(
  RFT,
  "This IToken indicates the Parser is in Recording Phase\n\t" +
    "See: https://chevrotain.io/docs/guide/internals.html#grammar-recording for details",
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
);
Object.freeze(RECORDING_PHASE_TOKEN);

const RECORDING_PHASE_CSTNODE: CstNode = {
  name:
    "This CSTNode indicates the Parser is in Recording Phase\n\t" +
    "See: https://chevrotain.io/docs/guide/internals.html#grammar-recording for details",
  children: {},
};

// --- TreeBuilder module-level helpers (absorbed from trait) ---

/**
 * Fixed-shape CstNode factory. Pre-declaring all fields — including the
 * optional `recoveredNode` and `location` — ensures every CstNode object
 * shares a single V8 hidden class from birth, keeping call sites that read
 * these fields monomorphic.
 */
function createCstNode(name: string): CstNode {
  return {
    name,
    children: Object.create(null),
    location: undefined,
  } as unknown as CstNode;
}

function createCstLocationOnlyOffset(): CstNodeLocation {
  return { startOffset: NaN, endOffset: NaN } as CstNodeLocation;
}

function createCstLocationFull(): CstNodeLocation {
  return {
    startOffset: NaN,
    startLine: NaN,
    startColumn: NaN,
    endOffset: NaN,
    endLine: NaN,
    endColumn: NaN,
  };
}

/**
 * Watermark snapshot of a CST node's mutable state taken before a
 * non-speculative parse attempt that may fail (OPTION, AT_LEAST_ONE, OR
 * committed fast-path). Stores each existing child array's length so that
 * restoreCstTop() can truncate — no .slice() copies, no new objects.
 */
export interface CstTopSave {
  keys: string[];
  lens: number[];
  location: Record<string, number> | undefined;
}

export class Parser {
  // Set this flag to true if you don't want the Parser to throw error when problems in it's definition are detected.
  // (normally during the parser's constructor).
  // This is a design time flag, it will not affect the runtime error handling of the parser, just design time errors,
  // for example: duplicate rule names, referencing an unresolved subrule, etc...
  // This flag should not be enabled during normal usage, it is used in special situations, for example when
  // needing to display the parser definition errors in some GUI(online playground).
  static DEFER_DEFINITION_ERRORS_HANDLING: boolean = false;

  /**
   *  @deprecated use the **instance** method with the same name instead
   */
  static performSelfAnalysis(parserInstance: Parser): void {
    throw Error(
      "The **static** `performSelfAnalysis` method has been deprecated." +
        "\t\nUse the **instance** method with the same name instead.",
    );
  }

  public performSelfAnalysis(this: MixedInParser): void {
    this.TRACE_INIT("performSelfAnalysis", () => {
      let defErrorsMsgs;

      this.selfAnalysisDone = true;
      const className = this.className;

      this.TRACE_INIT("toFastProps", () => {
        // Without this voodoo magic the parser would be x3-x4 slower
        // It seems it is better to invoke `toFastProperties` **before**
        // Any manipulations of the `this` object done during the recording phase.
        toFastProperties(this);
      });

      this.TRACE_INIT("Grammar Recording", () => {
        try {
          this.enableRecording();
          // Building the GAST
          this.definedRulesNames.forEach((currRuleName: string) => {
            const wrappedRule = (this as any)[
              currRuleName
            ] as ParserMethodInternal<unknown[], unknown>;
            const originalGrammarAction = wrappedRule["originalGrammarAction"];
            let recordedRuleGast!: Rule;
            this.TRACE_INIT(`${currRuleName} Rule`, () => {
              recordedRuleGast = this.topLevelRuleRecord(
                currRuleName,
                originalGrammarAction,
              );
            });
            this.gastProductionsCache[currRuleName] = recordedRuleGast;
          });
        } finally {
          this.disableRecording();
        }
      });

      let resolverErrors: IParserDefinitionError[] = [];
      this.TRACE_INIT("Grammar Resolving", () => {
        resolverErrors = resolveGrammar({
          rules: Object.values(this.gastProductionsCache),
        });
        this.definitionErrors = this.definitionErrors.concat(resolverErrors);
      });

      this.TRACE_INIT("Grammar Validations", () => {
        // only perform additional grammar validations IFF no resolving errors have occurred.
        // as unresolved grammar may lead to unhandled runtime exceptions in the follow up validations.
        if (resolverErrors.length === 0 && this.skipValidations === false) {
          const validationErrors = validateGrammar({
            rules: Object.values(this.gastProductionsCache),
            tokenTypes: Object.values(this.tokensMap),
            errMsgProvider: defaultGrammarValidatorErrorProvider,
            grammarName: className,
          });
          this.definitionErrors =
            this.definitionErrors.concat(validationErrors);

          const lookaheadValidationErrors = validateLookahead({
            lookaheadStrategy: this.lookaheadStrategy,
            rules: Object.values(this.gastProductionsCache),
            tokenTypes: Object.values(this.tokensMap),
            grammarName: className,
          });
          this.definitionErrors = this.definitionErrors.concat(
            lookaheadValidationErrors,
          );
        }
      });

      // this analysis may fail if the grammar is not perfectly valid
      if (this.definitionErrors.length === 0) {
        // Follow sets are only needed for resync recovery.
        if (this.recoveryEnabled) {
          this.TRACE_INIT("computeAllProdsFollows", () => {
            const allFollows = computeAllProdsFollows(
              Object.values(this.gastProductionsCache),
            );
            this.resyncFollows = allFollows;
          });
        }
      }

      if (
        !Parser.DEFER_DEFINITION_ERRORS_HANDLING &&
        this.definitionErrors.length !== 0
      ) {
        // Ambiguity errors are non-fatal — the speculative engine handles
        // them at runtime by trying alternatives in declaration order.
        // Ambiguity errors are non-fatal — our speculative engine resolves
        // them at runtime by trying alternatives in declaration order.
        // Other errors (empty non-last alts, infinite loops) are real bugs.
        const fatalErrors = this.definitionErrors.filter(
          (e) =>
            e.type !== ParserDefinitionErrorType.AMBIGUOUS_ALTS &&
            e.type !== ParserDefinitionErrorType.AMBIGUOUS_PREFIX_ALTS,
        );
        if (fatalErrors.length !== 0) {
          defErrorsMsgs = fatalErrors.map((defError) => defError.message);
          throw new Error(
            `Parser Definition Errors detected:\n ${defErrorsMsgs.join(
              "\n-------------------------------\n",
            )}`,
          );
        }
      }
    });
  }

  /**
   * Lazily populates gastProductionsCache when GAST-dependent APIs
   * (getSerializedGastProductions, getGAstProductions) are called without
   * recoveryEnabled. Preserves backward compatibility — these APIs work
   * regardless of recoveryEnabled.
   */
  ensureGastProductionsCachePopulated(this: MixedInParser): void {
    if (Object.keys(this.gastProductionsCache).length > 0) {
      return;
    }
    // Must run before any recording-phase manipulation of `this` —
    // same as performSelfAnalysis(). Without it the parser is 3-4x slower.
    toFastProperties(this);
    try {
      this.enableRecording();
      this.definedRulesNames.forEach((currRuleName: string) => {
        const wrappedRule = (this as any)[currRuleName] as ParserMethodInternal<
          unknown[],
          unknown
        >;
        const originalGrammarAction = wrappedRule["originalGrammarAction"];
        const recordedRuleGast = this.topLevelRuleRecord(
          currRuleName,
          originalGrammarAction,
        );
        this.gastProductionsCache[currRuleName] = recordedRuleGast;
      });
    } finally {
      this.disableRecording();
    }
    const resolverErrors = resolveGrammar({
      rules: Object.values(this.gastProductionsCache),
    });
    this.definitionErrors = this.definitionErrors.concat(resolverErrors);
    if (resolverErrors.length === 0 && this.skipValidations === false) {
      const validationErrors = validateGrammar({
        rules: Object.values(this.gastProductionsCache),
        tokenTypes: Object.values(this.tokensMap),
        errMsgProvider: defaultGrammarValidatorErrorProvider,
        grammarName: this.className,
      });
      this.definitionErrors = this.definitionErrors.concat(validationErrors);
      const lookaheadValidationErrors = validateLookahead({
        lookaheadStrategy: this.lookaheadStrategy,
        rules: Object.values(this.gastProductionsCache),
        tokenTypes: Object.values(this.tokensMap),
        grammarName: this.className,
      });
      this.definitionErrors = this.definitionErrors.concat(
        lookaheadValidationErrors,
      );
    }
    if (
      !Parser.DEFER_DEFINITION_ERRORS_HANDLING &&
      this.definitionErrors.length !== 0
    ) {
      const fatalErrors = this.definitionErrors.filter(
        (e) =>
          e.type !== ParserDefinitionErrorType.AMBIGUOUS_ALTS &&
          e.type !== ParserDefinitionErrorType.AMBIGUOUS_PREFIX_ALTS,
      );
      if (fatalErrors.length !== 0) {
        const defErrorsMsgs = fatalErrors.map((defError) => defError.message);
        throw new Error(
          `Parser Definition Errors detected:\n ${defErrorsMsgs.join(
            "\n-------------------------------\n",
          )}`,
        );
      }
    }
    if (this.definitionErrors.length === 0 && this.recoveryEnabled) {
      const allFollows = computeAllProdsFollows(
        Object.values(this.gastProductionsCache),
      );
      this.resyncFollows = allFollows;
    }
    this.selfAnalysisDone = true;
  }

  definitionErrors: IParserDefinitionError[] = [];
  selfAnalysisDone = false;
  protected skipValidations: boolean;

  // --- RecognizerEngine (absorbed from trait) ---
  /**
   * True while inside a speculative context (BACKTRACK, MANY iteration, OR
   * speculative attempt). When true, CONSUME throws the zero-cost SPEC_FAIL
   * symbol instead of allocating a MismatchedTokenException.
   */
  IS_SPECULATING!: boolean;
  /**
   * True only inside an explicit BACKTRACK() call. Unlike IS_SPECULATING (which
   * is also set by MANY/AT_LEAST_ONE iterations and OR speculative attempts),
   * this flag signals that we must NOT commit to any OR alternative even if it
   * made progress — because we are in a pure trial that must be rolled back.
   */
  _isInTrueBacktrack!: boolean;
  /** Set to true inside makeSpecLookahead to abort on the first successful CONSUME. */
  _earlyExitLookahead!: boolean;
  className!: string;
  RULE_STACK!: number[];
  RULE_OCCURRENCE_STACK!: number[];
  // Depth counters for the pre-allocated state stacks.
  // Using index-based access (arr[++idx] = val / idx--) instead of push/pop
  // avoids method-call overhead on every rule entry/exit.
  RULE_STACK_IDX!: number;
  RULE_OCCURRENCE_STACK_IDX!: number;
  /**
   * Single auto-occurrence counter for ALL DSL methods. Every DSL call
   * (CONSUME, SUBRULE, OR, OPTION, MANY, etc.) increments this counter,
   * giving unique occurrence IDs per call site within a rule. Saved/restored
   * on rule entry/exit. One property access per DSL call — minimal overhead.
   */
  _dslCounter!: number;
  _dslCounterStack!: number[];
  definedRulesNames!: string[];
  tokensMap!: { [fqn: string]: TokenType };
  gastProductionsCache!: Record<string, Rule>;
  shortRuleNameToFull!: Record<string, string>;
  fullRuleNameToShort!: Record<string, number>;
  // The shortName Index must be coded "after" the first 8bits to enable building unique lookahead keys
  ruleShortNameIdx!: number;
  tokenMatcher!: TokenMatcher;
  subruleIdx!: number;
  // Cached value of the current rule's short name to avoid repeated RULE_STACK[length-1] lookups.
  // Updated on rule entry/exit and state reload.
  currRuleShortName!: number;
  /**
   * Lazy LL(1) fast-dispatch map, keyed by `currRuleShortName | occurrence`.
   * Inner key is `tokenTypeIdx` of the LA(1) token → alt index that matched.
   * Built from observations in the slow path. Direct O(1) lookup, no
   * allocation on the hot path.
   *
   * A value of `-1` means ambiguous (multiple alts observed for this
   * tokenTypeIdx) — fall through to the slow path.
   */
  _orFastMaps!: Record<number, Record<number, number>>;
  /**
   * Per-OR set of alt indices whose first-token set is gate-dependent
   * (they have a gated OPTION/MANY/AT_LEAST_ONE before their first CONSUME).
   * Keyed by the same mapKey as _orFastMaps. These alts must always be
   * speculated on the fast path — they cannot be cached by LA(1) alone.
   */
  _orGatedPrefixAlts!: Record<number, number[]>;
  /**
   * Per-OR _dslCounter advance amount. When `_dslCounter` is shared across
   * all DSL methods, each OR alternative may contain a different number of
   * DSL calls. During recording ALL alternatives are walked sequentially, but
   * at runtime only ONE is chosen. To keep `_dslCounter` deterministic (same
   * value regardless of which alt is taken), we record the total counter delta
   * across all alternatives. At runtime, after executing the chosen alt,
   * `_dslCounter` is advanced to `savedCounter + totalDelta` so subsequent
   * DSL calls always receive the same occurrence index.
   * Keyed by the same mapKey (`currRuleShortName | orOccurrence`).
   */
  _orCounterDeltas!: Record<number, number>;
  /**
   * Per-OR per-alt counter starting offsets. During recording, each alt
   * runs sequentially, so alt i starts at `savedCounter + sum(deltas[0..i-1])`.
   * At runtime, before executing alt i, `_dslCounter` is set to
   * `savedCounter + _orAltCounterStarts[mapKey][i]`.
   */
  _orAltCounterStarts!: Record<number, number[]>;
  /**
   * Set during an OR alt's speculative execution. Records the lexer position
   * at the start of the alt so that gated productions (OPTION, MANY, etc.)
   * can detect whether they are executing before the first CONSUME.
   */
  _orAltStartLexPos!: number;
  /**
   * Set to true when a gated production (OPTION/MANY/AT_LEAST_ONE with GATE)
   * is encountered before the first CONSUME in an OR alt. When true, the alt
   * must not be added to the fast-dispatch candidate list because its
   * first-token set depends on gate state.
   */
  _orAltHasGatedPrefix!: boolean;

  initRecognizerEngine(
    this: MixedInParser,
    tokenVocabulary: TokenVocabulary,
    config: IParserConfig,
  ) {
    this.className = this.constructor.name;
    // TODO: would using an ES6 Map or plain object be faster (CST building scenario)
    this.shortRuleNameToFull = {};
    this.fullRuleNameToShort = {};
    this.ruleShortNameIdx = 256;
    this.tokenMatcher = tokenStructuredMatcherNoCategories;
    this.subruleIdx = 0;
    this.currRuleShortName = 0;
    this.IS_SPECULATING = false;
    this._isInTrueBacktrack = false;
    this._earlyExitLookahead = false;
    this._orFastMaps = Object.create(null);
    this._orGatedPrefixAlts = Object.create(null);
    this._orCounterDeltas = Object.create(null);
    this._orAltCounterStarts = Object.create(null);
    this._orAltStartLexPos = 0;
    this._orAltHasGatedPrefix = false;

    this.definedRulesNames = [];
    this.tokensMap = {};
    this.RULE_STACK = [];
    this.RULE_STACK_IDX = -1;
    this.RULE_OCCURRENCE_STACK = [];
    this.RULE_OCCURRENCE_STACK_IDX = -1;
    this._dslCounter = 0;
    this._dslCounterStack = [];
    this.gastProductionsCache = {};

    if (Object.hasOwn(config, "serializedGrammar")) {
      throw Error(
        "The Parser's configuration can no longer contain a <serializedGrammar> property.\n" +
          "\tSee: https://chevrotain.io/docs/changes/BREAKING_CHANGES.html#_6-0-0\n" +
          "\tFor Further details.",
      );
    }

    if (Array.isArray(tokenVocabulary)) {
      // This only checks for Token vocabularies provided as arrays.
      // That is good enough because the main objective is to detect users of pre-V4.0 APIs
      // rather than all edge cases of empty Token vocabularies.
      if ((tokenVocabulary as any[]).length === 0) {
        throw Error(
          "A Token Vocabulary cannot be empty.\n" +
            "\tNote that the first argument for the parser constructor\n" +
            "\tis no longer a Token vector (since v4.0).",
        );
      }

      if (typeof (tokenVocabulary as any[])[0].startOffset === "number") {
        throw Error(
          "The Parser constructor no longer accepts a token vector as the first argument.\n" +
            "\tSee: https://chevrotain.io/docs/changes/BREAKING_CHANGES.html#_4-0-0\n" +
            "\tFor Further details.",
        );
      }
    }

    if (Array.isArray(tokenVocabulary)) {
      this.tokensMap = (tokenVocabulary as TokenType[]).reduce(
        (acc: { [tokenName: string]: TokenType }, tokType: TokenType) => {
          acc[tokType.name] = tokType;
          return acc;
        },
        {} as { [tokenName: string]: TokenType },
      );
    } else if (
      Object.hasOwn(tokenVocabulary, "modes") &&
      (Object.values((<any>tokenVocabulary).modes) as any[][])
        .flat()
        .every(isTokenType)
    ) {
      const allTokenTypes = (
        Object.values((<any>tokenVocabulary).modes) as any[][]
      ).flat();
      const uniqueTokens = [...new Set(allTokenTypes)];
      this.tokensMap = <any>uniqueTokens.reduce(
        (acc: { [tokenName: string]: TokenType }, tokType: TokenType) => {
          acc[tokType.name] = tokType;
          return acc;
        },
        {} as { [tokenName: string]: TokenType },
      );
    } else if (
      typeof tokenVocabulary === "object" &&
      tokenVocabulary !== null
    ) {
      this.tokensMap = { ...(tokenVocabulary as TokenTypeDictionary) };
    } else {
      throw new Error(
        "<tokensDictionary> argument must be An Array of Token constructors," +
          " A dictionary of Token constructors or an IMultiModeLexerDefinition",
      );
    }

    // always add EOF to the tokenNames -> constructors map. it is useful to assure all the input has been
    // parsed with a clear error message ("expecting EOF but found ...")
    this.tokensMap["EOF"] = EOF;

    // Because ES2015+ syntax should be supported for creating Token classes
    // We cannot assume that the Token classes were created using the "extendToken" utilities
    // Therefore we must augment the Token classes both on Lexer initialization and on Parser initialization
    augmentTokenTypes(Object.values(this.tokensMap));

    // IMPORTANT: tokenMatcher selection must happen AFTER augmentTokenTypes()
    // which populates categoryMatches and MATCH_SET. Before augmentation,
    // categoryMatches is empty/undefined on all tokens, so the check would
    // always pick the no-categories matcher — breaking any grammar that
    // uses token categories (e.g. FunctionStart as parent of UrlStart).
    const allTokenTypes = Object.hasOwn(tokenVocabulary, "modes")
      ? (Object.values((<any>tokenVocabulary).modes) as any[][]).flat()
      : Object.values(tokenVocabulary);
    const noTokenCategoriesUsed = allTokenTypes.every(
      (tokenConstructor: any) => tokenConstructor.categoryMatches?.length == 0,
    );

    this.tokenMatcher = noTokenCategoriesUsed
      ? tokenStructuredMatcherNoCategories
      : tokenStructuredMatcher;
  }

  defineRule<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleName: string,
    impl: (...args: ARGS) => R,
    config: IRuleConfig<R>,
  ): ParserMethodInternal<ARGS, R> {
    if (this.selfAnalysisDone) {
      throw Error(
        `Grammar rule <${ruleName}> may not be defined after the 'performSelfAnalysis' method has been called'\n` +
          `Make sure that all grammar rule definitions are done before 'performSelfAnalysis' is called.`,
      );
    }
    const resyncEnabled: boolean = Object.hasOwn(config, "resyncEnabled")
      ? (config.resyncEnabled as boolean) // assumes end user provides the correct config value/type
      : DEFAULT_RULE_CONFIG.resyncEnabled;
    const recoveryValueFunc = Object.hasOwn(config, "recoveryValueFunc")
      ? (config.recoveryValueFunc as () => R) // assumes end user provides the correct config value/type
      : DEFAULT_RULE_CONFIG.recoveryValueFunc;

    // performance optimization: Use small integers as keys for the longer human readable "full" rule names.
    // this greatly improves Map access time (as much as 8% for some performance benchmarks).
    const shortName =
      this.ruleShortNameIdx << (BITS_FOR_METHOD_TYPE + BITS_FOR_OCCURRENCE_IDX);

    this.ruleShortNameIdx++;
    this.shortRuleNameToFull[shortName] = ruleName;
    this.fullRuleNameToShort[ruleName] = shortName;

    let coreRuleFunction: ParserMethod<ARGS, R>;

    // Micro optimization, only check the condition **once** on rule definition
    // instead of **every single** rule invocation.
    if (this.outputCst === true) {
      coreRuleFunction = function invokeRuleWithTry(
        this: MixedInParser,
        ...args: ARGS
      ): R {
        try {
          this.ruleInvocationStateUpdate(shortName, ruleName, this.subruleIdx);
          impl.apply(this, args);
          const cst = this.CST_STACK[this.CST_STACK.length - 1];
          this.cstPostRule(cst);
          return cst as unknown as R;
        } catch (e) {
          return this.invokeRuleCatch(e, resyncEnabled, recoveryValueFunc) as R;
        } finally {
          this.ruleFinallyStateUpdate();
        }
      };
    } else {
      coreRuleFunction = function invokeRuleWithTryCst(
        this: MixedInParser,
        ...args: ARGS
      ): R {
        try {
          this.ruleInvocationStateUpdate(shortName, ruleName, this.subruleIdx);
          return impl.apply(this, args);
        } catch (e) {
          return this.invokeRuleCatch(e, resyncEnabled, recoveryValueFunc) as R;
        } finally {
          this.ruleFinallyStateUpdate();
        }
      };
    }

    // wrapper to allow before/after parsing hooks
    const rootRuleFunction: ParserMethod<ARGS, R> = function rootRule(
      this: MixedInParser,
      ...args: ARGS
    ): R {
      this.onBeforeParse(ruleName);
      try {
        return coreRuleFunction.apply(this, args);
      } finally {
        this.onAfterParse(ruleName);
      }
    };

    const wrappedGrammarRule: ParserMethodInternal<ARGS, R> = Object.assign(
      rootRuleFunction as any,
      { ruleName, originalGrammarAction: impl, coreRule: coreRuleFunction },
    );

    return wrappedGrammarRule;
  }

  /**
   * Catch handler for `invokeRuleWithTryCst`. Decides how to handle
   * exceptions thrown during rule execution:
   *
   * - **Recognition exception + reSync enabled**: attempt reSync recovery —
   *   skip tokens until a follow-set token is found, then return a partial
   *   CST node (if `outputCst`) or the recovery value.
   * - **Recognition exception + first invoked rule**: terminate the parse
   *   gracefully and return the recovery value (the parser should never
   *   throw its own errors to user code).
   * - **Recognition exception + nested rule**: re-throw so the parent rule
   *   can attempt reSync at a higher level.
   * - **Non-recognition exception** (e.g., JS runtime error): always re-throw.
   *
   * ReSync is disabled during backtracking (`IS_SPECULATING=true`) to
   * prevent recovery from accepting invalid syntax that a different
   * speculative path would parse correctly.
   */
  invokeRuleCatch(
    this: MixedInParser,
    e: Error,
    resyncEnabledConfig: boolean,
    recoveryValueFunc: Function,
  ): unknown {
    const isFirstInvokedRule = this.RULE_STACK_IDX === 0;
    // note the reSync is always enabled for the first rule invocation, because we must always be able to
    // reSync with EOF and just output some INVALID ParseTree
    // during backtracking reSync recovery is disabled, otherwise we can't be certain the backtracking
    // path is really the most valid one
    const reSyncEnabled =
      resyncEnabledConfig && !this.isBackTracking() && this.recoveryEnabled;

    if (isRecognitionException(e)) {
      const recogError: any = e;
      if (reSyncEnabled) {
        const reSyncTokType = this.findReSyncTokenType();
        if (this.isInCurrentRuleReSyncSet(reSyncTokType)) {
          recogError.resyncedTokens = this.reSyncTo(reSyncTokType);
          if (this.outputCst) {
            const partialCstResult: any =
              this.CST_STACK[this.CST_STACK.length - 1];
            partialCstResult.recoveredNode = true;
            return partialCstResult;
          } else {
            return recoveryValueFunc(e);
          }
        } else {
          if (this.outputCst) {
            const partialCstResult: any =
              this.CST_STACK[this.CST_STACK.length - 1];
            partialCstResult.recoveredNode = true;
            recogError.partialCstResult = partialCstResult;
          }
          // to be handled Further up the call stack
          throw recogError;
        }
      } else if (isFirstInvokedRule) {
        // otherwise a Redundant input error will be created as well and we cannot guarantee that this is indeed the case
        this.moveToTerminatedState();
        // the parser should never throw one of its own errors outside its flow.
        // even if error recovery is disabled
        return recoveryValueFunc(e);
      } else {
        // to be recovered Further up the call stack
        throw recogError;
      }
    } else {
      // some other Error type which we don't know how to handle (for example a built in JavaScript Error)
      throw e;
    }
  }

  // Implementation of parsing DSL
  optionInternal<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
    _occurrence: number,
  ): OUT | undefined {
    return this.optionInternalLogic(actionORMethodDef);
  }

  /**
   * Optionally executes the OPTION body, returning its result or undefined.
   *
   * Does NOT set IS_SPECULATING — the outer speculating state (if any, set by
   * OR) propagates naturally so CONSUME throws the cheapest failure path.
   *
   * If a GATE is present: gate-false → skip; gate-true → commit directly
   * (gate is a reliable lookahead, no speculation needed).
   *
   * Without a GATE: save state + CST watermark, run body, restore on failure.
   * Two additional abort conditions:
   *   1. Body did not advance the token position (stuck / epsilon body).
   *   2. Recovery mode added errors — the optional content wasn't really there.
   */
  optionInternalLogic<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    let action: GrammarAction<OUT>;
    let gate: (() => boolean) | undefined;
    if (typeof actionORMethodDef !== "function") {
      action = actionORMethodDef.DEF;
      gate = actionORMethodDef.GATE;
    } else {
      action = actionORMethodDef;
      gate = undefined;
    }

    // GATE as a filter: if it fails skip immediately; if it passes fall through
    // to the speculative save/restore path (gate is a necessary but not sufficient
    // condition — the body may still not match the current tokens).
    // Track gated prefix: if this gated production fires before the first
    // CONSUME in an OR alt, the alt's first-token set is gate-dependent.
    if (gate !== undefined && this.IS_SPECULATING) {
      if (this.exportLexerState() === this._orAltStartLexPos) {
        this._orAltHasGatedPrefix = true;
      }
    }
    if (gate !== undefined && !gate.call(this)) {
      return undefined;
    }

    const startLexPos = this.exportLexerState();
    const startErrors = this._errors.length;
    const cstSave = this.saveCstTop();
    try {
      const result = action.call(this);
      // Stuck guard: if body didn't advance pos, or recovery added
      // errors (meaning the optional content wasn't really present), undo.
      if (
        this.exportLexerState() === startLexPos ||
        this._errors.length > startErrors
      ) {
        this.restoreCstTop(cstSave);
        this.importLexerState(startLexPos);
        this._errors.length = startErrors;
        return undefined;
      }
      return result;
    } catch (e) {
      if (e === SPEC_FAIL || isRecognitionException(e)) {
        this.restoreCstTop(cstSave);
        this.importLexerState(startLexPos);
        this._errors.length = startErrors;
        return undefined;
      }
      throw e;
    }
  }

  atLeastOneInternal<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    return this.atLeastOneInternalLogic(prodOccurrence, actionORMethodDef);
  }

  /**
   * One-or-more loop. The first iteration is mandatory: a speculative probe
   * checks whether the action can start at all, and if so the body runs
   * committed so that nested invokeRuleCatch performs normal error recovery.
   * Subsequent iterations use the same probe + commit pattern — the lookahead
   * guard prevents spurious in-repetition-recovery errors that would arise from
   * speculatively running the full body and exiting via SPEC_FAIL.
   */
  atLeastOneInternalLogic<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    let action: GrammarAction<OUT>;
    let gate: (() => boolean) | undefined;
    if (typeof actionORMethodDef !== "function") {
      action = actionORMethodDef.DEF;
      gate = actionORMethodDef.GATE;
    } else {
      action = actionORMethodDef;
      gate = undefined;
    }

    // Track gated prefix for OR fast-path cache.
    if (gate !== undefined && this.IS_SPECULATING) {
      if (this.exportLexerState() === this._orAltStartLexPos) {
        this._orAltHasGatedPrefix = true;
      }
    }
    if (gate !== undefined && !gate.call(this)) {
      throw this.raiseEarlyExitException(
        prodOccurrence,
        PROD_TYPE.REPETITION_MANDATORY,
        (actionORMethodDef as DSLMethodOptsWithErr<OUT>).ERR_MSG,
      );
    }

    // Save _dslCounter so each iteration starts from the same value.
    const savedRepDslCounter = this._dslCounter;

    // Speculative lookahead: check whether the action can start before running
    // it committed. This prevents invokeRuleCatch inside the action from silently
    // recovering (advancing to the follow token) and making AT_LEAST_ONE think
    // the first iteration succeeded when no matching tokens were consumed.
    if (!this.makeSpecLookahead(action)()) {
      throw this.raiseEarlyExitException(
        prodOccurrence,
        PROD_TYPE.REPETITION_MANDATORY,
        (actionORMethodDef as DSLMethodOptsWithErr<OUT>).ERR_MSG,
      );
    }

    // First iteration: mandatory — run committed.
    {
      this._dslCounter = savedRepDslCounter;
      const firstLexPos = this.exportLexerState();
      const firstErrors = this._errors.length;
      const firstCstSave = this.saveCstTop();
      try {
        action.call(this);
      } catch (e) {
        if (e === SPEC_FAIL || isRecognitionException(e)) {
          this.restoreCstTop(firstCstSave);
          this.importLexerState(firstLexPos);
          this._errors.length = firstErrors;
          throw this.raiseEarlyExitException(
            prodOccurrence,
            PROD_TYPE.REPETITION_MANDATORY,
            (actionORMethodDef as DSLMethodOptsWithErr<OUT>).ERR_MSG,
          );
        }
        throw e;
      }
    }

    // Subsequent iterations: probe with a quick speculative lookahead (exits
    // after the first successful CONSUME), then execute the body committed so
    // that nested invokeRuleCatch can perform normal error recovery. This
    // matches the original LL(k) engine's behaviour where each iteration was
    // fully committed once the lookahead said "yes".
    const lookaheadFunc = this.makeSpecLookahead(action);
    while (lookaheadFunc()) {
      if (gate !== undefined && !gate.call(this)) break;
      this._dslCounter = savedRepDslCounter;
      const iterLexPos = this.exportLexerState();
      const iterErrors = this._errors.length;
      const cstSave = this.saveCstTop();
      try {
        // Run committed — any recovery happens inside the subrule's invokeRuleCatch.
        action.call(this);
      } catch (e) {
        // The committed body failed (e.g. a CONSUME mismatch with no wrapping
        // SUBRULE to do resync recovery). Restore state and exit the loop so
        // the tokens can be consumed by whatever follows AT_LEAST_ONE.
        if (e === SPEC_FAIL || isRecognitionException(e)) {
          this.restoreCstTop(cstSave);
          this.importLexerState(iterLexPos);
          this._errors.length = iterErrors;
          break;
        }
        throw e;
      }
      // Stuck guard: body consumed no tokens → restore and stop.
      if (this.exportLexerState() <= iterLexPos) {
        this.restoreCstTop(cstSave);
        this.importLexerState(iterLexPos);
        this._errors.length = iterErrors;
        break;
      }
    }
    // Performance optimization: "attemptInRepetitionRecovery" will be defined as NOOP unless recovery is enabled
    this.attemptInRepetitionRecovery(
      this.atLeastOneInternal,
      [prodOccurrence, actionORMethodDef],
      lookaheadFunc,
      AT_LEAST_ONE_IDX,
      prodOccurrence,
      NextTerminalAfterAtLeastOneWalker,
    );
  }

  atLeastOneSepFirstInternal<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    this.atLeastOneSepFirstInternalLogic(prodOccurrence, options);
  }

  /**
   * One-or-more separated list. The first iteration is mandatory (no
   * IS_SPECULATING set); subsequent iterations are separator-driven
   * (tokenMatcher check — reliable lookahead, no speculation needed).
   *
   * We do NOT set IS_SPECULATING for the first iteration for the same reason as
   * atLeastOneInternalLogic: nested OR last alts inside the body must retain their
   * "committed" semantics. The separator provides a deterministic guard for all
   * subsequent iterations, so those also need no speculation.
   */
  atLeastOneSepFirstInternalLogic<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const action = options.DEF;
    const separator = options.SEP;

    // Save _dslCounter so each iteration starts from the same value.
    const savedRepDslCounter = this._dslCounter;

    // First iteration: mandatory — no IS_SPECULATING, let it throw/recover normally.
    {
      this._dslCounter = savedRepDslCounter;
      const firstLexPos = this.exportLexerState();
      const firstErrors = this._errors.length;
      const firstCstSave = this.saveCstTop();
      try {
        (action as GrammarAction<OUT>).call(this);
      } catch (e) {
        if (e === SPEC_FAIL || isRecognitionException(e)) {
          this.restoreCstTop(firstCstSave);
          this.importLexerState(firstLexPos);
          this._errors.length = firstErrors;
          throw this.raiseEarlyExitException(
            prodOccurrence,
            PROD_TYPE.REPETITION_MANDATORY_WITH_SEPARATOR,
            options.ERR_MSG,
          );
        }
        throw e;
      }
    }

    // The separator token acts as a reliable lookahead for subsequent iterations.
    const separatorLookAheadFunc = () => {
      return this.tokenMatcher(this.LA_FAST(1), separator);
    };

    // 2nd..nth iterations
    while (this.tokenMatcher(this.LA_FAST(1), separator) === true) {
      this.CONSUME(separator);
      this._dslCounter = savedRepDslCounter;
      (action as GrammarAction<OUT>).call(this);
    }

    // Performance optimization: "attemptInRepetitionRecovery" will be defined as NOOP unless recovery is enabled
    this.attemptInRepetitionRecovery(
      this.repetitionSepSecondInternal,
      [
        prodOccurrence,
        separator,
        separatorLookAheadFunc,
        action,
        NextTerminalAfterAtLeastOneSepWalker,
      ],
      separatorLookAheadFunc,
      AT_LEAST_ONE_SEP_IDX,
      prodOccurrence,
      NextTerminalAfterAtLeastOneSepWalker,
    );
  }

  manyInternal<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    return this.manyInternalLogic(prodOccurrence, actionORMethodDef);
  }

  /**
   * Core MANY loop: runs the body speculatively until it fails.
   * Modelled after @jesscss/parser's MANY with additional error handling.
   *
   * Each iteration: save state → `IS_SPECULATING=true` → try body →
   * on `SPEC_FAIL` → restore and break. On success → check stuck guard.
   *
   * ## Recognition exception handling (for error recovery)
   *
   * OR's committed re-run (see `orInternal`) temporarily clears
   * `IS_SPECULATING`, so `CONSUME` failures throw real
   * `MismatchedTokenException` instead of `SPEC_FAIL`. These propagate
   * as recognition exceptions rather than `SPEC_FAIL`:
   *
   * - **With progress** (lexer advanced past iteration start): the body
   *   partially matched → real error → re-throw for recovery in
   *   `invokeRuleCatch` or error reporting upstream.
   * - **No progress**: body couldn't start → stop iterating. Errors from
   *   the recognition exception (e.g., `NoViableAltException` from
   *   ambiguous OR) are preserved in `_errors` for diagnostics.
   */
  manyInternalLogic<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ) {
    let action: GrammarAction<OUT>;
    let gate: (() => boolean) | undefined;
    if (typeof actionORMethodDef !== "function") {
      action = actionORMethodDef.DEF;
      gate = actionORMethodDef.GATE;
    } else {
      action = actionORMethodDef;
      gate = undefined;
    }

    const wasSpeculating = this.IS_SPECULATING;
    let notStuck = true;
    let ranAtLeastOnce = false;
    // lookaheadFunc built lazily on first exit (for recovery pass below)
    let lookaheadFunc: (() => boolean) | undefined;

    // Save _dslCounter so each iteration of the repetition body starts from
    // the same counter value. The GAST records only one iteration's DSL calls,
    // so all runtime iterations must produce the same occurrence indices.
    const savedRepDslCounter = this._dslCounter;

    // Speculative body: IS_SPECULATING=true, catch SPEC_FAIL to stop.
    // Also catches recognition exceptions from OR's committed re-run
    // (which temporarily clears IS_SPECULATING for error recovery).
    // If a recognition exception arrives with no progress, the body
    // couldn't start → break. With progress, it's a real error → re-throw.
    while (notStuck) {
      // Track gated prefix for OR fast-path cache (first iteration only).
      if (gate !== undefined && this.IS_SPECULATING && !ranAtLeastOnce) {
        if (this.exportLexerState() === this._orAltStartLexPos) {
          this._orAltHasGatedPrefix = true;
        }
      }
      if (gate !== undefined && !gate.call(this)) break;
      // Reset counter for this iteration to match GAST recording.
      this._dslCounter = savedRepDslCounter;
      const iterLexPos = this.exportLexerState();
      const iterErrors = this._errors.length;
      const iterCstSave = this.saveCstTop();
      this.IS_SPECULATING = true;
      try {
        action.call(this);
        this.IS_SPECULATING = wasSpeculating;
      } catch (e) {
        this.IS_SPECULATING = wasSpeculating;
        if (e === SPEC_FAIL) {
          // Speculative failure: body can't match → stop iterating.
          this.importLexerState(iterLexPos);
          this.restoreCstTop(iterCstSave);
          this._errors.length = iterErrors;
          break;
        }
        if (isRecognitionException(e)) {
          // Real error from OR's committed re-run (IS_SPECULATING was
          // temporarily cleared). Check if the body made progress:
          if (this.exportLexerState() > iterLexPos) {
            // Body partially matched → real error → propagate for
            // recovery (invokeRuleCatch) or error reporting.
            throw e;
          }
          // No progress → body can't start → stop iterating.
          // Restore pos and CST, but NOT errors — the recognition
          // exception (e.g., NoViableAltException from ambiguous OR)
          // was intentionally added to _errors and should be kept.
          this.importLexerState(iterLexPos);
          this.restoreCstTop(iterCstSave);
          break;
        }
        throw e;
      }
      // Stuck guard: body consumed no tokens → stop to prevent infinite loops.
      if (this.exportLexerState() <= iterLexPos) {
        this.importLexerState(iterLexPos);
        notStuck = false;
        break;
      }
      ranAtLeastOnce = true;
    }

    // Only attempt in-repetition recovery if ≥1 iterations ran successfully.
    if (ranAtLeastOnce) {
      lookaheadFunc ??= this.makeSpecLookahead(action);
      // Performance optimization: "attemptInRepetitionRecovery" will be defined as NOOP unless recovery is enabled
      this.attemptInRepetitionRecovery(
        this.manyInternal,
        [prodOccurrence, actionORMethodDef],
        lookaheadFunc,
        MANY_IDX,
        prodOccurrence,
        NextTerminalAfterManyWalker,
        notStuck,
      );
    }
  }

  manySepFirstInternal<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    options: ManySepMethodOpts<OUT>,
  ): void {
    this.manySepFirstInternalLogic(prodOccurrence, options);
  }

  /**
   * Zero-or-more separated list. The first iteration is optional but tried
   * directly (no IS_SPECULATING set); subsequent iterations are
   * separator-driven (reliable tokenMatcher guard).
   *
   * The first element uses the same try/catch + stuck guard as OPTION — no
   * IS_SPECULATING, so nested OR last alts retain committed semantics inside
   * the body. The separator makes subsequent iterations deterministic.
   */
  manySepFirstInternalLogic<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    options: ManySepMethodOpts<OUT>,
  ): void {
    const action = options.DEF;
    const separator = options.SEP;

    // Save _dslCounter so each iteration starts from the same value.
    const savedRepDslCounter = this._dslCounter;

    // Optional first iteration — try without IS_SPECULATING.
    const firstLexPos = this.exportLexerState();
    const firstErrors = this._errors.length;
    const firstCstSave = this.saveCstTop();
    try {
      action.call(this);
    } catch (e) {
      if (e === SPEC_FAIL || isRecognitionException(e)) {
        this.restoreCstTop(firstCstSave);
        this.importLexerState(firstLexPos);
        this._errors.length = firstErrors;
        return; // zero iterations — MANY_SEP is optional
      }
      throw e;
    }
    // Stuck guard: first element consumed no tokens → treat as zero iterations.
    if (this.exportLexerState() <= firstLexPos) {
      this.restoreCstTop(firstCstSave);
      this.importLexerState(firstLexPos);
      this._errors.length = firstErrors;
      return;
    }

    const separatorLookAheadFunc = () => {
      return this.tokenMatcher(this.LA_FAST(1), separator);
    };
    // 2nd..nth iterations
    while (this.tokenMatcher(this.LA_FAST(1), separator) === true) {
      this.CONSUME(separator);
      this._dslCounter = savedRepDslCounter;
      action.call(this);
    }

    // Performance optimization: "attemptInRepetitionRecovery" will be defined as NOOP unless recovery is enabled
    this.attemptInRepetitionRecovery(
      this.repetitionSepSecondInternal,
      [
        prodOccurrence,
        separator,
        separatorLookAheadFunc,
        action,
        NextTerminalAfterManySepWalker,
      ],
      separatorLookAheadFunc,
      MANY_SEP_IDX,
      prodOccurrence,
      NextTerminalAfterManySepWalker,
    );
  }

  /**
   * Returns a speculative lookahead predicate for the given action, used
   * exclusively by attemptInRepetitionRecovery (which is a NOOP when recovery
   * is disabled). The predicate saves state, runs the action speculatively,
   * and always restores — returning true iff the action would succeed.
   */
  makeSpecLookahead(
    this: MixedInParser,
    action: GrammarAction<any>,
  ): () => boolean {
    // IS_SPECULATING=true means CST building and error building are both skipped
    // (Stage 3), so no CST save/restore or RULE_STACK_IDX save is needed —
    // only the lexer position requires rollback.
    return () => {
      const savedLexPos = this.exportLexerState();
      const savedCounter = this._dslCounter;
      const prev = this.IS_SPECULATING;
      this.IS_SPECULATING = true;
      // _earlyExitLookahead: abort the action after the first successful CONSUME,
      // preventing embedded-action side effects (e.g. array pushes) from running.
      this._earlyExitLookahead = true;
      try {
        action.call(this);
        return true;
      } catch (e) {
        if (e === SPEC_FAIL || isRecognitionException(e)) return false;
        if (e === FIRST_TOKEN_MATCH) return true;
        throw e;
      } finally {
        this._earlyExitLookahead = false;
        this.IS_SPECULATING = prev;
        this.importLexerState(savedLexPos);
        this._dslCounter = savedCounter;
      }
    };
  }

  repetitionSepSecondInternal<OUT>(
    this: MixedInParser,
    prodOccurrence: number,
    separator: TokenType,
    separatorLookAheadFunc: () => boolean,
    action: GrammarAction<OUT>,
    nextTerminalAfterWalker: typeof AbstractNextTerminalAfterProductionWalker,
  ): void {
    while (separatorLookAheadFunc()) {
      // note that this CONSUME will never enter recovery because
      // the separatorLookAheadFunc checks that the separator really does exist.
      this.CONSUME(separator);
      action.call(this);
    }

    // we can only arrive to this function after an error
    // has occurred (hence the name 'second') so the following
    // IF will always be entered, its possible to remove it...
    // however it is kept to avoid confusion and be consistent.
    // Performance optimization: "attemptInRepetitionRecovery" will be defined as NOOP unless recovery is enabled
    /* istanbul ignore else */
    this.attemptInRepetitionRecovery(
      this.repetitionSepSecondInternal,
      [
        prodOccurrence,
        separator,
        separatorLookAheadFunc,
        action,
        nextTerminalAfterWalker,
      ],
      separatorLookAheadFunc,
      AT_LEAST_ONE_SEP_IDX,
      prodOccurrence,
      nextTerminalAfterWalker,
    );
  }

  doSingleRepetition(this: MixedInParser, action: Function): any {
    const beforeIteration = this.getLexerPosition();
    action.call(this);
    const afterIteration = this.getLexerPosition();

    // This boolean will indicate if this repetition progressed
    // or if we are "stuck" (potential infinite loop in the repetition).
    return afterIteration > beforeIteration;
  }

  /**
   * Iterates alternatives using zero-cost speculative backtracking.
   * Modelled after @jesscss/parser's OR().
   *
   * ## Three execution paths (tried in order):
   *
   * **1. Fast-dispatch path** — `_orFastMaps[mapKey][la1.tokenTypeIdx]` gives
   * the alt index observed to match this LA(1) token on a previous call.
   * One property lookup → speculative ALT call. Gated-prefix alts are
   * checked separately via `_orGatedPrefixAlts`.
   *
   * **2. Slow speculative path** — For each alt in declaration order:
   * GATE fails → skip; otherwise save state, set `IS_SPECULATING=true`,
   * try ALT. On success → return (first success wins). On SPEC_FAIL →
   * restore state (pos + CST + errors), try next. Failed alts with
   * progress populate the fast-dispatch map for future calls.
   *
   * **3. Committed re-run** — When all speculative alts fail but the
   * fast-dispatch map has an entry for the current token (populated during
   * step 2), re-run that alt with `IS_SPECULATING=false`. This lets
   * `consumeInternal` throw real `MismatchedTokenException`, enabling:
   *   - **Recovery** (if `recoveryEnabled`): single-token insertion/deletion
   *     in `consumeInternalRecovery`, or reSync in `invokeRuleCatch`.
   *   - **Error propagation** (if recovery disabled): exception bubbles to
   *     the enclosing rule's `invokeRuleCatch` for error reporting.
   * For ambiguous entries (-1), raises `NoViableAltException` directly.
   * MANY's catch handler uses progress to decide whether to stop iterating
   * (no progress) or re-throw (progress made).
   */
  orInternal<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
    occurrence: number,
  ): T {
    const alts = Array.isArray(altsOrOpts) ? altsOrOpts : altsOrOpts.DEF;
    const errMsg = Array.isArray(altsOrOpts)
      ? undefined
      : (altsOrOpts as OrMethodOpts<unknown>).ERR_MSG;
    const wasSpeculating = this.IS_SPECULATING;
    // Save outer OR's gated-prefix tracking state so nested ORs (via
    // SUBRULEs) don't corrupt it.
    const savedAltStartLexPos = this._orAltStartLexPos;
    const savedAltHasGatedPrefix = this._orAltHasGatedPrefix;

    const savedDslCounter = this._dslCounter;
    const mapKey = this.currRuleShortName | occurrence;
    const altStarts = this._orAltCounterStarts[mapKey];

    // -----------------------------------------------------------------------
    // Fast-dispatch path — direct tokenTypeIdx→altIdx map, zero allocation.
    //
    // `_orFastMaps[mapKey][la1.tokenTypeIdx]` gives the alt index observed to
    // match this LA(1) token. Built lazily from slow-path observations.
    // For gate-free, unambiguous LL(1) grammars (e.g. JSON) this is the
    // hottest path: one property lookup → committed ALT call.
    //
    // Gated-prefix alts (gate-dependent first-token set) are checked
    // separately via `_orGatedPrefixAlts` — they must always be speculated.
    // -----------------------------------------------------------------------
    const la1 = this.LA_FAST(1);
    const la1TypeIdx = la1.tokenTypeIdx;
    const fastMap = this._orFastMaps[mapKey];
    const gatedPrefixAlts = this._orGatedPrefixAlts[mapKey];
    if (fastMap !== undefined || gatedPrefixAlts !== undefined) {
      // Gated-prefix alts have higher priority than fast-map entries.
      // They must ALWAYS be tried first because their first-token set is
      // gate-dependent — the gate may open/close between calls.
      if (gatedPrefixAlts !== undefined) {
        for (let gIdx = 0; gIdx < gatedPrefixAlts.length; gIdx++) {
          const altIdx = gatedPrefixAlts[gIdx];
          const alt = alts[altIdx];
          if (alt.GATE !== undefined && !alt.GATE.call(this)) continue;
          const fastLexPos = this.currIdx;
          if (altStarts !== undefined)
            this._dslCounter = savedDslCounter + altStarts[altIdx];
          if (wasSpeculating) {
            try {
              const r = alt.ALT.call(this) as T;
              {
                const d = this._orCounterDeltas[mapKey];
                if (d !== undefined) this._dslCounter = savedDslCounter + d;
              }
              return r;
            } catch (_e) {
              this.currIdx = fastLexPos;
            }
          } else {
            const fastErrors = this._errors.length;
            const fastCstSave = this.saveCstTop();
            try {
              const r = alt.ALT.call(this) as T;
              {
                const d = this._orCounterDeltas[mapKey];
                if (d !== undefined) this._dslCounter = savedDslCounter + d;
              }
              return r;
            } catch (_e) {
              this.restoreCstTop(fastCstSave);
              this.currIdx = fastLexPos;
              this._errors.length = fastErrors;
            }
          }
        }
      }

      const fastAltIdx =
        fastMap !== undefined ? fastMap[la1TypeIdx] : undefined;

      // Direct dispatch: single candidate for this tokenTypeIdx.
      if (fastAltIdx !== undefined && fastAltIdx >= 0) {
        // Decode: entries >= GATED_OFFSET have preceding gated alts with
        // an explicit GATE property on the alt itself. Check those first.
        let realAltIdx = fastAltIdx;
        if (fastAltIdx >= GATED_OFFSET) {
          realAltIdx = fastAltIdx - GATED_OFFSET;
          for (let g = 0; g < realAltIdx; g++) {
            const galt = alts[g];
            if (galt.GATE !== undefined && galt.GATE.call(this)) {
              const gPos = this.currIdx;
              if (altStarts !== undefined)
                this._dslCounter = savedDslCounter + altStarts[g];
              if (wasSpeculating) {
                try {
                  const r = galt.ALT.call(this) as T;
                  {
                    const d = this._orCounterDeltas[mapKey];
                    if (d !== undefined) this._dslCounter = savedDslCounter + d;
                  }
                  return r;
                } catch (_e) {
                  this.currIdx = gPos;
                }
              } else {
                const gErr = this._errors.length;
                const gCst = this.saveCstTop();
                try {
                  const r = galt.ALT.call(this) as T;
                  {
                    const d = this._orCounterDeltas[mapKey];
                    if (d !== undefined) this._dslCounter = savedDslCounter + d;
                  }
                  return r;
                } catch (_e) {
                  this.restoreCstTop(gCst);
                  this.currIdx = gPos;
                  this._errors.length = gErr;
                }
              }
            }
          }
        }

        // Dispatch to the mapped fallback alt.
        const alt = alts[realAltIdx];
        if (alt.GATE === undefined || alt.GATE.call(this)) {
          if (altStarts !== undefined)
            this._dslCounter = savedDslCounter + altStarts[realAltIdx];
          const fastLexPos = this.currIdx;
          if (wasSpeculating) {
            try {
              const r = alt.ALT.call(this) as T;
              {
                const d = this._orCounterDeltas[mapKey];
                if (d !== undefined) this._dslCounter = savedDslCounter + d;
              }
              return r;
            } catch (_e) {
              this.currIdx = fastLexPos;
            }
          } else {
            const fastErrors = this._errors.length;
            const fastCstSave = this.saveCstTop();
            try {
              const r = alt.ALT.call(this) as T;
              {
                const d = this._orCounterDeltas[mapKey];
                if (d !== undefined) this._dslCounter = savedDslCounter + d;
              }
              return r;
            } catch (_e) {
              this.restoreCstTop(fastCstSave);
              this.currIdx = fastLexPos;
              this._errors.length = fastErrors;
            }
          }
        }
      }
      // Fast path exhausted — fall through to full speculative loop.
    }

    // -----------------------------------------------------------------------
    // Slow path: try each alt speculatively. First success wins.
    // No bestProgress tracking — first success is final.
    //
    // Committed re-run: when all speculative alts fail but the fast-dispatch
    // map identified which alt's first token matched (LL(1)), re-run that
    // alt with IS_SPECULATING=false. This lets CONSUME throw real
    // MismatchedTokenException for recovery (if enabled) or error
    // propagation (if disabled). MANY catches the exception and checks
    // progress to decide whether to stop or re-throw.
    // -----------------------------------------------------------------------
    const startLexPos = this.exportLexerState();
    // Save CST/errors for clean state restoration. During speculation,
    // successful CONSUMEs add CST nodes that aren't cleaned up on
    // SPEC_FAIL (only lexer pos is restored).
    const savedErrors = this._errors.length;
    const savedCst = this.saveCstTop();

    for (let i = 0; i < alts.length; i++) {
      const alt = alts[i];
      if (alt.GATE !== undefined && !alt.GATE.call(this)) continue;
      this.IS_SPECULATING = true;
      if (altStarts !== undefined)
        this._dslCounter = savedDslCounter + altStarts[i];
      this._orAltStartLexPos = startLexPos;
      this._orAltHasGatedPrefix = false;
      try {
        const result = alt.ALT.call(this) as T;
        this.IS_SPECULATING = wasSpeculating;
        // Record for fast-dispatch cache.
        if (this._orAltHasGatedPrefix) {
          let gpa = this._orGatedPrefixAlts[mapKey];
          if (gpa === undefined) {
            gpa = [];
            this._orGatedPrefixAlts[mapKey] = gpa;
          }
          if (!gpa.includes(i)) {
            gpa.push(i);
            if (gpa.length > 1) gpa.sort((a, b) => a - b);
          }
        } else {
          addOrFastMapEntry(this._orFastMaps, mapKey, la1TypeIdx, i, alts);
        }
        this._orAltStartLexPos = savedAltStartLexPos;
        this._orAltHasGatedPrefix = savedAltHasGatedPrefix;
        {
          const d = this._orCounterDeltas[mapKey];
          if (d !== undefined) this._dslCounter = savedDslCounter + d;
        }
        return result;
      } catch (e) {
        this.IS_SPECULATING = wasSpeculating;
        if (e === SPEC_FAIL || isRecognitionException(e)) {
          // Record gated-prefix tracking for failed alts.
          if (this._orAltHasGatedPrefix) {
            let gpa = this._orGatedPrefixAlts[mapKey];
            if (gpa === undefined) {
              gpa = [];
              this._orGatedPrefixAlts[mapKey] = gpa;
            }
            if (!gpa.includes(i)) {
              gpa.push(i);
              if (gpa.length > 1) gpa.sort((a, b) => a - b);
            }
          }
          // Record failed alt with progress for fast-dispatch ambiguity
          // detection. If a different alt later succeeds for the same
          // tokenTypeIdx, the entry becomes -1 (ambiguous).
          const progress = this.exportLexerState() - startLexPos;
          if (!this._orAltHasGatedPrefix && progress > 0) {
            addOrFastMapEntry(this._orFastMaps, mapKey, la1TypeIdx, i, alts);
          }
          this.importLexerState(startLexPos);
          // Restore CST/errors so next alt starts with clean state.
          this._errors.length = savedErrors;
          this.restoreCstTop(savedCst);
          continue;
        }
        throw e;
      }
    }

    // -----------------------------------------------------------------
    // Committed re-run: all speculative alts failed, but the fast-dispatch
    // map identified which alt's first token matched (LL(1) lookahead).
    // Re-run that alt with IS_SPECULATING=false so CONSUME throws real
    // MismatchedTokenException. This enables:
    //   - Recovery (if recoveryEnabled): single-token insertion/deletion
    //   - Error propagation (if recovery disabled): exception bubbles to
    //     enclosing rule's invokeRuleCatch for error reporting
    // MANY catches the propagating exception and uses progress to decide
    // whether to stop iterating or re-throw for higher-level handling.
    // -----------------------------------------------------------------
    {
      const recoveryMap = this._orFastMaps[mapKey];
      if (recoveryMap !== undefined) {
        let recoveryAltIdx = recoveryMap[la1TypeIdx];
        if (recoveryAltIdx !== undefined && recoveryAltIdx >= 0) {
          if (recoveryAltIdx >= GATED_OFFSET) recoveryAltIdx -= GATED_OFFSET;
          // Restore clean state before committed re-run.
          this.restoreCstTop(savedCst);
          this._errors.length = savedErrors;
          if (altStarts !== undefined)
            this._dslCounter = savedDslCounter + altStarts[recoveryAltIdx];
          this._orAltStartLexPos = startLexPos;
          this._orAltHasGatedPrefix = false;
          // Clear IS_SPECULATING so CONSUME throws real errors.
          this.IS_SPECULATING = false;
          try {
            const result = alts[recoveryAltIdx].ALT.call(this) as T;
            this.IS_SPECULATING = wasSpeculating;
            this._orAltStartLexPos = savedAltStartLexPos;
            this._orAltHasGatedPrefix = savedAltHasGatedPrefix;
            {
              const d = this._orCounterDeltas[mapKey];
              if (d !== undefined) this._dslCounter = savedDslCounter + d;
            }
            return result;
          } catch (e) {
            // Recovery in invokeRuleCatch may have handled it (subrule
            // returns normally). If the error propagates here, it means
            // recovery couldn't fix it — let it bubble up.
            this.IS_SPECULATING = wasSpeculating;
            this._orAltStartLexPos = savedAltStartLexPos;
            this._orAltHasGatedPrefix = savedAltHasGatedPrefix;
            throw e;
          }
        }
      }
    }

    // All alts failed. Restore tracking state.
    this._orAltStartLexPos = savedAltStartLexPos;
    this._orAltHasGatedPrefix = savedAltHasGatedPrefix;
    {
      const d = this._orCounterDeltas[mapKey];
      if (d !== undefined) this._dslCounter = savedDslCounter + d;
    }

    // If the fast map has ANY entry for this token (including ambiguous -1),
    // the token matched at least one alt's first CONSUME during speculation.
    // Raise a real NoViableAltException so the error propagates through MANY
    // for proper error reporting, rather than being silently swallowed as
    // SPEC_FAIL. MANY's catch handler uses progress to decide whether to
    // stop iterating (no progress) or re-throw (progress made).
    if (this.IS_SPECULATING) {
      const failMap = this._orFastMaps[mapKey];
      if (failMap !== undefined && failMap[la1TypeIdx] !== undefined) {
        this.IS_SPECULATING = false;
        this.restoreCstTop(savedCst);
        this._errors.length = savedErrors;
        this.raiseNoAltException(occurrence, errMsg);
        // raiseNoAltException throws — unreachable.
      }
      throw SPEC_FAIL;
    }
    this.raiseNoAltException(occurrence, errMsg);
  }

  ruleFinallyStateUpdate(this: MixedInParser): void {
    // Restore the single DSL counter from the parent rule scope.
    this._dslCounter = this._dslCounterStack[this.RULE_STACK_IDX];
    this.RULE_STACK_IDX--;
    this.RULE_OCCURRENCE_STACK_IDX--;

    // Restore the cached short name to the parent rule.
    // When the stack is empty (top-level rule exiting), the stale value
    // is harmless — no DSL methods will be called before the next ruleInvocationStateUpdate.
    if (this.RULE_STACK_IDX >= 0) {
      this.currRuleShortName = this.RULE_STACK[this.RULE_STACK_IDX];
    }

    // NOOP when cst is disabled
    this.cstFinallyStateUpdate();
  }

  subruleInternal<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    idx: number,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    let ruleResult;
    try {
      const args = options !== undefined ? options.ARGS : undefined;
      this.subruleIdx = idx;
      // Use coreRule to bypass root-level hooks (onBeforeParse/onAfterParse)
      ruleResult = ruleToCall.coreRule.apply(this, args);
      this.cstPostNonTerminal(
        ruleResult,
        options !== undefined && options.LABEL !== undefined
          ? options.LABEL
          : ruleToCall.ruleName,
      );
      return ruleResult;
    } catch (e) {
      throw this.subruleInternalError(e, options, ruleToCall.ruleName);
    }
  }

  subruleInternalError(
    this: MixedInParser,
    e: any,
    options: SubruleMethodOpts<unknown[]> | undefined,
    ruleName: string,
  ): void {
    if (isRecognitionException(e) && e.partialCstResult !== undefined) {
      this.cstPostNonTerminal(
        e.partialCstResult,
        options !== undefined && options.LABEL !== undefined
          ? options.LABEL
          : ruleName,
      );

      e.partialCstResult = undefined;
    }
    throw e;
  }

  /**
   * Matches the next token against `tokType`. Three outcomes:
   *
   * 1. **Match**: advance position, add to CST, return the token.
   *    If `_earlyExitLookahead` is set, throws `FIRST_TOKEN_MATCH`
   *    immediately (used by `makeSpecLookahead` for LL(1) peek).
   *
   * 2. **Mismatch + speculating** (`IS_SPECULATING=true`): throws the
   *    `SPEC_FAIL` Symbol — zero allocation cost, no stack trace.
   *    Caught by OR/MANY/OPTION for backtracking.
   *
   * 3. **Mismatch + committed** (`IS_SPECULATING=false`): delegates to
   *    `consumeInternalError` → `consumeInternalRecovery` for
   *    single-token insertion/deletion (if `recoveryEnabled`), or
   *    throws `MismatchedTokenException` for upstream handling.
   */
  consumeInternal(
    this: MixedInParser,
    tokType: TokenType,
    idx: number,
    options: ConsumeMethodOpts | undefined,
  ): IToken {
    const nextToken = this.LA_FAST(1);
    const label =
      options !== undefined && options.LABEL !== undefined
        ? options.LABEL
        : tokType.name;

    if (this.tokenMatcher(nextToken, tokType) === true) {
      this.consumeToken();
      if (this._earlyExitLookahead) throw FIRST_TOKEN_MATCH;
      this.cstPostTerminal(label, nextToken);
      return nextToken;
    }

    // Mismatch: speculative fast path — skip try/catch and recovery entirely.
    if (this.IS_SPECULATING) throw SPEC_FAIL;

    // Non-speculative: in-rule single-token recovery.
    let consumedToken!: IToken;
    try {
      this.consumeInternalError(tokType, nextToken, options);
    } catch (eFromConsumption) {
      consumedToken = this.consumeInternalRecovery(
        tokType,
        idx,
        eFromConsumption,
      );
    }
    this.cstPostTerminal(label, consumedToken);
    return consumedToken;
  }

  /**
   * Called when a CONSUME fails to match. During speculation (IS_SPECULATING)
   * throws SPEC_FAIL — a Symbol with zero allocation cost — instead of
   * allocating a MismatchedTokenException (which triggers captureStackTrace).
   */
  consumeInternalError(
    this: MixedInParser,
    tokType: TokenType,
    nextToken: IToken,
    options: ConsumeMethodOpts | undefined,
  ): void {
    if (this.IS_SPECULATING) {
      throw SPEC_FAIL;
    }
    let msg;
    const previousToken = this.LA(0);
    if (options !== undefined && options.ERR_MSG) {
      msg = options.ERR_MSG;
    } else {
      msg = this.errorMessageProvider.buildMismatchTokenMessage({
        expected: tokType,
        actual: nextToken,
        previous: previousToken,
        ruleName: this.getCurrRuleFullName(),
      });
    }
    throw this.SAVE_ERROR(
      new MismatchedTokenException(msg, nextToken, previousToken),
    );
  }

  /**
   * Attempts single-token insertion or deletion recovery for a failed
   * CONSUME. Only runs when `recoveryEnabled=true` AND not backtracking
   * (`IS_SPECULATING=false`). If recovery fails, re-throws the original
   * `MismatchedTokenException` for reSync handling in `invokeRuleCatch`.
   *
   * This is the entry point for Chevrotain's per-token error recovery.
   * OR's committed re-run temporarily clears `IS_SPECULATING` specifically
   * so this method can fire.
   */
  consumeInternalRecovery(
    this: MixedInParser,
    tokType: TokenType,
    idx: number,
    eFromConsumption: Error,
  ): IToken {
    if (
      this.recoveryEnabled &&
      // TODO: more robust checking of the exception type. Perhaps Typescript extending expressions?
      eFromConsumption.name === "MismatchedTokenException" &&
      !this.isBackTracking()
    ) {
      const follows = this.getFollowsForInRuleRecovery(<any>tokType, idx);
      try {
        return this.tryInRuleRecovery(<any>tokType, follows);
      } catch (eFromInRuleRecovery) {
        if (eFromInRuleRecovery.name === IN_RULE_RECOVERY_EXCEPTION) {
          // failed in RuleRecovery.
          // throw the original error in order to trigger reSync error recovery
          throw eFromConsumption;
        } else {
          throw eFromInRuleRecovery;
        }
      }
    } else {
      throw eFromConsumption;
    }
  }

  ruleInvocationStateUpdate(
    this: MixedInParser,
    shortName: number,
    fullName: string,
    idxInCallingRule: number,
  ): void {
    this.RULE_OCCURRENCE_STACK[++this.RULE_OCCURRENCE_STACK_IDX] =
      idxInCallingRule;
    const depth = ++this.RULE_STACK_IDX;
    this.RULE_STACK[depth] = shortName;
    this.currRuleShortName = shortName;
    // Save and reset the single DSL auto-occurrence counter.
    this._dslCounterStack[depth] = this._dslCounter;
    this._dslCounter = 0;
    // NOOP when cst is disabled
    this.cstInvocationStateUpdate(fullName);
  }

  /**
   * Returns true while inside a BACKTRACK() trial. Reads the boolean flag
   * directly — O(1) with no array length check.
   */
  isBackTracking(this: MixedInParser): boolean {
    return this.IS_SPECULATING;
  }

  getCurrRuleFullName(this: MixedInParser): string {
    const shortName = this.currRuleShortName;
    return this.shortRuleNameToFull[shortName];
  }

  shortRuleNameToFullName(this: MixedInParser, shortName: number) {
    return this.shortRuleNameToFull[shortName];
  }

  public isAtEndOfInput(this: MixedInParser): boolean {
    return this.tokenMatcher(this.LA(1), EOF);
  }

  public reset(this: MixedInParser): void {
    this.resetLexerState();
    this.subruleIdx = 0;
    this.currRuleShortName = 0;
    this.IS_SPECULATING = false;
    this.errors = [];
    // Reset depth counters but keep arrays allocated to avoid re-allocation.
    // Stale number values in unused slots are harmless.
    this.RULE_STACK_IDX = -1;
    this.RULE_OCCURRENCE_STACK_IDX = -1;
    // TODO: extract a specific reset for TreeBuilder trait
    this.CST_STACK = [];
  }

  /**
   * Hook called before the root-level parsing rule is invoked.
   * This is only called when a rule is invoked directly by the consumer
   * (e.g., `parser.json()`), not when invoked as a sub-rule via SUBRULE.
   *
   * Override this method to perform actions before parsing begins.
   * The default implementation is a no-op.
   *
   * @param ruleName - The name of the root rule being invoked.
   */
  onBeforeParse(this: MixedInParser, _ruleName: string): void {
    // Pad with sentinels for bounds-free forward LA()
    for (let i = 0; i < this.maxLookahead + 1; i++) {
      this.tokVector.push(END_OF_FILE);
    }
  }

  /**
   * Hook called after the root-level parsing rule has completed (or thrown).
   * This is only called when a rule is invoked directly by the consumer
   * (e.g., `parser.json()`), not when invoked as a sub-rule via SUBRULE.
   *
   * This hook is called in a `finally` block, so it executes regardless of
   * whether parsing succeeded or threw an error.
   *
   * Override this method to perform actions after parsing completes.
   * The default implementation is a no-op.
   *
   * @param ruleName - The name of the root rule that was invoked.
   */
  onAfterParse(this: MixedInParser, _ruleName: string): void {
    if (this.isAtEndOfInput() === false) {
      const firstRedundantTok = this.LA(1);
      const errMsg = this.errorMessageProvider.buildNotAllInputParsedMessage({
        firstRedundant: firstRedundantTok,
        ruleName: this.getCurrRuleFullName(),
      });
      this.SAVE_ERROR(
        new NotAllInputParsedException(errMsg, firstRedundantTok),
      );
    }

    // undo the padding of sentinels for bounds-free forward LA() in onBeforeParse
    while (this.tokVector.at(-1) === END_OF_FILE) {
      this.tokVector.pop();
    }
  }

  // --- PerformanceTracer (absorbed from trait) ---
  traceInitPerf!: boolean | number;
  traceInitMaxIdent!: number;
  traceInitIndent!: number;

  initPerformanceTracer(config: IParserConfig) {
    if (Object.hasOwn(config, "traceInitPerf")) {
      const userTraceInitPerf = config.traceInitPerf;
      const traceIsNumber = typeof userTraceInitPerf === "number";
      this.traceInitMaxIdent = traceIsNumber
        ? <number>userTraceInitPerf
        : Infinity;
      this.traceInitPerf = traceIsNumber
        ? userTraceInitPerf > 0
        : (userTraceInitPerf as boolean);
    } else {
      this.traceInitMaxIdent = 0;
      this.traceInitPerf = DEFAULT_PARSER_CONFIG.traceInitPerf;
    }
    this.traceInitIndent = -1;
  }

  // --- Recoverable (absorbed from trait) ---
  recoveryEnabled!: boolean;
  firstAfterRepMap!: Record<string, IFirstAfterRepetition>;
  resyncFollows!: Record<string, TokenType[]>;

  initRecoverable(config: IParserConfig) {
    this.firstAfterRepMap = {};
    this.resyncFollows = {};

    this.recoveryEnabled = Object.hasOwn(config, "recoveryEnabled")
      ? (config.recoveryEnabled as boolean) // assumes end user provides the correct config value/type
      : DEFAULT_PARSER_CONFIG.recoveryEnabled;

    // performance optimization, NOOP will be inlined which
    // effectively means that this optional feature does not exist
    // when not used.
    if (this.recoveryEnabled) {
      this.attemptInRepetitionRecovery = attemptInRepetitionRecovery;
    }
  }

  public getTokenToInsert(tokType: TokenType): IToken {
    const tokToInsert = createTokenInstance(
      tokType,
      "",
      NaN,
      NaN,
      NaN,
      NaN,
      NaN,
      NaN,
    );
    tokToInsert.isInsertedInRecovery = true;
    return tokToInsert;
  }

  public canTokenTypeBeInsertedInRecovery(tokType: TokenType): boolean {
    return true;
  }

  public canTokenTypeBeDeletedInRecovery(tokType: TokenType): boolean {
    return true;
  }

  tryInRepetitionRecovery(
    this: MixedInParser,
    grammarRule: Function,
    grammarRuleArgs: any[],
    lookAheadFunc: () => boolean,
    expectedTokType: TokenType,
  ): void {
    // TODO: can the resyncTokenType be cached?
    const reSyncTokType = this.findReSyncTokenType();
    const savedLexerState = this.exportLexerState();
    const resyncedTokens: IToken[] = [];
    let passedResyncPoint = false;

    const nextTokenWithoutResync = this.LA_FAST(1);
    let currToken = this.LA_FAST(1);

    const generateErrorMessage = () => {
      const previousToken = this.LA(0);
      // we are preemptively re-syncing before an error has been detected, therefor we must reproduce
      // the error that would have been thrown
      const msg = this.errorMessageProvider.buildMismatchTokenMessage({
        expected: expectedTokType,
        actual: nextTokenWithoutResync,
        previous: previousToken,
        ruleName: this.getCurrRuleFullName(),
      });
      const error = new MismatchedTokenException(
        msg,
        nextTokenWithoutResync,
        this.LA(0),
      );
      // the first token here will be the original cause of the error, this is not part of the resyncedTokens property.
      error.resyncedTokens = resyncedTokens.slice(0, -1);
      this.SAVE_ERROR(error);
    };

    while (!passedResyncPoint) {
      // re-synced to a point where we can safely exit the repetition/
      if (this.tokenMatcher(currToken, expectedTokType)) {
        generateErrorMessage();
        return; // must return here to avoid reverting the inputIdx
      } else if (lookAheadFunc.call(this)) {
        // we skipped enough tokens so we can resync right back into another iteration of the repetition grammar rule
        generateErrorMessage();
        // recursive invocation in other to support multiple re-syncs in the same top level repetition grammar rule
        grammarRule.apply(this, grammarRuleArgs);
        return; // must return here to avoid reverting the inputIdx
      } else if (this.tokenMatcher(currToken, reSyncTokType)) {
        passedResyncPoint = true;
      } else {
        currToken = this.SKIP_TOKEN();
        this.addToResyncTokens(currToken, resyncedTokens);
      }
    }

    // we were unable to find a CLOSER point to resync inside the Repetition, reset the state.
    // The parsing exception we were trying to prevent will happen in the NEXT parsing step. it may be handled by
    // "between rules" resync recovery later in the flow.
    this.importLexerState(savedLexerState);
  }

  shouldInRepetitionRecoveryBeTried(
    this: MixedInParser,
    expectTokAfterLastMatch: TokenType,
    nextTokIdx: number,
    notStuck: boolean | undefined,
  ): boolean {
    // Edge case of arriving from a MANY repetition which is stuck
    // Attempting recovery in this case could cause an infinite loop
    if (notStuck === false) {
      return false;
    }

    // no need to recover, next token is what we expect...
    if (this.tokenMatcher(this.LA_FAST(1), expectTokAfterLastMatch)) {
      return false;
    }

    // error recovery is disabled during backtracking as it can make the parser ignore a valid grammar path
    // and prefer some backtracking path that includes recovered errors.
    if (this.isBackTracking()) {
      return false;
    }

    // if we can perform inRule recovery (single token insertion or deletion) we always prefer that recovery algorithm
    // because if it works, it makes the least amount of changes to the input stream (greedy algorithm)
    //noinspection RedundantIfStatementJS
    if (
      this.canPerformInRuleRecovery(
        expectTokAfterLastMatch,
        this.getFollowsForInRuleRecovery(expectTokAfterLastMatch, nextTokIdx),
      )
    ) {
      return false;
    }

    return true;
  }

  // TODO: should this be a member method or a utility? it does not have any state or usage of 'this'...
  // TODO: should this be more explicitly part of the public API?
  getNextPossibleTokenTypes(
    this: MixedInParser,
    grammarPath: ITokenGrammarPath,
  ): TokenType[] {
    const topRuleName = grammarPath.ruleStack[0]!;
    const gastProductions = this.getGAstProductions();
    const topProduction = gastProductions[topRuleName];
    const nextPossibleTokenTypes = new NextAfterTokenWalker(
      topProduction,
      grammarPath,
    ).startWalking();
    return nextPossibleTokenTypes;
  }

  // Error Recovery functionality
  getFollowsForInRuleRecovery(
    this: MixedInParser,
    tokType: TokenType,
    tokIdxInRule: number,
  ): TokenType[] {
    const grammarPath = this.getCurrentGrammarPath(tokType, tokIdxInRule);
    const follows = this.getNextPossibleTokenTypes(grammarPath);
    return follows;
  }

  tryInRuleRecovery(
    this: MixedInParser,
    expectedTokType: TokenType,
    follows: TokenType[],
  ): IToken {
    if (this.canRecoverWithSingleTokenInsertion(expectedTokType, follows)) {
      const tokToInsert = this.getTokenToInsert(expectedTokType);
      return tokToInsert;
    }

    if (this.canRecoverWithSingleTokenDeletion(expectedTokType)) {
      const nextTok = this.SKIP_TOKEN();
      this.consumeToken();
      return nextTok;
    }

    throw new InRuleRecoveryException("sad sad panda");
  }

  canPerformInRuleRecovery(
    this: MixedInParser,
    expectedToken: TokenType,
    follows: TokenType[],
  ): boolean {
    return (
      this.canRecoverWithSingleTokenInsertion(expectedToken, follows) ||
      this.canRecoverWithSingleTokenDeletion(expectedToken)
    );
  }

  canRecoverWithSingleTokenInsertion(
    this: MixedInParser,
    expectedTokType: TokenType,
    follows: TokenType[],
  ): boolean {
    if (!this.canTokenTypeBeInsertedInRecovery(expectedTokType)) {
      return false;
    }

    // must know the possible following tokens to perform single token insertion
    if (follows.length === 0) {
      return false;
    }

    const mismatchedTok = this.LA_FAST(1);
    const isMisMatchedTokInFollows =
      follows.find((possibleFollowsTokType: TokenType) => {
        return this.tokenMatcher(mismatchedTok, possibleFollowsTokType);
      }) !== undefined;

    return isMisMatchedTokInFollows;
  }

  canRecoverWithSingleTokenDeletion(
    this: MixedInParser,
    expectedTokType: TokenType,
  ): boolean {
    if (!this.canTokenTypeBeDeletedInRecovery(expectedTokType)) {
      return false;
    }

    const isNextTokenWhatIsExpected = this.tokenMatcher(
      // not using LA_FAST because LA(2) might be un-safe with maxLookahead=1
      // in some edge cases (?)
      this.LA(2),
      expectedTokType,
    );
    return isNextTokenWhatIsExpected;
  }

  isInCurrentRuleReSyncSet(
    this: MixedInParser,
    tokenTypeIdx: TokenType,
  ): boolean {
    const followKey = this.getCurrFollowKey();
    const currentRuleReSyncSet = this.getFollowSetFromFollowKey(followKey);
    return currentRuleReSyncSet.includes(tokenTypeIdx);
  }

  /**
   * Scans forward until finding a token whose type is in the follow set,
   * signalling where the parser can safely resume. Uses a Set built once by
   * flattenFollowSet() so each token is an O(1) lookup instead of O(n) scan.
   * LA_FAST is safe here because sentinel EOF tokens pad the end of tokVector.
   */
  findReSyncTokenType(this: MixedInParser): TokenType {
    const reSyncSet = this.flattenFollowSet();
    // always terminates: EOF is always in the follow set and always in the input
    let nextToken = this.LA_FAST(1);
    let k = 2;
    while (true) {
      const match = reSyncSet.get(nextToken.tokenTypeIdx);
      if (match !== undefined) {
        return match;
      }
      nextToken = this.LA_FAST(k++);
    }
  }

  getCurrFollowKey(this: MixedInParser): IFollowKey {
    // the length is at least one as we always add the ruleName to the stack before invoking the rule.
    if (this.RULE_STACK_IDX === 0) {
      return EOF_FOLLOW_KEY;
    }
    const currRuleShortName = this.currRuleShortName;
    const currRuleIdx = this.getLastExplicitRuleOccurrenceIndex();
    const prevRuleShortName = this.getPreviousExplicitRuleShortName();

    return {
      ruleName: this.shortRuleNameToFullName(currRuleShortName),
      idxInCallingRule: currRuleIdx,
      inRule: this.shortRuleNameToFullName(prevRuleShortName),
    };
  }

  buildFullFollowKeyStack(this: MixedInParser): IFollowKey[] {
    const explicitRuleStack = this.RULE_STACK;
    const explicitOccurrenceStack = this.RULE_OCCURRENCE_STACK;
    const len = this.RULE_STACK_IDX + 1;

    const result: IFollowKey[] = new Array(len);
    for (let idx = 0; idx < len; idx++) {
      if (idx === 0) {
        result[idx] = EOF_FOLLOW_KEY;
      } else {
        result[idx] = {
          ruleName: this.shortRuleNameToFullName(explicitRuleStack[idx]),
          idxInCallingRule: explicitOccurrenceStack[idx],
          inRule: this.shortRuleNameToFullName(explicitRuleStack[idx - 1]),
        };
      }
    }
    return result;
  }

  /**
   * Builds a Map from concrete tokenTypeIdx → follow-set TokenType for the
   * current rule stack. Keying by index instead of object reference gives O(1)
   * lookup in findReSyncTokenType without a linear scan per token. Category
   * types are expanded so every concrete member maps to its category — the
   * category object is returned by findReSyncTokenType so callers that check
   * isInCurrentRuleReSyncSet still get the right follow-set entry.
   */
  flattenFollowSet(this: MixedInParser): Map<number, TokenType> {
    const result = new Map<number, TokenType>();
    for (const key of this.buildFullFollowKeyStack()) {
      for (const tokType of this.getFollowSetFromFollowKey(key)) {
        if (tokType.isParent) {
          for (const idx of tokType.categoryMatches!) {
            if (!result.has(idx)) result.set(idx, tokType);
          }
        } else {
          if (!result.has(tokType.tokenTypeIdx!))
            result.set(tokType.tokenTypeIdx!, tokType);
        }
      }
    }
    return result;
  }

  getFollowSetFromFollowKey(
    this: MixedInParser,
    followKey: IFollowKey,
  ): TokenType[] {
    if (followKey === EOF_FOLLOW_KEY) {
      return [EOF];
    }

    const followName =
      followKey.ruleName + followKey.idxInCallingRule + IN + followKey.inRule;

    return this.resyncFollows[followName];
  }

  // It does not make any sense to include a virtual EOF token in the list of resynced tokens
  // as EOF does not really exist and thus does not contain any useful information (line/column numbers)
  addToResyncTokens(
    this: MixedInParser,
    token: IToken,
    resyncTokens: IToken[],
  ): IToken[] {
    if (!this.tokenMatcher(token, EOF)) {
      resyncTokens.push(token);
    }
    return resyncTokens;
  }

  reSyncTo(this: MixedInParser, tokType: TokenType): IToken[] {
    const resyncedTokens: IToken[] = [];
    let nextTok = this.LA_FAST(1);
    while (this.tokenMatcher(nextTok, tokType) === false) {
      nextTok = this.SKIP_TOKEN();
      this.addToResyncTokens(nextTok, resyncedTokens);
    }
    // the last token is not part of the error.
    return resyncedTokens.slice(0, -1);
  }

  attemptInRepetitionRecovery(
    this: MixedInParser,
    prodFunc: Function,
    args: any[],
    lookaheadFunc: () => boolean,
    dslMethodIdx: number,
    prodOccurrence: number,
    nextToksWalker: typeof AbstractNextTerminalAfterProductionWalker,
    notStuck?: boolean,
  ): void {
    // by default this is a NO-OP
    // The actual implementation is with the function(not method) below
  }

  getCurrentGrammarPath(
    this: MixedInParser,
    tokType: TokenType,
    tokIdxInRule: number,
  ): ITokenGrammarPath {
    const pathRuleStack: string[] = this.getHumanReadableRuleStack();
    const pathOccurrenceStack: number[] = this.RULE_OCCURRENCE_STACK.slice(
      0,
      this.RULE_OCCURRENCE_STACK_IDX + 1,
    );
    const grammarPath: any = {
      ruleStack: pathRuleStack,
      occurrenceStack: pathOccurrenceStack,
      lastTok: tokType,
      lastTokOccurrence: tokIdxInRule,
    };

    return grammarPath;
  }

  getHumanReadableRuleStack(this: MixedInParser): string[] {
    const len = this.RULE_STACK_IDX + 1;
    const result: string[] = new Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = this.shortRuleNameToFullName(this.RULE_STACK[i]);
    }
    return result;
  }

  // --- RecognizerApi (absorbed from trait) ---
  ACTION<T>(this: MixedInParser, impl: () => T): T {
    if (this.RECORDING_PHASE) return this.ACTION_RECORD(impl);
    return impl.call(this);
  }

  // ──── lowercase consume ────
  consume(
    this: MixedInParser,
    _idx: number,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  // ──── lowercase subrule ────
  subrule<ARGS extends unknown[], R>(
    this: MixedInParser,
    _idx: number,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  // ──── lowercase option ────
  option<OUT>(
    this: MixedInParser,
    _idx: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  // ──── lowercase or ────
  or(
    this: MixedInParser,
    _idx: number,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<any>,
  ): any {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) return this.orInternalRecord(altsOrOpts, idx);
    return this.orInternal(altsOrOpts, idx);
  }

  // ──── lowercase many ────
  many(
    this: MixedInParser,
    _idx: number,
    actionORMethodDef: GrammarAction<any> | DSLMethodOpts<any>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    return this.manyInternal(idx, actionORMethodDef);
  }

  // ──── lowercase atLeastOne ────
  atLeastOne(
    this: MixedInParser,
    _idx: number,
    actionORMethodDef: GrammarAction<any> | DSLMethodOptsWithErr<any>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    return this.atLeastOneInternal(idx, actionORMethodDef);
  }

  // ──── CONSUME family ────
  CONSUME(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME1(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME2(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME3(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME4(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME5(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME6(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME7(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME8(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  CONSUME9(
    this: MixedInParser,
    tokType: TokenType,
    options?: ConsumeMethodOpts,
  ): IToken {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.consumeInternalRecord(tokType, idx, options);
    return this.consumeInternal(tokType, idx, options);
  }

  // ──── SUBRULE family ────
  SUBRULE<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE1<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE2<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE3<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE4<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE5<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE6<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE7<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE8<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  SUBRULE9<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    options?: SubruleMethodOpts<ARGS>,
  ): R {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.subruleInternalRecord(ruleToCall, idx, options) as R;
    return this.subruleInternal(ruleToCall, idx, options);
  }

  // ──── OPTION family ────
  OPTION<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION1<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION2<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION3<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION4<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION5<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION6<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION7<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION8<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  OPTION9<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): OUT | undefined {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE)
      return this.optionInternalRecord(actionORMethodDef, idx) as OUT;
    return this.optionInternal(actionORMethodDef, idx);
  }

  /**
   * Committed LL(1) fast dispatch -- shared by OR, OR1-OR9, and lowercase or.
   */

  // ──── OR family ────
  OR<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      return this.orInternalRecord(altsOrOpts, idx) as T;
    }
    return this.orInternal(altsOrOpts, idx);
  }

  OR1<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR2<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR3<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR4<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR5<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR6<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR7<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR8<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  OR9<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
  ): T {
    return this.OR(altsOrOpts);
  }

  // ──── MANY family ────
  MANY<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY1<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY2<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY3<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY4<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY5<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY6<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY7<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY8<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  MANY9<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manyInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.manyInternal(idx, actionORMethodDef);
  }

  // ──── MANY_SEP family ────
  MANY_SEP<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP1<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP2<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP3<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP4<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP5<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP6<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP7<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP8<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  MANY_SEP9<OUT>(this: MixedInParser, options: ManySepMethodOpts<OUT>): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.manySepFirstInternalRecord(idx, options);
      return;
    }
    this.manySepFirstInternal(idx, options);
  }

  // ──── AT_LEAST_ONE family ────
  AT_LEAST_ONE<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE1<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE2<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE3<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE4<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE5<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE6<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE7<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE8<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  AT_LEAST_ONE9<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneInternalRecord(idx, actionORMethodDef);
      return;
    }
    this.atLeastOneInternal(idx, actionORMethodDef);
  }

  // ──── AT_LEAST_ONE_SEP family ────
  AT_LEAST_ONE_SEP<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP1<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP2<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP3<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP4<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP5<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP6<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP7<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP8<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  AT_LEAST_ONE_SEP9<OUT>(
    this: MixedInParser,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    const idx = this._dslCounter++;
    if (this.RECORDING_PHASE) {
      this.atLeastOneSepFirstInternalRecord(idx, options);
      return;
    }
    this.atLeastOneSepFirstInternal(idx, options);
  }

  RULE<T>(
    this: MixedInParser,
    name: string,
    implementation: (...implArgs: any[]) => T,
    config: IRuleConfig<T> = DEFAULT_RULE_CONFIG,
  ): (idxInCallingRule?: number, ...args: any[]) => T | any {
    if (this.definedRulesNames.includes(name)) {
      const errMsg =
        defaultGrammarValidatorErrorProvider.buildDuplicateRuleNameError({
          topLevelRule: name,
          grammarName: this.className,
        });

      const error = {
        message: errMsg,
        type: ParserDefinitionErrorType.DUPLICATE_RULE_NAME,
        ruleName: name,
      };
      this.definitionErrors.push(error);
    }

    this.definedRulesNames.push(name);

    const ruleImplementation = this.defineRule(name, implementation, config);
    (this as any)[name] = ruleImplementation;
    return ruleImplementation;
  }

  OVERRIDE_RULE<T>(
    this: MixedInParser,
    name: string,
    impl: (...implArgs: any[]) => T,
    config: IRuleConfig<T> = DEFAULT_RULE_CONFIG,
  ): (idxInCallingRule?: number, ...args: any[]) => T {
    const ruleErrors: IParserDefinitionError[] = validateRuleIsOverridden(
      name,
      this.definedRulesNames,
      this.className,
    );
    this.definitionErrors = this.definitionErrors.concat(ruleErrors);

    const ruleImplementation = this.defineRule(name, impl, config);
    (this as any)[name] = ruleImplementation;
    return ruleImplementation;
  }

  /**
   * Returns a zero-argument predicate that speculatively runs `grammarRule`
   * and returns true if it succeeds. On failure, state is restored via three
   * integer assignments (no array copies). Uses SPEC_FAIL (a Symbol) as the
   * failure signal so V8 never allocates an Error during failed alternatives.
   */
  BACKTRACK<T>(
    this: MixedInParser,
    grammarRule: (...args: any[]) => T,
    args?: any[],
  ): () => boolean {
    if (this.RECORDING_PHASE) return this.BACKTRACK_RECORD(grammarRule, args);
    // Use coreRule to bypass root-level hooks (onBeforeParse/onAfterParse).
    // Backtracking is speculative and should not trigger parse lifecycle hooks.
    const ruleToCall = (grammarRule as any).coreRule ?? grammarRule;
    return function (this: MixedInParser) {
      const prevIsSpeculating = this.IS_SPECULATING;
      const prevIsInTrueBacktrack = this._isInTrueBacktrack;
      this.IS_SPECULATING = true;
      this._isInTrueBacktrack = true;
      const savedPos = this.currIdx;
      const savedErrors = this._errors.length;
      const savedRuleStack = this.RULE_STACK_IDX;
      try {
        ruleToCall.apply(this, args);
        return true;
      } catch (e) {
        if (e === SPEC_FAIL || isRecognitionException(e)) {
          return false;
        } else {
          throw e;
        }
      } finally {
        this.currIdx = savedPos;
        this._errors.length = savedErrors;
        this.RULE_STACK_IDX = savedRuleStack;
        this.IS_SPECULATING = prevIsSpeculating;
        this._isInTrueBacktrack = prevIsInTrueBacktrack;
      }
    };
  }

  // GAST export APIs
  public getGAstProductions(this: MixedInParser): Record<string, Rule> {
    this.ensureGastProductionsCachePopulated();
    return this.gastProductionsCache;
  }

  public getSerializedGastProductions(this: MixedInParser): ISerializedGast[] {
    this.ensureGastProductionsCachePopulated();
    return serializeGrammar(Object.values(this.gastProductionsCache));
  }

  // --- TreeBuilder (absorbed from trait) ---
  outputCst!: boolean;
  CST_STACK!: CstNode[];
  baseCstVisitorConstructor!: Function;
  baseCstVisitorWithDefaultsConstructor!: Function;

  // dynamically assigned Methods
  setNodeLocationFromNode!: (
    nodeLocation: CstNodeLocation,
    locationInformation: CstNodeLocation,
  ) => void;
  setNodeLocationFromToken!: (
    nodeLocation: CstNodeLocation,
    locationInformation: CstNodeLocation,
  ) => void;
  cstPostRule!: (this: MixedInParser, ruleCstNode: CstNode) => void;

  setInitialNodeLocation!: (cstNode: CstNode) => void;
  nodeLocationTracking!: nodeLocationTrackingOptions;

  saveCstTop!: (this: MixedInParser) => CstTopSave | null;
  restoreCstTop!: (this: MixedInParser, save: CstTopSave | null) => void;

  initTreeBuilder(this: MixedInParser, config: IParserConfig) {
    this.CST_STACK = [];

    // outputCst is no longer exposed/defined in the pubic API
    this.outputCst = (config as any).outputCst;

    this.nodeLocationTracking = Object.hasOwn(config, "nodeLocationTracking")
      ? (config.nodeLocationTracking as nodeLocationTrackingOptions)
      : DEFAULT_PARSER_CONFIG.nodeLocationTracking;

    if (!this.outputCst) {
      this.cstInvocationStateUpdate = () => {};
      this.cstFinallyStateUpdate = () => {};
      this.cstPostTerminal = () => {};
      this.cstPostNonTerminal = () => {};
      this.cstPostRule = () => {};
      this.saveCstTop = () => null;
      this.restoreCstTop = () => {};
    } else {
      if (/full/i.test(this.nodeLocationTracking)) {
        if (this.recoveryEnabled) {
          this.setNodeLocationFromToken = setNodeLocationFull;
          this.setNodeLocationFromNode = setNodeLocationFull;
          this.cstPostRule = () => {};
          this.setInitialNodeLocation = this.setInitialNodeLocationFullRecovery;
        } else {
          this.setNodeLocationFromToken = () => {};
          this.setNodeLocationFromNode = () => {};
          this.cstPostRule = this.cstPostRuleFull;
          this.setInitialNodeLocation = this.setInitialNodeLocationFullRegular;
        }
      } else if (/onlyOffset/i.test(this.nodeLocationTracking)) {
        if (this.recoveryEnabled) {
          this.setNodeLocationFromToken = <any>setNodeLocationOnlyOffset;
          this.setNodeLocationFromNode = <any>setNodeLocationOnlyOffset;
          this.cstPostRule = () => {};
          this.setInitialNodeLocation =
            this.setInitialNodeLocationOnlyOffsetRecovery;
        } else {
          this.setNodeLocationFromToken = () => {};
          this.setNodeLocationFromNode = () => {};
          this.cstPostRule = this.cstPostRuleOnlyOffset;
          this.setInitialNodeLocation =
            this.setInitialNodeLocationOnlyOffsetRegular;
        }
      } else if (/none/i.test(this.nodeLocationTracking)) {
        this.setNodeLocationFromToken = () => {};
        this.setNodeLocationFromNode = () => {};
        this.cstPostRule = () => {};
        this.setInitialNodeLocation = () => {};
      } else {
        throw Error(
          `Invalid <nodeLocationTracking> config option: "${config.nodeLocationTracking}"`,
        );
      }
      // CST watermark helpers are the same regardless of location-tracking mode.
      this.saveCstTop = this.saveCstTopImpl;
      this.restoreCstTop = this.restoreCstTopImpl;
    }
  }

  setInitialNodeLocationOnlyOffsetRecovery(
    this: MixedInParser,
    cstNode: any,
  ): void {
    cstNode.location = createCstLocationOnlyOffset();
  }

  setInitialNodeLocationOnlyOffsetRegular(
    this: MixedInParser,
    cstNode: any,
  ): void {
    const loc = createCstLocationOnlyOffset();
    loc.startOffset = this.LA_FAST(1).startOffset;
    cstNode.location = loc;
  }

  setInitialNodeLocationFullRecovery(this: MixedInParser, cstNode: any): void {
    cstNode.location = createCstLocationFull();
  }

  setInitialNodeLocationFullRegular(this: MixedInParser, cstNode: any): void {
    const nextToken = this.LA_FAST(1);
    const loc = createCstLocationFull();
    loc.startOffset = nextToken.startOffset;
    loc.startLine = nextToken.startLine;
    loc.startColumn = nextToken.startColumn;
    cstNode.location = loc;
  }

  cstInvocationStateUpdate(this: MixedInParser, fullRuleName: string): void {
    const cstNode = createCstNode(fullRuleName);
    this.setInitialNodeLocation(cstNode);
    this.CST_STACK.push(cstNode);
  }

  cstFinallyStateUpdate(this: MixedInParser): void {
    this.CST_STACK.pop();
  }

  cstPostRuleFull(this: MixedInParser, ruleCstNode: CstNode): void {
    const prevToken = this.LA(0) as Required<CstNodeLocation>;
    const loc = ruleCstNode.location as Required<CstNodeLocation>;

    if (loc.startOffset <= prevToken.startOffset === true) {
      loc.endOffset = prevToken.endOffset;
      loc.endLine = prevToken.endLine;
      loc.endColumn = prevToken.endColumn;
    } else {
      loc.startOffset = NaN;
      loc.startLine = NaN;
      loc.startColumn = NaN;
    }
  }

  cstPostRuleOnlyOffset(this: MixedInParser, ruleCstNode: CstNode): void {
    const prevToken = this.LA(0);
    const loc = ruleCstNode.location!;

    if (loc.startOffset <= prevToken.startOffset === true) {
      loc.endOffset = prevToken.endOffset;
    } else {
      loc.startOffset = NaN;
    }
  }

  cstPostTerminal(
    this: MixedInParser,
    key: string,
    consumedToken: IToken,
  ): void {
    const rootCst = this.CST_STACK[this.CST_STACK.length - 1];
    addTerminalToCst(rootCst, consumedToken, key);
    this.setNodeLocationFromToken(rootCst.location!, <any>consumedToken);
  }

  cstPostNonTerminal(
    this: MixedInParser,
    ruleCstResult: CstNode,
    ruleName: string,
  ): void {
    const preCstNode = this.CST_STACK[this.CST_STACK.length - 1];
    addNoneTerminalToCst(preCstNode, ruleName, ruleCstResult);
    this.setNodeLocationFromNode(preCstNode.location!, ruleCstResult.location!);
  }

  saveCstTopImpl(this: MixedInParser): CstTopSave | null {
    if (this.IS_SPECULATING) return null;
    const top = this.CST_STACK[this.CST_STACK.length - 1];
    if (top === undefined) return null;
    const src = top.children;
    const srcKeys = Object.keys(src);
    const keys: string[] = new Array(srcKeys.length);
    const lens: number[] = new Array(srcKeys.length);
    for (let i = 0; i < srcKeys.length; i++) {
      keys[i] = srcKeys[i];
      lens[i] = src[srcKeys[i]].length;
    }
    return {
      keys,
      lens,
      location:
        top.location !== undefined
          ? ({ ...top.location } as Record<string, number>)
          : undefined,
    };
  }

  restoreCstTopImpl(this: MixedInParser, save: CstTopSave | null): void {
    if (save === null) return;
    const top = this.CST_STACK[this.CST_STACK.length - 1];
    if (top === undefined) return;
    const { keys, lens } = save;
    const ch = top.children;
    for (let i = 0; i < keys.length; i++) {
      ch[keys[i]].length = lens[i];
    }
    if (save.location !== undefined) {
      (top as any).location = save.location;
    }
  }

  getBaseCstVisitorConstructor<IN = any, OUT = any>(
    this: MixedInParser,
  ): {
    new (...args: any[]): ICstVisitor<IN, OUT>;
  } {
    if (this.baseCstVisitorConstructor === undefined) {
      const newBaseCstVisitorConstructor = createBaseSemanticVisitorConstructor(
        this.className,
        this.definedRulesNames,
      );
      this.baseCstVisitorConstructor = newBaseCstVisitorConstructor;
      return newBaseCstVisitorConstructor;
    }

    return <any>this.baseCstVisitorConstructor;
  }

  getBaseCstVisitorConstructorWithDefaults<IN = any, OUT = any>(
    this: MixedInParser,
  ): {
    new (...args: any[]): ICstVisitor<IN, OUT>;
  } {
    if (this.baseCstVisitorWithDefaultsConstructor === undefined) {
      const newConstructor = createBaseVisitorConstructorWithDefaults(
        this.className,
        this.definedRulesNames,
        this.getBaseCstVisitorConstructor(),
      );
      this.baseCstVisitorWithDefaultsConstructor = newConstructor;
      return newConstructor;
    }

    return <any>this.baseCstVisitorWithDefaultsConstructor;
  }

  getPreviousExplicitRuleShortName(this: MixedInParser): number {
    return this.RULE_STACK[this.RULE_STACK_IDX - 1];
  }

  getLastExplicitRuleOccurrenceIndex(this: MixedInParser): number {
    return this.RULE_OCCURRENCE_STACK[this.RULE_OCCURRENCE_STACK_IDX];
  }

  // --- GastRecorder (absorbed from trait) ---
  recordingProdStack!: ProdWithDef[];
  RECORDING_PHASE!: boolean;

  initGastRecorder(this: MixedInParser, config: IParserConfig): void {
    this.recordingProdStack = [];
    this.RECORDING_PHASE = false;
  }

  enableRecording(this: MixedInParser): void {
    this.RECORDING_PHASE = true;
  }

  disableRecording(this: MixedInParser) {
    this.RECORDING_PHASE = false;
  }

  // @ts-expect-error -- noop place holder
  ACTION_RECORD<T>(this: MixedInParser, impl: () => T): T {
    // NO-OP during recording
  }

  BACKTRACK_RECORD<T>(
    grammarRule: (...args: any[]) => T,
    args?: any[],
  ): () => boolean {
    return () => true;
  }

  LA_RECORD(howMuch: number): IToken {
    return END_OF_FILE;
  }

  topLevelRuleRecord(this: MixedInParser, name: string, def: Function): Rule {
    try {
      const newTopLevelRule = new Rule({ definition: [], name: name });
      newTopLevelRule.name = name;
      this.recordingProdStack.push(newTopLevelRule);
      const depth = ++this.RULE_STACK_IDX;
      const shortName = this.fullRuleNameToShort[name] ?? 0;
      this.RULE_STACK[depth] = shortName;
      this.currRuleShortName = shortName;
      this._dslCounterStack[depth] = this._dslCounter;
      this._dslCounter = 0;
      def.call(this);
      this._dslCounter = this._dslCounterStack[depth];
      this.RULE_STACK_IDX--;
      if (this.RULE_STACK_IDX >= 0) {
        this.currRuleShortName = this.RULE_STACK[this.RULE_STACK_IDX];
      }
      this.recordingProdStack.pop();
      return newTopLevelRule;
    } catch (originalError) {
      if (originalError.KNOWN_RECORDER_ERROR !== true) {
        try {
          originalError.message =
            originalError.message +
            '\n\t This error was thrown during the "grammar recording phase" For more info see:\n\t' +
            "https://chevrotain.io/docs/guide/internals.html#grammar-recording";
        } catch (mutabilityError) {
          throw originalError;
        }
      }
      throw originalError;
    }
  }

  optionInternalRecord<OUT>(
    this: MixedInParser,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
    occurrence: number,
  ): OUT {
    return gastRecordProd.call(this, Option, actionORMethodDef, occurrence);
  }

  atLeastOneInternalRecord<OUT>(
    this: MixedInParser,
    occurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOptsWithErr<OUT>,
  ): void {
    gastRecordProd.call(
      this,
      RepetitionMandatory,
      actionORMethodDef,
      occurrence,
    );
  }

  atLeastOneSepFirstInternalRecord<OUT>(
    this: MixedInParser,
    occurrence: number,
    options: AtLeastOneSepMethodOpts<OUT>,
  ): void {
    gastRecordProd.call(
      this,
      RepetitionMandatoryWithSeparator,
      options,
      occurrence,
      HANDLE_SEPARATOR,
    );
  }

  manyInternalRecord<OUT>(
    this: MixedInParser,
    occurrence: number,
    actionORMethodDef: GrammarAction<OUT> | DSLMethodOpts<OUT>,
  ): void {
    gastRecordProd.call(this, Repetition, actionORMethodDef, occurrence);
  }

  manySepFirstInternalRecord<OUT>(
    this: MixedInParser,
    occurrence: number,
    options: ManySepMethodOpts<OUT>,
  ): void {
    gastRecordProd.call(
      this,
      RepetitionWithSeparator,
      options,
      occurrence,
      HANDLE_SEPARATOR,
    );
  }

  orInternalRecord<T>(
    this: MixedInParser,
    altsOrOpts: IOrAlt<any>[] | OrMethodOpts<unknown>,
    occurrence: number,
  ): T {
    return gastRecordOrProd.call(this, altsOrOpts, occurrence);
  }

  subruleInternalRecord<ARGS extends unknown[], R>(
    this: MixedInParser,
    ruleToCall: ParserMethodInternal<ARGS, R>,
    occurrence: number,
    options?: SubruleMethodOpts<ARGS>,
  ): R | CstNode {
    gastAssertMethodIdxIsValid(occurrence);
    if (!ruleToCall || !Object.hasOwn(ruleToCall, "ruleName")) {
      const error: any = new Error(
        `<SUBRULE${gastGetIdxSuffix(occurrence)}> argument is invalid` +
          ` expecting a Parser method reference but got: <${JSON.stringify(
            ruleToCall,
          )}>` +
          `\n inside top level rule: <${
            (<Rule>this.recordingProdStack[0]).name
          }>`,
      );
      error.KNOWN_RECORDER_ERROR = true;
      throw error;
    }

    const prevProd: any = this.recordingProdStack.at(-1);
    const ruleName = ruleToCall.ruleName;
    const newNoneTerminal = new NonTerminal({
      idx: occurrence,
      nonTerminalName: ruleName,
      label: options?.LABEL,
      referencedRule: undefined,
    });
    prevProd.definition.push(newNoneTerminal);

    return this.outputCst
      ? RECORDING_PHASE_CSTNODE
      : <any>RECORDING_NULL_OBJECT;
  }

  consumeInternalRecord(
    this: MixedInParser,
    tokType: TokenType,
    occurrence: number,
    options?: ConsumeMethodOpts,
  ): IToken {
    gastAssertMethodIdxIsValid(occurrence);
    if (!hasShortKeyProperty(tokType)) {
      const error: any = new Error(
        `<CONSUME${gastGetIdxSuffix(occurrence)}> argument is invalid` +
          ` expecting a TokenType reference but got: <${JSON.stringify(
            tokType,
          )}>` +
          `\n inside top level rule: <${
            (<Rule>this.recordingProdStack[0]).name
          }>`,
      );
      error.KNOWN_RECORDER_ERROR = true;
      throw error;
    }
    const prevProd: any = this.recordingProdStack.at(-1);
    const newNoneTerminal = new Terminal({
      idx: occurrence,
      terminalType: tokType,
      label: options?.LABEL,
    });
    prevProd.definition.push(newNoneTerminal);

    return RECORDING_PHASE_TOKEN;
  }

  // --- LooksAhead (absorbed from trait) ---
  maxLookahead!: number;
  dynamicTokensEnabled!: boolean;
  lookaheadStrategy!: ILookaheadStrategy;

  initLooksAhead(config: IParserConfig) {
    this.dynamicTokensEnabled = Object.hasOwn(config, "dynamicTokensEnabled")
      ? (config.dynamicTokensEnabled as boolean)
      : DEFAULT_PARSER_CONFIG.dynamicTokensEnabled;

    this.maxLookahead = Object.hasOwn(config, "maxLookahead")
      ? (config.maxLookahead as number)
      : DEFAULT_PARSER_CONFIG.maxLookahead;

    this.lookaheadStrategy = Object.hasOwn(config, "lookaheadStrategy")
      ? (config.lookaheadStrategy as ILookaheadStrategy)
      : new LLkLookaheadStrategy({ maxLookahead: this.maxLookahead });
  }

  // --- ErrorHandler (absorbed from trait) ---
  _errors!: IRecognitionException[];
  errorMessageProvider!: IParserErrorMessageProvider;

  initErrorHandler(config: IParserConfig) {
    this._errors = [];
    this.errorMessageProvider = Object.hasOwn(config, "errorMessageProvider")
      ? (config.errorMessageProvider as IParserErrorMessageProvider)
      : DEFAULT_PARSER_CONFIG.errorMessageProvider;
  }

  SAVE_ERROR(
    this: MixedInParser,
    error: IRecognitionException,
  ): IRecognitionException {
    if (isRecognitionException(error)) {
      error.context = {
        ruleStack: this.getHumanReadableRuleStack(),
        ruleOccurrenceStack: this.RULE_OCCURRENCE_STACK.slice(
          0,
          this.RULE_OCCURRENCE_STACK_IDX + 1,
        ),
      };
      this._errors.push(error);
      return error;
    } else {
      throw Error(
        "Trying to save an Error which is not a RecognitionException",
      );
    }
  }

  get errors(): IRecognitionException[] {
    return [...this._errors];
  }

  set errors(newErrors: IRecognitionException[]) {
    this._errors = newErrors;
  }

  raiseEarlyExitException(
    this: MixedInParser,
    occurrence: number,
    prodType: PROD_TYPE,
    userDefinedErrMsg: string | undefined,
  ): never {
    if (this.IS_SPECULATING) throw SPEC_FAIL;
    const ruleName = this.getCurrRuleFullName();
    const ruleGrammar = this.getGAstProductions()[ruleName];

    let insideProdPaths: TokenType[][] | undefined;
    if (ruleGrammar !== undefined) {
      const lookAheadPathsPerAlternative = getLookaheadPathsForOptionalProd(
        occurrence,
        ruleGrammar,
        prodType,
        this.maxLookahead,
      );
      insideProdPaths = lookAheadPathsPerAlternative[0];
    }
    const actualTokens = [];
    for (let i = 1; i <= this.maxLookahead; i++) {
      actualTokens.push(this.LA(i));
    }
    const msg = this.errorMessageProvider.buildEarlyExitMessage({
      expectedIterationPaths: insideProdPaths ?? [],
      actual: actualTokens,
      previous: this.LA(0),
      customUserDescription: userDefinedErrMsg,
      ruleName: ruleName,
    });

    throw this.SAVE_ERROR(new EarlyExitException(msg, this.LA(1), this.LA(0)));
  }

  raiseNoAltException(
    this: MixedInParser,
    occurrence: number,
    errMsgTypes: string | undefined,
  ): never {
    if (this.IS_SPECULATING) throw SPEC_FAIL;
    const ruleName = this.getCurrRuleFullName();
    const ruleGrammar = this.getGAstProductions()[ruleName];
    const lookAheadPathsPerAlternative = getLookaheadPathsForOr(
      occurrence,
      ruleGrammar,
      this.maxLookahead,
    );

    const actualTokens = [];
    for (let i = 1; i <= this.maxLookahead; i++) {
      actualTokens.push(this.LA(i));
    }
    const previousToken = this.LA(0);

    const errMsg = this.errorMessageProvider.buildNoViableAltMessage({
      expectedPathsPerAlt: lookAheadPathsPerAlternative,
      actual: actualTokens,
      previous: previousToken,
      customUserDescription: errMsgTypes,
      ruleName: this.getCurrRuleFullName(),
    });

    throw this.SAVE_ERROR(
      new NoViableAltException(errMsg, this.LA(1), previousToken),
    );
  }

  // --- LexerAdapter (absorbed from trait) ---
  tokVector!: IToken[];
  tokVectorLength!: number;
  currIdx!: number;

  initLexerAdapter() {
    this.tokVector = [];
    this.tokVectorLength = 0;
    this.currIdx = -1;
  }

  set input(newInput: IToken[]) {
    // @ts-ignore - `this parameter` not supported in setters/getters
    const parser = this as unknown as MixedInParser;
    if (!parser.selfAnalysisDone) {
      parser.ensureGastProductionsCachePopulated();
    }
    parser.reset();
    parser.tokVector = newInput;
    parser.tokVectorLength = newInput.length;
  }

  get input(): IToken[] {
    return this.tokVector;
  }

  SKIP_TOKEN(this: MixedInParser): IToken {
    if (this.currIdx <= this.tokVectorLength - 2) {
      this.consumeToken();
      return this.LA_FAST(1);
    } else {
      return END_OF_FILE;
    }
  }

  LA_FAST(this: MixedInParser, howMuch: number): IToken {
    const soughtIdx = this.currIdx + howMuch;
    return this.tokVector[soughtIdx];
  }

  LA(this: MixedInParser, howMuch: number): IToken {
    const soughtIdx = this.currIdx + howMuch;
    if (soughtIdx < 0 || this.tokVectorLength <= soughtIdx) {
      return END_OF_FILE;
    } else {
      return this.tokVector[soughtIdx];
    }
  }

  consumeToken(this: MixedInParser) {
    this.currIdx++;
  }

  exportLexerState(this: MixedInParser): number {
    return this.currIdx;
  }

  importLexerState(this: MixedInParser, newState: number) {
    this.currIdx = newState;
  }

  resetLexerState(this: MixedInParser): void {
    this.currIdx = -1;
  }

  moveToTerminatedState(this: MixedInParser): void {
    this.currIdx = this.tokVectorLength - 1;
  }

  getLexerPosition(this: MixedInParser): number {
    return this.exportLexerState();
  }

  TRACE_INIT<T>(this: MixedInParser, phaseDesc: string, phaseImpl: () => T): T {
    if (this.traceInitPerf === true) {
      this.traceInitIndent++;
      const indent = new Array(this.traceInitIndent + 1).join("\t");
      if (this.traceInitIndent < this.traceInitMaxIdent) {
        console.log(`${indent}--> <${phaseDesc}>`);
      }
      const { time, value } = timer(phaseImpl);
      /* istanbul ignore next - Difficult to reproduce specific performance behavior (>10ms) in tests */
      const traceMethod = time > 10 ? console.warn : console.log;
      if (this.traceInitIndent < this.traceInitMaxIdent) {
        traceMethod(`${indent}<-- <${phaseDesc}> time: ${time}ms`);
      }
      this.traceInitIndent--;
      return value;
    } else {
      return phaseImpl();
    }
  }

  constructor(tokenVocabulary: TokenVocabulary, config: IParserConfig) {
    const that: MixedInParser = this as any;
    that.initErrorHandler(config);
    that.initLexerAdapter();
    that.initLooksAhead(config);
    that.initRecognizerEngine(tokenVocabulary, config);
    that.initRecoverable(config);
    that.initTreeBuilder(config);
    that.initGastRecorder(config);
    that.initPerformanceTracer(config);

    if (Object.hasOwn(config, "ignoredIssues")) {
      throw new Error(
        "The <ignoredIssues> IParserConfig property has been deprecated.\n\t" +
          "Please use the <IGNORE_AMBIGUITIES> flag on the relevant DSL method instead.\n\t" +
          "See: https://chevrotain.io/docs/guide/resolving_grammar_errors.html#IGNORING_AMBIGUITIES\n\t" +
          "For further details.",
      );
    }

    this.skipValidations = Object.hasOwn(config, "skipValidations")
      ? (config.skipValidations as boolean) // casting assumes the end user passing the correct type
      : DEFAULT_PARSER_CONFIG.skipValidations;
  }
}

applyMixins(Parser, []);

// --- GastRecorder module-level helpers (absorbed from trait) ---
// Prefixed with `gast` to avoid name collisions with engine methods.
function gastRecordProd(
  prodConstructor: any,
  mainProdArg: any,
  occurrence: number,
  handleSep: boolean = false,
): any {
  gastAssertMethodIdxIsValid(occurrence);
  const prevProd: any = this.recordingProdStack.at(-1);
  const grammarAction =
    typeof mainProdArg === "function" ? mainProdArg : mainProdArg.DEF;

  const newProd = new prodConstructor({ definition: [], idx: occurrence });
  if (handleSep) {
    newProd.separator = mainProdArg.SEP;
  }
  if (Object.hasOwn(mainProdArg, "MAX_LOOKAHEAD")) {
    newProd.maxLookahead = mainProdArg.MAX_LOOKAHEAD;
  }

  this.recordingProdStack.push(newProd);
  grammarAction.call(this);
  prevProd.definition.push(newProd);
  this.recordingProdStack.pop();

  return RECORDING_NULL_OBJECT;
}

function gastRecordOrProd(mainProdArg: any, occurrence: number): any {
  gastAssertMethodIdxIsValid(occurrence);
  const prevProd: any = this.recordingProdStack.at(-1);
  const hasOptions = Array.isArray(mainProdArg) === false;
  const alts: IOrAlt<unknown>[] =
    hasOptions === false ? mainProdArg : mainProdArg.DEF;

  const newOrProd = new Alternation({
    definition: [],
    idx: occurrence,
    ignoreAmbiguities: hasOptions && mainProdArg.IGNORE_AMBIGUITIES === true,
  });
  if (Object.hasOwn(mainProdArg, "MAX_LOOKAHEAD")) {
    newOrProd.maxLookahead = mainProdArg.MAX_LOOKAHEAD;
  }

  const hasPredicates = alts.some(
    (currAlt: any) => typeof currAlt.GATE === "function",
  );
  newOrProd.hasPredicates = hasPredicates;

  prevProd.definition.push(newOrProd);

  const savedDslCounter = this._dslCounter;
  const altStarts: number[] = [];

  alts.forEach((currAlt) => {
    altStarts.push(this._dslCounter - savedDslCounter);

    const currAltFlat = new Alternative({ definition: [] });
    newOrProd.definition.push(currAltFlat);
    if (Object.hasOwn(currAlt, "IGNORE_AMBIGUITIES")) {
      currAltFlat.ignoreAmbiguities = currAlt.IGNORE_AMBIGUITIES as boolean;
    } else if (Object.hasOwn(currAlt, "GATE")) {
      currAltFlat.ignoreAmbiguities = true;
    }
    this.recordingProdStack.push(currAltFlat);
    currAlt.ALT.call(this);
    this.recordingProdStack.pop();
  });

  const totalDelta = this._dslCounter - savedDslCounter;

  const mapKey = this.currRuleShortName | occurrence;
  this._orCounterDeltas[mapKey] = totalDelta;
  this._orAltCounterStarts[mapKey] = altStarts;

  return RECORDING_NULL_OBJECT;
}

function gastGetIdxSuffix(_idx: number): string {
  return "";
}

function gastAssertMethodIdxIsValid(idx: number): void {
  if (idx < 0 || idx > MAX_METHOD_IDX) {
    const error: any = new Error(
      `Invalid DSL Method idx value: <${idx}>\n\t` +
        `Idx value must be a none negative value smaller than ${
          MAX_METHOD_IDX + 1
        }`,
    );
    error.KNOWN_RECORDER_ERROR = true;
    throw error;
  }
}

export class CstParser extends Parser {
  constructor(
    tokenVocabulary: TokenVocabulary,
    config: IParserConfigInternal = DEFAULT_PARSER_CONFIG,
  ) {
    const configClone = { ...config };
    configClone.outputCst = true;
    super(tokenVocabulary, configClone);
  }
}

export class EmbeddedActionsParser extends Parser {
  constructor(
    tokenVocabulary: TokenVocabulary,
    config: IParserConfigInternal = DEFAULT_PARSER_CONFIG,
  ) {
    const configClone = { ...config };
    configClone.outputCst = false;
    super(tokenVocabulary, configClone);
  }
}
