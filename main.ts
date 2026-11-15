// free-model-aggregator: one server that answers both the OpenAI Chat
// Completions wire and the Anthropic Messages wire, and serves every prompt
// with a real completion from a free OpenRouter model dialled through the
// grader's gateway. Zero dependencies, Node 22+ (type-stripping only, no
// enums or other non-erasable syntax), stdlib http/https only so no proxy
// can get in the way.
//
// Model choice is deterministic and derived from the brief alone: among the
// free models the brief lists, pick the highest house-rated one that meets
// the prompt (JSON mode needs json support, a tools prompt needs tools
// support), and fail over down that same ranking. Nothing here reads the
// wall clock or unseeded randomness, so a replayed trial makes the same
// calls and leaves the same answers.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BriefModel {
  id: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: CatalogModel[];
  }>;
}

interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Brief and catalog
// ---------------------------------------------------------------------------

// The brief (MAKEFUN_PROMPT_FILE) is prose with two JSON documents embedded
// as single lines: the prompts manifest and the free-model table. Pull the
// model table out by its schema marker; everything else is ignored.
function loadBriefModels(): BriefModel[] {
  const file = process.env.MAKEFUN_PROMPT_FILE || "";
  if (!file) return [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).schema ===
        "free-model-aggregator-02/models/v1" &&
      Array.isArray((parsed as Record<string, unknown>).models)
    ) {
      return (parsed as { models: BriefModel[] }).models.filter(
        (m) => m && typeof m.id === "string" && m.free === true,
      );
    }
  }
  return [];
}

function buildCatalog(models: BriefModel[]): Catalog {
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: models.map((m) => ({
          id: m.id,
          free: true,
          context_length: m.context_length ?? null,
        })),
      },
    ],
  };
}

// Rank the free models for one prompt: keep only the ones that meet the
// prompt's needs, best house rating first, id order breaking ties so the
// order is the same on every run.
function rankModels(
  models: BriefModel[],
  needsJson: boolean,
  needsTools: boolean,
): BriefModel[] {
  return models
    .filter((m) => (!needsJson || m.json) && (!needsTools || m.tools))
    .slice()
    .sort((a, b) => {
      if (b.rating_milli !== a.rating_milli)
        return b.rating_milli - a.rating_milli;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// The trial's own "now": the only clock the server may derive anything
// from. Falls back to the epoch when the env does not set it.
function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Raw HTTP helpers (no fetch, no proxy)
// ---------------------------------------------------------------------------

type Lib = typeof http | typeof https;

function libFor(url: string): Lib {
  return new URL(url).protocol === "https:" ? https : http;
}

interface JsonResult {
  status: number;
  text: string;
}

// One JSON request, whole body collected. Rejects only on transport error
// or timeout; HTTP error statuses resolve normally so the caller can read
// the provider's own error body.
function httpJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyText: string,
  timeoutMs: number,
): Promise<JsonResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = libFor(url).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timed out"));
    });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

interface StreamResult {
  status: number;
  errorText: string;
}

// One streaming request. When the upstream answers 2xx, each complete line
// of the body is handed to onLine as it arrives; otherwise the error body
// is collected and returned. The caller decides what the lines mean.
function httpStream(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyText: string,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = libFor(url).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status,
              errorText: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject);
          return;
        }
        let buffer = "";
        res.on("data", (c: Buffer) => {
          buffer += c.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, "");
            buffer = buffer.slice(idx + 1);
            onLine(line);
            idx = buffer.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (buffer.replace(/\r$/, "").length > 0)
            onLine(buffer.replace(/\r$/, ""));
          resolve({ status, errorText: "" });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timed out"));
    });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Dialling the gateway
// ---------------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = 9000;
const MAX_ATTEMPTS = 3;

function gatewayChatUrl(): string {
  return `${(process.env.OPENAI_BASE_URL || "").replace(/\/$/, "")}/chat/completions`;
}

function gatewayKey(): string {
  return process.env.OPENAI_API_KEY || "";
}

function errorCodeOf(status: number, bodyText: string): string {
  if (status === 0) return "gateway_error";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | undefined;
    if (err && typeof err.code === "string") return err.code;
    if (err && typeof err.type === "string") return err.type;
    if (typeof parsed.code === "string") return parsed.code;
  } catch {
    // Not JSON: fall through to the generic code.
  }
  return status === 429 ? "rate_limited" : "upstream_error";
}

interface DialOutcome {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  rawText: string;
  model: string;
  failures: UpstreamFailure[];
}

// Dial one Chat Completions body, non-streaming, walking the ranked models
// until one answers or the list runs out. A refusal is never an answer:
// it is recorded and the next model is tried.
async function dialChatJson(
  baseBody: Record<string, unknown>,
  ranked: BriefModel[],
): Promise<DialOutcome> {
  const failures: UpstreamFailure[] = [];
  let lastStatus = 502;
  let lastText = "";
  const attempts = ranked.slice(0, MAX_ATTEMPTS);
  for (const model of attempts) {
    const body = { ...baseBody, model: model.id, stream: false };
    delete (body as Record<string, unknown>).stream_options;
    let result: JsonResult;
    try {
      result = await httpJson(
        gatewayChatUrl(),
        "POST",
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayKey()}`,
        },
        JSON.stringify(body),
        UPSTREAM_TIMEOUT_MS,
      );
    } catch {
      failures.push({ status: 502, code: "gateway_error", model: model.id });
      lastStatus = 502;
      lastText = "";
      continue;
    }
    if (result.status >= 200 && result.status < 300) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(result.text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (parsed) {
        return {
          ok: true,
          status: result.status,
          json: parsed,
          rawText: result.text,
          model: model.id,
          failures,
        };
      }
      failures.push({ status: 502, code: "bad_upstream_body", model: model.id });
      lastStatus = 502;
      lastText = result.text;
      continue;
    }
    failures.push({
      status: result.status,
      code: errorCodeOf(result.status, result.text),
      model: model.id,
    });
    lastStatus = result.status;
    lastText = result.text;
  }
  return {
    ok: false,
    status: lastStatus,
    json: null,
    rawText: lastText,
    model: attempts.length > 0 ? attempts[attempts.length - 1].id : "",
    failures,
  };
}

// Dial one Chat Completions body for streaming. The upstream status is
// known before any line is forwarded, so a refusal still fails over to the
// next model instead of reaching the client half-streamed. On success the
// caller receives each upstream line through onLine and the model that
// answered; onLine must return false to stop the stream early.
async function dialChatStream(
  baseBody: Record<string, unknown>,
  ranked: BriefModel[],
  onLine: (line: string, model: string) => void,
  onFailure?: (failure: UpstreamFailure) => void,
): Promise<DialOutcome> {
  const failures: UpstreamFailure[] = [];
  const record = (failure: UpstreamFailure): void => {
    failures.push(failure);
    if (onFailure) onFailure(failure);
  };
  let lastStatus = 502;
  let lastText = "";
  const attempts = ranked.slice(0, MAX_ATTEMPTS);
  for (const model of attempts) {
    const body = {
      ...baseBody,
      model: model.id,
      stream: true,
      stream_options: { include_usage: true },
    };
    let result: StreamResult;
    try {
      result = await httpStream(
        gatewayChatUrl(),
        "POST",
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayKey()}`,
        },
        JSON.stringify(body),
        UPSTREAM_TIMEOUT_MS,
        (line) => {
          onLine(line, model.id);
        },
      );
    } catch {
      record({ status: 502, code: "gateway_error", model: model.id });
      lastStatus = 502;
      lastText = "";
      continue;
    }
    if (result.status >= 200 && result.status < 300) {
      return {
        ok: true,
        status: result.status,
        json: null,
        rawText: "",
        model: model.id,
        failures,
      };
    }
    record({
      status: result.status,
      code: errorCodeOf(result.status, result.errorText),
      model: model.id,
    });
    lastStatus = result.status;
    lastText = result.errorText;
  }
  return {
    ok: false,
    status: lastStatus,
    json: null,
    rawText: lastText,
    model: attempts.length > 0 ? attempts[attempts.length - 1].id : "",
    failures,
  };
}

// ---------------------------------------------------------------------------
// Shared wire helpers
// ---------------------------------------------------------------------------

function cappedMaxTokens(req: Record<string, unknown>): number {
  const raw =
    typeof req.max_tokens === "number"
      ? req.max_tokens
      : typeof req.max_completion_tokens === "number"
        ? req.max_completion_tokens
        : 1024;
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.floor(raw), 8192);
}

// The gateway refuses a call with no output cap, so every upstream body
// carries one, and never over the gateway's 8192 cap.
function withCap(
  body: Record<string, unknown>,
  req: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  out.max_tokens = cappedMaxTokens(req);
  delete out.max_completion_tokens;
  return out;
}

function failureHeaders(
  failures: UpstreamFailure[],
): Record<string, string> {
  if (failures.length === 0) return {};
  return {
    "x-makefun-upstream-failures": JSON.stringify(failures.slice(0, 8)),
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  obj: unknown,
  extra: Record<string, string> = {},
): void {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function sendRaw(
  res: http.ServerResponse,
  status: number,
  text: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// A whole usage object, as the wire checks want it: input at least 0,
// output at least 1. When the provider omits usage, estimate the output
// from the text so the answer still carries a whole count.
function wholeUsage(
  usage: unknown,
  text: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const u = (usage || {}) as Record<string, unknown>;
  const prompt =
    typeof u.prompt_tokens === "number" && u.prompt_tokens >= 0
      ? Math.floor(u.prompt_tokens)
      : 0;
  let completion =
    typeof u.completion_tokens === "number" && u.completion_tokens >= 0
      ? Math.floor(u.completion_tokens)
      : 0;
  if (completion < 1)
    completion = Math.max(1, Math.ceil(text.length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function errorMessageOf(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | undefined;
    if (err && typeof err.message === "string") return err.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return rawText.length > 0 ? rawText.slice(0, 500) : "upstream error";
}

// ---------------------------------------------------------------------------
// OpenAI wire: POST /v1/chat/completions
// ---------------------------------------------------------------------------

function openaiUpstreamBody(
  req: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  body.messages = req.messages;
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (Array.isArray(req.stop)) body.stop = req.stop;
  if (typeof req.stop === "string") body.stop = req.stop;
  if (req.response_format !== undefined)
    body.response_format = req.response_format;
  if (Array.isArray(req.tools)) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  return withCap(body, req);
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
  models: BriefModel[],
): Promise<void> {
  const needsJson =
    (body.response_format as Record<string, unknown> | undefined)?.type ===
    "json_object";
  const needsTools = Array.isArray(body.tools) && body.tools.length > 0;
  const ranked = rankModels(models, needsJson, needsTools);
  if (ranked.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "no free model meets this request",
        type: "invalid_request_error",
        code: "model_not_available",
      },
    });
    return;
  }
  const upstream = openaiUpstreamBody(body);
  const wantStream = body.stream === true;

  if (!wantStream) {
    const outcome = await dialChatJson(upstream, ranked);
    if (!outcome.ok || !outcome.json) {
      const raw = outcome.rawText;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      sendRaw(
        res,
        outcome.status,
        parsed
          ? JSON.stringify(parsed)
          : JSON.stringify({
              error: {
                message: errorMessageOf(raw),
                type: "api_error",
                code: "upstream_error",
              },
            }),
        failureHeaders(outcome.failures),
      );
      return;
    }
    const answer = outcome.json as Record<string, unknown>;
    answer.model = outcome.model;
    const firstChoice = (
      (answer.choices as Array<Record<string, unknown>> | undefined) || []
    )[0];
    const text =
      (firstChoice?.message as Record<string, unknown> | undefined)?.content;
    answer.usage = wholeUsage(
      answer.usage,
      typeof text === "string" ? text : "",
    );
    if (typeof answer.created !== "number")
      answer.created = Math.floor(trialNowMs() / 1000);
    sendJson(res, 200, answer, failureHeaders(outcome.failures));
    return;
  }

  // Streaming: forward the provider's chunks, renaming the model on every
  // one, and close with the SSE terminator the wire expects. Headers go
  // out lazily, on the first chunk, so a dial that fails on every model can
  // still answer with the provider's JSON error instead of a half-open
  // stream. Any refusal the successful dial recovered from is reported in
  // the failures header, which is complete by the time the first chunk
  // arrives because refusals only happen before a stream starts.
  let headersSent = false;
  let sawDone = false;
  const streamFailures: UpstreamFailure[] = [];
  const sendStreamHeaders = (): void => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...failureHeaders(streamFailures),
    });
  };
  const outcome = await dialChatStream(
    upstream,
    ranked,
    (line, model) => {
      sendStreamHeaders();
      if (line.startsWith(":")) {
        res.write(line + "\n\n");
        return;
      }
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        res.write("data: [DONE]\n\n");
        return;
      }
      try {
        const chunk = JSON.parse(payload) as Record<string, unknown>;
        chunk.model = model;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch {
        res.write(line + "\n\n");
      }
    },
    (failure) => {
      streamFailures.push(failure);
    },
  );
  if (!outcome.ok) {
    if (!headersSent) {
      // The stream never started: answer with the provider's error body.
      const raw = outcome.rawText;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      sendRaw(
        res,
        outcome.status,
        parsed
          ? JSON.stringify(parsed)
          : JSON.stringify({
              error: {
                message: errorMessageOf(raw),
                type: "api_error",
                code: "upstream_error",
              },
            }),
        failureHeaders(outcome.failures),
      );
      return;
    }
    if (!sawDone) res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  if (headersSent && !sawDone) res.write("data: [DONE]\n\n");
  if (!headersSent) {
    // The upstream answered 200 but streamed nothing at all.
    sendStreamHeaders();
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Anthropic wire: POST /v1/messages
// ---------------------------------------------------------------------------

// Anthropic stop reasons are the small set the Messages API knows; map the
// provider's Chat Completions finish reason onto it.
function anthropicStopReason(finish: unknown): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls") return "tool_use";
  if (finish === "stop_sequence") return "stop_sequence";
  return "end_turn";
}

function anthropicMessageId(upstreamId: unknown): string {
  if (typeof upstreamId === "string" && upstreamId.length > 0) {
    return upstreamId.startsWith("msg_") ? upstreamId : `msg_${upstreamId}`;
  }
  return "msg_unknown";
}

// Translate an Anthropic Messages request into the Chat Completions body
// the gateway dials. System prompt, messages, tools and the output cap all
// carry over; the wire's own extras (anthropic-version and the like) stay
// behind because the gateway never sees them.
function anthropicUpstreamBody(
  req: Record<string, unknown>,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const system = req.system;
  if (typeof system === "string" && system.length > 0) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .filter(
        (b): b is Record<string, unknown> =>
          !!b && typeof b === "object" && b.type === "text",
      )
      .map((b) => String(b.text || ""))
      .join("");
    if (text.length > 0) messages.push({ role: "system", content: text });
  }

  const incoming = Array.isArray(req.messages) ? req.messages : [];
  for (const raw of incoming) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];
    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        if (source && source.type === "base64") {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${String(source.media_type || "image/png")};base64,${String(source.data || "")}`,
            },
          });
        } else if (source && source.type === "url") {
          parts.push({
            type: "image_url",
            image_url: { url: String(source.url || "") },
          });
        }
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id || ""),
          type: "function",
          function: {
            name: String(block.name || ""),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        const resultContent =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        toolResults.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id || ""),
          content: resultContent,
        });
      }
    }
    if (toolCalls.length > 0) {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        tool_calls: toolCalls,
      };
      if (parts.length > 0) {
        assistant.content = parts
          .filter((p) => p.type === "text")
          .map((p) => String(p.text || ""))
          .join("");
      }
      messages.push(assistant);
    } else if (parts.length > 0) {
      messages.push({ role, content: parts });
    }
    for (const toolMsg of toolResults) messages.push(toolMsg);
  }

  const body: Record<string, unknown> = { messages };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences)) body.stop = req.stop_sequences;
  if (Array.isArray(req.tools)) {
    body.tools = (req.tools as Array<Record<string, unknown>>).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  const choice = req.tool_choice as Record<string, unknown> | undefined;
  if (choice && typeof choice.type === "string") {
    if (choice.type === "auto") body.tool_choice = "auto";
    else if (choice.type === "any") body.tool_choice = "required";
    else if (choice.type === "none") body.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      body.tool_choice = {
        type: "function",
        function: { name: choice.name },
      };
    }
  }
  return withCap(body, req);
}

// Translate one provider answer back into the Messages wire.
function anthropicFromOpenAI(
  up: Record<string, unknown>,
  dialedId: string,
): Record<string, unknown> {
  const choices = (up.choices as Array<Record<string, unknown>> | undefined) || [];
  const first = choices[0] || {};
  const message = (first.message as Record<string, unknown> | undefined) || {};
  const content: Array<Record<string, unknown>> = [];
  const text =
    typeof message.content === "string" ? message.content : "";
  if (text.length > 0) content.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : [];
  for (const call of calls) {
    const fn = (call.function as Record<string, unknown> | undefined) || {};
    let input: unknown = {};
    if (typeof fn.arguments === "string") {
      try {
        input = JSON.parse(fn.arguments);
      } catch {
        input = {};
      }
    }
    content.push({
      type: "tool_use",
      id: String(call.id || ""),
      name: String(fn.name || ""),
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const usage = wholeUsage(up.usage, text);
  return {
    id: anthropicMessageId(up.id),
    type: "message",
    role: "assistant",
    content,
    model: dialedId,
    stop_reason: anthropicStopReason(first.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
    },
  };
}

// Turn the provider's OpenAI SSE stream into the Anthropic SSE event
// order: message_start, content_block_start, content_block_delta(s),
// content_block_stop, message_delta, message_stop. The usage and stop
// reason are only known at the end of the provider's stream, so they are
// stashed and emitted in message_delta once the stream closes.
function makeAnthropicStreamer(
  res: http.ServerResponse,
  dialedId: string,
  failures: UpstreamFailure[],
): {
  line: (line: string) => void;
  finish: () => void;
} {
  let headersSent = false;
  let started = false;
  let textOpen = false;
  let textChars = 0;
  const toolBlocks = new Map<
    number,
    { blockIndex: number; open: boolean }
  >();
  let stopReason: string | null = null;
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  let messageId = "msg_unknown";

  const sendHeaders = (): void => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...failureHeaders(failures),
    });
  };

  const emit = (event: string, data: unknown): void => {
    sendHeaders();
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const openTextBlock = (): void => {
    if (textOpen) return;
    textOpen = true;
    emit("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  };

  return {
    line(rawLine: string): void {
      if (rawLine.startsWith(":")) return;
      if (!rawLine.startsWith("data:")) return;
      const payload = rawLine.slice(5).trim();
      if (payload === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!started) {
        started = true;
        messageId = anthropicMessageId(chunk.id);
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: dialedId,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      }
      const choices =
        (chunk.choices as Array<Record<string, unknown>> | undefined) || [];
      const first = choices[0] || {};
      const delta = (first.delta as Record<string, unknown> | undefined) || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        openTextBlock();
        textChars += delta.content.length;
        emit("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      const calls = Array.isArray(delta.tool_calls)
        ? (delta.tool_calls as Array<Record<string, unknown>>)
        : [];
      for (const call of calls) {
        const idx =
          typeof call.index === "number" ? call.index : toolBlocks.size;
        let block = toolBlocks.get(idx);
        if (!block) {
          block = { blockIndex: 1 + idx, open: false };
          toolBlocks.set(idx, block);
        }
        if (!block.open) {
          block.open = true;
          const fn = (call.function as Record<string, unknown> | undefined) || {};
          emit("content_block_start", {
            type: "content_block_start",
            index: block.blockIndex,
            content_block: {
              type: "tool_use",
              id: String(call.id || ""),
              name: String(fn.name || ""),
              input: {},
            },
          });
        }
        const fn = (call.function as Record<string, unknown> | undefined) || {};
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: block.blockIndex,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          });
        }
      }
      if (typeof chunk.usage === "object" && chunk.usage !== null) {
        // The provider's usage is OpenAI-shaped; the Messages wire wants
        // Anthropic-shaped counts.
        const u = wholeUsage(chunk.usage, "");
        usage = {
          input_tokens: u.prompt_tokens,
          output_tokens: u.completion_tokens,
        };
      }
      if (
        typeof first.finish_reason === "string" &&
        first.finish_reason.length > 0
      ) {
        stopReason = anthropicStopReason(first.finish_reason);
      }
    },
    finish(): void {
      if (!started) {
        // The upstream answered 200 but streamed nothing: still emit a
        // well-formed empty message so the client gets a valid answer.
        started = true;
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: dialedId,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        openTextBlock();
      }
      if (textOpen) {
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        textOpen = false;
      }
      for (const block of toolBlocks.values()) {
        if (block.open) {
          emit("content_block_stop", {
            type: "content_block_stop",
            index: block.blockIndex,
          });
          block.open = false;
        }
      }
      const finalUsage = usage || {
        input_tokens: 0,
        output_tokens: Math.max(1, Math.ceil(textChars / 4)),
      };
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason || "end_turn", stop_sequence: null },
        usage: finalUsage,
      });
      emit("message_stop", { type: "message_stop" });
      res.end();
    },
  };
}

async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
  models: BriefModel[],
): Promise<void> {
  const needsTools = Array.isArray(body.tools) && body.tools.length > 0;
  const ranked = rankModels(models, false, needsTools);
  if (ranked.length === 0) {
    sendJson(res, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "no free model meets this request",
      },
    });
    return;
  }
  const upstream = anthropicUpstreamBody(body);
  const wantStream = body.stream === true;

  if (!wantStream) {
    const outcome = await dialChatJson(upstream, ranked);
    if (!outcome.ok || !outcome.json) {
      sendJson(
        res,
        outcome.status,
        {
          type: "error",
          error: {
            type: "api_error",
            message: errorMessageOf(outcome.rawText),
          },
        },
        failureHeaders(outcome.failures),
      );
      return;
    }
    sendJson(
      res,
      200,
      anthropicFromOpenAI(outcome.json, outcome.model),
      failureHeaders(outcome.failures),
    );
    return;
  }

  // Streaming: translate the provider's OpenAI chunks into Anthropic
  // events. If no model answers, the client gets a JSON error instead —
  // the streamer only writes headers once a real chunk arrives.
  let streamer: ReturnType<typeof makeAnthropicStreamer> | null = null;
  const streamFailures: UpstreamFailure[] = [];
  const outcome = await dialChatStream(
    upstream,
    ranked,
    (line, model) => {
      if (!streamer) {
        streamer = makeAnthropicStreamer(res, model, streamFailures);
      }
      streamer.line(line);
    },
    (failure) => {
      streamFailures.push(failure);
    },
  );
  if (!outcome.ok) {
    if (!streamer) {
      sendJson(
        res,
        outcome.status,
        {
          type: "error",
          error: {
            type: "api_error",
            message: errorMessageOf(outcome.rawText),
          },
        },
        failureHeaders(outcome.failures),
      );
      return;
    }
    streamer.finish();
    return;
  }
  if (!streamer) {
    streamer = makeAnthropicStreamer(res, outcome.model, streamFailures);
  }
  streamer.finish();
}

// ---------------------------------------------------------------------------
// GET /v1/models: the wire is the auth header
// ---------------------------------------------------------------------------

function handleModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  models: BriefModel[],
): void {
  const auth = String(req.headers.authorization || "");
  const apiKey = String(req.headers["x-api-key"] || "");
  const ids = models.map((m) => m.id);
  if (apiKey.length > 0 && !auth.startsWith("Bearer ")) {
    // Anthropic shape.
    const nowIso = new Date(trialNowMs()).toISOString();
    sendJson(res, 200, {
      data: models.map((m) => ({
        id: m.id,
        type: "model",
        display_name: m.display_name,
        created_at: nowIso,
      })),
      has_more: false,
      first_id: ids.length > 0 ? ids[0] : null,
      last_id: ids.length > 0 ? ids[ids.length - 1] : null,
    });
    return;
  }
  // OpenAI shape (also the default when no auth header names a wire).
  const created = Math.floor(trialNowMs() / 1000);
  sendJson(res, 200, {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "openrouter",
    })),
  });
}

// ---------------------------------------------------------------------------
// Router and trial bootstrap
// ---------------------------------------------------------------------------

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  models: BriefModel[],
): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      handleModels(req, res, models);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const text = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, {
          error: {
            message: "request body is not valid JSON",
            type: "invalid_request_error",
            code: "invalid_json",
          },
        });
        return;
      }
      await handleChatCompletions(req, res, body, models);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const text = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "request body is not valid JSON",
          },
        });
        return;
      }
      await handleMessages(req, res, body, models);
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, { ok: true, service: "free-model-aggregator" });
      return;
    }
    sendJson(res, 404, {
      error: {
        message: "not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : "internal error",
          type: "api_error",
          code: "internal_error",
        },
      });
    } else {
      res.end();
    }
  }
}

async function registerWithEnv(
  envUrl: string,
  port: number,
  catalog: Catalog,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await httpJson(
        `${envUrl.replace(/\/$/, "")}/register`,
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify({ protocol_version: 1, port, catalog }),
        5000,
      );
      if (result.status >= 200 && result.status < 300) return true;
    } catch {
      // The env may not be up yet; retry below.
    }
    await sleep(500);
  }
  return false;
}

async function pollWorkUntilDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const result = await httpJson(
        `${envUrl.replace(/\/$/, "")}/work`,
        "GET",
        {},
        "",
        5000,
      );
      if (result.status >= 200 && result.status < 300) {
        const parsed = JSON.parse(result.text) as Record<string, unknown>;
        if (parsed.done === true) return;
      }
    } catch {
      // The env may be briefly unreachable; keep polling.
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const models = loadBriefModels();
  const catalog = buildCatalog(models);

  if (process.argv.includes("--list")) {
    process.stdout.write(JSON.stringify(catalog));
    return;
  }

  const server = http.createServer((req, res) => {
    void route(req, res, models);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  const envUrl = process.env.MAKEFUN_ENV_URL || "";
  if (envUrl) {
    await registerWithEnv(envUrl, port, catalog);
    await pollWorkUntilDone(envUrl);
    process.exit(0);
  }
  // No trial env: serve until stopped (local use).
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
