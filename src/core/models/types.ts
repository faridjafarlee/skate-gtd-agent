/**
 * LLM model metadata and routing types.
 */

export type ModelProvider = "openai" | "anthropic" | "google" | "ollama" | "vllm" | "custom";

export type RoutingPolicy = "quality" | "cost" | "latency" | "balanced";

export interface ModelMetadata {
  id: string;
  provider: ModelProvider;
  name: string;
  contextWindow: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
  latencyClass: "fast" | "medium" | "slow";
  supportsTools: boolean;
  supportsVision?: boolean;
  reliabilityScore?: number;
  privacyLevel?: "local" | "hosted" | "api";
}

export interface ModelConfig {
  metadata: ModelMetadata;
  enabled: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
}
