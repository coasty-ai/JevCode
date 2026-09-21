/**
 * Kill ring (TUI-DESIGN §4.1, §4.7): ≤ 16 entries, newest first, in memory for the process lifetime — it survives
 * submit and run boundaries because the buffer object that holds it does (`TextBuffer.killRing`). Pure helpers over
 * readonly arrays; `reduceBuffer` is the only caller.
 */

/** Maximum ring entries (TUI-DESIGN §4.7: "Kill ring 16 entries"). */
export const KILL_RING_MAX = 16;

/** How a kill joins the ring (TUI-DESIGN §4.1 `lastKill`): `unshift` starts a new entry; `append`/`prepend` extend the newest one (consecutive kills, readline). */
export type KillJoin = 'unshift' | 'append' | 'prepend';

/** Add `text` to the ring per `how`, dropping the oldest entry beyond 16 (TUI-DESIGN §4.1, §4.7). Empty kills leave the ring untouched. */
export function pushKill(ring: readonly string[], text: string, how: KillJoin): readonly string[] {
  if (text.length === 0) return ring;
  const head = ring[0];
  if (how !== 'unshift' && head !== undefined) {
    const joined = how === 'append' ? head + text : text + head;
    return [joined, ...ring.slice(1)];
  }
  return [text, ...ring].slice(0, KILL_RING_MAX);
}

/** Index of the next older entry for Alt+Y rotation, wrapping to the newest (TUI-DESIGN §4.7); null on an empty ring. */
export function nextYankIndex(ring: readonly string[], current: number): number | null {
  if (ring.length === 0) return null;
  if (!Number.isInteger(current) || current < 0) return 0;
  return (current + 1) % ring.length;
}
