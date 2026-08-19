import {
	type Api,
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Model,
	type ThinkingConfig,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it, test, vi } from "bun:test";
import {
	KIRO_MODELS,
	mapKiroCatalogToProviderModelConfigs,
	type KiroProviderModelConfig,
} from "../src/catalog.ts";
import {
	crc32,
	decodeKiroEventStream,
	decodeKiroEventStreamMessage,
} from "../src/eventstream.ts";
import { type KiroOAuthCredential, kiroOAuth } from "../src/oauth.ts";
import { createKiroProviderConfig } from "../src/provider.ts";
import { fetchKiroModelCatalog } from "../src/shared.ts";
import { buildKiroRequest, parseKiroEvent, streamKiro } from "../src/stream.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function eventStreamFrame(payload: string): Uint8Array {
	const payloadBytes = new TextEncoder().encode(payload);
	const totalLength = 16 + payloadBytes.length;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, 0, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(payloadBytes, 12);
	view.setUint32(
		totalLength - 4,
		crc32(frame.subarray(0, totalLength - 4)),
		false,
	);
	return frame;
}

function concatFrames(frames: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(
		frames.reduce((length, frame) => length + frame.length, 0),
	);
	let offset = 0;
	for (const frame of frames) {
		result.set(frame, offset);
		offset += frame.length;
	}
	return result;
}

const abortSignal = new AbortController().signal;
const originalFetch = globalThis.fetch;

function stubFetch(fetchImpl: FetchImpl): void {
	globalThis.fetch = fetchImpl as typeof globalThis.fetch;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function kiroModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "auto",
		name: "Auto",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		thinking: {
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "high",
		},
		...overrides,
	} as unknown as Model<Api>;
}

function assistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tool-1",
				name: "lookup",
				arguments: { query: "x" },
			},
		],
		api: "kiro-api",
		provider: "kiro",
		model: "auto",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "lookup",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 3,
	};
}

function loginCallbacks(overrides: { prompts?: string[] } = {}) {
	const prompts = overrides.prompts ?? [];
	const notifications: Array<{
		url?: string;
		instructions?: string;
		message?: string;
	}> = [];
	return {
		notifications,
		callbacks: {
			signal: abortSignal,
			onPrompt: vi.fn(async () => prompts.shift() ?? ""),
			onAuth: vi.fn((info: { url: string; instructions?: string }) =>
				notifications.push(info),
			),
			onProgress: vi.fn((message: string) => notifications.push({ message })),
		},
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
});

describe("Kiro OAuth", () => {
	it("runs Builder ID device authorization and keeps non-secret routing metadata", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/client/register")) {
				return jsonResponse({
					clientId: "client-fixture",
					clientSecret: "secret-fixture",
				});
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete:
						"https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			if (url.endsWith("/token")) {
				return jsonResponse({
					accessToken: "access-fixture",
					refreshToken: "refresh-fixture",
					expiresIn: 3600,
				});
			}
			throw new Error(`unexpected Kiro test URL: ${url}`);
		};
		stubFetch(fetchMock);

		const { callbacks, notifications } = loginCallbacks();
		const credential = await kiroOAuth.login(callbacks);

		expect(credential.access).toBe("access-fixture");
		expect(credential.refresh).toContain("|idc|us-east-1");
		expect((credential as KiroOAuthCredential).region).toBe("us-east-1");
		expect(notifications).toEqual([
			{
				url: "https://device.example.test/verify?code=fixture",
				instructions:
					"Open https://device.example.test/verify and enter your code: CODE-FIXTURE",
			},
			{ message: "Waiting for Kiro authorization in us-east-1..." },
		]);
		expect(calls.map((call) => call.url)).toEqual([
			"https://oidc.us-east-1.amazonaws.com/client/register",
			"https://oidc.us-east-1.amazonaws.com/device_authorization",
			"https://oidc.us-east-1.amazonaws.com/token",
		]);
	});

	it("refreshes with the registered device client and emits the structured API key", async () => {
		const fetchMock = vi.fn<FetchImpl>(async () =>
			jsonResponse({ accessToken: "access-refreshed", expiresIn: 1800 }),
		);
		stubFetch(fetchMock);
		const credential: KiroOAuthCredential = {
			access: "access-old",
			refresh: "refresh-old|client-fixture|secret-fixture|idc|eu-west-1",
			expires: 0,
			clientId: "client-fixture",
			clientSecret: "secret-fixture",
			region: "eu-west-1",
			authMethod: "idc",
			profileArn: "profile-fixture",
		};

		const refreshed = await kiroOAuth.refreshToken(credential);
		expect(refreshed.access).toBe("access-refreshed");
		expect((refreshed as KiroOAuthCredential).region).toBe("eu-west-1");
		expect((refreshed as KiroOAuthCredential).profileArn).toBe(
			"profile-fixture",
		);
		const refreshBody = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, string>;
		expect(refreshBody).toMatchObject({
			clientId: "client-fixture",
			clientSecret: "secret-fixture",
			refreshToken: "refresh-old",
			grantType: "refresh_token",
		});

		const apiKey = JSON.parse(kiroOAuth.getApiKey(refreshed)) as {
			token: string;
			region: string;
			profileArn: string;
		};
		expect(apiKey).toEqual({
			token: "access-refreshed",
			region: "eu-west-1",
			profileArn: "profile-fixture",
		});
	});
});

describe("Kiro OAuth error handling", () => {
	test("fails immediately for fatal HTTP 400 token errors", async () => {
		const fetchMock: FetchImpl = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({
					clientId: "client-fixture",
					clientSecret: "secret-fixture",
				});
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete:
						"https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			return jsonResponse({ error: "access_denied" }, 400);
		};
		stubFetch(fetchMock);

		await expect(kiroOAuth.login(loginCallbacks().callbacks)).rejects.toThrow(
			"Kiro authorization failed: access_denied",
		);
	});

	test("reports slow_down instead of treating it as authorization_pending", async () => {
		const fetchMock: FetchImpl = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({
					clientId: "client-fixture",
					clientSecret: "secret-fixture",
				});
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete:
						"https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 1,
				});
			}
			return jsonResponse({ error: "slow_down" }, 400);
		};
		stubFetch(fetchMock);
		await expect(kiroOAuth.login(loginCallbacks().callbacks)).rejects.toThrow(
			"after one or more slow_down responses",
		);
	});

	test("rejects a malformed device expiry before starting to poll", async () => {
		const prompts = ["https://start.example.test", "us-east-1"];
		let tokenPolls = 0;
		const fetchMock: FetchImpl = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({
					clientId: "client-fixture",
					clientSecret: "secret-fixture",
				});
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete:
						"https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: "not-a-number",
				});
			}
			tokenPolls += 1;
			return jsonResponse({
				accessToken: "unexpected",
				refreshToken: "unexpected",
				expiresIn: 3600,
			});
		};
		stubFetch(fetchMock);

		await expect(
			kiroOAuth.login(loginCallbacks({ prompts }).callbacks),
		).rejects.toThrow(
			"Could not find an AWS Identity Center region for the supplied start URL",
		);
		expect(tokenPolls).toBe(0);
	});
});

describe("Kiro management and request transformation", () => {
	it("discovers a profile and fetches a profile-scoped model catalog", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			return jsonResponse({
				models: [
					{
						modelId: "fixture-model",
						displayName: "Fixture Model",
						tokenLimits: { maxInputTokens: 1234, maxOutputTokens: 567 },
					},
				],
			});
		};

		const result = await fetchKiroModelCatalog(
			{ accessToken: "access-fixture", region: "eu-central-1" },
			undefined,
			fetchMock,
		);
		expect(result.profileArn).toBe("profile-fixture");
		expect(result.response.models[0]?.modelId).toBe("fixture-model");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[1]?.url).toContain("origin=KIRO_CLI");
		expect(requests[1]?.url).toContain("profileArn=profile-fixture");
		expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
			"Bearer access-fixture",
		);

		const models = mapKiroCatalogToProviderModelConfigs(
			result.response.models,
			"eu-central-1",
		);
		expect(models[0]).toMatchObject({
			id: "fixture-model",
			contextWindow: 1234,
			maxTokens: 567,
			baseUrl: "https://runtime.eu-central-1.kiro.dev/",
		});
		// Only standard ProviderModelConfig fields (+baseUrl): no custom keys.
		expect(
			(models[0] as { kiroModelId?: unknown }).kiroModelId,
		).toBeUndefined();
		expect((models[0] as { kiroRegion?: unknown }).kiroRegion).toBeUndefined();
		expect(
			(models[0] as { kiroProfileArn?: unknown }).kiroProfileArn,
		).toBeUndefined();
	});

	it("maps system, tool, assistant, and tool-result history into a Kiro request", () => {
		const model = kiroModel();
		const context: Context = {
			systemPrompt: ["Use concise answers."],
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: { query: "string" } as never,
				},
			],
			messages: [
				{ role: "user", content: "Earlier", timestamp: 1 },
				assistantToolCall(),
				toolResult(),
				{ role: "user", content: "Current", timestamp: 4 },
			],
		};

		const request = buildKiroRequest(
			model,
			context,
			"profile-fixture",
			"conversation-fixture",
			"high",
		);
		expect(request.profileArn).toBe("profile-fixture");
		expect(
			request.conversationState.history?.[0]?.userInputMessage?.content,
		).toContain("Earlier");
		expect(
			request.conversationState.history?.[0]?.userInputMessage?.content,
		).toContain("Use concise answers.");
		expect(
			request.conversationState.history?.[1]?.assistantResponseMessage
				?.toolUses?.[0]?.toolUseId,
		).toBe("tool-1");
		expect(
			request.conversationState.history?.[2]?.userInputMessage
				?.userInputMessageContext?.toolResults?.[0]?.content[0]?.text,
		).toBe("result");
		expect(
			request.conversationState.currentMessage.userInputMessage.content,
		).toBe("Current");
		expect(
			request.conversationState.currentMessage.userInputMessage
				.userInputMessageContext?.tools?.[0]?.toolSpecification.name,
		).toBe("lookup");
		expect(request.additionalModelRequestFields).toEqual({
			reasoning: { effort: "high" },
		});
	});

	it("encodes the output_config wire shape from standard thinking metadata", () => {
		const model = kiroModel({
			thinking: {
				mode: "budget",
				efforts: ["low", "medium", "high", "xhigh", "max"],
				defaultLevel: "high",
			},
		});
		const context: Context = {
			messages: [{ role: "user", content: "Current", timestamp: 1 }],
		};
		const request = buildKiroRequest(
			model,
			context,
			"profile-fixture",
			"conversation-fixture",
			"high",
		);
		expect(request.additionalModelRequestFields).toEqual({
			output_config: { effort: "high" },
			thinking: { type: "adaptive", display: "summarized" },
		});
	});
});

describe("Kiro dynamic catalog (fetchDynamicModels contract)", () => {
	it("returns the bootstrap catalog when unauthenticated and never touches the network", async () => {
		const fetchMock = vi.fn<FetchImpl>();
		stubFetch(fetchMock);
		const config = createKiroProviderConfig();

		const models = await config.fetchDynamicModels!(undefined);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(models.length).toBeGreaterThanOrEqual(1);
		expect(models[0]).toMatchObject({ id: "auto", api: "kiro-api" });
		for (const model of models) {
			expect(model.api).toBe("kiro-api");
			expect((model as { kiroModelId?: unknown }).kiroModelId).toBeUndefined();
			expect((model as { kiroRegion?: unknown }).kiroRegion).toBeUndefined();
			expect(
				(model as { kiroProfileArn?: unknown }).kiroProfileArn,
			).toBeUndefined();
		}
		expect(KIRO_MODELS.length).toBe(models.length);
	});

	it("merges a partial profile catalog without dropping omitted Claude bootstrap models", async () => {
		const requests: string[] = [];
		const fetchMock: FetchImpl = async (input) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			return jsonResponse({
				models: [
					{
						modelId: "glm-5",
						displayName: "GLM 5 Dynamic",
						tokenLimits: { maxInputTokens: 1234, maxOutputTokens: 567 },
						additionalModelRequestFieldsSchema: {
							properties: {
								reasoning: {
									properties: { effort: { enum: ["low", "high"] } },
								},
							},
						},
					},
				],
			});
		};
		stubFetch(fetchMock);
		const config = createKiroProviderConfig();

		const models = (await config.fetchDynamicModels!(
			JSON.stringify({
				token: "access-fixture",
				region: "eu-west-1",
				profileArn: "profile-fixture",
			}),
		)) as KiroProviderModelConfig[];

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(
			"https://management.eu-central-1.kiro.dev/List-Available-Models",
		);
		expect(requests[0]).toContain("profileArn=profile-fixture");
		expect(models).toHaveLength(KIRO_MODELS.length);
		expect(models[0]).toMatchObject({
			id: "glm-5",
			name: "GLM 5 Dynamic",
			contextWindow: 1234,
			maxTokens: 567,
		});
		expect(models[0]?.baseUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
		expect(models[0]?.headers?.["x-amzn-kiro-profile-arn"]).toBe(
			"profile-fixture",
		);
		expect((models[0]?.thinking as ThinkingConfig | undefined)?.mode).toBe(
			"effort",
		);
		expect(models.some((model) => model.id === "claude-sonnet-4.5")).toBe(true);
	});
});

describe("Kiro EventStream and runtime", () => {
	it("validates CRCs and reassembles split frames", async () => {
		const frame = eventStreamFrame(JSON.stringify({ content: "hello" }));
		expect(
			new TextDecoder().decode(decodeKiroEventStreamMessage(frame).payload),
		).toBe(JSON.stringify({ content: "hello" }));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame.slice(0, 7));
				controller.enqueue(frame.slice(7));
				controller.close();
			},
		});
		const messages = [];
		for await (const message of decodeKiroEventStream(stream))
			messages.push(message);
		expect(messages).toHaveLength(1);
		expect(new TextDecoder().decode(messages[0]!.payload)).toBe(
			JSON.stringify({ content: "hello" }),
		);
		const corrupt = frame.slice();
		corrupt[8] ^= 1;
		expect(() => decodeKiroEventStreamMessage(corrupt)).toThrow("prelude CRC");
	});

	it("parses native events and emits a complete text/tool runtime response", async () => {
		expect(parseKiroEvent({ content: "hello" })).toEqual({
			type: "content",
			data: "hello",
		});
		expect(parseKiroEvent({ text: "reason" })).toEqual({
			type: "thinkingText",
			data: "reason",
		});
		expect(
			parseKiroEvent({
				name: "lookup",
				toolUseId: "tool-1",
				input: { query: "x" },
				stop: true,
			}),
		).toEqual({
			type: "toolUse",
			data: {
				name: "lookup",
				toolUseId: "tool-1",
				input: JSON.stringify({ query: "x" }),
				stop: true,
			},
		});
		expect(
			parseKiroEvent({ usage: { inputTokens: 10, outputTokens: 4 } }),
		).toEqual({
			type: "usage",
			data: { inputTokens: 10, outputTokens: 4 },
		});

		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const responseBody = concatFrames([
			eventStreamFrame(JSON.stringify({ text: "reason" })),
			eventStreamFrame(JSON.stringify({ content: "hello" })),
			eventStreamFrame(
				JSON.stringify({
					name: "lookup",
					toolUseId: "tool-1",
					input: { query: "x" },
					stop: true,
				}),
			),
			eventStreamFrame(
				JSON.stringify({ usage: { inputTokens: 10, outputTokens: 4 } }),
			),
		]);
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(responseBody, { status: 200 });
		};
		const model = kiroModel();
		const context: Context = {
			messages: [{ role: "user", content: "Current", timestamp: 1 }],
		};
		let sentRequest: unknown;
		const result = await streamKiro(model, context, {
			apiKey: JSON.stringify({
				token: "access-fixture",
				region: "eu-central-1",
				profileArn: "profile-fixture",
			}),
			fetch: fetchMock,
			sessionId: "conversation-fixture",
			onPayload: (payload) => {
				sentRequest = payload;
			},
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "hello" },
			{
				type: "toolCall",
				id: "tool-1",
				name: "lookup",
				arguments: { query: "x" },
			},
		]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(4);
		expect(requests[0]?.url).toBe(
			"https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		);
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
			"Bearer access-fixture",
		);
		expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
			profileArn: "profile-fixture",
			conversationState: { conversationId: "conversation-fixture" },
		});
		expect(sentRequest).toMatchObject({ profileArn: "profile-fixture" });
	});

	it("resolves the region from the model base URL and the profile ARN from model headers", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(
				concatFrames([eventStreamFrame(JSON.stringify({ content: "hi" }))]),
				{ status: 200 },
			);
		};
		const model = kiroModel({
			baseUrl: "https://runtime.eu-central-1.kiro.dev/",
			headers: { "x-amzn-kiro-profile-arn": "header-fixture" },
		});
		const context: Context = {
			messages: [{ role: "user", content: "Current", timestamp: 1 }],
		};
		const result = await streamKiro(model, context, {
			apiKey: "plain-bearer-fixture",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requests[0]?.url).toBe(
			"https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		);
		expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
			profileArn: "header-fixture",
		});
		expect(
			new Headers(requests[0]?.init?.headers).get("x-amzn-kiro-profile-arn"),
		).toBe("header-fixture");
	});

	it("emits an error event when no credentials are configured", async () => {
		const model = kiroModel();
		const context: Context = {
			messages: [{ role: "user", content: "Current", timestamp: 1 }],
		};
		const events: Array<{ type: string; error?: AssistantMessage }> = [];
		for await (const event of streamKiro(model, context, {})) {
			if (event.type === "error")
				events.push({ type: event.type, error: event.error });
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.errorMessage).toContain("Run /login kiro");
	});
});
