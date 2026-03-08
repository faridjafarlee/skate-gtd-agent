import type { ModelConfig, ModelMetadata } from "./types.js";

const BUILTIN_MODELS: ModelMetadata[] = [
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    contextWindow: 128_000,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    latencyClass: "fast",
    supportsTools: true,
    supportsVision: true,
    reliabilityScore: 0.95,
    privacyLevel: "api",
  },
  {
    id: "claude-sonnet-4",
    provider: "anthropic",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    latencyClass: "medium",
    supportsTools: true,
    supportsVision: true,
    reliabilityScore: 0.95,
    privacyLevel: "api",
  },
  {
    id: "claude-opus-4",
    provider: "anthropic",
    name: "Claude Opus 4",
    contextWindow: 200_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    latencyClass: "slow",
    supportsTools: true,
    supportsVision: true,
    reliabilityScore: 0.98,
    privacyLevel: "api",
  },
  {
    id: "gemini-2.0-flash",
    provider: "google",
    name: "Gemini 2.0 Flash",
    contextWindow: 1_000_000,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    latencyClass: "fast",
    supportsTools: true,
    supportsVision: true,
    reliabilityScore: 0.9,
    privacyLevel: "api",
  },
  {
    id: "ollama/llama3",
    provider: "ollama",
    name: "Llama 3 (Ollama)",
    contextWindow: 8_192,
    latencyClass: "fast",
    supportsTools: true,
    supportsVision: false,
    privacyLevel: "local",
  },
  {
    id: "ollama/llama3.2",
    provider: "ollama",
    name: "Llama 3.2 (Ollama)",
    contextWindow: 128_000,
    latencyClass: "fast",
    supportsTools: true,
    supportsVision: false,
    privacyLevel: "local",
  },
];

const registry = new Map<string, ModelConfig>();

function initRegistry(): void {
  for (const meta of BUILTIN_MODELS) {
    registry.set(meta.id, {
      metadata: meta,
      enabled: meta.provider === "ollama",
      apiKeyEnv:
        meta.provider === "openai"
          ? "OPENAI_API_KEY"
          : meta.provider === "anthropic"
            ? "ANTHROPIC_API_KEY"
            : meta.provider === "google"
              ? "GOOGLE_AI_API_KEY"
              : undefined,
    });
  }
}

initRegistry();

export function listModels(): ModelConfig[] {
  return Array.from(registry.values());
}

export function getEnabledModelIds(): string[] {
  return listModels().filter((c) => c.enabled).map((c) => c.metadata.id);
}

export function setModelEnabled(id: string, enabled: boolean): boolean {
  const cfg = registry.get(id);
  if (!cfg) return false;
  cfg.enabled = enabled;
  return true;
}

export function applyEnabledIds(ids: string[]): void {
  const set = new Set(ids);
  for (const cfg of registry.values()) {
    cfg.enabled = set.has(cfg.metadata.id);
  }
}

export function getModel(id: string): ModelConfig | undefined {
  return registry.get(id);
}

export function addModel(config: ModelConfig): void {
  registry.set(config.metadata.id, config);
}

export function enableModel(id: string): boolean {
  const cfg = registry.get(id);
  if (!cfg) return false;
  cfg.enabled = true;
  return true;
}

export function disableModel(id: string): boolean {
  const cfg = registry.get(id);
  if (!cfg) return false;
  cfg.enabled = false;
  return true;
}
