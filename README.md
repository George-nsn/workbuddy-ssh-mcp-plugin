# WorkBuddy SSH MCP Plugin

本仓库将 `ssh-mcp-server` 与 `ssh-mcp-dashboard` 作为一套本地部署的 SSH 运维工具。MCP 提供 SSH 命令、SFTP 和后台任务；Dashboard 提供账号管理、文件浏览及操作监控。

## Windows 快速部署

1. 安装 Node.js 22 或更新的 LTS 版本，并确认 `node`、`npm` 可从 PATH 运行。
2. 保持 `ssh-mcp-server` 与 `ssh-mcp-dashboard` 两个目录并列。
3. 在 `ssh-mcp-dashboard` 中运行 `setup.bat`。脚本检查环境、按 `package-lock.json` 安装依赖并构建 MCP。
4. 运行 `start.bat` 启动本地面板。在 Dashboard 的“账号”页添加 SSH 连接。

已有的 `ssh-config.json` 不会被部署脚本覆盖。首次部署若文件不存在，脚本只创建空配置；私钥和连接凭据请保存在本机。

## 接入 WorkBuddy

在 WorkBuddy 的 MCP 配置中，将命令指向本机 Node.js，将入口与配置文件指向这份仓库。例如：

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

请按本机路径替换 `command` 和两个 `args` 路径。Dashboard 和 WorkBuddy 必须使用同一份 `ssh-config.json`，并且 WorkBuddy 应指向仓库内构建的 MCP 入口。

## 更新与测试

- 更新源码后，在 Dashboard 目录重新运行 `setup.bat`；需要加载新 MCP 构建时，重启 WorkBuddy 的 MCP 连接器。
- MCP：在 `ssh-mcp-server` 中运行 `npm ci`、`npm test`。
- Dashboard：在 `ssh-mcp-dashboard` 中运行 `node --test test/dashboard.test.js`。

## 安全与来源

- 仓库不应包含 `ssh-config.json`、私钥、AI Key、审计日志或 `.env` 文件。根 `.gitignore` 已排除常见敏感文件。
- 面板默认只监听本机回环地址。为服务器设置最小权限账号，并使用命令白名单和远程路径限制。
- MCP 源码保留原项目的 `LICENSE` 与来源说明；部署前请阅读两个子项目的 README。
