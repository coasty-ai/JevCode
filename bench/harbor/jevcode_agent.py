"""Harbor installed-agent adapter for JevCode (bench/harbor/README.md, DESIGN.md §13).

Runs JevCode the way the Terminal-Bench 4.0 leaderboard runs agents: installed into the task
container (Node 22 via nvm + the packed tarball), invoked headless as
``jevcode run --plain --workspace /app "<instruction>"`` with the run directory redirected to
``/logs/agent`` so trajectories survive the container. Harbor's verifier decides pass/fail from
``/app``; JevCode's own exit code is recorded, never raised.

Usage (from the repo root, see README):
    PYTHONPATH=$PWD harbor run -d terminal-bench/terminal-bench@4.0.0 \
        -a bench.harbor.jevcode_agent:JevCodeAgent -m anthropic/claude-sonnet-5 \
        --ae ANTHROPIC_API_KEY=... --ae JEV_API_KEY=... --ak max_wall=7h30m --ak spend_cap_usd=5

Only ``harbor.*`` and the standard library are imported. Untested on the reference machine (Harbor needs
Python >= 3.12); kept faithful to the documented BaseInstalledAgent API fetched 2026-09-19.
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template

try:  # helper present in Harbor main; fall back to an equivalent snippet on older wheels
    from harbor.agents.installed.node_install import nvm_node_install_snippet
except ImportError:  # pragma: no cover - depends on the installed Harbor version

    def nvm_node_install_snippet(node_major: int) -> str:
        return (
            "export NVM_DIR=\"$HOME/.nvm\" && "
            "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && "
            ". \"$NVM_DIR/nvm.sh\" && "
            f"nvm install {node_major} && nvm use {node_major}"
        )


try:  # declarative error patterns / env vars exist on Harbor main; optional elsewhere
    from harbor.agents.installed.base import ApiRateLimitError, AgentAuthenticationError, ContextWindowExceededError, EnvVar, ErrorPattern
except ImportError:  # pragma: no cover
    ApiRateLimitError = AgentAuthenticationError = ContextWindowExceededError = None  # type: ignore[assignment]
    EnvVar = ErrorPattern = None  # type: ignore[assignment]

try:
    from harbor.agents.base import AgentOptions
except ImportError:  # pragma: no cover
    AgentOptions = None  # type: ignore[assignment]


REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_VERSION = json.loads((REPO_ROOT / "package.json").read_text()).get("version", "0.1.0") if (REPO_ROOT / "package.json").exists() else "0.1.0"
# the npm package is scoped; the command it installs is still `jevcode`
NPM_PACKAGE = "@coasty/jevcode"
NODE_MAJOR = 22
DEFAULT_MODEL = "anthropic/claude-sonnet-5"
DEFAULT_MAX_WALL = "7h30m"  # below TB 4.0's flat 8 h agent timeout so JevCode stops itself
DEFAULT_MAX_STEPS = 40
DEFAULT_SPEND_CAP_USD = 5.0
AGENT_LOGS = "/logs/agent"
PASSTHROUGH_ENV = (
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "JEV_API_KEY",
    "JEV_BASE_URL",
    "JEV_MODEL",
    "JEVCODE_PROVIDER",
    "JEVCODE_MODEL",
    "JEVCODE_SPEND_CAP_USD",
    "JEVCODE_MAX_STEPS",
    "JEVCODE_MAX_WALL",
)

if AgentOptions is not None:

    class JevCodeAgentOptions(AgentOptions):  # type: ignore[misc]
        """``--ak`` keys Harbor validates at preflight (main; may post-date the 0.23.0 wheel)."""

        max_steps: int = DEFAULT_MAX_STEPS
        spend_cap_usd: float = DEFAULT_SPEND_CAP_USD
        max_wall: str = DEFAULT_MAX_WALL
        provider: str | None = None
        install_mode: str = "bundle"  # bundle | npm
        tarball: str | None = None

else:  # pragma: no cover
    JevCodeAgentOptions = None  # type: ignore[assignment]


_WALL_RE = re.compile(r"^(\d+(ms|s|m|h|d))+$|^\d+$")


class JevCodeAgent(BaseInstalledAgent):
    """JevCode as a Harbor installed agent."""

    options_model = JevCodeAgentOptions
    SYSTEM_PACKAGES = ["curl", "ca-certificates", "git"]
    if EnvVar is not None:
        ENV_VARS = [EnvVar(name=n, required=False) for n in PASSTHROUGH_ENV]  # type: ignore[call-arg]
    if ErrorPattern is not None and ApiRateLimitError is not None:
        ERROR_PATTERNS = [  # regexes over the plain renderer's output -> Harbor retry classes
            ErrorPattern(pattern=re.compile(r"(?i)(429|rate.?limit)"), error_type=ApiRateLimitError),  # type: ignore[call-arg]
            ErrorPattern(pattern=re.compile(r"(?i)(401|403|authentication|invalid api key)"), error_type=AgentAuthenticationError),  # type: ignore[call-arg]
            ErrorPattern(pattern=re.compile(r"(?i)(context.?window|prompt is too long|maximum context)"), error_type=ContextWindowExceededError),  # type: ignore[call-arg]
        ]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Harbor validates kwargs through options_model on main; older wheels pass them raw.
        self.max_steps = int(kwargs.pop("max_steps", DEFAULT_MAX_STEPS))
        self.spend_cap_usd = float(kwargs.pop("spend_cap_usd", DEFAULT_SPEND_CAP_USD))
        self.max_wall = str(kwargs.pop("max_wall", DEFAULT_MAX_WALL))
        self.provider_override = kwargs.pop("provider", None)
        self.install_mode = str(kwargs.pop("install_mode", "bundle"))
        self.tarball = kwargs.pop("tarball", None)
        if not _WALL_RE.match(self.max_wall):
            raise ValueError(f"max_wall must look like 7h30m / 90s / 1500 (got {self.max_wall!r})")
        if self.max_steps < 1 or self.spend_cap_usd <= 0:
            raise ValueError("max_steps must be >= 1 and spend_cap_usd > 0")
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "jevcode"

    def version(self) -> str | None:
        return PACKAGE_VERSION

    # -- install -----------------------------------------------------------------------------

    def _local_tarball(self) -> Path:
        if self.tarball:
            p = Path(self.tarball).expanduser().resolve()
        else:
            # `npm pack` names the scoped package's tarball coasty-jevcode-<version>.tgz; a release asset is jevcode-<version>.tgz
            candidates = sorted(REPO_ROOT.glob("coasty-jevcode-*.tgz")) or sorted(REPO_ROOT.glob("jevcode-*.tgz"))
            if not candidates:
                raise FileNotFoundError("no coasty-jevcode-<version>.tgz in the repo root; run `npm run build && npm pack` first (or --ak install_mode=npm)")
            p = candidates[-1]
        if not p.is_file():
            raise FileNotFoundError(f"tarball not found: {p}")
        return p

    async def install(self, environment) -> None:  # type: ignore[no-untyped-def]
        await self.exec_as_root(environment, command="apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git || true")
        if self.install_mode == "npm":
            pkg = f"{NPM_PACKAGE}@{PACKAGE_VERSION}"
            install = f"npm install -g {shlex.quote(pkg)}"
        else:
            await environment.upload_file(self._local_tarball(), "/tmp/jevcode.tgz")
            install = "npm install -g /tmp/jevcode.tgz"
        # nvm leaves `jevcode` under ~/.nvm/...; expose a fixed path for the fresh shells exec_as_agent starts
        await self.exec_as_root(
            environment,
            command=f"{nvm_node_install_snippet(NODE_MAJOR)} && {install} && ln -sf \"$(command -v jevcode)\" /usr/local/bin/jevcode && ln -sf \"$(command -v node)\" /usr/local/bin/node",
        )
        await self.exec_as_root(environment, command=f"mkdir -p {AGENT_LOGS}/jevcode && chmod -R a+rwx {AGENT_LOGS}")

    # -- run ---------------------------------------------------------------------------------

    def _provider_and_model(self) -> tuple[str, str]:
        provider, _, model = (self.model_name or DEFAULT_MODEL).partition("/")
        if self.provider_override:
            provider = str(self.provider_override)
        if provider not in ("anthropic", "openrouter"):
            # LiteLLM-style ids such as `claude-sonnet-5` without a provider default to Anthropic
            provider, model = "anthropic", (self.model_name or DEFAULT_MODEL)
        return provider, model or DEFAULT_MODEL.partition("/")[2]

    def command(self, instruction: str) -> str:
        provider, model = self._provider_and_model()
        return (
            "cd /app && "
            f"JEVCODE_HOME={AGENT_LOGS}/jevcode "
            f"JEVCODE_PROVIDER={shlex.quote(provider)} JEVCODE_MODEL={shlex.quote(model)} "
            "jevcode run --plain --workspace /app "
            f"--max-wall {shlex.quote(self.max_wall)} --max-steps {self.max_steps} "
            f"--spend-cap {self.spend_cap_usd} "
            f"{shlex.quote(instruction)} "
            f"2>&1 | tee -a {AGENT_LOGS}/jevcode.log; "
            f"echo ${{PIPESTATUS[0]}} > {AGENT_LOGS}/jevcode.exit"
        )

    @with_prompt_template
    async def run(self, instruction: str, environment, context) -> None:  # type: ignore[no-untyped-def]
        # JevCode's non-zero exits (e.g. budget stops) are data, not agent errors: the verifier decides from /app.
        try:
            await self.exec_as_agent(environment, command=self.command(instruction))
        except Exception as exc:  # noqa: BLE001 - recorded, never raised
            context.metadata = {**(getattr(context, "metadata", None) or {}), "exec_error": str(exc)[:500]}
        self.populate_context_post_run(context)

    # -- post-run ----------------------------------------------------------------------------

    def populate_context_post_run(self, context) -> None:  # type: ignore[no-untyped-def]
        logs = Path(self.logs_dir)
        meta: dict[str, Any] = dict(getattr(context, "metadata", None) or {})
        exit_file = logs / "jevcode.exit"
        if exit_file.is_file():
            try:
                meta["exit_code"] = int(exit_file.read_text().strip() or "0")
            except ValueError:
                meta["exit_code"] = None
        runs = sorted(p for p in (logs / "jevcode" / "runs").glob("*") if p.is_dir()) if (logs / "jevcode" / "runs").is_dir() else []
        if not runs:
            runs = sorted(p for p in (logs / "jevcode").glob("*") if (p / "state.json").is_file())
        if not runs:
            context.metadata = meta
            return
        run = runs[-1]
        n_in = n_out = n_cache = 0
        for line in _jsonl(run / "generator.jsonl"):
            usage = line.get("usage") or {}
            n_in += int(usage.get("inputTokens", 0) or 0)
            n_out += int(usage.get("outputTokens", 0) or 0)
            n_cache += int(usage.get("cacheReadTokens", 0) or 0)
        jev_in = jev_out = 0
        for line in _jsonl(run / "jev.jsonl"):
            usage = line.get("usage") or {}
            jev_in += int(usage.get("inputTokens", 0) or 0)
            jev_out += int(usage.get("outputTokens", 0) or 0)
        state: dict[str, Any] = {}
        try:
            envelope = json.loads((run / "state.json").read_text())
            state = envelope.get("state", envelope) if isinstance(envelope, dict) else {}
        except (OSError, ValueError):
            state = {}
        spend = state.get("spend") or {}
        context.n_input_tokens = n_in + jev_in
        context.n_output_tokens = n_out + jev_out
        context.n_cache_tokens = n_cache
        context.cost_usd = float(spend.get("totalUsd", 0.0) or 0.0)
        counters = state.get("counters") or {}
        meta.update(
            {
                "run_id": run.name,
                "steps": state.get("step"),
                "stopReason": state.get("stopReason"),
                "loops": counters.get("loops"),
                "reviews": counters.get("reviews"),
                "blocked": counters.get("blocked"),
                "declined": counters.get("declined"),
                "generator_tokens": {"input": n_in, "output": n_out},
                "jev_tokens": {"input": jev_in, "output": jev_out},
                "resolvedJevModel": state.get("resolvedJevModel"),
            }
        )
        context.metadata = meta


def _jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for raw in path.read_text().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out
