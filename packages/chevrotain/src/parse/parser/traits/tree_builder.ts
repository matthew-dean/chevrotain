import {
  addNoneTerminalToCst,
  addTerminalToCst,
  setNodeLocationFull,
  setNodeLocationOnlyOffset,
} from "../../cst/cst.js";
import {
  createBaseSemanticVisitorConstructor,
  createBaseVisitorConstructorWithDefaults,
} from "../../cst/cst_visitor.js";
import {
  CstNode,
  CstNodeLocation,
  ICstVisitor,
  IParserConfig,
  IToken,
  nodeLocationTrackingOptions,
} from "@chevrotain/types";
import { MixedInParser } from "./parser_traits.js";
import { DEFAULT_PARSER_CONFIG } from "../parser.js";

/**
 * Snapshot of a CST node's mutable state taken before a speculative parse
 * attempt. Restored via restoreCstTop() if the attempt fails, preventing
 * partial terminal/non-terminal additions from leaking into the parent node.
 */
export interface CstTopSave {
  children: Record<string, any[]>;
  location: Record<string, number> | undefined;
}

/**
 * This trait is responsible for the CST building logic.
 */
export class TreeBuilder {
  outputCst: boolean;
  CST_STACK: CstNode[];
  baseCstVisitorConstructor: Function;
  baseCstVisitorWithDefaultsConstructor: Function;

  // dynamically assigned Methods
  setNodeLocationFromNode: (
    nodeLocation: CstNodeLocation,
    locationInformation: CstNodeLocation,
  ) => void;
  setNodeLocationFromToken: (
    nodeLocation: CstNodeLocation,
    locationInformation: CstNodeLocation,
  ) => void;
  cstPostRule: (this: MixedInParser, ruleCstNode: CstNode) => void;

  setInitialNodeLocation: (cstNode: CstNode) => void;
  nodeLocationTracking: nodeLocationTrackingOptions;

  /**
   * Saves a snapshot of the current top CST node's mutable state before a
   * speculative parse attempt. Dynamically dispatched — NOOP when outputCst = false.
   * @see saveCstTopImpl for the real implementation.
   */
  saveCstTop: (this: MixedInParser) => CstTopSave | null;

  /**
   * Restores the top CST node to a previously saved snapshot, undoing any
   * terminal/non-terminal additions from a failed speculative attempt.
   * Dynamically dispatched — NOOP when outputCst = false.
   * @see restoreCstTopImpl for the real implementation.
   */
  restoreCstTop: (this: MixedInParser, save: CstTopSave | null) => void;

  initTreeBuilder(this: MixedInParser, config: IParserConfig) {
    this.CST_STACK = [];

    // outputCst is no longer exposed/defined in the pubic API
    this.outputCst = (config as any).outputCst;

    this.nodeLocationTracking = Object.hasOwn(config, "nodeLocationTracking")
      ? (config.nodeLocationTracking as nodeLocationTrackingOptions) // assumes end user provides the correct config value/type
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
    cstNode.location = {
      startOffset: NaN,
      endOffset: NaN,
    };
  }

  setInitialNodeLocationOnlyOffsetRegular(
    this: MixedInParser,
    cstNode: any,
  ): void {
    cstNode.location = {
      // without error recovery the starting Location of a new CstNode is guaranteed
      // To be the next Token's startOffset (for valid inputs).
      // For invalid inputs there won't be any CSTOutput so this potential
      // inaccuracy does not matter
      startOffset: this.LA_FAST(1).startOffset,
      endOffset: NaN,
    };
  }

  setInitialNodeLocationFullRecovery(this: MixedInParser, cstNode: any): void {
    cstNode.location = {
      startOffset: NaN,
      startLine: NaN,
      startColumn: NaN,
      endOffset: NaN,
      endLine: NaN,
      endColumn: NaN,
    };
  }

  /**
     *  @see setInitialNodeLocationOnlyOffsetRegular for explanation why this work

     * @param cstNode
     */
  setInitialNodeLocationFullRegular(this: MixedInParser, cstNode: any): void {
    const nextToken = this.LA_FAST(1);
    cstNode.location = {
      startOffset: nextToken.startOffset,
      startLine: nextToken.startLine,
      startColumn: nextToken.startColumn,
      endOffset: NaN,
      endLine: NaN,
      endColumn: NaN,
    };
  }

  cstInvocationStateUpdate(this: MixedInParser, fullRuleName: string): void {
    const cstNode: CstNode = {
      name: fullRuleName,
      children: Object.create(null),
    };

    this.setInitialNodeLocation(cstNode);
    this.CST_STACK.push(cstNode);
  }

  cstFinallyStateUpdate(this: MixedInParser): void {
    this.CST_STACK.pop();
  }

  cstPostRuleFull(this: MixedInParser, ruleCstNode: CstNode): void {
    // casts to `required<CstNodeLocation>` are safe because `cstPostRuleFull` should only be invoked when full location is enabled
    // TODO(perf): can we replace this with LA_FAST?
    //       edge case is the empty CstNode on first rule invocation.
    //       perhaps create a test case to verify correctness of LA vs LA_FAST in this scenario?
    const prevToken = this.LA(0) as Required<CstNodeLocation>;
    const loc = ruleCstNode.location as Required<CstNodeLocation>;

    // If this condition is true it means we consumed at least one Token
    // In this CstNode.
    if (loc.startOffset <= prevToken.startOffset === true) {
      loc.endOffset = prevToken.endOffset;
      loc.endLine = prevToken.endLine;
      loc.endColumn = prevToken.endColumn;
    }
    // "empty" CstNode edge case
    else {
      loc.startOffset = NaN;
      loc.startLine = NaN;
      loc.startColumn = NaN;
    }
  }

  cstPostRuleOnlyOffset(this: MixedInParser, ruleCstNode: CstNode): void {
    // TODO: can we replace this with LA_FAST? see comment in `cstPostRuleFull()`
    const prevToken = this.LA(0);
    // `location' is not null because `cstPostRuleOnlyOffset` will only be invoked when location tracking is enabled.
    const loc = ruleCstNode.location!;

    // If this condition is true it means we consumed at least one Token
    // In this CstNode.
    if (loc.startOffset <= prevToken.startOffset === true) {
      loc.endOffset = prevToken.endOffset;
    }
    // "empty" CstNode edge case
    else {
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
    // This is only used when **both** error recovery and CST Output are enabled.
    this.setNodeLocationFromToken(rootCst.location!, <any>consumedToken);
  }

  cstPostNonTerminal(
    this: MixedInParser,
    ruleCstResult: CstNode,
    ruleName: string,
  ): void {
    const preCstNode = this.CST_STACK[this.CST_STACK.length - 1];
    addNoneTerminalToCst(preCstNode, ruleName, ruleCstResult);
    // This is only used when **both** error recovery and CST Output are enabled.
    this.setNodeLocationFromNode(preCstNode.location!, ruleCstResult.location!);
  }

  /**
   * Real implementation of saveCstTop. Snapshots the current top CST node's
   * children (deep-copied per array) and location before a speculative parse
   * attempt. The copy is O(k) in distinct child types already in the node —
   * typically 0-3 at an OR/OPTION/MANY decision point.
   */
  saveCstTopImpl(this: MixedInParser): CstTopSave | null {
    const top = this.CST_STACK[this.CST_STACK.length - 1];
    if (top === undefined) return null;
    const savedChildren: Record<string, any[]> = Object.create(null);
    const src = top.children;
    for (const key of Object.keys(src)) {
      savedChildren[key] = src[key].slice();
    }
    return {
      children: savedChildren,
      location:
        top.location !== undefined
          ? ({ ...top.location } as Record<string, number>)
          : undefined,
    };
  }

  /**
   * Real implementation of restoreCstTop. Restores the top CST node from a
   * snapshot, undoing all terminal and non-terminal additions made during the
   * failed speculative attempt.
   */
  restoreCstTopImpl(this: MixedInParser, save: CstTopSave | null): void {
    if (save === null) return;
    const top = this.CST_STACK[this.CST_STACK.length - 1];
    if (top === undefined) return;
    // CstNode.children is declared readonly in the type, but we own the object
    // and must roll it back — the snapshot copy IS the authoritative state.
    (top as any).children = save.children;
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
        Object.keys(this.gastProductionsCache),
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
        Object.keys(this.gastProductionsCache),
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
}
