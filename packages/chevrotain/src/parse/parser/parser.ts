import { timer, toFastProperties } from "@chevrotain/utils";
import { computeAllProdsFollows } from "../grammar/follow.js";
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
  NoViableAltException,
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
  DSLMethodOpts,
  DSLMethodOptsWithErr,
  GrammarAction,
  IOrAlt,
  IParserConfig,
  IParserErrorMessageProvider,
  IProduction,
  IRecognitionException,
  IRuleConfig,
  IToken,
  ManySepMethodOpts,
  OrMethodOpts,
  SubruleMethodOpts,
  TokenType,
  TokenVocabulary,
} from "@chevrotain/types";
import { Recoverable } from "./traits/recoverable.js";
import { ILookaheadStrategy } from "@chevrotain/types";
import { LLkLookaheadStrategy } from "../grammar/llk_lookahead.js";
import { TreeBuilder } from "./traits/tree_builder.js";
// LexerAdapter absorbed into Parser (Stage 7)
import { RecognizerApi } from "./traits/recognizer_api.js";
import { RecognizerEngine, SPEC_FAIL } from "./traits/recognizer_engine.js";

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
  Terminal,
} from "@chevrotain/gast";
import { Lexer } from "../../scan/lexer_public.js";
import { augmentTokenTypes, hasShortKeyProperty } from "../../scan/tokens.js";
import { IParserConfigInternal, ParserMethodInternal } from "./types.js";
import { BITS_FOR_OCCURRENCE_IDX } from "../grammar/keys.js";
import { validateLookahead } from "../grammar/checks.js";

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

applyMixins(Parser, [
  Recoverable,
  TreeBuilder,
  RecognizerEngine,
  RecognizerApi,
]);

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
