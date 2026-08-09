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
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data?.error?.message ?? `请求失败 (${response.status})`, response.status, data?.error?.details);
  }
  return data as T;
}

export async function connectEvents(
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
) {
  const response = await fetch("/events", {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError("事件流连接失败", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (data) {
        try {
          onEvent(JSON.parse(data.slice(5).trim()));
        } catch {
          // Ignore malformed keepalive data.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
