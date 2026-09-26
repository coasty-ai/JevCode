#!/usr/bin/env node
/**
 * check-doc-links — every relative link in the published Markdown must resolve.
 *
 * Scope: README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md and everything under docs/.
 * Checks, for each inline link and image target — and each `src`, `href` and `srcset` target of
 * an HTML tag, such as the README's `<img>` and `<picture>` — that is not absolute (`http:`,
 * `https:`, `mailto:`) and not a bare in-page anchor:
 *   1. the file or directory the path names exists on disk;
 *   2. if the target carries a `#fragment` and names a Markdown file, that heading exists
 *      in it (GitHub's slug rules) or an explicit HTML anchor with that id does.
 * A bare `#fragment` is checked against the headings of the file it appears in.
 * Fenced blocks and inline code spans are stripped first, so an example link inside
 * backticks is not mistaken for a real one; HTML comments are skipped for the tag scan.
 *
 * Usage: node scripts/check-doc-links.mjs [--quiet]
 * Exit 0 when every link resolves, 1 otherwise.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Every Markdown file we check links out of. */
function markdownFiles() {
  const out = ROOT_FILES.filter((f) => existsSync(join(ROOT, f)));
  const walk = (rel) => {
    for (const name of readdirSync(join(ROOT, rel)).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const child = join(rel, name);
      const st = statSync(join(ROOT, child));
      if (st.isDirectory()) walk(child);
      else if (extname(name) === '.md') out.push(child);
    }
  };
  if (existsSync(join(ROOT, 'docs'))) walk('docs');
  return out;
}

/** Blank out inline code spans, keeping the line length so reported line numbers stay true. */
function withoutCodeSpans(text) {
  // Newlines are kept so reported line numbers still match the file.
  return text.replace(/(`+)(?:(?!\1)[^\n])*?\1/g, (m) => ' '.repeat(m.length));
}

/** Strip fenced code blocks so a link inside an example is not checked. */
function withoutFences(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const m = /^\s*(```+|~~~+)/.exec(line);
      if (m) {
        if (fence === null) { fence = m[1][0]; return ''; }
        if (m[1][0] === fence) { fence = null; return ''; }
        return '';
      }
      return fence === null ? line : '';
    })
    .join('\n');
}

/** GitHub's heading slug: lowercase, drop punctuation except `-` and `_`, spaces to dashes. */
function slug(heading) {
  return heading
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

const anchorCache = new Map();
/** Every fragment a Markdown file offers: heading slugs plus explicit HTML ids. */
function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const set = new Set();
  const text = readFileSync(absPath, 'utf8');
  const seen = new Map();
  for (const line of withoutFences(text).split('\n')) {
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      if (!base) continue;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  for (const m of text.matchAll(/<a\s+[^>]*(?:name|id)=["']([^"']+)["']/gi)) set.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\sid=["']([^"']+)["']/gi)) set.add(m[1].toLowerCase());
  anchorCache.set(absPath, set);
  return set;
}

/** Inline links and images: [text](target) and ![alt](target), plus [ref]: target definitions. */
function linksIn(text) {
  const out = [];
  const body = withoutCodeSpans(withoutFences(text));
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^()<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      out.push({ target: m[1], line: i + 1 });
    }
    // A link reference definition is the whole line: [label]: target "optional title".
    // Requiring the end of the line keeps prose such as `[D10]: the supervisor…` out.
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s<>]+)>?\s*(?:"[^"]*"|'[^']*')?\s*$/.exec(line);
    if (def) out.push({ target: def[1], line: i + 1 });
  }
  out.push(...htmlTargetsIn(body));
  return out;
}

/**
 * HTML tag targets: `src`, `href` and every candidate of a `srcset`. A Markdown-only scan misses the README's
 * hero image, so a missing picture would pass. Tags may span lines; comments are blanked (newlines kept) first.
 */
function htmlTargetsIn(body) {
  const out = [];
  const text = body.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  for (const tag of text.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\s(src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const value = (attr[2] ?? attr[3] ?? '').trim();
      const line = lineAt(tag.index + attr.index);
      const targets = attr[1].toLowerCase() === 'srcset'
        ? value.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean)
        : value ? [value] : [];
      for (const target of targets) out.push({ target, line });
    }
  }
  return out;
}

const files = markdownFiles();
const problems = [];
let checked = 0;

for (const rel of files) {
  const abs = join(ROOT, rel);
  const text = readFileSync(abs, 'utf8');
  for (const { target, line } of linksIn(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, …
    if (target.startsWith('//')) continue;
    checked++;
    const hash = target.indexOf('#');
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1)).toLowerCase();

    if (pathPart === '') {
      if (frag && !anchorsOf(abs).has(frag)) {
        problems.push(`${rel}:${line}  #${frag} — no such heading in this file`);
      }
      continue;
    }
    const decoded = decodeURIComponent(pathPart);
    const targetAbs = decoded.startsWith('/')
      ? join(ROOT, decoded.slice(1))
      : resolve(dirname(abs), decoded);
    if (!existsSync(targetAbs)) {
      problems.push(`${rel}:${line}  ${target} — no such file (${relative(ROOT, targetAbs)})`);
      continue;
    }
    if (frag && extname(targetAbs) === '.md' && statSync(targetAbs).isFile()) {
      if (!anchorsOf(targetAbs).has(frag)) {
        problems.push(`${rel}:${line}  ${target} — file exists, no heading "#${frag}"`);
      }
    }
  }
}

const quiet = process.argv.includes('--quiet');
if (problems.length) {
  console.error(`check-doc-links: ${problems.length} broken link(s) in ${files.length} file(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (!quiet) console.log(`check-doc-links: ok (${checked} relative link(s) in ${files.length} Markdown file(s))`);
