# pi-commandcode-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that adds [Command Code](https://commandcode.ai) as a model provider — DeepSeek V4 Pro, Kimi K2.6, Qwen 3.7 Max, MiMo V2.5 Pro, GLM 5.1, MiniMax M2.7, and others, all routable from inside pi.

> **Unofficial.** Reverse-engineered from the `command-code` npm CLI (v0.28.1). Not affiliated with or endorsed by Command Code / Langbase. Schema is undocumented and can change without notice.

## Why this exists

Command Code's `/provider/v1/messages` and `/provider/v1/chat/completions` endpoints are gated behind the **Pro plan**. The **Go plan** ($1/month with $10 of credits and per-model multipliers, e.g. ~$40 of DeepSeek V4 Pro) doesn't expose them — calls return `403: Your Go plan doesn't include API access`.

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

Pulled from `/provider/v1/models` and registered with the canonical id the gateway expects. All support text input + reasoning.

| Model id                       | Display name        | Context | Max out |
| ------------------------------ | ------------------- | ------- | ------- |
| `deepseek/deepseek-v4-pro`     | DeepSeek V4 Pro     | 1M      | 128K    |
| `deepseek/deepseek-v4-flash`   | DeepSeek V4 Flash   | 1M      | 128K    |
| `xiaomi/mimo-v2.5-pro`         | MiMo V2.5 Pro       | 1M      | 128K    |
| `xiaomi/mimo-v2.5`             | MiMo V2.5           | 1M      | 128K    |
| `Qwen/Qwen3.7-Max`             | Qwen 3.7 Max        | 1M      | 128K    |
| `moonshotai/Kimi-K2.6`         | Kimi K2.6           | 256K    | 64K     |
| `MiniMaxAI/MiniMax-M2.7`       | MiniMax M2.7        | 200K    | 64K     |
| `zai-org/GLM-5.1`              | GLM 5.1             | 200K    | 32K     |

To add more, edit the `MODELS` array in `index.ts` — every id in the gateway's `GET /provider/v1/models` list works.

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
- **No image input** for now. The gateway accepts images in the message schema but none of the currently registered models declare image input.
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
```

Pi loads `.ts` files directly, so there's no build step.

## License

MIT — see [LICENSE](LICENSE).
