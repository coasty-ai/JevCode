/**
 * The jevcode version string (TUI-DESIGN §15 item 19, §17). The bundle build defines
 * `__JEVCODE_VERSION__` from package.json (esbuild `define`); under tsx and vitest the
 * global is absent and the version is read from the package.json next to the source or
 * bundle root, falling back to '0.0.0' so this module never throws at import time.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __JEVCODE_VERSION__: string | undefined;

/** the npm package name: scoped, because npm refused the unscoped `jevcode`. The command it installs stays `jevcode`. */
export const NPM_PACKAGE_NAME = '@coasty-ai/jevcode';

/** a package.json `name` that is this package: the scoped name, or `jevcode` from a checkout that predates the scope */
export function isJevcodePackageName(name: unknown): boolean {
  return name === NPM_PACKAGE_NAME || name === 'jevcode';
}

function readPackageVersion(): string {
  // src/version.ts -> <root>/package.json; dist/jevcode.mjs -> <root>/package.json: one level up in both layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

export const VERSION: string = typeof __JEVCODE_VERSION__ === 'string' ? __JEVCODE_VERSION__ : readPackageVersion();
