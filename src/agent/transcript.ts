/**
 * The agent's append-only conversation (docs/AGENT-LOOP-DESIGN.md §7.6, §10): seq-addressed records, JSONL persistence in
 * `<runDir>/agent/transcript.jsonl` (mode 0600), restore with truncation after the checkpoint's `transcriptSeq`, and the
 * projection into the `AgentMessage[]` a request carries (masking marks and the latest compaction applied).
 *
 * Invariants the rest of the driver relies on:
 *  - a call is resolved only once its `result` record exists; the queue is always re-derived from the records;
 *  - memory is updated before the disk append, so a failed write never un-resolves a call (the error is rethrown after);
 *  - text is redacted before it is recorded; `providerState` is kept verbatim (a redaction could corrupt a signature) and
 *    is never emitted in events or logs.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentAssistantBlock, AgentMessage, AgentUserBlock, Json, JsonObject, ProviderName, ProviderReplayState } from '../core/types.js';
import { writeFileAtomic } from '../core/atomic.js';
import { ConfigError } from '../errors.js';

export type NoteTag = 'steer' | 'continue' | 'verify' | 'loop' | 'progress';

/** One call as the assistant record keeps (and replays) it. `error`: the parse-time verdict of an unrepairable call. */
export interface RecordedCall {
  id: string;
  name: string;
  input: JsonObject;
  error?: string;
}

interface Base {
  v: 1;
  seq: number;
  at: string;
  turn?: number;
}

export type CarryRecord = Base & { kind: 'carry'; parentRunId: string; parentSeq: number };
export type UserRecord = Base & { kind: 'user'; text: string };
export type NoteRecord = Base & { kind: 'note'; text: string; tag: NoteTag };
export type AssistantRecord = Base & { kind: 'assistant'; text: string; calls: RecordedCall[]; providerState?: ProviderReplayState; stopReason: string; sys: string };
export type ResultRecord = Base & { kind: 'result'; toolUseId: string; name: string; content: string; isError: boolean; summary: string; pointer?: string };
export type MaskRecord = Base & { kind: 'mask'; ids: string[] };
export type CompactionRecord = Base & { kind: 'compaction'; text: string; fromSeq: number; toSeq: number; by: 'llm' | 'code' };

export type TranscriptRecord = CarryRecord | UserRecord | NoteRecord | AssistantRecord | ResultRecord | MaskRecord | CompactionRecord;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewRecord = DistributiveOmit<TranscriptRecord, 'v' | 'seq' | 'at'>;

/** A resumed agent run whose transcript is gone: the resume is refused rather than silently restarted (§3.1, §10). */
export class AgentTranscriptMissingError extends ConfigError {
  readonly path: string;
  constructor(path: string) {
    super(`agent transcript missing: ${path} — the run cannot be resumed without it (start a new run instead)`, { setting: 'resume' });
    this.path = path;
  }
}

export function transcriptPath(runDir: string): string {
  return join(runDir, 'agent', 'transcript.jsonl');
}

function isRecord(v: unknown): v is TranscriptRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { v?: unknown; seq?: unknown; kind?: unknown };
  return r.v === 1 && typeof r.seq === 'number' && typeof r.kind === 'string';
}

/** Read a transcript file; a torn last line (a crash mid-append) is dropped. null when the file does not exist. */
export async function readTranscript(path: string): Promise<TranscriptRecord[] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  const out: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // a torn line: everything after it belongs to an uncommitted step
      break;
    }
  }
  return out;
}

function line(r: TranscriptRecord): string {
  return `${JSON.stringify(r)}\n`;
}

export interface ProjectOptions {
  provider: ProviderName;
  model: string;
  systemHash: string;
  replay: boolean;
}

/** The in-memory transcript plus its file. */
export class Transcript {
  readonly records: TranscriptRecord[] = [];
  private readonly path: string;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => number) {
    this.path = path;
    this.now = now;
  }

  get file(): string {
    return this.path;
  }

  lastSeq(): number {
    return this.records.length === 0 ? 0 : this.records[this.records.length - 1]!.seq;
  }

  /** Replace the file with `records` (restore truncation, a fresh head, a carry copy). */
  async reset(records: readonly TranscriptRecord[]): Promise<void> {
    this.records.length = 0;
    this.records.push(...records);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, records.map(line).join(''), { mode: 0o600 });
  }

  /** Append one record: memory first, then the file (serialised). A write failure is rethrown after the memory update. */
  async append(r: NewRecord): Promise<TranscriptRecord> {
    const record = { ...r, v: 1 as const, seq: this.lastSeq() + 1, at: new Date(this.now()).toISOString() } as TranscriptRecord;
    this.records.push(record);
    const write = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line(record), { encoding: 'utf8', mode: 0o600 });
    });
    this.chain = write.catch(() => undefined);
    await write;
    return record;
  }

  latestAssistant(): AssistantRecord | null {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const r = this.records[i]!;
      if (r.kind === 'assistant') return r;
      if (r.kind === 'compaction') return null;
    }
    return null;
  }

  /** §3.1 step 3: the calls of the latest assistant record that have no result record — the queue. */
  unresolved(): RecordedCall[] {
    const a = this.latestAssistant();
    if (a === null) return [];
    const resolved = new Set(this.records.filter((r): r is ResultRecord => r.kind === 'result' && r.seq > a.seq).map((r) => r.toolUseId));
    return a.calls.filter((c) => !resolved.has(c.id));
  }

  /** The last record is an assistant turn without calls (a finish or verify that was discarded, or never observed). */
  trailingReply(): AssistantRecord | null {
    const last = this.records[this.records.length - 1];
    return last !== undefined && last.kind === 'assistant' && last.calls.length === 0 ? last : null;
  }

  usedIds(): Set<string> {
    const out = new Set<string>();
    for (const r of this.records) if (r.kind === 'assistant') for (const c of r.calls) out.add(c.id);
    return out;
  }

  /** The first `user` record (the head the compaction carries forward). */
  firstUser(): UserRecord | null {
    return (this.records.find((r) => r.kind === 'user') as UserRecord | undefined) ?? null;
  }

  masked(): Set<string> {
    const out = new Set<string>();
    for (const r of this.records) if (r.kind === 'mask') for (const id of r.ids) out.add(id);
    return out;
  }

  /** Records from the latest compaction on (the part a request replays). */
  live(): TranscriptRecord[] {
    for (let i = this.records.length - 1; i >= 0; i -= 1) if (this.records[i]!.kind === 'compaction') return this.records.slice(i);
    return this.records.slice();
  }

  /** §6.2 / §7.3 / §7.4: the transcript as request messages. */
  messages(o: ProjectOptions): AgentMessage[] {
    const masked = this.masked();
    const out: AgentMessage[] = [];
    let results: Extract<AgentUserBlock, { type: 'tool_result' }>[] = [];
    let texts: AgentUserBlock[] = [];
    let order: string[] = [];
    const flush = (): void => {
      if (results.length === 0 && texts.length === 0) return;
      results.sort((x, y) => order.indexOf(x.toolUseId) - order.indexOf(y.toolUseId));
      out.push({ role: 'user', content: [...results, ...texts] });
      results = [];
      texts = [];
    };
    for (const r of this.live()) {
      switch (r.kind) {
        case 'compaction':
        case 'user':
        case 'note':
          texts.push({ type: 'text', text: r.text });
          break;
        case 'result':
          results.push({ type: 'tool_result', toolUseId: r.toolUseId, name: r.name, content: masked.has(r.toolUseId) ? elided(r) : r.content, ...(r.isError ? { isError: true } : {}) });
          break;
        case 'assistant': {
          flush();
          const content: AgentAssistantBlock[] = [];
          if (r.text.length > 0) content.push({ type: 'text', text: r.text });
          for (const c of r.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
          // an empty reply is never recorded (it is a stage failure); no harness text is ever put in the assistant's mouth
          if (content.length === 0) break;
          const replay = o.replay && r.providerState !== undefined && r.providerState.provider === o.provider && r.providerState.model === o.model && r.sys === o.systemHash;
          const prev = out[out.length - 1];
          // two assistant turns in a row never reach the wire: the second one's blocks join the first
          if (prev !== undefined && prev.role === 'assistant') prev.content.push(...content);
          else out.push({ role: 'assistant', content, ...(replay && r.providerState !== undefined ? { providerState: r.providerState } : {}) });
          order = r.calls.map((c) => c.id);
          break;
        }
        default:
          break;
      }
    }
    flush();
    // the wire starts with the user
    if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    return out;
  }
}

/** §7.3: the elision marker of a masked tool result. */
export function elided(r: ResultRecord): string {
  return `[elided: ${r.name} ${r.summary} — ${r.content.length} chars; ${r.pointer ?? 'call it again if you need it'}]`;
}

export function messageChars(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') n += b.text.length;
      else if (b.type === 'tool_result') n += b.content.length + b.toolUseId.length;
      else n += JSON.stringify(b.input).length + b.name.length + b.id.length;
    }
  }
  return n;
}

/** Strip every `providerState` (a systemHash / provider / model mismatch on carry, §7.6 step 5). */
export function withoutProviderState(records: readonly TranscriptRecord[]): TranscriptRecord[] {
  return records.map((r) => {
    if (r.kind !== 'assistant' || r.providerState === undefined) return r;
    const { providerState: _dropped, ...rest } = r;
    return rest;
  });
}

/** A JSON value's object form, or {} — the recorded input of a call is always an object on the wire. */
export function asInput(v: Json | null | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}
