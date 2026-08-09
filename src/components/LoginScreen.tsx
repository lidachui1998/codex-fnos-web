import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";

type LoginScreenProps = {
  mode: "checking" | "setup" | "login";
  onSubmit: (password: string) => Promise<void>;
  onRetry?: () => void;
  error?: string;
};

export function LoginScreen({ mode, onSubmit, onRetry, error }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (mode === "checking") {
    return (
      <main className="unlock-page">
        <section className="unlock-card checking-card">
          <div className="brand-mark large"><img src="/app-icon.png" alt="" /></div>
          <div className="eyebrow"><ShieldCheck size={15} /> 飞牛本地安全访问</div>
          <h1>正在打开 Codex 工作台</h1>
          <p>正在检查工作台状态和浏览器登录信息，请稍候。</p>
          {!error && <div className="checking-status"><LoaderCircle size={18} /> 正在连接本机服务</div>}
          {error && <div className="form-error">{error}</div>}
          {error && onRetry && <button className="secondary-button full" type="button" onClick={onRetry}>重新连接</button>}
        </section>
      </main>
    );
  }

  const setup = mode === "setup";
  const visibleError = localError || error;

  return (
    <main className="unlock-page">
      <section className="unlock-card">
        <div className="brand-mark large"><img src="/app-icon.png" alt="" /></div>
        <div className="eyebrow"><ShieldCheck size={15} /> 飞牛本地安全访问</div>
        <h1>{setup ? "第一次使用，设置访问密码" : "欢迎回来"}</h1>
        <p>{setup
          ? "请设置一个你记得住的密码，用来保护 NAS 上的项目与会话。以后打开工作台就输入这个密码。"
          : "输入你之前设置的访问密码，继续进入 Codex 工作台。"}</p>
        <form onSubmit={async (event) => {
          event.preventDefault();
          setLocalError("");
          if (password.length < 8) {
            setLocalError("访问密码至少需要 8 个字符");
            return;
          }
          if (setup && password !== confirmation) {
            setLocalError("两次输入的密码不一致");
            return;
          }
          setSubmitting(true);
          try {
            await onSubmit(password);
          } finally {
            setSubmitting(false);
          }
        }}>
          <input className="sr-only" name="username" autoComplete="username" value="fnOS Codex" readOnly tabIndex={-1} aria-hidden="true" />
          <div className="password-fields">
            <label>
              <span className="field-label">{setup ? "设置访问密码" : "访问密码"}</span>
              <span className="token-input">
                <KeyRound size={18} />
                <input
                  id="access-password"
                  type="password"
                  autoComplete={setup ? "new-password" : "current-password"}
                  placeholder={setup ? "至少 8 个字符" : "输入你设置的密码"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus
                />
              </span>
            </label>
            {setup && <label>
              <span className="field-label">确认访问密码</span>
              <span className="token-input">
                <KeyRound size={18} />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="再输入一次"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </span>
            </label>}
          </div>
          {visibleError && <div className="form-error">{visibleError}</div>}
          <button className="primary-button full" type="submit" disabled={submitting || !password}>
            {submitting ? "请稍候…" : setup ? "设置并进入" : "进入工作台"} {!submitting && <ArrowRight size={18} />}
          </button>
        </form>
        <div className="unlock-note">这是你自己设置的工作台密码，不是 OpenAI 或第三方 API Key。API Key 登录后再配置。</div>
      </section>
    </main>
  );
}
