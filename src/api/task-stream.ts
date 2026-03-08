/**
 * CC-4: Streaming API for task output.
 * Subscribers to a task ID receive SSE events when progress is emitted.
 */

export interface TaskStreamEvent {
  phase?: string;
  role?: string;
  status?: string;
  output?: string;
}

const subscribers = new Map<string, Set<(event: TaskStreamEvent) => void>>();

export function streamSubscribe(taskId: string, send: (event: TaskStreamEvent) => void): () => void {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(send);
  return () => {
    set?.delete(send);
    if (set?.size === 0) subscribers.delete(taskId);
  };
}

export function streamEmit(taskId: string, event: TaskStreamEvent): void {
  const set = subscribers.get(taskId);
  if (!set) return;
  for (const send of set) {
    try {
      send(event);
    } catch {
      set.delete(send);
    }
  }
}
