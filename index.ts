/**
 * Command Code provider extension for pi.
 *
 * Routes pi requests through https://api.commandcode.ai/alpha/generate
 * (the CLI's own endpoint), which the Go plan permits. The /provider/v1/*
 * compatibility endpoints are gated behind the Pro plan, so we cannot
 * use openai-completions / anthropic-messages directly.
 *
 * Authenticates with COMMANDCODE_API_KEY (a "user_..." token from
 * https://commandcode.ai/settings/billing or `cmd auth status`).
 *
 * Wire shape, sender:
 *   POST /alpha/generate
 *   body: { config, memory: "", taste: null, skills: null,
 *           permissionMode: "standard",
 *           params: { model, system, messages, tools, max_tokens, stream } }
 *
 * Wire shape, receiver (newline-delimited JSON, NOT SSE):
 *   {"type":"start"}
 *   {"type":"start-step",...}
 *   {"type":"reasoning-start","id":"reasoning-0"}
 *   {"type":"reasoning-delta","id":"reasoning-0","text":"..."}
 *   {"type":"reasoning-end","id":"reasoning-0"}
 *   {"type":"text-start","id":"txt-0"}
 *   {"type":"text-delta","id":"txt-0","text":"..."}
 *   {"type":"text-end","id":"txt-0"}
 *   {"type":"tool-input-start","id":"call_...","toolName":"..."}
 *   {"type":"tool-input-delta","id":"call_...","delta":"<json chunk>"}
 *   {"type":"tool-input-end","id":"call_..."}
 *   {"type":"finish-step","finishReason":"stop"|"length"|"tool-calls","usage":{...}}
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.commandcode.ai";
const ENDPOINT = "/alpha/generate";

// ---- Models -------------------------------------------------------------
// IDs are the gateway's canonical ids from GET /provider/v1/models.
// The Go plan ($1/mo, $10 credits) has multipliers for these three:
//   deepseek-v4-pro  → ~$40 of usage (4x)
//   xiaomi/mimo-v2.5 → ~$100 (10x)
//   xiaomi/mimo-v2.5-pro → ~$50 (5x)
//   Qwen/Qwen3.7-Max → ~$20 (2x)
// Other OSS models on Go cost real credits — burn fast.

type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const MODELS: ModelDef[] = [
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5-pro",
		name: "MiMo V2.5 Pro (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5",
		name: "MiMo V2.5 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.7-Max",
		name: "Qwen 3.7 Max (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 65536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM 5.1 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

// ---- Message conversion -------------------------------------------------
//
// The gateway speaks Vercel AI SDK's ModelMessage schema (not Anthropic's
// content-block shape). Verified by reading the CLI bundle's own converter
// and by hitting the gateway with both shapes — the Anthropic shape errors
// with "messages do not match the ModelMessage[] schema."
//
// Shape:
//   user:      { role: "user",      content: [{ type: "text", text }, { type: "image", image, mediaType }] }
//   assistant: { role: "assistant", content: [{ type: "text", text }, { type: "tool-call", toolCallId, toolName, input }] }
//   tool:      { role: "tool",      content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }] }

type UserContent =
	| { type: "text"; text: string }
	| { type: "image"; image: string; mediaType?: string };

type AssistantContent =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> };

type ToolContent = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: { type: "text"; value: string } | { type: "error-text"; value: string };
};

type CmdMessage =
	| { role: "user"; content: UserContent[] }
	| { role: "assistant"; content: AssistantContent[] }
	| { role: "tool"; content: ToolContent[] };

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.message || value.stack || "Error";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "Unknown error (non-serializable)";
	}
}

function parseJsonLine(line: string, lineNumber: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		const preview = line.length > 240 ? `${line.slice(0, 240)}...` : line;
		throw new Error(
			`Malformed Command Code NDJSON at line ${lineNumber}: ${preview} (${stringifyUnknown(error)})`,
		);
	}
}

function convertMessages(messages: Message[]): CmdMessage[] {
	const out: CmdMessage[] = [];
	// Track tool call names by id so tool-result messages can fill `toolName`
	const toolNameById = new Map<string, string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content: UserContent[] = [];
			if (typeof msg.content === "string") {
				content.push({ type: "text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") content.push({ type: "text", text: block.text });
					else if (block.type === "image")
						content.push({
							type: "image",
							image: `data:${block.mimeType};base64,${block.data}`,
							mediaType: block.mimeType,
						});
				}
			}
			if (content.length > 0) out.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content: AssistantContent[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text) content.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					toolNameById.set(block.id, block.name);
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						toolName: block.name,
						input: block.arguments ?? {},
					});
				}
				// Skip "thinking" — the upstream provider reconstructs its own reasoning
			}
			if (content.length > 0) out.push({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			const block: ToolContent = {
				type: "tool-result",
				toolCallId: msg.toolCallId,
				toolName: toolNameById.get(msg.toolCallId) ?? msg.toolName ?? "unknown",
				output: { type: msg.isError ? "error-text" : "text", value: text },
			};
			// Merge consecutive tool-result messages into one role:"tool" message
			const last = out[out.length - 1];
			if (last && last.role === "tool") {
				last.content.push(block);
			} else {
				out.push({ role: "tool", content: [block] });
			}
		}
	}
	return out;
}

// ---- Static "config" sidecar --------------------------------------------
// The /alpha/generate schema is strict — all of these fields are required.
// We don't actually have a project context inside an extension, so we send
// neutral defaults. The gateway just stuffs them into the system prompt
// preamble; they don't affect routing.

function staticConfig() {
	return {
		workingDir: process.cwd(),
		date: new Date().toISOString().slice(0, 10),
		environment: "production",
		structure: [],
		isGitRepo: false,
		currentBranch: "",
		mainBranch: "",
		gitStatus: "",
		recentCommits: [],
	};
}

// ---- NDJSON line reader -------------------------------------------------

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lineNumber = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			lineNumber += 1;
			yield parseJsonLine(line, lineNumber);
		}
	}
	buffer = buffer.trim();
	if (buffer) {
		lineNumber += 1;
		yield parseJsonLine(buffer, lineNumber);
	}
}

type GatewayEvent = Record<string, any>;

function toolEventId(event: GatewayEvent): string | undefined {
	return event.id ?? event.toolCallId;
}

function toolEventName(event: GatewayEvent): string {
	return event.toolName ?? event.name ?? "";
}

// ---- Stream implementation ----------------------------------------------

function streamCommandCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No Command Code API key. Set COMMANDCODE_API_KEY=user_...");

			stream.push({ type: "start", partial: output });

			const tools = (context.tools ?? []).map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));

			const body = {
				config: staticConfig(),
				memory: "",
				taste: null,
				skills: null,
				permissionMode: "standard",
				params: {
					model: model.id,
					system: context.systemPrompt ?? "",
					messages: convertMessages(context.messages),
					tools,
					max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
					...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
					stream: true,
				},
			};

			const response = await fetch(`${BASE_URL}${ENDPOINT}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"x-cli-environment": "production",
					"x-command-code-version": "0.28.1",
					"x-session-id": options?.sessionId ?? crypto.randomUUID(),
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok || !response.body) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {}
				throw new Error(`Command Code ${response.status}: ${detail || response.statusText}`);
			}

			// id-keyed maps: gateway gives us "reasoning-0", "txt-0", "call_..." as ids
			const idToIndex = new Map<string, number>();
			const toolJsonByIndex = new Map<number, string>();
			const endedToolCalls = new Set<number>();

			for await (const event of ndjsonLines(response.body)) {
				if (!event || typeof event !== "object") continue;
				const gatewayEvent = event as GatewayEvent;
				const type = gatewayEvent.type;
				if (!type) continue;

				switch (type) {
					case "reasoning-start": {
						output.content.push({ type: "thinking", thinking: "" });
						const idx = output.content.length - 1;
						idToIndex.set(gatewayEvent.id, idx);
						stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
						break;
					}
					case "reasoning-delta": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "thinking") break;
						const delta = gatewayEvent.text ?? "";
						block.thinking += delta;
						stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "reasoning-end": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "thinking") break;
						stream.push({
							type: "thinking_end",
							contentIndex: idx,
							content: block.thinking,
							partial: output,
						});
						break;
					}
					case "text-start": {
						output.content.push({ type: "text", text: "" });
						const idx = output.content.length - 1;
						idToIndex.set(gatewayEvent.id, idx);
						stream.push({ type: "text_start", contentIndex: idx, partial: output });
						break;
					}
					case "text-delta": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "text") break;
						const delta = gatewayEvent.text ?? "";
						block.text += delta;
						stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "text-end": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "text") break;
						stream.push({
							type: "text_end",
							contentIndex: idx,
							content: block.text,
							partial: output,
						});
						break;
					}
					case "tool-input-start": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						output.content.push({
							type: "toolCall",
							id,
							name: toolEventName(gatewayEvent),
							arguments: {},
						});
						const idx = output.content.length - 1;
						idToIndex.set(id, idx);
						toolJsonByIndex.set(idx, "");
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						break;
					}
					case "tool-input-delta": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						const idx = idToIndex.get(id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "toolCall") break;
						const delta = gatewayEvent.delta ?? "";
						const acc = (toolJsonByIndex.get(idx) ?? "") + delta;
						toolJsonByIndex.set(idx, acc);
						try {
							block.arguments = JSON.parse(acc);
						} catch {
							// JSON still streaming
						}
						stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "tool-input-end":
					case "tool-call": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						let idx = idToIndex.get(id);
						if (idx === undefined) {
							output.content.push({
								type: "toolCall",
								id,
								name: toolEventName(gatewayEvent),
								arguments: {},
							});
							idx = output.content.length - 1;
							idToIndex.set(id, idx);
							stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						}
						const block = output.content[idx];
						if (block.type !== "toolCall") break;
						// Some streams send full input on "tool-call"; prefer that if present
						if (gatewayEvent.input && typeof gatewayEvent.input === "object") {
							block.arguments = gatewayEvent.input;
						} else {
							const acc = toolJsonByIndex.get(idx) ?? "";
							if (acc) {
								try {
									block.arguments = JSON.parse(acc);
								} catch {}
							}
						}
						if (endedToolCalls.has(idx)) break;
						endedToolCalls.add(idx);
						stream.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall: {
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: block.arguments,
							},
							partial: output,
						});
						break;
					}
					case "finish-step":
					case "finish": {
						const usage = gatewayEvent.usage;
						if (usage) {
							// The gateway reports inputTokens as the TOTAL input (cached + uncached),
							// matching the Vercel AI SDK convention. Pi's Usage shape expects
							// `input` and `cacheRead` to be disjoint — calculateCost multiplies
							// each separately, so leaving cached tokens inside `input` would
							// double-charge on paid models. Subtract to match the convention
							// used by the built-in Anthropic provider in pi-ai.
							const totalInputTokens = usage.inputTokens ?? usage.input_tokens ?? 0;
							const cacheReadTokens =
								usage.cachedInputTokens ??
								usage.inputTokenDetails?.cacheReadTokens ??
								usage.raw?.prompt_cache_hit_tokens ??
								0;
							output.usage.input = Math.max(0, totalInputTokens - cacheReadTokens);
							output.usage.output = usage.outputTokens ?? usage.output_tokens ?? 0;
							output.usage.cacheRead = cacheReadTokens;
							output.usage.cacheWrite = 0;
							output.usage.totalTokens =
								output.usage.input +
								output.usage.output +
								output.usage.cacheRead +
								output.usage.cacheWrite;
							calculateCost(model, output.usage);
						}
						const reason = gatewayEvent.finishReason ?? gatewayEvent.rawFinishReason;
						if (reason === "length") output.stopReason = "length";
						else if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use")
							output.stopReason = "toolUse";
						else output.stopReason = "stop";
						break;
					}
					case "error": {
						throw new Error(
							gatewayEvent.message ??
								(gatewayEvent.error === undefined
									? "Command Code stream error"
									: stringifyUnknown(gatewayEvent.error)),
						);
					}
				}
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = stringifyUnknown(error);
			if (process.env.DEBUG) {
				console.error("[commandcode] stream error:", error);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---- Extension entry point ----------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerProvider("commandcode", {
		name: "Command Code",
		baseUrl: BASE_URL,
		apiKey: "COMMANDCODE_API_KEY",
		authHeader: true,
		api: "commandcode-generate",
		streamSimple: streamCommandCode,
		models: MODELS,
	});
}
