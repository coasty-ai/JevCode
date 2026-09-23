# Releasing

**Nothing here has shipped yet.** There is no published package, no tag, and no Homebrew tap. This page is
the procedure and an honest account of what is still missing before the first release can happen.

The full step-by-step checklist, with every command, is [`docs/RELEASE.md`](../RELEASE.md). This page is the
orientation: what ships, what the gates are, what is set up, and what is not.

## State of play

| fact | state |
| --- | --- |
| package version | **0.5.0** (`package.json` is the single source of truth; the bundle reads it at build time) |
| published to the registry | **no** — the registry returns 404 for the package name |
| git tag | **none exists** |
| git remote | present |
| `repository`, `homepage`, `bugs` in `package.json` | **set**, all three at `github.com/coasty-ai/JevCode`. Provenance verification compares the repository field against the publishing workflow's repository, so they have to stay in step with it |
| Homebrew formula | present. `homepage` is real; **`url` and `sha256` are placeholders** — the `url` names a tarball that is not on the registry, and the digest is deliberately invalid |
| `CHANGELOG.md` header line | current — it names 0.5.0, and says nothing has been published |

Until a release exists, **every install instruction that names the registry or the tap is unavailable**, and
the README says so rather than printing a command that cannot work.

The formula's `sha256` is deliberately invalid, so an unreleased copy can never install by accident.

## What ships

One package with **zero runtime dependencies**. The rendering library and its React peer are inlined into a
single bundled file at build time, so a global install pulls in exactly one package.

The `files` field in `package.json` is the allowlist:

| path | produced by |
| --- | --- |
| `bin/jevcode.js` | the launcher: a Node-version guard, a no-colour shim, the compile cache, then the bundle |
| `dist/jevcode.mjs` | `scripts/build.mjs` — one minified ESM bundle with names kept, so stack traces stay readable, and the version injected from `package.json` |
| `THIRD_PARTY_LICENSES.txt` | `scripts/licenses.mjs`, derived from the bundler's metafile because the bundle strips attribution comments |
| `man/jevcode.1`, `completions/jevcode.{bash,zsh,fish}` | `scripts/gen-docs.mjs`, from the command tables |
| `README.md`, `LICENSE`, `package.json` | always included by the packager |

Not shipped: the source map, the bundler metafile, `src/`, `docs/`, tests.

## The gates

### `npm run build`

Two steps, in order:

1. `node scripts/build.mjs` — bundles, then runs a **smoke test on the artefact it just built**:
   - it launches the real binary in a temporary workspace with `JEVCODE_ASSERT_NO_NETWORK=1` and a flag that
     exits after the first frame, and requires the first-frame marker to appear. With that variable set, any
     HTTP fetch before the first frame throws, so a build that added a network call at startup fails here.
   - it then runs `--version` under the same variable and requires the exact `package.json` version.
2. `node scripts/licenses.mjs` — regenerates the attribution file.

The publishing workflow sets `JEVCODE_ASSERT_NO_NETWORK=1` for the whole job, so the smoke runs under it there
too.

### `npm run pack:check`

Eight gates, every failure reported, exit 1 if any fails:

1. the package is publishable (not marked private);
2. `LICENSE` exists and is non-empty;
3. `THIRD_PARTY_LICENSES.txt` exists and is non-empty;
4. **`dependencies` is empty** — so a global install installs zero other packages;
5. the packed file list equals the allowlist derived from `files`, expanded recursively, plus `package.json`;
   extras and missing entries are both named;
6. no forbidden path: source maps, the metafile, `src/`, `docs/`, test files, dotenv files, local tooling
   state, or any non-shipping directory;
7. unpacked size under 3.5 MB and the gzipped tarball under 1.5 MB;
8. `node bin/jevcode.js --version` prints the `package.json` version.

The size ceiling has its own history in a comment: it was 3.0 MB, and it was raised to 3.5 MB when one round
of interface work plus several harness waves landing the same day put the unpacked package 0.12 % over.

### The rest

`npm run check` (typecheck, no-`any`, the decision-call lint, the documentation link check, the unit
suite) and `npm run perf` both run
before a release. The performance gate needs the machine quiet at both ends to produce a release number; see
[the performance page](../measurements/performance.md).

`node scripts/gen-docs.mjs --check` must print nothing stale. The manual page's date comes from the commit date
of `package.json`, so the generated documents are regenerated **after** the version-bump commit.

## The publish path

**There is exactly one**, and it is not a laptop.

`.github/workflows/release.yml` fires on a pushed tag matching `v*`. Running `npm publish` locally is refused
by a guard in `package.json` unless the continuous-integration variable is set, which is a deliberate
speed bump rather than a lock.

The job:

- asserts Node ≥ 24.5.0 and the packaging client ≥ 11.5.1, which is what trusted publishing requires;
- asserts the tag equals the `package.json` version, and fails otherwise;
- routes a tag containing a hyphen to the pre-release channel and everything else to the default channel;
- runs install, typecheck, tests, build, the pack gates and the generated-document check;
- packs, then publishes with provenance under trusted publishing — **no long-lived token is used or wanted**;
- creates the release with the exact tarball that was published plus its checksum file;
- prints the two Homebrew lines, ready to paste, in the job summary.

The whole job runs on a Node version used nowhere else in the project. Everything else runs on the version
pinned in `.nvmrc`.

## One-time setup, still outstanding

Two things must happen before the first release, and neither has:

1. **Create the package on the registry and configure trusted publishing** for this repository and this
   workflow file. No token secret is needed.
2. **Create the tap repository and copy the formula into it.** The formula's `url` and `sha256` stay
   placeholders until the release job prints the real digest.

`package.json` already carries `repository`, `homepage` and `bugs`, and `main` has to be pushed to that
remote before the first publish: provenance verification compares `repository.url` with the workflow's
repository. Three strings in the source still name an older owner in lower case and need the same update —
`OPENROUTER_REFERER` in `src/provider/openrouter.ts`, `DEFAULT_REFERER` in `src/jev/types.ts` and
`ISSUES_URL` in `src/cli/report.ts`.
<!-- docs/RELEASE.md "One-time setup" items 1-3. -->

## The release itself, in outline

1. Gates on a clean tree: `npm run check`, then `npm run perf`.
2. Bump the version without a tag.
3. Add a changelog section at the top. The release notes are generated from titles; the changelog is the
   curated record.
4. Commit the bump, then regenerate the derived documents and commit again if anything changed.
5. Build, regenerate the attribution file, run the pack gates, and eyeball the packed file list.
6. Tag and push. The tag is what triggers the workflow.
7. Verify: check the published version and its attestations, run the published package's `--version`, and
   install it into an empty directory — exactly one package should appear.
8. Bump the tap: take the tarball's digest, set `url` and `sha256`, build from source, test and audit the
   formula. Confirm first that the formula's Node dependency still satisfies the package's engine range.
9. Promote a pre-release to the default channel once its gates pass.

## Rehearsing without publishing

```sh
npm run build && npm run pack:check && npm pack
```

Then, in a temporary directory, unpack the tarball, install it with development dependencies omitted, and run
`--version`. That installs zero packages and leaves the dependency directory absent or empty. A dry-run
publish shows exactly what would be uploaded without any network write.

## If something goes wrong

- **The job failed after the publish succeeded.** Fix forward with a patch version. Published versions are
  immutable; unpublishing is only possible within a short window and only while nothing depends on the
  package.
- **A bad default channel.** Move the channel pointer back to the previous version. No unpublish is needed.
- **A tag pushed before the bump commit.** Delete the remote tag before the job reaches the packing step.

## Related

- [`docs/RELEASE.md`](../RELEASE.md) — the checklist with every command.
- [Contributing](README.md) — the gates in detail.
- [Startup, render and harness overhead](../measurements/performance.md) — what the performance gate measures.
