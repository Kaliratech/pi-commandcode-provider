# Troubleshooting

Error responses you'll actually hit, what they mean, and the fix. The gateway
returns errors in two formats depending on the surface: `/alpha/generate` uses
`{"success":false,"error":{"code","status","message"}}`; the `/provider/v1/*`
paths use an OpenAI-style `{"error":{"message","type","code"}}`.

## 401 — `UNAUTHORIZED`

```json
{"success":false,"error":{"code":"UNAUTHORIZED","status":401,"message":"Invalid 'Authorization' header or token."}}
```

The key didn't resolve. Causes, in order of likelihood:

- `COMMANDCODE_API_KEY` isn't set **in the shell that launched pi**. pi reads
  the env at launch; exporting it in a different terminal won't help. Confirm:
  ```bash
  echo $COMMANDCODE_API_KEY        # should print user_…
  ```
- You set it after starting an interactive pi session. Restart pi or `/reload`.
- The key is wrong / rotated. Verify directly:
  ```bash
  curl -sS https://api.commandcode.ai/alpha/whoami \
    -H "Authorization: Bearer $COMMANDCODE_API_KEY"
  # → 200 {"success":true,"user":{…}}  means the key is good
  ```

If you can't keep the env var around, you can inline the literal in your local
copy of `index.ts` (replace `apiKey: "COMMANDCODE_API_KEY"` with the `user_…`
string) — but **never commit that.** The repo's `.gitignore` and the README
warn against it for a reason.

## 403 — `upgrade_required`

```json
{"error":{"message":"Your Go plan doesn't include API access. Upgrade to Pro or higher…","type":"permission_error","code":"upgrade_required"}}
```

You hit `/provider/v1/messages` or `/provider/v1/chat/completions`, which are
Pro-gated. This extension does **not** use those — it uses `/alpha/generate`.
If you see this, something is calling the compat endpoints directly (e.g. a
`models.json` provider entry pointing at `https://api.commandcode.ai/provider/v1`).
Remove that entry; let the extension own the `commandcode` provider.

## 400 — `BAD_REQUEST` (schema mismatch)

This is the failure mode to expect when Command Code changes their CLI.

### Missing `config` fields

```
Validation error: expected string, received undefined at "config.workingDir"; …
```

The strict envelope schema rejected the body. Compare your outgoing `config`
against the current required fields (see `docs/wire-protocol.md`): `workingDir`,
`date`, `environment`, `structure`, `isGitRepo`, `currentBranch`, `mainBranch`,
`gitStatus`, `recentCommits`, plus top-level `memory` (string), `taste`,
`skills`, `permissionMode`, `params`. If the CLI added a new required field,
add it to `staticConfig()` / the body in `index.ts`.

### Wrong message shape

```
{"type":"error","error":{"type":"server_error","message":"Invalid prompt: The messages do not match the ModelMessage[] schema."}}
```

You sent something that isn't the Vercel AI SDK `ModelMessage` shape — most
often Anthropic content blocks (`tool_use` / `tool_result` / `role:"user"` with
tool results folded in) instead of `tool-call` / `tool-result` /
`role:"tool"`. See the schema in `docs/wire-protocol.md`. If the gateway
migrates to a new message schema version, `convertMessages()` is where to fix
it.

### Model not supported on this endpoint

```json
{"type":"error","error":{"type":"invalid_request_error","message":"Model \"deepseek/deepseek-v4-pro\" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models."}}
```

Only relevant if you're poking `/provider/v1/messages` (Anthropic-only) by
hand. Not produced via this extension. Anthropic models → `/messages`;
OpenAI/OSS → `/chat/completions`; everything → `/alpha/generate` (what we use).

## 400 — `insufficient credits`

```json
{"type":"error","error":{"type":"invalid_request_error","message":"You have insufficient credits to make this request. Please purchase more credits…"}}
```

Out of credits. Check the balance:

```bash
curl -sS https://api.commandcode.ai/alpha/billing/credits \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
# {"credits":{"monthlyCredits":…,"purchasedCredits":…,"freeCredits":…}}
```

Note the Go plan's per-model multipliers stretch the nominal $10 a long way on
DeepSeek / MiMo / Qwen — but reasoning-heavy models burn output tokens fast.

## `Error: [object Object]`

Old symptom (fixed). Was a non-`Error` throwable getting `String()`-ed. If you
ever see it again, run with `DEBUG=1` — the extension logs the raw error object
to stderr:

```bash
DEBUG=1 pi --model "commandcode/deepseek/deepseek-v4-pro" -p "test" 2>&1 \
  | grep '\[commandcode\]'
```

## Stream just hangs / no output

- Reasoning models (DeepSeek V4 Pro, Qwen 3.7 Max) can spend many seconds on
  `reasoning-delta` before the first `text-delta`. That's normal, not a hang.
- A dropped connection mid-stream surfaces as an `error` event or a thrown
  fetch error, both caught and reported. If it truly hangs, check network /
  the gateway status, then retry.

## Re-deriving the protocol when it breaks

Everything here came from the shipped CLI bundle. When something changes:

```bash
npm i -g command-code            # get the latest CLI
F=$(npm root -g)/command-code/dist/index.mjs
grep -o '/alpha/[a-z/]*' "$F" | sort -u          # endpoints
# search the bundle for the request-body construction + the message converter
```

The canonical model id list is always:

```bash
curl -sS https://api.commandcode.ai/provider/v1/models \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
```
