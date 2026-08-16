import type { Thread, ThreadItem } from "./types";

export type AgentViewState = {
  id: string;
  path?: string;
  status: string;
  message?: string | null;
  name?: string | null;
  role?: string | null;
  parentThreadId?: string | null;
  updatedAt?: number;
  activeFlags?: string[];
};

export const runningAgentStatuses = new Set(["pendingInit", "running", "inProgress", "waitingApproval", "waitingInput"]);

export function collabAgentStates(item: ThreadItem) {
  const states = Object.entries(item.agentsStates ?? {}).map(([id, state]) => ({
    id,
    status: state?.status || (item.status === "inProgress" ? "running" : "completed"),
    message: state?.message,
  }));
  if (states.length > 0) return states;
  const receiverIds = item.receiverThreadIds?.length
    ? item.receiverThreadIds
    : [item.receiverThreadId, item.newThreadId].filter((id): id is string => Boolean(id));
  const legacyStatus = typeof item.agentStatus === "string" ? item.agentStatus : item.agentStatus?.status;
  return receiverIds.map((id) => ({
    id,
    status: legacyStatus || (item.status === "inProgress" || item.tool === "spawnAgent" ? "running" : item.status || "completed"),
    message: typeof item.agentStatus === "object" ? item.agentStatus.message : null,
  }));
}

export function subagentStates(items: ThreadItem[], activeTurnId: string | null = null) {
  const states = new Map<string, AgentViewState>();
  const sourceTurnIds = new Map<string, string | undefined>();
  for (const item of items) {
    if (item.type === "subAgentActivity" && item.agentThreadId) {
      const previous = states.get(item.agentThreadId);
      states.set(item.agentThreadId, {
        id: item.agentThreadId,
        path: item.agentPath || previous?.path,
        status: item.kind === "interrupted" ? "interrupted" : previous?.status && !runningAgentStatuses.has(previous.status) ? previous.status : "running",
        message: previous?.message,
      });
      sourceTurnIds.set(item.agentThreadId, item.turnId);
      continue;
    }
    if (item.type !== "collabToolCall") continue;
    for (const state of collabAgentStates(item)) {
      const previous = states.get(state.id);
      states.set(state.id, { ...previous, ...state });
      sourceTurnIds.set(state.id, item.turnId);
    }
  }
  return [...states.values()].map((state) => {
    const belongsToActiveTurn = Boolean(activeTurnId) && sourceTurnIds.get(state.id) === activeTurnId;
    return runningAgentStatuses.has(state.status) && !belongsToActiveTurn
      ? { ...state, status: "completed" }
      : state;
  });
}

export function threadAgentStatus(thread: Thread) {
  const type = typeof thread.status === "string" ? thread.status : thread.status?.type;
  const activeFlags = typeof thread.status === "object" ? thread.status?.activeFlags ?? [] : [];
  if (type === "systemError") return "failed";
  if (type === "active") {
    if (activeFlags.includes("waitingOnApproval")) return "waitingApproval";
    if (activeFlags.includes("waitingOnUserInput")) return "waitingInput";
    return "running";
  }
  if (type === "idle" || type === "notLoaded") return "completed";
  return type || "completed";
}

export function resolveSubagentStates(items: ThreadItem[], activeTurnId: string | null, threads: Thread[] = []) {
  const states = new Map(subagentStates(items, activeTurnId).map((state) => [state.id, state]));
  for (const thread of threads) {
    const previous = states.get(thread.id);
    states.set(thread.id, {
      ...previous,
      id: thread.id,
      status: threadAgentStatus(thread),
      name: thread.agentNickname || thread.name || previous?.name,
      role: thread.agentRole || previous?.role,
      parentThreadId: thread.parentThreadId ?? previous?.parentThreadId,
      updatedAt: thread.updatedAt,
      activeFlags: typeof thread.status === "object" ? thread.status?.activeFlags ?? [] : [],
    });
  }
  return [...states.values()].sort((left, right) => {
    const leftRunning = runningAgentStatuses.has(left.status) || left.status.startsWith("waiting");
    const rightRunning = runningAgentStatuses.has(right.status) || right.status.startsWith("waiting");
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}
