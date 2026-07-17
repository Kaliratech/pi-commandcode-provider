import assert from "node:assert/strict";
import test from "node:test";

import registerCommandCode from "../index.ts";

let provider;
registerCommandCode({
	registerProvider(name, config) {
		assert.equal(name, "commandcode");
		provider = config;
	},
});

const model = {
	id: "deepseek/deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "commandcode-generate",
	provider: "commandcode",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("model registry includes the current OSS roster and vision capabilities", () => {
	const byID = new Map(provider.models.map((entry) => [entry.id, entry]));
	for (const id of [
		"moonshotai/Kimi-K3",
		"zai-org/GLM-5.2-Fast",
		"tencent/Hy3",
		"thinkingmachines/inkling",
	]) {
		assert.ok(byID.has(id), `missing current model ${id}`);
	}
	for (const id of [
		"moonshotai/Kimi-K3",
		"moonshotai/Kimi-K2.7-Code",
		"moonshotai/Kimi-K2.7-Code-Highspeed",
		"moonshotai/Kimi-K2.6",
		"moonshotai/Kimi-K2.5",
		"MiniMaxAI/MiniMax-M3",
		"Qwen/Qwen3.7-Plus",
		"stepfun/Step-3.7-Flash",
		"thinkingmachines/inkling",
	]) {
		assert.ok(byID.get(id)?.input.includes("image"), `${id} should accept image input`);
	}
});

test("truncated NDJSON stream fails instead of emitting done", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		return new Response(
			[
				'{"type":"start"}',
				'{"type":"text-start","id":"txt-0"}',
				'{"type":"text-delta","id":"txt-0","text":"partial"}',
			].join("\n"),
			{ status: 200, headers: { "content-type": "application/x-ndjson" } },
		);
	});

	const events = [];
	const stream = provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" });
	for await (const event of stream) {
		events.push(event);
	}

	assert.equal(events.at(-1)?.type, "error");
	assert.match(events.at(-1)?.error?.errorMessage ?? "", /terminal event/i);
});

test("tool-call accepts the current args fallback", async (t) => {
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		assert.equal(init.headers["x-command-code-version"], "0.52.1");
		return new Response(
			[
				'{"type":"start"}',
				'{"type":"tool-call","toolCallId":"call_1","toolName":"get_weather","args":{"location":"Paris"}}',
				'{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":3,"totalTokens":13}}',
			].join("\n"),
			{ status: 200, headers: { "content-type": "application/x-ndjson" } },
		);
	});

	const events = [];
	const stream = provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" });
	for await (const event of stream) {
		events.push(event);
	}

	const toolEnd = events.find((event) => event.type === "toolcall_end");
	assert.deepEqual(toolEnd?.toolCall?.arguments, { location: "Paris" });
	assert.equal(events.at(-1)?.message?.usage?.output, 3);
});
