/**
 * `todo_write` and the plan (docs/AGENT-LOOP-DESIGN.md §4.7). The todo list is the run's plan: completed items become
 * `PlanDraft.done`, pending and in-progress items `remaining`. Every proposal the driver returns carries it, so the
 * engine's commit keeps `/plan`, `/rewind` and the TUI plan counts working. A pending item never blocks completion.
 */
import type { Json, PlanDraft } from '../../core/types.js';
import { AGENT_TODO_ITEM_CHARS, AGENT_TODO_MAX_ITEMS } from '../limits.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface Todo {
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

function isTodo(v: Json): v is { content: string; status: TodoStatus } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v['content'] === 'string' && typeof v['status'] === 'string' && (STATUSES as readonly string[]).includes(v['status']);
}

/** The todos of a validated `todo_write` call, or the error text (the schema already bounded count and length). */
export function todoWrite(todos: Json): { ok: true; todos: Todo[]; text: string; summary: string } | { ok: false; text: string; summary: string } {
  const summary = 'todo_write (invalid)';
  if (!Array.isArray(todos) || !todos.every(isTodo)) return { ok: false, text: 'INVALID ARGUMENTS for todo_write: todos must be a list of {content, status}', summary };
  const list = todos.slice(0, AGENT_TODO_MAX_ITEMS).map((t): Todo => ({ content: t.content.slice(0, AGENT_TODO_ITEM_CHARS), status: t.status }));
  const count = (s: TodoStatus): number => list.filter((t) => t.status === s).length;
  if (count('in_progress') > 1) return { ok: false, text: 'INVALID ARGUMENTS for todo_write: more than one item is in_progress', summary };
  const c = count('completed');
  return {
    ok: true,
    todos: list,
    text: `OK: todo list updated (${c} completed, ${count('in_progress')} in progress, ${count('pending')} pending)`,
    summary: `todo_write (${c}/${list.length} done)`,
  };
}

/** §4.7: the todo list as the engine's `PlanDraft`. */
export function planOf(todos: readonly Todo[]): PlanDraft {
  return {
    done: todos.filter((t) => t.status === 'completed').map((t) => t.content),
    remaining: todos.filter((t) => t.status !== 'completed').map((t) => t.content),
    openProblems: [],
  };
}
