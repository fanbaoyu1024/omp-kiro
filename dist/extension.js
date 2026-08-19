// src/shared.ts
var API_REGION_MAP = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1"
};
function resolveKiroApiRegion(ssoRegion) {
  const normalized = ssoRegion?.trim();
  return normalized ? API_REGION_MAP[normalized] ?? normalized : "us-east-1";
}
function getKiroEndpoints(region) {
  return {
    region,
    management: `https://management.${region}.kiro.dev/`,
    runtime: `https://runtime.${region}.kiro.dev/`
  };
}
function getKiroRegionFromEndpoint(endpoint) {
  if (!endpoint)
    return;
  try {
    const [service, region, ...suffix] = new URL(endpoint).hostname.split(".");
    if ((service === "management" || service === "runtime") && suffix.join(".") === "kiro.dev") {
      return region;
    }
  } catch {}
  return;
}

class KiroManagementHttpError extends Error {
  status;
  constructor(operation, region, status) {
    super(`Kiro management ${operation} failed in ${region}: HTTP ${status}`);
    this.name = "KiroManagementHttpError";
    this.status = status;
  }
}
async function managementRequest(auth, operation, path, method, params, fetchFn, signal) {
  const url = new URL(path, getKiroEndpoints(auth.region).management);
  const request = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.accessToken}`
    },
    signal
  };
  if (method === "GET") {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined)
        url.searchParams.set(name, value);
    }
  } else {
    request.headers = { ...request.headers, "Content-Type": "application/json" };
    request.body = JSON.stringify(Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)));
  }
  let response;
  try {
    response = await fetchFn(url, request);
  } catch (error) {
    if (signal?.aborted)
      throw error;
    throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
  }
  if (!response.ok)
    throw new KiroManagementHttpError(operation, auth.region, response.status);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Kiro management ${operation} returned invalid JSON in ${auth.region}`, { cause: error });
  }
}
async function resolveKiroProfileArn(auth, providedProfileArn, fetchFn = globalThis.fetch, signal) {
  if (providedProfileArn)
    return providedProfileArn;
  const response = await managementRequest(auth, "ListAvailableProfiles", "List-Available-Profiles", "POST", {}, fetchFn, signal);
  const profileArn = response.profiles?.find((profile) => typeof profile.arn === "string" && profile.arn.length > 0)?.arn;
  if (!profileArn) {
    throw new Error(`Kiro management ListAvailableProfiles returned no profile in ${auth.region}`);
  }
  return profileArn;
}
async function fetchKiroModelCatalog(auth, providedProfileArn, fetchFn = globalThis.fetch, signal) {
  const profileArn = await resolveKiroProfileArn(auth, providedProfileArn, fetchFn, signal);
  const response = await managementRequest(auth, "ListAvailableModels", "List-Available-Models", "GET", { origin: "KIRO_CLI", profileArn }, fetchFn, signal);
  if (!Array.isArray(response.models) || response.models.length === 0) {
    throw new Error(`Kiro management ListAvailableModels returned no models in ${auth.region}`);
  }
  if (response.models.some((model) => !model || typeof model.modelId !== "string" || model.modelId.length === 0)) {
    throw new Error(`Kiro management ListAvailableModels returned an invalid catalog in ${auth.region}`);
  }
  return { profileArn, response };
}

// src/catalog.ts
var KIRO_API = "kiro-api";
var ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
var DEFAULT_CONTEXT_WINDOW = 200000;
var DEFAULT_MAX_TOKENS = 8192;
var KIRO_RUNTIME = getKiroEndpoints("us-east-1").runtime;
var KIRO_THINKING = {
  mode: "effort",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "high"
};
function isReasoningModel(id) {
  return /auto|claude-opus|claude-sonnet|deepseek|gpt|glm|qwen/i.test(id);
}
function createBootstrapModel(id, options = {}) {
  return {
    id,
    name: id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    api: KIRO_API,
    baseUrl: KIRO_RUNTIME,
    reasoning: options.reasoning ?? isReasoningModel(id),
    input: options.input ?? (/^(auto|claude)/i.test(id) ? ["text", "image"] : ["text"]),
    cost: { ...ZERO_COST },
    contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...options.thinking ? { thinking: options.thinking } : {}
  };
}
var KIRO_MODELS = [
  createBootstrapModel("auto", {
    contextWindow: 1e6,
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-opus-5", {
    contextWindow: 1e6,
    maxTokens: 128000,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-sonnet-5", {
    contextWindow: 1e6,
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-opus-4.8", {
    contextWindow: 1e6,
    maxTokens: 128000,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-opus-4.7", {
    contextWindow: 1e6,
    maxTokens: 128000,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-opus-4.6", {
    maxTokens: 32768,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-sonnet-4.6", {
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-opus-4.5", {
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-sonnet-4.5", {
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-sonnet-4", {
    maxTokens: 65536,
    thinking: KIRO_THINKING
  }),
  createBootstrapModel("claude-haiku-4.5", {
    reasoning: false,
    maxTokens: 65536
  }),
  createBootstrapModel("gpt-5.6-sol", { thinking: KIRO_THINKING }),
  createBootstrapModel("gpt-5.6-terra", { thinking: KIRO_THINKING }),
  createBootstrapModel("gpt-5.6-luna", { thinking: KIRO_THINKING }),
  createBootstrapModel("deepseek-3.2", { thinking: KIRO_THINKING }),
  createBootstrapModel("minimax-m2.5", { reasoning: false }),
  createBootstrapModel("minimax-m2.1", { reasoning: false }),
  createBootstrapModel("glm-5", { thinking: KIRO_THINKING }),
  createBootstrapModel("qwen3-coder-next", { thinking: KIRO_THINKING })
];
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function effortEnumValues(schema, field) {
  const properties = asRecord(asRecord(schema)?.properties);
  const fieldSchema = asRecord(properties?.[field]);
  const effortSchema = asRecord(asRecord(fieldSchema?.properties)?.effort);
  return Array.isArray(effortSchema?.enum) ? effortSchema.enum.filter((value) => typeof value === "string") : [];
}
function dynamicThinking(schema) {
  if (!schema)
    return;
  const usesOutputConfig = effortEnumValues(schema, "output_config").length > 0 && effortEnumValues(schema, "reasoning").length === 0;
  return { ...KIRO_THINKING, mode: usesOutputConfig ? "budget" : "effort" };
}
function mapKiroCatalogToProviderModelConfigs(catalog, region) {
  const seen = new Set;
  return catalog.map((model) => {
    const id = model.modelId.trim();
    if (!id || seen.has(id))
      throw new Error(`Kiro management catalog contains duplicate model ID ${id}`);
    seen.add(id);
    const existing = KIRO_MODELS.find((candidate) => candidate.id === id);
    const limits = model.tokenLimits;
    const schema = model.additionalModelRequestFieldsSchema;
    return {
      ...existing ?? createBootstrapModel(id),
      id,
      name: model.displayName?.trim() || existing?.name || id,
      api: KIRO_API,
      baseUrl: getKiroEndpoints(region).runtime,
      reasoning: schema !== undefined ? true : existing?.reasoning ?? isReasoningModel(id),
      contextWindow: limits?.maxInputTokens ?? existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: limits?.maxOutputTokens ?? existing?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...schema !== undefined ? { thinking: dynamicThinking(schema) } : {}
    };
  });
}

// src/device-code.ts
var CANCEL_MESSAGE = "Login cancelled";
var TIMEOUT_MESSAGE = "Device flow timed out";
var SLOW_DOWN_TIMEOUT_MESSAGE = "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
var MINIMUM_INTERVAL_MS = 1000;
var DEFAULT_POLL_INTERVAL_SECONDS = 5;
var SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;
function abortableSleep(ms, signal, cancelMessage) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error(cancelMessage));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollOAuthDeviceCodeFlow(options) {
  const deadline = typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000));
  let slowDownResponses = 0;
  if (options.waitBeforeFirstPoll) {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
    }
  }
  while (Date.now() < deadline) {
    if (options.signal.aborted) {
      throw new Error(CANCEL_MESSAGE);
    }
    const result = await options.poll();
    if (result.status === "complete") {
      return result.value;
    }
    if (result.status === "failed") {
      throw new Error(result.message);
    }
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      intervalMs = typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0 ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000)) : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
  }
  throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}

// src/oauth.ts
var BUILDER_ID_START_URL = "https://view.awsapps.com/start";
var DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
var REFRESH_GRANT = "refresh_token";
var SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist"
];
var REGION_PROBES = [
  "us-east-1",
  "eu-west-1",
  "eu-central-1",
  "us-east-2",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "us-west-2"
];
var LOGIN_REQUEST_TIMEOUT_MS = 15000;
var TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
var USER_AGENT = "omp-kiro";
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function getField(response, camel, snake) {
  const camelValue = response[camel];
  if (camelValue !== undefined)
    return camelValue;
  return response[snake];
}
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
async function registerAndAuthorize(startUrl, region, fetchFn, signal) {
  const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;
  const registerResponse = await fetchFn(`${oidcEndpoint}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      clientName: USER_AGENT,
      clientType: "public",
      scopes: SSO_SCOPES,
      grantTypes: [DEVICE_CODE_GRANT, REFRESH_GRANT]
    }),
    signal: requestSignal(signal)
  });
  if (!registerResponse.ok)
    return;
  const registration = await readJson(registerResponse);
  const clientId = getField(registration, "clientId", "client_id");
  const clientSecret = getField(registration, "clientSecret", "client_secret");
  if (!clientId || !clientSecret)
    return;
  const deviceResponse = await fetchFn(`${oidcEndpoint}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
    signal: requestSignal(signal)
  });
  if (!deviceResponse.ok)
    return;
  const raw = await readJson(deviceResponse);
  const deviceCode = getField(raw, "deviceCode", "device_code");
  const userCode = getField(raw, "userCode", "user_code");
  const verificationUri = getField(raw, "verificationUri", "verification_uri");
  const verificationUriComplete = getField(raw, "verificationUriComplete", "verification_uri_complete");
  const interval = Number(getField(raw, "interval", "interval") ?? 5);
  const expiresIn = Number(getField(raw, "expiresIn", "expires_in") ?? 600);
  if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete || !Number.isFinite(interval) || !Number.isFinite(expiresIn)) {
    return;
  }
  return {
    clientId,
    clientSecret,
    device: {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      interval: Math.max(1, interval),
      expiresIn: Math.max(1, expiresIn)
    }
  };
}
async function beginDeviceAuthorization(startUrl, preferredRegion, fetchFn, signal) {
  const regions = preferredRegion ? [preferredRegion] : [...REGION_PROBES];
  for (const region of regions) {
    try {
      const result = await registerAndAuthorize(startUrl, region, fetchFn, signal);
      if (result)
        return { region, ...result };
    } catch (error) {
      if (signal?.aborted)
        throw error;
    }
  }
  throw new Error("Could not find an AWS Identity Center region for the supplied start URL");
}
async function pollForToken(flow, fetchFn, signal) {
  return pollOAuthDeviceCodeFlow({
    intervalSeconds: flow.device.interval,
    expiresInSeconds: flow.device.expiresIn,
    signal: signal ?? new AbortController().signal,
    poll: async () => {
      const response = await fetchFn(`https://oidc.${flow.region}.amazonaws.com/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          clientId: flow.clientId,
          clientSecret: flow.clientSecret,
          deviceCode: flow.device.deviceCode,
          grantType: DEVICE_CODE_GRANT
        }),
        signal: requestSignal(signal)
      });
      const data = await readJson(response);
      const error = data.error;
      if (response.ok && !error) {
        const access = data.accessToken ?? data.access_token;
        const refresh = data.refreshToken ?? data.refresh_token;
        const expiresIn = Number(data.expiresIn ?? data.expires_in);
        if (!access || !refresh || !Number.isFinite(expiresIn)) {
          return { status: "failed", message: "Kiro token response was missing required fields" };
        }
        return {
          status: "complete",
          value: {
            access,
            refresh: `${refresh}|${flow.clientId}|${flow.clientSecret}|idc|${flow.region}`,
            expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            region: flow.region,
            authMethod: "idc"
          }
        };
      }
      if (error === "authorization_pending")
        return { status: "pending" };
      if (error === "slow_down")
        return { status: "slow_down" };
      return {
        status: "failed",
        message: `Kiro authorization failed${error ? `: ${error}` : ` (HTTP ${response.status})`}`
      };
    }
  });
}
async function loginKiro(callbacks) {
  if (callbacks.signal?.aborted)
    throw new Error("Login cancelled");
  const startUrlInput = (await callbacks.onPrompt({
    message: "Paste your IAM Identity Center start URL, or leave blank for AWS Builder ID",
    placeholder: BUILDER_ID_START_URL,
    allowEmpty: true
  }))?.trim() ?? "";
  if (callbacks.signal?.aborted)
    throw new Error("Login cancelled");
  const startUrl = startUrlInput || BUILDER_ID_START_URL;
  if (!/^https?:\/\//i.test(startUrl))
    throw new Error("Kiro start URL must be an http(s) URL");
  let preferredRegion;
  if (startUrl !== BUILDER_ID_START_URL) {
    const regionInput = await callbacks.onPrompt({
      message: "AWS Identity Center region (leave blank to auto-detect)",
      placeholder: "us-east-1",
      allowEmpty: true
    }) ?? "";
    preferredRegion = regionInput.trim() || undefined;
  }
  const fetchFn = callbacks.fetch ?? globalThis.fetch;
  const flow = await beginDeviceAuthorization(startUrl, preferredRegion, fetchFn, callbacks.signal);
  callbacks.onAuth({
    url: flow.device.verificationUriComplete,
    instructions: `Open ${flow.device.verificationUri} and enter your code: ${flow.device.userCode}`
  });
  callbacks.onProgress?.(`Waiting for Kiro authorization in ${flow.region}...`);
  return pollForToken(flow, fetchFn, callbacks.signal);
}
function parseRefreshCredential(credential) {
  const kiroCredential = credential;
  const parts = credential.refresh.split("|");
  const refreshToken = parts[0];
  const clientId = kiroCredential.clientId ?? parts[1];
  const clientSecret = kiroCredential.clientSecret ?? parts[2];
  const region = kiroCredential.region ?? (parts[3] === "idc" ? parts[4] : undefined);
  if (!refreshToken || !clientId || !clientSecret || !region) {
    throw new Error("Kiro OAuth credential is missing Identity Center refresh metadata; run /login again");
  }
  return { refreshToken, clientId, clientSecret, region };
}
async function refreshKiroToken(credential) {
  const { refreshToken, clientId, clientSecret, region } = parseRefreshCredential(credential);
  const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: REFRESH_GRANT }),
    signal: requestSignal(undefined)
  });
  const data = await readJson(response);
  if (!response.ok)
    throw new Error(`Kiro token refresh failed (HTTP ${response.status})`);
  const access = data.accessToken ?? data.access_token;
  const refresh = data.refreshToken ?? data.refresh_token ?? refreshToken;
  const expiresIn = Number(data.expiresIn ?? data.expires_in);
  if (!access || !Number.isFinite(expiresIn))
    throw new Error("Kiro token refresh response was missing required fields");
  return {
    access,
    refresh: `${refresh}|${clientId}|${clientSecret}|idc|${region}`,
    expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: credential.profileArn
  };
}
function getKiroApiKey(credential) {
  const kiroCredential = credential;
  return JSON.stringify({
    token: credential.access,
    region: kiroCredential.region,
    profileArn: kiroCredential.profileArn
  });
}
var kiroOAuth = {
  name: "Kiro (AWS Builder ID / IAM Identity Center plugin)",
  login: loginKiro,
  refreshToken: refreshKiroToken,
  getApiKey: getKiroApiKey
};

// src/assistant-stream.ts
class LocalAssistantMessageEventStream {
  #queue = [];
  #waiting = [];
  #finalResult;
  #resolveFinalResult;
  #rejectFinalResult;
  #done = false;
  #failed = false;
  #error;
  #resultSettled = false;
  #pendingLocalWork = 0;
  constructor() {
    const result = Promise.withResolvers();
    this.#finalResult = result.promise;
    this.#resolveFinalResult = result.resolve;
    this.#rejectFinalResult = result.reject;
    this.#finalResult.catch(() => {});
  }
  push(event) {
    if (this.#done)
      return;
    if (event.type === "done" || event.type === "error") {
      this.#done = true;
      this.#resultSettled = true;
      this.#resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    this.#deliver(event);
  }
  end(result) {
    this.#done = true;
    if (result !== undefined && !this.#resultSettled) {
      this.#resultSettled = true;
      this.#resolveFinalResult(result);
    } else if (!this.#resultSettled) {
      this.#resultSettled = true;
      this.#rejectFinalResult(new Error("Stream ended without a final result"));
    }
    this.#finishWaiting();
  }
  fail(error) {
    if (this.#done)
      return;
    this.#done = true;
    this.#failed = true;
    this.#error = error;
    this.#resultSettled = true;
    this.#rejectFinalResult(error);
    while (this.#waiting.length > 0)
      this.#waiting.shift().reject(error);
  }
  result() {
    return this.#finalResult;
  }
  get hasPendingLocalWork() {
    return this.#pendingLocalWork > 0;
  }
  async trackLocalWork(work) {
    this.#pendingLocalWork += 1;
    try {
      return await work;
    } finally {
      this.#pendingLocalWork -= 1;
    }
  }
  async* [Symbol.asyncIterator]() {
    while (true) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#failed)
        throw this.#error;
      if (this.#done)
        return;
      const next = await new Promise((resolve, reject) => {
        this.#waiting.push({ resolve, reject });
      });
      if (next.done)
        return;
      yield next.value;
    }
  }
  #deliver(event) {
    const waiter = this.#waiting.shift();
    if (waiter)
      waiter.resolve({ value: event, done: false });
    else
      this.#queue.push(event);
  }
  #finishWaiting() {
    while (this.#waiting.length > 0) {
      this.#waiting.shift().resolve({ value: undefined, done: true });
    }
  }
}
function createAssistantMessageEventStream() {
  return new LocalAssistantMessageEventStream;
}

// src/eventstream.ts
var PRELUDE_LENGTH = 12;
var MESSAGE_CRC_LENGTH = 4;
var MIN_MESSAGE_LENGTH = PRELUDE_LENGTH + MESSAGE_CRC_LENGTH;
var CRC_TABLE = new Uint32Array(256);
for (let index = 0;index < CRC_TABLE.length; index++) {
  let value = index;
  for (let bit = 0;bit < 8; bit++)
    value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}
function crc32(bytes) {
  let value = 4294967295;
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 4294967295) >>> 0;
}
function decodeKiroEventStreamMessage(frame) {
  if (frame.length < MIN_MESSAGE_LENGTH)
    throw new Error("Kiro event stream frame is too short");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  if (totalLength !== frame.length) {
    throw new Error(`Kiro event stream framed length ${totalLength} does not match ${frame.length}`);
  }
  if (headersLength > totalLength - MIN_MESSAGE_LENGTH) {
    throw new Error("Kiro event stream header block exceeds frame");
  }
  if (crc32(frame.subarray(0, 8)) !== view.getUint32(8, false)) {
    throw new Error("Kiro event stream prelude CRC mismatch");
  }
  if (crc32(frame.subarray(0, totalLength - MESSAGE_CRC_LENGTH)) !== view.getUint32(totalLength - 4, false)) {
    throw new Error("Kiro event stream message CRC mismatch");
  }
  const headersStart = PRELUDE_LENGTH;
  const headersEnd = headersStart + headersLength;
  return {
    headers: parseKiroEventStreamHeaders(frame.subarray(headersStart, headersEnd)),
    payload: frame.subarray(headersEnd, totalLength - MESSAGE_CRC_LENGTH)
  };
}
function parseKiroEventStreamHeaders(bytes) {
  const result = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder;
  let offset = 0;
  const requireBytes = (count) => {
    if (offset + count > bytes.length)
      throw new Error("Truncated Kiro event stream headers");
  };
  while (offset < bytes.length) {
    requireBytes(1);
    const nameLength = view.getUint8(offset++);
    requireBytes(nameLength + 1);
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = view.getUint8(offset++);
    switch (type) {
      case 0:
        result[name] = "true";
        break;
      case 1:
        result[name] = "false";
        break;
      case 2:
        requireBytes(1);
        result[name] = String(view.getInt8(offset++));
        break;
      case 3:
        requireBytes(2);
        result[name] = String(view.getInt16(offset, false));
        offset += 2;
        break;
      case 4:
        requireBytes(4);
        result[name] = String(view.getInt32(offset, false));
        offset += 4;
        break;
      case 5:
        requireBytes(8);
        result[name] = readSignedBigEndian(bytes.subarray(offset, offset + 8)).toString();
        offset += 8;
        break;
      case 6: {
        requireBytes(2);
        const length = view.getUint16(offset, false);
        offset += 2;
        requireBytes(length);
        const headerBytes = bytes.subarray(offset, offset + length);
        let binary = "";
        for (const byte of headerBytes)
          binary += String.fromCharCode(byte);
        result[name] = btoa(binary);
        offset += length;
        break;
      }
      case 7: {
        requireBytes(2);
        const length = view.getUint16(offset, false);
        offset += 2;
        requireBytes(length);
        result[name] = decoder.decode(bytes.subarray(offset, offset + length));
        offset += length;
        break;
      }
      case 8:
        requireBytes(8);
        result[name] = new Date(Number(readSignedBigEndian(bytes.subarray(offset, offset + 8)))).toISOString();
        offset += 8;
        break;
      case 9:
        requireBytes(16);
        result[name] = [...bytes.subarray(offset, offset + 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        offset += 16;
        break;
      default:
        throw new Error(`Unknown Kiro event stream header type ${type}`);
    }
  }
  return result;
}
function readSignedBigEndian(bytes) {
  let value = 0n;
  for (const byte of bytes)
    value = value << 8n | BigInt(byte);
  if (bytes.length === 8 && (bytes[0] & 128) !== 0)
    value -= 1n << 64n;
  return value;
}
async function* decodeKiroEventStream(source) {
  const reader = source.getReader();
  let buffer = new Uint8Array(0);
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value && value.length > 0) {
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;
      }
      let offset = 0;
      while (buffer.length - offset >= 4) {
        const totalLength = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
        if (totalLength < MIN_MESSAGE_LENGTH)
          throw new Error(`Invalid Kiro event stream length ${totalLength}`);
        if (buffer.length - offset < totalLength)
          break;
        yield decodeKiroEventStreamMessage(buffer.subarray(offset, offset + totalLength));
        offset += totalLength;
      }
      if (offset > 0)
        buffer = buffer.slice(offset);
      if (done)
        break;
    }
    if (buffer.length > 0)
      throw new Error("Truncated Kiro event stream message");
    completed = true;
  } finally {
    if (!completed)
      await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// src/stream.ts
var EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";
var TOOL_RESULT_LIMIT = 250000;
var USER_AGENT2 = "omp-kiro/1.0";
function asRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function parseKiroEvent(payload) {
  const parsed = asRecord2(payload);
  if (!parsed)
    return;
  if (typeof parsed.content === "string")
    return { type: "content", data: parsed.content };
  if (typeof parsed.text === "string")
    return { type: "thinkingText", data: parsed.text };
  if (typeof parsed.signature === "string")
    return { type: "thinkingSignature", data: parsed.signature };
  if (typeof parsed.name === "string" && typeof parsed.toolUseId === "string") {
    const inputRecord = asRecord2(parsed.input);
    const input = typeof parsed.input === "string" ? parsed.input : inputRecord && Object.keys(inputRecord).length > 0 ? JSON.stringify(inputRecord) : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name,
        toolUseId: parsed.toolUseId,
        input,
        stop: parsed.stop === true
      }
    };
  }
  if (parsed.input !== undefined && typeof parsed.name !== "string") {
    return {
      type: "toolUseInput",
      data: {
        input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input)
      }
    };
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
    return { type: "toolUseStop", data: { stop: parsed.stop === true } };
  }
  if (typeof parsed.contextUsagePercentage === "number") {
    return {
      type: "contextUsage",
      data: { contextUsagePercentage: parsed.contextUsagePercentage }
    };
  }
  const rawUsage = asRecord2(parsed.usage);
  if (rawUsage) {
    return {
      type: "usage",
      data: {
        inputTokens: typeof rawUsage.inputTokens === "number" ? rawUsage.inputTokens : undefined,
        outputTokens: typeof rawUsage.outputTokens === "number" ? rawUsage.outputTokens : undefined
      }
    };
  }
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const rawError = parsed.error ?? parsed.Error ?? "unknown";
    return {
      type: "error",
      data: {
        error: typeof rawError === "string" ? rawError : JSON.stringify(rawError),
        message: typeof parsed.message === "string" ? parsed.message : typeof parsed.reason === "string" ? parsed.reason : undefined
      }
    };
  }
  return;
}
function textContent(message) {
  if (message.role === "user" || message.role === "developer") {
    return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  if (message.role === "toolResult") {
    return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function imagesFromMessage(message) {
  if (message.role === "toolResult" || typeof message.content === "string")
    return [];
  return message.content.filter((block) => block.type === "image");
}
function toKiroImages(images) {
  return images.map((image) => ({
    format: image.mimeType.split("/", 2)[1] || "png",
    source: { bytes: image.data }
  }));
}
function toKiroTools(tools) {
  return tools?.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.parameters
      }
    }
  }));
}
function truncate(value) {
  return value.length <= TOOL_RESULT_LIMIT ? value : value.slice(0, TOOL_RESULT_LIMIT);
}
function toKiroToolUse(block) {
  let input;
  if (typeof block.arguments === "string") {
    try {
      input = JSON.parse(block.arguments);
    } catch {
      input = {};
    }
  } else {
    input = block.arguments;
  }
  return { name: block.name, toolUseId: block.id, input };
}
function assistantHistoryEntry(message) {
  if (message.role !== "assistant")
    return;
  let content = "";
  const toolUses = [];
  for (const block of message.content) {
    if (block.type === "text")
      content += block.text;
    if (block.type === "toolCall")
      toolUses.push(toKiroToolUse(block));
  }
  if (!content && toolUses.length === 0 && message.content.length === 0)
    return;
  return {
    assistantResponseMessage: {
      content,
      ...toolUses.length > 0 ? { toolUses } : {}
    }
  };
}
function addToolResults(entry, messages, modelId) {
  const results = messages.map((message) => ({
    content: [{ text: truncate(textContent(message)) }],
    status: message.isError ? "error" : "success",
    toolUseId: message.toolCallId
  }));
  if (entry?.userInputMessage) {
    entry.userInputMessage.userInputMessageContext ??= {};
    entry.userInputMessage.userInputMessageContext.toolResults = [
      ...entry.userInputMessage.userInputMessageContext.toolResults ?? [],
      ...results
    ];
    return entry;
  }
  return {
    userInputMessage: {
      content: "",
      modelId,
      origin: "KIRO_CLI",
      userInputMessageContext: { toolResults: results }
    }
  };
}
function buildHistory(messages, modelId, systemPrompt) {
  if (messages.length === 0)
    return { history: [], currentMessages: [] };
  let currentStart = messages.length - 1;
  while (currentStart > 0 && messages[currentStart]?.role === "toolResult")
    currentStart--;
  const currentCandidate = messages[currentStart];
  if (currentCandidate?.role === "assistant" && !currentCandidate.content.some((block) => block.type === "toolCall")) {
    currentStart++;
  }
  const historyMessages = messages.slice(0, currentStart);
  const history = [];
  let systemAdded = false;
  for (let index = 0;index < historyMessages.length; index++) {
    const message = historyMessages[index];
    if (!message)
      continue;
    if (message.role === "user" || message.role === "developer") {
      let content = textContent(message);
      if (systemPrompt?.length && !systemAdded) {
        content = `${systemPrompt.join(`

`)}

${content}`;
        systemAdded = true;
      }
      const images = imagesFromMessage(message);
      const previous = history.at(-1)?.userInputMessage;
      if (previous) {
        previous.content = previous.content && content ? `${previous.content}

${content}` : previous.content || content;
        if (images.length > 0)
          previous.images = [
            ...previous.images ?? [],
            ...toKiroImages(images)
          ];
      } else {
        history.push({
          userInputMessage: {
            content,
            modelId,
            origin: "KIRO_CLI",
            ...images.length > 0 ? { images: toKiroImages(images) } : {}
          }
        });
      }
    } else if (message.role === "assistant") {
      const entry = assistantHistoryEntry(message);
      if (entry)
        history.push(entry);
    } else if (message.role === "toolResult") {
      const results = [message];
      let next = index + 1;
      while (next < historyMessages.length && historyMessages[next]?.role === "toolResult") {
        results.push(historyMessages[next]);
        next++;
      }
      index = next - 1;
      const previous = history.at(-1);
      const carrier = previous?.userInputMessage ? previous : undefined;
      const nextEntry = addToolResults(carrier, results, modelId);
      if (!carrier)
        history.push(nextEntry);
    }
  }
  return { history, currentMessages: messages.slice(currentStart) };
}
function buildAdditionalModelRequestFields(model, reasoning) {
  if (!reasoning || !model.reasoning || !model.thinking)
    return;
  const requested = reasoning === "minimal" ? "low" : reasoning;
  const pick = (allowed) => allowed.includes(requested) ? requested : allowed.at(-1) ?? requested;
  const efforts = model.thinking.efforts.map((effort) => String(effort));
  if (model.thinking.mode === "budget") {
    return {
      output_config: { effort: pick(efforts) },
      thinking: { type: "adaptive", display: "summarized" }
    };
  }
  return { reasoning: { effort: pick(efforts) } };
}
function buildKiroRequest(model, context, profileArn, conversationId, reasoning) {
  const modelId = model.id;
  const { history, currentMessages } = buildHistory(context.messages, modelId, context.systemPrompt);
  const first = currentMessages[0];
  let content = "";
  let images = [];
  const toolResults = [];
  if (first?.role === "assistant") {
    const entry = assistantHistoryEntry(first);
    if (entry)
      history.push(entry);
    for (const message of currentMessages.slice(1))
      if (message.role === "toolResult")
        toolResults.push(message);
  } else if (first?.role === "toolResult") {
    for (const message of currentMessages)
      if (message.role === "toolResult")
        toolResults.push(message);
  } else if (first?.role === "user" || first?.role === "developer") {
    content = textContent(first);
    images = imagesFromMessage(first);
    if (context.systemPrompt?.length && history.length === 0)
      content = `${context.systemPrompt.join(`

`)}

${content}`;
  }
  const tools = toKiroTools(context.tools);
  const currentContext = {};
  if (tools && tools.length > 0)
    currentContext.tools = tools;
  if (toolResults.length > 0) {
    currentContext.toolResults = toolResults.map((message) => ({
      content: [{ text: truncate(textContent(message)) }],
      status: message.isError ? "error" : "success",
      toolUseId: message.toolCallId
    }));
  }
  if (!content && toolResults.length === 0)
    content = EMPTY_CONTENT_PLACEHOLDER;
  const userInputMessage = {
    content,
    modelId,
    origin: "KIRO_CLI",
    ...images.length > 0 ? { images: toKiroImages(images) } : {},
    ...Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}
  };
  const additionalModelRequestFields = buildAdditionalModelRequestFields(model, reasoning);
  return {
    profileArn,
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId,
      ...history.length > 0 ? { history } : {},
      currentMessage: { userInputMessage }
    },
    ...additionalModelRequestFields ? { additionalModelRequestFields } : {},
    agentMode: "vibe"
  };
}
function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
function findHeader(headers, name) {
  if (!headers)
    return;
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1] ?? undefined;
}
function parseStructuredApiKey(apiKey) {
  if (!apiKey?.startsWith("{"))
    return { token: apiKey ?? "" };
  try {
    const parsed = JSON.parse(apiKey);
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return {
        token: parsed.token,
        region: typeof parsed.region === "string" ? parsed.region : undefined,
        profileArn: typeof parsed.profileArn === "string" ? parsed.profileArn : undefined
      };
    }
  } catch {}
  return { token: apiKey };
}
function appendText(output, stream, text, state) {
  if (!text)
    return;
  if (state.index === undefined) {
    state.index = output.content.length;
    output.content.push({ type: "text", text: "" });
    stream.push({
      type: "text_start",
      contentIndex: state.index,
      partial: output
    });
  }
  const block = output.content[state.index];
  if (block?.type !== "text")
    return;
  block.text += text;
  stream.push({
    type: "text_delta",
    contentIndex: state.index,
    delta: text,
    partial: output
  });
}
function endText(output, stream, state) {
  if (state.index === undefined)
    return;
  const block = output.content[state.index];
  if (block?.type === "text")
    stream.push({
      type: "text_end",
      contentIndex: state.index,
      content: block.text,
      partial: output
    });
  state.index = undefined;
}
function appendThinking(output, stream, text, state, textState) {
  if (!text)
    return;
  endText(output, stream, textState);
  if (state.index === undefined) {
    state.index = output.content.length;
    output.content.push({ type: "thinking", thinking: "" });
    stream.push({
      type: "thinking_start",
      contentIndex: state.index,
      partial: output
    });
  }
  const block = output.content[state.index];
  if (block?.type !== "thinking")
    return;
  block.thinking += text;
  stream.push({
    type: "thinking_delta",
    contentIndex: state.index,
    delta: text,
    partial: output
  });
}
function endThinking(output, stream, state) {
  if (state.index === undefined)
    return;
  const block = output.content[state.index];
  if (block?.type === "thinking")
    stream.push({
      type: "thinking_end",
      contentIndex: state.index,
      content: block.thinking,
      partial: output
    });
  state.index = undefined;
}
function emitToolCall(output, stream, call) {
  const input = call.input.trim() || "{}";
  let argumentsValue;
  try {
    argumentsValue = JSON.parse(input);
  } catch {
    argumentsValue = {};
  }
  const toolCall = {
    type: "toolCall",
    id: call.toolUseId,
    name: call.name,
    arguments: argumentsValue
  };
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({
    type: "toolcall_delta",
    contentIndex,
    delta: input,
    partial: output
  });
  stream.push({
    type: "toolcall_end",
    contentIndex,
    toolCall,
    partial: output
  });
  return true;
}
async function fetchKiroModelsForCredential(credential, signal) {
  const region = resolveKiroApiRegion(credential.region);
  const { profileArn, response } = await fetchKiroModelCatalog({ accessToken: credential.access, region }, credential.profileArn, globalThis.fetch, signal);
  return mapKiroCatalogToProviderModelConfigs(response.models, region).map((model) => ({
    ...model,
    headers: { ...model.headers, "x-amzn-kiro-profile-arn": profileArn }
  }));
}
function streamKiro(model, context, options = {}) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now()
    };
    try {
      const structured = parseStructuredApiKey(typeof options.apiKey === "string" ? options.apiKey : undefined);
      if (!structured.token)
        throw new Error("Kiro credentials not set. Run /login kiro.");
      const region = resolveKiroApiRegion(structured.region ?? getKiroRegionFromEndpoint(model.baseUrl));
      const fetchFn = options.fetch ?? globalThis.fetch;
      const profileArn = await resolveKiroProfileArn({ accessToken: structured.token, region }, structured.profileArn ?? findHeader(model.headers, "x-amzn-kiro-profile-arn") ?? findHeader(options.headers, "x-amzn-kiro-profile-arn"), fetchFn, options.signal);
      const simpleOptions = options;
      const request = buildKiroRequest(model, context, profileArn, simpleOptions.sessionId ?? crypto.randomUUID(), simpleOptions.reasoning);
      const payload = await options.onPayload?.(request, model) ?? request;
      const endpoint = new URL("generateAssistantResponse", `https://runtime.${region}.kiro.dev/`).toString();
      const requestId = crypto.randomUUID();
      const userAgent = `${USER_AGENT2} ${requestId}`;
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          ...model.headers ?? {},
          ...options.headers ?? {},
          "Content-Type": "application/json",
          Accept: "application/vnd.amazon.eventstream",
          Authorization: `Bearer ${structured.token}`,
          "x-amzn-codewhisperer-optout": "true",
          "amz-sdk-invocation-id": requestId,
          "amz-sdk-request": "attempt=1; max=1",
          "x-amzn-kiro-agent-mode": "vibe",
          "x-amz-user-agent": userAgent,
          "user-agent": userAgent
        },
        body: JSON.stringify(payload),
        signal: options.signal
      });
      if (!response.ok) {
        output.errorStatus = response.status;
        throw new Error(`Kiro API request failed (HTTP ${response.status})`);
      }
      if (!response.body)
        throw new Error("Kiro API returned no event stream body");
      stream.push({ type: "start", partial: output });
      const textState = {};
      const thinkingState = {};
      let activeTool;
      let emittedToolCalls = 0;
      let receivedContextUsage = false;
      let usageEvent;
      for await (const frame of decodeKiroEventStream(response.body)) {
        const payloadText = new TextDecoder().decode(frame.payload);
        let payload2;
        try {
          payload2 = JSON.parse(payloadText);
        } catch {
          continue;
        }
        const event = parseKiroEvent(payload2);
        if (!event)
          continue;
        switch (event.type) {
          case "content":
            endThinking(output, stream, thinkingState);
            appendText(output, stream, event.data, textState);
            break;
          case "thinkingText":
            if (model.reasoning)
              appendThinking(output, stream, event.data, thinkingState, textState);
            break;
          case "thinkingSignature": {
            const block = thinkingState.index !== undefined ? output.content[thinkingState.index] : undefined;
            if (block?.type === "thinking")
              block.thinkingSignature = event.data;
            endThinking(output, stream, thinkingState);
            break;
          }
          case "toolUse":
            if (!activeTool || activeTool.toolUseId !== event.data.toolUseId) {
              if (activeTool)
                emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
              activeTool = {
                name: event.data.name,
                toolUseId: event.data.toolUseId,
                input: ""
              };
            }
            activeTool.input += event.data.input;
            if (event.data.stop) {
              emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
              activeTool = undefined;
            }
            break;
          case "toolUseInput":
            if (activeTool)
              activeTool.input += event.data.input;
            break;
          case "toolUseStop":
            if (event.data.stop && activeTool) {
              emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
              activeTool = undefined;
            }
            break;
          case "contextUsage":
            if (typeof model.contextWindow === "number") {
              output.usage.input = Math.round(event.data.contextUsagePercentage / 100 * model.contextWindow);
            }
            receivedContextUsage = true;
            break;
          case "usage":
            usageEvent = event.data;
            break;
          case "error":
            throw new Error(`Kiro API stream error: ${event.data.error}${event.data.message ? `: ${event.data.message}` : ""}`);
        }
      }
      if (activeTool)
        emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
      endThinking(output, stream, thinkingState);
      endText(output, stream, textState);
      output.usage.input = usageEvent?.inputTokens ?? output.usage.input;
      output.usage.output = usageEvent?.outputTokens ?? 0;
      output.usage.totalTokens = output.usage.input + output.usage.output;
      if (!receivedContextUsage && output.usage.input === 0)
        output.usage.input = context.messages.length;
      output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof Response)
        output.errorStatus = error.status;
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      stream.end();
    }
  })();
  return stream;
}

// src/provider.ts
var KIRO_PROVIDER_ID = "kiro";
function createKiroProviderConfig() {
  return {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: KIRO_API,
    oauth: {
      name: kiroOAuth.name,
      login: kiroOAuth.login,
      refreshToken: kiroOAuth.refreshToken,
      getApiKey: kiroOAuth.getApiKey
    },
    streamSimple: streamKiro,
    fetchDynamicModels: async (apiKey) => {
      const structured = parseStructuredApiKey(apiKey);
      if (!structured.token) {
        return KIRO_MODELS.map((model) => ({ ...model }));
      }
      return fetchKiroModelsForCredential({
        access: structured.token,
        region: structured.region,
        profileArn: structured.profileArn
      });
    }
  };
}

// src/extension.ts
function registerKiro(pi) {
  pi.registerProvider(KIRO_PROVIDER_ID, createKiroProviderConfig());
}
export {
  registerKiro as default,
  createKiroProviderConfig,
  KIRO_PROVIDER_ID
};
