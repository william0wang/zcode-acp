# zcode-acp-server

[![CI](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**[English](README.md)** | 简体中文

一个独立的 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）服务端，将无头模式的 **ZCode** app-server 桥接到支持 ACP 的编辑器，例如 [Zed](https://zed.dev) 和 JetBrains IDE。

本服务端以子进程方式启动 ZCode 无头 app-server（`zcode app-server --stdio`），将其内部事件流翻译为 ACP `session/update` 通知，并把 ZCode 的交互通道桥接到 ACP —— 当客户端支持时优先使用 `elicitation/create`，否则回退到 `session/request_permission` —— 从而让编辑器获得原生的、一流的编码助手体验。

## 状态

早期开发中。核心框架已就绪，功能正在陆续加入。进度请看项目看板。

## 环境要求

- **Node.js ≥ 22**（桥接层用 `node:sqlite` 同步 tasks-index；ZCode CLI
  运行时也要求 Node ≥ 22）
- 已安装 `zcode` CLI 并位于 `PATH` 上（或通过 `ZCODE_BIN` 指定）
- ZCode 凭证位于 `~/.zcode/v2/config.json`（由 ZCode App 创建）

## 安装

```bash
git clone <repo-url>
cd zcode-acp-server
pnpm install
pnpm build
```

编译产物入口为 `dist/index.js`（同时作为 `zcode-acp-server` bin 暴露）。在你的
ACP 客户端里配置启动它 —— 见下方的 **在 Zed 中配置** 或你的编辑器的 ACP 文档。

## 在 Zed 中配置

将本服务端作为自定义 agent server 添加到 Zed。在 `~/.config/zed/settings.json`
（Windows 上为 `%APPDATA%\Zed\settings.json`）中：

```jsonc
{
  "agent_servers": {
    "ZCode": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/zcode-acp-server/dist/index.js"],
      "env": {
        // 指向桌面应用内置的 ZCode CLI（默认不在 PATH 上）。
        // 各平台路径见下方表格。
        "ZCODE_BIN": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      },
    },
  },
}
```

重启 Zed，然后从 agent 下拉菜单中选择 **ZCode**。

### 各平台的 `ZCODE_BIN` 路径

ZCode CLI 内置于桌面应用中，默认不会加到 `PATH`。用 `ZCODE_BIN` 指向内置的
`zcode.cjs`：

| 平台        | `ZCODE_BIN` 路径                                           |
| ----------- | ---------------------------------------------------------- |
| **macOS**   | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` |
| **Windows** | `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`    |
| **Linux**   | 解压后的应用目录内：`<安装目录>/resources/glm/zcode.cjs`   |

> 如果路径与实际安装不符，可用以下命令定位：
>
> ```bash
> # macOS / Linux
> find / -name zcode.cjs -path '*resources/glm*' 2>/dev/null
> # Windows (PowerShell)
> Get-ChildItem -Path $env:LOCALAPPDATA,$env:APPDATA,'C:\Program Files' -Recurse -Filter zcode.cjs -ErrorAction SilentlyContinue
> ```

## 环境变量

| 变量                               | 默认值           | 用途                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_BIN`                        | `zcode`          | ZCode CLI 二进制文件路径或其 `.cjs` 入口                                                                                                                                                                                                                                            |
| `ZCODE_NODE`                       | _（自动发现）_   | 显式指定运行 `ZCODE_BIN` 的 Node 二进制（必须支持 `node:sqlite`）                                                                                                                                                                                                                   |
| `ZCODE_MODEL`                      | _（来自 config） | 覆盖当前使用的模型 id                                                                                                                                                                                                                                                               |
| `ZCODE_BASE_URL`                   | _（来自 config） | 覆盖 provider 的 base URL                                                                                                                                                                                                                                                           |
| `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` | _（未设置）      | 触发自动压缩的绝对 token 阈值。每次回合成功完成后（`end_turn`），若 `contextUsed >= 阈值`，服务端会自动调用 `session/compact` 压缩上下文，为下一个 prompt 腾出空间。设为 `0` 或不设置则禁用（默认）。例如 `240000` 表示上下文达 24 万 token 时触发压缩。压缩目标由 ZCode 后端决定。 |
| `ZCODE_ACP_DEBUG`                  | _（未设置）      | 设为 `1` 可开启详细诊断日志（事件流、探测循环、状态更新）。默认安静——只输出警告类日志（后端管道错误、命令/权限失败、锁等待超时）。诊断桥接问题时开启；日志出现在 `Zed.log` 中，前缀为 `[zcode-acp]`。                                                                               |
| `ZCODE_ACP_REMOTE`                 | _（未设置）_     | 设为 `1` 启用[远程访问](#远程访问)——通过 WebSocket 向更多 ACP 客户端提供相同会话。                                                                                                                                                                                                  |
| `ZCODE_ACP_REMOTE_TOKEN`           | _（未设置）_     | 远程访问的鉴权 token。启用 `ZCODE_ACP_REMOTE=1` 时**必填**；缺失则远程保持禁用。                                                                                                                                                                                                    |
| `ZCODE_ACP_HUB_PORT`               | `8377`           | 机器级 `zcode-acp-hub` 的端口。隧道只映射这一个端口。                                                                                                                                                                                                                               |
| `ZCODE_ACP_HUB_HOST`               | `127.0.0.1`      | hub 绑定地址。`0.0.0.0` 会暴露仅 token 保护的明文面——只用于容器化隧道 agent 所在的私网接口（见[远程访问](#远程访问)）。                                                                                                                                                             |
| `ZCODE_ACP_REMOTE_PORT`            | `8378`           | bridge ACP 端点的起始回环端口。每个 bridge（每个编辑器窗口）自动递增取下一个空闲端口。                                                                                                                                                                                              |

## 远程访问

设置 `ZCODE_ACP_REMOTE=1` 后，bridge 会额外通过 WebSocket 接收 ACP 连接，
手机或浏览器即可观看并驱动与编辑器**相同的会话**。Zed（或任何 stdio ACP
编辑器）仍是主客户端并拥有进程：编辑器断开时，bridge 连同所有远程连接
一起退出。

```text
phone / browser ──WS── 隧道 ── hub (127.0.0.1:8377, 唯一入口)
                                │ 字节级代理
                                ▼
                  bridge ACP 端点 (127.0.0.1:8378+n)
                                │ 与 stdio 同一个 AgentApp
Zed ──────── stdio ────────────┘
```

启用方式：在上文「配置 Zed」的 `env` 里追加（Zed 会把这些合并进 agent
的环境变量）：

```json
"ZCODE_ACP_REMOTE": "1",
"ZCODE_ACP_REMOTE_TOKEN": "<一段足够长的随机密钥>"
```

相关环境变量（详见上文表格）：`ZCODE_ACP_REMOTE`（开关）、
`ZCODE_ACP_REMOTE_TOKEN`（必填 token）、`ZCODE_ACP_HUB_PORT`（hub 端口，
默认 8377）、`ZCODE_ACP_HUB_HOST`（hub 绑定地址）、
`ZCODE_ACP_REMOTE_PORT`（bridge 端点起始端口，默认 8378）。

**Hub。** 第一个启用远程的 bridge 会以 detached 方式拉起机器级单例
`zcode-acp-hub`（监听 `ZCODE_ACP_HUB_PORT`，也可手动运行）。它只做三件事：
token 鉴权、实例发现、字节级 WebSocket 代理——不保存会话状态、不解析 ACP。
空闲约 10 分钟后退出，需要时再被拉起。每个 bridge 每 10 秒注册一次作为
心跳，心跳停止约 30 秒后从发现列表移除；客户端刷新时也可调用
`GET /api/instances?probe=1` 主动探测，立即清理不可达的实例。

**语义。** 所有 agent 通知广播给每个已连接客户端；权限 / elicitation 请求
发给所有客户端，**先应答者生效**，其余客户端收到 `$/cancel_request` 关闭
对话框。同一会话的并发 prompt 与单编辑器一样串行化。任一客户端声明的能力
按 OR 合并。

**隧道。** 面向单端口隧道（Cloudflare Tunnel、frp）设计：只映射 hub 端口。
frp 的 `tcp` 模式原样透传 WebSocket；Cloudflare Tunnel 会断开空闲连接，
hub 因此在两段链路上每 30 秒发送 keepalive ping。bridge 端点本身只监听
回环地址，永不直接暴露。

要构建远程客户端（Web、移动端或 CLI）？完整的集成契约（端点、帧格式、
生命周期时序、故障恢复、平台注意事项）见
[docs/REMOTE-CLIENTS.md](docs/REMOTE-CLIENTS.md)。

## 独立配额查询 CLI（zcode-quota）

除了 ACP server，本包还附带一个 `zcode-quota` 命令，可在**终端**里直接查询
用量——无需编辑器，也无需 server 运行。默认在一张卡片里同时显示
**GLM Coding Plan** 和 **Opencode Go**；传入 provider 参数可只看其中一个。

GLM 凭证读取自 `~/.zcode/v2/config.json`。Opencode Go 凭证来自环境变量
（dashboard 需要浏览器 cookie——见下方 [Opencode Go 配置](#opencode-go-配置)）。

```bash
# 双平台（默认）：GLM + Opencode Go 合并为一张卡片
zcode-quota

# 只看某一个 provider
zcode-quota glm            # 仅 GLM Coding Plan
zcode-quota go             # 仅 Opencode Go（rolling + weekly + monthly 三窗口）

# 常驻监控：清屏并每 30s 刷新（默认）
zcode-quota -w
zcode-quota go -w          # 只监控 Opencode Go

# 自定义刷新间隔（秒，最小 10）
zcode-quota --watch --interval 60

# 纯文本单色进度条（终端默认是彩色）
zcode-quota --plain
```

默认情况下 CLI 会渲染热力配色（绿→黄→红）的进度条，并把用量数字叠在条内，
这样每行更紧凑。传 `--plain`（或 `-p`）切回经典的 `█`/`░` 单色布局。当 stdout
被管道或重定向时，彩色也会自动关闭，保证捕获到的输出干净。

watch 模式会原地清屏重绘卡片，效果类似 `top`/`htop`。按 `Ctrl-C` 退出。
之所以设最小间隔 10s，是因为配额 API 内部有 10s 缓存——更短的间隔只会一直
返回过期的缓存值，没有意义。

未全局安装时，可直接运行构建产物：

```bash
node dist/bin/quota.js -w
```

### Opencode Go 配置

Opencode Go 订阅用量没有 JSON API——CLI 抓取的是登录后的 dashboard 页面
`opencode.ai/workspace/<id>/go`，因此需要你的浏览器 `auth` cookie。设置两个
环境变量：

```bash
export OPENCODE_GO_WORKSPACE_ID="wrk_你的工作区id"
export OPENCODE_GO_AUTH_COOKIE="Fe26.2**你的cookie值"
```

获取方式：

1. **Workspace ID**——打开 `https://opencode.ai`，进入你的 Go 工作区，从 URL
   里复制 `wrk_…` id（`https://opencode.ai/workspace/<wrk_…>/go`）。
2. **Auth cookie**——打开浏览器开发者工具（F12）→ Application → Cookies →
   `opencode.ai` → 复制名为 `auth` 的 cookie 值（以 `Fe26.2**` 开头）。

未设置这两个变量时，默认的双平台模式会**静默退化为只显示 GLM**（不报错）。
若明确运行 `zcode-quota go` 但未配置，会打印一条配置提示。把它们加到 shell
配置文件（`~/.zshrc` / `~/.bashrc`）即可持久化。

## ACP Registry

本服务端兼容 [ACP Registry](https://agentclientprotocol.com/get-started/registry)。它在 `initialize` 时声明一个 `agent` 类型的认证方法——GLM API key 由 ZCode 后端从 `~/.zcode/v2/config.json` 读取，**编辑器侧无需配置任何凭据**。

Registry 提交资产位于 [`registry/zcode-acp-server/`](registry/zcode-acp-server/)（`agent.json` + `icon.svg`）。包发布到 npm 后，将该目录复制到 [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) 的 fork 中并提 PR——CI 会校验 `agent.json` schema、图标，以及 `initialize` 返回的 `authMethods` 非空。

## 开发

```bash
pnpm install
pnpm build       # tsc → dist/
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint（警告为建议性质；错误会导致 CI 失败）
pnpm test        # vitest
pnpm format      # prettier on src/
```

CI 会在每次 push 和 pull request 时运行 `typecheck`、`lint`、`build` 和
`test` —— 推送前请在本地跑一遍（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

> **提示（Node 版本管理）**：本项目通过根目录的 `.node-version` 锁定 Node 22，
> 推荐配合 [fnm](https://github.com/Schniz/fnm) 或 [nvm](https://github.com/nvm-sh/nvm)
> 使用 —— 进入目录即自动切换到 Node 22。pnpm 的版本由本地环境（corepack）管理。

## 架构

服务端按 ACP 协议分层组织：

- `backend/` —— ZCode 子进程客户端：spawn、reader-loop 多路复用、事件流监听、同步请求/响应
- `translators/` —— 将 ZCode 事件转为 ACP `session/update` 通知（事件流 + 快照 diff）
- `interaction/` —— 将 ZCode `interaction/*` 服务端请求桥接到 ACP，优先 `elicitation/create`，回退 `session/request_permission`（工具授权、ExitPlanMode、AskUserQuestion）
- `handlers/` —— ACP 方法处理器（`session/new`、`session/prompt` 等）和 turn 引擎
- `config/` —— model / mode / thought-level 的 configOptions 和运行时模型切换
- `server.ts` —— 共享状态和处理器注册
- `index.ts` —— 通过 ACP SDK 的 stdio 连接

完整架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 版本兼容性

| ZCode CLI 版本 |  支持  | 说明                     |
| :------------: | :----: | ------------------------ |
| **>= 0.15.0**  |  完整  | 所有扩展方法可用         |
| **>= 0.14.8**  |  完整  | 事件流推送、所有扩展方法 |
|  **< 0.14.8**  | 不兼容 | 无事件流订阅能力         |

## 文档

- [架构](docs/ARCHITECTURE.md) —— 事件流、双路径去重、模块职责
- [协议](docs/PROTOCOL.md) —— ZCode JSON-RPC 协议细节
- [开发](docs/DEVELOPMENT.md) —— 本地开发、调试、新增扩展方法
- [故障排查](docs/TROUBLESHOOTING.md) —— 常见问题排查

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解环境搭建、代码风格、
commit 约定和 PR 检查清单。重要变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 相关项目

- [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) —— 一个社区 Python 实现，将 ZCode 接入 MCP/ACP 生态。本项目参考了它的桥接架构和若干处理策略。

## 致谢

- [Agent Client Protocol](https://agentclientprotocol.com/)（Apache 2.0）—— ACP 协议规范
- [ZCode](https://zcode.z.ai) / [智谱 Z.AI](https://z.ai) —— GLM 模型与 ZCode CLI
- [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) —— 参考实现，本项目的设计借鉴了它的桥接架构

## 隐私

**无遥测、无追踪** —— 本服务端不向任何方上报任何信息。除 ACP SDK 外唯一运行时依赖是
`zod`。

你的提示词、代码、文件内容通过**本地管道**在编辑器与 ZCode 后端之间中转；这些数据会到达
GLM 云端 API，仅因 ZCode 后端本身为推理而发送——本服务端不增加任何额外去向。

| 方面 | 做什么 & 为什么                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网络 | 全代码库仅一处对外请求：配额 GET（`open.bigmodel.cn` / `api.z.ai`），只带 API key —— 为查询用量数字，不发送用户内容                                           |
| 凭据 | API key 从 `~/.zcode/v2/config.json` 读取，用于认证 ZCode 子进程和配额请求。从不记录日志、从不写入别处。OAuth 完全由 ZCode 子进程处理                         |
| 磁盘 | 不创建任何新文件。只写入已存在的 `~/.zcode/v2/tasks-index.sqlite` —— 这是**将会话同步到 ZCode App**，使其出现在历史列表和全文搜索中（存会话标题和首条提示词） |
| 日志 | 诊断信息输出到 stderr，用于排查桥接问题。即使开启 `ZCODE_ACP_DEBUG=1`，也绝不记录提示词/代码/密钥                                                             |

## 许可证

Apache-2.0。本项目沿用上游 ACP 规范的同一许可证。

## 免责声明

本项目为独立的社区项目，与智谱 Z.AI 官方无任何隶属、认可或赞助关系。ZCode 是智谱 Z.AI 的产品。
