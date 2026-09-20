# 08 — Node.js and TypeScript toolchain for a strict ESM CLI (JevCode)

Research date: **2026-09-19**. All versions/dates below were fetched live from primary sources on that date; the URL follows each claim. Local machine: `node v22.23.2`, `npm 10.9.8`, `git 2.50.1 (Apple Git-155)`, `/usr/bin/patch` = `patch 2.0-12u11-Apple` (all from running the binaries locally on 2026-09-19).

Local verification runs done in `/tmp` on 2026-09-19 are marked **[local test]**.

---

## 1. Node.js release status (2026-09-19)

Source: `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json` (fetched 2026-09-19) and `https://nodejs.org/dist/index.json` (fetched 2026-09-19).

| Major | Codename | Start | LTS start | Maintenance start | End-of-life | Status on 2026-09-19 | Latest release (index.json) |
|---|---|---|---|---|---|---|---|
| v20 | Iron | 2023-04-18 | 2023-10-24 | 2024-10-22 | **2026-04-30** | **EOL** | v20.20.2 (2026-03-24) |
| v22 | Jod | 2024-04-24 | 2024-10-29 | **2025-10-21** | **2027-04-30** | **Maintenance LTS** | **v22.23.2 (2026-07-28), npm 10.9.8** |
| v24 | Krypton | 2025-05-06 | 2025-10-28 | 2026-10-20 | 2028-04-30 | **Active LTS** (goes Maintenance 2026-10-20) | v24.21.0 (2026-09-07), npm 11.19.0 |
| v25 | — | 2025-10-15 | — | 2026-04-01 | 2026-06-01 | EOL | v25.9.0 (2026-03-31) |
| v26 | (codename empty in JSON) | 2026-05-05 | **2026-10-28** | 2027-10-20 | 2029-04-30 | **Current** (becomes Active LTS 2026-10-28) | v26.9.0 (2026-09-16), npm 11.19.1 |
| v27 | — | alpha 2026-10-28, start 2027-04-22 | — | 2027-10-20 | 2030-04-30 | not released | — |

Note: `https://nodejs.org/en/about/previous-releases` (fetched 2026-09-19) says "LTS release status is 'long-term support', which typically guarantees that critical bugs will be fixed for a total of 30 months" and "Historically (up to Node.js 26), odd-numbered releases … become unsupported after six months, and even-numbered releases … move to Active LTS". The HTML table's date columns rendered ambiguously via fetch; the JSON schedule above is authoritative.

### Assessment: pin 22.x vs 24.x

- The installed `v22.23.2` **is the newest 22.x** (index.json, 2026-09-19). Node 22 is already in **Maintenance** (since 2025-10-21) with **~19 months of life left** (EOL 2027-04-30). Node 24 is Active LTS for one more month, then Maintenance until 2028-04-30.
- Every dependency we need supports 22: ink `engines.node >=22`; vitest `^22.12.0 || ^24.0.0 || >=26.0.0`; vite `^20.19.0 || >=22.12.0`; tsx `>=18`; esbuild `>=18`; typescript `>=16.20.0` (all from `https://registry.npmjs.org/<pkg>/latest`, fetched 2026-09-19).
- **Recommendation:** develop on 22.23.2 (matches the machine and SWE-bench/Terminal-Bench harness images are conservative), but declare `"engines": { "node": ">=22.18.0" }` (22.18 is where type stripping became default — see below) and add `.nvmrc` = `22.23.2`. Do **not** cap at `<24`; CI should also run on 24.x so we can flip `.nvmrc` to 24 before 22 EOL. Per nvm README, `.nvmrc` holds "a node version number … in the project root directory" and `nvm use`/`nvm install` honour it (`https://raw.githubusercontent.com/nvm-sh/nvm/master/README.md`, section ".nvmrc", fetched 2026-09-19).

### Node 22 features we can rely on (all from `https://nodejs.org/docs/latest-v22.x/api/*.html`, fetched 2026-09-19)

| Feature | Version / stability in v22 docs | Source page |
|---|---|---|
| Global `fetch()` | "v21.0.0: No longer experimental"; based on undici | globals.html |
| WebStreams (`ReadableStream` etc.) | "v22.15.0: Marking the API stable" — Stability 2 | globals.html |
| `AbortSignal.timeout(delay)` | Added v17.3.0/v16.14.0 | globals.html |
| `AbortSignal.any(signals)` | Added v20.3.0/v18.17.0 | globals.html |
| `node --env-file=file` | Added v20.6.0; "v22.21.0: The --env-file flag is no longer experimental" | cli.html |
| `node --env-file-if-exists=file` | Added v22.9.0; non-experimental since v22.21.0 | cli.html |
| `process.loadEnvFile(path='./.env')` | Added v21.7.0/v20.12.0; "v22.21.0: This API is no longer experimental"; "Usage of NODE_OPTIONS in the .env file will not have any effect" | process.html |
| `util.parseEnv(content)` | Added v21.7.0/v20.12.0; non-experimental since v22.21.0 | util.html |
| `util.styleText(format, text[, {validateStream, stream}])` | "v22.13.0: styleText is now stable"; respects `NO_COLOR`, `NODE_DISABLE_COLORS`, `FORCE_COLOR` (v22.8.0); `'none'` format added v22.17.0 | util.html |
| `module.enableCompileCache([cacheDir])` | Added v22.1.0; Stability 1.1 Active development; returns `{status, message, directory}` | module.html |
| `module.stripTypeScriptTypes(code[, {mode:'strip'|'transform', sourceMap, sourceUrl}])` | Added v22.13.0; Stability 1.2 Release candidate | module.html |
| Type stripping (`node file.ts`) | Added v22.6.0 behind `--experimental-strip-types`; **"v22.18.0: Type stripping is enabled by default"** and "no longer emits an experimental warning"; disable with `--no-experimental-strip-types`; Stability 1.2 | cli.html, typescript.html; release post `https://nodejs.org/en/blog/release/v22.18.0` (2025-07-31) |
| `--experimental-transform-types` | Added v22.7.0; needed for enums/namespaces-with-values/parameter properties/`import =`; implies source maps | cli.html, typescript.html |
| `node:sqlite` | Added v22.5.0; "v22.13.0: SQLite is no longer behind --experimental-sqlite but still experimental"; Stability 1.1 | sqlite.html, cli.html |
| `node:test` / `node --test` | Stability 2 Stable ("v20.0.0: The test runner is now stable"); default globs include `**/*.test.{cts,mts,ts}` etc. when type stripping is on | test.html |
| `child_process.spawn(..., {detached:true})` | "On non-Windows platforms, if options.detached is set to true, the child process will be made the leader of a new process group and session"; `killSignal` default `'SIGTERM'`; `timeout` default `undefined` | child_process.html |
| `process.kill(pid[, signal])` | Node docs only say "Windows platforms will throw an error if the pid is used to kill a process group"; the negative-pid semantics come from kill(2): "If pid is less than -1, then sig is sent to every process in the process group whose ID is -pid" (`https://man7.org/linux/man-pages/man2/kill.2.html`, fetched 2026-09-19) | process.html |
| Atomic file write | `fsPromises.rename(oldPath,newPath)` maps to rename(2): "If newpath already exists, it will be atomically replaced, so that there is no point at which another process attempting to access newpath will find it missing" (`https://man7.org/linux/man-pages/man2/rename.2.html`, fetched 2026-09-19). Pattern: write `file.tmp-<pid>-<rand>` in same directory, `await fh.sync()`, then `rename` | fs.html |

Type-stripping constraints (typescript.html, fetched 2026-09-19), which shape our tsconfig: "`.tsx` files are unsupported"; "file extensions are mandatory in import statements … `import './file.ts'`"; "the `type` keyword is necessary to correctly strip type imports … The tsconfig option `verbatimModuleSyntax` can be used to match this behavior"; "Node.js refuses to handle TypeScript files inside folders under a node_modules path"; tsconfig `paths` unsupported ("The closest feature available is subpath imports … start with #"). Because Ink needs `.tsx`, **we cannot run the TUI source directly with `node src/x.tsx`**; use tsx or a build step (see §3).

**[local test]** `node t.ts` (no flags) printed `ts ok 42` on v22.23.2; `node --help` lists `--no-experimental-strip-types`, `--experimental-transform-types`, `--env-file`, `--env-file-if-exists`.
**[local test]** `spawn('sh',[...],{detached:true})` then `process.kill(-child.pid,'SIGTERM')` killed the whole group (child exited with `SIGTERM`; no orphan `sleep` remained).

---

## 2. TypeScript

Registry (`https://registry.npmjs.org/typescript`, fetched 2026-09-19): dist-tags `latest: 7.0.2` (published 2026-07-08), `next: 7.1.0-dev.20260919.1`, `rc: 7.0.1-rc`, `beta: 6.0.0-beta`. Recent stable line: 5.8.3 (2025-04-05), 5.9.3 (2025-09-30), 6.0.2 (2026-03-23), 6.0.3 (2026-04-16), **7.0.2 (2026-07-08)**. `engines.node >=16.20.0`. The `typescript@7.0.2` package's dependencies are per-platform binaries (`@typescript/typescript-darwin-arm64`, `…-linux-x64`, etc.).

- **TypeScript 7.0 (released July 8th, 2026) is the native Go port and is stable** — "a 10x faster native port of TypeScript!"; `npm install -D typescript` provides "the new `tsc` executable" (`https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/`, fetched 2026-09-19). Limitation: "While TypeScript 7.0 is here, it does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API." and "TypeScript 7 does not yet expose a stable programmatic API" (same post, fetched 2026-09-19). `@typescript/native-preview` (`tsgo`) is now legacy: latest is `7.0.0-dev.20260707.2` (2026-07-07) and its README says the repo "will be permanently archived in September 2026"; status list: type checking "Same errors, locations, and messages as TS 6.0", JSX/declaration emit/JS output finished, "API — not ready" (`https://raw.githubusercontent.com/microsoft/typescript-go/main/README.md`, fetched 2026-09-19). **Use `typescript@7.0.2`, not native-preview.**
- **TypeScript 6.0 (2026-03-23)** was "the last release based on the current JavaScript codebase" and changed defaults: `strict` → `true`, `module` → `esnext`, `target` → `es2025`, `types` → `[]` ("Projects must explicitly specify … `"types": ["node"]`"), `esModuleInterop`/`allowSyntheticDefaultImports` can no longer be `false` (`https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/`, fetched 2026-09-19). Hard errors in 7.0 ("no longer supported", 7.0 post, fetched 2026-09-19): `target: es5`, `downlevelIteration`, `moduleResolution: node/node10` ("with `nodenext` and `bundler` being recommended instead"), `module: amd, umd, systemjs, none`, `baseUrl` ("`paths` can be updated to be relative to the project root instead"), `moduleResolution: classic`; "`alwaysStrict` is assumed to be true and can no longer be set to `false`"; "The `asserts` keyword cannot be used on imports, and must use the `with` keyword instead". Note: `outFile` is **not** in the 7.0 list because it was already removed one release earlier — "The `--outFile` option has been removed from TypeScript 6.0" (6.0 post, fetched 2026-09-19); `asserts` also already errors in 6.0. Registry note: `6.0.0`/`6.0.1` and `7.0.0`/`7.0.1` were never published as stable; `6.0.2` and `7.0.2` are the first stable builds of each line (`https://registry.npmjs.org/typescript` `time` field, fetched 2026-09-19).
- `--module nodenext` "implies the floating `--target esnext`"; `node20` "adds support for require(ESM)"; `node18` is a 5.8 replacement for `node16` (`https://www.typescriptlang.org/tsconfig/module.html`, fetched 2026-09-19).
- `erasableSyntaxOnly` forbids `enum`, namespaces/modules with runtime code, parameter properties, `import =`/`export =`, `<T>x` assertions; docs: "you will want to combine this flag with the `--verbatimModuleSyntax`" (`https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html`, fetched 2026-09-19). Introduced in TS 5.8 — "That's why TypeScript 5.8 introduces the `--erasableSyntaxOnly` flag." (`https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/`, fetched 2026-09-19); still present in the 7.0.2-era tsconfig reference (fetched 2026-09-19).

### Recommended `tsconfig.json` (TS 7.0.2)

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Flag defaults per `https://www.typescriptlang.org/tsconfig/` (fetched 2026-09-19): `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions` all default `false`; `allowImportingTsExtensions` defaults to "`true` if `rewriteRelativeImportExtensions` is enabled; `false` otherwise" (so the explicit `true` above is redundant but harmless; its own page adds that it otherwise requires `--noEmit` or `--emitDeclarationOnly`, which our `tsc --noEmit` typecheck satisfies — `https://www.typescriptlang.org/tsconfig/allowImportingTsExtensions.html`, fetched 2026-09-19); `types` defaults `[]` (TS 6+); `strict` defaults `true` (TS 6+). Rationale: `rewriteRelativeImportExtensions` + `allowImportingTsExtensions` let us write `import './x.ts'` so the same source runs under Node type stripping / tsx and emits `./x.js`. Keep `target` explicit (`es2023`) rather than `nodenext`'s floating `esnext` so emitted syntax is predictable on Node 22 — Node 22 ships V8 12.4 (`v8: 12.4.254.21` for v22.23.2 in `https://nodejs.org/dist/index.json`, fetched 2026-09-19). **[local test]** on v22.23.2: `Promise.withResolvers`, `Object.groupBy`, `Array.prototype.toSorted` are functions and `new RegExp('a','v')` succeeds, so ES2024 syntax/APIs are present and `target: es2024` would also be safe; `es2023` is kept as the conservative floor. Vite ignores `target` in tsconfig anyway (`https://vite.dev/guide/features`, fetched 2026-09-19).

---

## 3. Vitest, tsx, esbuild

| Tool | Latest (npm, 2026-09-19) | Published | `engines.node` | Notes |
|---|---|---|---|---|
| vitest | **5.0.1** | 2026-09-15 | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | peer `vite: ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0` (**not optional**, `peerDependenciesMeta.vite.optional=false`); vite is not in `dependencies` — add it as a devDependency explicitly. Other dist-tags: `V4: 4.1.11`, `V3: 3.2.7` |
| @vitest/coverage-v8 | **5.0.1** | 2026-09-15 | — | peer `vitest: 5.0.1` (exact) |
| vite | **8.3.0** | 2026-09-10 | `^20.19.0 \|\| >=22.12.0` | transpiles TS/TSX with the Oxc transformer; reads `jsx`/`jsxImportSource` from tsconfig (`https://vite.dev/guide/features`, fetched 2026-09-19) |
| tsx | **4.23.13** | 2026-08-30 | `>=18.0.0` | depends on `esbuild ~0.28.0`; "designed to be compatible with all maintained versions of Node.js" (`https://raw.githubusercontent.com/privatenumber/tsx/master/docs/getting-started.md`, fetched 2026-09-19); `npm install -D tsx`, run `npx tsx ./file.ts` |
| esbuild | **0.28.2** | 2026-08-08 | `>=18` | still 0.x |

Sources: `https://registry.npmjs.org/{vitest,@vitest/coverage-v8,vite,tsx,esbuild}` and `https://registry.npmjs.org/vitest/5.0.1` (fetched 2026-09-19).

### Vitest 5 specifics (`https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/guide/migration/index.md`, fetched 2026-09-19)
- "Vitest 5.0 requires Vite >= 6.4.0 and Node.js >= 22.12.0." → v22.23.2 is fine.
- "`clearMocks` now defaults to true". `test.sequential` removed → use `concurrent: false`. Hoisted `vi.mock` calls must be top-level.
- "The `extends` option now defaults to `true`: every project defined as an inline configuration in `test.projects` inherits all options from the root configuration"; set `extends: false` to opt out. Inline projects share one Vite server (`sharedViteServer`, default on).
- Projects guide (`https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/guide/projects.md`, fetched 2026-09-19): "The `workspace` is deprecated since 3.2 and replaced with the `projects` configuration." `projects` type `TestProjectConfiguration[]`, default `[]`; "A config file that declares `projects` doesn't run tests itself"; "All projects must have unique names"; run one with `vitest --project <name>` ("This can be repeated for multiple projects", `https://vitest.dev/guide/cli.html`, fetched 2026-09-19). The `workspace` option and separate workspace file were removed in **Vitest 4.0**: "The `workspace` configuration option was renamed to `projects` in Vitest 3. They are functionally the same, except you cannot specify another file as the source of your workspace" (`https://v4.vitest.dev/guide/migration.html`, fetched 2026-09-19).
- Coverage (`https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/guide/coverage.md`, fetched 2026-09-19): "Both `v8` and `istanbul` support are optional. By default, `v8` will be used." Install `npm i -D @vitest/coverage-v8`. "Since `v3.2.0` Vitest has used AST based coverage remapping for V8 coverage, which produces identical coverage reports to Istanbul."
- Gating: `test.skipIf(cond)` / `test.runIf(cond)` ("Opposite of test.skipIf", `https://vitest.dev/api/`, fetched 2026-09-19); default `testTimeout` 5_000 ms.

### `vitest.config.ts` for JevCode (unit offline + live gated)

```ts
import { defineConfig } from 'vitest/config';

const live = process.env.JEVCODE_LIVE_TESTS === '1';

export default defineConfig({
  test: {
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], reporter: ['text', 'lcov'] },
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.{ts,tsx}'], environment: 'node' } },
      ...(live
        ? [{ test: { name: 'live', include: ['test/live/**/*.test.ts'], testTimeout: 120_000, concurrent: false } }]
        : []),
    ],
  },
});
```

Run: `vitest --run --project unit` (offline, CI) and `JEVCODE_LIVE_TESTS=1 vitest --run --project live` (needs `.env`; load with `node --env-file=.env ./node_modules/vitest/vitest.mjs --run --project live` or `process.loadEnvFile()` in a `setupFiles` entry). `--run` = "Disable watch mode" (CLI option); the `vitest run` *command* is the one documented as "Perform a single run without watch mode" (`https://vitest.dev/guide/cli.html`, fetched 2026-09-19). No extra plugin is needed for TSX: Vite handles `.tsx` "out of the box" and honours tsconfig `jsx: react-jsx` (`https://vite.dev/guide/features`, fetched 2026-09-19).

### esbuild single-file ESM bundle (`https://esbuild.github.io/api/`, fetched 2026-09-19)
- `--platform=node`: "All built-in node modules such as fs are automatically marked as external"; default format becomes `cjs` when bundling, so pass `--format=esm` explicitly.
- `--packages=external`: "all package imports considered external to the bundle, and are not bundled. Note that your dependencies must still be present on the file system when your bundle is run." Default `--packages=bundle` "means that package imports are allowed to be bundled"; combine with `--external:<pkg>` for exceptions.
- `--jsx=automatic --jsx-import-source=react` for React 17+ runtime; esbuild also reads `jsx` from tsconfig.
- `--banner:js=...` "insert an arbitrary string at the beginning of generated JavaScript" — use for the shebang.

Recommended commands:
```sh
# dev: run TS/TSX directly (tsx needed because Node type-stripping rejects .tsx)
npx tsx src/cli.tsx
# build: keep deps external (smaller, no ESM/CJS interop surprises inside ink's dep tree)
npx esbuild src/cli.tsx --bundle --platform=node --format=esm --target=node22 \
  --packages=external --jsx=automatic --jsx-import-source=react \
  --banner:js='#!/usr/bin/env node' --sourcemap --outfile=dist/cli.mjs
# alt: bundle ink+react in (single-file distribution) — drop --packages=external; watch for
# ink's `ws`/`react-devtools-core` optional peers (mark --external:react-devtools-core).
```
Ink 7.1.1's runtime deps (registry, 2026-09-19) include `yoga-layout`, `react-reconciler`, `ws`, `chalk`, `signal-exit`, etc.; bundling them is possible but untested here (**UNVERIFIED** that yoga-layout's WASM loads correctly from a single esbuild bundle).

---

## 4. Minimal-dependency stance

Runtime deps needed: **`ink` + `react` only.** Ink 7.1.1 peers: `react >=19.2.0` (required), `@types/react >=19.2.0` (optional per `peerDependenciesMeta`), `react-devtools-core >=6.1.2` (optional devtools); `engines.node >=22`; `"type": "module"` (`https://registry.npmjs.org/ink`, fetched 2026-09-19). Ink 7.0.0 published 2026-04-08 with breaking changes "Require Node.js 22", "Require React 19.2+" (`https://github.com/vadimdemedes/ink/releases/tag/v7.0.0`, fetched 2026-09-19); last 6.x is 6.8.0 (2026-02-19, node >=20). Ink README (`https://raw.githubusercontent.com/vadimdemedes/ink/master/readme.md`, fetched 2026-09-19): `npm install ink react`; render options `exitOnCtrlC` (default true), `patchConsole` (default true), `maxFps` (default 30), incremental rendering and concurrent mode options; `useInput`, `usePaste`, `useWindowSize` hooks (7.0 notes).

Everything else is covered by Node 22 built-ins: `fetch`/WebStreams (HTTP to OpenRouter/Anthropic — no `axios`/`undici` needed), `--env-file`/`process.loadEnvFile` (no `dotenv`), `util.styleText` (no `chalk` in our own code), `util.parseArgs` ("v20.0.0: The API is no longer experimental", `https://nodejs.org/docs/latest-v22.x/api/util.html`, fetched 2026-09-19), `node:sqlite` (experimental; avoid in the benchmark path, JSONL files are enough), `AbortSignal.timeout/any` for tool timeouts, `child_process` + `detached` + `process.kill(-pid)` for tree kill.

**ink-testing-library** 4.0.0 (published 2024-05-22) peers `@types/react >=18` and was developed against `ink ^5.0.0`, `react ^18.3.1` (`https://registry.npmjs.org/ink-testing-library/latest` and `https://raw.githubusercontent.com/vadimdemedes/ink-testing-library/master/package.json`, fetched 2026-09-19). **UNVERIFIED** that it works with Ink 7/React 19.3 — treat as optional; prefer testing decision/patch logic without the TUI, and render Ink via `render()` with a fake stdout stream if needed.

### Unified-diff application without npm deps
`https://git-scm.com/docs/git-apply` (fetched 2026-09-19):
- "Without these options, the command applies the patch only to files, and does not require them to be in a Git repository." **[local test]** `git apply --check p.diff` and `git apply p.diff` succeeded in a non-git `/tmp` dir.
- `--check`: "Instead of applying the patch, see if the patch is applicable to the current working tree and/or the index file and detects errors."
- `--3way`: "Attempt 3-way merge if the patch records the identity of blobs it is supposed to apply to and we have those blobs available locally, possibly leaving the conflict markers in the files … This option implies the `--index` option unless the `--cached` option is used, and is incompatible with the `--reject` option." **[local test]** outside a repo: `error: '--3way' outside a repository`. So `--3way` only inside the SWE-bench repo checkout (fine — those are git repos). `--index` requires index and worktree to match exactly; for agent edits prefer plain `git apply` (worktree only) and fall back to `git apply --3way`.
- Atomicity: "For atomicity, `git apply` by default fails the whole patch and does not touch the working tree when some of the hunks do not apply." `--reject` writes `*.rej`. `--recount` "Do not trust the line counts in the hunk headers" (useful for LLM-generated hunks). `--unidiff-zero` for context-free diffs (discouraged). `-p<n>` default 1. `--whitespace=nowarn`. `--allow-empty`.
- macOS: `/usr/bin/patch` is `patch 2.0-12u11-Apple` (BSD patch, not GNU) — **[local test]** `patch -p1 --dry-run < p.diff` worked. Prefer `git apply` for consistent behaviour across macOS and Linux benchmark containers; `patch -p1 --forward --batch` is a last-resort fallback.

Suggested apply ladder: `git apply --check` → `git apply` → `git apply --recount` → `git apply --3way` (in-repo) → regenerate patch.

---

## 5. package.json for a modern ESM CLI

Fields (npm docs `https://docs.npmjs.com/cli/v10/configuring-npm/package-json`, fetched 2026-09-19, and Node `https://nodejs.org/docs/latest-v22.x/api/packages.html`, fetched 2026-09-19):
- `"type": "module"` — Node lists as ES modules: "Files with a `.js` extension when the nearest parent `package.json` file contains a top-level `"type"` field with a value of `"module"`." (packages.html, fetched 2026-09-19)
- `"bin"` — npm: "If you have a single executable, and its name should be the name of the package, then you can just supply it as a string." and "Please make sure that your file(s) referenced in `bin` starts with `#!/usr/bin/env node`, otherwise the scripts are started without the node executable!"
- `"exports"` — Node and npm docs share the same text: "`"exports"` provides a modern alternative to `"main"` allowing multiple entry points to be defined, conditional entry resolution support between environments, and preventing any other entry points besides those defined in `"exports"`. This encapsulation allows module authors to clearly define the public interface for their package." (packages.html and npm package-json docs, fetched 2026-09-19).
- `"files"` — npm: omitting → `["*"]`; always included: `package.json`, `README`, `LICENSE`, `main`, `bin` files; always ignored: `.git`, `.npmrc`, `node_modules`, `package-lock.json` ("use npm-shrinkwrap.json if you wish it to be published"), `pnpm-lock.yaml`, `yarn.lock`, `*.orig`, `.DS_Store`, etc.
- `"engines"` — npm: "Unless the user has set the `engine-strict` config flag, this field is advisory only and will only produce warnings." `engine-strict` (npm 10 config, `https://docs.npmjs.com/cli/v10/using-npm/config#engine-strict`, fetched 2026-09-19): Default `false`, Type Boolean, "npm will stubbornly refuse to install (or even consider installing) any package that claims to not be compatible with the current Node.js version." → put `engine-strict=true` in the project `.npmrc`. **Yes, npm 10 supports it.** Note: `engine-strict` only checks *installed packages'* engines against the running Node; it does not error when merely *running* our CLI — do a runtime `process.versions.node` check in `cli.tsx` too.
- `"devEngines"` (npm 10 docs, fetched 2026-09-19): "aids engineers working on a codebase to all be using the same tooling"; keys `runtime`, `packageManager`, `cpu`, `os`, `libc`, each with `name`, `version`, `onFail: warn|error|ignore`. Useful: `{"runtime": {"name": "node", "version": ">=22.18.0", "onFail": "error"}}`. `devEngines` landed in **npm 10.9.0 (2024-10-03)** — CHANGELOG entry "devEngines (#7766)" (`https://raw.githubusercontent.com/npm/cli/v10.9.0/CHANGELOG.md`, fetched 2026-09-19); our npm 10.9.8 has it. npm docs also say the check runs "before install, ci, and run commands".
- `"packageManager"` — belongs to Corepack. Node v22 docs: "Corepack will no longer be distributed starting with Node.js v25" (`https://nodejs.org/docs/latest-v22.x/api/corepack.html`, fetched 2026-09-19; the v26 docs page `corepack.html` returns HTTP 404, checked 2026-09-19). Still harmless metadata; set `"packageManager": "npm@10.9.8"` but do not depend on Corepack. (Registry `npm` `latest` is 12.0.2, published 2026-07-29, `engines.node ^22.22.2 || ^24.15.0 || >=26.0.0`; `next-10` is 10.9.9 — `https://registry.npmjs.org/npm`, fetched 2026-09-19. We stay on the bundled 10.9.8.)

```json
{
  "name": "jevcode",
  "version": "0.1.0",
  "type": "module",
  "bin": { "jevcode": "./dist/cli.mjs" },
  "exports": { ".": "./dist/index.js", "./package.json": "./package.json" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22.18.0" },
  "devEngines": { "runtime": { "name": "node", "version": ">=22.18.0", "onFail": "error" } },
  "packageManager": "npm@10.9.8",
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "typecheck": "tsc --noEmit",
    "build": "esbuild src/cli.tsx --bundle --platform=node --format=esm --target=node22 --packages=external --jsx=automatic --jsx-import-source=react --banner:js='#!/usr/bin/env node' --sourcemap --outfile=dist/cli.mjs",
    "test": "vitest --run --project unit",
    "test:live": "node --env-file=.env ./node_modules/vitest/vitest.mjs --run --project live",
    "coverage": "vitest --run --project unit --coverage.enabled"
  }
}
```
`.npmrc`: `engine-strict=true` and `save-exact=true`. `.nvmrc`: `22.23.2`.

### Exact pinned versions (all `https://registry.npmjs.org/<pkg>/latest`, fetched 2026-09-19)

| Package | Pin | Published | Kind | Why |
|---|---|---|---|---|
| ink | `7.1.1` | 2026-07-16 | dependency | TUI; node >=22, react >=19.2 |
| react | `19.3.0` | 2026-09-09 | dependency | Ink peer |
| @types/react | `19.3.0` | 2026-09-09 | devDependency | Ink peer (types) |
| @types/node | `22.20.4` | 2026-09-19 | devDependency | match Node 22 line (latest is 26.6.2 — do not use; it types Node 26 APIs) |
| typescript | `7.0.2` | 2026-07-08 | devDependency | native compiler, `tsc --noEmit` |
| vitest | `5.0.1` | 2026-09-15 | devDependency | tests |
| @vitest/coverage-v8 | `5.0.1` | 2026-09-15 | devDependency | must equal vitest version |
| vite | `8.3.0` | 2026-09-10 | devDependency | required non-optional peer of vitest 5 |
| tsx | `4.23.13` | 2026-08-30 | devDependency | run `.tsx` sources in dev |
| esbuild | `0.28.2` | 2026-08-08 | devDependency | bundle to `dist/cli.mjs` |
| ink-testing-library | `4.0.0` (optional) | 2024-05-22 | devDependency | **UNVERIFIED** Ink 7 compat; add only if TUI snapshot tests are wanted |

Not needed: dotenv, chalk, node-fetch/undici, commander/yargs (`util.parseArgs`), tree-kill (`process.kill(-pid)`), diff/patch libs (`git apply`), ts-node (tsx or Node strip-types), @typescript/native-preview (superseded by typescript 7).

---

## UNVERIFIED / not fetched
- ink-testing-library 4.0.0 compatibility with Ink 7.1.1 / React 19.3.0 (not exercised; registry/package.json only show it was built against ink ^5 / react ^18.3.1).
- Whether a fully bundled (ink inlined) esbuild output loads `yoga-layout` WASM correctly (not exercised).
- Resolved on 2026-09-19 (see Verification log): `erasableSyntaxOnly` = TS 5.8; `workspace` removed in Vitest 4.0; `util.parseArgs` stable since v20.0.0; ES2024 features present on v22.23.2; `devEngines` since npm 10.9.0.
- GitHub REST API calls for Ink release bodies hit the unauthenticated rate limit; Ink 7.0.0's date/breaking changes were taken from the release page fetch plus the npm `time` field (both 2026-04-08).

---

## Verification log (2026-09-19)

Independent re-check by an adversarial fact-checker on 2026-09-19. Every version, date and quote was re-fetched from the primary source (`registry.npmjs.org/<pkg>`, `nodejs.org/dist/index.json`, `raw.githubusercontent.com/nodejs/Release/main/schedule.json`, the v22 API docs, the TypeScript/Vitest/esbuild/git/npm docs listed inline) and the local binaries were re-run.

Confirmed unchanged (no edit): Node schedule dates and codenames for v20/v22/v24/v25/v26/v27; latest releases v22.23.2 (2026-07-28, npm 10.9.8), v24.21.0 (2026-09-07, npm 11.19.0), v26.9.0 (2026-09-16, npm 11.19.1), v20.20.2, v25.9.0; all Node v22 doc version/stability lines in the §1 table (fetch v21.0.0, WebStreams v22.15.0, `--env-file`/`--env-file-if-exists`/`loadEnvFile`/`parseEnv` v22.21.0, `--env-file-if-exists` added v22.9.0, `styleText` v22.13.0/v22.8.0/v22.17.0, `enableCompileCache` v22.1.0 Stability 1.1, `stripTypeScriptTypes` v22.13.0 Stability 1.2, type stripping default in v22.18.0 (blog dated 2025-07-31), `node:sqlite` v22.5.0/v22.13.0 Stability 1.1, `node:test` Stable with `**/*.test.{cts,mts,ts}` globs "Unless --no-experimental-strip-types is supplied", `detached` process-group text, spawn `timeout` default `undefined`, `killSignal` `'SIGTERM'`); the typescript.html constraint quotes; Corepack "no longer be distributed starting with Node.js v25" and v26 `corepack.html` HTTP 404; all npm registry facts (typescript 7.0.2 2026-07-08, `next` 7.1.0-dev.20260919.1, `rc` 7.0.1-rc, `beta` 6.0.0-beta, engines >=16.20.0; @typescript/native-preview 7.0.0-dev.20260707.2 2026-07-07; vitest 5.0.1 2026-09-15 with engines `^22.12.0 || ^24.0.0 || >=26.0.0`, non-optional peer `vite ^6.4.0 || ^7.0.0 || ^8.0.0`, vite absent from `dependencies`, dist-tags V4 4.1.11 / V3 3.2.7; @vitest/coverage-v8 5.0.1 peer `vitest: 5.0.1`; vite 8.3.0 2026-09-10 engines `^20.19.0 || >=22.12.0`; tsx 4.23.13 2026-08-30 engines >=18.0.0 dep `esbuild ~0.28.0`; esbuild 0.28.2 2026-08-08 engines >=18; ink 7.1.1 2026-07-16 engines >=22 peers react/@types/react >=19.2.0 and react-devtools-core >=6.1.2, ink 7.0.0 2026-04-08, last 6.x = 6.8.0 2026-02-19 node >=20; react 19.3.0 and @types/react 19.3.0 both 2026-09-09; @types/node 22.20.4 (newest 22.x, 2026-09-19) vs `latest` 26.6.2; ink-testing-library 4.0.0 2024-05-22 peer @types/react >=18, devDeps ink ^5.0.0 / react ^18.3.1); typescript-go README "permanently archived in September 2026" and "API — not ready"; TS 7.0 post date July 8th 2026 and "10x faster native port"; TS 6.0 post date March 23rd 2026 and new defaults; tsconfig `module` page quotes; Vitest migration/projects/coverage/CLI/API quotes (including `--project` "can be repeated for multiple projects", `test.sequential` removal, `clearMocks` default, `extends` default, `sharedViteServer`, "deprecated since 3.2", v3.2.0 AST remapping, `testTimeout` 5_000, `runIf` "Opposite of test.skipIf"); esbuild `--platform=node` cjs default / builtins external / `--packages` / banner quotes; git-apply quotes (`-p` "The default is 1", `--whitespace=nowarn`, `--3way` implies `--index`, atomicity, `--recount`); npm `engine-strict` and `engines` "advisory only" quotes; `devEngines` keys and `onFail` values; nvm `.nvmrc` text; Ink README defaults (`exitOnCtrlC` true, `patchConsole` true, `maxFps` 30, `incrementalRendering`/`concurrent` false); kill(2) and rename(2) quotes; Vite "`.tsx` files are also supported out of the box" and "Vite ignores the `target` value in the tsconfig"; local `node v22.23.2`, `npm 10.9.8`, `git 2.50.1 (Apple Git-155)`, `patch 2.0-12u11-Apple`, and the `--help` flags.

Corrections made:
1. §2 TS 7.0 hard-error list: `outFile` moved out of the 7.0 list (removed in 6.0 per the 6.0 post); `module amd/umd/system` corrected to `amd, umd, systemjs, none`; added the verbatim `alwaysStrict`/`asserts` wording and the "does not ship with an API … 7.1" quote; noted 6.0.2/7.0.2 are the first stable builds of their lines.
2. §2 `erasableSyntaxOnly`: UNVERIFIED removed — TS 5.8 announcement confirms introduction in 5.8.
3. §2 flag defaults: `allowImportingTsExtensions` default corrected from `false` to "true if `rewriteRelativeImportExtensions` is enabled; false otherwise"; ES2024 UNVERIFIED replaced with a local test on v22.23.2 (V8 12.4.254.21) showing `Promise.withResolvers`, `Object.groupBy`, `toSorted`, RegExp `v` flag all present.
4. §3 `--run` description corrected: the flag is documented as "Disable watch mode"; "Perform a single run without watch mode" describes the `vitest run` command.
5. §3 `workspace` removal version resolved: Vitest 4.0 (v4 migration guide).
6. §4 `util.parseArgs` stability resolved: "v20.0.0: The API is no longer experimental" (util.html); Ink `@types/react` peer marked optional per `peerDependenciesMeta`.
7. §5 `"type": "module"` and `"exports"` quotes replaced with the verbatim packages.html sentences (previous wording was paraphrase presented as quotation); always-ignored list made explicit (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).
8. §5 `devEngines` introduction resolved: npm 10.9.0 (2024-10-03), CHANGELOG "#7766"; added registry note that npm `latest` is 12.0.2 (2026-07-29).
9. Final UNVERIFIED list trimmed to the two items that remain unexercised (ink-testing-library with Ink 7; yoga-layout WASM in a single bundle).

Still unverified after this pass: ink-testing-library 4.0.0 with Ink 7.1.1/React 19.3.0 (would need an actual install+render); yoga-layout WASM loading from a fully inlined esbuild bundle (would need a build). GitHub REST `releases` endpoints (vitest, npm/cli) returned no body during this pass (unauthenticated limit), so release-note claims were verified from raw CHANGELOG/docs files instead.
