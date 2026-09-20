/**
 * Donor candidate source for the Jev-only synthesizer (docs/JEV-ONLY.md "Donor code";
 * measurements in experiments/results/probe-donor-and-templates.md): a normalised-shape index
 * over the workspace, code-side identifier re-binding of donor lines to the site's scope, and
 * the Jev hole questions that fill an identifier by Choice when the enumeration is too wide.
 */
export { buildDonorIndex, indexFile, NON_DONOR_KINDS } from './corpus.js';
export type { DonorIndex, DonorLine } from './corpus.js';

export { adaptIdentifiers, applySubstitutions, swapFamilyPairs, targetScore } from './adapt.js';
export type { AdaptOptions, Adaptation, FamilySwap, Substitution } from './adapt.js';

export { createDonorSource } from './source.js';
export type { DonorOp, DonorSourceOptions } from './source.js';

export {
  COMMON_BUILTINS,
  HOLE_MARKER,
  MAX_HOLES,
  MAX_HOLE_OPTIONS,
  MAX_PROGRAM_LINES,
  fillHolesSequentially,
  holeIdentifierOptions,
  holeQuestion,
  holeQuestions,
  holeState,
  holeTemplate,
  identifierHoles,
  optionKey,
} from './holes.js';
export type { FillOptions, FillResult, HoleContext, HoleFilling, HoleOptions, HoleQuestionSet, IdentifierHole } from './holes.js';

export {
  ATTRIBUTE_FAMILIES,
  BUILTIN_FAMILIES,
  CONSTANT_NAMES,
  IDENTIFIER_FAMILIES,
  builtinSiblings,
  distinctNames,
  familySiblings,
  isFamilyPair,
  isInScope,
  nameOccurrences,
  namesLookAlike,
  roleOf,
  scopeNamesForRole,
  substituteNames,
} from './names.js';
export type { IdentifierRole, NameOccurrence, OccurrenceKind } from './names.js';
