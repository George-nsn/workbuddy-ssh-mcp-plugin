# SSH 可视化管理面板（ssh-mcp-dashboard）

> 基于开源项目 [`classfang/ssh-mcp-server`](https://github.com/classfang/ssh-mcp-server)（v1.10.0）构建的本地 Web 控制台。  
> 把「SSH 命令执行、文件浏览、文件传输、后台任务、账号管理」做成图形界面，同时保留 WorkBuddy 对话式操作能力。

---

## 一、能力总览

### 界面与交互

采用浅色工作区与深色终端的分区设计，以蓝色作为操作强调色。卡片与活动服务器有轻微层次，工作区标题随模块切换；保留有助于识别连接状态与操作焦点的视觉提示。

- 桌面保留服务器侧栏；宽度不超过 800px 时切换为横向服务器卡片与可滚动模块导航。大表格只在卡片内横向滚动，不撑宽页面。
- 导航支持键盘 `←` / `→` 切换、`Home` / `End` 跳到首尾，并提供焦点提示、tab/tabpanel 语义及减少动态效果偏好。
- 右上角「黑色模式」可切换全站深色外观，再点「浅色模式」恢复；主题保存在当前浏览器的本机存储中，刷新后保持，不修改服务器账号或 MCP 配置。首次默认浅色；浏览器阻止保存时会明确提示，当前页面仍可切换。
- 所有样式、SVG 图标均内置，不请求外部字体、图标库或 CDN。刷新已有面板页面即可加载新界面，不需要重启 MCP。
- 项目已安装 GitHub Copilot 的 `frontend-design` 技能，位于 `.agents/skills/frontend-design/`；用于后续界面迭代，当前样式保持 SSH 运维工作台的简洁与易读，不额外堆叠动效或装饰。
- 本轮界面验证：面板 **26 项测试通过**，覆盖主题初始化、双向切换、刷新恢复与存储受限提示；浏览器检查了桌面、平板和 320px 手机布局、六个模块切换、账号弹窗、监控标签及键盘导航。预览数据仅在浏览器中模拟，不写入账号配置、不执行远程命令。

| 模块        | 能力                            | 说明                                                      |
| --------- | ----------------------------- | ------------------------------------------------------- |
| **账号管理**  | 增 / 删 / 改服务器                  | 共用 `ssh-config.json`，新版 MCP 在下次工具调用前加载；密码不回显前端        |
| **一键连接**  | 每台服务器独立「⚡ 连接」+ 顶部「全部连接」       | 实测建连（`echo __WB_PONG__`），显示状态与延迟                        |
| **连接诊断**  | 每台服务器「🧪 测试」                  | 分三步定位问题：TCP 网络 → SSH 认证 → 远程命令执行，每步给出处理建议               |
| **环境自检**  | 「🔍 一键检测环境」                   | 检查 Node、OpenSSH、ssh-keygen、MCP 进程、服务器配置、私钥可读性           |
| **密钥助手**  | 生成密钥对 / 打开密钥文件夹 / 公钥投放指引      | 默认 ed25519，可选 RSA-4096、ECDSA-521；含新手图解与 3 种公钥安装方式       |
| **服务器切换** | 左侧列表点选即切换                     | 当前服务器在顶部与终端标题实时显示                                       |
| **文件传输**  | 拖拽上传、点击下载、传输记录                | 浏览器直传，无需记忆服务器端路径                                        |
| **文件查看**  | 目录浏览、点击查看、在线编辑保存、文件内查找        | 支持上级目录、面包屑导航                                            |
| **文件查找**  | 按文件名（`find`）/ 按内容（`grep -rn`） | 在当前目录及子目录递归搜索                                           |
| **终端**    | 历史检索 + 输出 + 命令输入三区布局          | 上方只查历史、下方只输入；支持选中复制、右键粘贴、Ctrl+滚轮缩放                      |
| **AI 助手** | 终端内 `/workbuddy` 对话           | `/workbuddy-mode` 换模型、`/workbuddy-think` 调思考与上下文；只建议不执行 |
| **后台任务**  | 长任务启动、状态轮询、终止                 | 任务状态存在远端 `~/.ssh-mcp-jobs/`，断线不丢                        |
| **操作监控**  | 汇总 Dashboard / WorkBuddy 等 MCP 操作 | 5 秒刷新，展示客户端、实例心跳、配置版本、执行结果与规则风险评级 |

---

## 二、架构与实现原理

### 2.1 三层架构

```
┌────────────────────┐   HTTP / REST    ┌──────────────────┐   stdio JSON-RPC   ┌──────────────────┐   SSH/SFTP   ┌──────────────┐
│  浏览器 index.html  │ ───────────────▶ │  server.js       │ ─────────────────▶ │ ssh-mcp-server   │ ───────────▶ │ 远程服务器    │
│  （单文件，无框架）  │ ◀─────────────── │  （零依赖 Node）  │ ◀───────────────── │ （MCP 子进程）    │ ◀─────────── │              │
└────────────────────┘                  └──────────────────┘                    └──────────────────┘              └──────────────┘
```

为什么这样设计：

1. **浏览器不能直接说 SSH**。浏览器没有 TCP/SSH 能力，必须有一个本地进程代为执行。
2. **不重复造轮子**。SSH 连接、SFTP、密钥认证、堡垒机、2FA 等逻辑已经由 `ssh-mcp-server` 实现并经过验证；面板只做「协议翻译 + 界面」。
3. **复用 WorkBuddy 同一套配置**。面板直接读写 `../ssh-mcp-server/ssh-config.json`，与 WorkBuddy 连接器共用服务器清单，改一处两边生效。

### 2.2 MCP 桥接是怎么工作的

`ssh-mcp-server` 是一个 MCP（Model Context Protocol）服务器，标准形态是「stdin 收 JSON-RPC 请求、stdout 回 JSON-RPC 响应」：

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize",...}
← {"jsonrpc":"2.0","id":1,"result":{...}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute-command","arguments":{...}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"..."}]}}
```

`server.js` 做的事：

- 用 `child_process.spawn` 拉起 MCP 子进程，按行缓冲解析 stdout，按 `id` 把响应分发给对应的 Promise（`pending` Map）；
- 启动时完成一次 `initialize` + `notifications/initialized` 握手；
- 把每个 REST 接口翻译成一次 `tools/call`。

### 2.3 工具映射表

| 前端动作      | REST 接口                          | MCP 工具            | 实际行为                                  |
| --------- | -------------------------------- | ----------------- | ------------------------------------- |
| 连接 / 全部连接 | `POST /api/connect`              | `execute-command` | 执行 `echo __WB_PONG__`，成功即视为连通，记录耗时    |
| 执行命令      | `POST /api/exec`                 | `execute-command` | 远端 shell 执行，返回 stdout+stderr          |
| 列出目录      | `POST /api/files/list`           | `execute-command` | `LC_ALL=C ls -la <path>`，前端解析成表格      |
| 查看文件      | `POST /api/files/read`           | `read-file`       | SFTP 读取文本（默认最多 200 KB）                |
| 保存文件      | `POST /api/files/write`          | `write-file`      | SFTP 写入，避开 shell 转义问题                 |
| 拖拽上传      | `POST /api/transfer/upload`      | `upload`          | 字节流落临时文件 → SFTP 上传 → 删除临时文件           |
| 点击下载      | `GET /api/transfer/download`     | `download`        | SFTP 下载到临时文件 → 以附件流回传 → 删除            |
| 按文件名查找    | `POST /api/search`（mode=name）    | `execute-command` | `find <dir> -maxdepth 4 -iname "*q*"` |
| 按内容查找     | `POST /api/search`（mode=content） | `execute-command` | `grep -rIn --max-count=30 <q> <dir>`  |
| 启动长任务     | `POST /api/job/start`            | `job-start`       | 远端后台执行，返回 job_id                      |
| 任务状态      | `POST /api/job/status`           | `job-status`      | 轮询输出末尾 16 KB                          |
| 账号增改删     | `POST/PUT/DELETE /api/accounts`  | （无）               | 原子替换配置 → 新版 MCP 在下次调用前加载      |
| 操作监控      | `GET /api/monitor`              | （无）               | 汇总同配置路径 MCP 的本地审计日志与心跳       |

### 2.4 连接状态是怎么判断的

MCP 协议本身不提供「连接状态查询」工具（`list-servers` 返回的 `connected` 只在本次会话建立过连接后才为 true）。因此面板采用 **主动探测**：

1. 点击「连接」→ 状态置为 `connecting`；
2. 调用 `execute-command` 执行 `echo __WB_PONG__`，超时 15 秒；
3. 输出包含 `__WB_PONG__` → `connected`，并记录往返耗时（延迟）；
4. 返回 `SSH_CONNECTION_FAILED` 等错误 → `error`，把服务器原始错误信息展示出来；
5. 任何命令执行成功后也会顺带把该服务器标记为已连接（避免状态过期）。

### 2.5 账号修改如何同步到 WorkBuddy

面板与 WorkBuddy 的 MCP **必须使用本地同一份配置文件和本次更新后的构建**。两个入口保持独立 stdio 进程与连接池，不需要把 WorkBuddy 改成 HTTP，也不需要面板代管 WorkBuddy 登录态。

```
保存账号 → 原子替换 ssh-config.json → 各 MCP 下次工具调用检查配置版本
         → 若有旧操作则等其结束 → 完整校验新配置 → 切换连接 → 执行新操作
```

配置未变化时不强制串行化；配置损坏时保留旧配置但拒绝新工具操作，不会悄悄继续使用过期凭据。空账号列表合法，删除最后一个账号不必杀进程。面板清空自己的连接与家目录缓存，避免显示旧账号状态。

**首次升级必须重启面板和 WorkBuddy 的 MCP 连接器一次**，已运行的旧 JavaScript 不会自动变成新实现。之后无需因普通账号修改重启。若 WorkBuddy 使用 `npx` 下载的旧发布包、不同目录的构建或另一份配置，这些改动不会同步；请在连接器设置中使用本地 `ssh-mcp-server/build/index.js` 和同一个 `--config-file` 绝对路径。监控页显示“已加载当前配置”才表示该实例已实际采用新版配置。

这属于**逻辑整合**（同配置、同风险规则、统一观测），不是把两个进程合成一个，也不共享 SSH 连接池。若将来需要单后端，可考虑现有 HTTP transport，但需要额外处理客户端兼容、认证和服务生命周期；本次没有自动改写 WorkBuddy 配置。

### 2.6 安全细节

- **服务只监听 `127.0.0.1`**，不暴露局域网/公网；
- **密码不回传**：`GET /api/overview` 只返回 `hasPassword`（布尔），编辑时密码留空表示保持原值；
- **命令注入防护**：拼接 shell 命令时统一走 `shq()` 转义（转义 `"`、`\`、`$`、`` ` ``）；搜索关键词同理；
- **上传大小限制** 2 GiB，采用流式落盘；JSON 接口请求体上限 2 MiB；
- **临时文件**存放在面板目录的 `.tmp/`，用后清理；MCP 子进程的工作目录固定为面板目录，从其他目录启动也不会误触本地路径限制；
- **配置写入保护**：兼容账号数组和以名称为键的对象；无法解析、结构无效或存在重复名称时明确报错，不会当成空清单覆盖；保存使用同目录临时文件与重命名替换；
- **删除账号只改本地配置**，不触碰远端服务器。

---

## 三、安装与启动

### 3.1 前置条件

| 依赖             | 要求               | 本机现状                                                   |
| -------------- | ---------------- | ------------------------------------------------------ |
| Node.js / npm | Node.js ≥ 22 | 安装 Node.js LTS 并将 `node`、`npm` 加入 PATH |
| MCP 源码        | 与 dashboard 文件夹并列 | `plugin\ssh-mcp-server` |
| SSH 凭据         | 私钥或密码（首次可跳过） | 之后在面板添加账号；私钥保存在本机 |

### 3.2 首次部署与启动

1. 从同一版本下载或复制 `ssh-mcp-dashboard` 与 `ssh-mcp-server` 两个目录，保持它们在同一个 `plugin` 目录下。
2. 安装 Node.js 22 或更新 LTS 版本；打开新的终端，确认 `node --version` 和 `npm --version` 均可运行。
3. **首次部署双击 `setup.bat`**。脚本会检查 Node/npm，校验并记住 `package-lock.json` 的 SHA-256；依赖缺失或锁文件更新时运行 `npm ci`；随后构建 TypeScript MCP；仅在 `ssh-config.json` 不存在时创建空配置。已有账号配置不会被覆盖。脚本退出码非零时按错误提示处理，不能跳过失败继续启动。
4. 双击 `start.bat` 启动面板。它会复用部署检查与构建，再启动 Dashboard 并打开浏览器。账号可在「账号」页添加；也可以直接安全地编辑 MCP 目录下的 `ssh-config.json`。
5. 若希望 WorkBuddy 也能操作这些账号，在 WorkBuddy 的 MCP 连接器中配置本地 MCP 入口（路径替换成 `where node` 和你的实际安装目录），保存后重启/信任连接器：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "D:/WorkBuddy/plugin/ssh-mcp-server/build/index.js",
        "--config-file",
        "D:/WorkBuddy/plugin/ssh-mcp-server/ssh-config.json"
      ]
    }
  }
}
```

**路径和配置必须一致**：Dashboard 与 WorkBuddy 应指向同一份 `ssh-config.json`，且 WorkBuddy 应使用此目录构建出的 `build/index.js`。首次换到新版构建后，重启 WorkBuddy MCP 连接器一次；之后账号变更会在下一次工具调用前加载。

默认端口 **8080**；被占用时自动尝试 8081–8085。可在启动前设置 `DASHBOARD_PORT`：

```bat
cd /d D:\WorkBuddy\plugin\ssh-mcp-dashboard
set DASHBOARD_PORT=9090
call start.bat
```

停止：运行窗口按 `Ctrl+C`，或直接关闭窗口。

部署期间需要联网下载 npm 依赖；依赖与锁文件未变时，日常启动不会重复安装，但会重新构建本地 TypeScript 源码。面板和 WorkBuddy 各自运行一个 MCP 进程、各自维护 SSH 连接池，但共用配置。

**更新源码时**：先关闭旧面板，再替换源码；从 dashboard 目录运行 `setup.bat` 构建，然后重新运行 `start.bat`。若同时更新 MCP 构建，退出并重启 WorkBuddy 的 MCP 连接器一次。`setup.bat` 依据锁文件哈希判断是否需要重新安装依赖，重复运行不会反复下载；不会删除或覆盖已有 `ssh-config.json`。

---

## 四、使用方法

### 4.1 添加 / 编辑服务器（账号管理）

1. 左侧「＋ 添加」或「账号」页 →「＋ 添加服务器」；
2. 填写：名称（唯一标识，仅字母数字 `._-`）、主机、端口、用户名；
3. 选择认证方式：
   - **私钥**：填私钥路径（如 `C:/Users/<your-user>/.ssh/id_ed25519`）；
   - **密码**：填密码（保存后不回显，编辑时留空即不修改）；
4. 「保存」→ 列表出现新服务器 → 新版 MCP 在下次工具调用前加载；到「操作监控」检查配置版本。

删除：账号页 →「删除」→ 确认（只删本地配置）。

### 4.2 连接、测试与切换

- 单台连接：服务器卡片右下角「⚡ 连接」，成功后显示绿色状态点 + 延迟（如 `128 ms`）；
- 全部连接：顶部「⚡ 全部连接」，依次探测并汇总成功数；
- **单台诊断**：卡片或账号页的「🧪 测试」，弹窗分三步给出结论：
  1. `① 网络连通（TCP）` —— 直接连目标端口，判断是网络/防火墙问题还是凭据问题；
  2. `② SSH 认证` —— 通过 MCP 实际握手，失败时显示服务器原始报错与修复建议；
  3. `③ 远程命令执行` —— 执行 `whoami; hostname; uname` 验证账号权限。
- 切换：左侧点任意服务器卡片，顶部与终端标题同步切换。

### 4.3 密钥与环境自检（新手必读）

**先理解概念**（「🔑 密钥」页有同样内容）：

| 概念         | 通俗解释             | 放哪里                          |
| ---------- | ---------------- | ---------------------------- |
| 公钥（`.pub`） | 像**锁芯**，可以公开给任何人 | 服务器 `~/.ssh/authorized_keys` |
| 私钥（无后缀）    | 像**唯一钥匙**，等于密码   | 只留在本机 `~/.ssh`，绝不外发          |

**操作顺序**：

1. 点「🔍 一键检测环境」→ 按结果逐条处理红色/黄色项（缺 OpenSSH、缺密钥、私钥不可读等）；
2. 点「＋ 生成新密钥」→ 选算法（默认 ed25519，老服务器选 RSA 4096）、填文件名与备注 →「生成」；
3. 生成后可「📂 打开密钥文件夹」查看文件；点「复制公钥」；
4. 把公钥装到服务器，三种方式任选：
   - **方式 A**：本机终端执行 `ssh-copy-id -i <公钥路径> -p <端口> <用户>@<主机>`（面板会自动生成可复制的完整命令）；
   - **方式 B**：登录服务器后 `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "<公钥内容>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`；
   - **方式 C**：云厂商控制台 → 密钥对 → 导入公钥 → 绑定实例；
5. 回到左侧点「⚡ 连接」或「🧪 测试」验证。

> 私钥文件权限建议 `600`；如果给密钥设置了密码短语，每次连接需输入（面板当前不保存密码短语）。

### 4.4 终端（经典布局 + AI 指令）

输入框**贴在输出流底部**，提示符与输出连续，和真实终端一致；历史检索独立在最上方，可收起。

```
┌ ① 历史记录（只用于查找，可收起） ────────────────────────┐
│ 🔍 搜索   [全部|命令|AI]   清空   收起                    │
│ 10:39:12  203.0.113.14  ❯ ls -la …  成功                │
└──────────────────────────────────────────────────────────┘
┌ ② 终端（输出 + 内联提示符） ──────────────────────────────┐
│ ❯ df -h                                                   │
│ Filesystem      Size  Used Avail Use% Mounted on          │
│ ── 10:39 · 820 ms ──                                      │
│ zhaoxin@203.0.113.14:/home/data/zhaoxin$ █               │
└──────────────────────────────────────────────────────────┘
```

**交互**

| 操作                     | 行为                          |
| ---------------------- | --------------------------- |
| 左键拖选输出                 | 松开自动复制（仅在输出区内选中才触发，不干扰其他区域） |
| 右键（仅输出区）               | 粘贴剪贴板到提示符光标处；输入框/历史区保留系统菜单  |
| `Ctrl + 滚轮`            | 缩放终端字号 85%–180%，记忆比例        |
| `Enter` / `Ctrl+Enter` | 统一走分发：命令模式执行命令，AI 模式发给模型    |
| `↑` / `↓`              | 翻阅历史命令                      |
| 输入 `/`                 | 弹出指令菜单                      |
| 历史条目 单击 / 双击           | 填入提示符 / 直接执行                |

**指令列表**

| 指令                       | 作用                                                                                | 边界                                                          |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/workbuddy`             | 进入 AI 对话；`/workbuddy 磁盘满了怎么办` 直接问                                                 | 未配置时**先自动探测本机模型服务**（Ollama/LM Studio/vLLM），探测到就自动接入；没有才弹配置框 |
| `/workbuddy-mode`        | 列模型、按序号切换，或 `/workbuddy-mode <模型名>`                                               | 换模型会重置对话上下文                                                 |
| `/workbuddy-think`       | 1–4 选思考（off/low/medium/high），5–8 选上下文（4k/8k/16k/32k），或 `/workbuddy-think high 16` | 影响回答深度与历史预算                                                 |
| `/exit` `/clear` `/help` | 退出 AI / 清屏 / 帮助                                                                   | —                                                           |

**AI 能力从哪来（重要）**

WorkBuddy 桌面端的模型会话**不对外开放 API**，面板是独立进程，无法直接复用它的登录态（实测其内置 CLI 在 Electron 外无法运行）。因此终端 AI 采用三级降级：

1. **本地模型**：自动探测 `127.0.0.1:11434`（Ollama）、`1234`（LM Studio）、`8000`（vLLM），有则免 Key 直接用；
2. **已保存配置**：`ai-config.json` 里的 Base URL + Key；
3. **手动配置**：任意 OpenAI 兼容接口（DeepSeek/OpenAI/通义/Kimi/自建）。

三步都不可用时，`/workbuddy` 会明确告知原因，而不是假装可用。

**为什么 top / vim 会报错或显示乱码**

面板通过 MCP 的**请求/响应通道**执行命令，不提供持续的键盘输入。MCP 的 `exec` 默认可分配 PTY（由账号配置的 `pty` 控制），但这不等于交互终端。`top`、`htop`、`vim`、`less` 这类**全屏交互程序**依赖终端尺寸和持续输入，在面板中不适合直接运行：

- `top` 只会输出终端控制序列（`ESC[?1l ESC>`），看起来像乱码或空白；
- `vim/nano` 直接退出或卡住；
- `less/more` 无法翻页。

实测（203.0.113.14）：`top` 返回 `\u001b[?1l\u001b>`、无内容；`top -b -n 1` 正常输出 CPU/内存表格。

**替代命令**

| 想做什么    | 交互式命令           | 面板里用这个                                       |
| ------- | --------------- | -------------------------------------------- |
| 看进程/CPU | `top` / `htop`  | `top -b -n 1 \| head -30`                    |
| 看日志     | `less` / `more` | `tail -n 100 <file>`、`sed -n '1,80p' <file>` |
| 编辑文件    | `vim` / `nano`  | 「文件」页点文件名直接编辑保存                              |
| 持续观察    | `watch`         | `while true; do <cmd>; sleep 2; done`（用后台任务） |

另外：面板会自动**清洗 ANSI 控制字符**（`ls --color=always`、`systemctl status`、`docker ps` 的彩色输出不会再显示成 `^[[01;36m` 这类乱码），并把 `\r` 进度条折叠成最终状态。

**边界**：AI 只输出建议与命令文本，**不执行任何命令**；请求只带服务器名与当前目录，不上传命令输出。

### 4.5 文件

| 操作          | 方式                               |
| ----------- | -------------------------------- |
| 浏览目录        | 「文件」页 →「↻」；点文件夹进入                |
| 地址栏跳转       | 顶部路径框**可直接编辑**，回车跳转（支持绝对路径）      |
| 后退 / 前进     | `←` `→`（保留 100 条目录历史，切换服务器时重置）   |
| 上级 / 家目录    | `↑` / `🏠`（家目录自动探测，不靠猜）          |
| 显示 / 隐藏隐藏文件 | `👁` 切换以 `.` 开头的文件，选择记忆在本地       |
| 查看文件        | 点文件名或「查看」→ 右侧编辑器显示内容             |
| 编辑保存        | 修改后「保存」（覆盖）或「另存为…」（输入新路径）        |
| 文件内查找       | 编辑器上方输入关键词，`↑`/`↓` 跳转，显示 `当前/总数` |
| 按文件名查找      | 搜索框 + 「按文件名」→ 递归匹配子目录            |
| 按内容查找       | 搜索框 + 「按内容 grep」→ 返回 `文件:行号:内容`  |
| 上传          | 「⇧ 上传」（上传到当前目录）或「传输」页拖拽          |
| 下载          | 文件行「↓」按钮，浏览器直接下载                 |

编辑器只显示文件正文，不包含 MCP 的 `[file]` / `[bytes]` 信息头。默认最多读取 200,000 字节；未读完整的文件仅提供只读预览，禁用保存与另存为，避免把文件截断覆盖。需要编辑大文件时，请先下载完整文件。切换服务器、关闭预览或打开其他文件后，过期读写响应不会改动当前编辑器。

### 4.6 传输

- 顶部设置目标目录，可点「使用当前目录」同步；
- 拖拽多个文件到虚线区域 → 逐个上传，右下角提示成功/失败；
- 「传输记录」保留最近 60 条（时间、方向、路径、大小、状态）。
- 浏览器附件下载仅支持单个文件；目录不显示下载按钮，接口误传目录时明确报错并清理临时目录。整目录传输请使用 MCP `download` 工具，或先在远端打包再下载。

### 4.7 后台任务（适用于构建/部署/训练）

```bash
# 在「终端」里也能直接跑，但超过 60 秒会被超时中断
# 长任务建议这样做：
nohup bash train.sh > train.log 2>&1 &
```

MCP 提供更规范的方式（当前面板已有接口，命令行/对话中可直接用）：

```json
{"name":"job-start","arguments":{"cmdString":"bash train.sh","connectionName":"prod"}}
{"name":"job-status","arguments":{"jobId":"<id>","connectionName":"prod"}}
{"name":"job-kill","arguments":{"jobId":"<id>","connectionName":"prod"}}
```

### 4.8 AI 助手配置（可选，用 `/workbuddy` 才需要）

支持任何 **OpenAI 兼容**接口（DeepSeek / OpenAI / 通义兼容模式 / Kimi / 自建网关）。

**配置**：终端右上角「⚙ AI」→ 选预设（自动填 Base URL）或手填 → 填 API Key → 填默认模型（可点「拉取模型列表」）→ 保存。

| 字段       | 说明                                          |
| -------- | ------------------------------------------- |
| Base URL | 到 `/v1` 为止，例如 `https://api.deepseek.com/v1` |
| API Key  | 只保存在本机 `ai-config.json`，不会回传到页面             |
| 默认模型     | 如 `deepseek-chat`、`gpt-4o-mini`             |
| 可用模型     | 逗号分隔多个，`/workbuddy-mode` 才能切换               |


**也可用环境变量**（适合临时测试）：`OPENAI_BASE_URL`、`OPENAI_API_KEY`。

**对接自建网关**：只要实现 `POST {baseUrl}/chat/completions` 与 `GET {baseUrl}/models`，返回 OpenAI 标准结构即可。

本机 `localhost`、`127.0.0.1`、`[::1]` 上的 OpenAI 兼容服务可以不填 Key；远程服务仍需 Key。历史消息裁剪始终保留面板的 system 指令；接口未返回有效文本时明确报错，不会显示为成功。

---

## 五、在 WorkBuddy 里怎么用

WorkBuddy 的扩展体系是「连接器 + MCP」，**没有开放自定义 UI 按钮的接口**，所以「集成进界面」实际有三条路径：

### 路径 1：对话（已启用）

WorkBuddy 连接器管理页里 `ssh-mcp-server` 已点过「信任」，10 个 SSH 工具直接可用，直接用自然语言即可：

> 「在 203.0.113.16 上看看磁盘和内存」  
> 「把 D:\report.pdf 传到 203.0.113.14 的 /home/zhaoxin/」  
> 「读一下 /etc/nginx/nginx.conf 并解释」

### 路径 2：技能（已配置）

已安装技能 `ssh-remote`（`C:\Users\<your-user>\.workbuddy\skills\ssh-remote\SKILL.md`），让「连接服务器 / 远程执行 / 上传下载 / 看日志」等说法稳定命中正确的工具与服务器，并带上安全约束（只读优先、破坏性操作先确认）。

### 路径 3：面板（本页面）

需要**可视化、批量操作、拖拽传文件**时用面板；需要**理解语义、批量分析、生成报告**时用对话。两者共用同一份 `ssh-config.json`。

---

## 六、REST API 参考

| 方法     | 路径                                           | 说明                       | 主要参数                                                    |
| ------ | -------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| GET    | `/api/health`                                | 健康状况                     | —                                                       |
| GET    | `/api/overview`                              | 账号列表 + 连接状态 + 配置路径       | —                                                       |
| GET    | `/api/servers`                               | MCP `list-servers` 原始结果  | —                                                       |
| POST   | `/api/accounts`                              | 新增账号                     | `name,host,port,username,authType,privateKey\|password` |
| PUT    | `/api/accounts`                              | 修改账号                     | 同上 + `originalName`                                     |
| DELETE | `/api/accounts?name=`                        | 删除账号                     | `name`                                                  |
| POST   | `/api/test`                                  | 单台分步诊断（网络/认证/执行）         | `name`                                                  |
| GET    | `/api/env/check`                             | 环境体检（Node/OpenSSH/密钥/配置） | —                                                       |
| GET    | `/api/keys`                                  | 列出本地密钥与指纹                | —                                                       |
| POST   | `/api/keys/generate`                         | 生成密钥对                    | `algorithm,name,comment,passphrase,overwrite`           |
| POST   | `/api/keys/open-folder`                      | 打开密钥所在文件夹                | `dir?`                                                  |
| GET    | `/api/keys/public?name=`                     | 读取公钥内容                   | `name`                                                  |
| POST   | `/api/connect`                               | 单台建连探测                   | `name`                                                  |
| POST   | `/api/connect-all`                           | 全部探测                     | —                                                       |
| POST   | `/api/exec`                                  | 执行命令                     | `connectionName,cmdString,timeout`                      |
| POST   | `/api/files/list`                            | 列目录（失败时返回 `reason`）      | `connectionName,path`                                   |
| POST   | `/api/files/home`                            | 探测远端真实家目录                | `connectionName`                                        |
| GET    | `/api/ai/config`                             | 读取 AI 配置（Key 不回传）        | —                                                       |
| POST   | `/api/ai/config`                             | 保存 AI 配置                 | `baseUrl,apiKey,model,models,thinking,contextK`         |
| POST   | `/api/ai/models`                             | 拉取可用模型                   | —                                                       |
| POST   | `/api/ai/chat`                               | AI 对话                    | `messages,model,thinking,contextK,server,cwd`           |
| POST   | `/api/files/read`                            | 读文件，返回正文和预览范围         | `connectionName,remotePath,length`                      |
| POST   | `/api/files/write`                           | 写文件                      | `connectionName,remotePath,content,append`              |
| POST   | `/api/search`                                | 查找                       | `connectionName,path,query,mode(name\|content)`         |
| POST   | `/api/transfer/upload`                       | 原始字节上传                   | query: `connectionName,remotePath,filename`             |
| GET    | `/api/transfer/download`                     | 下载附件                     | query: `connectionName,remotePath`                      |
| GET    | `/api/transfers`                             | 传输记录                     | —                                                       |
| POST   | `/api/job/start`、`/api/job/status`、`/api/job/kill` | 后台任务              | `connectionName,cmdString/directory` 或 `jobId`         |

`POST /api/files/read` 成功时保留原始 MCP 输出 `text`，并返回可直接编辑的 `content`、字节范围 `start/end/total` 与 `truncated`。消费者应使用 `content` 而不是 `text` 写回文件；`truncated=true` 时不能将预览当作完整文件保存。

示例：

```bash
curl -X POST http://127.0.0.1:8080/api/connect -H "Content-Type: application/json" -d "{\"name\":\"prod\"}"
curl -X POST http://127.0.0.1:8080/api/exec -H "Content-Type: application/json" \
     -d "{\"connectionName\":\"prod\",\"cmdString\":\"df -h\"}"
```

---

## 七、常见问题

| 现象                                                                      | 原因                                                                                        | 处理                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 文件页提示「读取失败：No such file or directory」                                   | 默认家目录猜错了——**不同服务器的家目录不一定在 `/home/<用户名>`**（例：`203.0.113.14` 的真实家目录是 `/home/data/zhaoxin`） | 点文件页「🏠 家目录」自动定位；或点「🔍 诊断」查看 `HOME` 与权限位                   |
| 文件页提示「输出无法解析（收到 N 行，但格式不匹配）」                                            | 远端 `ls` 输出格式特殊（BusyBox / SELinux / Windows）                                               | 按提示查看原始输出；用「终端」直接 `ls -la`；把输出贴给我可适配新的解析规则                 |
| 终端执行 `top` 报错 / 满屏乱码                                                    | 请求/响应界面不提供持续交互输入                                                                          | 改用 `top -b -n 1`；面板已自动拦截并提示，同时清理 ANSI 转义                   |
| 文件页只显示一个文件                                                              | 旧版本缺陷：SSH 返回 `\r\n`，正则被行尾 `\r` 截断，只有最后一行能解析（已在 v4.1 修复：统一归一化换行）                           | 升级到当前版本即可                                                  |
| 文件页提示「读取失败：Permission denied」                                           | 账号对目录无读权限                                                                                 | 让管理员放开权限，或换用有权限的账号                                         |
| `EPERM: operation not permitted, open 'C:\Users\<your-user>\.ssh\id_ed25519'` | 面板进程处在受限沙箱中（例如由 AI/容器代为启动），读不到 `~/.ssh`                                                   | **双击 `start.bat` 直接启动**；或检查安全软件是否锁定私钥文件                    |
| 连接失败：`All configured authentication methods failed`                     | 服务器未接受该公钥                                                                                 | 把 `id_ed25519.pub` 追加到服务器 `~/.ssh/authorized_keys`；或改用密码认证 |
| 连接超时                                                                    | 网络不通 / 端口被防火墙拦                                                                            | 先在本机 `ssh -p <端口> <用户>@<主机>` 验证                            |
| 启动提示 Node.js 版本过低或找不到 npm                                            | Node.js 未安装、版本低于 22 或 PATH 尚未刷新                                                          | 安装 Node.js 22+ LTS，开新终端并确认 `node --version`、`npm --version` |
| 启动时报缺少 `build/index.js` 或 MCP 依赖                                     | 尚未部署，或构建/依赖不完整                                                                        | 在 dashboard 目录运行 `setup.bat` 并处理其错误输出 |
| `setup.bat` 提示缺少 `package-lock.json` / `npm ci` 失败                     | 源码副本不完整，或网络/代理阻止下载依赖                                                               | 重新获取完整 MCP 源码并检查 npm 网络配置；安装失败不会继续启动 |
| WorkBuddy 看不到面板里添加的账号                                               | WorkBuddy 连接器使用了另一份配置文件或旧构建                                                          | 检查连接器中 `build/index.js`、`--config-file` 的绝对路径是否与面板一致 |
| 端口 8080 被占用                                                             | 旧实例未关闭                                                                                    | 关闭旧窗口，或看控制台自动切换后的端口                                        |
| 保存账号后状态变「未连接」                                                           | 面板主动清空旧连接状态缓存；各实例在下一次调用加载新配置                                             | 正常现象，重新点「连接」，并在监控页检查版本                              |
| 中文乱码                                                                    | 远端 locale 非 UTF-8                                                                         | 目录列表已强制 `LC_ALL=C`；命令输出取决于远端设置                             |
| 文件太大读不全                                                                 | `read-file` 单次上限                                                                          | 面板默认读 200 KB；大文件请用「下载」                                     |

---

## 八、已知限制

1. **不是完整远程 IDE**：面板提供命令与文件能力，不含远程 LSP、远程调试、远程终端 PTY。需要这些请用 VS Code + Remote-SSH。
2. **编辑大文件不便**：文本编辑器基于 textarea，超过 200 KB 建议下载后本地编辑再上传。
3. **无实时目录监听**：远端文件变化需手动「刷新」。
4. **上传并发为串行**：多文件逐个上传，避免打满带宽。
5. **WorkBuddy 无 UI 扩展接口**：无法把按钮嵌进 WorkBuddy 原生界面，只能用连接器/技能/本面板三种入口。

---

## 九、文件结构

```
D:\WorkBuddy\plugin\
├─ ssh-mcp-server\                 # MCP 服务本体（v1.10.0）
│  ├─ build\index.js               # 入口
│  ├─ ssh-config.json              # 服务器清单（面板与 WorkBuddy 共用）
│  └─ ssh-config.example.json      # 配置模板
└─ ssh-mcp-dashboard\              # 本面板
   ├─ setup.bat                    # 检查 Node/npm、安装依赖并构建
   ├─ setup.bat                    # 环境检查、依赖安装与 MCP 构建
   ├─ server.js                    # 后端（零依赖）
   ├─ public\index.html            # 前端（单文件）
   ├─ test\dashboard.test.js       # 后端、编辑器和真实进程回归测试
   ├─ start.bat                    # 启动脚本
   └─ README.md                    # 本文档
```

使用 `--config-file` 的 MCP 会在配置文件所在目录创建 `.ssh-mcp-monitor/<配置路径摘要>/`。该目录不应提交、打包或对外开放，不包含 SSH 配置副本。

---

## 十、安全建议

1. 面板不要改绑 `0.0.0.0`，不要做端口映射到公网；
2. 服务已内置同源防护：只接受 `Host: 127.0.0.1/localhost` 的请求，拒绝跨站 `Origin` 与 `Sec-Fetch-Site: cross-site`，写接口强制 `Content-Type: application/json`（阻断 CSRF 与 DNS rebinding）；
3. 命令拼接做参数转义并拒绝控制字符；Windows 远端路径额外拒绝 `& | < > ^ % " !`；
4. 「打开密钥文件夹」限制在 `~/.ssh` 内，拒绝 UNC 路径（防 NTLM 泄露）；
5. 修改 AI `Base URL` 到新主机时，会清空已保存的 Key，避免凭据被发往新地址；
6. 生产服务器在 `ssh-config.json` 中加命令白名单与路径限制：

```json
{
  "name": "prod",
  "host": "203.0.113.12",
  "port": 22,
  "username": "deploy",
  "privateKey": "C:/Users/<your-user>/.ssh/id_ed25519",
  "commandWhitelist": ["^ls(?: [A-Za-z0-9_./-]+)*$", "^cat [A-Za-z0-9_./-]+$", "^df .*"],
  "allowedRemotePaths": ["/var/log", "/srv/app"]
}
```

1. 避免用 root 直连生产机，建议专用部署账号 + sudo 白名单；
2. 面板具备远程命令执行能力，**离开电脑时请关闭**。

---

## 十一、迁移到其他 WorkBuddy / 其他电脑

面板与 MCP 都是「本地文件 + 一份 JSON 配置」，没有数据库、没有云端依赖，因此迁移就是**拷目录 + 改路径 + 点信任**。

### 11.1 需要带走的内容

| 内容     | 路径                                                         | 是否必须                 |
| ------ | ---------------------------------------------------------- | -------------------- |
| MCP 服务 | `D:\WorkBuddy\plugin\ssh-mcp-server\`（含 `build\`） | ✅ 必须（对话能力也依赖它）       |
| 服务器清单  | 上述目录下 `ssh-config.json`                                    | ✅ 必须（含账号与私钥路径）       |
| 可视化面板  | `D:\WorkBuddy\plugin\ssh-mcp-dashboard\`          | ⭕ 可选（只要对话可不带）        |
| 连接器配置  | `C:\Users\<用户>\.workbuddy\mcp.json`                        | ✅ 必须（在新机器重建）         |
| 私钥     | `C:\Users\<用户>\.ssh\id_*`                                  | ✅ 必须（**手动拷，别走公开渠道**） |
| 技能（可选） | `C:\Users\<用户>\.workbuddy\skills\ssh-remote\SKILL.md`      | ⭕ 可选                 |

### 11.2 迁移步骤

1. **拷贝两个源码目录**到目标机同一位置（例如放在 `D:\WorkBuddy\plugin\`）。首次部署在 dashboard 目录双击 `setup.bat`：
   ```bat
   setup.bat
   ```
   脚本检查 Node/npm，按锁文件安装依赖、构建 MCP，并在需要时创建空配置；不会覆盖已有账号文件。
2. **重建连接器配置**：新建/合并 `C:\Users\<新用户>\.workbuddy\mcp.json`。`command` 用 `where node` 得到的实际路径，`args` 使用下面这种 MCP 入口与配置文件的绝对路径：
   ```json
   {
     "mcpServers": {
       "ssh-mcp-server": {
         "command": "C:\\Users\\<新用户>\\.workbuddy\\binaries\\node\\versions\\<版本>\\node.exe",
         "args": [
           "D:/WorkBuddy/plugin/ssh-mcp-server/build/index.js",
           "--config-file",
           "D:/WorkBuddy/plugin/ssh-mcp-server/ssh-config.json"
         ]
       }
     }
   }
   ```
   > `command` 建议直接写**目标机 node.exe 的绝对路径**（`where node` 可查），避免依赖 PATH。
3. **确认 Node.js 已加入 PATH**：在新终端运行 `node --version` 和 `npm --version`；面板启动脚本会自动检查并调用 `setup.bat`。
4. **修正 `ssh-config.json` 中的私钥路径**：原机器是 `C:/Users/<your-user>/.ssh/id_ed25519`，新机器用户目录不同时必须改，否则连接报"文件不存在/不可读"。
5. **在新 WorkBuddy 里启用**：连接器管理页 → 右上角「自定义连接器」→ 找到 `ssh-mcp-server` → 点「信任」。
6. **启动面板**：双击 `start.bat`，浏览器自动打开；先点「🔍 一键检测环境」确认没有红项。

### 11.3 需要替换的绝对路径清单

| 文件                               | 需要改的字段                               | 示例                               |
| -------------------------------- | ------------------------------------ | -------------------------------- |
| `~/.workbuddy/mcp.json`          | `command`（node 路径）、`args[0]`（MCP 入口） | `C:\Users\Alice\...\node.exe`    |
| `ssh-mcp-server/ssh-config.json` | 每个账号的 `privateKey`                   | `C:/Users/Alice/.ssh/id_ed25519` |
| `ssh-mcp-dashboard/setup.bat`    | 无需写死 node 路径；确认 node 与 npm 在 PATH 中 | `where node`、`where npm`          |
| `ssh-mcp-dashboard/start.bat`    | 无需替换路径；会调用 setup 并使用 PATH 中的 node | —                                  |
| `ssh-mcp-dashboard/server.js`    | 一般**无需改**（入口与配置路径由 `__dirname` 自动推算） | —                                |

> 面板会自动读取 `../ssh-mcp-server/ssh-config.json`，因此**只要保持两个目录的相对位置不变**，就不需要改 `server.js`。

### 11.4 跨平台（macOS / Linux）

- 启动脚本换成 `start.sh`：
  ```bash
  #!/usr/bin/env bash
  cd "$(dirname "$0")" && node server.js --open
  ```
- `server.js` 的「打开文件夹」已按平台分支：Windows 用 `explorer.exe`，macOS 用 `open`，Linux 用 `xdg-open`；
- 私钥权限必须收紧：`chmod 600 ~/.ssh/id_*`、`chmod 700 ~/.ssh`；
- 端口若被占用会自动顺延，或用 `DASHBOARD_PORT=9090 node server.js` 指定。

### 11.5 分发给团队时的注意事项

1. **不要打包 `~/.ssh`**：私钥属于个人凭据，让每个人用自己的密钥（用「密钥」页生成即可）；
2. `ssh-config.json` 里可能含密码，建议：
   - 提供 `ssh-config.example.json` 作为模板，真实文件加进 `.gitignore`；
   - 或者统一用「私钥 + 每台机器自己的公钥」模式，配置里只写路径不写密码；
3. 面板**只监听 127.0.0.1**，不要为了"方便访问"改成 `0.0.0.0` 或做内网穿透；
4. 团队共享可用 git 管理 `ssh-mcp-dashboard` 源码（`node_modules` 不入库），但 `ssh-config.json` 单独维护。

### 11.6 最小化方案（只要对话，不要面板）

如果对方只想在 WorkBuddy 里用自然语言操作服务器：只需拷 `ssh-mcp-server` 目录 + 建 `mcp.json` + 点信任，**不需要** dashboard 目录，也不需要 Node 面板进程。面板只是可视化增强，不是必需项。

---

## 十二、回归验证与本次检查记录

在面板目录运行（需要同级 MCP 项目已构建）：

```bat
node --test test\dashboard.test.js
```

在 MCP 项目目录运行：

```bat
npm test
```

本次修复的主要问题：

- 文件编辑器混入 MCP 信息头，以及不完整预览可覆盖原文件的问题；
- 文件读写、切换服务器与关闭编辑器之间的异步状态串台；
- 配置对象格式不兼容、解析失败被当成空清单、端口输入被部分解析，以及白名单展示字段不正确；
- 从其他工作目录启动时临时文件不在允许路径内，以及 MCP stdout 分块导致中文乱码；
- MCP 拒绝握手却被当成握手成功；
- 本地模型无 Key 无法使用、历史裁剪丢失 system 指令、空模型结果被当成成功；
- 下载流中断仍被记录为成功、目录被误当成附件导致失败且残留临时文件，以及家目录含空格时被截断；
- Windows 测试入口路径错误、POSIX 专用测试误在 Windows 执行、HTTP 警告测试依赖日志分块时机；
- 启动脚本绑定特定用户的 Node 路径，以及上传上限、临时目录、PTY 和配置白名单字段的文档偏差。

首轮检查验证结果（Windows / Node.js 24.17.0）：面板 **19 项通过**；MCP 构建通过，`npm test` **241 项通过、0 失败、2 项跳过**，此外 2 个 POSIX 专用套件按平台跳过。测试不读取真实 SSH 凭据，也不在真实远程服务器执行命令或写文件。后续整合增强的验证见下节。

边界：尚未执行 Linux/macOS 的 POSIX 套件、真实远程 SFTP 传输和真实外部 AI 接口请求。自动化编辑器测试覆盖脚本语法与关键交互逻辑，不等同于完整浏览器视觉验收。

## 十三、操作监控、风险评估与可靠性

### 13.1 如何启用与确认

1. 在同级 MCP 项目运行 `npm run build`，重启面板和 WorkBuddy 的连接器一次。
2. 确认 WorkBuddy 使用本地构建入口和与面板相同的配置路径。
3. 在 WorkBuddy 中调用 `list-servers`；先不要执行修改类远程命令。
4. 进入「📊 操作监控」：查看来源、实例 PID、心跳及配置版本；按来源、风险、服务器筛选。
5. 修改一个测试账号后，再调用一次 `list-servers`。账号清单变化且实例配置版本与页面当前版本相同，才是同步已生效的证据。

页面每 5 秒刷新（后台标签页暂停），最多显示当前筛选下最近 100 项操作，不是全量统计。`GET /api/monitor` 支持 `limit`（1–200）、`source`、`risk`、`connectionName`。日志读取最多 20 个近期文件，每文件最多读取尾部 256 KiB；实例最多展示 100 个。数据截断或日志损坏会显式提示，不能据此宣称“没有其他操作”。

### 13.2 记录范围与隐私

- 记录进入新版工具处理器的开始与结束、来源、工具名、服务器名称、风险原因、耗时、失败状态，以及可识别的命令退出码。后台任务“启动成功”不等于任务已经执行完成，仍需 `job-status`。
- 默认只保留命令名摘要，**不保留命令参数、文件正文、原始输出、密码或 Key**，因此监控不是完整命令回放。风险分析使用原始请求，但不把原始请求持久化。已有 stderr 诊断输出不属于这份脱敏日志，不要随意对外分享。
- 客户端名称来自 MCP `clientInfo` 自报。名称含 WorkBuddy 才归为 WorkBuddy，其他名称显示为其他 MCP 客户端；无法证明真实客户端身份。无会话 HTTP 请求可能无法保留初始化名称。
- 无法看到手动 SSH、其他 SSH 工具、旧构建、其他配置文件、服务上线前的历史操作，也不是远端进程实时追踪器。无心跳超过 20 秒显示为非活跃；未完成的操作此时显示结果未知，不能推断远端任务停止。
- 每个实例最多 5 个 1 MiB 日志分段，单条事件最多 16 KiB；新实例启动时清理超过 7 天未更新的自有日志/状态文件，不删除其他文件。这不是严格按事件时间删除的合规保留策略。
- 日志只在本机文件系统保存，未加密、未签名、不能防止本机用户篡改。Unix 创建权限尽量使用目录 0700 / 文件 0600，Windows 依赖目录 ACL。配置目录必须可写；审计无法写入时拒绝执行新操作，而不是静默丢日志。若远程操作后最终审计失败，会提示结果不确定，重试前先核实远端状态。

### 13.3 风险评级

| 等级 | 典型特征 |
| --- | --- |
| 严重 | 根目录/家目录递归删除、磁盘格式化、向设备写入等已知破坏性模式 |
| 高 | 提权、删除、权限修改、服务启停、输出重定向、下载脚本后执行、敏感路径写入、终止任务 |
| 中 | 未知命令、脚本、后台任务启动、普通文件写入、文件下载 |
| 低 | 常见只读命令模式，以及列表、文本读取、任务状态等只读工具 |

**这是启发式提示，不是 shell 语义解析或安全证明**：别名、编码、脚本内容和间接调用可能造成漏报，文本匹配也可能误报；低风险不表示数据不敏感。风险评级不自动拦截高风险操作。真正的执行边界仍是 SSH 用户权限、命令白名单与 SFTP 路径限制。

### 13.4 稳定性评价与本次优化

定位：**适合本机、单用户、受信任环境的开发/运维辅助工具，不应当视为生产级运维审计平台。**

已有优势包括零依赖面板、类型检查、SSH/SFTP 超时、路径约束、退出码处理、独立协议客户端和可运行的回归测试。本次增加了安全配置切换、旧操作完成等待、等待期间取消保护、损坏配置拒绝执行、持久化审计、日志容量限制和严格无用声明检查。没有增加外部服务或新依赖。

仍欠缺真实服务器的长期压力/断网恢复验证、多用户 RBAC、审批链、不可篡改审计和正式高可用部署；单文件前端与较大的连接管理器仍有维护成本。后续优先级应是补真实 SSH/SFTP 与 Linux/macOS CI，而不是继续堆叠与 SSH 无关的产品功能。

整合回归覆盖：两个真实独立 MCP 进程（一个由 Dashboard 启动、一个模拟 WorkBuddy）共享配置；账号重命名与删除最后一个账号无需重启进程；同一监控 API 能读取双方事件；非零命令退出码、风险等级、日志脱敏、日志轮转和配置损坏/并发/取消路径有自动化断言。该验证不等于已经操控你的 WorkBuddy 桌面客户端或真实远端服务器。

本轮自动化结果：MCP 构建与严格无用声明检查通过，**256 项通过、0 失败、2 项跳过**（另有 2 个 POSIX 专用套件在 Windows 跳过）；面板 **19 项通过**。本机浏览器冒烟验证了监控页可见、实例/事件渲染、风险筛选、自动刷新及无控制台错误；测试使用空账号隔离配置，验收实例已停止，不改变用户正在运行的服务。

### 13.5 主题审查与清理

主线保留：SSH 命令、SFTP、账号认证/代理/堡垒机、后台任务、服务器状态、配置同步、操作监控与风险提示。现有 AI 模块仍被终端运维建议入口调用，暂保留为可选辅助功能，不参与 SSH 授权或自动执行。

已删除确认无用或不属于功能主线的部分：无调用的 `navReset`、被安全热更新取代的强制重启队列、微信群推广段落/二维码图片，以及重复的 Star 趋势宣传图。SSH 回调协议要求的参数位置保留，对未用参数显式加 `_`；不把必要协议参数、依赖、构建产物、认证方式或公共导出当成“垃圾”盲删。原项目来源和许可证归属仍然保留。
