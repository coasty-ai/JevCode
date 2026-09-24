/**
 * Option keys for the localizer's Choices. REPORT §10: option names are read by the model, and
 * keys such as `a`, `alpha` or `1` carry a prior, so every key is a descriptive snake_case word
 * derived from the thing it names, made unique within its Choice. `choice()` in
 * src/jev/questions.ts rejects anything that slips through.
 */

const NAME_PRIOR = /^([a-z]|alpha|beta|gamma|option_?[a-z0-9]+|\d+)$/i;
const KEY_MAX = 60;

/** Snake_case key from a dotted qualified name (`Point.distance` → `point_distance`), unique in `used`. */
export function functionKey(qualname: string, used: Set<string>): string {
  let k = qualname
    .toLowerCase()
    .replace(/\./g, '__')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k) || k.length < 2 || NAME_PRIOR.test(k)) k = `fn_${k}`;
  return unique(k.slice(0, KEY_MAX), used);
}

/** Snake_case key from a file path (`django/forms/models.py` → `django_forms_models_py`). */
export function pathKey(path: string, used: Set<string>): string {
  let k = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k) || k.length < 2 || NAME_PRIOR.test(k)) k = `file_${k}`;
  return unique(k.slice(0, KEY_MAX), used);
}

/** `line_<n>` (the measured QuixBugs/SWE-bench option shape). */
export function lineKey(line: number): string {
  return `line_${line}`;
}

/** Inverse of lineKey; null for the escape option or anything else. */
export function lineOfKey(key: string): number | null {
  const m = /^line_(\d+)$/.exec(key);
  return m === null ? null : Number(m[1]);
}

function unique(base: string, used: Set<string>): string {
  let k = base;
  let i = 2;
  while (used.has(k)) k = `${base.slice(0, KEY_MAX - 4)}_${i++}`;
  used.add(k);
  return k;
}
