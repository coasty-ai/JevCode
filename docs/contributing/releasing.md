# Releasing

This page explains how a release works: what ships, which gates guard it, and how the pipeline carries one tagged
version to every install channel. The step-by-step runbook, with every settings page, command and recovery, is
[`docs/RELEASE.md`](../RELEASE.md).

**Nothing has been published yet.** The registry returns 404 for `jevcode`, no `v*` tag exists, and the
Homebrew tap and the AUR package do not exist until their one-time setup steps are done
([`docs/RELEASE.md`](../RELEASE.md), "One-time setup").

## Channels

| Channel | Install command | How it is updated |
| --- | --- | --- |
| npm | `npm i -g jevcode`, `npx jevcode` | `release.yml` publishes with trusted publishing and provenance |
| bun, pnpm, yarn | `bunx jevcode`, `pnpm dlx jevcode`, `yarn dlx jevcode` | nothing extra: they read the npm registry |
| mise | `mise use -g npm:jevcode` | nothing extra: mise's npm backend |
| Homebrew | `brew install coasty-ai/jevcode/jevcode` | `release.yml` pushes the rendered formula to `coasty-ai/homebrew-jevcode` |
| AUR | `yay -S jevcode` or `paru -S jevcode` | `release.yml` pushes `PKGBUILD` and `.SRCINFO` to the AUR |
| Nix | `nix run github:coasty-ai/JevCode` | nothing per release: `flake.nix` builds from source at any ref, and `flake-lock.yml` keeps `flake.lock` current |

Pre-releases (versions with a hyphen, such as `0.7.0-rc.1`) go to npm under the `next` dist-tag and become a
GitHub pre-release. They do not update Homebrew or the AUR.

## What ships

One package with **zero runtime dependencies**. The rendering library and its React peer are inlined into a
single bundled file at build time, so a global install pulls in exactly one package.

The `files` field in `package.json` is the allowlist:

| path | produced by |
| --- | --- |
| `bin/jevcode.js` | the launcher: a Node-version guard, a no-colour shim, the compile cache, then the bundle |
| `dist/jevcode.mjs` | `scripts/build.mjs`: one minified ESM bundle with names kept, and the version injected from `package.json` |
| `THIRD_PARTY_LICENSES.txt` | `scripts/licenses.mjs`, derived from the bundler's metafile because the bundle strips attribution comments |
| `man/jevcode.1`, `completions/jevcode.{bash,zsh,fish}` | `scripts/gen-docs.mjs`, from the command tables |
| `README.md`, `LICENSE`, `package.json` | always included by the packager |

Not shipped: the source map, the bundler metafile, `src/`, `docs/`, tests.

## The gates

`ci.yml` runs on every push to `main` and every pull request. `release.yml`'s `gates` job runs the same steps
in the same order, so a green `ci.yml` predicts a green release gate:

1. typecheck (strict `tsc`, then the no-`any` rule) and the Jev call-site contract;
2. the unit suite, where a failing test is retried up to twice (about 40 files assert wall-clock budgets that a
   busy shared runner can miss; a real regression fails all three attempts);
3. `npm run build`: bundle, attribution file, and a smoke test of the built artefact. The smoke launches the real
   binary with `JEVCODE_ASSERT_NO_NETWORK=1`, requires the first frame, then requires `--version` to print the
   `package.json` version. Any HTTP fetch before the first frame fails the build;
4. `npm run pack:check`: the package is publishable, `LICENSE` and `THIRD_PARTY_LICENSES.txt` exist,
   `dependencies` is empty, the packed file list equals the allowlist, no forbidden path ships, the unpacked
   size is under 3.6 MB and the tarball under 1.5 MB, and the packed binary prints the right version;
5. the generated documents, the decisions table of contents and every relative doc link are current, and the
   README carries no hard-coded version or placeholder.

`packaging.yml` runs on pull requests that touch packaging, and on demand. It packs a tarball and then checks
three things against that same local file: the Homebrew formula on macOS (install, test, audit, style), the
PKGBUILD in an Arch container (makepkg, namcap, install) and the flake on Linux and macOS.

`npm run perf` is a separate gate that needs a quiet machine; see
[the performance page](../measurements/performance.md).

## The publish path

There is exactly one, and it runs in GitHub Actions, not on a laptop. A local `npm publish` is refused by a guard
in `package.json` unless `CI` is set.

1. **prepare-release** (Actions → prepare-release → Run workflow on `main`). It bumps the version, turns the
   changelog heading into a dated one, regenerates the derived documents, commits as `github-actions[bot]`, tags,
   pushes, and starts `release.yml` on the tag. A person pushing a `v*` tag starts the same workflow.
2. **release.yml**:
   - `validate`: the tag equals `package.json`, the changelog has a dated section, the commit is on `main`,
     and it picks the dist-tag;
   - `gates`: the ci.yml steps;
   - `pack`: builds the published tarball on a fresh runner that runs only lockfile-pinned code;
   - `publish-npm`: waits for **one human approval** on the `release` environment, then publishes with
     trusted publishing (OIDC, no stored token) and provenance;
   - `github-release`, `homebrew` and `aur` update their channels. The last two run for stable releases only;
   - `verify`: runs the published package and prints a table of every channel.

Every job can be re-run. It skips work that is already done, fails loudly on a mismatch (for example different
bytes already on the registry), and a channel whose credential is not configured yet is skipped with a
one-line summary instead of failing.

## Rehearsing without publishing

- Run prepare-release with **dry_run** ticked. It makes the commit and tag in the runner, runs the gates and
  shows what it would push, and pushes nothing.
- Run packaging.yml on your branch. It exercises all three package formats against a locally packed tarball.
- Locally: `npm run build && npm run pack:check && npm pack --ignore-scripts`. Then unpack the tarball in a
  temporary directory, install it with dev dependencies omitted, and run `--version`. Exactly one package
  installs.

## If something goes wrong

A published version is immutable, so fix forward with a patch version. `docs/RELEASE.md` has a recovery row for
every job that can stop part-way, including re-running a single channel and moving a dist-tag back.

## Related

- [`docs/RELEASE.md`](../RELEASE.md): the runbook, with one-time setup, the per-release flow and recovery.
- [Install](../getting-started/install.md): every channel from the user's side.
- [Contributing](README.md): the gates in detail.
