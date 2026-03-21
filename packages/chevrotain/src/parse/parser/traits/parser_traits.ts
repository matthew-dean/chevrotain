import {
  CstParser as CstParserConstructorImpel,
  EmbeddedActionsParser as EmbeddedActionsParserConstructorImpl,
  ForgivingParser as ForgivingParserConstructorImpl,
  StrictParser as StrictParserConstructorImpl,
  SmartParser as SmartParserConstructorImpl,
} from "../parser.js";
import * as defs from "@chevrotain/types";
/**
 * All traits have been absorbed into the strict parser implementation (Stage 7).
 * MixedInParser is now just StrictParser itself.
 */
export type MixedInParser = StrictParserConstructorImpl;

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

interface MixedInStrictParserConstructor {
  new (
    tokenVocabulary: defs.TokenVocabulary,
    config?: defs.IParserConfig,
  ): defs.StrictParser;
}

export const StrictParser: MixedInStrictParserConstructor = <any>(
  StrictParserConstructorImpl
);

interface MixedInForgivingParserConstructor {
  new (
    tokenVocabulary: defs.TokenVocabulary,
    config?: defs.IParserConfig,
  ): defs.ForgivingParser;
}

export const ForgivingParser: MixedInForgivingParserConstructor = <any>(
  ForgivingParserConstructorImpl
);

interface MixedInSmartParserConstructor {
  new (
    tokenVocabulary: defs.TokenVocabulary,
    config?: defs.IParserConfig,
  ): defs.SmartParser;
}

export const SmartParser: MixedInSmartParserConstructor = <any>(
  SmartParserConstructorImpl
);
