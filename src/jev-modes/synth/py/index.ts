/**
 * Dependency-free Python source utilities shared by every jev-only candidate source
 * (docs/JEV-ONLY.md): tokenizer, structural analysis, line edits + unified diff, similarity.
 */
export { PyEditError, PyIndentationError, PyTokenizeError } from './errors.js';
export type { PyTokenizeErrorKind } from './errors.js';

export { PY_KEYWORDS, PY_OPERATORS, codeTokens, indentWidth, isKeyword, lineStartOffsets, renderTokens, tokenize, tokenizeFragment, untokenize } from './tokenize.js';
export type { Token, TokenType } from './tokenize.js';

export { PY_BUILTINS, analyse, blockAt, conditionOperands, fallsOffEnd, functionAt, guardClauses, guardPlacement, guardsDerivedLocal, isLateGuard, lineScopes, mutatedParameterDetails, mutatedParameters, parameterDerivedLocals, qualifiedName, scopeAt, splitPhysicalLines, statementAt, statementKinds } from './structure.js';
export type { AttrAssign, AttrFact, Block, CallFact, FunctionFacts, GuardClause, ImportEntry, LineScope, OperandPlacement, Param, PyModule, ReturnFact, Statement, StatementKind } from './structure.js';

export { deleteLine, indentOf, insertLine, lineCount, reindent, replaceLine, unifiedDiff } from './edits.js';

export { jaccard, levenshtein, levenshteinSimilarity, nearDuplicates, normaliseLine, normaliseTokens } from './similarity.js';
export type { NearDuplicate, NearDuplicateOptions, SimilarityMetric } from './similarity.js';
