/**
 * Grammar-guided token beam candidate source (docs/JEV-ONLY.md "Grammar-guided synthesis";
 * measured in experiments/results/probe-token-synthesis.md). Code owns syntax and position,
 * Jev owns content, tests decide.
 */
export { createTokenBeamSource, siteKey, DEFAULT_MAX_REQUESTS, DEFAULT_ROUTES } from './source.js';
export type { BeamContext, BeamRoute, BeamSourceOptions, LineSynthesis, TokenBeamSource } from './source.js';

export { BEAM_STAGE, BeamError, buildDepthRequest, checkAborted, dedupeHypotheses, expansionCount, filterOptions, rankedOptions, runTokenBeam, siteLineKind } from './beam.js';
export type { BeamRunOptions, BeamTask, Hypothesis, TokenBeamOutcome } from './beam.js';

export { END, analysePrefix, legalNext, lineKindOf } from './grammar.js';
export type { LineKind, NextToken, PrefixState } from './grammar.js';

export { COMMON_BUILTINS, COMMON_METHODS, END_DESCRIPTION, END_KEY, KEYWORDS, MAX_LITERALS, MAX_VOCAB_TOKENS, buildVocabulary, slotTokens } from './vocab.js';
export type { VocabToken, Vocabulary } from './vocab.js';

export { DONOR_THRESHOLD, MAX_TEMPLATES, MUTATIONS, SLOT, fillText, isSlotTok, mutants, runTemplateRoute, slotOptions, templateKey, templateOf, templatePool, templateText } from './templates.js';
export type { TemplateEntry, TemplateOutcome } from './templates.js';

export { FULL_PERMUTATION_MAX_ARGS, NON_COMMUTATIVE, argumentOrders, permutationCandidates, permutationsOf, primaryEnd, primaryStart } from './permute.js';
export type { Permutation } from './permute.js';

export { CURRENT_LINE_CORRECT_ID, HYPOTHESES_KEY, MARK, OUTER_BLOCK_MAX_LINES, TEMPLATE_QUESTION, WHOLE_FILE_MAX_LINES, baseState, buggyLine, currentLineCorrectNoul, fieldPath, hypothesisKey, listingRange, markedListing, nextTokenQuestion, slotQuestion, taskSentence, testsView } from './state.js';

export { LITERAL_KEYWORDS, OP_NAMES, classify, detokenize, isValueTok, keyAndDescription, sameTokens, sanitise, toks } from './tokens.js';
export type { Tok, TokClass } from './tokens.js';
