#!/usr/bin/env node
// CHANGELOG.md helpers for the release workflows. No dependencies.
//
//   node scripts/release/changelog.mjs promote <V> [--date YYYY-MM-DD] [--file PATH]   heading -> "## [V] — DATE"
//   node scripts/release/changelog.mjs notes <V> [--file PATH]                         release notes on stdout
//
// Accepted headings: `## [V]` or `## V`, an optional `— date`, an optional parenthetical, and `## [Unreleased]`.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const HEADING_RE = new RegExp(String.raw`^## \[?(${SEMVER}|Unreleased)\]?(?:\s+—\s+([^\n(]*))?(?:\s*\(([^)]*)\))?\s*$`);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ChangelogError extends Error {}
const fail = (msg) => {
  throw new ChangelogError(msg);
};

/** `{name, date, paren}` for a release heading line, or null */
export function parseHeading(line) {
  const m = HEADING_RE.exec(line);
  if (m === null) return null;
  return { name: m[1], date: (m[2] ?? '').trim(), paren: m[3] ?? null };
}

/** the section whose heading names `name` (a version or "Unreleased"): `{start, end, heading, body}` in lines */
export function findSection(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => parseHeading(l)?.name === name);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  return { start, end, heading: lines[start], body: lines.slice(start + 1, end).join('\n').trim() };
}

/** true when the heading carries a date and is not marked "not yet published" */
export function isPromoted(heading) {
  const h = parseHeading(heading);
  return h !== null && DATE_RE.test(h.date) && h.paren === null;
}

/** the promoted text and whether it changed */
export function promote(text, version, date) {
  if (!DATE_RE.test(date)) fail(`date must be YYYY-MM-DD; got ${JSON.stringify(date)}`);
  const section = findSection(text, version) ?? findSection(text, 'Unreleased');
  if (section === null) {
    fail(`CHANGELOG.md has neither a "## [${version}]" nor a "## [Unreleased]" section; add "## [${version}] — (not yet published)" with the release notes under it, commit, and run again`);
  }
  if (parseHeading(section.heading).name === version && isPromoted(section.heading)) return { text, changed: false };
  const lines = text.split('\n');
  lines[section.start] = `## [${version}] — ${date}`;
  return { text: lines.join('\n'), changed: true };
}

/** the release notes for `version`: the section body plus the install lines */
export function notes(text, version) {
  const section = findSection(text, version);
  if (section === null) fail(`CHANGELOG.md has no "## [${version}]" section`);
  if (section.body === '') fail(`CHANGELOG.md's "## [${version}]" section is empty`);
  const stable = !version.includes('-');
  const install = [`- npm: \`npm i -g jevcode@${version}\``];
  if (stable) {
    install.push('- Homebrew: `brew install coasty-ai/jevcode/jevcode`');
    install.push('- AUR: `yay -S jevcode`');
  }
  return `${section.body}\n\n---\n\n**Install**\n\n${install.join('\n')}\n`;
}

function parseOpts(argv) {
  const [version, ...rest] = argv;
  const opts = { version, date: new Date().toISOString().slice(0, 10), file: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md') };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (v === undefined || (k !== '--date' && k !== '--file')) fail(`unexpected argument ${JSON.stringify(k)}`);
    opts[k.slice(2)] = v;
  }
  if (!version || !new RegExp(`^${SEMVER}$`).test(version)) fail(`version must be x.y.z or x.y.z-pre; got ${JSON.stringify(version)}`);
  return opts;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'promote' && cmd !== 'notes') fail('usage: changelog.mjs promote|notes <V> [--date YYYY-MM-DD] [--file PATH]');
  const o = parseOpts(rest);
  const text = readFileSync(o.file, 'utf8');
  if (cmd === 'notes') {
    process.stdout.write(notes(text, o.version));
    return;
  }
  const r = promote(text, o.version, o.date);
  if (r.changed) writeFileSync(o.file, r.text);
  process.stderr.write(r.changed ? `changelog: promoted ${o.version} (${o.date})\n` : `changelog: ${o.version} already promoted\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof ChangelogError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`::error::${msg.replace(/\r?\n/g, ' ')}\n`);
    process.exit(1);
  }
}
