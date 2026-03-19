import { RecognizerApi } from "./recognizer_api.js";
import { RecognizerEngine } from "./recognizer_engine.js";
import { Recoverable } from "./recoverable.js";
import { TreeBuilder } from "./tree_builder.js";
import {
  CstParser as CstParserConstructorImpel,
  EmbeddedActionsParser as EmbeddedActionsParserConstructorImpl,
  Parser as ParserConstructorImpel,
} from "../parser.js";
import * as defs from "@chevrotain/types";
/**
 * This Type combines all the Parser traits.
 * It is used in all traits in the "this type assertion"
 * - https://github.com/Microsoft/TypeScript/wiki/What%27s-new-in-TypeScript#specifying-the-type-of-this-for-functions
 * This enables strong Type Checks inside trait methods that invoke methods from other traits.
 * This pattern is very similar to "self types" in Scala.
 * - https://docs.scala-lang.org/tour/self-types.html
 *
 * As traits are merged into Parser (Stage 7), they are removed from this
 * intersection type. Once all traits are absorbed, this type and the
 * applyMixins infrastructure will be deleted.
 */
export type MixedInParser = ParserConstructorImpel &
  RecognizerApi &
  RecognizerEngine &
  Recoverable &
  TreeBuilder;

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
