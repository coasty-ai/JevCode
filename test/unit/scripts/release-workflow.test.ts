/**
 * The release job runs the gates the merges are gated on (.github/workflows/release.yml).
 *
 * The job ran typecheck + test + build + pack:check + gen-docs but never `node scripts/jev-contract.mjs`, so the
 * four-clause Jev contract lint that every merge message in this wave cites as a gate (34 sites / 10 four-clause /
 * 24 allow-listed) was not enforced at tag time: a four-clause block deleted on the way to a release would have
 * shipped. package.json already defines `check` as the composite the sessions actually type
 * (`typecheck && jev-contract && test`), so the job ran that. Since the release pipeline rewrite the `gates` job runs
 * ci.yml's steps one by one (`npm run jev-contract` among them), and the pins below hold for either shape.
 *
 * Failing-first: red at d297b29, where the pair `npm run typecheck` / `npm test` names neither `check` nor
 * `jev-contract`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW = join(ROOT, '.github/workflows/release.yml');

/**
 * The shell commands the `publish` job runs, in order. A hand parse rather than a YAML dependency: steps are
 * `- run: <cmd>` or `- run: |` followed by an indented block, both under a `steps:` list, and a `- name:` step's
 * `run:` is the same shape one line down. Comments after the command are dropped.
 */
function runSteps(yaml: string): string[] {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    const inline = (m[2] ?? '').trim();
    if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-') {
      out.push(inline.replace(/\s+#.*$/, '').trim());
      continue;
    }
    // a block scalar: every following line indented past the `run:` key belongs to it
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if ((/^\s*/.exec(next)?.[0] ?? '').length <= indent) break;
      block.push(next.trim());
      i = j;
    }
    out.push(block.join('\n'));
  }
  return out;
}

describe('.github/workflows/release.yml runs the Jev contract lint before it builds', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const steps = runSteps(yaml);

  it('parses the job into its ordered run steps', () => {
    // the parse itself must be load-bearing: if it stops finding steps the assertions below go vacuous
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps).toContain('npm ci');
    expect(steps.some((s) => /npm run build\b/.test(s))).toBe(true);
    expect(steps.some((s) => /npm run pack:check\b/.test(s))).toBe(true);
  });

  it('a step runs jev-contract — directly or through `npm run check` — and it runs before `npm run build`', () => {
    const lint = steps.findIndex((s) => /npm run (check|jev-contract)\b/.test(s) || /scripts\/jev-contract\.mjs/.test(s));
    const build = steps.findIndex((s) => /npm run build\b/.test(s));
    expect(lint, `no jev-contract step in ${steps.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(lint).toBeLessThan(build);
  });

  it('`npm run check` is the composite that reaches jev-contract, so the step above is not a lie', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const check = pkg.scripts['check'] ?? '';
    // only meaningful when the workflow leans on `check` rather than naming the lint itself
    if (!steps.some((s) => /npm run check\b/.test(s))) return;
    expect(check).toMatch(/\bjev-contract\b/);
    expect(check).toMatch(/\btypecheck\b/);
    expect(check).toMatch(/\btest\b/);
    expect(pkg.scripts['jev-contract']).toBe('node scripts/jev-contract.mjs');
  });
});

describe('release.yml refuses a README that names the unscoped npm package', () => {
  // README.md ships in the tarball and is the @coasty-ai/jevcode package page; npm refused the unscoped name, so
  // `npx jevcode` there installs nothing. ci.yml cannot carry this check until the README (another session's file)
  // is scoped, and gates must mirror ci.yml, so it runs in the validate job, before anything is built or published.
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const validate = yaml.slice(yaml.indexOf('\n  validate:'), yaml.indexOf('\n  gates:'));
  const pattern = /- name: README names the scoped npm package\n\s+run: \|\n\s+if grep -nE '([^']+)' README\.md; then/.exec(validate)?.[1] ?? '';
  const hits = (text: string): number => Number(spawnSync('grep', ['-cE', pattern], { input: `${text}\n`, encoding: 'utf8' }).stdout.trim());

  it('the validate job carries the step', () => {
    expect(validate.length).toBeGreaterThan(0);
    expect(pattern, 'the README step and its grep pattern must be in the validate job').not.toBe('');
  });

  it.each([
    'npm install -g jevcode', 'npm i -g jevcode@next', 'npx jevcode', 'npx -y jevcode', 'bunx jevcode', 'pnpm dlx jevcode',
    'pnpm add -g jevcode', 'yarn dlx jevcode', 'bun i -g jevcode', 'mise use -g npm:jevcode', '`npm install jevcode` adds one',
    'registry.npmjs.org/jevcode is a 404', 'https://www.npmjs.com/package/jevcode', 'npm view jevcode version',
  ])('refuses %s', (line) => {
    expect(hits(line)).toBe(1);
  });

  it.each([
    'npm i -g @coasty-ai/jevcode', 'npx @coasty-ai/jevcode', 'bunx @coasty-ai/jevcode@next', 'mise use -g npm:@coasty-ai/jevcode',
    'registry.npmjs.org/@coasty-ai%2fjevcode', 'https://www.npmjs.com/package/@coasty-ai/jevcode', '`npm install @coasty-ai/jevcode` adds one',
    'brew install coasty-ai/jevcode/jevcode', 'yay -S jevcode', 'nix run github:coasty-ai/JevCode', 'run jevcode upgrade',
  ])('accepts %s', (line) => {
    expect(hits(line)).toBe(0);
  });
});
