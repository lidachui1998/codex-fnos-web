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

export type EventTransportState = {
  mode: "connecting" | "sse" | "polling" | "offline" | "reconnecting";
  lastEventAt: number | null;
  error: string | null;
};

let preferPollingUntil = 0;
let lastEventCursor: number | null = null;
let transportState: EventTransportState = { mode: "connecting", lastEventAt: null, error: null };
const transportListeners = new Set<(state: EventTransportState) => void>();

function updateTransport(next: Partial<EventTransportState>) {
  transportState = { ...transportState, ...next };
  for (const listener of transportListeners) listener(transportState);
}

export function getEventTransportState() {
  return transportState;
}

export function subscribeEventTransport(listener: (state: EventTransportState) => void) {
  transportListeners.add(listener);
  listener(transportState);
  return () => {
    transportListeners.delete(listener);
  };
}

export function resetEventTransport() {
  preferPollingUntil = 0;
  updateTransport({ mode: "reconnecting", error: null });
}

function waitUntilOnline(signal: AbortSignal) {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  updateTransport({ mode: "offline", error: "设备当前离线" });
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      window.removeEventListener("online", online);
      signal.removeEventListener("abort", abort);
    };
    const online = () => {
      cleanup();
      updateTransport({ mode: "reconnecting", error: null });
      resolve();
    };
    const abort = () => {
      cleanup();
      resolve();
    };
    window.addEventListener("online", online, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

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
    updateTransport({ mode: "connecting", error: null });
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
    source.onopen = () => {
      connected = true;
      clearTimeout(timeout);
      updateTransport({ mode: "sse", lastEventAt: Date.now(), error: null });
    };
    source.onmessage = (message) => {
      connected = true;
      clearTimeout(timeout);
      updateTransport({ mode: "sse", lastEventAt: Date.now(), error: null });
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
      const error = new Error(connected ? "SSE 连接已断开" : "SSE 连接失败");
      updateTransport({ mode: "reconnecting", error: error.message });
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function pollEvents(onEvent: (event: unknown) => void, signal: AbortSignal) {
  let cursor = lastEventCursor;
  updateTransport({ mode: "polling", error: null });
  while (!signal.aborted) {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    let response: Response;
    try {
      response = await fetch(`/api/events/poll${query}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
    } catch (reason) {
      if (!signal.aborted) updateTransport({
        mode: typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "reconnecting",
        error: reason instanceof Error ? reason.message : "事件连接失败",
      });
      throw reason;
    }
    const data = await response.json().catch(() => ({})) as Partial<PollResponse> & { error?: { message?: string; details?: unknown } };
    if (!response.ok) {
      const message = data.error?.message ?? `事件轮询失败 (${response.status})`;
      updateTransport({ mode: "reconnecting", error: message });
      throw new ApiError(message, response.status, data.error?.details);
    }
    updateTransport({ mode: "polling", lastEventAt: Date.now(), error: null });
    if (data.reset) {
      cursor = Number.isSafeInteger(data.nextCursor) ? Number(data.nextCursor) : null;
      lastEventCursor = cursor;
      onEvent({ kind: "transport_reset" });
    }
    for (const entry of data.events ?? []) {
      if (!Number.isSafeInteger(entry.cursor) || entry.cursor < 0) continue;
      cursor = Math.max(cursor ?? 0, entry.cursor);
      lastEventCursor = cursor;
      onEvent(entry.event);
    }
    if (Number.isSafeInteger(data.nextCursor) && Number(data.nextCursor) >= 0) {
      cursor = data.reset ? Number(data.nextCursor) : Math.max(cursor ?? 0, Number(data.nextCursor));
      lastEventCursor = cursor;
    }
  }
}

export async function connectEvents(
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
) {
  await waitUntilOnline(signal);
  if (signal.aborted) return;
  if (Date.now() >= preferPollingUntil) {
    try {
      if (lastEventCursor === null) await loadEventCheckpoint(signal);
      await waitForEventSource(onEvent, signal);
      if (signal.aborted) return;
    } catch (reason) {
      if (signal.aborted) return;
      preferPollingUntil = Date.now() + 30 * 60_000;
      if (reason instanceof ApiError && reason.status === 401) throw reason;
    }
  }
  await pollEvents(onEvent, signal);
}
