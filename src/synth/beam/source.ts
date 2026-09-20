/**
 * The `token_beam` candidate source. `enumerate()` is pure and synchronous: permutation
 * candidates for the current line plus whatever `synthesizeLine()` already built for the
 * site. `synthesizeLine()` is the Jev-driven path the search controller calls when cheaper
 * sources are exhausted: templates → slots first (cheapest when covered), then the
 * grammar-guided token beam, under one request budget and one abort signal.
 */
import { sha12 } from '../../core/hash.js';
import type { BeamOptions, BeamResult, Candidate, CandidateSource, EnumerateOptions, FailureView, Site } from '../types.js';
import type { JevAsk } from '../types.js';
import { checkAborted, runTokenBeam } from './beam.js';
import type { TokenBeamOutcome } from './beam.js';
import { permutationCandidates } from './permute.js';
import { runTemplateRoute } from './templates.js';
import type { TemplateOutcome } from './templates.js';
import { buildVocabulary } from './vocab.js';

export type BeamRoute = 'template' | 'beam';
export const DEFAULT_ROUTES: readonly BeamRoute[] = ['template', 'beam'];
/** Measured: templates ≈ 8 requests, beam W=3+grammar ≈ 31; the budget covers both with slack. */
export const DEFAULT_MAX_REQUESTS = 48;

export interface BeamSourceOptions extends BeamOptions {
  /** Requests one `synthesizeLine` call may spend across routes (default 48). */
  maxRequests?: number;
  /** Routes in order (default templates then beam); the controller may pick one. */
  routes?: readonly BeamRoute[];
}

export interface BeamContext {
  task: string;
  failures: readonly FailureView[];
  signal: AbortSignal;
  /** Vocabulary and donor inputs (test literals, task identifiers, corpus). */
  enumerate: EnumerateOptions;
  /** Per-call overrides of the source defaults. */
  maxRequests?: number;
  routes?: readonly BeamRoute[];
}

export interface LineSynthesis extends BeamResult {
  /** Distinct lines per route, for the transcript and the controller's routing. */
  byRoute: { template?: TemplateOutcome; beam?: TokenBeamOutcome };
}

export interface TokenBeamSource extends CandidateSource {
  readonly name: 'token_beam';
  synthesizeLine(site: Site, ctx: BeamContext): Promise<LineSynthesis>;
  /** The last synthesis for a site, if any (what `enumerate` will surface). */
  cached(site: Site): LineSynthesis | undefined;
  clearCache(): void;
}

/**
 * Identity of a site for the cache: same file content, line, kind and current text. The source
 * hash is part of the key so a synthesis made against an earlier version of the file (before
 * another candidate was applied) is not surfaced as if it were current.
 */
export function siteKey(site: Site): string {
  return `${site.file.path}:${sha12(site.file.src)}:${site.line}:${site.kind}:${site.currentLine}`;
}

function lineCandidate(site: Site, text: string, op: string, prior: number): Candidate {
  return { id: `token_beam:${op}:${sha12(`${site.file.path}:${site.line}:${text}`)}`, site, text, source: 'token_beam', op, prior };
}

export function createTokenBeamSource(ask: JevAsk, opts: BeamSourceOptions): TokenBeamSource {
  const cache = new Map<string, LineSynthesis>();
  const width = Math.max(1, Math.floor(opts.width));
  const maxTokens = Math.max(1, Math.floor(opts.maxTokens));

  return {
    name: 'token_beam',

    enumerate(site: Site, eopts: EnumerateOptions): Candidate[] {
      const out: Candidate[] = [];
      const seen = new Set<string>();
      const hit = cache.get(siteKey(site));
      if (hit !== undefined) {
        // lines are grouped by route (templates first), not sorted, so the reference is the maximum
        const best = Math.max(...hit.lines.map((l) => l.logProb));
        for (const l of hit.lines) {
          if (seen.has(l.text)) continue;
          seen.add(l.text);
          // prior relative to the best line of the synthesis (≤ 1); only orders enumeration
          out.push(lineCandidate(site, l.text, 'synthesized_line', Math.exp(l.logProb - best)));
        }
      }
      for (const c of permutationCandidates(site, eopts.cap)) {
        if (seen.has(c.text)) continue;
        seen.add(c.text);
        out.push(c);
      }
      return out.slice(0, Math.max(0, eopts.cap));
    },

    async synthesizeLine(site: Site, ctx: BeamContext): Promise<LineSynthesis> {
      checkAborted(ctx.signal);
      const budget = ctx.maxRequests ?? opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
      const routes = ctx.routes ?? opts.routes ?? DEFAULT_ROUTES;
      const vocab = buildVocabulary(site, ctx.enumerate);
      const task = { task: ctx.task, failures: ctx.failures };
      const result: LineSynthesis = { lines: [], requests: 0, byRoute: {} };
      const seen = new Set<string>();
      const add = (lines: readonly { text: string; logProb: number }[]): void => {
        for (const l of lines) {
          if (seen.has(l.text)) continue;
          seen.add(l.text);
          result.lines.push(l);
        }
      };
      for (const route of routes) {
        const remaining = budget - result.requests;
        if (remaining <= 0) break;
        const run = { width, maxTokens, confidentExpandThreshold: opts.confidentExpandThreshold, maxRequests: remaining, signal: ctx.signal };
        if (route === 'template') {
          const t = await runTemplateRoute(ask, site, vocab, task, ctx.enumerate, run);
          result.byRoute.template = t;
          result.requests += t.requests;
          add(t.lines);
        } else {
          const b = await runTokenBeam(ask, site, vocab, task, run);
          result.byRoute.beam = b;
          result.requests += b.requests;
          add(b.lines);
        }
      }
      cache.set(siteKey(site), result);
      return result;
    },

    cached(site: Site): LineSynthesis | undefined {
      return cache.get(siteKey(site));
    },

    clearCache(): void {
      cache.clear();
    },
  };
}
