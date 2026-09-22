/**
 * The eight-dialect MCP normaliser (docs/IMPORT-DESIGN.md §3.10, §2.7, §4.7.4 step 5, §4.8.3).
 *
 * Eight tools describe the same server eight ways; `.jevcode/mcp.json` describes it once. Everything
 * here is **pure**: no filesystem, no `process.env`, and — §A.3 — no network request of any kind, not
 * even to resolve a server `url`. Three rules carry the security weight:
 *
 *   1. Every server arrives `enabled: false` (§2.7, §1 property 16). The type makes it unrepresentable
 *      otherwise, and `mergeMcpFile`/`parseMcpFile` re-assert it on values that came from disk.
 *   2. Every env-reference form becomes `${VAR}`; a **literal** that looks like a credential is replaced
 *      by its own variable name with the §4.8.3 note, so the value never leaves its file.
 *   3. **Credential-looking variables are never expanded** into a remote `url` or `headers`
 *      (`SECRET_NAME_RE`, `redact.ts:56`) — the same rule Claude Code itself applies. Nothing in this
 *      module can expand a reference at all; the sighting is recorded as a note so the report says so.
 */
import { IMPORT_LIMITS } from '../core/limits.js';
import { detectSecrets, SECRET_NAME_RE } from '../core/redact.js';
import type { Json } from '../core/types.js';
import type { McpFile, McpServerRecord, SourceTool } from './types.js';

/** §3.10: the eight source dialects the atlas knows. */
export type McpDialect = 'claude-code' | 'cursor' | 'windsurf' | 'gemini' | 'opencode' | 'codex' | 'vscode' | 'claude-desktop';

/** §3.10: one parsed source document, plus the provenance every record carries (§0 principle 6). */
export interface NormaliseInput {
  dialect: McpDialect;
  tool: SourceTool;
  /** `~/…` display form; it lands in `McpServerRecord.source.path` */
  sourcePath: string;
  sourceSha256: string;
  importId: string;
  /** the tolerant parser's output for the whole document — never a body, never a value we retain */
  raw: Json;
  /** VS Code's `inputs[]`, when the caller read it from elsewhere in the document */
  inputs?: Json;
}

/** §3.10: the normalised servers, the report's notes and every extra that was dropped by name. */
export interface NormaliseResult {
  servers: Readonly<Record<string, McpServerRecord>>;
  notes: readonly string[];
  dropped: readonly string[];
}

// ---------------------------------------------------------------------------------------
// tolerant Json accessors — the parsers are total (§4.3), so nothing here throws
// ---------------------------------------------------------------------------------------

function asObject(v: Json | undefined): Readonly<Record<string, Json>> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
}
function asString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}
function asStringArray(v: Json | undefined): readonly string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}
/** A variable name safe to write into a `${…}` reference. */
function varName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_]/g, '_');
}

// ---------------------------------------------------------------------------------------
// §3.10: the dialect table
// ---------------------------------------------------------------------------------------

/** Where each dialect keeps its server map; the first key present wins. */
const SERVER_KEYS: Readonly<Record<McpDialect, readonly string[]>> = {
  'claude-code': ['mcpServers', 'servers'],
  cursor: ['mcpServers'],
  windsurf: ['mcpServers'],
  gemini: ['mcpServers'],
  opencode: ['mcp'],
  codex: ['mcp_servers'],
  vscode: ['servers'],
  'claude-desktop': ['mcpServers'],
};

/** §3.10 column 5 — extras dropped, and the reason the report prints. */
const DROPPED_EXTRAS: Readonly<Record<McpDialect, Readonly<Record<string, string>>>> = {
  'claude-code': { headersHelper: 'it runs a command to build a header', oauth: 'account-side OAuth is never imported', alwaysLoad: 'JevCode has no equivalent' },
  cursor: { envFile: 'it names a file of values; the importer never reads one' },
  windsurf: {},
  gemini: { oauth: 'oauth.clientSecret is a credential (§4.8.1)', trust: 'a permission decision is never imported (§4.8.4)' },
  opencode: {},
  codex: {},
  vscode: { envFile: 'it names a file of values; the importer never reads one' },
  'claude-desktop': {},
};

/** §3.10 column 5 — extras kept as a report note (the normalised record has nowhere to put them). */
const RECORDED_EXTRAS: Readonly<Record<McpDialect, readonly string[]>> = {
  'claude-code': [],
  cursor: [],
  windsurf: [],
  gemini: ['includeTools', 'excludeTools'],
  opencode: [],
  codex: ['enabled_tools', 'disabled_tools'],
  vscode: [],
  'claude-desktop': [],
};

/** Keys every dialect's reader consumes; anything else becomes a `dropped` entry, so nothing is silent (§1 property 2). */
const CONSUMED = new Set([
  'type',
  'transport',
  'command',
  'args',
  'url',
  'serverUrl',
  'httpUrl',
  'env',
  'environment',
  'headers',
  'env_key',
  'bearer_token_env_var',
  'enabled',
  'disabled',
  'name',
  'description',
  'timeout',
  'cwd',
]);

const FILE_REF_RE = /(?:\$\{file:[^}]*\}|\{file:[^}]*\})/;
const SSE_RE = /\/sse\/?(?:$|[?#])/;
const AUTH_HEADER_RE = /^(?:authorization|proxy-authorization|x-api-key|api-key)$/i;

// ---------------------------------------------------------------------------------------
// §3.10: env-reference normalisation
// ---------------------------------------------------------------------------------------

/**
 * §3.10: normalise one env-reference form to `${VAR}`; returns **null when the value is a literal**
 * (which is what makes the §4.8.3 substitution decidable). Every dialect's `${…}` forms are accepted
 * everywhere — recognising `${VAR}` in a dialect that has no expansion syntax is safe, because nothing
 * in this module ever expands anything — while `{env:…}` (opencode) and `$VAR` / `%VAR%` (Gemini) are
 * only read for the dialect that defines them, so a Windows `%PATH%` literal elsewhere survives intact.
 *
 * `${workspaceFolder}` → `${JEVCODE_WORKSPACE}`, `${userHome}` → `${HOME}`, `${pathSeparator}` → `/`,
 * `${input:id}` → `${ID_UPPER}`, `${VAR:-default}` → `${VAR}`. A `${file:…}` reference is left exactly
 * as written and reported as *not* a reference: the importer never reads a file a config points at.
 */
export function normaliseReference(value: string, dialect: McpDialect): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let changed = false;
  let out = value.replace(/\$\{([^{}]*)\}/g, (whole, inner: string): string => {
    if (inner.startsWith('file:')) return whole;
    changed = true;
    if (inner === 'workspaceFolder') return '${JEVCODE_WORKSPACE}';
    if (inner === 'userHome') return '${HOME}';
    if (inner === 'pathSeparator') return '/';
    if (inner.startsWith('input:')) return `\${${varName(inner.slice(6)).toUpperCase()}}`;
    if (inner.startsWith('env:')) return `\${${varName(inner.slice(4))}}`;
    const colon = inner.indexOf(':');
    return `\${${varName(colon === -1 ? inner : inner.slice(0, colon))}}`;
  });
  if (dialect === 'opencode') {
    out = out.replace(/\{env:([^{}]*)\}/g, (_m, inner: string): string => {
      changed = true;
      return `\${${varName(inner)}}`;
    });
  }
  if (dialect === 'gemini') {
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, inner: string): string => {
      changed = true;
      return `\${${inner}}`;
    });
    out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, inner: string): string => {
      changed = true;
      return `\${${inner}}`;
    });
  }
  return changed ? out : null;
}

/** Every `${VAR}` name inside an already-normalised value. */
function referencedVars(value: string): readonly string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/** §4.8.3 / §4.4.2 rule 8: a literal that must not travel — the key names a credential, or the value is one. */
function looksLikeCredential(key: string, value: string): boolean {
  return SECRET_NAME_RE.test(key) || detectSecrets(value).length > 0;
}

// ---------------------------------------------------------------------------------------
// §3.10: transport inference
// ---------------------------------------------------------------------------------------

/** §3.10: `command` → stdio; `httpUrl` → http; `url` ending `/sse` or a declared SSE → sse; otherwise http. A declared type wins. */
function inferTransport(declared: string | null, hasCommand: boolean, url: string | null, hasHttpUrl: boolean): 'stdio' | 'http' | 'sse' {
  const d = declared === null ? null : declared.toLowerCase();
  if (d === 'stdio' || d === 'local') return 'stdio';
  if (d === 'sse') return 'sse';
  if (d === 'http' || d === 'streamable-http' || d === 'streamablehttp') return 'http';
  if (hasCommand) return 'stdio';
  if (hasHttpUrl) return 'http';
  if (url !== null && SSE_RE.test(url)) return 'sse';
  return 'http';
}

// ---------------------------------------------------------------------------------------
// §3.10: the normaliser
// ---------------------------------------------------------------------------------------

interface ServerDraft {
  notes: string[];
  dropped: string[];
}

function readCommand(srv: Readonly<Record<string, Json>>): { command: string | null; args: readonly string[] } {
  const raw = srv['command'];
  let command: string | null = null;
  let args: string[] = [];
  if (typeof raw === 'string') command = raw;
  else if (Array.isArray(raw)) {
    // opencode writes `command: ["npx", "-y", "pkg"]`
    const parts = raw.filter((x): x is string => typeof x === 'string');
    command = parts[0] ?? null;
    args = parts.slice(1);
  }
  const explicit = asStringArray(srv['args']);
  if (explicit !== null) args = [...args, ...explicit];
  return { command, args };
}

function readEnv(name: string, srv: Readonly<Record<string, Json>>, dialect: McpDialect, draft: ServerDraft): Record<string, string> {
  const env: Record<string, string> = {};
  const source = asObject(srv['env']) ?? asObject(srv['environment']);
  for (const [key, raw] of Object.entries(source ?? {})) {
    const value = asString(raw);
    if (value === null) {
      draft.dropped.push(`${name}.env.${key} (not a string)`);
      continue;
    }
    if (FILE_REF_RE.test(value)) {
      draft.dropped.push(`${name}.env.${key} (file reference)`);
      draft.notes.push(`env ${key} used a file reference; it was dropped — the importer never reads a referenced file`);
      continue;
    }
    const reference = normaliseReference(value, dialect);
    if (reference !== null) {
      env[key] = reference;
      continue;
    }
    if (looksLikeCredential(key, value)) {
      env[key] = `\${${varName(key)}}`;
      draft.notes.push(`env ${key} held a literal value in the source; only the name was imported`);
      continue;
    }
    env[key] = value;
  }
  // §3.10: Codex carries variable **names**, never values
  const envKey = asString(srv['env_key']);
  if (envKey !== null) {
    env[varName(envKey)] = `\${${varName(envKey)}}`;
    draft.notes.push(`codex env_key ${varName(envKey)} imported as the variable reference \${${varName(envKey)}}; it renders back as env, not env_key`);
  }
  return env;
}

function readHeaders(name: string, srv: Readonly<Record<string, Json>>, dialect: McpDialect, draft: ServerDraft): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = asObject(srv['headers']);
  for (const [key, raw] of Object.entries(source ?? {})) {
    const value = asString(raw);
    if (value === null) {
      draft.dropped.push(`${name}.headers.${key} (not a string)`);
      continue;
    }
    if (FILE_REF_RE.test(value)) {
      draft.dropped.push(`${name}.headers.${key} (file reference)`);
      draft.notes.push(`header ${key} used a file reference; it was dropped — the importer never reads a referenced file`);
      continue;
    }
    const reference = normaliseReference(value, dialect);
    if (reference !== null) {
      headers[key] = reference;
      for (const v of referencedVars(reference)) {
        if (SECRET_NAME_RE.test(v)) draft.notes.push(`header ${key} holds the reference \${${v}}; it is never expanded (§3.10)`);
      }
      continue;
    }
    if (AUTH_HEADER_RE.test(key) || looksLikeCredential(key, value)) {
      const generated = `MCP_${varName(name).toUpperCase()}_${AUTH_HEADER_RE.test(key) ? 'AUTH' : varName(key).toUpperCase()}`;
      headers[key] = `\${${generated}}`;
      draft.notes.push(`header ${key} held a literal value in the source; only the name was imported (\${${generated}})`);
      continue;
    }
    headers[key] = value;
  }
  const bearer = asString(srv['bearer_token_env_var']);
  if (bearer !== null) {
    headers['Authorization'] = `\${${varName(bearer)}}`;
    draft.notes.push(`codex bearer_token_env_var ${varName(bearer)} imported as the reference \${${varName(bearer)}}; it is never expanded`);
  }
  return headers;
}

/**
 * §3.10: the eight-dialect normaliser. Transport inference, env-reference normalisation to `${VAR}`,
 * and the NEVER-EXPAND rule for credential-looking variables. Pure.
 */
export function normaliseMcp(input: NormaliseInput): NormaliseResult {
  const notes: string[] = [];
  const dropped: string[] = [];
  const root = asObject(input.raw);
  if (root === null) return { servers: {}, notes: ['the source did not parse to an object; no MCP server was imported'], dropped: [] };

  let map: Readonly<Record<string, Json>> | null = null;
  for (const key of SERVER_KEYS[input.dialect]) {
    const candidate = asObject(root[key]);
    if (candidate !== null) {
      map = candidate;
      break;
    }
  }
  // a bare server map (the fragment form `--from -` and `.mcp.json` snippets both produce it)
  if (map === null && Object.values(root).every((v) => asObject(v) !== null)) map = root;
  if (map === null) return { servers: {}, notes: ['the source held no MCP server map'], dropped: [] };

  const inputDescriptions = new Map<string, string>();
  for (const entry of Array.isArray(input.inputs) ? input.inputs : Array.isArray(root['inputs']) ? root['inputs'] : []) {
    const o = asObject(entry);
    const id = o === null ? null : asString(o['id']);
    if (id === null) continue;
    inputDescriptions.set(varName(id).toUpperCase(), asString(o?.['description']) ?? id);
  }

  const servers: Record<string, McpServerRecord> = {};
  for (const [rawName, rawServer] of Object.entries(map)) {
    const name = varName(rawName).length > 0 ? rawName : 'server';
    if (Object.keys(servers).length >= IMPORT_LIMITS.mcpServers) {
      dropped.push(`${name} (over the ${IMPORT_LIMITS.mcpServers}-server cap)`);
      continue;
    }
    const srv = asObject(rawServer);
    if (srv === null) {
      dropped.push(`${name} (not an object)`);
      continue;
    }
    const draft: ServerDraft = { notes: [], dropped: [] };
    const { command, args } = readCommand(srv);
    const httpUrl = asString(srv['httpUrl']);
    const plainUrl = asString(srv['url']) ?? asString(srv['serverUrl']);
    if (httpUrl !== null && plainUrl !== null) {
      draft.dropped.push(`${name}.url (the record carries one url; httpUrl wins)`);
      draft.notes.push('gemini httpUrl and url were both set; the record keeps httpUrl — url is a fixed, reported loss (§8.2 R6)');
    }
    const rawUrl = httpUrl ?? plainUrl;
    let url: string | null = null;
    if (rawUrl !== null) {
      if (FILE_REF_RE.test(rawUrl)) {
        draft.dropped.push(`${name}.url (file reference)`);
      } else {
        url = normaliseReference(rawUrl, input.dialect) ?? rawUrl;
        for (const v of referencedVars(url)) {
          if (SECRET_NAME_RE.test(v)) draft.notes.push(`url holds the reference \${${v}}; it is never expanded (§3.10)`);
        }
      }
    }
    const transport = inferTransport(asString(srv['type']) ?? asString(srv['transport']), command !== null, url, httpUrl !== null);
    const env = readEnv(name, srv, input.dialect, draft);
    const headers = readHeaders(name, srv, input.dialect, draft);
    for (const v of Object.values(env)) {
      for (const ref of referencedVars(v)) {
        if (transport !== 'stdio' && SECRET_NAME_RE.test(ref)) draft.notes.push(`env holds the reference \${${ref}} for a remote server; it is never expanded (§3.10)`);
      }
    }
    // §3.10 column 5: the extras, named either way — nothing is dropped silently (§1 property 2)
    for (const [key, why] of Object.entries(DROPPED_EXTRAS[input.dialect])) {
      if (key in srv) {
        draft.dropped.push(`${name}.${key}`);
        draft.notes.push(`${key} dropped: ${why}`);
      }
    }
    for (const key of RECORDED_EXTRAS[input.dialect]) {
      if (key in srv) draft.notes.push(`${key} is recorded in the report, not applied`);
    }
    for (const key of Object.keys(srv)) {
      if (CONSUMED.has(key)) continue;
      if (key in DROPPED_EXTRAS[input.dialect]) continue;
      if (RECORDED_EXTRAS[input.dialect].includes(key)) continue;
      draft.dropped.push(`${name}.${key}`);
      draft.notes.push(`${key} is not part of the normalised record; it was dropped`);
    }
    for (const value of [...Object.values(env), ...Object.values(headers), url ?? '']) {
      for (const ref of referencedVars(value)) {
        const described = inputDescriptions.get(ref);
        if (described !== undefined) draft.notes.push(`\${${ref}} came from the VS Code input "${described}"`);
      }
    }

    const record: McpServerRecord = {
      transport,
      ...(command !== null ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(url !== null && transport !== 'stdio' ? { url } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      enabled: false,
      source: { tool: input.tool, path: input.sourcePath, sha256: input.sourceSha256, importId: input.importId },
      ...(draft.notes.length > 0 ? { notes: [...new Set(draft.notes)] } : {}),
    };
    servers[name] = record;
    for (const note of new Set(draft.notes)) notes.push(`${name}: ${note}`);
    dropped.push(...draft.dropped);
  }
  return { servers, notes, dropped };
}

// ---------------------------------------------------------------------------------------
// §4.7.4 step 5: the merge
// ---------------------------------------------------------------------------------------

/** Every record that reaches disk is re-asserted disabled, whatever the value on disk said (§1 property 16). */
function disabled(rec: McpServerRecord): McpServerRecord {
  return rec.enabled === false ? rec : { ...rec, enabled: false };
}

/**
 * §4.7.4 step 5: existing servers untouched, new ones added `enabled: false`, name collision →
 * `<name>-<tool>` (then `-2`, `-3`… if that collides too). `added` names every server the file gained,
 * `renamed` the subset that collided and got a suffix, `dropped` whatever the `mcpServers` cap refused.
 */
export function mergeMcpFile(
  existing: McpFile | null,
  incoming: Readonly<Record<string, McpServerRecord>>,
  opts: { maxServers?: number } = {},
): { file: McpFile; added: readonly string[]; renamed: readonly string[]; dropped: readonly string[] } {
  const maxServers = Math.max(0, opts.maxServers ?? IMPORT_LIMITS.mcpServers);
  const servers: Record<string, McpServerRecord> = {};
  for (const [name, rec] of Object.entries(existing?.servers ?? {})) servers[name] = disabled(rec);
  const added: string[] = [];
  const renamed: string[] = [];
  const dropped: string[] = [];
  for (const [name, rec] of Object.entries(incoming)) {
    if (Object.keys(servers).length >= maxServers) {
      dropped.push(`${name} (over the ${maxServers}-server cap)`);
      continue;
    }
    let final = name;
    if (final in servers) {
      final = `${name}-${rec.source.tool}`;
      for (let n = 2; final in servers; n++) final = `${name}-${rec.source.tool}-${n}`;
      renamed.push(final);
    }
    servers[final] = disabled(rec);
    added.push(final);
  }
  return { file: { v: 1, servers }, added, renamed, dropped };
}

// ---------------------------------------------------------------------------------------
// §2.7: the file
// ---------------------------------------------------------------------------------------

/** §2.7: `.jevcode/mcp.json`, servers in name order and record keys in a fixed order, so a re-run diffs cleanly. */
export function renderMcpFile(file: McpFile): string {
  const servers: Record<string, Json> = {};
  for (const name of Object.keys(file.servers).sort()) {
    const rec = file.servers[name];
    if (rec === undefined) continue;
    const ordered: Record<string, Json> = { transport: rec.transport };
    if (rec.command !== undefined) ordered['command'] = rec.command;
    if (rec.args !== undefined) ordered['args'] = [...rec.args];
    if (rec.url !== undefined) ordered['url'] = rec.url;
    if (rec.env !== undefined) ordered['env'] = { ...rec.env };
    if (rec.headers !== undefined) ordered['headers'] = { ...rec.headers };
    ordered['enabled'] = false;
    ordered['source'] = { tool: rec.source.tool, path: rec.source.path, sha256: rec.source.sha256, importId: rec.source.importId };
    if (rec.notes !== undefined) ordered['notes'] = [...rec.notes];
    servers[name] = ordered;
  }
  return `${JSON.stringify({ v: 1, servers }, null, 2)}\n`;
}

const SOURCE_TOOLS: ReadonlySet<string> = new Set<SourceTool>(['claude-code', 'claude-desktop', 'codex', 'opencode', 'cursor', 'windsurf', 'aider', 'gemini', 'copilot', 'mcp', 'pasted']);
function asSourceTool(v: Json | undefined): SourceTool {
  const s = asString(v);
  return s !== null && SOURCE_TOOLS.has(s) ? (s as SourceTool) : 'mcp';
}

/** §2.7: read `.jevcode/mcp.json` back. Tolerant and total — a malformed file is `null`, never a throw. */
export function parseMcpFile(text: string): McpFile | null {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  const root = asObject(parsed);
  if (root === null || root['v'] !== 1) return null;
  const rawServers = asObject(root['servers']);
  if (rawServers === null) return null;
  const servers: Record<string, McpServerRecord> = {};
  for (const [name, raw] of Object.entries(rawServers)) {
    const srv = asObject(raw);
    if (srv === null) continue;
    const transport = asString(srv['transport']);
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') continue;
    const sourceObj = asObject(srv['source']);
    const command = asString(srv['command']);
    const args = asStringArray(srv['args']);
    const url = asString(srv['url']);
    const env = asObject(srv['env']);
    const headers = asObject(srv['headers']);
    const notes = asStringArray(srv['notes']);
    const stringMap = (o: Readonly<Record<string, Json>> | null): Record<string, string> | null => {
      if (o === null) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
      return out;
    };
    const envMap = stringMap(env);
    const headerMap = stringMap(headers);
    servers[name] = {
      transport,
      ...(command !== null ? { command } : {}),
      ...(args !== null && args.length > 0 ? { args } : {}),
      ...(url !== null ? { url } : {}),
      ...(envMap !== null ? { env: envMap } : {}),
      ...(headerMap !== null ? { headers: headerMap } : {}),
      enabled: false,
      source: {
        tool: asSourceTool(sourceObj?.['tool']),
        path: asString(sourceObj?.['path']) ?? '',
        sha256: asString(sourceObj?.['sha256']) ?? '',
        importId: asString(sourceObj?.['importId']) ?? '',
      },
      ...(notes !== null && notes.length > 0 ? { notes } : {}),
    };
  }
  return { v: 1, servers };
}

// ---------------------------------------------------------------------------------------
// §8.2 R6: render back to the source dialect
// ---------------------------------------------------------------------------------------

function denormaliseValue(value: string, dialect: McpDialect): string {
  if (dialect === 'cursor' || dialect === 'windsurf' || dialect === 'vscode') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}');
  if (dialect === 'opencode') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}');
  return value;
}

function denormaliseMap(map: Readonly<Record<string, string>> | undefined, dialect: McpDialect): Json | null {
  if (map === undefined || Object.keys(map).length === 0) return null;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(map)) out[k] = denormaliseValue(v, dialect);
  return out;
}

/**
 * §8.2 R6: render one normalised record back to a source dialect, for the round-trip gate. Six dialects
 * round-trip byte-stable modulo key order; the two documented losses are **Gemini `httpUrl`** (the record
 * carries a single `url`, so a source that set both comes back with only the `httpUrl` one) and **Codex
 * `env_key`** (a variable *name* becomes an ordinary `env` entry and renders back as `env`). Both are
 * asserted explicitly in `mcp.test.ts`, so a silent loss becomes a test failure.
 */
export function renderBackTo(dialect: McpDialect, _name: string, rec: McpServerRecord): Json {
  // `_name` is the server's key in the source map (and Codex's `[mcp_servers.<name>]` header). Every
  // dialect keys the map by it, so the caller owns it and the rendered body never repeats it; it stays
  // in the signature because the round-trip gate pairs name and body.
  const out: Record<string, Json> = {};
  const declaresType = dialect === 'claude-code' || dialect === 'opencode' || dialect === 'vscode';
  if (declaresType) out['type'] = dialect === 'opencode' && rec.transport === 'stdio' ? 'local' : rec.transport;
  if (rec.command !== undefined) out['command'] = rec.command;
  if (rec.args !== undefined && rec.args.length > 0) out['args'] = [...rec.args];
  if (rec.url !== undefined) {
    if (dialect === 'windsurf') out['serverUrl'] = rec.url;
    else if (dialect === 'gemini' && rec.transport === 'http') out['httpUrl'] = rec.url;
    else out['url'] = rec.url;
  }
  const env = denormaliseMap(rec.env, dialect);
  if (env !== null) out[dialect === 'opencode' ? 'environment' : 'env'] = env;
  const headers = denormaliseMap(rec.headers, dialect);
  if (headers !== null) out['headers'] = headers;
  // never rendered back: `enabled` is JevCode's own gate (§2.7) and `source` is provenance, not configuration
  return out;
}
