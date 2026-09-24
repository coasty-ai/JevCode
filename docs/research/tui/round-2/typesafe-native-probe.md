# TypeSafe native decisions API — live probe (2026-09-21, key from `.env`, never printed)

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <TYPESAFE_API_KEY>`, body `{ model, state, questions }`
(the same body JevCode sends to OpenRouter's decisions router). One Noul question over `{ message: "hi" }`, one request
per model id, from a Mac in California:

| `model` sent | HTTP | latency | served `model` | `usage` | answer |
| --- | --- | --- | --- | --- | --- |
| `jev-1.13` | 400 `{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev-1.13"}}` | 194 ms | – | – | – |
| `typesafe/jev-1.13` | 400 `Unknown model: typesafe/jev-1.13` | 148 ms | – | – | – |
| `jev-1.13-20260917` | 400 `Unknown model: jev-1.13-20260917` | 48 ms | – | – | – |
| `jev-latest` | 200 | 109 ms | `jev-1.13.0` | `{"input_tokens":319,"output_tokens":23}` (no `cost`) | `{"type":"noul","noul":0.99}` |
| `jev-1.13.0` | 200 | 112 ms | `jev-1.13.0` | `{"input_tokens":319,"output_tokens":23}` | `{"type":"noul","noul":0.99}` |

Consequences for the provider layer (docs/TUI-DESIGN-2.md §2):

- Model ids differ per provider: OpenRouter accepts `typesafe/jev-1.13`, `typesafe/jev-1.13-20260917`, `jev-1.13`;
  the native API accepts TypeSafe's own versioned id `jev-1.13.0` and the alias `jev-latest` only. The pinned default
  for the native provider is therefore `jev-1.13.0` (`jev-latest` is an alias and must trigger the same "pin it"
  warning as `typesafe/jev-1.13` does on OpenRouter). Cross-provider id mapping: `typesafe/jev-1.13-20260917` ↔
  `jev-1.13.0` are the same weights (REPORT §1: the dated OpenRouter id and TypeSafe's `jev-1.13.0`); the drift check
  must compare within one provider's naming and treat `jev-1.13.0` as the resolution of `jev-latest`.
- Unknown-model errors are HTTP **400** with `detail.error_type: "api_usage_error"` (REPORT said 422 for validation
  errors; that applies to malformed bodies). The client must surface `detail.message` (redacted) as a `ConfigError`
  on the decider model, exit 2, on the first call.
- `usage.cost` is absent: cost = `input_tokens × 0.042 / 1e6` USD (output free; REPORT §1 and the cookbook constant
  `TYPESAFE_PRICE = (0.042, 0.00)`), marked as table-priced (`~`) in the UI.
- `x-typesafe-request-id` is present on every response (success and error); log it redacted like OpenRouter's
  `x-generation-id`.
- Latency ≈ 110 ms per request against ≈ 237 ms p50 through OpenRouter in the 30-task run, so the native provider
  should be the default whenever `TYPESAFE_API_KEY` is configured (owner decision D-B).
