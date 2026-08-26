import { HelpCircle, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api";
import type { PendingServerRequest } from "../types";

type Question = {
  id: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

export function UserInputCard({ request, onResolved }: { request: PendingServerRequest; onResolved: (id: number) => void }) {
  const questions = (Array.isArray(request.params?.questions) ? request.params.questions : []) as Question[];
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const complete = useMemo(() => questions.length > 0 && questions.every((question) => values[question.id]?.trim()), [questions, values]);

  async function submit() {
    if (!complete || sending) return;
    setSending(true);
    setError("");
    try {
      await api("/api/rpc/respond", {
        method: "POST",
        body: JSON.stringify({
          id: request.id,
          result: {
            answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [values[question.id].trim()] }])),
          },
        }),
      });
      onResolved(request.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法提交回答");
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="approval-card user-input-card">
      <div className="approval-icon"><HelpCircle size={19} /></div>
      <div className="approval-content">
        <strong>Codex 需要你的输入</strong>
        {questions.map((question) => {
          const options = question.options ?? [];
          const listId = `request-${request.id}-${question.id}`;
          return <label className="user-input-question" key={question.id}>
            <span>{question.header || "请确认"}</span>
            <small>{question.question || "请输入答案"}</small>
            <input
              type={question.isSecret ? "password" : "text"}
              list={options.length > 0 ? listId : undefined}
              value={values[question.id] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder={question.isOther ? "选择或输入其他答案" : options[0]?.label || "请输入"}
            />
            {options.length > 0 && <datalist id={listId}>{options.map((option) => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist>}
          </label>;
        })}
        {error && <p className="form-error">{error}</p>}
        <div className="approval-actions"><button className="primary-button compact" disabled={!complete || sending} onClick={() => void submit()}><Send size={14} />{sending ? "提交中…" : "提交回答"}</button></div>
      </div>
    </aside>
  );
}
