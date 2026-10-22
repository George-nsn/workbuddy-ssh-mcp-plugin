const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const os = require("node:os");
const readline = require("node:readline");

const root = path.resolve(__dirname, "..");
const backend = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

function harness(options = {}) {
  let config = options.config ?? "[]";
  const files = new Map();
  const spawned = [];
  const calls = [];
  const fakeFs = {
    ...fs,
    mkdirSync() {},
    readFileSync(file, ...args) {
      if (file.endsWith("ssh-config.json")) return config;
      if (file.endsWith("ai-config.json")) return JSON.stringify(options.ai || {});
      return fs.readFileSync(file, ...args);
    },
    writeFileSync(file, data) { files.set(file, data); },
    renameSync(from, to) {
      config = files.get(from);
      files.delete(from);
    },
    rmSync(file) { files.delete(file); },
    ...options.fs,
  };
  const fakeSpawn = (bin, args, opts) => {
    spawned.push({ bin, args, opts });
    const proc = new EventEmitter();
    proc.exitCode = null;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      proc.exitCode = 0;
      queueMicrotask(() => proc.emit("exit", 0));
    };
    proc.stdin.on("data", (data) => {
      const req = JSON.parse(data.toString());
      if (req.id === undefined) return;
      calls.push(req);
      let reply;
      if (req.method === "initialize") {
        reply = options.initError ? { error: { message: "handshake rejected" } } : { result: {} };
      } else {
        const result = options.tool ? options.tool(req.params) : { content: [{ type: "text", text: "ok" }] };
        reply = { result };
      }
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...reply }) + "\n");
      const split = bytes.indexOf(Buffer.from("中文")) + 1;
      if (split > 0) {
        proc.stdout.write(bytes.subarray(0, split));
        proc.stdout.write(bytes.subarray(split));
      } else {
        proc.stdout.write(bytes);
      }
    });
    return proc;
  };
  const context = vm.createContext({
    require(name) {
      if (name === "fs") return fakeFs;
      if (name === "child_process") return { ...require("node:child_process"), spawn: fakeSpawn };
      if (name === "stream" && options.pipeline) return { ...require("node:stream"), pipeline: options.pipeline };
      return require(name);
    },
    module: { exports: {} },
    __dirname: root,
    process: { execPath: process.execPath, pid: process.pid, env: {}, argv: [] },
    console: { log() {}, error() {} },
    Buffer, URL, setTimeout, clearTimeout, AbortSignal,
    fetch: options.fetch,
  });
  vm.runInContext(backend, context, { filename: "server.js" });
  return { ...context.module.exports, spawned, calls, config: () => config };
}

const textTool = (text) => ({ content: [{ type: "text", text }] });

describe("dashboard backend", () => {
  it("accepts named-object configs without exposing passwords or losing advanced fields", async () => {
    const h = harness({ config: JSON.stringify({
      dev: { host: "example.invalid", port: 22, username: "test", password: "secret", commandWhitelist: ["^echo"], proxy: "socks5://localhost:1080" },
    }) });
    const overview = await h.routes["GET /api/overview"]();
    assert.equal(overview.accounts[0].name, "dev");
    assert.equal(overview.accounts[0].hasPassword, true);
    assert.equal(overview.accounts[0].password, undefined);
    assert.equal(overview.accounts[0].whitelist[0], "^echo");
    await h.routes["PUT /api/accounts"]({
      originalName: "dev", name: "dev", host: "example.invalid", port: 22, username: "test", authType: "password",
    }, null, new URLSearchParams());
    const saved = JSON.parse(h.config())[0];
    assert.equal(saved.password, "secret");
    assert.equal(saved.proxy, "socks5://localhost:1080");
    assert.deepEqual(saved.commandWhitelist, ["^echo"]);
  });

  it("refuses to overwrite malformed or invalid account configs", async () => {
    for (const config of ["{broken", "null", '"text"', '{"dev":null}', "[{}]", '[{"name":"x"},{"name":"x"}]']) {
      const h = harness({ config });
      await assert.rejects(h.routes["POST /api/accounts"]({}), /配置/);
      assert.equal(h.config(), config);
    }
  });

  it("rejects partial and non-integer account ports", async () => {
    const h = harness();
    for (const port of ["22junk", 22.5, 0, 65536]) {
      await assert.rejects(h.routes["POST /api/accounts"]({
        name: "dev", host: "example.invalid", port, username: "test", authType: "password", password: "test",
      }), /端口/);
    }
    assert.equal(h.config(), "[]");
  });

  it("anchors the MCP cwd and preserves UTF-8 split across stdout chunks", async () => {
    const h = harness({ tool: () => textTool("中文") });
    await h.startMcp();
    assert.equal(h.spawned[0].opts.cwd, root);
    const result = await h.routes["POST /api/exec"]({ connectionName: "dev", cmdString: "echo test" });
    assert.equal(result.text, "中文");
  });

  it("reports rejected initialization instead of claiming a working MCP", async () => {
    const h = harness({ initError: true });
    await assert.rejects(h.startMcp(), /handshake rejected/);
    assert.equal((await h.routes["GET /api/health"]()).mcpAlive, false);
  });

  it("separates the MCP header from editable text, including empty and CRLF files", async () => {
    for (const content of ["", "中文\r\n---\n[file] body\n", "a\n"]) {
      const size = Buffer.byteLength(content);
      const h = harness({ tool: () => textTool(`[file] /a\n[bytes] 0-${size} of ${size} (end of file)\n---\n${content}`) });
      await h.startMcp();
      const result = await h.routes["POST /api/files/read"]({ remotePath: "/a" });
      assert.equal(result.content, content);
      assert.equal(result.truncated, false);
      assert.equal(result.total, size);
    }
  });

  it("marks incomplete reads as read-only previews and rejects unknown response formats", async () => {
    const h = harness({ tool: () => textTool("[file] /a\n[bytes] 0-3 of 10 (next offset 3)\n---\nabc") });
    await h.startMcp();
    const result = await h.routes["POST /api/files/read"]({ remotePath: "/a" });
    assert.equal(result.content, "abc");
    assert.equal(result.truncated, true);
    const bad = harness({ tool: () => textTool("unexpected text") });
    await bad.startMcp();
    await assert.rejects(bad.routes["POST /api/files/read"]({ remotePath: "/a" }), /无法解析/);
  });

  it("preserves spaces in detected home directories", async () => {
    const h = harness({ tool: () => textTool("HOME=/home/test user\r\ntest\r\n/home/test user\r\n") });
    await h.startMcp();
    const result = await h.routes["POST /api/files/home"]({ connectionName: "dev" });
    assert.equal(result.home, "/home/test user");
    assert.equal(result.user, "test");
  });

  it("preserves the AI system instruction under history trimming and supports keyless localhost", async () => {
    let sent;
    const h = harness({
      ai: { baseUrl: "http://127.0.0.1:11434/v1", model: "local-model" },
      fetch: async (_url, init) => {
        sent = init;
        return { ok: true, json: async () => ({ choices: [{ message: { content: "answer" } }] }) };
      },
    });
    assert.equal((await h.routes["GET /api/ai/config"]()).configured, true);
    await h.routes["POST /api/ai/chat"]({
      contextK: 2,
      messages: [{ role: "system", content: "replace policy" }, ...Array.from({ length: 10 }, () => ({ role: "user", content: "x".repeat(1000) }))],
    });
    const request = JSON.parse(sent.body);
    assert.equal(request.messages[0].role, "system");
    assert.match(request.messages[0].content, /不能直接执行命令/);
    assert.equal(request.messages.filter((m) => m.role === "system").length, 1);
    assert.equal(sent.headers.Authorization, undefined);
  });

  it("requires keys for remote AI providers and surfaces empty model responses", async () => {
    const remote = harness({ ai: { baseUrl: "https://example.invalid/v1", model: "test" } });
    assert.equal((await remote.routes["GET /api/ai/config"]()).configured, false);
    await assert.rejects(remote.routes["POST /api/ai/chat"]({}), /尚未配置/);
    const empty = harness({
      ai: { baseUrl: "http://localhost:1234/v1", model: "test" },
      fetch: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
    });
    await assert.rejects(empty.routes["POST /api/ai/chat"]({}), /未返回有效文本/);
  });

  it("serves HTML and health over HTTP while retaining request-origin guards", async (t) => {
    const h = harness();
    const server = h.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    const health = await fetch(base + "/api/health");
    assert.equal((await health.json()).mcpAlive, false);
    const blocked = await fetch(base + "/api/health", { headers: { Origin: "https://example.invalid" } });
    assert.equal(blocked.status, 403);
  });

  it("rejects directory attachments and cleans only their generated temporary destination", async (t) => {
    const removed = [];
    const h = harness({
      fs: {
        existsSync: () => true,
        statSync: () => ({ isFile: () => false }),
        rm(file, options, callback) { removed.push({ file, options }); callback(); },
      },
    });
    await h.startMcp();
    const server = h.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transfer/download?remotePath=%2Ffolder`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /仅支持单个文件/);
    assert.equal(removed.length, 1);
    assert.equal(path.dirname(removed[0].file), path.join(root, ".tmp"));
    assert.equal(removed[0].options.recursive, true);
    assert.match(path.basename(removed[0].file), new RegExp(`^${process.pid}-[a-f0-9-]+-folder$`));
  });

  it("records download pipeline errors as failed transfers", async (t) => {
    const h = harness({
      fs: {
        existsSync: () => true,
        statSync: () => ({ isFile: () => true, size: 0 }),
        createReadStream: () => new PassThrough(),
        rm(_file, _options, callback) { callback(); },
      },
      pipeline(_source, response, callback) {
        response.end();
        callback(new Error("transfer aborted"));
      },
    });
    await h.startMcp();
    const server = h.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await fetch(`http://127.0.0.1:${server.address().port}/api/transfer/download?remotePath=%2Ffile.txt`);
    const { transfers } = await h.routes["GET /api/transfers"]();
    assert.equal(transfers[0].ok, false);
    assert.equal(transfers[0].message, "transfer aborted");
  });
});

function editorHarness(api) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", style: {}, textContent: "", disabled: false });
    return elements.get(id);
  };
  const context = vm.createContext({
    $, api, Blob,
    state: { current: "dev", file: null, dir: "/" },
    needServer: () => true,
    toast() {}, loadDir() {}, fmtSize: String,
  });
  const start = html.indexOf("let fileSeq = 0;");
  const end = html.indexOf("\nfunction findInFile(", start);
  vm.runInContext(html.slice(start, end), context);
  return { context, $ };
}

describe("dashboard file editor", () => {
  it("all embedded scripts are syntactically valid", () => {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      new vm.Script(match[1]);
    }
  });

  it("edits and saves only file content, never MCP metadata", async () => {
    const calls = [];
    const { context, $ } = editorHarness(async (route, body) => {
      calls.push({ route, body });
      return { content: "actual text", text: "[file] header", truncated: false };
    });
    await context.openFile("/a");
    assert.equal($("editor").value, "actual text");
    assert.equal($("btn-save").disabled, false);
    await context.saveFile();
    assert.equal(calls[1].body.content, "actual text");
  });

  it("blocks save and save-as for incomplete files, including direct function calls", async () => {
    const calls = [];
    const { context, $ } = editorHarness(async (route) => {
      calls.push(route);
      return { content: "partial", truncated: true, end: 7, total: 100 };
    });
    await context.openFile("/a");
    assert.equal($("editor").readOnly, true);
    assert.equal($("btn-save").disabled, true);
    assert.equal($("btn-save-as").disabled, true);
    await context.saveFile();
    await context.saveFile("/copy");
    assert.deepEqual(calls, ["/api/files/read"]);
  });

  it("ignores stale read failures after changing servers", async () => {
    let reject;
    const { context, $ } = editorHarness(() => new Promise((_resolve, fail) => { reject = fail; }));
    const reading = context.openFile("/a");
    context.state.current = "prod";
    context.state.file = { path: "/prod-file" };
    $("editor").value = "prod content";
    reject(new Error("old failure"));
    await reading;
    assert.equal(context.state.file.path, "/prod-file");
    assert.equal($("editor").value, "prod content");
  });

  it("does not rename a newly opened editor when an older save completes", async () => {
    let finish;
    const { context, $ } = editorHarness(() => new Promise((resolve) => { finish = resolve; }));
    context.state.file = { path: "/old" };
    $("editor").value = "old content";
    const saving = context.saveFile("/copy");
    context.state.file = { path: "/new" };
    finish({ ok: true });
    await saving;
    assert.equal(context.state.file.path, "/new");
  });
});

describe("dashboard presentation", () => {
  function themeHarness(saved, storageError = false) {
    const attributes = {};
    const button = { textContent: "", title: "", setAttribute(name, value) { attributes[name] = value; } };
    const notices = [];
    const stored = new Map(saved === undefined ? [] : [["wb_theme", saved]]);
    const context = vm.createContext({
      document: { documentElement: { dataset: {} } },
      localStorage: {
        getItem(key) { if (storageError) throw new Error("storage blocked"); return stored.get(key) ?? null; },
        setItem(key, value) { if (storageError) throw new Error("storage blocked"); stored.set(key, value); },
      },
      $: () => button,
      console: { warn: (...args) => notices.push(args[0]) },
      toast: (message) => notices.push(message),
    });
    const initial = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    vm.runInContext(initial, context);
    const start = html.indexOf("function applyTheme(");
    const end = html.indexOf("/* ---------------- 事件 ---------------- */", start);
    vm.runInContext(html.slice(start, end), context);
    context.applyTheme(context.document.documentElement.dataset.theme);
    return { context, button, attributes, stored, notices };
  }

  it("starts with the saved theme before rendering and defaults unknown preferences to light", () => {
    for (const saved of [undefined, "invalid", "light", "dark"]) {
      const { context, button, attributes } = themeHarness(saved);
      const dark = saved === "dark";
      assert.equal(context.document.documentElement.dataset.theme, dark ? "dark" : "light");
      assert.equal(attributes["aria-pressed"], String(dark));
      assert.match(button.textContent, dark ? /浅色模式/ : /黑色模式/);
    }
  });

  it("toggles both ways, saves the preference and restores it on reload", () => {
    const { context, stored, attributes } = themeHarness();
    context.toggleTheme();
    assert.equal(stored.get("wb_theme"), "dark");
    assert.equal(attributes["aria-pressed"], "true");
    assert.equal(themeHarness(stored.get("wb_theme")).context.document.documentElement.dataset.theme, "dark");
    context.toggleTheme();
    assert.equal(stored.get("wb_theme"), "light");
    assert.equal(attributes["aria-pressed"], "false");
  });

  it("still switches themes when preference storage is blocked and explicitly notifies the user", () => {
    const { context, notices } = themeHarness(undefined, true);
    assert.equal(context.document.documentElement.dataset.theme, "light");
    context.toggleTheme();
    assert.equal(context.document.documentElement.dataset.theme, "dark");
    assert.ok(notices.some((message) => message.includes("无法保存偏好")));
  });

  function monitorHarness(api) {
    const elements = new Map();
    const $ = (id) => {
      if (!elements.has(id)) elements.set(id, { value: "", textContent: "", innerHTML: "", disabled: false });
      return elements.get(id);
    };
    const context = vm.createContext({
      $, api, URLSearchParams,
      esc: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
    });
    const start = html.indexOf("let monitorLoading = false;");
    const end = html.indexOf('/* ---------------- 事件 ---------------- */', start);
    vm.runInContext(html.slice(start, end), context);
    return { context, $ };
  }

  it("renders risk/result badges with text labels and escapes event data", async () => {
    const { context, $ } = monitorHarness(async () => ({
      configPath: "test-config.json", configVersion: "test-version", warnings: [], truncated: false,
      instances: [{ instanceId: "live", client: "WorkBuddy", active: true, pid: 123, configVersion: "test-version" }],
      events: [
        { time: "2026-10-21", instanceId: "live", source: "workbuddy", client: "WorkBuddy", connectionName: "dev", tool: "execute-command",
          risk: "high", reason: "PRIVILEGED_OR_MUTATING", summary: '<img src=x onerror="bad()">', status: "failed", durationMs: 12 },
        { time: "2026-10-21", instanceId: "stopped", source: "dashboard", client: "ssh-dashboard", connectionName: "dev", tool: "execute-command",
          risk: 'evil" onclick="bad()', reason: "unknown", summary: "unknown", status: "running" },
      ],
    }));
    await context.loadMonitor();
    assert.match($("monitor-events").innerHTML, /risk-high">高风险/);
    assert.match($("monitor-events").innerHTML, /result-failed">失败/);
    assert.match($("monitor-events").innerHTML, /结果未知/);
    assert.match($("monitor-events").innerHTML, /&lt;img/);
    assert.doesNotMatch($("monitor-events").innerHTML, /<img|onclick=/);
    assert.match($("monitor-instances").innerHTML, /result-success">在线/);
    assert.equal($("monitor-refresh").disabled, false);
  });

  it("restores the refresh button and marks existing monitor data as stale after errors", async () => {
    const { context, $ } = monitorHarness(async () => { throw new Error("offline"); });
    $("monitor-events").innerHTML = "previous data";
    await context.loadMonitor();
    assert.equal($("monitor-events").innerHTML, "previous data");
    assert.match($("monitor-health").textContent, /offline.*过期/);
    assert.equal($("monitor-refresh").disabled, false);
  });

  it("keeps six uniquely labelled keyboard-accessible tabs and matching panels", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const name of ["term", "keys", "files", "xfer", "acct", "monitor"]) {
      assert.match(html, new RegExp(`<button[^>]*id="tab-${name}"[^>]*role="tab"[^>]*aria-controls="pane-${name}"`));
      assert.ok(ids.includes("pane-" + name));
    }
    assert.match(html, /prefers-reduced-motion:reduce/);
    assert.match(html, /:focus-visible/);
  });

  it("uses layered light/dark workspaces without decorative page backgrounds or eyebrow labels", () => {
    assert.doesNotMatch(html, /background:\s*radial-gradient|class="eyebrow"|WORKSPACE \//);
    assert.match(html, /--bg:#f3f5f9/);
    assert.match(html, /--acc:#345ce6/);
    assert.match(html, /--bg:#080c11/);
    assert.match(html, /--acc:#72b6ee/);
    assert.match(html, /background:var\(--panel\);border:1px solid var\(--line\);border-radius:12px/);
    assert.match(html, /本机服务 · 127\.0\.0\.1/);
    assert.doesNotMatch(html, /class="dots"|workspace-section/);
  });
});

describe("Windows deployment", () => {
  const setup = fs.readFileSync(path.join(root, "setup.bat"), "utf8");
  const start = fs.readFileSync(path.join(root, "start.bat"), "utf8");
  const serverIgnore = fs.readFileSync(path.join(root, "..", "ssh-mcp-server", ".gitignore"), "utf8");

  it("validates Node/npm and the lockfile before a deterministic install and build", () => {
    assert.match(setup, /%SCRIPT_DIR%server\.js/);
    assert.match(setup, /%SCRIPT_DIR%public\\index\.html/);
    assert.match(setup, /where node/);
    assert.match(setup, /where npm/);
    assert.match(setup, /NODE_MAJOR% LSS 22/);
    assert.match(setup, /if not exist package-lock\.json/);
    assert.match(setup, /createHash\('sha256'\)/);
    assert.match(setup, /\.ssh-mcp-lock\.sha256/);
    assert.match(setup, /createHash\('sha256'\)/);
    assert.match(setup, /\.ssh-mcp-lock\.sha256/);
    assert.match(setup, /call npm ci/);
    assert.match(setup, /call npm run build/);
    assert.match(setup, /if not exist ssh-config\.json/);
    assert.match(setup, /> ssh-config\.json echo \[\]/);
    assert.match(setup, /node_modules\\ssh2\\package\.json/);
    assert.doesNotMatch(serverIgnore, /^package-lock\.json\s*$/m);
  });

  it("makes the launcher run setup first and avoids hard-coded user-specific Node paths", () => {
    assert.match(start, /call "%~dp0setup\.bat" --no-pause/);
    assert.doesNotMatch(start, /[A-Z]:\\Users\\[^\\]+\\.*node\.exe/i);
    assert.match(start, /node "%~dp0server\.js"/);
  });
});

it("shares config and audit between the real dashboard and an independent WorkBuddy MCP client", { timeout: 15000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-dashboard-test-"));
  const configFile = path.join(tmp, "config.json");
  fs.writeFileSync(configFile, JSON.stringify([{
    name: "isolated", host: "127.0.0.1", port: 1, username: "test", password: "test",
    connectionTimeoutMs: 1000,
  }]));
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: tmp,
    env: { ...process.env, DASHBOARD_PORT: "0", SSH_CONFIG_FILE: configFile },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let workbuddy;
  let workbuddyExited;
  t.after(async () => {
    if (workbuddy) {
      workbuddy.stdin.end();
      await workbuddyExited;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const base = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Dashboard startup timed out: " + stderr)), 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Dashboard exited: " + stderr)); });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = /面板已启动: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const health = await fetch(base + "/api/health");
  assert.equal((await health.json()).mcpAlive, true);
  const overview = await fetch(base + "/api/overview");
  const data = await overview.json();
  assert.equal(data.accounts[0].name, "isolated");
  assert.equal(data.accounts[0].password, undefined);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const upload = await fetch(base + "/api/transfer/upload?connectionName=isolated&remotePath=%2Ftest.txt&filename=test.txt", {
    method: "POST", body: "test",
  });
  const result = await upload.json();
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.error).code, "SSH_CONNECTION_FAILED", "local path must pass validation before the deliberately refused SSH connection");
  const leftovers = () => fs.readdirSync(path.join(root, ".tmp"))
    .filter((name) => name.startsWith(child.pid + "-") && name.endsWith("-test.txt"));
  for (let i = 0; i < 50 && leftovers().length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(leftovers(), [], "upload temporary files must be removed before stopping the dashboard");

  workbuddy = spawn(process.execPath, [path.join(root, "..", "ssh-mcp-server", "build", "index.js"), "--config-file", configFile], {
    cwd: tmp, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  workbuddyExited = new Promise((resolve) => workbuddy.once("exit", resolve));
  workbuddy.stderr.resume();
  const pending = new Map();
  let nextId = 0;
  const lines = readline.createInterface({ input: workbuddy.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  workbuddy.on("error", (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("WorkBuddy test RPC timed out: " + method));
      workbuddy.kill();
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    workbuddy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "WorkBuddy", version: "integration-test" } });
  workbuddy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const before = await rpc("tools/call", { name: "list-servers", arguments: {} });
  assert.match(before.content[0].text, /isolated/);
  const failed = await rpc("tools/call", { name: "execute-command", arguments: { connectionName: "isolated", cmdString: "sudo echo SECRET_ARGUMENT_123", timeout: 1000 } });
  assert.equal(failed.isError, true);
  const update = await fetch(base + "/api/accounts", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName: "isolated", name: "renamed", host: "127.0.0.1", port: 1, username: "test", authType: "password" }),
  });
  assert.equal((await update.json()).ok, true);
  const after = await rpc("tools/call", { name: "list-servers", arguments: {} });
  assert.match(after.content[0].text, /renamed/);
  assert.doesNotMatch(after.content[0].text, /isolated/);
  const dashboardServers = await (await fetch(base + "/api/servers")).json();
  assert.equal(dashboardServers.servers[0].name, "renamed");
  const monitor = await (await fetch(base + "/api/monitor")).json();
  assert.equal(monitor.ok, true);
  assert.ok(monitor.events.some((e) => e.source === "dashboard" && e.tool === "upload"));
  assert.ok(monitor.events.some((e) => e.source === "workbuddy" && e.risk === "high" && e.status === "failed"));
  assert.equal(monitor.instances.length, 2);
  assert.ok(monitor.instances.every((i) => i.active && i.configVersion === monitor.configVersion));
  assert.doesNotMatch(JSON.stringify(monitor), /SECRET_ARGUMENT_123/);
  const filtered = await (await fetch(base + "/api/monitor?source=workbuddy&risk=high")).json();
  assert.equal(filtered.events.length, 1);
  assert.equal((await (await fetch(base + "/api/monitor?limit=abc")).json()).ok, false);
  assert.equal((await (await fetch(base + "/api/monitor?source=unknown")).json()).ok, false);
  assert.equal((await (await fetch(base + "/api/monitor?risk=unknown")).json()).ok, false);
  assert.equal((await (await fetch(base + "/api/accounts?name=renamed", { method: "DELETE" })).json()).ok, true);
  const empty = await rpc("tools/call", { name: "list-servers", arguments: {} });
  assert.equal(empty.content[0].text, "No SSH servers configured.");
});
