# Contributing

Thanks for looking. The full guide — how the code is laid out, what the tests expect, how to run a
bench or a live capture, and how a change gets reviewed — is in
[docs/contributing/README.md](docs/contributing/README.md). This page is the short version.

## Get set up

```sh
git clone https://github.com/coasty-ai/JevCode && cd JevCode
nvm use          # Node 22.23.2, per .nvmrc; anything >=22.12 works
npm ci
npm run build
```

No API key is needed to build, typecheck or run the unit tests. They are offline.

## Before you open a pull request

```sh
npm run check    # typecheck (tsc strict + the no-any rule), the Jev contract, unit tests
npm run build    # the bundle, plus THIRD_PARTY_LICENSES.txt
```

If you touched anything the CLI tables generate from — flags, commands, key bindings — regenerate
the derived files and commit them:

```sh
node scripts/gen-docs.mjs            # man page, shell completions, docs/KEYS.md, docs/COMMANDS.md
node scripts/gen-docs.mjs --check    # must print nothing
```

CI runs exactly these, so a green local run is a green CI run.

## House rules

- **No `any`.** `scripts/no-any.mjs` fails the typecheck on it. The types are strict on purpose.
- **No new runtime dependencies.** The package ships one bundled file and installs zero packages;
  a new dependency needs its own discussion first.
- **Tests come with the change.** A bug fix should include the test that failed before it.
- **Do not rename the design documents in `docs/`.** The code cites them by path and section.
- **Never commit a key**, a `.env` file, or a captured session that contains one.

## Filing a bug

Include the version (`jevcode --version`), your operating system, the mode, and what you ran. If a
run is involved, `jevcode report` bundles the artefacts with secrets already redacted — check it
before attaching it anyway.

Security problems go to [SECURITY.md](SECURITY.md), not to the issue tracker.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE), the
same as the rest of the project.
