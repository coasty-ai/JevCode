# Research archive

**Historical.** These 73 files are dated notes taken while the project was being built, between 2026-09-19 and
2026-09-22. Every external claim in them carries its source URL and the date it was fetched. **None of them
describes current behaviour**, and several record decisions that were later reversed.

They are kept because the design documents cite them and because a claim with a fetch date beside it is worth
more than the same claim without one. Version numbers, prices and API shapes in these files were true on the
date each file gives and have not been re-checked since.

If you want what the system does now, read the [design documents](../design/README.md) or the
[measurements](../measurements/README.md).

A synthesis of the nine foundation surveys — with the pins chosen, the formats adopted, the adopt/reject list
and the open questions — is [`docs/RESEARCH.md`](../RESEARCH.md).

## Foundation surveys (9 files, fetched 2026-09-19)

| File | What it established |
| --- | --- |
| [`01-ink-stack.md`](01-ink-stack.md) | the terminal-rendering library: version, peer requirements, minimum Node, and locally measured render costs |
| [`02-swebench-verified.md`](02-swebench-verified.md) | the SWE-bench Verified dataset, its official harness, its prediction and result formats |
| [`03-terminal-bench.md`](03-terminal-bench.md) | Terminal-Bench: version, task format and how a custom agent plugs into its runner |
| [`04-benchmarks-and-harnesses.md`](04-benchmarks-and-harnesses.md) | which benchmarks actually test long-horizon coding work, and what published harnesses do |
| [`05-cli-architectures.md`](05-cli-architectures.md) | how three shipped coding CLIs are structured and how they stay fast at startup |
| [`06-jev-shapes-and-question-design.md`](06-jev-shapes-and-question-design.md) | the decision API's wire shapes verified live, its confidence arithmetic, and the rules for writing a question |
| [`07-generator-apis.md`](07-generator-apis.md) | the two generator APIs: request shapes, tool calling, streaming, and their error surfaces |
| [`08-node-toolchain.md`](08-node-toolchain.md) | the Node and TypeScript toolchain for a strict ESM command-line program |
| [`09-edit-formats-and-sandboxing.md`](09-edit-formats-and-sandboxing.md) | which edit format a model produces most reliably, and how to sandbox a subprocess on macOS without Docker |

## Terminal-interface research (51 files, 2026-09-20 to 2026-09-22)

Five rounds. Each round researched its topics first, then designed, then built.

### Round 1 — the survey (21 files)

| File | Topic |
| --- | --- |
| [`tui/00-SUMMARY.md`](tui/00-SUMMARY.md) | the synthesis of files 01–17 and 19 |
| [`tui/01-opencode.md`](tui/01-opencode.md) | the primary interface inspiration, read in detail |
| [`tui/02-claude-code.md`](tui/02-claude-code.md) | one shipped agent CLI's terminal conventions |
| [`tui/03-gemini-cli.md`](tui/03-gemini-cli.md) | a second, as a reference implementation |
| [`tui/04-codex-cli.md`](tui/04-codex-cli.md) | a third, written in Rust — what carries over to a Node interface and what does not |
| [`tui/05-other-agent-tuis.md`](tui/05-other-agent-tuis.md) | conventions and performance lessons from the rest of the field |
| [`tui/06-tui-conventions.md`](tui/06-tui-conventions.md) | interaction and visual conventions from the best terminal programs generally |
| [`tui/07-terminal-protocols-edge-cases.md`](tui/07-terminal-protocols-edge-cases.md) | every terminal edge case a chat interface must survive |
| [`tui/08-ink7-internals.md`](tui/08-ink7-internals.md) | the rendering library's internals for a composer and a scrolling transcript |
| [`tui/09-packaging-distribution.md`](tui/09-packaging-distribution.md) | packaging, installation and startup cost |
| [`tui/10-sessions-and-multiturn.md`](tui/10-sessions-and-multiturn.md) | session and multi-turn semantics, mapped onto the run and checkpoint model |
| [`tui/11-jev-native-ui.md`](tui/11-jev-native-ui.md) | how to surface calibrated decisions, risk, plans and search progress |
| [`tui/12-accessibility-robustness-testing.md`](tui/12-accessibility-robustness-testing.md) | accessibility, internationalisation, robustness and the testing strategy |
| [`tui/13-first-run-onboarding-without-keys-in-tui.md`](tui/13-first-run-onboarding-without-keys-in-tui.md) | first run with no keys: in-interface key entry, provider setup, workspace trust |
| [`tui/14-cost-guardrails-for-an-interactive-multi.md`](tui/14-cost-guardrails-for-an-interactive-multi.md) | cost guardrails for an interactive session that can start many runs |
| [`tui/15-git-state-awareness-diff-format-and-undo.md`](tui/15-git-state-awareness-diff-format-and-undo.md) | git-state awareness, the diff format, and undo safety |
| [`tui/16-secrets-typed-or-pasted-into-the-compose.md`](tui/16-secrets-typed-or-pasted-into-the-compose.md) | secrets typed or pasted into the composer: pre-submit checks, mention denylist, clipboard |
| [`tui/17-error-provider-failure-and-crash-ux-plus.md`](tui/17-error-provider-failure-and-crash-ux-plus.md) | error, provider-failure and crash experience, and where logs live |
| [`tui/19-reverification.md`](tui/19-reverification.md) | twelve claims from the synthesis re-checked against primary sources |
| [`tui/20-pty-driver-findings.md`](tui/20-pty-driver-findings.md) | what the generic pseudo-terminal driver measured, 2026-09-20 |
| [`tui/terminal-matrix.md`](tui/terminal-matrix.md) | the terminal-by-terminal support matrix and checklist |

### Round 1 — competing designs and their judgements (7 files)

| File | Topic |
| --- | --- |
| [`tui/designs/composer-first.md`](tui/designs/composer-first.md) | design: the composer is the whole surface |
| [`tui/designs/jev-native.md`](tui/designs/jev-native.md) | design: build the interface around calibrated decisions |
| [`tui/designs/minimal-robust.md`](tui/designs/minimal-robust.md) | design: minimal surface, robustness first |
| [`tui/designs/sessions-long-horizon.md`](tui/designs/sessions-long-horizon.md) | design: sessions and long-horizon work |
| [`tui/designs/judge-engineering.md`](tui/designs/judge-engineering.md) | judgement of all four, engineering-feasibility lens |
| [`tui/designs/judge-safety.md`](tui/designs/judge-safety.md) | judgement of all four, safety and edge-case lens |
| [`tui/designs/judge-ux.md`](tui/designs/judge-ux.md) | judgement of all four, experience-quality lens |

### Round 2 (3 files)

| File | Topic |
| --- | --- |
| [`tui/round-2/design-conversation.md`](tui/round-2/design-conversation.md) | conversation, defaults and providers |
| [`tui/round-2/design-visual.md`](tui/round-2/design-visual.md) | visual and motion design |
| [`tui/round-2/typesafe-native-probe.md`](tui/round-2/typesafe-native-probe.md) | a live probe of the decision provider's native endpoint |

### Round 3 (5 files)

| File | Topic |
| --- | --- |
| [`tui/round-3/theme.md`](tui/round-3/theme.md) | the colour theme, derived from the brand and applied everywhere |
| [`tui/round-3/wordmark.md`](tui/round-3/wordmark.md) | the persistent animated wordmark and its frame budget |
| [`tui/round-3/onboarding.md`](tui/round-3/onboarding.md) | one-key onboarding for the default mode |
| [`tui/round-3/commands.md`](tui/round-3/commands.md) | the slash-command audit and the shortcut design |
| [`tui/round-3/polish.md`](tui/round-3/polish.md) | readability and animation polish |

### Round 4 (8 files)

| File | Topic |
| --- | --- |
| [`tui/round-4/pinned-header.md`](tui/round-4/pinned-header.md) | the pinned-header architectures, with a probe of each |
| [`tui/round-4/resize-robustness.md`](tui/round-4/resize-robustness.md) | resize and terminal robustness |
| [`tui/round-4/command-output-style.md`](tui/round-4/command-output-style.md) | one grammar for command output |
| [`tui/round-4/palette-enter-cycling.md`](tui/round-4/palette-enter-cycling.md) | Enter as the primary palette key, and the navigation model that follows |
| [`tui/round-4/conversation-edge-cases.md`](tui/round-4/conversation-edge-cases.md) | the conversation, intake and history surface |
| [`tui/round-4/file-edit-display.md`](tui/round-4/file-edit-display.md) | the file-edit surface |
| [`tui/round-4/production-hardening.md`](tui/round-4/production-hardening.md) | production hardening: what fails quietly and how it is made loud |
| [`tui/round-4/integration-drives/README.md`](tui/round-4/integration-drives/README.md) | the recorded integration drives that closed the round |

Round 4 also keeps its raw captures: pseudo-terminal recordings, timing files and the probe scripts that
produced them, under `tui/round-4/`. They are evidence for the reports above, not documentation.

### Round 5 (7 files)

| File | Topic |
| --- | --- |
| [`tui/round-5/00-contract-digest.md`](tui/round-5/00-contract-digest.md) | the interface surface implied by three concurrent harness designs |
| [`tui/round-5/10-coordination-surface.md`](tui/round-5/10-coordination-surface.md) | the coordination surface: peers, pause, resume, end |
| [`tui/round-5/11-context-meter-compaction.md`](tui/round-5/11-context-meter-compaction.md) | the context meter and the compaction interface |
| [`tui/round-5/12-agent-tree.md`](tui/round-5/12-agent-tree.md) | the agent-tree and control surface |
| [`tui/round-5/13-import-surface.md`](tui/round-5/13-import-surface.md) | the import surface |
| [`tui/round-5/14-provider-model-picker.md`](tui/round-5/14-provider-model-picker.md) | the provider picker, the model picker and key setup |
| [`tui/round-5/15-edge-matrix-and-tests.md`](tui/round-5/15-edge-matrix-and-tests.md) | the cross-cutting edge matrix and the test plan |

## Adversarial code reviews and one analysis (13 files, 2026-09-21 to 2026-09-22)

Each of these was written by someone told to assume the work was wrong and try to prove it. They are kept
because several of them changed what shipped — a pool-suspicion signal was withdrawn, a bound was corrected,
and a "byte-identical" claim was withdrawn as false because a review measured it.

| File | Subject |
| --- | --- |
| [`llm-jev/oos-analysis-2026-09-22.md`](llm-jev/oos-analysis-2026-09-22.md) | not a review: where the out-of-sample wall and dollars actually went, over 44 runs |
| [`llm-jev/review-oos-iter-1-2026-09-22.md`](llm-jev/review-oos-iter-1-2026-09-22.md) | the first round of changes written against that analysis |
| [`llm-jev/review-oos-iter-3-2026-09-22.md`](llm-jev/review-oos-iter-3-2026-09-22.md) | the third round — 16 findings, one of which killed a shipped signal |
| [`llm-jev/review-oos-iter-4-2026-09-22.md`](llm-jev/review-oos-iter-4-2026-09-22.md) | the fourth round, re-checked against its own fix pass |
| [`coordination/review-2026-09-21.md`](coordination/review-2026-09-21.md) | the coordination design, revision 2.1 |
| [`coordination/re-review-blockers-2026-09-21.md`](coordination/re-review-blockers-2026-09-21.md) | the seven blockers from that review, re-checked at revision 3 |
| [`coordination/re-check-rev4-2026-09-21.md`](coordination/re-check-rev4-2026-09-21.md) | the remaining partial findings, re-checked at revision 4 |
| [`coordination/re-check-ledger-2026-09-22.md`](coordination/re-check-ledger-2026-09-22.md) | the coordination implementation, read-only |
| [`coordination/peer-hunks-r5-2026-09-22.md`](coordination/peer-hunks-r5-2026-09-22.md) | what one round's interface work needed from harness-owned files |
| [`orchestration/review-planner-2026-09-22.md`](orchestration/review-planner-2026-09-22.md) | the orchestration planner, read-only and traced |
| [`orchestration/review-engine-2026-09-22.md`](orchestration/review-engine-2026-09-22.md) | the orchestration engine |
| [`import/review-engine-2026-09-22.md`](import/review-engine-2026-09-22.md) | the import engine, read-only |
| [`context-policy/review-2026-09-22.md`](context-policy/review-2026-09-22.md) | the context policy |

## Related

- [`docs/RESEARCH.md`](../RESEARCH.md) — the synthesis of the nine foundation surveys.
- [Normative design documents](../design/README.md) — what was built from all of this.
- [History](../history/README.md) — the round-by-round build record.
