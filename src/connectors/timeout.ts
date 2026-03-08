/**
 * Connector task timeout. Set CONNECTOR_TASK_TIMEOUT_MS (e.g. 3600000 for 1h) to abort long-running tasks.
 */

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export function getConnectorTaskTimeoutMs(): number {
  const v = process.env.CONNECTOR_TASK_TIMEOUT_MS;
  if (v == null || v === "") return 0;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}
