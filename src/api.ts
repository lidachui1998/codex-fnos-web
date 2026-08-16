export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isBinaryBody = init.body instanceof Blob || init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body && !isBinaryBody && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data?.error?.message ?? `请求失败 (${response.status})`, response.status, data?.error?.details);
  }
  return data as T;
}

type PolledEvent = { cursor: number; event: unknown };
type PollResponse = { events: PolledEvent[]; nextCursor: number; reset: boolean };

let preferPolling = false;
let lastEventCursor: number | null = null;

async function loadEventCheckpoint(signal: AbortSignal) {
  const data = await api<PollResponse>("/api/events/poll", { cache: "no-store", signal });
  if (Number.isSafeInteger(data.nextCursor) && data.nextCursor >= 0) lastEventCursor = data.nextCursor;
}

function waitForEventSource(onEvent: (event: unknown) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (typeof EventSource === "undefined") {
      reject(new Error("当前 WebView 不支持 EventSource"));
      return;
    }
    const query = lastEventCursor === null ? "" : `?cursor=${encodeURIComponent(lastEventCursor)}`;
    const source = new EventSource(`/events${query}`, { withCredentials: true });
    let connected = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("SSE 首包超时"));
    }, 4_500);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      source.close();
    };
    const abort = () => {
      cleanup();
      resolve();
    };
    source.onmessage = (message) => {
      connected = true;
      clearTimeout(timeout);
      const cursor = message.lastEventId.trim() ? Number(message.lastEventId) : null;
      if (cursor !== null && Number.isSafeInteger(cursor) && cursor >= 0) lastEventCursor = cursor;
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // Ignore malformed keepalive data.
      }
    };
    source.onerror = () => {
      cleanup();
      reject(new Error(connected ? "SSE 连接已断开" : "SSE 连接失败"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function pollEvents(onEvent: (event: unknown) => void, signal: AbortSignal) {
  let cursor = lastEventCursor;
  while (!signal.aborted) {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`/api/events/poll${query}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    const data = await response.json().catch(() => ({})) as Partial<PollResponse> & { error?: { message?: string; details?: unknown } };
    if (!response.ok) {
      throw new ApiError(data.error?.message ?? `事件轮询失败 (${response.status})`, response.status, data.error?.details);
    }
    if (data.reset) onEvent({ kind: "transport_reset" });
    for (const entry of data.events ?? []) {
      if (!Number.isSafeInteger(entry.cursor) || entry.cursor < 0) continue;
      cursor = Math.max(cursor ?? 0, entry.cursor);
      lastEventCursor = cursor;
      onEvent(entry.event);
    }
    if (Number.isSafeInteger(data.nextCursor) && Number(data.nextCursor) >= 0) {
      cursor = Math.max(cursor ?? 0, Number(data.nextCursor));
      lastEventCursor = cursor;
    }
  }
}

export async function connectEvents(
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
) {
  if (!preferPolling) {
    try {
      if (lastEventCursor === null) await loadEventCheckpoint(signal);
      await waitForEventSource(onEvent, signal);
      if (signal.aborted) return;
    } catch (reason) {
      if (signal.aborted) return;
      preferPolling = true;
      if (reason instanceof ApiError && reason.status === 401) throw reason;
    }
  }
  await pollEvents(onEvent, signal);
}
