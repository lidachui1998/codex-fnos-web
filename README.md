# Codex 飞牛工作台

一个全新实现、与旧 `codex_fnos` 完全独立的 fnOS Codex Web 客户端。

## 已实现

- 桌面三栏工作区与手机抽屉布局
- 创建项目、NAS 目录选择、会话创建/恢复/分叉/归档
- 流式回答、工具状态、命令与文件操作审批、中断任务
- OpenAI / ChatGPT 设备码登录和 API Key 登录
- 第三方 Responses API 与 Chat Completions 自动适配
- 自动从供应商 Base URL 的 `/models` 获取并切换模型，也支持手动填写模型 ID
- 一个代理配置可同时填写 HTTP、HTTPS、SOCKS5；供应商可继承全局、指定代理或强制直连
- SQLite 持久化；API Key、代理密码使用 AES-256-GCM 加密
- 首次使用自设访问密码、HttpOnly 持久登录、工作目录限制、路径穿越防护
- 首页直接填写 API 令牌，顶部切换供应商和模型
- 通过 fnOS iframe 在当前桌面窗口打开，不跳转新标签页

## 本地开发

需要 Node.js 24+。

```powershell
npm install
npm run dev
```

默认仅监听 `127.0.0.1:19090`。首次打开页面时由用户自行设置访问密码；
浏览器通过 HttpOnly Cookie 保持登录，不需要寻找系统生成的令牌。

可用环境变量：`HOST`、`PORT`、`DATA_DIR`、`WORKSPACE_ROOTS`、
`CODEX_BIN`、`CODEX_HOME`、`APP_ACCESS_TOKEN`。

## 构建 fnOS FPK

```powershell
npm pack @openai/codex@linux-x64 --pack-destination vendor-cache
npm run package:fnos
npm run verify:fnos
```

FPK 使用独立应用 ID `com.lidachui.codexweb` 和端口 `19090`，依赖飞牛
`nodejs_v24`。安装后会创建 `codexweb` 共享目录：项目默认位于
`codexweb/projects`，应用密钥和 Codex 登录信息位于
`codexweb/.codex-system`。卸载和升级不会主动删除这些数据。
