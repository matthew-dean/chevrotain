import { Lexer } from "./lexer_public.js";
import { augmentTokenTypes, tokenStructuredMatcher } from "./tokens.js";
import { IToken, ITokenConfig, TokenType } from "@chevrotain/types";

export function tokenLabel(tokType: TokenType): string {
  if (hasTokenLabel(tokType)) {
    return tokType.LABEL;
  } else {
    return tokType.name;
  }
}

export function tokenName(tokType: TokenType): string {
  return tokType.name;
}

export function hasTokenLabel(
  obj: TokenType,
): obj is TokenType & Pick<Required<TokenType>, "LABEL"> {
  return typeof obj.LABEL === "string" && obj.LABEL !== "";
}

export function createToken(config: ITokenConfig): TokenType {
  if (Object.hasOwn(config, "parent")) {
    throw (
      "The parent property is no longer supported.\n" +
      "See: https://github.com/chevrotain/chevrotain/issues/564#issuecomment-349062346 for details."
    );
  }

  // Normalize CATEGORIES to an array at creation time.
  const rawCats = config.categories;
  const categories: TokenType[] = rawCats
    ? Array.isArray(rawCats)
      ? (rawCats as TokenType[])
      : [rawCats as TokenType]
    : [];

  // ALL fields are pre-declared with sentinel values so every TokenType object
  // shares a single V8 hidden class from birth. augmentTokenTypes() overwrites
  // the augmented sentinel slots without adding new properties, eliminating
  // hidden-class transitions on every token construction.
  //
  // Validators in lexer.ts that previously used Object.hasOwn() to detect
  // "was this field explicitly configured?" have been updated to check
  // `!== undefined` instead. Tests that verified properties were added
  // post-creation are updated accordingly.
  const tokenType: TokenType = {
    name: config.name,
    PATTERN: config.pattern ?? undefined,
    LABEL: config.label ?? undefined,
    GROUP: config.group ?? undefined,
    PUSH_MODE: config.push_mode ?? undefined,
    POP_MODE: config.pop_mode ?? undefined,
    LONGER_ALT: config.longer_alt ?? undefined,
    LINE_BREAKS: config.line_breaks ?? undefined,
    START_CHARS_HINT: config.start_chars_hint ?? undefined,
    CATEGORIES: categories,
    // Augmented slots — sentinel values, overwritten by augmentTokenTypes().
    tokenTypeIdx: 0,
    isParent: false,
    categoryMatches: [],
    categoryMatchesMap: {},
    MATCH_SET: null,
  } as unknown as TokenType;

  augmentTokenTypes([tokenType]);

  return tokenType;
}

export const EOF = createToken({ name: "EOF", pattern: Lexer.NA });

export function createTokenInstance(
  tokType: TokenType,
  image: string,
  startOffset: number,
  endOffset: number,
  startLine: number,
  endLine: number,
  startColumn: number,
  endColumn: number,
): IToken {
  return {
    image,
    startOffset,
    endOffset,
    startLine,
    endLine,
    startColumn,
    endColumn,
    tokenTypeIdx: (<any>tokType).tokenTypeIdx,
    tokenType: tokType,
    payload: undefined,
    isInsertedInRecovery: false,
  };
}

export function tokenMatcher(token: IToken, tokType: TokenType): boolean {
  return tokenStructuredMatcher(token, tokType);
}
