# Releasing jevcode

The release procedure for the npm package and the Homebrew tap (TUI-DESIGN §17, decisions D14/F15;
evidence in `docs/research/tui/09-packaging-distribution.md` §11.7). Nothing here publishes by itself:
the only publish path is `.github/workflows/release.yml` on a `v*` tag, under npm trusted publishing.
`npm publish` from a laptop is refused by the `prepublishOnly` guard unless `CI=true` is set.

## What ships

One zero-dependency package. `package.json` `files` is the allowlist:

| Path | Origin |
| --- | --- |
| `bin/jevcode.js` | launcher: Node ≥ 22.12 guard, `NO_COLOR` shim, compile cache |
| `dist/jevcode.mjs` | `scripts/build.mjs`: esbuild bundle (ink + react inlined), `minify` + `keepNames`, version injected from `package.json` via `__JEVCODE_VERSION__` |
| `THIRD_PARTY_LICENSES.txt` | `scripts/licenses.mjs`: attributions for every bundled package (the bundle strips license comments) |
| `man/jevcode.1`, `completions/jevcode.{bash,zsh,fish}` | `scripts/gen-docs.mjs` from the CLI tables |
| `README.md`, `LICENSE`, `package.json` | always included by npm |

Not shipped: `dist/jevcode.mjs.map`, `dist/meta.json`, `src/`, `docs/`, tests. `scripts/check-pack.mjs`
enforces this: allowlist equality, forbidden paths, an unpacked-size gate, a tarball-size gate and a `--version` smoke.

**The size gates are the script's `UNPACKED_MAX` and `TARBALL_MAX`, and this document deliberately does not restate
them.** This paragraph carried a hand-copied 2 MB figure long after the gate was raised past it (`ca8e71c`), which is
how a release note comes to promise a bound the build does not enforce. Read the two constants at the top of `scripts/check-pack.mjs`, or just
run it — the pass line prints the measured size against the gate. `test/unit/hygiene/doc-claims.test.ts` fails if any
byte figure printed here beside either constant's name stops matching the script.

## One-time setup (before the first release)

1. Push the repository to GitHub and set `repository`, `homepage` and `bugs` in `package.json`
   (`npm pkg set repository.type=git repository.url=git+https://github.com/<owner>/JevCode.git homepage=https://github.com/<owner>/JevCode#readme bugs.url=https://github.com/<owner>/JevCode/issues`).
   Provenance verification compares `repository.url` with the workflow's repository, so this must be right.
2. On npmjs.com: create the `jevcode` package (first publish can be done from CI directly) and configure
   **Settings → Trusted publisher → GitHub Actions** with repository `<owner>/JevCode`, workflow
   `release.yml`. No `NPM_TOKEN` secret is needed or wanted.
3. Create the tap repository `<owner>/homebrew-jevcode` and copy `Formula/jevcode.rb` into it; set
   `homepage` in the formula.

## Checklist per release

Work on `main` with a clean tree (`git status --short` empty). `<v>` is the new version, e.g. `0.2.0`;
pre-releases look like `0.2.0-rc.1` and land on the `next` dist-tag automatically.

1. **Gates on the current tree**

   ```sh
   nvm use                      # Node 22.23.2 from .nvmrc
   npm ci
   npm run check                # tsc strict + no-any, vitest unit
   npm run perf                 # perf/results/latest.json: firstFrame.pass === true
   ```

2. **Version bump** (package.json is the single source of truth; the bundle reads it at build time)

   ```sh
   npm version <v> --no-git-tag-version
   ```

3. **CHANGELOG** — add a `## <v> — YYYY-MM-DD` section at the top of `CHANGELOG.md` (create the file on the
   first release; Keep-a-Changelog headings: Added / Changed / Fixed / Removed). The GitHub Release notes
   are generated from PR titles by the workflow; the CHANGELOG is the curated record.

4. **Commit the bump, then regenerate the derived docs** (the man page's `.TH` date is the commit date of
   `package.json`, so regenerate after committing and commit again if anything changed)

   ```sh
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "release: v<v>"
   node scripts/gen-docs.mjs             # man/jevcode.1, completions/*, docs/KEYS.md, docs/COMMANDS.md
   node scripts/gen-docs.mjs --check     # must print nothing stale
   git add -A man completions docs/KEYS.md docs/COMMANDS.md && git commit -m "docs: regenerate for v<v>" || true
   ```

5. **Build, licenses, pack gates** (exactly what CI runs)

   ```sh
   npm run build                # bundle + first-frame/--version smoke, then THIRD_PARTY_LICENSES.txt
   npm run licenses -- --check  # attribution file is current
   npm run pack:check           # all gates "ok"
   npm pack --dry-run           # eyeball the file list and sizes
   ```

6. **Tag and push** — the tag triggers `.github/workflows/release.yml`

   ```sh
   git tag -a v<v> -m "jevcode v<v>"
   git push origin main
   git push origin v<v>
   ```

   The job (Node 24, npm ≥ 11.5.1, `id-token: write`) runs `npm ci`, `typecheck`, `test`, `build`,
   `pack:check`, `gen-docs --check`, packs, publishes with `--provenance --access public --tag next|latest`,
   creates the GitHub Release with the tarball and `SHA256SUMS`, and prints the Homebrew bump lines in the
   job summary. Watch it: `gh run watch`.

7. **Verify the publish**

   ```sh
   npm view jevcode@<v> version dist-tags dist.attestations
   npx -y jevcode@<v> --version         # prints "jevcode <v>"
   mkdir -p /tmp/jevcode-verify && cd /tmp/jevcode-verify && npm init -y >/dev/null && npm i jevcode@<v> --omit=dev \
     && ls node_modules | wc -l          # 1: only jevcode itself is installed
   ```

8. **Homebrew tap bump** (manual; the tap is a separate repository)

   ```sh
   curl -sL "https://registry.npmjs.org/jevcode/-/jevcode-<v>.tgz" | shasum -a 256
   brew info --json=v2 node | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).formulae[0]; console.log("brew node", d.versions.stable)'
   #   the node major must satisfy package.json engines (>=22.12.0 <27); otherwise switch the formula to node@22
   ```

   In `<owner>/homebrew-jevcode`, set `url` to `https://registry.npmjs.org/jevcode/-/jevcode-<v>.tgz` and
   `sha256` to the digest (the workflow's job summary has both lines ready), then:

   ```sh
   brew install --build-from-source <owner>/jevcode/jevcode
   brew test jevcode
   brew audit --strict --online jevcode
   git commit -am "jevcode <v>" && git push
   ```

9. **Promote a pre-release** once the bench/perf gates pass on it (`next` → `latest`):

   ```sh
   npm dist-tag add jevcode@<v> latest
   ```

## Dry runs

- Full local rehearsal without publishing: `npm run build && npm run pack:check && npm pack` then, in a
  temp dir, `tar xzf jevcode-<v>.tgz && cd package && npm install --omit=dev && node bin/jevcode.js --version`
  (installs zero packages; `node_modules` is absent or empty).
- `CI=true npm publish --dry-run` shows what npm would upload (no network write).

## Recovery

- A failed job after `npm publish` succeeded: fix forward with a patch version; npm versions are
  immutable (unpublish only within 72 h and only when nothing depends on it).
- A bad `latest`: `npm dist-tag add jevcode@<previous> latest` moves the pointer back without unpublishing.
- A tag pushed by mistake before the bump commit: `git push --delete origin v<v>` before the job packs.
