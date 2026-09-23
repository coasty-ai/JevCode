/**
 * AGENT-LOOP-DESIGN §6.1 / slice S2 test (f): a request WITHOUT `agent` produces exactly the wire bytes every adapter sent
 * before the agent widening, and a legacy result carries exactly the fields it carried before (no `id` on a tool call,
 * no `providerState` / `contextEdits` / `warnings`). The goldens below were captured from `agent-base` (main e4139e2 +
 * S1) BEFORE any adapter change; each is the raw `fetch` body string, the URL and the header set minus the key header.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GenerateRequest, GenerateResult, GeneratorConfig } from '../../../src/core/types.js';
import { createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { createFireworksProvider } from '../../../src/provider/fireworks.js';
import { createGeminiProvider } from '../../../src/provider/gemini.js';
import { createMetaProvider } from '../../../src/provider/meta.js';
import { createOpenAiProvider } from '../../../src/provider/openai.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { createXaiProvider } from '../../../src/provider/xai.js';
import type { ProviderConfig } from '../../../src/provider/types.js';
import { GLM_PRICING, PROPOSE_TOOL, anthropicCfg, fixture, genOpts, openrouterCfg, providerCfg, providerDeps, request, scriptedFetch } from './helpers.js';

type Gen = { generate: (req: GenerateRequest, opts: ReturnType<typeof genOpts>) => Promise<GenerateResult> };
type Factory = (fetchImpl: typeof fetch) => Gen;

const KEY_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);

const orCfg = (model: string): GeneratorConfig => openrouterCfg({ model, pricing: GLM_PRICING, priced: true });
const pc = (model: string, over: Partial<ProviderConfig> = {}): ProviderConfig => providerCfg({ model, priced: true, ...over });

/** One factory per adapter surface the goldens pin (two OpenRouter models, both OpenAI surfaces, both Gemini families). */
const ADAPTERS: Readonly<Record<string, Factory>> = {
  'openrouter-glm': (f) => createOpenRouterProvider(orCfg('z-ai/glm-5.3-flash'), providerDeps(f).deps),
  'openrouter-claude': (f) => createOpenRouterProvider(orCfg('anthropic/claude-sonnet-5'), providerDeps(f).deps),
  anthropic: (f) => createAnthropicProvider(anthropicCfg(), providerDeps(f).deps),
  'openai-responses': (f) => createOpenAiProvider(pc('gpt-5.6-luna', { baseUrl: 'https://api.openai.com/v1' }), providerDeps(f).deps),
  'openai-chat-41': (f) => createOpenAiProvider(pc('gpt-4.1-mini', { baseUrl: 'https://api.openai.com/v1' }), providerDeps(f).deps, { api: 'chat' }),
  xai: (f) => createXaiProvider(pc('grok-4.7', { baseUrl: 'https://api.x.ai/v1' }), providerDeps(f).deps),
  fireworks: (f) => createFireworksProvider(pc('accounts/fireworks/models/glm-5p3-flash', { baseUrl: 'https://api.fireworks.ai/inference/v1' }), providerDeps(f).deps),
  meta: (f) => createMetaProvider(pc('muse-spark-1.3', { baseUrl: 'https://api.meta.ai/v1' }), providerDeps(f).deps),
  'gemini-38': (f) => createGeminiProvider(pc('gemini-3.8-flash', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), providerDeps(f).deps),
  'gemini-25': (f) => createGeminiProvider(pc('gemini-2.5-flash', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), providerDeps(f).deps),
};

/** The legacy request shapes every caller sends today: a chat turn, a forced propose_action step, an auto-tool turn, a budget turn. */
const REQUESTS: Readonly<Record<string, GenerateRequest>> = {
  plain: request(),
  chat: request({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'who made you' },
    ],
    maxTokens: 1024,
    temperature: 0.3,
    reasoning: { effort: 'low' },
    providerPrefs: { requireParameters: false, sort: 'latency' },
  }),
  forced: request({
    tools: [PROPOSE_TOOL],
    toolChoice: { name: 'propose_action' },
    temperature: 0.2,
    seed: 7,
    reasoning: { effort: 'medium' },
    providerPrefs: { requireParameters: true, order: ['together', 'friendli'] },
  }),
  auto: request({ tools: [PROPOSE_TOOL], toolChoice: 'auto', reasoning: { enabled: false }, maxTokens: 4096 }),
  budget: request({ tools: [PROPOSE_TOOL], toolChoice: 'required', reasoning: { maxTokens: 2048 }, system: '' }),
};

/** A stream every adapter accepts, so `generate` completes and the request is captured. */
const OK_BODY: Readonly<Record<string, string>> = {
  'openrouter-glm': fixture('openrouter-text.sse'),
  'openrouter-claude': fixture('openrouter-text.sse'),
  anthropic: fixture('anthropic-text.sse'),
  'openai-responses': fixture('openai-responses-tool.sse'),
  'openai-chat-41': fixture('openai-chat-tool.sse'),
  xai: fixture('xai-tool.sse'),
  fireworks: fixture('fireworks-tool.sse'),
  meta: fixture('meta-tool.json'),
  'gemini-38': fixture('gemini-tool.sse'),
  'gemini-25': fixture('gemini-tool.sse'),
};

/** The existing tool fixture of each adapter, whose legacy RESULT is pinned whole. */
const RESULT_FIXTURE: Readonly<Record<string, string>> = {
  'openrouter-glm': 'openrouter-tool.sse',
  anthropic: 'anthropic-tool.sse',
  'openai-responses': 'openai-responses-tool.sse',
  'openai-chat-41': 'openai-chat-tool.sse',
  xai: 'xai-tool.sse',
  fireworks: 'fireworks-tool.sse',
  meta: 'meta-tool.json',
  'gemini-38': 'gemini-tool.sse',
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function capture(name: string, req: GenerateRequest): Promise<Captured> {
  const f = scriptedFetch([{ status: 200, body: OK_BODY[name]! }]);
  await ADAPTERS[name]!(f.fetch).generate(req, genOpts());
  const call = f.calls[0]!;
  const headers: Record<string, string> = {};
  for (const k of Object.keys(call.headers).sort()) if (!KEY_HEADERS.has(k)) headers[k] = call.headers[k]!;
  return { url: call.url, headers, body: String(call.init.body) };
}

async function legacyResult(name: string): Promise<string> {
  const f = scriptedFetch([{ status: 200, body: fixture(RESULT_FIXTURE[name]!) }]);
  const res = await ADAPTERS[name]!(f.fetch).generate(request({ tools: [PROPOSE_TOOL], toolChoice: { name: 'propose_action' } }), genOpts());
  return JSON.stringify(res);
}

/** a wire golden: the URL and headers verbatim, the body by length and sha256 (58 KB of verbatim JSON otherwise) */
interface Golden {
  url: string;
  headers: Readonly<Record<string, string>>;
  bytes: number;
  sha256: string;
}

const OPENROUTER_H: Readonly<Record<string, string>> = { accept: 'text/event-stream', 'content-type': 'application/json', 'http-referer': 'https://github.com/coasty-ai/JevCode', 'x-title': 'jevcode' };
const ANTHROPIC_H: Readonly<Record<string, string>> = { accept: 'text/event-stream', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
const SSE_H: Readonly<Record<string, string>> = { accept: 'text/event-stream', 'content-type': 'application/json' };
const JSON_H: Readonly<Record<string, string>> = { accept: 'application/json', 'content-type': 'application/json' };

const GOLDEN_WIRE: Readonly<Record<string, Golden>> = {
  'openrouter-glm/plain': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 193, sha256: 'd35999c114151de72269409905d9d9cf02dd499b037bd66fbff14aad51b4eab4' },
  'openrouter-glm/chat': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 369, sha256: 'a2acaabb2d7aaaf68eb48be082fbd4f43a1a3cf746e59955a6a7cfd169ae2c0e' },
  'openrouter-glm/forced': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 1131, sha256: '35ab5313f829ce4b0ee77c05078b64c6bf1831aed7ef57680decb2b5a239b346' },
  'openrouter-glm/auto': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 982, sha256: '26de7b54c8e7d51f763029ab25a7f4c2aac523696c50788a1b961e23e23ceb07' },
  'openrouter-glm/budget': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 934, sha256: '8dda50e742f2ec292995490138e8c6baf528e51578935ef0cd2a025fdd5634c7' },
  'openrouter-claude/plain': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 200, sha256: '44e6a1f034f7778c09da131fc5aa0ce5323ef939fc3cff0ce5fd39bdb01b4d89' },
  'openrouter-claude/chat': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 376, sha256: 'f9bb1e6009b0293c75062797cf5ca63b6f899d406933877f56b103237f25481f' },
  'openrouter-claude/forced': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 1138, sha256: '2d11ce7df05d2629692ddccdf01b9ee31a592982b19228a9612a9d2c290cbc61' },
  'openrouter-claude/auto': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 989, sha256: '079ba2cd81571b67b2cf6099bbbc1f63ece85b6489a21782e7be85a322c39b02' },
  'openrouter-claude/budget': { url: 'https://openrouter.ai/api/v1/chat/completions', headers: OPENROUTER_H, bytes: 941, sha256: 'd4b536d5f5aca709139e5d10889dd3829b208b26df6244b4477f807132098926' },
  'anthropic/plain': { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_H, bytes: 208, sha256: 'ce15df9a47a912794e9b74cea37c3571aba53509d53a99e4d7c0e4cda9fd1238' },
  'anthropic/chat': { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_H, bytes: 298, sha256: '56ed6df994a573ef597740fb9f6a52ba741452b174614df94523510ceb87b063' },
  'anthropic/forced': { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_H, bytes: 1059, sha256: '72bb5b9863ad8a55685db6489466675a8fe8fc37b9b1e6be865722e51711bcec' },
  'anthropic/auto': { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_H, bytes: 1018, sha256: 'd6cc2f3513659fecf3ca81460df8962d764a62d6d2cb6d3f4ae128d6b6b728ef' },
  'anthropic/budget': { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_H, bytes: 920, sha256: '944e67204a50ea9f904880ca40a71338e17d4f7663e0634971cd01477013426e' },
  'openai-responses/plain': { url: 'https://api.openai.com/v1/responses', headers: SSE_H, bytes: 215, sha256: '46169f4d355324a42cb03376726785b78384952241c9239359fd1d05b676ef21' },
  'openai-responses/chat': { url: 'https://api.openai.com/v1/responses', headers: SSE_H, bytes: 413, sha256: 'ec9b2aff2a7edb8b3c7b75ea2e96bd18378e4d9dae5eb489ed3253a5342941e1' },
  'openai-responses/forced': { url: 'https://api.openai.com/v1/responses', headers: SSE_H, bytes: 1029, sha256: '1b2ef1df7feef47fe24c5e351c86e2365773c059bad7731a14c93db6eb1542e8' },
  'openai-responses/auto': { url: 'https://api.openai.com/v1/responses', headers: SSE_H, bytes: 991, sha256: 'fc51ac47b69857c9a4ad5fadbc3b04fb8df20bb3b9bbdb93ceda80e6b1383673' },
  'openai-responses/budget': { url: 'https://api.openai.com/v1/responses', headers: SSE_H, bytes: 924, sha256: '5918e78893dea9e01023ae8879ec1afb5da617775924c6057ff4e841521f82f2' },
  'openai-chat-41/plain': { url: 'https://api.openai.com/v1/chat/completions', headers: SSE_H, bytes: 227, sha256: '99c41d9af5fe6907182feea1ffd7019922e30201cb9b003934d96488ac306ad5' },
  'openai-chat-41/chat': { url: 'https://api.openai.com/v1/chat/completions', headers: SSE_H, bytes: 317, sha256: 'b1d00350b4e950e246cf088ca7065bbe7be71eaace4273371fcd57884a194398' },
  'openai-chat-41/forced': { url: 'https://api.openai.com/v1/chat/completions', headers: SSE_H, bytes: 1053, sha256: '7349311dd0b36227089097c3e8aeae6adadbf278216f0b767adf95fd4cd97661' },
  'openai-chat-41/auto': { url: 'https://api.openai.com/v1/chat/completions', headers: SSE_H, bytes: 986, sha256: '195521fde1eba675b8fddede71e59886b9fae1ed01efbdd108dbe0794fac3d2f' },
  'openai-chat-41/budget': { url: 'https://api.openai.com/v1/chat/completions', headers: SSE_H, bytes: 936, sha256: 'b9b0ae288e43406b6d71a41a5e7dab1ddb989625b2d91a5f5678e0ad7d243e0c' },
  'xai/plain': { url: 'https://api.x.ai/v1/chat/completions', headers: SSE_H, bytes: 198, sha256: '464689836437bc0057d5903696db6eef78b5cd8b971e2fd3b8d052d8f2a4a732' },
  'xai/chat': { url: 'https://api.x.ai/v1/chat/completions', headers: SSE_H, bytes: 313, sha256: 'a9a9b2060247526d8775e803dd3466ae63817b2906b9559f1a119ee50820df45' },
  'xai/forced': { url: 'https://api.x.ai/v1/chat/completions', headers: SSE_H, bytes: 1061, sha256: '17fe6e5b2e731d29796c3066e7208af182a88ed456a63b26dc559678d12bcd9c' },
  'xai/auto': { url: 'https://api.x.ai/v1/chat/completions', headers: SSE_H, bytes: 982, sha256: '4bf6c40480c7b03dd66b4816823d6607c9decaa53389c94ddb6c20fdc1323a67' },
  'xai/budget': { url: 'https://api.x.ai/v1/chat/completions', headers: SSE_H, bytes: 907, sha256: 'b3ed470cd67ae19586011c00adfa607f8cc83300886ada2c2f618ae351d951c2' },
  'fireworks/plain': { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: SSE_H, bytes: 272, sha256: '2d413b24fec92ef6faa7cfda4f8e28a55ff5cf3979babc4a4acbbc241b107655' },
  'fireworks/chat': { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: SSE_H, bytes: 387, sha256: '080f220a52e75fec9639d0483b2178f7092b78cf8e52125d5322716d6b9b441c' },
  'fireworks/forced': { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: SSE_H, bytes: 1135, sha256: '3979fe0a871b3c102823f515e2da479c8a14cb70594d28a8b6e4243d0a65f3db' },
  'fireworks/auto': { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: SSE_H, bytes: 1056, sha256: 'ae1861fd900777a1ddebfe6c5758a3e4dc467938471331e22a4ccc8b55c1cb60' },
  'fireworks/budget': { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: SSE_H, bytes: 1032, sha256: '20137705b5b2e73e928a26a459f8c85cb6cacd5609efcda3140e7681dae36c8b' },
  'meta/plain': { url: 'https://api.meta.ai/v1/chat/completions', headers: JSON_H, bytes: 150, sha256: 'a39253f4700dca9b548bb7e7ba5c0f9a6eb6fbb5b4ae40e39926dfc36446302c' },
  'meta/chat': { url: 'https://api.meta.ai/v1/chat/completions', headers: JSON_H, bytes: 265, sha256: '20dd0539f60eb21f64908da850b8cf8f1e03bf8a76f10827beea6f7d865e6874' },
  'meta/forced': { url: 'https://api.meta.ai/v1/chat/completions', headers: JSON_H, bytes: 963, sha256: 'bf0c4b7ecd72df71f8f39c33b43e8294bae3dc5f67fb5d5df6c0cdc1793509b6' },
  'meta/auto': { url: 'https://api.meta.ai/v1/chat/completions', headers: JSON_H, bytes: 934, sha256: '620be7231f8cb59898703d13324e82be57b4449fdd3ed5ab5ddce525706eb92a' },
  'meta/budget': { url: 'https://api.meta.ai/v1/chat/completions', headers: JSON_H, bytes: 855, sha256: '0483f4a74cb16021f20b16a536ad977872fa1ca331054e3befaed2cca538d05a' },
  'gemini-38/plain': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 173, sha256: 'c5a6bfca3ce3c338d51b726b629f4fb4ea1d406931eaad46c3ddf60117c26867' },
  'gemini-38/chat': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 318, sha256: '7ec6ca73fd7746a2993f9d27055048d119d44e382a5118c4311ccc9eccfd8129' },
  'gemini-38/forced': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 1041, sha256: 'ba3ca090a8d32e3365d17d30e8dd86580b0cef87d87737e31a001b58b025c1e6' },
  'gemini-38/auto': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 971, sha256: '967b70d5def5e710e2bd303a3fb8d908397fa083ea2c83ac07455f4bad75f01d' },
  'gemini-38/budget': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 903, sha256: '8516717a3cf371ac2bd8a2da83046554089095437ba7a04d8544a111d159bc5f' },
  'gemini-25/plain': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 173, sha256: 'c5a6bfca3ce3c338d51b726b629f4fb4ea1d406931eaad46c3ddf60117c26867' },
  'gemini-25/chat': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 318, sha256: 'c0cc5b48b8ec95cba8824d967d33498d7641a7621cd6ed6d8c70f9b1c8c5a43b' },
  'gemini-25/forced': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 1038, sha256: 'a33042652381de59f2a21d44da66699e1d0b0bf2bbe661867d2acd74b161b4e9' },
  'gemini-25/auto': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 968, sha256: '99482d0aab656ca0d5b46cd0782b851919fc47aa2d5a0657b49b863f7433354d' },
  'gemini-25/budget': { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', headers: SSE_H, bytes: 903, sha256: '8516717a3cf371ac2bd8a2da83046554089095437ba7a04d8544a111d159bc5f' },
};

const GOLDEN_RESULT: Readonly<Record<string, string>> = {
  "openrouter-glm":
    "{\"text\":\"Editing.\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"add test\",\"action\":{\"kind\":\"run\",\"command\":\"pytest -q\"},\"plan\":{\"done\":[],\"remaining\":[],\"openProblems\":[]}},\"rawJson\":\"{\\\"goal\\\": \\\"add test\\\", \\\"action\\\": {\\\"kind\\\": \\\"run\\\", \\\"command\\\": \\\"pytest -q\\\"}, \\\"plan\\\": {\\\"done\\\": [], \\\"remaining\\\": [], \\\"openProblems\\\": []}}\"}],\"usage\":{\"inputTokens\":1000,\"outputTokens\":100,\"costUsd\":0.00007905,\"calls\":1,\"reasoningTokens\":0,\"cacheReadTokens\":600,\"cacheWriteTokens\":100},\"model\":\"anthropic/claude-sonnet-5\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"gen-1789872400-tool\",\"servedProvider\":\"Anthropic\"}",
  "anthropic":
    "{\"text\":\"I will edit the file.\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"fix the off-by-one\",\"action\":{\"kind\":\"edit\",\"path\":\"src/a.py\",\"old\":\"i < n\",\"new\":\"i <= n\"},\"plan\":{\"done\":[],\"remaining\":[\"run tests\"],\"openProblems\":[]}},\"rawJson\":\"{\\\"goal\\\": \\\"fix the off-by-one\\\", \\\"action\\\": {\\\"kind\\\": \\\"edit\\\", \\\"path\\\": \\\"src/a.py\\\", \\\"old\\\": \\\"i < n\\\", \\\"new\\\": \\\"i <= n\\\"}, \\\"plan\\\": {\\\"done\\\": [], \\\"remaining\\\": [\\\"run tests\\\"], \\\"openProblems\\\": []}}\"}],\"usage\":{\"inputTokens\":4020,\"outputTokens\":51,\"costUsd\":0.00498,\"calls\":1,\"cacheReadTokens\":2400,\"cacheWriteTokens\":1500},\"model\":\"claude-sonnet-5\",\"stopReason\":\"tool_use\",\"latencyMs\":21,\"generationId\":\"msg_01Tool\"}",
  "openai-responses":
    "{\"text\":\"\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"List current directory files\",\"command\":\"ls\"},\"rawJson\":\"{\\\"goal\\\":\\\"List current directory files\\\",\\\"command\\\":\\\"ls\\\"}\"}],\"usage\":{\"inputTokens\":198,\"outputTokens\":26,\"costUsd\":0.000656,\"calls\":1,\"reasoningTokens\":0},\"model\":\"gpt-5.6-terra\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"resp_0ac1713f5a4e1ca7016ab1f29b685487d09c8437630d074816\"}",
  "openai-chat-41":
    "{\"text\":\"\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"List current directory files\",\"command\":\"ls\"},\"rawJson\":\"{\\\"goal\\\":\\\"List current directory files\\\",\\\"command\\\":\\\"ls\\\"}\"}],\"usage\":{\"inputTokens\":185,\"outputTokens\":25,\"costUsd\":0.00062,\"calls\":1,\"reasoningTokens\":0},\"model\":\"gpt-5.6-terra\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"chatcmpl-EQlI6KZ9wArq8mhMKmJs39wqPbOtj\"}",
  "xai":
    "{\"text\":\"I'll list the current directory contents.\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"List files in current directory\",\"command\":\"ls -la\"},\"rawJson\":\"{\\\"goal\\\":\\\"List files in current directory\\\",\\\"command\\\":\\\"ls -la\\\"}\"}],\"usage\":{\"inputTokens\":1413,\"outputTokens\":63,\"costUsd\":0.001476,\"calls\":1,\"reasoningTokens\":35,\"cacheReadTokens\":1152},\"model\":\"grok-4.7\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"4c9688b9-da1c-9fc6-bf6d-8ea4ea03b60e\"}",
  "fireworks":
    "{\"text\":\"\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"List files in the current directory\",\"command\":\"ls -la\"},\"rawJson\":\"{\\\"goal\\\": \\\"List files in the current directory\\\", \\\"command\\\": \\\"ls -la\\\"}\"}],\"usage\":{\"inputTokens\":234,\"outputTokens\":26,\"costUsd\":0.000728,\"calls\":1,\"reasoningTokens\":0},\"model\":\"accounts/fireworks/models/glm-5p3-flash\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"chatcmpl-6e2f4f05a36549c28cfdcb10b01e2eb0\"}",
  "meta":
    "{\"text\":\"Listing files — preparing your command.\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"command\":\"ls -la\",\"goal\":\"List files in directory\"},\"rawJson\":\"{\\\"command\\\":\\\"ls -la\\\",\\\"goal\\\":\\\"List files in directory\\\"}\"}],\"usage\":{\"inputTokens\":598,\"outputTokens\":204,\"costUsd\":0.003236,\"calls\":1,\"reasoningTokens\":117},\"model\":\"muse-spark-1.3\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"chatcmpl-01a0c71d-fb80-7573-8438-c80e3f413ddb\"}",
  "gemini-38":
    "{\"text\":\"Listing the files.\",\"toolCalls\":[{\"name\":\"propose_action\",\"input\":{\"goal\":\"list files\",\"command\":\"ls -la\"},\"rawJson\":\"{\\\"goal\\\":\\\"list files\\\",\\\"command\\\":\\\"ls -la\\\"}\"}],\"usage\":{\"inputTokens\":240,\"outputTokens\":32,\"costUsd\":0.0006848,\"calls\":1,\"reasoningTokens\":14,\"cacheReadTokens\":64},\"model\":\"gemini-3.8-flash\",\"stopReason\":\"tool_calls\",\"latencyMs\":21,\"generationId\":\"aBcD1234\"}",
};

describe('legacy wire bodies are byte-identical (AGENT-LOOP-DESIGN §6.1, S2 test f)', () => {
  for (const a of Object.keys(ADAPTERS)) {
    for (const r of Object.keys(REQUESTS)) {
      it(`${a} / ${r}`, async () => {
        const c = await capture(a, REQUESTS[r]!);
        const g = GOLDEN_WIRE[`${a}/${r}`]!;
        expect({ url: c.url, headers: c.headers, bytes: Buffer.byteLength(c.body), sha256: createHash('sha256').update(c.body, 'utf8').digest('hex') }).toEqual({ ...g, headers: { ...g.headers } });
      });
    }
  }
  for (const a of Object.keys(RESULT_FIXTURE)) {
    it(`${a} legacy result shape`, async () => {
      const json = await legacyResult(a);
      expect(json).toBe(GOLDEN_RESULT[a]);
      expect(json).not.toMatch(/"id":|providerState|contextEdits|warnings/);
    });
  }
});
