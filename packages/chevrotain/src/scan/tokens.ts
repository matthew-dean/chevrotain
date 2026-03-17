import { IToken, TokenType } from "@chevrotain/types";

export function tokenStructuredMatcher(
  tokInstance: IToken,
  tokConstructor: TokenType,
) {
  const instanceType = tokInstance.tokenTypeIdx;
  if (instanceType === tokConstructor.tokenTypeIdx) {
    return true;
  }
  // MATCH_SET is a Uint32Array bitset: bit (tokenTypeIdx) is set for every
  // token type that is a member of this category (including transitive ones).
  // This replaces the O(1)-but-two-allocation categoryMatchesMap lookup with a
  // single bitwise AND — one fewer indirection and zero object property lookup.
  const matchSet = tokConstructor.MATCH_SET;
  return (
    matchSet !== null &&
    matchSet !== undefined &&
    (matchSet[instanceType >> 5] & (1 << (instanceType & 31))) !== 0
  );
}

// Optimized tokenMatcher in case our grammar does not use token categories.
// Being so tiny it is much more likely to be in-lined and this avoids the function call overhead.
export function tokenStructuredMatcherNoCategories(
  token: IToken,
  tokType: TokenType,
) {
  return token.tokenTypeIdx === tokType.tokenTypeIdx;
}

export let tokenShortNameIdx = 1;
export const tokenIdxToClass: { [tokenIdx: number]: TokenType } = {};

export function augmentTokenTypes(tokenTypes: TokenType[]): void {
  // collect the parent Token Types as well.
  const tokenTypesAndParents = expandCategories(tokenTypes);

  // assign tokenTypeIdx and normalize CATEGORIES on any token not yet augmented
  assignTokenDefaultProps(tokenTypesAndParents);

  // fill up the categoryMatchesMap (used by lookahead, kept for compatibility)
  assignCategoriesMapProp(tokenTypesAndParents);
  assignCategoriesTokensProp(tokenTypesAndParents);

  tokenTypesAndParents.forEach((tokType) => {
    tokType.isParent = tokType.categoryMatches!.length > 0;
  });

  // Build MATCH_SET bitsets after all indices are finalized.
  // Size: enough 32-bit words to cover the highest assigned index.
  const setSize = (tokenShortNameIdx >>> 5) + 1;
  tokenTypesAndParents.forEach((tokType) => {
    if (tokType.isParent) {
      const matchSet = new Uint32Array(setSize);
      tokType.categoryMatches!.forEach((idx) => {
        matchSet[idx >> 5] |= 1 << (idx & 31);
      });
      tokType.MATCH_SET = matchSet;
    } else {
      tokType.MATCH_SET = null;
    }
  });
}

export function expandCategories(tokenTypes: TokenType[]): TokenType[] {
  let result = [...tokenTypes];

  let categories = tokenTypes;
  let searching = true;
  while (searching) {
    categories = categories
      .map((currTokType) => currTokType.CATEGORIES)
      .flat()
      .filter(Boolean) as TokenType[];

    const newCategories = categories.filter((x) => !result.includes(x));

    result = result.concat(newCategories);

    if (newCategories.length === 0) {
      searching = false;
    } else {
      categories = newCategories;
    }
  }
  return result;
}

export function assignTokenDefaultProps(tokenTypes: TokenType[]): void {
  tokenTypes.forEach((currTokType) => {
    if (!hasShortKeyProperty(currTokType)) {
      tokenIdxToClass[tokenShortNameIdx] = currTokType;
      (<any>currTokType).tokenTypeIdx = tokenShortNameIdx++;
    }

    // CATEGORIES? : TokenType | TokenType[]
    if (
      hasCategoriesProperty(currTokType) &&
      !Array.isArray(currTokType.CATEGORIES)
      // &&
      // !isUndefined(currTokType.CATEGORIES.PATTERN)
    ) {
      currTokType.CATEGORIES = [currTokType.CATEGORIES as unknown as TokenType];
    }

    if (!hasCategoriesProperty(currTokType)) {
      currTokType.CATEGORIES = [];
    }

    if (!hasExtendingTokensTypesProperty(currTokType)) {
      currTokType.categoryMatches = [];
    }

    if (!hasExtendingTokensTypesMapProperty(currTokType)) {
      currTokType.categoryMatchesMap = {};
    }
  });
}

export function assignCategoriesTokensProp(tokenTypes: TokenType[]): void {
  tokenTypes.forEach((currTokType) => {
    // avoid duplications
    currTokType.categoryMatches = [];
    Object.keys(currTokType.categoryMatchesMap!).forEach((key) => {
      currTokType.categoryMatches!.push(
        tokenIdxToClass[key as unknown as number].tokenTypeIdx!,
      );
    });
  });
}

export function assignCategoriesMapProp(tokenTypes: TokenType[]): void {
  tokenTypes.forEach((currTokType) => {
    singleAssignCategoriesToksMap([], currTokType);
  });
}

export function singleAssignCategoriesToksMap(
  path: TokenType[],
  nextNode: TokenType,
): void {
  path.forEach((pathNode) => {
    nextNode.categoryMatchesMap![pathNode.tokenTypeIdx!] = true;
  });

  nextNode.CATEGORIES!.forEach((nextCategory) => {
    const newPath = path.concat(nextNode);
    // avoids infinite loops due to cyclic categories.
    if (!newPath.includes(nextCategory)) {
      singleAssignCategoriesToksMap(newPath, nextCategory);
    }
  });
}

// tokenTypeIdx is pre-declared as 0 (sentinel) on all TokenType objects.
// Valid indices start at 1, so a non-zero value means already augmented.
// The null/undefined guard preserves the original safety contract — callers
// such as gast_recorder.ts pass user-supplied values that may be null.
export function hasShortKeyProperty(tokType: TokenType): boolean {
  return tokType != null && !!tokType.tokenTypeIdx;
}

export function hasCategoriesProperty(tokType: TokenType): boolean {
  return Object.hasOwn(tokType ?? {}, "CATEGORIES");
}

export function hasExtendingTokensTypesProperty(tokType: TokenType): boolean {
  return Object.hasOwn(tokType ?? {}, "categoryMatches");
}

export function hasExtendingTokensTypesMapProperty(
  tokType: TokenType,
): boolean {
  return Object.hasOwn(tokType ?? {}, "categoryMatchesMap");
}

export function isTokenType(tokType: TokenType): boolean {
  return Object.hasOwn(tokType ?? {}, "tokenTypeIdx");
}
