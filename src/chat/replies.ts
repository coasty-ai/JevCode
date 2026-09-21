/**
 * Group B — the reply catalogue (TUI-DESIGN-2 §3.4, verbatim): fourteen rows, each a Choice option whose criteria
 * is `{ definition: when, examples }` (REPORT rule 4), a `text` template ≤ 160 chars filled by `fillReply`.
 * Jev picks the row (`pickReply`, argmax; the escape option or a missing answer falls back to `smalltalk_other`);
 * nothing here reads the message. Adding a row changes the Choice's option set and nothing else. No emoji; a
 * `/command` inside a reply is literal.
 */
import { homedir } from 'node:os';
import type { Answer, EngineMode, Json, Question } from '../core/types.js';
import { choice, ref } from '../jev/questions.js';
import type { CriteriaSide } from './intake.js';

export interface ReplySpec {
  readonly key: string;
  /** the Choice option's definition */
  readonly when: string;
  readonly examples: readonly string[];
  /** template ≤ 160 chars; `<dir>` `<last>` `<mode>` `<runsDir>` filled by fillReply */
  readonly text: string;
}

export const REPLY_TEXT_MAX = 160;
export const REPLY_FALLBACK_KEY = 'smalltalk_other';

/** the 14 rows of §3.4, in this order */
export const REPLIES: readonly ReplySpec[] = [
  { key: 'hello_first', when: 'a first greeting in this session, no question attached', examples: ['hi', 'hello', 'hey there'], text: "Hi. I'm ready when you are — describe a change you want in <dir>, or ask what I can do." },
  { key: 'hello_again', when: 'a greeting after earlier turns in `conversation`', examples: ['hi again', 'hello?'], text: "Hi again. Same session, same workspace — what's next?" },
  { key: 'how_are_you', when: 'asks how the agent is doing', examples: ['how are you?', "how's it going"], text: 'Doing well: idle, keys loaded, nothing running. What can I look at?' },
  { key: 'good_morning', when: 'a morning greeting', examples: ['good morning', 'morning!'], text: 'Good morning. Fresh session on <dir> — tell me what to work on.' },
  { key: 'good_evening', when: 'an afternoon, evening or night greeting', examples: ['good evening', 'late night here'], text: "Good evening. I'm here whenever you're ready." },
  { key: 'thanks', when: 'thanks or appreciation for something done', examples: ['thanks', 'thank you, that worked'], text: "You're welcome. Anything else on <dir>?" },
  { key: 'bye', when: 'a goodbye or sign-off', examples: ['bye', 'see you', "that's all for today"], text: 'Bye for now. /exit closes the session; runs are saved under <runsDir>.' },
  { key: 'praise', when: 'praise for the agent or the result', examples: ['nice work', 'perfect'], text: 'Thanks — Jev did the deciding. Want to take on the next one?' },
  { key: 'apology', when: 'the human apologises or says they made a mistake', examples: ['sorry, wrong window', 'my bad'], text: 'No harm done — nothing was run, so we can just carry on.' },
  { key: 'checking_alive', when: 'asks whether the agent is present or working', examples: ['you there?', 'still alive?', 'hello??'], text: "Yes, I'm here: idle and listening. Type a task or a question." },
  { key: 'ok_ack', when: 'a bare acknowledgement', examples: ['ok', 'okay', 'got it', 'cool'], text: "Okay. Whenever you're ready." },
  { key: 'whats_up', when: 'asks what is happening or what is new', examples: ["what's up?", 'anything new?'], text: "Not much: the composer's open, the workspace is <dir>, <last>." },
  { key: 'laughing', when: 'laughter or a joke', examples: ['lol', 'haha', 'ha'], text: 'Glad that landed. What shall we do next?' },
  { key: REPLY_FALLBACK_KEY, when: 'small talk none of the others fit (the fallback)', examples: ['nice weather', 'how was your weekend'], text: "Happy to chat, though I'm best at code. Ask me anything about <dir>, or hand me a task." },
];

const REPLY_INSTRUCTIONS = `Which reply in the catalogue answers ${ref('message')} best, read with ${ref('conversation')} and ${ref('session')}?`;

/** the group-B Choice: one option per catalogue row, criteria `{ definition: when, examples }` */
export function buildReplyQuestion(): Question {
  const options: Record<string, Json | null> = Object.fromEntries(REPLIES.map((r) => [r.key, { definition: r.when, examples: [...r.examples] }]));
  return choice(REPLY_INSTRUCTIONS, options);
}

/** the criteria side of a row (for tests and the panel's `/why intake.reply`) */
export function replyCriteria(r: ReplySpec): CriteriaSide {
  return { definition: r.when, examples: r.examples };
}

/** argmax over the catalogue keys; `none_of_these` / a missing answer → the fallback at p 0 */
export function pickReply(answers: Record<string, Answer>): { key: string; probability: number } {
  const a = answers['reply'];
  if (!a || a.type !== 'choice') return { key: REPLY_FALLBACK_KEY, probability: 0 };
  let key: string | null = null;
  let best = -1;
  for (const r of REPLIES) {
    const p = a.probabilities[r.key];
    const v = typeof p === 'number' && Number.isFinite(p) ? p : 0;
    if (v > best + 1e-12) {
      best = v;
      key = r.key;
    }
  }
  if (key === null || best <= 0) return { key: REPLY_FALLBACK_KEY, probability: 0 };
  return { key, probability: best };
}

export function replyByKey(key: string): ReplySpec {
  return REPLIES.find((r) => r.key === key) ?? REPLIES.find((r) => r.key === REPLY_FALLBACK_KEY)!;
}

export interface ReplyFacts {
  /** `basename(workspaceRoot)` */
  dir: string;
  /** `the last run ended <stopReason> after <steps> steps` / `the last run is paused after step <n> (/resume continues)`; null → `nothing has run yet` */
  lastRun: string | null;
  mode: EngineMode;
  /** `<runsDir>` verbatim; `~`-abbreviated by fillReply (`JEVCODE_HOME` / `--runs-dir` relocate it, so it is never hardcoded) */
  runsDir: string;
  /** injected for tests; default `os.homedir()` */
  home?: string;
}

/** `/Users/me/.jevcode/runs` → `~/.jevcode/runs` */
export function tildify(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** the `<mode>` word of a reply: `jev-only` / `jev+llm` / `llm-only` (§1.5 badge words) */
export function modeWord(mode: EngineMode): 'jev-only' | 'jev+llm' | 'llm-only' | 'llm-jev' {
  return mode === 'jev-only' ? 'jev-only' : mode === 'jev-on' ? 'jev+llm' : mode === 'llm-jev' ? 'llm-jev' : 'llm-only';
}

export function fillReply(spec: ReplySpec, facts: ReplyFacts): string {
  return spec.text
    .replaceAll('<dir>', facts.dir)
    .replaceAll('<last>', facts.lastRun ?? 'nothing has run yet')
    .replaceAll('<mode>', modeWord(facts.mode))
    .replaceAll('<runsDir>', tildify(facts.runsDir, facts.home));
}
