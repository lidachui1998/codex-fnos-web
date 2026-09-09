type Host = { ready: () => Promise<void>; isStandaloneWeb: boolean };

function deadline<T>(promise: Promise<T>, message: string, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// Each factory call loads an independent copy of the official SDK module. Merely
// constructing another TrimApp leaves its module-scoped host connection cached.
export class HostConnection<T extends Host> {
  private connection: Promise<T> | null = null;
  private generations = 0;
  private createHost: (generation: number) => Promise<T>;
  private timeoutMs: number;

  constructor(createHost: (generation: number) => Promise<T>, timeoutMs = 8000) {
    this.createHost = createHost;
    this.timeoutMs = timeoutMs;
  }

  connect() {
    if (this.connection) return this.connection;
    if (this.generations >= 3) return Promise.reject(new Error("已尝试重新连接 3 次，请保存未完成的编辑后刷新工作台页面。"));
    const generation = ++this.generations;
    this.connection = deadline((async () => {
      const host = await this.createHost(generation);
      if (host.isStandaloneWeb) throw new Error("当前是独立网页，无法调用飞牛桌面的文件管理器。请从 fnOS 桌面的应用图标打开工作台。");
      await host.ready();
      return host;
    })(), "与飞牛宿主建立连接超时，请点击“重新连接飞牛”后再试。", this.timeoutMs);
    return this.connection;
  }

  reconnect() {
    this.connection = null;
    return this.connect();
  }

  async run(request: (host: T) => Promise<unknown>) {
    // Never leave a navigation queued behind an expired SDK handshake.
    const host = await this.connect();
    await deadline(request(host), "已发送打开请求，但飞牛没有回执。请先检查文件管理器是否已经打开；未打开时可重新连接后再试。", this.timeoutMs);
  }
}
