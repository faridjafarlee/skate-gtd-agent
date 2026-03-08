/**
 * OpenTelemetry OTLP trace export.
 * When GTD_OTEL_EXPORT=true or GTD_OTEL_ENDPOINT is set, initializes a trace provider
 * and exports spans to the configured OTLP HTTP endpoint.
 */

import { trace, type Span, type Tracer, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const TRACER_NAME = "skate";

let tracer: Tracer | undefined;
let provider: NodeTracerProvider | undefined;

function shouldExport(): boolean {
  return process.env.GTD_OTEL_EXPORT === "true" || Boolean(process.env.GTD_OTEL_ENDPOINT);
}

/**
 * Initialize OTLP trace export when GTD_OTEL_EXPORT=true or GTD_OTEL_ENDPOINT is set.
 * Idempotent; safe to call multiple times.
 */
export function initOtel(): void {
  if (provider) return;
  if (!shouldExport()) return;

  try {
    const endpoint = process.env.GTD_OTEL_ENDPOINT;
    const url = endpoint
      ? (endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`)
      : undefined;

    const exporter = new OTLPTraceExporter({
      url,
      headers: process.env.GTD_OTEL_HEADERS
        ? (JSON.parse(process.env.GTD_OTEL_HEADERS) as Record<string, string>)
        : undefined,
    });

    provider = new NodeTracerProvider();
    provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 512,
        scheduledDelayMillis: 5000,
      })
    );
    provider.register();
    tracer = trace.getTracer(TRACER_NAME, "0.1.0");
  } catch (e) {
    if (process.env.GTD_OTEL_DEBUG === "true") {
      console.error("[GTD OTEL] init failed:", e);
    }
  }
}

/**
 * Return the tracer if OTLP export is enabled; otherwise undefined.
 * Call initOtel() before using.
 */
export function getTracer(): Tracer | undefined {
  if (!tracer && shouldExport()) initOtel();
  return tracer;
}

/**
 * Start a span for a task or step. Returns a no-op span if OTLP is disabled.
 */
export function startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
  const t = getTracer();
  if (!t) return trace.getTracer(TRACER_NAME, "0.1.0").startSpan(name) as Span;
  const span = t.startSpan(name, { attributes: attributes as Record<string, string | number | boolean | undefined> });
  return span;
}

/**
 * End a span with optional status (default: OK). No-op if span is a no-op.
 */
export function endSpan(span: Span, ok = true): void {
  try {
    span.setStatus({ code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  } catch {
    // no-op
  }
}
