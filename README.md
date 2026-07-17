# pi-commandcode-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that adds [Command Code](https://commandcode.ai) as a model provider — DeepSeek V4 Pro/Flash, Kimi K3, GLM 5.2, MiniMax M3, Qwen 3.7 Max, Inkling, and the rest of the open-weight roster, all routable from inside pi.

> **Unofficial.** Reverse-engineered from the `command-code` npm CLI (currently verified against v0.52.1). Not affiliated with or endorsed by Command Code / Langbase. Schema is undocumented and can change without notice.

## Why this exists

Command Code's `/provider/v1/messages` and `/provider/v1/chat/completions` **generation** endpoints require the **Provider plan or higher**. The **Go plan** ($1/month with $10 of credits and per-model multipliers, e.g. ~$40 of DeepSeek V4 Pro) doesn't expose them. (The `GET /provider/v1/models` _list_ endpoint is readable on Go — handy for discovering ids — but generation isn't.)

This extension instead talks to `/alpha/generate`, the endpoint the Command Code CLI (`cmd`) uses for every model call. It's not plan-gated, so any account that can run `cmd` can use it. The trade-off is that the request/response shape is undocumented and Vercel-AI-SDK-flavored, not OpenAI- or Anthropic-shaped — hence the extension.

## Configure

Set your Command Code API key as an env var. You can mint one at [commandcode.ai/settings](https://commandcode.ai/settings) (it looks like `user_…`):

```bash
export COMMANDCODE_API_KEY=user_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Verify the key is live:

```bash
curl -sS https://api.commandcode.ai/alpha/whoami \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
```

## Install

```bash
pi install git:github.com/safzanpirani/pi-commandcode-provider
```

Or try it for one run without installing:

```bash
pi -e git:github.com/safzanpirani/pi-commandcode-provider
```

## Use

```bash
pi --model "commandcode/deepseek/deepseek-v4-pro" -p "what is 17 * 23?"
pi --model "commandcode/moonshotai/Kimi-K2.6" -p "draft a haiku about caching"
```

`pi --list-models | grep commandcode` shows everything registered.

## Models

Pulled from `GET /provider/v1/models` and the CLI registry, then registered with the canonical id the gateway expects. All support text; models marked by the CLI as multimodal also accept image input. This is the **open-weight** roster; proprietary frontier models are omitted by default (see below).

| Model id                              | Display name              | Context | Max out |
| ------------------------------------- | ------------------------- | ------- | ------- |
| `deepseek/deepseek-v4-pro`            | DeepSeek V4 Pro           | 1M      | 128K    |
| `deepseek/deepseek-v4-flash`          | DeepSeek V4 Flash         | 1M      | 128K    |
| `moonshotai/Kimi-K3`                  | Kimi K3                   | 1M      | 64K     |
| `moonshotai/Kimi-K2.7-Code`           | Kimi K2.7 Code            | 256K    | 64K     |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | Kimi K2.7 Code HighSpeed  | 262K    | 64K     |
| `moonshotai/Kimi-K2.6`                | Kimi K2.6                 | 256K    | 64K     |
| `moonshotai/Kimi-K2.5`                | Kimi K2.5                 | 256K    | 64K     |
| `zai-org/GLM-5.2`                     | GLM 5.2                   | 1M      | 128K    |
| `zai-org/GLM-5.2-Fast`                | GLM 5.2 Fast              | 1M      | 64K     |
| `zai-org/GLM-5.1`                     | GLM 5.1                   | 200K    | 32K     |
| `zai-org/GLM-5`                       | GLM 5                     | 200K    | 32K     |
| `MiniMaxAI/MiniMax-M3`                | MiniMax M3                | 1M      | 128K    |
| `MiniMaxAI/MiniMax-M2.7`              | MiniMax M2.7              | 200K    | 64K     |
| `MiniMaxAI/MiniMax-M2.5`              | MiniMax M2.5              | 200K    | 64K     |
| `xiaomi/mimo-v2.5-pro`                | MiMo V2.5 Pro             | 1M      | 128K    |
| `xiaomi/mimo-v2.5`                    | MiMo V2.5                 | 1M      | 128K    |
| `Qwen/Qwen3.7-Max`                    | Qwen 3.7 Max              | 1M      | 128K    |
| `Qwen/Qwen3.7-Plus`                   | Qwen 3.7 Plus             | 1M      | 128K    |
| `Qwen/Qwen3.6-Max-Preview`            | Qwen 3.6 Max Preview      | 200K    | 32K     |
| `Qwen/Qwen3.6-Plus`                   | Qwen 3.6 Plus             | 200K    | 32K     |
| `stepfun/Step-3.7-Flash`             | Step 3.7 Flash            | 256K    | 64K     |
| `stepfun/Step-3.5-Flash`             | Step 3.5 Flash            | 1M      | 128K    |
| `tencent/Hy3`                         | Tencent Hy3               | 262K    | 64K     |
| `nvidia/nemotron-3-ultra-550b-a55b`   | Nemotron 3 Ultra          | 1M      | 128K    |
| `thinkingmachines/inkling`            | Inkling                    | 256K    | 64K     |

**Proprietary models (omitted by default).** Command Code also serves `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-fable-5`, `claude-haiku-4-5-20251001`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `google/gemini-3.5-flash`, and `google/gemini-3.1-flash-lite` over the same envelope. They bill real plan credits and are usually cheaper elsewhere, so they aren't registered here.

To add any model, append a `ModelDef` to the `MODELS` array in `index.ts` — every id in the gateway's `GET /provider/v1/models` list works.

## How it works

- POST `https://api.commandcode.ai/alpha/generate` with `Authorization: Bearer <key>`
- Body is a wrapped envelope: `{ config, memory, taste, skills, permissionMode, params }` where `params` carries the actual `{ model, system, messages, tools, max_tokens, stream }`
- `config`, `memory`, `taste`, and `skills` are static neutral defaults in `index.ts`. A fork that wants Command Code's workspace/taste context can replace `staticConfig()` and those sidecar fields without touching message or stream parsing.
- Messages use the [Vercel AI SDK `ModelMessage` schema](https://sdk.vercel.ai/docs) — `tool-call` parts on assistant messages, `role: "tool"` + `tool-result` parts for tool outputs (not Anthropic content blocks, not OpenAI tool messages)
- Response is **NDJSON** (newline-delimited JSON), not SSE — events like `reasoning-start/delta/end`, `text-start/delta/end`, `tool-input-start/delta/end`, `finish-step`
- The extension translates pi's native message format ↔ that wire shape and maps stream events onto pi's `thinking_*` / `text_*` / `toolcall_*` events

For the full, field-by-field contract, see the docs below.

## Docs

Reverse-engineered reference for the undocumented endpoint this extension speaks — useful if you're forking, extending, or the schema drifts and something starts 400ing:

- [`docs/wire-protocol.md`](docs/wire-protocol.md) — the complete `/alpha/generate` request/response contract: config envelope, Vercel-AI-SDK `ModelMessage` schema, tool format, every NDJSON event type, usage shape.
- [`docs/caching.md`](docs/caching.md) — prompt caching behavior + measured numbers (~36× cheaper on a warm prefix), and why the extension subtracts cached tokens from `input`.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — the 401 / 403 / 400 error modes, what each means, how to fix, and how to re-derive the protocol from the CLI bundle when it changes.

## Caveats

- **Undocumented endpoint.** `/alpha/generate` isn't a published API surface. Command Code can change the schema at any time. If they tighten the request shape, expect 400 errors until the extension is updated. For request-schema 400s, first compare the outgoing body in `index.ts` against the current CLI envelope: `config.{workingDir, date, environment, structure, isGitRepo, currentBranch, mainBranch, gitStatus, recentCommits}`, `memory: string`, `taste`, `skills`, `permissionMode`, and `params.{model, system, messages, tools, max_tokens, stream}`.
- **Tier policy.** This extension uses an endpoint the official CLI uses, on credentials your plan grants. Command Code may consider that fair game or may not; their published "API access" feature still requires the Pro plan. If your account gets flagged or rate-limited, that's the realistic downside.
- **Vision depends on the model.** Kimi K3/K2.x, MiniMax M3, Qwen 3.7 Plus, Step 3.7 Flash, and Inkling currently declare image input.
- **Cost is reported as $0** by pi. The Go plan applies per-model multipliers (e.g. $10 credits ↔ ~$40 of DeepSeek usage) that don't map cleanly to per-token pricing. Real balance: `curl -H "Authorization: Bearer $COMMANDCODE_API_KEY" https://api.commandcode.ai/alpha/billing/credits`.
- **Reasoning is heavy.** DeepSeek V4 Pro and Qwen 3.7 Max emit a lot of reasoning tokens by default. A short answer can cost 10–30× the input. Budget accordingly on the Go plan.

## Development

```bash
git clone https://github.com/safzanpirani/pi-commandcode-provider
cd pi-commandcode-provider

# Test it without installing
COMMANDCODE_API_KEY=user_... pi -e . -p "say pong"

# Type-check
npm install
npm run check
npm test
```

Pi loads `.ts` files directly, so there's no build step.

## License

MIT — see [LICENSE](LICENSE).
