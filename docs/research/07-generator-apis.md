# 07 - Generator LLM APIs (Anthropic Messages + OpenRouter chat completions) for Claude Sonnet 5

Research date: 2026-09-19. All fetches below were made on 2026-09-19 unless stated. Scope: what JevCode's generator client must send/parse when calling both APIs directly with `fetch` (no SDKs). Live probes were run with `node --env-file=.env` scripts that print only redacted output; total live spend was well under $0.01 (three Sonnet 5 calls capped at 8-60 output tokens, one Jev decision, one free Models GET).

Local-notes caveat: `<research-notes>/or-decisions.html` (99,144 bytes) is a saved Next.js 404 shell (`<html id="__next_error__">`, `noindex`), byte-for-byte the same size as the live 404 at `https://openrouter.ai/docs/api-reference/decisions` fetched 2026-09-19. It contains no API content. The substantive local notes are `jev-research/REPORT.md` and `jev-research/clean/api.md`; the comparison in section 3 is against those.

---

## 1. Anthropic Messages API (direct)

### 1.1 Endpoint, headers, body

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` | https://platform.claude.com/docs/en/api/messages (fetched 2026-09-19) |
| Header `x-api-key` | your key | same |
| Header `anthropic-version` | `2023-06-01` (the SDK default; "The SDK automatically sends the `anthropic-version` header set to `2023-06-01`") | https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript (2026-09-19) |
| Header `content-type` | `application/json` | https://platform.claude.com/docs/en/api/messages (2026-09-19) |
| Header `anthropic-beta` | only for beta features (none needed for anything in this file) | same |
| Response header `request-id` | e.g. `req_011CfDvcnay8azepbdSioxW2` (also `request_id` in error bodies) | https://platform.claude.com/docs/en/api/errors (2026-09-19); live probe 2026-09-19 |

Request body fields (https://platform.claude.com/docs/en/api/messages, 2026-09-19): required `model`, `max_tokens`, `messages` (array of `{role, content}`); optional `system` (string or array of text blocks), `tools`, `tool_choice` (`{type: auto|any|tool|none}`), `stream` (bool), `metadata` (`{user_id}`), `stop_sequences`, `output_config` (`{format, effort}`), `cache_control` (top-level), `thinking`, `service_tier`, `inference_geo`. `temperature`, `top_p` and `top_k` are all marked **Deprecated** on the reference page ("Models released after Claude Opus 4.6 do not support setting temperature. A value of 1.0 will be accepted for backwards compatibility"; `top_p`: "A value >= 0.99 will be accepted for backwards compatibility, all other values will be rejected with a 400 error"; `top_k`: "any value will be rejected with a 400 error" - https://platform.claude.com/docs/en/api/messages.md, 2026-09-19), and on Sonnet 5 "Setting `temperature`, `top_p`, or `top_k` to non-default values returns a 400 error" (https://platform.claude.com/docs/en/models/sonnet-5/overview, 2026-09-19). Do not send sampling params.

Response object: `id`, `type: "message"`, `role: "assistant"`, `content[]` (blocks: `text`, `tool_use`, `thinking`...), `model`, `stop_reason` (documented enum: `end_turn` | `max_tokens` | `stop_sequence` | `tool_use` | `pause_turn` | `refusal` | `model_context_window_exceeded`; "In streaming mode, it is null in the `message_start` event and non-null otherwise" - https://platform.claude.com/docs/en/api/messages.md, 2026-09-19), `stop_sequence`, `usage`, `stop_details`, `container` (https://platform.claude.com/docs/en/api/messages, 2026-09-19; live probe 2026-09-19 showed `stop_details: null`, `container: null`).

### 1.2 Model id, limits, pricing for Claude Sonnet 5

| Item | Value | Source |
|---|---|---|
| Model id (only form) | `claude-sonnet-5` - "Every Claude model ID is a pinned snapshot, including the dateless IDs used from the 4.6 generation on." The alias row repeats `claude-sonnet-5`. | https://platform.claude.com/docs/en/about-claude/models/overview (2026-09-19; resolves with a redirect to https://platform.claude.com/docs/en/models/overview) |
| Dated id | **does not exist**: live `POST` with `claude-sonnet-5-20260630` -> `404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5-20260630"}}` | live probe 2026-09-19; re-confirmed by fact-check with the free `GET /v1/models/claude-sonnet-5-20260630` -> same 404 body (2026-09-19) |
| Released | June 30, 2026 (Models API `created_at: "2026-06-29T00:00:00Z"`) | https://platform.claude.com/docs/en/models/sonnet-5/overview (2026-09-19); live `GET /v1/models/claude-sonnet-5` 2026-09-19 (re-run by fact-check 2026-09-19: `created_at`, `max_input_tokens: 1000000`, `max_tokens: 128000`, `capabilities.thinking.types.enabled.supported: false`, `adaptive.supported: true`, effort `low..max` all confirmed) |
| Context window | 1,000,000 tokens (`max_input_tokens: 1000000`) | same two sources |
| Max output | 128,000 tokens (`max_tokens: 128000`); 300K on Batches with beta `output-300k-2026-03-24` | same |
| Input / output price | $2 / MTok input, $10 / MTok output ("introductory pricing ... is now the standard price. The previously scheduled increase to $3/$15 ... on September 1, 2026 will not occur.") | https://platform.claude.com/docs/en/about-claude/pricing (2026-09-19) |
| Cache write 5m / 1h | $2.50 / $4 per MTok (1.25x / 2x) | same |
| Cache read | $0.20 / MTok (0.1x) | same |
| Batch | $1 / $5 per MTok (50% off) | same |
| Long context | "Claude 4.6 and later models ... include the full 1M token context window at standard pricing" (no >200K premium) | same |
| Tool-use system prompt overhead | 354 tokens (`auto`/`none`), 474 (`any`/`tool`) | same |
| Thinking | adaptive on by default; `thinking: {type:"enabled", budget_tokens}` -> 400; effort `low|medium|high|xhigh|max`, default `high` | https://platform.claude.com/docs/en/models/sonnet-5/overview (2026-09-19); live Models API `capabilities.thinking.types.enabled.supported: false, adaptive.supported: true` |
| Tokenizer | "Claude 4.7 and later models ... newer tokenizer ... approximately 30% more tokens for the same text" | https://platform.claude.com/docs/en/about-claude/pricing (2026-09-19) |
| Retirement | not sooner than June 30, 2027 | https://platform.claude.com/docs/en/models/sonnet-5/overview (2026-09-19) |

Other current Anthropic ids (same overview page, 2026-09-19): `claude-fable-5-1` ($10/$50), `claude-opus-5` ($5/$25), `claude-haiku-4-5` alias -> `claude-haiku-4-5-20251001` ($1/$5, 200K ctx, 64K out).

### 1.3 Streaming SSE (`"stream": true`)

Format: `event: <name>\ndata: <json>\n\n`; each data object carries the same `type`. "new event types may be added, and your code should handle unknown event types gracefully." (https://platform.claude.com/docs/en/build-with-claude/streaming, 2026-09-19)

| Event | Data shape (verbatim from docs / live probe) |
|---|---|
| `message_start` | `{"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"stop_sequence":null,"stop_details":null,"container":null,"usage":{"input_tokens":475,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":16,"service_tier":"standard","inference_geo":"global"}}}` (live 2026-09-19) |
| `content_block_start` | `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` or `{"type":"tool_use","id":"toolu_...","name":"run_shell","input":{},"caller":{"type":"direct"}}` (live) |
| `ping` | `{"type": "ping"}` - "There may be `ping` events dispersed throughout the response" |
| `content_block_delta` text | `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}` |
| `content_block_delta` tool input | `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}` - first delta may be `partial_json: ""`; concatenate all, `JSON.parse` on `content_block_stop` |
| `content_block_delta` thinking | `thinking_delta` (`thinking`), `signature_delta` (`signature`); with default `display: "omitted"` on Sonnet 5 the thinking text is empty |
| `content_block_stop` | `{"type":"content_block_stop","index":0}` |
| `message_delta` | `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"container":null},"usage":{"input_tokens":475,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":51,"output_tokens_details":{"thinking_tokens":0}}}` (live 2026-09-19) - **final usage lives here** |
| `message_stop` | `{"type":"message_stop"}` |
| `error` | `event: error` / `data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}` - "an error can occur after the API returns a 200 response" (https://platform.claude.com/docs/en/api/errors, 2026-09-19) |

Live sequence observed (Sonnet 5, one tool call): `message_start > content_block_start > ping > content_block_delta x4 > content_block_stop > message_delta > message_stop`. Note the raw `data:` lines have trailing whitespace padding after the JSON (e.g. `...}         }` is actually `{...}` followed by spaces) - trim before parsing. "Current models only support emitting one complete key and value property from `input` at a time" unless `eager_input_streaming: true` is set on the tool (https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming, 2026-09-19).

### 1.4 Usage object

Fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, plus `service_tier`, `inference_geo`, `output_tokens_details.thinking_tokens` (live 2026-09-19). "`input_tokens`: Tokens after the last cache breakpoint"; `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens` (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, 2026-09-19). Cost per step = `input*2 + cache_creation_5m*2.5 + cache_creation_1h*4 + cache_read*0.2 + output*10` (all per MTok, Sonnet 5).

### 1.5 Errors and status codes

Shape (https://platform.claude.com/docs/en/api/errors, 2026-09-19): `{"type":"error","error":{"type":"not_found_error","message":"..."},"request_id":"req_..."}`; some 429s add `error.details.error_code` (e.g. `enforced_spend_limit_reached`, https://platform.claude.com/docs/en/api/rate-limits, 2026-09-19).

| Status | `error.type` | Retry? |
|---|---|---|
| 400 | `invalid_request_error` (also spend-limit-you-set) | no |
| 401 | `authentication_error` | no |
| 402 | `billing_error` | no |
| 403 | `permission_error` | no |
| 404 | `not_found_error` | no |
| 409 | `conflict_error` | yes (SDKs retry) |
| 413 | `request_too_large` (Messages max 32 MB) | no |
| 429 | `rate_limit_error` - honour `retry-after`; spend-cap 429 has **no** `retry-after` and "keeps failing until access resumes" | yes if `retry-after` present |
| 500 | `api_error` - "Retry the request with exponential backoff" | yes |
| 504 | `timeout_error` - use streaming | yes |
| 529 | `overloaded_error` - "temporarily overloaded" | yes |

### 1.6 Rate-limit headers (https://platform.claude.com/docs/en/api/rate-limits, 2026-09-19; all seen live 2026-09-19)

`retry-after` (seconds; "Earlier retries will fail"), `anthropic-ratelimit-requests-{limit,remaining,reset}`, `anthropic-ratelimit-input-tokens-{limit,remaining,reset}`, `anthropic-ratelimit-output-tokens-{limit,remaining,reset}`, `anthropic-ratelimit-tokens-{limit,remaining,reset}` (most restrictive limit in effect). `*-reset` is RFC 3339. Token bucket. Only `input_tokens + cache_creation_input_tokens` count toward ITPM; `cache_read_input_tokens` do not. Sonnet 5 has its own bucket (not shared with Sonnet 4.x). Standard tiers for Sonnet 5: Start 1,000 RPM / 2M ITPM / 400K OTPM; Build 5,000 / 5M / 1M; Scale 10,000 / 10M / 2M. Live probe showed this org at 10,000 RPM / 10M ITPM / 2M OTPM (Scale tier values).

### 1.7 Prompt caching basics (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, 2026-09-19)

- Syntax: `"cache_control": {"type": "ephemeral"}` (5m default) or `{"type": "ephemeral", "ttl": "1h"}`. Place on the last `tools[]` entry, on `system[]` text blocks, on `messages[].content[]` blocks, or once at the **top level of the request body** (automatic caching: "Breakpoint automatically moves to the last cacheable block in each request").
- Max 4 explicit breakpoints per request (top-level auto-caching consumes one).
- Minimum cacheable prefix on Sonnet 5: **1,024 tokens** (Opus 5 / Fable 5.1: 512; Haiku 4.5: 4,096). Shorter prefixes silently do not cache (both cache fields = 0).
- Prefix order and invalidation: `tools` -> `system` -> `messages`; changing tool definitions invalidates everything; changing `tool_choice` or adding/removing images invalidates messages only; cache lookback is 20 blocks back from each breakpoint (consecutive tool blocks count as one).
- Cache lifetime is measured from the start of the request; 5m entries refresh free on each hit. Pre-warm with `max_tokens: 0` (non-streaming only).
- Recommended JevCode layout for flat tokens/step: frozen system prompt + deterministic tool list first (breakpoint on last tool and/or system block), `cache_control` top-level auto mode so the growing transcript is cached turn over turn; verify `usage.cache_read_input_tokens > 0` from turn 2.

---

## 2. OpenRouter chat completions (direct)

### 2.1 Endpoint, headers

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST https://openrouter.ai/api/v1/chat/completions` | https://openrouter.ai/docs/api-reference/chat-completion (2026-09-19) |
| `Authorization` | `Bearer <OPENROUTER_API_KEY>` | same |
| `Content-Type` | `application/json` | same |
| `HTTP-Referer` | "identifies your app's URL and is used as the primary identifier for rankings ... This header is required for app attribution. Without it, no app page will be created." | https://openrouter.ai/docs/app-attribution (2026-09-19) |
| `X-OpenRouter-Title` | "sets or modifies your app's display name in rankings and analytics"; "`X-Title` is still supported for backwards compatibility" | same |
| `X-OpenRouter-Metadata: enabled` | optional routing metadata on responses | https://openrouter.ai/docs/api-reference/chat-completion (2026-09-19) |
| Response headers | no rate-limit headers on 200 (live 2026-09-19: only `content-type`, `cf-ray`); "Successful inference responses do not include `X-RateLimit-*` headers"; on an OpenRouter platform-limit 429 "the error response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`", and `Retry-After` only "when every attempted provider returned a retry hint" | https://openrouter.ai/docs/api-reference/limits (2026-09-19; resolves to https://openrouter.ai/docs/api_reference/limits) |

### 2.2 Body

From the OpenAPI source https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md (2026-09-19): `messages` (required), `model`, `models[]` (fallback list), `stream`, `stream_options.include_usage` ("Deprecated: This field has no effect. Full usage details are always included."), `max_tokens` ("deprecated, use max_completion_tokens ... some providers enforce a minimum of 16"), `max_completion_tokens`, `temperature`, `top_p`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `reasoning` (`{effort}`), `provider` (ProviderPreferences), `route`, `transforms`, `plugins`, `user` (<=256 chars), `session_id` (<=256), `metadata`. `usage: {include: true}`: "deprecated and have no effect" - usage is always returned (https://openrouter.ai/docs/use-cases/usage-accounting, 2026-09-19); live non-stream call without it still returned `usage.cost`.

`provider` object (https://openrouter.ai/docs/features/provider-routing, 2026-09-19): `order: string[]`, `allow_fallbacks: boolean` (default true), `require_parameters: boolean` (default false), `data_collection: "allow"|"deny"` (default allow), `only: string[]`, `ignore: string[]`, `quantizations: string[]`, `sort: string|object`, `max_price: {prompt, completion, request, image}` (`prompt`/`completion` in USD per M tokens, `request` per request, `image` per image; no `audio` attribute is documented - https://openrouter.ai/docs/guides/routing/provider-selection.md, 2026-09-19), `zdr: boolean`, `preferred_min_throughput`, `preferred_max_latency` (seconds, p50). Suffixes `:nitro` (sort by throughput), `:floor` (sort by price). Default routing: "select one weighted by inverse square of the price" among stable providers. Live 2026-09-19: `provider: {order: ["anthropic"]}` routed to `"provider": "Anthropic"`; without it the stream went to `"provider": "Claude Platform on AWS"`. For reproducible benchmarking pin `provider: {order: ["anthropic"], allow_fallbacks: false}` or use `require_parameters: true` with `tools`.

Anthropic-specific note (OpenRouter, Sonnet 5 endpoints list, https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5/endpoints, 2026-09-19): 10 endpoints (Anthropic, Claude Platform on AWS, Azure us/global, Google Vertex global/us/europe, Amazon Bedrock global/us-east-1/eu-west-1); regional Bedrock/Vertex endpoints price at $2.20/$11 (1.1x). Anthropic endpoint `supported_parameters`: `max_tokens, stop, reasoning, include_reasoning, tools, tool_choice, structured_outputs, response_format, verbosity, reasoning_effort` (no `temperature`).

### 2.3 Streaming SSE format (https://openrouter.ai/docs/api_reference/streaming.md, 2026-09-19; confirmed live 2026-09-19)

- Lines are `data: <json>`; terminator `data: [DONE]`.
- Keep-alive comment lines `: OPENROUTER PROCESSING` "can be safely ignored per the SSE specs" - skip any line starting with `:` before `JSON.parse` (seen live).
- Chunk: `{"id":"gen-1789872345-...","object":"chat.completion.chunk","created":1789872345,"model":"anthropic/claude-sonnet-5","provider":"Claude Platform on AWS","choices":[{"index":0,"delta":{"content":"I","role":"assistant"},"finish_reason":null,"native_finish_reason":null}]}` (live).
- Tool call delta (live): `"delta":{"content":null,"role":"assistant","tool_calls":[{"index":0,"id":"toolu_0125GNipsBQ4h2wxuQwk6gsg","type":"function","function":{"name":"run_shell","arguments":""}}]}`; subsequent chunks carry `arguments` fragments keyed by `tool_calls[].index`; concatenate per index.
- Terminal: `finish_reason` normalized to `stop | length | tool_calls | content_filter | error`; `native_finish_reason` is the raw provider value (live: `"finish_reason":"length","native_finish_reason":"max_tokens"`).
- Final usage chunk: "every stream ends with an extra chunk that carries the `usage` object ... sent just before the `[DONE]` message ... the terminal `finish_reason` appears twice ... treat the usage chunk as an accounting frame rather than a second terminal event." Live: `"usage":{"prompt_tokens":444,"completion_tokens":40,"total_tokens":484,"cost":0.001288,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.001288,"upstream_inference_prompt_cost":0.000888,"upstream_inference_completions_cost":0.0004},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}}`.
- Mid-stream errors: HTTP stays 200; a `data:` chunk carries top-level `error: {code, message, metadata: {error_type, ...}}` and `choices[0].finish_reason: "error"` (https://openrouter.ai/docs/api_reference/errors-and-debugging.md, 2026-09-19).
- Cancellation: aborting the connection stops billing on supported providers (Anthropic listed as supported).

`usage` schema (ChatUsage, OpenAPI 2026-09-19): required `prompt_tokens`, `completion_tokens`, `total_tokens`; optional `cost` (USD, "number | null"), `cost_details {upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost}`, `is_byok`, `prompt_tokens_details {cached_tokens, cache_write_tokens, audio_tokens, video_tokens}`, `completion_tokens_details {reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens}`, `server_tool_use_details`. Note the live 11-token/5-token call cost `0.000072` = 11*2e-6 + 5*1e-5, matching list price exactly (no OpenRouter markup on the token rate).

### 2.4 Errors and status codes (https://openrouter.ai/docs/api_reference/errors-and-debugging.md, 2026-09-19)

Shape: `{"error":{"code":<http status>,"message":"...","metadata":{...}}}` (live 400/401 bodies also had a top-level `user_id`). "The HTTP status matches the error code unless processing has begun."

| Status | Meaning (verbatim) | `error.metadata.error_type` | Retry? |
|---|---|---|---|
| 400 | "Bad Request (invalid or missing params, CORS)" | `invalid_request`, `invalid_prompt`, `context_length_exceeded`, `string_too_long` | no |
| 401 | "Invalid credentials (OAuth session expired, disabled/invalid API key)" (live: `{"error":{"message":"User not found.","code":401}}`) | `authentication` | no |
| 402 | "Your account or API key has insufficient credits. Add more credits and retry the request." Check `error.metadata.limit_source`; only `openrouter_in_flight_budget` 402s carry `Retry-After` | `payment_required` | only if `Retry-After` |
| 403 | "insufficient permissions, guardrail block, or moderation flag" | `permission_denied`, `content_policy_violation`, `refusal` | no |
| 408 | "Your request timed out" | - | yes |
| 429 | "You are being rate limited" - `Retry-After` header | `rate_limit_exceeded` | yes |
| 502 | "Your chosen model is down or we received an invalid response from it" | `provider_unavailable` | yes (or let `models[]`/fallbacks handle) |
| 503 | "There is no available model provider that meets your routing requirements" - `Retry-After` header | `provider_overloaded` | yes |
| 500 / 504 | server / timeout | `server`, `timeout` | yes |

Live 2026-09-19: bad model id -> `400 {"error":{"message":"anthropic/claude-sonnet-99 is not a valid model ID","code":400}}`.

### 2.5 Claude model ids on OpenRouter (public `GET https://openrouter.ai/api/v1/models`, 447 models, fetched 2026-09-19)

Prices are USD per token as returned in `pricing` (strings). `ctx` = `context_length`, `out` = `top_provider.max_completion_tokens`.

| id | prompt | completion | cache read | cache write 5m / 1h | ctx | out | created (unix) |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5` (canonical `anthropic/claude-sonnet-5-20260630`) | 0.000002 | 0.00001 | 0.0000002 | 0.0000025 / 0.000004 | 1,000,000 | 128,000 | 1782843083 |
| `anthropic/claude-sonnet-5:batch` | 0.000001 | 0.000005 | 0.0000001 | 0.00000125 / 0.000002 | 1,000,000 | 128,000 | 1782843083 |
| `anthropic/claude-opus-5` | 0.000005 | 0.000025 | 0.0000005 | 0.00000625 / 0.00001 | 1,000,000 | 128,000 | 1784912544 |
| `anthropic/claude-fable-5.1` | 0.00001 | 0.00005 | 0.00000025 | 0.0000125 / 0.00002 | 1,000,000 | 128,000 | 1788285838 |
| `anthropic/claude-fable-5` | 0.00001 | 0.00005 | 0.000001 | 0.0000125 / 0.00002 | 1,000,000 | 128,000 | 1781007515 |
| `anthropic/claude-opus-4.8` / `4.7` / `4.6` | 0.000005 | 0.000025 | 0.0000005 | 0.00000625 / 0.00001 | 1,000,000 | 128,000 | - |
| `anthropic/claude-sonnet-4.6` | 0.000003 | 0.000015 | 0.0000003 | 0.00000375 / 0.000006 | 1,000,000 | 128,000 | 1771342990 |
| `anthropic/claude-haiku-4.5` | 0.000001 | 0.000005 | 0.0000001 | 0.00000125 / 0.000002 | 200,000 | 64,000 | 1760547638 |
| `~anthropic/claude-sonnet-latest` / `~anthropic/claude-opus-latest` / `~anthropic/claude-haiku-latest` / `~anthropic/claude-fable-latest` | rolling aliases (tilde prefix); Sonnet-latest priced as Sonnet 5 | | | | | | |

`anthropic/claude-sonnet-5` metadata: `architecture.modality: "text+image+file->text"`, `tokenizer: "Claude"`, `top_provider.is_moderated: true`, `supported_parameters: ["include_reasoning","max_completion_tokens","max_tokens","reasoning","reasoning_effort","response_format","stop","structured_outputs","tool_choice","tools","verbosity"]` (no `temperature`/`top_p`), `reasoning: {mandatory:false, default_enabled:true, supported_efforts:["max","xhigh","high","medium","low"], default_effort:"high"}`, `pricing.web_search: "0.01"`. Older Sonnet 4.5/Sonnet 4 entries carry `pricing.overrides[{min_prompt_tokens:200000, prompt:0.000006,...}]` (long-context premium); Sonnet 5 has **no** override.

`typesafe/jev-1.13` (https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints and `GET /api/v1/models?output_modalities=decisions`, 2026-09-19): **not present in the default `/api/v1/models` list** (only text/image/audio output modalities there); appears via the `output_modalities=decisions` filter. `architecture.modality: "text->decisions"`, `input_modalities: ["text"]`, `output_modalities: ["decisions"]`, `context_length: 32000`, `max_completion_tokens: 28800`, `pricing: {prompt: "0.000000042", completion: "0"}` ($0.042/M input, output free), `supported_parameters: []`, provider `TypeSafe`, endpoint name `TypeSafe | typesafe/jev-1.13-20260917`, `created: 1789689684`. Alias `~typesafe/jev-latest` -> `alias_target.slug: "typesafe/jev-1.13"`. `GET /api/v1/models/typesafe/jev-1.13` (without `/endpoints`) is 404.

---

## 3. OpenRouter `/api/alpha/decisions` docs vs local notes

Docs source: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md (OpenAPI 3.1 fragment, fetched 2026-09-19). The HTML page https://openrouter.ai/docs/api-reference/decisions is a 404 (2026-09-19). The OpenAPI's top-level `servers.url` is `https://openrouter.ai/api/v1` and the path is `/api/alpha/decisions`, so composing against the *top-level* server would wrongly give `/api/v1/api/alpha/decisions`; however the `post` operation carries its own operation-level override `servers: [{url: https://openrouter.ai}]` (line 326-327 of the `.md` fragment, 2026-09-19), so a spec-compliant OpenAPI client composes the right URL. Either way the working URL is **`POST https://openrouter.ai/api/alpha/decisions`** (live 200 on 2026-09-19; `jev-research/REPORT.md` line 30 agrees).

Request (`DecisionsRequest`, required `model`, `state`, `questions`): `state` is `string | object | array`; `questions` is a map id -> question with discriminator `type` in `noul | choice | score`; each question has `instructions` (string|object|array) and `criteria` (noul: `{true, false}` both required if present; choice: map option -> string|object|array|null, required; score: array minItems 1, required). Optional: `provider` (ProviderPreferences), `session_id` (<=256), `user` (<=256), `trace`. Response (`DecisionsResponse`, required `model`, `answers`, `usage`): `answers` map -> `{type:"noul", noul}` | `{type:"choice", choice, confidence?, probabilities?}` | `{type:"score", score, confidence?, legend?, probabilities?}`; `usage {input_tokens, output_tokens, cost?}`; `id` (`gen-dec-...`), `provider`. Documented response statuses on the operation: 200, 400, 401, 402, 403, 404, 413 ("Payload Too Large - Request payload exceeds size limits"), 429 ("Too Many Requests - Rate limit exceeded"), 500, 502, 503 ("Service Unavailable"), 524, 529 ("Provider Overloaded"). The chat-completions operation documents the same set plus 408 and 422 (both OpenAPI fragments, 2026-09-19).

Live 2026-09-19 (one choice question, 356 input tokens): `{"model":"typesafe/jev-1.13-20260917","answers":{"next":{"type":"choice","choice":"edit","probabilities":{"rerun":0.18,"finish":0,"edit":0.82},"confidence":0.73}},"usage":{"input_tokens":356,"output_tokens":39,"cost":0.000014952},"id":"gen-dec-...","provider":"TypeSafe"}`; cost = 356 x 4.2e-8 exactly. Sending `typesafe/jev-1.13` to `/api/v1/chat/completions` -> `400 "typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."`

Comparison with local notes (`jev-research/REPORT.md`, `jev-research/clean/api.md`, dated 2026-09-19): **no drift found**. Same endpoint, same body shape (`model`, `state`, `questions`), same three primitives, same answer fields, same `usage.cost` formula, same dated model id in the response, same 32000 ctx / 28800 max_completion_tokens / 4.2e-8 pricing. New information from the official OpenAPI that the local notes lack: optional `provider`, `session_id`, `user`, `trace` request fields and the documented 413 status. The local notes add measured facts the docs omit (whole-request cap ~65,536 tokens, unknown fields silently ignored, no 429 seen at 128 concurrent).

---

## 4. Recommended request shape for a coding generator with structured actions

**Use native tool calling on both APIs; do not ask for a fenced JSON block.**

Anthropic (https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools and .../handle-tool-calls, 2026-09-19):
- Tool def: `{"name": "^[a-zA-Z0-9_-]{1,128}$", "description": "...", "input_schema": {JSON Schema}, "strict": true, "eager_input_streaming": true, "cache_control"?, "input_examples"?}`. `strict: true` "Guarantees `tool_use.input` validates exactly"; schema needs `additionalProperties: false` and `required`; unsupported: recursive schemas, external `$ref`, numeric/string constraints (https://platform.claude.com/docs/en/build-with-claude/structured-outputs, 2026-09-19). Live 2026-09-19: Sonnet 5 accepted `strict: true` + `additionalProperties: false`.
- `tool_choice`: `{type:"auto"}` (default), `{type:"any"}`, `{type:"tool", name}`, `{type:"none"}`; add `disable_parallel_tool_use: true` to cap at one call. Forced (`any`/`tool`) works on Sonnet 5 with adaptive thinking (only Fable 5.1 / Mythos 5.1 return 400). Changing `tool_choice` invalidates the messages cache but not tools/system.
- Response: `stop_reason: "tool_use"`, blocks `{type:"tool_use", id:"toolu_...", name, input}`; reply with a `user` message whose content starts with `{type:"tool_result", tool_use_id, content: string | blocks[], is_error?: true}` - "tool_result blocks must come FIRST in the content array"; every `tool_use` needs a matching `tool_result` in the very next message. Return **all** parallel results in one user message. Invalid JSON after eager streaming: send `{"INVALID_JSON": "<raw>"}` as `content` with `is_error: true`.
- No prefill on Sonnet 5 ("This model does not support assistant message prefill", 400) so the classic "start the assistant turn with `{`" trick is gone; use tools or `output_config.format: {type:"json_schema", schema}` (`output_format` is deprecated).
- Streaming tool calls: fully supported via `input_json_delta`; with `eager_input_streaming: true` fragments arrive unbuffered/unvalidated (good for streaming a large patch into the TUI), so guard the parse and check `stop_reason === "max_tokens"`.

OpenRouter (https://openrouter.ai/docs/guides/features/tool-calling.md, 2026-09-19):
- Tool def: `{"type":"function","function":{"name","description","parameters":{JSON Schema}}}`; `tool_choice`: `"auto" | "none" | "required" | {"type":"function","function":{"name"}}` (the Client Tools guide shows only `auto`, `none` and the named-function form; `required` comes from the OpenAPI `ChatToolChoice` schema at https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md, 2026-09-19); `parallel_tool_calls: false` to force one call ("default is true for most models").
- Response: `finish_reason: "tool_calls"`, `message.tool_calls[] = {id, type:"function", function:{name, arguments:"<JSON string>"}}`; reply with `{"role":"tool","tool_call_id": id, "content": "<result>"}`. `arguments` is a string - `JSON.parse` it.
- Streaming tool calls: supported; the guide only shows accumulating `data.choices[0].delta.tool_calls` chunks. The finer shape - entries keyed by `index`, first chunk carrying `id`/`name` and `arguments: ""`, later chunks appending `arguments` fragments - is a live observation (2026-09-19 against Sonnet 5), not a documented contract. No strict/schema-guarantee flag on the OpenAI-style path unless the provider honours `structured_outputs` (Anthropic endpoint lists it in `supported_parameters`). Filter providers with `provider.require_parameters: true` when sending `tools`.

Trade-offs: fenced JSON in free text needs no tool schema and works identically on both APIs, but it costs a regex/brace-matching parser, fails on prose leakage or truncation, cannot be validated server-side, and Sonnet 5 sometimes wraps or comments; native tools give typed `input`/`arguments`, a distinct `stop_reason`/`finish_reason`, parallel calls, and (Anthropic only) `strict` schema guarantees plus cacheable tool definitions (354-token system-prompt overhead on Sonnet 5). Recommendation: one small tool surface (`run_shell`, `apply_patch`/`str_replace`, `read_file`, `finish`) declared identically on both APIs, `strict: true` + `eager_input_streaming: true` on Anthropic, `parallel_tool_calls: false` / `disable_parallel_tool_use: true` while Jev owns control flow (one action per step), and a fenced-JSON fallback parser only for `max_tokens`/invalid-JSON recovery.

---

## 5. Retry / backoff guidance

Anthropic (https://platform.claude.com/docs/en/api/errors and https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript, 2026-09-19): "The official SDKs automatically retry transient failures (such as connection errors, rate limits, and 5xx server errors) with exponential backoff, twice by default, honoring the `retry-after` header when present." TS SDK specifics: "Connection errors ..., 408 Request Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors are all retried by default" (`maxRetries` default 2); default timeout 10 minutes, scaled up to 60 minutes for large non-streaming `max_tokens` by `(60*60*maxTokens)/128000` seconds; timeouts are retried. Exact constants from the SDK source (https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/client.ts, fetched 2026-09-19): `this.maxRetries = validatePositiveInteger('maxRetries', options.maxRetries ?? 2)`; `shouldRetry`: header `x-should-retry` `'true'` -> retry, `'false'` -> no retry, then `408`, `409`, `429`, `status >= 500`; `calculateDefaultRetryTimeoutMillis`: `const initialRetryDelay = 0.5; const maxRetryDelay = 8.0; const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay); const jitter = 1 - Math.random() * 0.25;`; `retryRequest` reads `retry-after-ms` first, then `retry-after` (`parseFloat` seconds, else `Date.parse(header) - Date.now()`), and uses it only `if (timeoutMillis > 0 && timeoutMillis <= 2 ** 31 - 1)`, else falls back to the computed backoff; `static DEFAULT_TIMEOUT = 600000; // 10 minutes`. Mirror this in JevCode's fetch client with fixed numbers: retry 408/409/429/500/502/503/504/529, `x-should-retry: true`, network errors and timeouts; 3 attempts total (2 retries); backoff `min(500 * 2^n, 8000)` ms x `(1 - U[0,0.25))`; honour `retry-after-ms`/`retry-after` only when `0 < value <= 60000` ms; per-attempt timeout 600 s (streaming only, so no `max_tokens` scaling); never retry 400/401/402/403/404/413, do not retry a 429 that lacks `retry-after` and has `error.details.error_code: "enforced_spend_limit_reached"`. For streams, treat an `event: error` after 200 like the equivalent status (e.g. `overloaded_error` -> retry) and reset the accumulator.

OpenRouter (https://openrouter.ai/docs/api_reference/errors-and-debugging.md and https://openrouter.ai/docs/api-reference/limits, 2026-09-19): "Retry with exponential backoff. Rate limits are transient"; "Honor the `Retry-After` header when present"; OpenRouter "may include" `Retry-After` on 429, 503, and on 402 with `error.metadata.limit_source: "openrouter_in_flight_budget"` (a 402 without the header "is not a wait-and-retry case"); docs' snippet: `if (res.status === 429 || res.status === 503 || res.status === 402) { const retryAfter = Number(res.headers.get('Retry-After')); ... }`. 502 (`provider_unavailable`): "OpenRouter may auto-retry with another provider if fallback routing is enabled" (`provider.allow_fallbacks`, default true) - so with fallbacks on, a single client retry is enough. Mid-stream rate limits arrive as a `data:` chunk with `error.code: 429` and `finish_reason: "error"`; retry the whole step. A 200 with `finish_reason: "length"`, empty content and `reasoning_tokens ~ completion_tokens` means the budget went to reasoning - raise `max_tokens` or lower `reasoning.effort`, do not blind-retry.

---

## UNVERIFIED / not confirmed

- Anthropic `anthropic-version` values other than `2023-06-01`: no newer version string is documented; only `2023-06-01` verified (docs + live).
- OpenRouter `X-Title` header acceptance: docs say still supported; the live probe sent `X-Title` and got 200, but attribution effect was not checked in the dashboard.
- OpenRouter tool-calling guide is the "Client Tools" page at `/docs/guides/features/tool-calling`; the older `/docs/features/tool-calling` and `/docs/api-reference/decisions` URLs return 404 (tried 2026-09-19).
- Whether OpenRouter passes Anthropic `cache_control` through automatically for `anthropic/claude-sonnet-5` (implicit caching): not tested; `prompt_tokens_details.cache_write_tokens` field exists, and every endpoint in `GET /api/v1/models/anthropic/claude-sonnet-5/endpoints` (all 10) and the Jev endpoint report `supports_implicit_caching: false` (2026-09-19). Test before relying on caching via OpenRouter.
- OpenRouter Decisions rate limits and payload cap: documented only as 429/413 statuses without numbers; local REPORT.md measured ~65,536-token request cap and no 429 at 128 concurrent.

---

## Verification log (2026-09-19)

Adversarial re-check of every URL, version, date, model id, price, limit and field name above, done 2026-09-19 by re-fetching the primary sources (platform.claude.com pages and their `.md` variants, openrouter.ai docs `.md` fragments, the public unauthenticated `GET https://openrouter.ai/api/v1/models*` endpoints, and one free `GET /v1/models/...` pair on the Anthropic API). No paid generation calls were made; no live streaming/headers/tool-call probes were re-run.

Corrections made:

1. **1.1 body fields** - `top_p` and `top_k` are also marked **Deprecated** on the Messages reference (not only `temperature`); added the verbatim acceptance rules (`temperature` 1.0 accepted, `top_p` >= 0.99 accepted, `top_k` any value rejected). Source: https://platform.claude.com/docs/en/api/messages.md.
2. **1.1 response object** - `stop_reason` enum was incomplete; added `model_context_window_exceeded` and the documented ordering/null rule. Source: https://platform.claude.com/docs/en/api/messages.md.
3. **1.2** - noted that https://platform.claude.com/docs/en/about-claude/models/overview resolves via redirect to https://platform.claude.com/docs/en/models/overview (content confirmed there).
4. **1.2** - re-ran the free Models GET: `created_at: 2026-06-29T00:00:00Z`, 1,000,000 / 128,000, thinking `enabled: false` / `adaptive: true`, effort levels, and the `claude-sonnet-5-20260630` 404 body all confirmed.
5. **2.2 `provider.max_price`** - removed the undocumented `audio` attribute; the docs list `prompt`, `completion`, `request`, `image`. Source: https://openrouter.ai/docs/guides/routing/provider-selection.md.
6. **2.1 response headers** - added the documented nuance that `X-RateLimit-*` appear only on OpenRouter platform-limit 429s and `Retry-After` only "when every attempted provider returned a retry hint". Source: https://openrouter.ai/docs/api_reference/limits.md.
7. **3. Decisions OpenAPI** - the "naive concatenation gives `/api/v1/api/alpha/decisions`" claim was misleading: the operation has an operation-level `servers: [{url: https://openrouter.ai}]` override, so a spec-compliant client composes the correct URL. Source: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md lines 26-28, 121-122, 326-327.
8. **3. Decisions OpenAPI** - "Documented error statuses: 400, 402, 413, 429, 503" was incomplete; the operation documents 200, 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529.
9. **4. OpenRouter tools** - `tool_choice: "required"` is not shown in the Client Tools guide (only `auto`, `none`, named function); it is defined in the OpenAPI `ChatToolChoice` schema. Attribution fixed. The index-keyed streaming `arguments` fragment shape is marked as a live observation rather than a documented contract.
10. **5. OpenRouter retry** - `Retry-After` wording changed from "is sent" to the documented "may include", and added that a 402 without the header "is not a wait-and-retry case". Source: https://openrouter.ai/docs/api_reference/errors-and-debugging.md.
11. **UNVERIFIED section** - refuted "`supports_implicit_caching` only for the Jev endpoint": all 10 Sonnet 5 endpoints and the Jev endpoint carry `supports_implicit_caching: false`. Source: https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5/endpoints and .../typesafe/jev-1.13/endpoints.

Confirmed unchanged (primary source re-fetched 2026-09-19): endpoint/headers and `anthropic-version: 2023-06-01`; Sonnet 5 id `claude-sonnet-5`, release June 30 2026, 1M/128K, 300K batch beta `output-300k-2026-03-24`, retirement not sooner than June 30 2027; all Sonnet 5 prices ($2/$10, $2.50/$4/$0.20, batch $1/$5), the cancelled Sept 1 2026 increase, no long-context premium, 354/474 tool-system-prompt tokens, tokenizer note; Fable 5.1 $10/$50, Opus 5 $5/$25, Haiku 4.5 $1/$5 and `claude-haiku-4-5-20251001`; sampling-param 400, `thinking.type: enabled` 400, effort `low|medium|high|xhigh|max` default `high`, no prefill; all SSE event names/shapes, `ping`, `error` after 200 with `overloaded_error`, cumulative `message_delta.usage`, "one complete key and value" note, `eager_input_streaming` and `INVALID_JSON` handling; error shape/`request_id`, every status/`error.type` row, 32 MB, SDK retry sentence, spend-cap 429 without `retry-after` and `error.details.error_code: enforced_spend_limit_reached`; all `anthropic-ratelimit-*` headers (RFC 3339), token bucket, cache-read exclusion from ITPM, Sonnet 5 separate bucket, Start/Build/Scale 1,000/2M/400K, 5,000/5M/1M, 10,000/10M/2M; prompt-caching minimums (Sonnet 5 1,024; Opus 5/Fable 5.1 512; Haiku 4.5 4,096), 4 breakpoints, auto-caching slot, 20-block lookback with consecutive tool blocks as one position, invalidation hierarchy, lifetime from request start, `max_tokens: 0` pre-warm rejected with `stream: true`; TS SDK retries (408/409/429/>=500, `maxRetries` 2), 10-min timeout and the `(60*60*maxTokens)/128000` formula, timeouts retried; tool definition fields and name regex, `strict` requirements and unsupported schema features, `tool_result`-first rule, `disable_parallel_tool_use`, `tool_choice` cache invalidation, Fable 5.1/Mythos 5.1 forced-tool 400, `output_config.format` with `output_format` deprecated; OpenRouter chat endpoint, `HTTP-Referer` "required for app attribution", `X-OpenRouter-Title` with `X-Title` still supported, `X-OpenRouter-Metadata: enabled`, `usage.include`/`stream_options.include_usage` deprecated no-ops, `max_tokens` deprecated with the "minimum of 16" note, `user`/`session_id` <= 256, `provider` fields and defaults, inverse-square routing, `:nitro`/`:floor`; SSE `: OPENROUTER PROCESSING`, the final usage chunk quotes ("accounting frame"), `finish_reason` normalisation, Anthropic in the cancellation list; error shape, every status description, `error_type` list including `string_too_long`, `limit_source`, the retry snippet, the 502 auto-retry sentence, mid-stream `finish_reason: "error"`; `/api/v1/models` count 447 and every Claude row (prices, cache prices, `canonical_slug`, `created`, ctx/out, `supported_parameters`, `reasoning`, no `pricing.overrides` on Sonnet 5, overrides present on Sonnet 4.5 and Sonnet 4, tilde aliases); Sonnet 5 endpoints list (10 endpoints, 1.1x regional Bedrock/Vertex pricing, Anthropic endpoint parameters); `typesafe/jev-1.13` absent from the default list, present via `?output_modalities=decisions`, 32000/28800, 4.2e-8/0, endpoint `typesafe/jev-1.13-20260917`, `~typesafe/jev-latest` alias, `GET /api/v1/models/typesafe/jev-1.13` 404; local `or-decisions.html` 99,144 bytes `__next_error__` shell matching the live 404 size; REPORT.md endpoint/limits agreement; Node v22.23.2; 404 status of `/docs/features/tool-calling` and `/docs/api-reference/decisions`.

Not independently re-verified (would need paid or authenticated generation calls; left as the researcher's live observations): trailing-whitespace padding after Anthropic `data:` JSON; `caller: {type: "direct"}` on `content_block_start`; live `message_start`/`message_delta` usage payloads and `output_tokens_details.thinking_tokens`; this org's Scale-tier rate-limit header values; OpenRouter live chunk/usage payloads, `provider` routing results, `is_byok`, top-level `user_id` on live 400/401 bodies; Sonnet 5 accepting `strict: true` live; the single live Jev decision response; `X-Title` attribution effect in the dashboard.
