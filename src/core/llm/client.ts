import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { getModel } from "../models/registry.js";
import type { ModelProvider } from "../models/types.js";
import { withRetry, llmRetryOptions } from "../retry.js";

export interface LLMOptions {
  modelId: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** One tool call from the model (id, name, parsed args). */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Content part for multimodal messages (CC-20 vision). */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "image"; data: string; mimeType?: string };

/** Message for multi-turn tool use: user, assistant (optional tool_calls), or tool result. */
export interface LLMChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string | LLMContentPart[];
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

/** Response when model may return tool calls. */
export interface LLMResponseWithTools extends LLMResponse {
  toolCalls?: LLMToolCall[];
}

/** Tool definition for the API (name, description, parameters schema). */
export interface LLMToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string }>;
}

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4": "claude-sonnet-4-6",
  "claude-opus-4": "claude-opus-4-6",
};

export interface PingResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Health check: send a minimal completion to verify the model is reachable.
 */
export async function ping(modelId: string): Promise<PingResult> {
  const start = Date.now();
  try {
    await complete(
      { modelId, systemPrompt: "Reply with exactly: ok", temperature: 0 },
      "ping"
    );
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Stream completion, calling onChunk for each content delta. Returns full response when done.
 */
export async function completeStream(
  options: LLMOptions,
  userMessage: string,
  onChunk: (chunk: string) => void
): Promise<LLMResponse> {
  const config = getModel(options.modelId);
  if (!config || !config.enabled) {
    throw new Error(`Model ${options.modelId} is not available or not enabled`);
  }
  return withRetry(async () => {
    if (config!.metadata.provider === "anthropic") {
      return completeAnthropicStream(options, userMessage, config!, onChunk);
    }
    if (config!.metadata.provider === "google") {
      return completeGoogleStream(options, userMessage, config!, onChunk);
    }
    return completeOpenAIStream(options, userMessage, config!, onChunk);
  }, llmRetryOptions());
}

/**
 * Unified LLM client supporting OpenAI, Anthropic, and Ollama.
 */
export async function complete(options: LLMOptions, userMessage: string): Promise<LLMResponse> {
  const config = getModel(options.modelId);
  if (!config || !config.enabled) {
    throw new Error(`Model ${options.modelId} is not available or not enabled`);
  }

  return withRetry(async () => {
    if (config!.metadata.provider === "anthropic") {
      return completeAnthropic(options, userMessage, config!);
    }
    if (config!.metadata.provider === "google") {
      return completeGoogle(options, userMessage, config!);
    }
    return completeOpenAI(options, userMessage, config!);
  }, llmRetryOptions());
}

/**
 * Try models in order until one succeeds. For fallback resilience.
 */
export async function completeWithFallback(
  modelIds: string[],
  options: Omit<LLMOptions, "modelId">,
  userMessage: string
): Promise<LLMResponse & { modelUsed: string }> {
  let lastError: Error | null = null;
  for (const modelId of modelIds) {
    try {
      const res = await complete({ ...options, modelId }, userMessage);
      return { ...res, modelUsed: modelId };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("No models available");
}

/**
 * Try models in order with streaming until one succeeds.
 */
export async function completeStreamWithFallback(
  modelIds: string[],
  options: Omit<LLMOptions, "modelId">,
  userMessage: string,
  onChunk: (chunk: string) => void
): Promise<LLMResponse & { modelUsed: string }> {
  let lastError: Error | null = null;
  for (const modelId of modelIds) {
    try {
      const res = await completeStream({ ...options, modelId }, userMessage, onChunk);
      return { ...res, modelUsed: modelId };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("No models available");
}

/**
 * Completion with tool definitions; returns content and optional tool_calls.
 * Use for Builder (or other roles) that can invoke tools. Supports OpenAI and Anthropic.
 */
export async function completeWithTools(
  options: LLMOptions,
  messages: LLMChatMessage[],
  tools: LLMToolDef[]
): Promise<LLMResponseWithTools> {
  if (!tools.length) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const raw = lastUser?.content ?? "";
    const userText = typeof raw === "string" ? raw : raw.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const res = await complete(options, userText);
    return { ...res, toolCalls: undefined };
  }
  const config = getModel(options.modelId);
  if (!config || !config.enabled) {
    throw new Error(`Model ${options.modelId} is not available or not enabled`);
  }
  return withRetry(async () => {
    if (config!.metadata.provider === "anthropic") {
      return completeAnthropicWithTools(options, messages, tools, config!);
    }
    if (config!.metadata.provider === "google") {
      return completeGoogleWithTools(options, messages, tools, config!);
    }
    return completeOpenAIWithTools(options, messages, tools, config!);
  }, llmRetryOptions());
}

async function completeAnthropicStream(
  options: LLMOptions,
  userMessage: string,
  _config: { metadata: { provider: ModelProvider } },
  onChunk: (chunk: string) => void
): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for Claude models");
  const modelId = ANTHROPIC_MODEL_MAP[options.modelId] ?? options.modelId;
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: modelId,
    max_tokens: 4096,
    system: options.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    temperature: options.temperature ?? 0.7,
  });
  let fullText = "";
  await new Promise<void>((resolve, reject) => {
    stream.on("text", (textDelta: string) => {
      fullText += textDelta;
      onChunk(textDelta);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const response = await stream.finalMessage();
  const usage = response.usage;
  return {
    content: fullText,
    model: response.model,
    usage: usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } : undefined,
  };
}

async function completeAnthropic(
  options: LLMOptions,
  userMessage: string,
  _config: { metadata: { provider: ModelProvider } }
): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude models");
  }

  const modelId = ANTHROPIC_MODEL_MAP[options.modelId] ?? options.modelId;

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: options.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    temperature: options.temperature ?? 0.7,
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("Empty response from Claude");
  }

  return {
    content: textBlock.text,
    model: response.model,
    usage: response.usage
      ? {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        }
      : undefined,
  };
}

async function completeGoogleStream(
  options: LLMOptions,
  userMessage: string,
  _config: { metadata: { provider: ModelProvider } },
  onChunk: (chunk: string) => void
): Promise<LLMResponse> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required for Gemini models");
  const ai = new GoogleGenAI({ apiKey });
  const stream = await ai.models.generateContentStream({
    model: options.modelId,
    contents: userMessage,
    config: {
      systemInstruction: options.systemPrompt,
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: 4096,
    },
  });
  let fullText = "";
  for await (const chunk of stream) {
    const text = (chunk as { text?: string }).text ?? "";
    if (text) {
      fullText += text;
      onChunk(text);
    }
  }
  return { content: fullText, model: options.modelId };
}

async function completeGoogle(
  options: LLMOptions,
  userMessage: string,
  _config: { metadata: { provider: ModelProvider } }
): Promise<LLMResponse> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required for Gemini models");
  }

  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: options.modelId,
    contents: userMessage,
    config: {
      systemInstruction: options.systemPrompt,
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: 4096,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error("Empty response from Gemini");
  }

  const um = response.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  return {
    content: text,
    model: options.modelId,
    usage: um
      ? {
          promptTokens: um.promptTokenCount ?? 0,
          completionTokens: um.candidatesTokenCount ?? 0,
        }
      : undefined,
  };
}

/** Build Gemini tool list from LLMToolDef (one tool with all function declarations). */
function toGeminiTools(tools: LLMToolDef[]): Array<{ functionDeclarations: Array<{ name: string; description?: string; parametersJsonSchema?: unknown }> }> {
  if (tools.length === 0) return [];
  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([k, v]) => [k, { type: (v.type === "string" ? "string" : v.type === "number" ? "number" : v.type === "integer" ? "integer" : v.type === "boolean" ? "boolean" : "string"), description: v.description }])
      ),
    } as const,
  }));
  return [{ functionDeclarations }];
}

/** Build Gemini contents (multi-turn) from LLM messages. */
function toGeminiContents(messages: LLMChatMessage[]): Array<{ role: string; content: string | Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown>; call_id?: string; result?: unknown }> }> {
  const turns: Array<{ role: string; content: string | Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown>; call_id?: string; result?: unknown }> }> = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "system") {
      i++;
      continue;
    }
    if (m.role === "user" && m.content) {
      turns.push({ role: "user", content: m.content });
      i++;
      continue;
    }
    if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        turns.push({
          role: "model",
          content: m.toolCalls.map((tc) => ({
            type: "function_call",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        });
      } else if (m.content) {
        turns.push({ role: "model", content: m.content });
      }
      i++;
      continue;
    }
    if (m.role === "tool" && m.toolCallId != null) {
      const parts: Array<{ type: string; call_id: string; result: unknown; name?: string }> = [];
      while (i < messages.length && messages[i].role === "tool") {
        const t = messages[i];
        if (t.toolCallId != null) parts.push({ type: "function_result", call_id: t.toolCallId, result: t.content ?? "" });
        i++;
      }
      turns.push({ role: "user", content: parts });
      continue;
    }
    i++;
  }
  return turns;
}

async function completeGoogleWithTools(
  options: LLMOptions,
  messages: LLMChatMessage[],
  tools: LLMToolDef[],
  _config: { metadata: { provider: ModelProvider } }
): Promise<LLMResponseWithTools> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required for Gemini models");
  }
  const ai = new GoogleGenAI({ apiKey });
  const geminiTools = toGeminiTools(tools);
  const turns = toGeminiContents(messages);
  const contents = turns.length === 0 ? "" : turns.length === 1 && typeof turns[0].content === "string" && turns[0].role === "user" ? turns[0].content : turns;
  const response = await ai.models.generateContent({
    model: options.modelId,
    contents,
    config: {
      systemInstruction: options.systemPrompt,
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: 4096,
      ...(geminiTools.length ? { tools: geminiTools } : {}),
    },
  });
  const text = response.text ?? "";
  const um = response.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  const functionCalls = response.functionCalls;
  const toolCalls: LLMToolCall[] | undefined =
    functionCalls?.length ?
      functionCalls.map((fc) => ({
        id: fc.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: fc.name ?? "",
        arguments: (fc.args as Record<string, unknown>) ?? {},
      }))
    : undefined;
  return {
    content: text,
    model: options.modelId,
    usage: um ? { promptTokens: um.promptTokenCount ?? 0, completionTokens: um.candidatesTokenCount ?? 0 } : undefined,
    toolCalls,
  };
}

async function completeOpenAIStream(
  options: LLMOptions,
  userMessage: string,
  config: { metadata: { provider: ModelProvider }; apiKeyEnv?: string; baseUrl?: string },
  onChunk: (chunk: string) => void
): Promise<LLMResponse> {
  const { baseUrl, apiKey } = resolveEndpoint(config);
  const modelIdForApi = resolveModelId(options.modelId, config.metadata.provider);
  const client = new OpenAI({ apiKey: apiKey ?? "ollama", baseURL: baseUrl });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (options.systemPrompt) messages.push({ role: "system", content: options.systemPrompt });
  messages.push({ role: "user", content: userMessage });
  const stream = await client.chat.completions.create({
    model: modelIdForApi,
    messages,
    temperature: options.temperature ?? 0.7,
    stream: true,
  });
  let fullText = "";
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onChunk(delta);
    }
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }
  return { content: fullText, model: options.modelId, usage };
}

async function completeOpenAI(
  options: LLMOptions,
  userMessage: string,
  config: { metadata: { provider: ModelProvider }; apiKeyEnv?: string; baseUrl?: string }
): Promise<LLMResponse> {
  const { baseUrl, apiKey } = resolveEndpoint(config);
  const modelIdForApi = resolveModelId(options.modelId, config.metadata.provider);

  const client = new OpenAI({
    apiKey: apiKey ?? "ollama",
    baseURL: baseUrl,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const completion = await client.chat.completions.create({
    model: modelIdForApi,
    messages,
    temperature: options.temperature ?? 0.7,
  });

  const choice = completion.choices[0];
  if (!choice?.message?.content) {
    throw new Error("Empty response from LLM");
  }

  return {
    content: choice.message.content,
    model: completion.model ?? options.modelId,
    usage: completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens ?? 0,
          completionTokens: completion.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

function toOpenAIMessages(msgs: LLMChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of msgs) {
    if (m.role === "system" && m.content) {
      const c = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
      out.push({ role: "system", content: c });
    } else if (m.role === "user" && m.content) {
      const c = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
      out.push({ role: "user", content: c });
    } else if (m.role === "assistant") {
      const content = m.content ?? null;
      out.push({
        role: "assistant",
        content: typeof content === "string" ? content : null,
        tool_calls: m.toolCalls?.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      });
    } else if (m.role === "tool" && m.toolCallId && m.content !== undefined) {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: typeof m.content === "string" ? m.content : "" });
    }
  }
  return out;
}

function toOpenAITools(tools: LLMToolDef[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
        ),
      },
    },
  }));
}

async function completeOpenAIWithTools(
  options: LLMOptions,
  messages: LLMChatMessage[],
  tools: LLMToolDef[],
  config: { metadata: { provider: ModelProvider }; apiKeyEnv?: string; baseUrl?: string }
): Promise<LLMResponseWithTools> {
  const { baseUrl, apiKey } = resolveEndpoint(config);
  const modelIdForApi = resolveModelId(options.modelId, config.metadata.provider);
  const client = new OpenAI({ apiKey: apiKey ?? "ollama", baseURL: baseUrl });

  const apiMessages = toOpenAIMessages(messages);
  const apiTools = toOpenAITools(tools);

  const completion = await client.chat.completions.create({
    model: modelIdForApi,
    messages: apiMessages,
    tools: apiTools,
    temperature: options.temperature ?? 0.7,
  });

  const choice = completion.choices[0];
  const msg = choice?.message;
  const content = (msg?.content as string) ?? "";
  const toolCalls: LLMToolCall[] | undefined = msg?.tool_calls?.length
    ? msg.tool_calls.map((tc: { id: string; function?: { name: string; arguments?: string } }) => ({
        id: tc.id,
        name: (tc.function as { name: string })?.name ?? "",
        arguments: (() => {
          try {
            return JSON.parse((tc.function as { arguments?: string })?.arguments ?? "{}") as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      }))
    : undefined;

  return {
    content,
    model: completion.model ?? options.modelId,
    usage: completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens ?? 0,
          completionTokens: completion.usage.completion_tokens ?? 0,
        }
      : undefined,
    toolCalls,
  };
}

async function completeAnthropicWithTools(
  options: LLMOptions,
  messages: LLMChatMessage[],
  tools: LLMToolDef[],
  _config: { metadata: { provider: ModelProvider } }
): Promise<LLMResponseWithTools> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for Claude models");
  const modelId = ANTHROPIC_MODEL_MAP[options.modelId] ?? options.modelId;
  const client = new Anthropic({ apiKey });

  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
      ),
    },
  }));

  const system: string[] = [];
  const anthropicMessages: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system" && m.content) system.push(typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
    else if (m.role === "user" && m.content) {
      const content = Array.isArray(m.content)
        ? ((m.content as LLMContentPart[]).map((p) => {
            if (p.type === "text") return { type: "text" as const, text: p.text };
            if (p.type === "image_url") return { type: "image" as const, source: { type: "url" as const, url: p.image_url.url } as const };
            return { type: "image" as const, source: { type: "base64" as const, media_type: (p.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp") || "image/png", data: p.data } };
          }) as Anthropic.ContentBlockParam[])
        : ([{ type: "text" as const, text: m.content }] as Anthropic.ContentBlockParam[]);
      anthropicMessages.push({ role: "user", content });
    }
    else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n") });
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      if (content.length) anthropicMessages.push({ role: "assistant", content });
    } else if (m.role === "tool" && m.toolCallId != null && m.content !== undefined) {
      const toolContent = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: toolContent }],
      });
    }
  }
  const systemPrompt = options.systemPrompt ? [options.systemPrompt, ...system].join("\n\n") : system.join("\n\n");

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: systemPrompt || undefined,
    messages: anthropicMessages,
    tools: anthropicTools,
    temperature: options.temperature ?? 0.7,
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const content = textBlock?.text ?? "";
  const toolCalls: LLMToolCall[] =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          arguments: (b.input as Record<string, unknown>) ?? {},
        }))
      : [];

  return {
    content,
    model: response.model,
    usage: response.usage
      ? { promptTokens: response.usage.input_tokens, completionTokens: response.usage.output_tokens }
      : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function resolveEndpoint(config: { metadata: { provider: ModelProvider }; apiKeyEnv?: string; baseUrl?: string }): {
  baseUrl: string;
  apiKey: string | undefined;
} {
  if (config.baseUrl) {
    return { baseUrl: config.baseUrl, apiKey: process.env[config.apiKeyEnv ?? ""] };
  }
  switch (config.metadata.provider) {
    case "ollama":
      return { baseUrl: "http://localhost:11434/v1", apiKey: undefined };
    case "openai":
      return { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY };
    default:
      return { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY };
  }
}

function resolveModelId(modelId: string, provider: ModelProvider): string {
  if (provider === "ollama") {
    return modelId.replace(/^ollama\//, "");
  }
  return modelId;
}
