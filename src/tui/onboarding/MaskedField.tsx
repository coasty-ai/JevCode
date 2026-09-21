/**
 * The wizard's masked key field (TUI-DESIGN §11.1, A114–A115, F10, F-N; TUI-DESIGN-2 §4.3): `'•'.repeat(min(len, columns − 3))`
 * (`*` in ASCII) after the prompt — `> ` in the flat tier, `› ` (`glyphs.prompt`) inside the boxed console — the real cursor
 * after the bullets. The key bytes live only in a `useRef` (`useMaskedBytes`): never in React state, the reducer
 * (`{ step, field, length }` only), an item, a log line or a frame. Every keystroke is traced as `key masked len=1` (§10.6)
 * by the caller.
 */
import { useRef } from 'react';
import { Text } from 'ink';
import type { CursorPosition } from 'ink';
import { sanitizeKeyInput, type WizardField } from './reducer.js';
import { MASKED_PROMPT_DEFAULT, maskedFieldCursorX, maskedFieldRow } from './lines.js';

export interface MaskedBytes {
  /** append typed / pasted text (sanitised: whitespace stripped, NFC); returns the new length */
  append(field: WizardField, text: string): number;
  /** drop one code point; returns the new length */
  backspace(field: WizardField): number;
  clear(field: WizardField): void;
  length(field: WizardField): number;
  /** read without forgetting (the prefix check) */
  peek(field: WizardField): string;
  /** read and forget (the save path) */
  take(field: WizardField): string;
  /** forget everything (Ctrl-C, done) */
  wipe(): void;
}

/** §11.1: the one place the bytes exist — a `useRef<Map>`; the reducer only ever sees lengths. */
export function useMaskedBytes(): MaskedBytes {
  const ref = useRef<Map<WizardField, string>>(new Map());
  const api = useRef<MaskedBytes | null>(null);
  api.current ??= {
    append(field, text) {
      const next = (ref.current.get(field) ?? '') + sanitizeKeyInput(text);
      ref.current.set(field, next);
      return [...next].length;
    },
    backspace(field) {
      const cur = [...(ref.current.get(field) ?? '')];
      cur.pop();
      ref.current.set(field, cur.join(''));
      return cur.length;
    },
    clear(field) {
      ref.current.set(field, '');
    },
    length(field) {
      return [...(ref.current.get(field) ?? '')].length;
    },
    peek(field) {
      return ref.current.get(field) ?? '';
    },
    take(field) {
      const v = ref.current.get(field) ?? '';
      ref.current.delete(field);
      return v;
    },
    wipe() {
      ref.current.clear();
    },
  };
  return api.current;
}

export interface MaskedFieldProps {
  length: number;
  columns: number;
  /** the row inside the dynamic region (the App's cursor is placed here) */
  top: number;
  cursor?: (pos: CursorPosition | undefined) => void;
  ascii?: boolean;
  /** `--screen-reader`: the aria label instead of bullets */
  screenReader?: boolean;
  /** TUI-DESIGN-2 §4.3: the prompt glyph (`glyphs.prompt`); default `> ` */
  prompt?: string;
}

/** §11.1: the masked row; places the cursor after the bullets through the App-owned setter. */
export function MaskedField(p: MaskedFieldProps): React.JSX.Element {
  const prompt = p.prompt ?? MASKED_PROMPT_DEFAULT;
  const row = maskedFieldRow(p.length, p.columns, p.ascii ?? false, prompt);
  p.cursor?.({ x: Math.min(Math.max(0, p.columns - 1), maskedFieldCursorX(p.length, p.columns, prompt)), y: p.top });
  return (
    <Text wrap="truncate" {...(p.screenReader ? { 'aria-label': `API key field, ${p.length} characters entered, hidden` } : {})}>
      {row}
    </Text>
  );
}
