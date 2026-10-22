# 测试文档

本项目使用 Node.js 内置的测试框架进行单元测试和集成测试。

## 测试结构

```
test/
├── ssh-config-parser.test.js      # SSH 配置解析器测试
├── command-line-parser.test.js    # 命令行参数解析器测试
├── ssh-connection-manager.test.js # SSH 连接管理器测试
├── integration.test.js            # 集成测试
├── file-io-tool.test.js           # SFTP 读写工具参数与错误
├── execute-command-tool.test.js   # 退出码与错误输出
├── remote-jobs.test.js            # 后台任务脚本与 POSIX 执行
├── http-transport.test.js         # HTTP 传输、鉴权和启动提示
├── lifecycle.test.js              # 子进程关闭与资源释放
├── operation-audit.test.js        # 风险分类、脱敏日志、轮转与保留边界
├── tool-runtime.test.js           # 热更新、并发、取消、失败保护、全工具接入
└── ...                           # 路径、状态采集、延迟依赖等测试
```

## 运行测试

### 运行所有测试

```bash
npm test
```

该命令会先构建 TypeScript，再使用当前 Node 可执行文件运行测试；无需手动构建。Windows 的工作目录使用 `fileURLToPath` 转换，不再把 `/D:/...` URL 路径误当成文件系统路径。

### 监听模式（开发时使用）

```bash
npm run test:watch
```

监听模式会在文件变化时自动重新运行测试。

### 运行单个测试文件

```bash
npm run build
node --test test/ssh-config-parser.test.js
```

### 平台要求

- 推荐 Node.js 22 或更新版本。
- `remote-jobs.test.js` 的脚本语法和真实执行套件需要 POSIX `/bin/sh`，Windows 原生环境明确跳过，其他任务 ID 与脚本结构测试仍运行。
- POSIX 信号关闭测试在 Windows 跳过；stdin 关闭测试仍运行。
- 请在 Linux/macOS 补跑 POSIX 套件；Windows 通过不代表这些平台专属路径已经验证。
- HTTP 启动警告测试等待所断言的完整警告出现，不依赖 stderr 分块或事件调度时机。

### 同级面板测试

在 `../ssh-mcp-dashboard` 中运行 `node --test test/dashboard.test.js`。面板测试使用隔离配置与模拟协议响应，不读取真实 SSH 凭据；真实进程验证启动两个独立 MCP（Dashboard 和模拟 WorkBuddy 客户端），断言账号热更新、删除最后一个账号、双方监控汇总、风险筛选及脱敏。通过故意拒绝的本机 SSH 端口验证传输路径及失败事件，不进行远程文件写入。运行前需构建本项目。

运行时测试还验证配置变化等待旧操作、不改变正常并发、等待期间取消不执行、损坏配置不静默沿用、审计初始写入失败不执行、非零退出码不改变既有 MCP 输出语义。审计测试实际写满分段验证单实例最多五个 1 MiB 日志文件、单事件 16 KiB 和查询截断提示。

## 测试覆盖范围

### 1. SSH Config Parser 测试

测试 `src/utils/ssh-config-parser.ts` 的功能：

- ✅ 基本 Host 别名解析
- ✅ 多别名 Host 行（`Host a b c`）
- ✅ 通配符匹配（`Host *.example.com`）
- ✅ `Host *` 默认值 fallback
- ✅ `Include` 指令支持
- ✅ 路径展开（`~` 和相对路径）
- ✅ First-match-wins 语义
- ✅ 错误处理（文件不存在等）

### 2. Command Line Parser 测试

测试 `src/cli/command-line-parser.ts` 的功能：

- ✅ JSON 配置文件解析（对象和数组格式）
- ✅ `--ssh` 参数解析（JSON 和旧格式）
- ✅ 单连接模式（命令行参数和位置参数）
- ✅ SSH config 集成
- ✅ 参数优先级（命令行 > SSH config）
- ✅ 命令白名单和黑名单
- ✅ 其他选项（`--pty`, `--pre-connect`, `--proxy`, `--socksProxy`）
- ✅ 错误处理

### 3. SSH Connection Manager 测试

测试 `src/services/ssh-connection-manager.ts` 的功能：

- ✅ 配置管理（初始化、获取配置）
- ✅ 命令验证（白名单、黑名单、正则表达式）
- ✅ 连接状态管理
- ✅ 多服务器支持

### 4. 集成测试

端到端测试完整流程：

- ✅ 从命令行参数到连接管理器的完整流程
- ✅ 从 SSH config 到连接管理器的完整流程
- ✅ 多服务器配置场景
- ✅ 错误处理（无效配置、缺少字段等）

## 编写新测试

### 测试文件命名

测试文件应该以 `.test.js` 结尾，并放在 `test/` 目录下。

### 测试示例

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('功能模块名称', () => {
  before(() => {
    // 测试前的准备工作
  });

  after(() => {
    // 测试后的清理工作
  });

  describe('子功能', () => {
    it('应该做某事', () => {
      // 测试代码
      assert.strictEqual(1 + 1, 2);
    });

    it('应该处理错误情况', () => {
      assert.throws(() => {
        throw new Error('测试错误');
      }, /测试错误/);
    });
  });
});
```

## 测试最佳实践

1. **独立性**：每个测试应该独立运行，不依赖其他测试的状态
2. **清理**：使用 `after` 钩子清理测试创建的临时文件和资源
3. **描述性**：测试名称应该清楚地描述测试的内容
4. **覆盖边界情况**：测试正常情况、边界情况和错误情况
5. **使用 fixtures**：将测试数据放在 `test/fixtures/` 目录下

## CI/CD 集成

测试可以轻松集成到 CI/CD 流程中：

```yaml
# GitHub Actions 示例
- name: Run tests
  run: npm test
```

## 调试测试

### 使用 Node.js 调试器

```bash
node --inspect-brk --test test/ssh-config-parser.test.js
```

然后在 Chrome 中打开 `chrome://inspect` 进行调试。

### 查看详细输出

```bash
node --test --test-reporter=tap test/*.test.js
```

## 常见问题

### Q: 测试失败但没有详细错误信息？

A: 使用 `--test-reporter=spec` 查看详细输出：

```bash
node --test --test-reporter=spec test/*.test.js
```

### Q: 如何跳过某个测试？

A: 使用 `it.skip()`:

```javascript
it.skip('暂时跳过的测试', () => {
  // 测试代码
});
```

### Q: 如何只运行某个测试？

A: 使用 `it.only()`:

```javascript
it.only('只运行这个测试', () => {
  // 测试代码
});
```

## 贡献指南

提交 PR 时，请确保：

1. 所有测试通过：`npm test`
2. 新功能有对应的测试
3. 测试覆盖了正常情况和边界情况
4. 代码编译通过：`npm run build`
