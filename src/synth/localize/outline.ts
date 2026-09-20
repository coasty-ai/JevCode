/**
 * Code-computed views of a workspace file for the localizer's states: top-level outlines (file
 * confirmation), the flattened function list (function Choice), the code lines of a span (line
 * Choice; blank, comment-only and docstring lines are never edit targets so they are not
 * options), and traceback frames resolved to workspace paths. Everything comes from
 * src/synth/py/structure; nothing here re-parses Python.
 */
import type { Block, PyModule } from '../py/structure.js';
import type { SourceFile } from '../types.js';
import { MODULE_LEVEL_NAME } from './types.js';
import type { FunctionEntry, TracebackFrame } from './types.js';

/** Outline entries shown per file in the confirmation pass (Q3 used ≤ 40). */
export const OUTLINE_MAX = 40;

/** `class X` / `f()` for every depth-0 block, source order, capped. */
export function outline(mod: PyModule, max = OUTLINE_MAX): string[] {
  const out: string[] = [];
  for (const b of mod.blocks) {
    if (b.depth !== 0) continue;
    out.push(b.kind === 'class' ? `class ${b.name}` : `${b.name}()`);
    if (out.length >= max) {
      const rest = mod.blocks.filter((x) => x.depth === 0).length - max;
      if (rest > 0) out.push(`... ${rest} more`);
      break;
    }
  }
  return out;
}

function hasDefAncestor(b: Block, blocks: readonly Block[]): boolean {
  let p = b.parent;
  while (p !== null) {
    const pb = blocks[p]!;
    if (pb.kind === 'def') return true;
    p = pb.parent;
  }
  return false;
}

function qualnameOf(b: Block, blocks: readonly Block[]): string {
  const parts = [b.name];
  let p = b.parent;
  while (p !== null) {
    const pb = blocks[p]!;
    parts.unshift(pb.name);
    p = pb.parent;
  }
  return parts.join('.');
}

/**
 * Every def at module level or inside classes (nested classes flattened into the qualname);
 * defs nested in defs are folded into their enclosing def, as the measured Q2 option set was.
 */
export function functionEntries(file: SourceFile): FunctionEntry[] {
  const { blocks } = file.mod;
  const out: FunctionEntry[] = [];
  for (const b of blocks) {
    if (b.kind !== 'def' || hasDefAncestor(b, blocks)) continue;
    const parent = b.parent === null ? null : blocks[b.parent]!;
    out.push({
      file,
      qualname: qualnameOf(b, blocks),
      kind: parent !== null && parent.kind === 'class' ? 'method' : 'function',
      startLine: b.startLine,
      endLine: b.endLine,
      headerLine: b.headerLine,
      blockIndex: b.index,
    });
  }
  return out;
}

/** The pseudo-entry for code outside every function (imports, constants, class attributes). */
export function moduleEntry(file: SourceFile): FunctionEntry {
  return { file, qualname: MODULE_LEVEL_NAME, kind: 'module', startLine: 1, endLine: Math.max(1, file.mod.lines.length), headerLine: 1, blockIndex: null };
}

/** Physical lines covered by docstring statements (block docstrings and module-level string-only statements). */
function docstringLines(mod: PyModule): Set<number> {
  const out = new Set<number>();
  for (const st of mod.statements) {
    if (st.kind !== 'expr' || st.tokens.length === 0 || !st.tokens.every((t) => t.type === 'STRING')) continue;
    for (let l = st.startLine; l <= st.endLine; l++) out.add(l);
  }
  return out;
}

export interface CodeLine {
  line: number;
  text: string;
}

/**
 * Non-blank, non-comment, non-docstring physical lines of [startLine, endLine]. The QuixBugs
 * probe listed exactly these (trailing docstring stripped, blanks and comments removed).
 */
export function codeLines(mod: PyModule, startLine: number, endLine: number): CodeLine[] {
  const doc = docstringLines(mod);
  const out: CodeLine[] = [];
  const last = Math.min(endLine, mod.lines.length);
  for (let l = Math.max(1, startLine); l <= last; l++) {
    const text = mod.lines[l - 1] ?? '';
    const t = text.trim();
    if (t === '' || t.startsWith('#') || doc.has(l)) continue;
    out.push({ line: l, text });
  }
  return out;
}

/** Code lines of the file that lie outside every def block (module-level statements, class attributes). */
export function moduleCodeLines(mod: PyModule): CodeLine[] {
  const inDef = new Set<number>();
  for (const b of mod.blocks) {
    if (b.kind !== 'def') continue;
    for (let l = b.startLine; l <= b.endLine; l++) inDef.add(l);
  }
  return codeLines(mod, 1, mod.lines.length).filter((c) => !inDef.has(c.line));
}

/** Innermost def containing `line` among the flattened entries (methods own their bodies). */
export function entryAt(entries: readonly FunctionEntry[], line: number): FunctionEntry | undefined {
  let best: FunctionEntry | undefined;
  for (const e of entries) {
    if (e.blockIndex === null || line < e.startLine || line > e.endLine) continue;
    if (best === undefined || e.endLine - e.startLine < best.endLine - best.startLine) best = e;
  }
  return best;
}

const FRAME_RE = /File "([^"]+)", line (\d+)(?:, in (\S+))?/g;

/**
 * Traceback frames whose file resolves to a workspace path (exact, or the traceback path ends
 * with `/<workspace path>` because the runner printed absolute paths). Innermost frame last.
 */
export function tracebackFrames(traceback: string | undefined, files: ReadonlyMap<string, SourceFile>): TracebackFrame[] {
  if (traceback === undefined || traceback === '') return [];
  const out: TracebackFrame[] = [];
  for (const m of traceback.matchAll(FRAME_RE)) {
    const raw = m[1]!.replace(/\\/g, '/');
    const path = resolvePath(raw, files);
    if (path === null) continue;
    out.push({ path, line: Number(m[2]), fn: m[3] ?? null });
  }
  return out;
}

function resolvePath(raw: string, files: ReadonlyMap<string, SourceFile>): string | null {
  if (files.has(raw)) return raw;
  const stripped = raw.replace(/^\.\//, '');
  if (files.has(stripped)) return stripped;
  let best: string | null = null;
  for (const p of files.keys()) {
    if (raw.endsWith(`/${p}`) && (best === null || p.length > best.length)) best = p;
  }
  return best;
}
