import {
  CstParser as CstParserConstructorImpel,
  EmbeddedActionsParser as EmbeddedActionsParserConstructorImpl,
  Parser as ParserConstructorImpel,
} from "../parser.js";
import * as defs from "@chevrotain/types";
/**
 * All traits have been absorbed into Parser (Stage 7).
 * MixedInParser is now just Parser itself.
 */
export type MixedInParser = ParserConstructorImpel;

interface MixedInCstParserConstructor {
  new (
    tokenVocabulary: defs.TokenVocabulary,
    config?: defs.IParserConfig,
  ): defs.CstParser;
}

export const CstParser: MixedInCstParserConstructor = <any>(
  CstParserConstructorImpel
);

interface MixedInEmbeddedActionsParserConstructor {
  new (
    tokenVocabulary: defs.TokenVocabulary,
    config?: defs.IParserConfig,
  ): defs.EmbeddedActionsParser;
}

export const EmbeddedActionsParser: MixedInEmbeddedActionsParserConstructor = <
  any
>EmbeddedActionsParserConstructorImpl;
