/**
 * TUI-DESIGN-4 §1.3.1 / §10 S1: the renderer selection and its refusal matrix, plus the launch-layer precedence
 * `--fullscreen > --renderer > JEVCODE_RENDERER > (the file row) > classic` and the conflicting-flags usage error.
 *
 * `src/config/launch.ts` and `src/cli/args.ts` are S1's files; `test/unit/config/**` is S3's, so the launch rows
 * live here, beside the selection they feed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../../../src/cli/args.js';
import { rendererFromConfigFile } from '../../../../src/cli/main.js';
import { UsageError } from '../../../../src/errors.js';
import { resolveLaunchSettingsWithSources } from '../../../../src/config/launch.js';
import { selectRenderer } from '../../../../src/tui/fullscreen/select.js';

const ok = { wanted: 'fullscreen' as const, rows: 24, columns: 80, screenReader: false, term: 'xterm-256color', isTTY: true };

describe('selectRenderer (§1.3.1)', () => {
  it('classic is the default and is never refused', () => {
    expect(selectRenderer({ ...ok, wanted: 'classic' })).toEqual({ renderer: 'classic', refusal: null });
    expect(selectRenderer({ ...ok, wanted: undefined, rows: 2, columns: 2, isTTY: false })).toEqual({ renderer: 'classic', refusal: null });
  });

  it('fullscreen is entered when every row of the matrix passes', () => {
    expect(selectRenderer(ok)).toEqual({ renderer: 'fullscreen', refusal: null });
    expect(selectRenderer({ ...ok, rows: 18, columns: 40 })).toEqual({ renderer: 'fullscreen', refusal: null });
  });

  it('the four spoken refusals, in the table order, each falling back to classic', () => {
    expect(selectRenderer({ ...ok, rows: 17 })).toEqual({ renderer: 'classic', refusal: 'fullscreen needs 18 rows (now 17) — the classic renderer is used' });
    expect(selectRenderer({ ...ok, columns: 39 })).toEqual({ renderer: 'classic', refusal: 'fullscreen needs 40 columns (now 39) — the classic renderer is used' });
    expect(selectRenderer({ ...ok, screenReader: true })).toEqual({ renderer: 'classic', refusal: 'fullscreen repaints the whole screen on every key; the classic renderer is used under a screen reader' });
    expect(selectRenderer({ ...ok, term: 'dumb' })).toEqual({ renderer: 'classic', refusal: 'fullscreen needs a terminal that supports the alternate screen (TERM=dumb) — the classic renderer is used' });
    expect(selectRenderer({ ...ok, term: undefined })).toEqual({ renderer: 'classic', refusal: 'fullscreen needs a terminal that supports the alternate screen (TERM=unset) — the classic renderer is used' });
    // rows are checked before columns, and geometry before the screen reader
    expect(selectRenderer({ ...ok, rows: 10, columns: 10, screenReader: true, term: 'dumb' }).refusal).toContain('18 rows');
  });

  it('the SILENT rows: a non-TTY and a pinned non-interactive mount fall back with no note at all', () => {
    expect(selectRenderer({ ...ok, isTTY: false })).toEqual({ renderer: 'classic', refusal: null });
    expect(selectRenderer({ ...ok, interactive: false })).toEqual({ renderer: 'classic', refusal: null });
    expect(selectRenderer({ ...ok, interactive: true })).toEqual({ renderer: 'fullscreen', refusal: null });
  });
});

describe('the launch layer (§1.3.1 precedence, §8 item 6)', () => {
  const resolve = (flags: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) => resolveLaunchSettingsWithSources(flags, env);

  it('`--fullscreen` > `--renderer` > `JEVCODE_RENDERER` > (the file row) > classic', () => {
    expect(resolve({}).settings.renderer).toBeUndefined(); // ABSENT, so `resolveUiConfig`'s file layer is not shadowed
    expect(resolve({}).sources.renderer).toBe('default');
    expect(resolve({}, { JEVCODE_RENDERER: 'fullscreen' }).settings.renderer).toBe('fullscreen');
    expect(resolve({}, { JEVCODE_RENDERER: 'fullscreen' }).sources.renderer).toBe('env');
    expect(resolve({ renderer: 'classic' }, { JEVCODE_RENDERER: 'fullscreen' }).settings.renderer).toBe('classic');
    expect(resolve({ renderer: 'classic' }, { JEVCODE_RENDERER: 'fullscreen' }).sources.renderer).toBe('flag');
    expect(resolve({ fullscreen: true }, { JEVCODE_RENDERER: 'classic' }).settings.renderer).toBe('fullscreen');
    expect(resolve({ fullscreen: true }).sources.renderer).toBe('flag');
    // an unparseable env value is ignored, not an error (the flag layer validates; the env layer never throws)
    expect(resolve({}, { JEVCODE_RENDERER: 'nonsense' }).settings.renderer).toBeUndefined();
  });

  /**
   * §1.3.1 / §8 item 6: `wanted = launch.renderer ?? ui.renderer ?? 'classic'`. The FILE layer cannot come through
   * `resolveUiConfig` (it runs after `render()`, and Ink fixes `alternateScreen` in its constructor), so
   * `rendererFromConfigFile` reads that one key synchronously before the mount — otherwise `/fullscreen`, which
   * persists exactly that row and promises "set for the next launch", promised something the relaunch never gave.
   */
  it('the config file is the last layer of `wanted`, and a broken file is classic, never a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-renderer-'));
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    const home = join(dir, 'home');
    const cwd = mkdtempSync(join(tmpdir(), 'jevcode-cwd-'));
    const io2 = { env, home, cwd };
    try {
      // no file anywhere: undefined, so the launch layer's `?? 'classic'` decides
      expect(rendererFromConfigFile(io2)).toBeUndefined();
      // the XDG file, the `fileKey` of `ui.renderer` at the top level (the file format is flat)
      const xdg = join(dir, 'jevcode');
      mkdirSync(xdg, { recursive: true });
      writeFileSync(join(xdg, 'config.json'), JSON.stringify({ renderer: 'fullscreen' }));
      expect(rendererFromConfigFile(io2)).toBe('fullscreen');
      writeFileSync(join(xdg, 'config.json'), JSON.stringify({ renderer: 'classic' }));
      expect(rendererFromConfigFile(io2)).toBe('classic');
      // ./jevcode.json wins over the XDG file, exactly as `resolveConfig` walks the candidates
      writeFileSync(join(xdg, 'config.json'), JSON.stringify({ renderer: 'classic' }));
      writeFileSync(join(cwd, 'jevcode.json'), JSON.stringify({ renderer: 'fullscreen' }));
      expect(rendererFromConfigFile(io2)).toBe('fullscreen');
      // --config and JEVCODE_CONFIG replace the candidate list
      const explicit = join(dir, 'explicit.json');
      writeFileSync(explicit, JSON.stringify({ renderer: 'classic' }));
      expect(rendererFromConfigFile({ ...io2, configFlag: explicit })).toBe('classic');
      expect(rendererFromConfigFile({ ...io2, env: { ...env, JEVCODE_CONFIG: explicit } })).toBe('classic');
      // a broken file, a wrong type and an unknown value are all `undefined`: never an exception at launch
      writeFileSync(join(cwd, 'jevcode.json'), '{not json');
      expect(rendererFromConfigFile(io2)).toBeUndefined();
      writeFileSync(join(cwd, 'jevcode.json'), JSON.stringify({ renderer: 7 }));
      expect(rendererFromConfigFile(io2)).toBeUndefined();
      writeFileSync(join(cwd, 'jevcode.json'), JSON.stringify({ renderer: 'nonsense' }));
      expect(rendererFromConfigFile(io2)).toBeUndefined();
      writeFileSync(join(cwd, 'jevcode.json'), JSON.stringify([1, 2]));
      expect(rendererFromConfigFile(io2)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('`--fullscreen --renderer classic` is a USAGE ERROR, not a silent override', () => {
    expect(() => parseCliArgs(['chat', '--fullscreen', '--renderer', 'classic'])).toThrow(UsageError);
    expect(() => parseCliArgs(['chat', '--fullscreen', '--renderer', 'classic'])).toThrow(/--fullscreen and --renderer classic disagree/);
    // the two AGREEING forms are fine, and either alone is fine
    expect(parseCliArgs(['chat', '--fullscreen', '--renderer', 'fullscreen']).renderer).toBe('fullscreen');
    expect(parseCliArgs(['chat', '--fullscreen']).fullscreen).toBe(true);
    expect(parseCliArgs(['chat', '--renderer', 'classic']).renderer).toBe('classic');
    // and an unknown value is still the `oneOf` error
    expect(() => parseCliArgs(['chat', '--renderer', 'nope'])).toThrow(/expected one of/);
  });
});
