/**
 * The directories no listing enters, zero-import so the git listing (git.ts) can share the rule without pulling
 * the candidate cache's `node:fs` imports into the TUI item formatter's first-frame graph (test/unit/tui/plain.test.ts
 * §14.2 item 13 keeps that graph's fs importers on a declared allowlist).
 *
 * The names are the dependency, build-output and cache directories of the common toolchains — JavaScript
 * (`node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.angular`, `.expo`, `bower_components`,
 * `coverage`), Python (`.venv`, `venv`, `__pycache__`, `.tox`, `.nox`, `.eggs`, `*.egg-info`, the `.mypy_cache` /
 * `.pytest_cache` / `.ruff_cache` caches), Rust and Java (`target`, `.gradle`), Dart (`.dart_tool`), Terraform
 * (`.terraform`), Haskell (`.stack-work`), Elm (`elm-stuff`), Xcode (`DerivedData`), direnv (`.direnv`) and the
 * generic `dist`, `build` and `.cache`. Tracked files under any of them are never dropped (see `underSkippedDir`).
 */
export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '__pycache__',
  'target',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.angular',
  '.expo',
  '.cache',
  'coverage',
  '.gradle',
  '.dart_tool',
  '.terraform',
  '.stack-work',
  'elm-stuff',
  'bower_components',
  '.eggs',
  '.ruff_cache',
  '.nox',
  '.direnv',
  'DerivedData',
]);

/** A directory name no listing enters: a `WALK_SKIP_DIRS` name, or setuptools' `<pkg>.egg-info` metadata directory. */
export function isSkippedDirName(name: string): boolean {
  return WALK_SKIP_DIRS.has(name) || (name.endsWith('.egg-info') && name.length > '.egg-info'.length);
}

/**
 * True when a directory segment of the workspace-relative path is a skipped directory name (`isSkippedDirName`; the
 * file's own name never counts). The readdir walk never enters those directories; the git listing applies the same
 * rule to its UNTRACKED entries (git.ts `lsFiles`) and so does the per-command status refresh (files.ts), so a
 * virtualenv or `node_modules` the workspace forgot to gitignore does not become thousands of candidates — which is
 * what made a three-file demo read as a repository-class checkout (`isRepositoryWorkspace` counts `.py` candidates)
 * and had the localiser name `site-packages/pip/.../wheel.py` as a module file. Tracked files are never dropped: a
 * checkout that commits `dist/` or `build/` means it.
 */
export function underSkippedDir(relPath: string): boolean {
  const segs = relPath.split('/');
  for (let i = 0; i < segs.length - 1; i++) if (isSkippedDirName(segs[i]!)) return true;
  return false;
}
