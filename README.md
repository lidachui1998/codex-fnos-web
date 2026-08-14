# Codex 飞牛工作台

一个全新实现、与旧 `codex_fnos` 完全独立的 fnOS Codex Web 客户端。

## 已实现

- 桌面三栏工作区与手机抽屉布局
- 创建项目、NAS 目录选择、会话创建/恢复/分叉；会话支持重命名、置顶、归档、删除和跨项目全局搜索
- 流式回答、工具状态、命令与文件操作审批、中断任务
- 每个会话独立保存模型、思考强度和命令审批策略；全局审批仅作为新会话默认值
- 按 OpenAI、Claude、DeepSeek、Qwen、Kimi、GLM、Gemini 等供应商和模型显示对应的思考档位
- 消息支持复制、重新发送、重新生成、编辑并分支；重试固定复用原会话及其供应商，只有“编辑并分支”才创建新会话；回复进行中仍可继续输入并按会话独立排队
- 会话切换会缓存每个任务的消息、草稿、附件、Skills 和滚动位置；悬停时预取聊天记录，切换时取消过期恢复请求，不再先清空页面或被短暂缺项的列表误删当前会话
- Codex 回复中的项目文件链接会在当前页打开文件面板，支持项目绝对路径、`file://`、行号定位、直接下载、调用飞牛官方文件管理器定位和复制 NAS 完整路径
- Skills 搜索、智能调用开关和 `SKILL.md` 预览；可从 GitHub 或本地 `SKILL.md` / ZIP 安全导入账户全局 Skill，聊天框输入 `@` 会统一搜索已启用 Skills、已安装插件以及当前项目文件/目录
- 插件中心把“插件市场”和“已安装”分开管理，支持标准 ZIP 导入、安装和卸载；远程安装严格使用官方 `remotePluginId`（`plugins~Plugin_...`），并自动隔离旧版本留下的无效缓存
- 飞牛本地定时任务，支持固定间隔、每天和每周计划；无人值守命令自动审批，默认使用项目可写沙箱并可不限域名联网；受阻的浏览器/渲染器任务可逐项明确关闭 Codex 内置沙箱，结果保存为新会话
- 支持选择电脑 Codex 的 `automation.toml` 和 `memory.md` 导入：保留 RRULE、模型、思考强度、原提示词与记忆，映射 Windows 工作目录，并对 PowerShell、桌面浏览器登录态和原生工具做 fnOS 兼容检查；存在阻塞时完整保存但自动暂停
- 可直接在对话中让 Codex 创建定时任务、账户全局 Skill 和 skills-only 全局插件；这些本地工具都经过明确审批，插件先进入个人市场再由用户安装
- 深色与墨色主题统一使用语义化表面、表单、提示和悬浮层颜色，插件中心和设置页在暗色环境下保持清晰层级
- 内置 fnOS 工作台通知中心：任务运行、完成、失败、超时和等待输入状态持久化，支持全部、未读、运行中、失败、定时任务筛选、一键全部已读和点击通知跳转到对应项目会话
- 飞书 V2 自定义机器人与 Hermes 微信 Webhook 外部提醒；支持按事件启停、测试发送、可选飞书签名和 Hermes HMAC-SHA256 原始 Body 签名
- 类似 ChatGPT 的个人指令，并默认注入可编辑的飞牛 NAS 环境、安全和工具使用说明
- OpenAI / ChatGPT 设备码登录和 API Key 登录；显示当前套餐、主/次额度剩余比例与官方重置时间
- 支持保存多个 OpenAI / ChatGPT 账户并一键切换或删除附加账户；各账户使用独立的登录凭据、会话、Skills 和插件目录，删除时凭据目录先移入可恢复隔离区
- 额度界面识别官方 `rateLimitReachedType`、消费上限和多额度桶；缺少百分比时显示未知，不再把缺失数据当成剩余 100%
- 设备码登录会持续确认 NAS 端凭据是否真正落盘，不再把“网页授权成功”误报为应用已登录
- 第三方 Responses API 与 Chat Completions 自动适配
- 自动从供应商 Base URL 的 `/models` 获取并切换模型，也支持手动填写模型 ID
- 一个代理配置可同时填写 HTTP、HTTPS、SOCKS5；供应商可继承全局、指定代理或强制直连
- 聊天顶部可为每个会话单独开启命令联网；代理切换会先从 NAS 侧测试，直连会清除 Codex 子进程继承的旧代理变量
- SQLite 持久化；API Key、代理密码使用 AES-256-GCM 加密
- 首次使用自设访问密码、HttpOnly 持久登录、工作目录限制、路径穿越防护
- 首页直接填写 API 令牌，顶部切换供应商和模型
- 项目文件、图片和 Markdown 预览，Git 改动红绿差异展示；产物中心自动聚合 HTML、PDF、图片、音视频、压缩包、FPK 和 APK，HTML 等产物在隔离的新标签页打开
- 长会话分段加载和浏览器原生渲染跳过，工具执行过程默认折叠
- 模型请求失败、自动重试和空回复会直接显示在聊天中，可复制具体错误并从原消息重试
- ChatGPT 风格顶部栏、消息操作栏和输入框；背景支持填满、完整显示、拉伸、平铺、位置、模糊和内容面板透明度，手机窄屏布局经过单独适配
- 通过 fnOS iframe 在当前桌面窗口打开，不跳转新标签页
- 会话快速切换会丢弃过期请求，归档只影响所选会话，不再触发上游的派生会话级联归档

## 飞牛开放平台集成

- 前端使用飞牛官方 [`@trimjs/web-app`](https://www.npmjs.com/package/@trimjs/web-app)，安装包声明 `micro_app=true`。
- “使用飞牛打开”和“在文件管理器中定位”分别调用官方 `openFile`、`openFileManager`，不再猜测桌面私有 URL 或内部消息协议。
- fnOS 官方统一网关能够复用 NAS（包括 FN Connect 访问入口）的登录态，并向应用后端转发可信用户 Header；安卓客户端应优先接统一网关，不逆向 FN Connect 私有协议。
- 生命周期会探测飞牛 Docker CLI 并加入 Codex 的 `PATH`。固定 Compose 应用应通过官方 `docker-project` 资源声明；任意控制宿主 Docker 套接字接近 root 权限，本安装包不会默认静默开放。

## 通知配置

在“设置 → 通知设置”中配置渠道：

- fnOS 工作台通知中心始终启用，通知和未读状态只保存在应用 SQLite 中。飞牛官方开放平台目前没有公开向系统通知中心写入消息的 API，因此本应用不会调用私有接口或修改飞牛系统数据库。
- 飞书填写 V2 自定义机器人 Webhook；如果群机器人启用了签名校验，再填写签名 secret。
- Hermes 填写完整 notify 地址（例如 `http://192.168.5.4:8644/webhooks/notify`）和 notify 路由 secret。局域网、localhost 和私有 IPv4 地址会自动直连，不经过应用默认代理。
- Webhook 地址与 secret 均由应用主密钥使用 AES-256-GCM 加密；公开接口、前端和日志只返回掩码。

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
`nodejs_v24`，并把该运行时的 `node`、`npm` 和 `npx` 暴露给 Codex 项目命令。安装后会创建 `codexweb` 共享目录：项目默认位于
`codexweb/projects`，应用密钥和 Codex 登录信息位于
`codexweb/.codex-system`。卸载和升级不会主动删除这些数据。
