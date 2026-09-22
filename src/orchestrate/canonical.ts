/**
 * The canonical forms two modules must agree on (docs/ORCHESTRATION-DESIGN.md §2.2, §3.7).
 *
 * `manifestId` is computed by the NORMALISER (§2.2's fixed order: rule 1 renames the slug → rules 2–9
 * run → `manifestId` → `branch`), and it is re-checked by `manifest.ts` when a written manifest is read
 * back and on adoption (row 12: "a resumed delegation whose `manifestId` and `baseSha` still match is
 * adopted, never re-spawned"). A second implementation of the canonical form would make adoption
 * silently re-spawn, so there is one, here, and both import it.
 *
 * Deviation from §8.1's file list: the design gives `manifest.ts` "canonical form, checksum" and §3.4
 * gives `normalize.ts` the `manifestId`. Those are the same bytes, so they live in one module rather
 * than twice.
 *
 * Pure: `core/hash.ts` only.
 */
import { sha256Hex, stableStringify } from '../core/hash.js';
import type { Json } from '../core/types.js';
import type { AgentSpec, Manifest, SplitKind } from './types.js';

/** §2.2: exactly the fields `manifestId` is `sha256(canonical(...))` of. */
export interface ManifestIdInput {
  task: string;
  remaining: readonly string[];
  splitKind: SplitKind;
  agents: readonly AgentSpec[];
  baseSha: string;
}

/**
 * The agent fields that make two manifests the same delegation. Caps and mode are included: a
 * delegation whose money split changed is not the one on disk, so it must not be adopted.
 */
function canonicalAgent(a: AgentSpec): Json {
  return {
    slug: a.slug,
    task: a.task,
    own: [...a.own],
    role: a.role,
    verify: [...a.verify],
    dependsOn: [...a.dependsOn].sort(),
    capUsd: a.capUsd,
    maxSteps: a.maxSteps,
    maxWallMs: a.maxWallMs,
    mode: a.mode,
  };
}

export function canonicalManifestInput(input: ManifestIdInput): Json {
  return {
    task: input.task,
    remaining: [...input.remaining],
    splitKind: input.splitKind,
    agents: input.agents.map(canonicalAgent),
    baseSha: input.baseSha,
  };
}

/** §2.2: `sha256(canonical({ task, remaining, splitKind, agents, baseSha }))`, hex, full length. */
export function manifestIdOf(input: ManifestIdInput): string {
  return sha256Hex(stableStringify(canonicalManifestInput(input)));
}

/**
 * §3.7: the manifest's own checksum, over every field except `checksum` itself. A manifest read back
 * with a different checksum is refused by `readManifest` (it was edited, truncated or is from another
 * build), which is why the field is excluded rather than zeroed.
 */
export function checksumOf(manifest: Omit<Manifest, 'checksum'>): string {
  const record: Record<string, unknown> = { ...manifest };
  delete record['checksum'];
  const json = JSON.parse(JSON.stringify(record)) as Json;
  return sha256Hex(stableStringify(json));
}
