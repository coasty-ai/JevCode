/**
 * Supply-chain and injection rules for every .github/workflows/*.yml, plus the pin that release.yml's `gates` job
 * runs ci.yml's `check` job step for step (so a green ci.yml predicts a green release gate) and that its `pack` job,
 * not `gates`, builds the published tarball.
 *
 *   1. every non-local `uses:` is `owner/repo@<40-hex> # vX.Y.Z`, one SHA per action across all workflows
 *   2. a top-level `permissions:` of `{}` or `contents: read`; jobs widen it
 *   3. no `${{ … }}` inside a `run:` block (values reach the shell through `env:`)
 *   4. `secrets.*` only as the whole value of an `env:` entry
 *   5. no `set -x` in scripts/release/*.sh, and each one runs under `set -euo pipefail`
 *   6. each workflow_dispatch input is read first by a step that validates it; never `github.event.inputs`
 *
 * A line-based parse, the same technique as release-workflow.test.ts: no YAML dependency.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const WF_DIR = join(ROOT, '.github/workflows');
const WORKFLOWS = readdirSync(WF_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort()
  .map((f) => ({ name: f, text: readFileSync(join(WF_DIR, f), 'utf8') }));
const RELEASE_SCRIPTS = join(ROOT, 'scripts/release');

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').length;
const isBlank = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');

interface Step {
  /** 0-based line index of the step's `- ` line */
  at: number;
  lines: string[];
}

/** every step of every `steps:` list, in file order */
function stepsOf(text: string): Step[] {
  const lines = text.split('\n');
  const out: Step[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*steps:\s*$/.test(lines[i] ?? '')) continue;
    let item = -1;
    let cur: Step | null = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] ?? '';
      if (isBlank(l)) continue;
      const ind = indentOf(l);
      if (item < 0) item = ind;
      if (ind < item || (ind === item && !l.trimStart().startsWith('- '))) break;
      if (ind === item) {
        cur = { at: j, lines: [l] };
        out.push(cur);
      } else cur?.lines.push(l);
      i = j;
    }
  }
  return out;
}

/** the raw text of every `run:` value (inline or block scalar) */
function runBlocks(text: string): Array<{ line: number; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ line: number; body: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] ?? '');
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    const inline = (m[2] ?? '').trim();
    if (!/^[|>][-+]?$/.test(inline)) {
      out.push({ line: i + 1, body: inline });
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() !== '' && indentOf(next) <= indent) break;
      block.push(next);
    }
    out.push({ line: i + 1, body: block.join('\n') });
  }
  return out;
}

/** release-workflow.test.ts's parse: the ordered, trimmed commands of one job's run steps */
function runCommands(yaml: string): string[] {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] ?? '');
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    const inline = (m[2] ?? '').trim();
    if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-') {
      out.push(inline.replace(/\s+#.*$/, '').trim());
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (indentOf(next) <= indent) break;
      block.push(next.trim());
      i = j;
    }
    out.push(block.join('\n'));
  }
  return out;
}

/** the text of job `name` (its `  name:` line through the line before the next job) */
function job(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end] ?? '') && !/^\S/.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end).join('\n');
}

describe('workflow hygiene', () => {
  it('finds the workflows it guards', () => {
    const names = WORKFLOWS.map((w) => w.name);
    for (const n of ['ci.yml', 'release.yml', 'prepare-release.yml']) expect(names).toContain(n);
  });

  it('rule 1: every third-party action is pinned to a full SHA with its version comment, one SHA per action', () => {
    const seen = new Map<string, string>();
    const bad: string[] = [];
    let count = 0;
    for (const w of WORKFLOWS) {
      w.text.split('\n').forEach((line, i) => {
        const m = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
        if (m === null) return;
        const ref = m[1] ?? '';
        if (ref.startsWith('./')) return;
        count += 1;
        const pin = /^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})$/.exec(ref);
        if (pin === null || !/^\s+# v\d+\.\d+\.\d+\s*$/.test(m[2] ?? '')) {
          bad.push(`${w.name}:${i + 1}: ${line.trim()}`);
          return;
        }
        const action = pin[1] ?? '';
        const sha = pin[2] ?? '';
        if (seen.has(action) && seen.get(action) !== sha) bad.push(`${w.name}:${i + 1}: ${action} pinned to a second SHA`);
        seen.set(action, sha);
      });
    }
    expect(count).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('rule 2: top-level permissions are {} or contents: read', () => {
    for (const w of WORKFLOWS) {
      const lines = w.text.split('\n');
      const at = lines.findIndex((l) => /^permissions:/.test(l));
      expect(at, `${w.name} has no top-level permissions`).toBeGreaterThanOrEqual(0);
      const head = (lines[at] ?? '').replace(/\s+#.*$/, '');
      if (head === 'permissions: {}') continue;
      expect(head, w.name).toBe('permissions:');
      const body: string[] = [];
      for (let j = at + 1; j < lines.length && (isBlank(lines[j] ?? '') || /^\s/.test(lines[j] ?? '')); j += 1) {
        if (!isBlank(lines[j] ?? '')) body.push((lines[j] ?? '').replace(/\s+#.*$/, '').trim());
      }
      expect(body, w.name).toEqual(['contents: read']);
    }
  });

  it('rule 3: no ${{ }} expression inside a run block', () => {
    const bad: string[] = [];
    let count = 0;
    for (const w of WORKFLOWS) {
      for (const r of runBlocks(w.text)) {
        count += 1;
        if (r.body.includes('${{')) bad.push(`${w.name}:${r.line}`);
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it('rule 4: secrets appear only as the whole value of an env: entry', () => {
    const bad: string[] = [];
    let count = 0;
    for (const w of WORKFLOWS) {
      const lines = w.text.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('secrets.') || line.trim().startsWith('#')) return;
        count += 1;
        const ok = /^\s+[A-Za-z_][A-Za-z0-9_]*: \$\{\{ secrets\.[A-Za-z0-9_]+ \}\}\s*$/.test(line);
        let parent = '';
        for (let j = i - 1; j >= 0; j -= 1) {
          const p = lines[j] ?? '';
          if (!isBlank(p) && indentOf(p) < indentOf(line)) {
            parent = p.trim();
            break;
          }
        }
        if (!ok || parent !== 'env:') bad.push(`${w.name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(count).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('rule 5: release shell scripts never trace and always run strict', () => {
    const scripts = readdirSync(RELEASE_SCRIPTS).filter((f) => f.endsWith('.sh'));
    expect(scripts.length).toBeGreaterThanOrEqual(7);
    for (const f of scripts) {
      const text = readFileSync(join(RELEASE_SCRIPTS, f), 'utf8');
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code, f).not.toMatch(/\bset\s+-[a-wyz]*x|set\s+-o\s+xtrace|\bbash\s+-x\b/);
      expect(code, f).toMatch(/^set -euo pipefail$/m);
    }
  });

  it('rule 6: each workflow_dispatch input is first read by a validating step; github.event.inputs is never used', () => {
    const bad: string[] = [];
    let inputs = 0;
    for (const w of WORKFLOWS) {
      if (w.text.includes('github.event.inputs')) bad.push(`${w.name}: github.event.inputs`);
      const lines = w.text.split('\n');
      const start = lines.findIndex((l) => /^\s+inputs:\s*$/.test(l));
      if (start < 0) continue;
      const names: string[] = [];
      const ind = indentOf(lines[start + 1] ?? '');
      for (let j = start + 1; j < lines.length && (isBlank(lines[j] ?? '') || indentOf(lines[j] ?? '') >= ind); j += 1) {
        const m = /^\s+([A-Za-z_][\w-]*):\s*$/.exec(lines[j] ?? '');
        if (m !== null && indentOf(lines[j] ?? '') === ind) names.push(m[1] ?? '');
      }
      const steps = stepsOf(w.text);
      for (const name of names) {
        inputs += 1;
        const re = new RegExp(`\\binputs\\.${name}\\b`);
        // a job-level `if:` or any non-step use would bypass validation
        const uses = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
        const first = steps.find((s) => s.lines.some((l) => re.test(l)));
        if (first === undefined) {
          if (uses.length > 0) bad.push(`${w.name}: inputs.${name} is read outside any step`);
          continue;
        }
        if (uses.some((i) => i < first.at)) bad.push(`${w.name}: inputs.${name} is read before its validating step`);
        const body = first.lines.join('\n');
        if (!/scripts\/release\/(version\.mjs|prepare\.sh)|=~|grep -E|case /.test(body)) bad.push(`${w.name}: the first step reading inputs.${name} does not validate it`);
      }
    }
    expect(inputs).toBeGreaterThanOrEqual(5);
    expect(bad).toEqual([]);
  });

  it('release.yml gates runs ci.yml check step for step; a separate pack job builds the published bytes', () => {
    const release = WORKFLOWS.find((w) => w.name === 'release.yml')?.text ?? '';
    const ci = runCommands(job(WORKFLOWS.find((w) => w.name === 'ci.yml')?.text ?? '', 'check'));
    const gates = runCommands(job(release, 'gates'));
    expect(ci.length).toBeGreaterThanOrEqual(10);
    expect(ci).toContain('npm ci');
    expect(gates).toEqual(ci);
    // gates installs pytest from PyPI as root, so the tarball comes from a runner that never ran that code
    const packJob = job(release, 'pack');
    const pack = runCommands(packJob);
    expect(pack.join('\n')).not.toMatch(/pip|pytest/);
    const at = (re: RegExp): number => pack.findIndex((c) => re.test(c));
    expect(at(/^npm ci$/)).toBe(0);
    expect(at(/^npm run build$/)).toBeGreaterThan(at(/^npm ci$/));
    expect(at(/^npm run pack:check$/)).toBeGreaterThan(at(/^npm run build$/));
    expect(at(/^npm pack --ignore-scripts$/)).toBeGreaterThan(at(/^npm run pack:check$/));
    expect(packJob).toMatch(/needs: \[validate, gates\]/);
    expect(job(release, 'publish-npm')).toMatch(/needs: \[validate, pack\]/);
  });
});
