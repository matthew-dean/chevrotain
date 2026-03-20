import { expect } from "chai";
import {
  ILookaheadStrategy,
  ILookaheadValidationError,
  IOrAlt,
  IToken,
  OptionalProductionType,
  Rule,
  TokenType,
} from "@chevrotain/types";
import { augmentTokenTypes } from "../../src/scan/tokens.js";
import { createToken } from "../../src/scan/tokens_public.js";
import { createRegularToken } from "../utils/matchers.js";
import { SmartParser } from "../../src/parse/parser/parser.js";

describe("SmartParser", () => {
  describe("lazy self analysis", () => {
    const IntTok = createToken({ name: "IntTok" });
    const PlusTok = createToken({ name: "PlusTok" });
    const allTokens = [IntTok, PlusTok];
    augmentTokenTypes(allTokens);

    it("can parse without an explicit performSelfAnalysis call", () => {
      class ParserWithoutPerformSelfAnalysis extends SmartParser {
        constructor() {
          super(allTokens);
          this.RULE("goodRule", () => {
            this.CONSUME(IntTok);
          });
        }
      }

      const parser: any = new ParserWithoutPerformSelfAnalysis();
      parser.input = [createRegularToken(IntTok, "1")];
      expect(parser.goodRule()).to.be.undefined;
      expect(parser.errors).to.be.empty;
    });

    it("can expose GAST without an explicit performSelfAnalysis call", () => {
      class ParserWithoutPerformSelfAnalysis extends SmartParser {
        constructor() {
          super(allTokens);
          this.RULE("goodRule", () => {
            this.CONSUME(IntTok);
          });
        }
      }

      const parser: any = new ParserWithoutPerformSelfAnalysis();
      const gast = parser.getGAstProductions();
      expect(gast).to.be.an("object");
      expect(gast.goodRule).to.exist;
    });

    it("can serialize GAST without an explicit performSelfAnalysis call", () => {
      class ParserWithoutPerformSelfAnalysis extends SmartParser {
        constructor() {
          super(allTokens);
          this.RULE("goodRule", () => {
            this.CONSUME(IntTok);
          });
        }
      }

      const parser: any = new ParserWithoutPerformSelfAnalysis();
      const serialized = parser.getSerializedGastProductions();
      expect(serialized).to.be.an("array");
      expect(serialized.length).to.be.greaterThan(0);
    });

    it("can parse OR and MANY without an explicit performSelfAnalysis call", () => {
      class ParserWithoutPerformSelfAnalysis extends SmartParser {
        constructor() {
          super(allTokens);
          this.RULE("list", () => {
            const items: string[] = [];
            this.MANY({
              DEF: () => {
                items.push(
                  this.OR([
                    { ALT: () => this.CONSUME1(IntTok).image },
                    { ALT: () => this.CONSUME1(PlusTok).image },
                  ]) as string,
                );
              },
            });
            return items;
          });
        }
      }

      const parser: any = new ParserWithoutPerformSelfAnalysis();
      parser.input = [
        createRegularToken(IntTok, "1"),
        createRegularToken(PlusTok, "+"),
        createRegularToken(IntTok, "2"),
      ];
      const result = parser.list();
      expect(result).to.deep.equal(["1", "+", "2"]);
      expect(parser.errors).to.be.empty;
    });

    for (const explicitPSA of [false, true]) {
      it(`honors a custom lookahead strategy on parser reuse ${
        explicitPSA ? "with" : "without"
      } performSelfAnalysis()`, () => {
        const Tok = createToken({ name: "Tok" });
        const allTokens = [Tok];
        augmentTokenTypes(allTokens);

        class ToggleLookaheadStrategy implements ILookaheadStrategy {
          validate(_options: {
            rules: Rule[];
            tokenTypes: TokenType[];
            grammarName: string;
          }): ILookaheadValidationError[] {
            return [];
          }

          buildLookaheadForAlternation(_options: {
            prodOccurrence: number;
            rule: Rule;
            maxLookahead: number;
            hasPredicates: boolean;
            dynamicTokensEnabled: boolean;
          }): (orAlts?: IOrAlt<any>[] | undefined) => number | undefined {
            return function (this: CustomStrategyParser) {
              return this.pickSecond ? 1 : 0;
            };
          }

          buildLookaheadForOptional(_options: {
            prodOccurrence: number;
            prodType: OptionalProductionType;
            rule: Rule;
            maxLookahead: number;
            dynamicTokensEnabled: boolean;
          }): () => boolean {
            return function () {
              return false;
            };
          }
        }

        class CustomStrategyParser extends SmartParser {
          public pickSecond = false;

          constructor() {
            super(allTokens, {
              lookaheadStrategy: new ToggleLookaheadStrategy(),
            });
            if (explicitPSA) {
              this.performSelfAnalysis();
            }
          }

          public rule = this.RULE("rule", () => {
            return this.OR([
              { ALT: () => (this.CONSUME(Tok), "first") },
              { ALT: () => (this.CONSUME(Tok), "second") },
            ]);
          });
        }

        const parser = new CustomStrategyParser();

        parser.pickSecond = false;
        parser.input = [createRegularToken(Tok, "a")];
        expect(parser.rule()).to.equal("first");
        expect(parser.errors).to.be.empty;

        parser.pickSecond = true;
        parser.input = [createRegularToken(Tok, "a")];
        expect(parser.rule()).to.equal("second");
        expect(parser.errors).to.be.empty;
      });
    }
  });

  describe("auto occurrence", () => {
    it("allows repeated plain OR sites in the same rule", () => {
      const TokenA = createToken({ name: "TokenA" });
      const TokenB = createToken({ name: "TokenB" });
      const TokenC = createToken({ name: "TokenC" });
      const TokenD = createToken({ name: "TokenD" });
      const allTokens = [TokenA, TokenB, TokenC, TokenD];
      augmentTokenTypes(allTokens);

      class TwoOrParser extends SmartParser {
        constructor() {
          super(allTokens, {});
          this.performSelfAnalysis();
        }

        public testRule = this.RULE("testRule", () => {
          const first = this.OR([
            { ALT: () => (this.CONSUME(TokenA), "A") },
            { ALT: () => (this.CONSUME(TokenB), "B") },
          ]);
          const second = this.OR([
            { ALT: () => (this.CONSUME(TokenC), "C") },
            { ALT: () => (this.CONSUME(TokenD), "D") },
          ]);
          return [first, second];
        });
      }

      const parser = new TwoOrParser();
      parser.input = [createRegularToken(TokenA), createRegularToken(TokenC)];
      expect(parser.testRule()).to.deep.equal(["A", "C"]);
      expect(parser.errors).to.be.empty;

      parser.input = [createRegularToken(TokenB), createRegularToken(TokenD)];
      expect(parser.testRule()).to.deep.equal(["B", "D"]);
      expect(parser.errors).to.be.empty;

      const fastMaps = (parser as any)._orFastMaps ?? {};
      expect(Object.keys(fastMaps)).to.have.lengthOf(2);
    });

    it("allows repeated plain CONSUME calls in the same rule", () => {
      const TokenA = createToken({ name: "TokenA" });
      const TokenB = createToken({ name: "TokenB" });
      const allTokens = [TokenA, TokenB];
      augmentTokenTypes(allTokens);

      class MultiConsumeParser extends SmartParser {
        constructor() {
          super(allTokens, {});
          this.performSelfAnalysis();
        }

        public testRule = this.RULE("testRule", () => {
          const first = this.CONSUME(TokenA);
          const second = this.CONSUME(TokenB);
          return [first.image, second.image];
        });
      }

      const parser = new MultiConsumeParser();
      parser.input = [
        createRegularToken(TokenA, "a"),
        createRegularToken(TokenB, "b"),
      ];
      expect(parser.testRule()).to.deep.equal(["a", "b"]);
      expect(parser.errors).to.be.empty;
    });

    it("allows duplicate explicit SUBRULE occurrences in the same rule", () => {
      class PlusTok {
        static PATTERN = /NA/;
      }

      class DuplicateSubruleParser extends SmartParser {
        constructor(input: IToken[] = []) {
          super([PlusTok]);
          this.performSelfAnalysis();
          this.input = input;
        }

        public duplicateRef = this.RULE("duplicateRef", () => {
          this.SUBRULE1(this.anotherRule);
          this.SUBRULE1(this.anotherRule);
        });

        public anotherRule = this.RULE("anotherRule", () => {
          this.CONSUME(PlusTok);
        });
      }

      expect(() => new DuplicateSubruleParser()).to.not.throw();
    });

    it("ignores user-provided lowercase idx values", () => {
      const Tok = createToken({ name: "Tok" });
      const allTokens = [Tok];
      augmentTokenTypes(allTokens);

      class InvalidIdxParser extends SmartParser {
        constructor() {
          super(allTokens);
          this.performSelfAnalysis();
        }

        public one = this.RULE("one", () => {
          this.consume(256, Tok);
        });
      }

      expect(() => new InvalidIdxParser()).to.not.throw();
    });
  });

  describe("ambiguity tolerance", () => {
    it("allows ambiguous LL(1) alternatives and resolves them speculatively", () => {
      const Ident = createToken({ name: "Ident" });
      const LParen = createToken({ name: "LParen" });
      const allTokens = [Ident, LParen];
      augmentTokenTypes(allTokens);

      expect(() => {
        class AmbiguousParser extends SmartParser {
          constructor() {
            super(allTokens, {});
            this.performSelfAnalysis();
          }

          public testRule = this.RULE("testRule", () => {
            return this.OR([
              {
                ALT: () => {
                  const id = this.CONSUME(Ident);
                  this.CONSUME(LParen);
                  return "call:" + id.image;
                },
              },
              {
                ALT: () => {
                  const id = this.CONSUME(Ident);
                  return "ref:" + id.image;
                },
              },
            ]);
          });
        }

        const parser = new AmbiguousParser();
        parser.input = [
          createRegularToken(Ident, "foo"),
          createRegularToken(LParen, "("),
        ];
        expect(parser.testRule()).to.equal("call:foo");
        expect(parser.errors).to.be.empty;

        parser.input = [createRegularToken(Ident, "bar")];
        expect(parser.testRule()).to.equal("ref:bar");
        expect(parser.errors).to.be.empty;
      }).to.not.throw();
    });
  });

  describe("speculative lookahead tolerance", () => {
    it("can skip a wrong OPTION path even when explicit MAX_LOOKAHEAD is too low", () => {
      const OneTok = createToken({ name: "OneTok" });
      const TwoTok = createToken({ name: "TwoTok" });
      const ThreeTok = createToken({ name: "ThreeTok" });
      const allTokens = [OneTok, TwoTok, ThreeTok];
      augmentTokenTypes(allTokens);

      class SpeculativeOptionParser extends SmartParser {
        constructor(input: IToken[] = []) {
          super(allTokens);
          this.performSelfAnalysis();
          this.input = input;
        }

        public rule = this.RULE("rule", () => {
          let result = "OPTION Not Taken";
          this.OPTION2({
            // Deliberately too low; SmartParser should still try the body
            // speculatively and back out when ThreeTok does not appear.
            MAX_LOOKAHEAD: 1,
            DEF: () => {
              this.CONSUME1(OneTok);
              this.CONSUME1(ThreeTok);
              result = "OPTION Taken";
            },
          });
          this.CONSUME2(OneTok);
          this.CONSUME2(TwoTok);
          return result;
        });
      }

      const parser = new SpeculativeOptionParser([
        createRegularToken(OneTok),
        createRegularToken(TwoTok),
      ]);
      expect(parser.rule()).to.equal("OPTION Not Taken");
      expect(parser.errors).to.be.empty;
    });
  });

  describe("definition validations", () => {
    it("does not require skipValidations for repeated plain CONSUME sites", () => {
      const IntTok = createToken({ name: "IntTok" });
      const allTokens: TokenType[] = [IntTok];
      augmentTokenTypes(allTokens);

      class SkipValidationsParser extends SmartParser {
        constructor(skipValidationsValue: boolean) {
          super(allTokens, {
            skipValidations: skipValidationsValue,
          });

          this.RULE("goodRule", () => {
            this.CONSUME(IntTok);
            this.CONSUME(IntTok);
          });
          this.performSelfAnalysis();
        }
      }

      expect(() => new SkipValidationsParser(true)).to.not.throw();
      expect(() => new SkipValidationsParser(false)).to.not.throw();
    });
  });
});
