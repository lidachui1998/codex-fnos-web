import { Check, ShieldAlert, X } from "lucide-react";
import { api } from "../api";

type Request = { id: number; method: string; params: Record<string, any> };

export function ApprovalCard({ request, onResolved }: { request: Request; onResolved: (id: number) => void }) {
  const params = request.params ?? {};
  const isPermissions = request.method === "item/permissions/requestApproval";

  async function respond(decision: "accept" | "acceptForSession" | "decline") {
    const result = isPermissions
      ? decision === "decline"
        ? { scope: "turn", permissions: {} }
        : { scope: decision === "acceptForSession" ? "session" : "turn", permissions: params.permissions }
      : { decision };
    await api("/api/rpc/respond", {
      method: "POST",
      body: JSON.stringify({ id: request.id, result }),
    });
    onResolved(request.id);
  }

  return (
    <aside className="approval-card">
      <div className="approval-icon"><ShieldAlert size={19} /></div>
      <div className="approval-content">
        <strong>需要你的确认</strong>
        <p>{params.reason || (isPermissions ? "Codex 请求扩大当前任务权限" : "Codex 准备执行一项受保护操作")}</p>
        {params.command && <pre>{String(params.command)}</pre>}
        {params.cwd && <small>{String(params.cwd)}</small>}
        <div className="approval-actions">
          <button className="primary-button compact" onClick={() => respond("accept")}><Check size={15} /> 允许一次</button>
          <button className="secondary-button compact" onClick={() => respond("acceptForSession")}>本会话允许</button>
          <button className="ghost-button compact danger-text" onClick={() => respond("decline")}><X size={15} /> 拒绝</button>
        </div>
      </div>
    </aside>
  );
}
