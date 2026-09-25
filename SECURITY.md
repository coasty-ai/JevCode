# Security

JevCode runs commands that a language model chose, on your machine, against your files. This page
says what protects you, what does not, and how to tell us when something is wrong.

## Reporting a vulnerability

Please report privately first, so a fix can ship before the details are public.

- Preferred: open a [private security advisory](https://github.com/coasty-ai/JevCode/security/advisories/new)
  on the repository. Only the maintainers can see it.
- If that is not available to you, open a normal issue that says only "security report, please make
  contact" and nothing else — no details, no reproduction — and a maintainer will reply with a
  private channel.

Please include the version (`jevcode --version`), your operating system, and the smallest sequence
of steps that shows the problem. If a proof of concept writes files or makes network calls, say so.

Expect an acknowledgement within a few days. There is no bug bounty. Fixes go out in a normal
release and the advisory is published once the release is available.

Please do not report: a model producing a bad patch, a model refusing a task, or a command failing
in the sandbox. Those are ordinary bugs — open an issue.

## Your keys

Your API keys are stored on your machine and are sent to exactly one place: the provider they
belong to, over HTTPS. There is no JevCode server, no telemetry, and no crash reporting.

- Keys are read from the environment, from a `.env` file, or from `~/.config/jevcode/config.json`,
  which is written with mode `0600` inside a directory created `0700`.
- Keys are never accepted as command-line arguments in the interactive flow, so they do not land in
  your shell history or in the process table.
- Keys are never placed in the environment of a command the agent runs. A sandboxed command
  inherits your environment minus every JevCode key, every variable whose name marks a secret
  (`KEY`, `TOKEN`, `SECRET`, `PASSW`, `PASSPHRASE`, `CREDENTIAL`, `COOKIE`, or an `AUTH` segment),
  any value the redactor recognises, and `JEVCODE_*` / `JEV_*`, `npm_*`, `INIT_CWD` and `GIT_*`.
  `HOME` and `TMPDIR` are remapped into the run directory. A password inside an ordinarily named
  value such as `DATABASE_URL` is passed. The full list is in
  [the environment a command sees](docs/operations/sandbox-and-security.md#the-environment-a-command-sees).
- Logs, checkpoints, results, the `--json` stream and the session transcript pass through a redactor
  seeded with every configured secret and with the recognised key formats. `jevcode config` shows a
  key only as its source and the first few characters of a hash of it.
- Text you type is scanned before it is sent. If it looks like a secret, the composer masks it and
  asks before sending; without a terminal, the run is refused rather than sent.

Two limits worth knowing. The "send anyway" decision registers that secret with the redactor for the
current process only — a later `--resume` does not remember it, though what was already written to
disk stays redacted. And a secret in a format nothing recognises, typed inline, is not detected.

## What the sandbox does

Every command the agent runs goes through `/bin/sh -c` in a detached process group with the working
directory fixed to your workspace, the environment filtered as above, a timeout, a cap on captured
output, and a three-pass tree kill on timeout or cancel.

On macOS, and only on macOS, the command additionally runs under `sandbox-exec` with a generated
profile: writes are denied everywhere except the workspace, the run's own temp and home directories
and `/dev`; git's own configuration and hooks are write-denied so a command cannot make later git
calls run code; and reads of JevCode's config, `.env`, `~/.ssh`, `~/.aws`, `~/.config/gh` and
`~/.netrc` are denied. `--no-network` additionally denies all network.

## What the sandbox is NOT

Read this part. The sandbox raises the cost of an accident. It is not a security boundary and it is
not a defence against a deliberately hostile model or a hostile repository.

- **There is no sandbox at all off macOS.** On Linux and everywhere else the protection level
  degrades to cwd confinement, environment filtering, timeout, output cap and tree kill. No
  filesystem confinement, no network confinement. `jevcode config` reports the level it actually
  got; read it rather than assuming.
- **Reads are mostly allowed.** Outside the specific denied paths listed above, a command can read
  anything your user can read. Treat anything readable by your account as visible to the model.
- **The network is open unless you close it.** Without `--no-network`, a command can reach the
  internet, including exfiltrating anything it just read.
- **A prompt-injecting repository is in scope for the model, not for the sandbox.** A comment, a
  README or a test fixture in the code you point JevCode at can instruct the model. Nothing here
  prevents that; the sandbox only limits what the resulting command can write.
- **Known escapes exist.** `sandbox-exec` is deprecated by Apple. A process that double-forks before
  the kill snapshot can outlive the tree kill. Some Apple platform binaries refuse to run under any
  profile and are reported as denied rather than silently unconfined.
- **Windows is not supported.** There is no equivalent confinement; use WSL 2.

The safe posture: run JevCode on a repository you are willing to have modified, from an account
without credentials you would mind being read, and use `--no-network` when the task does not need
the network.

## Supported versions

Only the most recent release receives security fixes.
