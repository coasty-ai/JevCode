/**
 * Types of the introspected-names source (docs/JEV-ONLY-DESIGN.md §3 "task-text names" row and
 * experiments/results/swebench-reach-oracle-9.md, missing capability 2): names that are on the
 * objects of the failing call but in no file, test or issue text. One sandboxed run of the
 * reproduction evaluates the operands of the failing expression and records, per operand, the
 * class names of `type(obj).__mro__`, the public `dir(obj)` attributes and the `is_*` predicates
 * with their truth value at the failing call, plus the module-level names of the raising frame's
 * module. Everything is a fact read from the interpreter; nothing here ranks or decides.
 */

/** One frame of the reproduction's traceback inside the workspace (path relative to the workspace root). */
export interface IntrospectFrame {
  path: string;
  line: number;
  fn: string | null;
  /** the source line of the frame, when the interpreter could read it */
  code: string | null;
}

/** One operand of the failing expression, evaluated where it failed. */
export interface IntrospectOperand {
  /** the operand as written in the raising line / the reproduction statement (`rv.exp`, `Max(x, 2)`) */
  expr: string;
  typeName: string;
  /** `type(obj).__mro__` class names, most specific first, `object` dropped */
  classes: string[];
  /** public `is_*` attributes that read as a bool / None (properties, not methods) */
  predicates: string[];
  /** the predicates whose value was falsy (False / None) at the failing call: `if not x.<p>:` fires on this input */
  falsyPredicates: string[];
  /** other public attribute names of `dir(obj)` (bounded) */
  attributes: string[];
  /** the frame the operand was read in; null for operands of the reproduction statement itself */
  frame: IntrospectFrame | null;
  /** true when this object is the receiver (`self`) or an argument of the innermost raising frame */
  raisingReceiver: boolean;
}

export type IntrospectStatus = 'ran' | 'timeout' | 'error' | 'no_output' | 'no_target';

/** The harvested names, size-capped (≤ INTROSPECT_NAMES_MAX in total over the four lists). */
export interface IntrospectedNames {
  classes: string[];
  attributes: string[];
  predicates: string[];
  moduleNames: string[];
  /** per-operand detail the template productions read (subjects, predicate truth, frames) */
  operands: IntrospectOperand[];
  /** the workspace frames of the raising traceback, outermost first (empty when nothing raised) */
  frames: IntrospectFrame[];
  /** the module whose names `moduleNames` are (the raising frame's, or the callee's) */
  moduleName: string | null;
  /** the statement the pass introspected (source), for the transcript */
  target: string | null;
  status: IntrospectStatus;
  durationMs: number;
  note: string;
}
