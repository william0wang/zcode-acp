# zcode-acp-server

[![CI](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**[English](README.md)** | 简体中文

一个独立的 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）服务端，将无头模式的 **ZCode** app-server 桥接到支持 ACP 的编辑器，例如 [Zed](https://zed.dev) 和 JetBrains IDE。

本服务端以子进程方式启动 ZCode 无头 app-server（`zcode app-server --stdio`），将其内部事件流翻译为 ACP `session/update` 通知，并把 ZCode 的交互通道桥接到 ACP —— 当客户端支持时优先使用 `elicitation/create`，否则回退到 `session/request_permission` —— 从而让编辑器获得原生的、一流的编码助手体验。

## 为什么选 zcode-acp

- **编辑器原生体验** —— 流式改动以真实 diff 呈现，权限确认、计划模式都走 Zed / JetBrains 自己的 agent 面板，无需并排终端。
- **官方 harness，而非重新实现** —— 驱动真实的 `zcode app-server`：原生工具、skills、MCP 与斜杠命令、自动压缩、会话恢复/分叉。
- **不止于编辑器** —— 完整的双语终端 REPL（`zcode-acp`，中/英可切换，SSH 下可用），手机/网页访问相同会话（`zcode-acp-remote`），可选的只限写入沙箱。凭据留在 `~/.zcode`。

由于驱动的是真实 ZCode 客户端，你现有的 GLM Coding Plan 原样生效——当前的套餐权益（150% 额度加成、高于直连 API 的请求优先级）和包月计费方式都和在官方 App 中一致。编辑器设置无需任何 API key。

## 状态

早期开发中。核心框架已就绪，功能正在陆续加入。进度请看项目看板。

## 环境要求

- **Node.js ≥ 22**（桥接层用 `node:sqlite` 同步 tasks-index；ZCode CLI
  运行时也要求 Node ≥ 22）
- 已安装 `zcode` CLI 并位于 `PATH` 上（或通过 `ZCODE_BIN` 指定）
- ZCode 凭证位于 `~/.zcode/v2/config.json`（由 ZCode App 创建）

## 安装

```bash
npm install -g zcode-acp-server
```

会同时安装两个 bin：`zcode-acp-server`（编辑器调用）和 `zcode-acp`（统一 CLI）。
在你的 ACP 客户端里配置启动它 —— 见下方的 **在 Zed 中配置** 或你的编辑器的 ACP 文档。

<details>
<summary>改为从源码安装</summary>

```bash
git clone https://github.com/william0wang/zcode-acp.git
cd zcode-acp-server
pnpm install
pnpm build
```

编译产物入口为 `dist/index.js`（同时作为 `zcode-acp-server` bin 暴露）。

</details>

## 在 Zed 中配置

将本服务端作为自定义 agent server 添加到 Zed。在 `~/.config/zed/settings.json`
（Windows 上为 `%APPDATA%\Zed\settings.json`）中：

```jsonc
{
  "agent_servers": {
    "ZCode": {
      "type": "custom",
      "command": "zcode-acp-server",
      "env": {
        // 仅自定义安装时需要——CLI 会从桌面应用内置路径或 PATH 自动发现
        // （见下方表格）。
        "ZCODE_BIN": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      },
    },
  },
}
```

从源码运行？改用 `"command": "node"` 与
`"args": ["/absolute/path/to/zcode-acp-server/dist/index.js"]`。

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
| `ZCODE_ACP_SANDBOX`                | _（未设置）_     | 设为 `1` 全局启用 macOS Seatbelt 沙箱限制 Agent 的文件写入；项目级则在 `<工作区>/.zcode/acp/sandbox.json` 里设 `"enabled": true`（见[沙箱](#沙箱)）。                                                                                                                               |
| `ZCODE_ACP_LANG`                   | _（继承）_       | 桥的用户可见文案（弹窗、状态/提示行、命令菜单描述）语言：`zh` 或 `en`。未设置时继承 ZCode APP 的语言设置（`~/.zcode/v2/setting.json` 的 `localePreference`/`locale`），再退回 `LC_ALL`/`LC_MESSAGES`/`LANG` 区域设置，默认英文。                                                    |

## 沙箱

可选的 macOS Seatbelt 写入隔离：双开关（全局 `ZCODE_ACP_SANDBOX=1`，或项目
级在自动创建的 `<工作区>/.zcode/acp/sandbox.json` 里设 `"enabled": true`），
白名单之外的写入会弹放行/拒绝确认，"始终"决定可见地持久化在该配置里；放行
后后端自动以加宽的 profile 重启并续接被中断的任务。完整手册（英文）：
[docs/SANDBOX.md](docs/SANDBOX.md)。

## 远程访问

设置 `ZCODE_ACP_REMOTE=1` 后，bridge 会额外通过机器级 hub 守护进程把**相同
的会话**暴露到 WebSocket——手机或浏览器可以旁观、驱动、甚至在本机已知项目里
直接创建新会话，Zed 仍是主客户端并拥有进程。发现 API、隧道、鉴权与语义：
[docs/REMOTE.md](docs/REMOTE.md)；客户端集成契约：
[docs/REMOTE-CLIENTS.md](docs/REMOTE-CLIENTS.md)。

## 统一 CLI（zcode-acp）

本包所有能力收敛在一条命令下：交互式终端聊天 REPL（原生滚动回溯）、套餐
用量卡片（`zcode-acp quota`，GLM + Opencode Go）、远程 hub 守护进程
（`zcode-acp hub`）以及编辑器调用的 stdio server（`zcode-acp server`）。
REPL 按键、补全、历史与配额配置详见 [docs/CLI.md](docs/CLI.md)。

## ACP Registry

本服务端兼容 [ACP Registry](https://agentclientprotocol.com/get-started/registry)。它在 `initialize` 时声明一个 `agent` 类型的认证方法——GLM API key 由 ZCode 后端从 `~/.zcode/v2/config.json` 读取，**编辑器侧无需配置任何凭据**。

Registry 提交资产位于 [`registry/zcode-acp/`](registry/zcode-acp/)（`agent.json` + `icon.svg`）。包发布到 npm 后，将该目录复制到 [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) 的 fork 中并提 PR——CI 会校验 `agent.json` schema、图标，以及 `initialize` 返回的 `authMethods` 非空。

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
- [沙箱](docs/SANDBOX.md) —— 沙箱完整手册（开关、白名单、弹窗、验证）
- [远程访问](docs/REMOTE.md) —— hub、发现 API、隧道、远程创建会话
- [统一 CLI](docs/CLI.md) —— REPL、配额卡片、hub/server 子命令
- [开发](docs/DEVELOPMENT.md) —— 本地开发、调试、新增扩展方法
- [故障排查](docs/TROUBLESHOOTING.md) —— 常见问题排查

## 贡献

欢迎贡献！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解环境搭建、代码风格、
commit 约定和 PR 检查清单。重要变更记录在 [CHANGELOG.md](CHANGELOG.md)。

感谢每一位贡献者（由[贡献者图谱](https://github.com/william0wang/zcode-acp/graphs/contributors)
自动生成，覆盖全部历史贡献者）：

<a href="https://github.com/william0wang/zcode-acp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=william0wang/zcode-acp" alt="贡献者" />
</a>

## 相关项目

- [glm-acp-agent](https://github.com/stefandevo/glm-acp-agent) —— 自包含的 ACP agent，直接调用 GLM API；zcode-acp 则桥接真实的 `zcode app-server`，继承其完整的官方 harness。
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) / [codex-acp](https://github.com/agentclientprotocol/codex-acp) —— Claude 与 Codex CLI 的官方 ACP 适配器；zcode-acp 是同一思路在 ZCode CLI 上的实现。
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
