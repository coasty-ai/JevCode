/**
 * Frames that draw the wordmark carry `◆ <package version>`. A snapshot that pins that string breaks on every release
 * (prepare-release bumps package.json, then the release gates run the unit suite on the tag — v0.7.0 stopped there).
 * Snapshot tests pass their frame through this, so the pin keeps every byte except the version itself.
 */
import { VERSION } from '../../../src/version.js';

export const VERSION_TOKEN = 'x.y.z';

export function versionFree(frame: string, version: string = VERSION): string {
  return version === '' ? frame : frame.split(version).join(VERSION_TOKEN);
}
