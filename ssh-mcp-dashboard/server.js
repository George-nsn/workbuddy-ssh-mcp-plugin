/**
 * SSH 可视化管理面板 —— 后端服务（零依赖，仅用 Node 内置模块）
 *
 * 架构：
 *   浏览器(index.html) ──HTTP/REST──▶ server.js ──stdio JSON-RPC──▶ ssh-mcp-server 子进程 ──SSH──▶ 远程服务器
 *
 * 特性：
 *   - 账号管理：共用 ssh-config.json，MCP 在工具调用边界安全加载
 *   - 连接探测：用 `echo __WB_PONG__` 实测建连，记录状态与延迟
 *   - 文件传输：支持浏览器拖拽上传（原始字节流）与直接下载
 *   - 文件查找：按文件名（find）或文件内容（grep）在服务器端搜索
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { pipeline } = require("stream");
const { StringDecoder } = require("string_decoder");
const { pathToFileURL } = require("url");

const PORT_PREFERRED = parseInt(process.env.DASHBOARD_PORT || "8080", 10);
const NODE_BIN = process.execPath;
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const MCP_DIR = path.join(PLUGIN_ROOT, "ssh-mcp-server");
const MCP_ENTRY = path.join(MCP_DIR, "build", "index.js");
const SSH_CONFIG = path.resolve(process.env.SSH_CONFIG_FILE || path.join(MCP_DIR, "ssh-config.json"));
const INDEX_HTML = path.join(__dirname, "public", "index.html");
const TMP_DIR = path.join(__dirname, ".tmp"); // 必须位于 MCP 的允许本地根目录（cwd）内，否则上传/下载会被拒
fs.mkdirSync(TMP_DIR, { recursive: true });

// ==================== 状态 ====================
let mcpProc = null;
let rpcId = 0;
let stdoutBuf = "";
const stdoutDecoder = new StringDecoder("utf8");
let mcpAlive = false;
const pending = new Map();
const connState = new Map(); // name -> {status, latencyMs, lastError, lastCheck}
const transfers = [];        // 最近传输记录
const MAX_TRANSFERS = 60;

const log = (...a) => console.log("[dashboard]", ...a);
const nowStr = () => new Date().toLocaleString("zh-CN", { hour12: false });

// ==================== MCP stdio 客户端 ====================
function failAllPending(msg) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(msg)); }
  pending.clear();
}

function send(obj) {
  if (!mcpAlive || !mcpProc || mcpProc.exitCode !== null || !mcpProc.stdin.writable) return false;
  try { mcpProc.stdin.write(JSON.stringify(obj) + "\n"); return true; }
  catch { return false; }
}

function rpc(method, params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!mcpAlive) return reject(new Error("MCP 子进程未运行"));
    const id = ++rpcId;
    const timer = setTimeout(() => {
      pending.delete(id);
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Dashboard RPC timeout" } });
      reject(new Error("MCP 调用超时: " + method));
    }, timeoutMs);
    pending.set(id, { timer, resolve, reject });
    if (!send({ jsonrpc: "2.0", id, method, params })) {
      clearTimeout(timer); pending.delete(id);
      reject(new Error("MCP 写入失败（子进程可能已退出）"));
    }
  });
}

function onStdout(chunk) {
  stdoutBuf += stdoutDecoder.write(chunk);
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  }
}

async function startMcp() {
  const proc = spawn(NODE_BIN, [MCP_ENTRY, "--config-file", SSH_CONFIG], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  mcpProc = proc;
  mcpAlive = true;

  proc.on("error", (e) => {
    mcpAlive = false;
    log("MCP 子进程启动失败:", e.message);
    failAllPending("MCP 子进程启动失败: " + e.message);
  });
  proc.stdin.on("error", (error) => {
    mcpAlive = false;
    log("MCP 写入通道失败:", error.message);
    failAllPending("MCP 写入通道失败: " + error.message);
  });
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", (d) => process.stderr.write("[mcp] " + d.toString("utf8")));
  proc.on("exit", (code) => {
    mcpAlive = false;
    log("MCP 子进程退出, code =", code);
    failAllPending("MCP 子进程已退出");
  });

  try {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ssh-dashboard", version: "2.1.0" },
    }, 20000);
    if (initialized.error || !initialized.result) throw new Error(initialized.error?.message || "MCP 握手响应无效");
    if (!send({ jsonrpc: "2.0", method: "notifications/initialized" })) throw new Error("MCP 初始化通知写入失败");
  } catch (error) {
    mcpAlive = false;
    failAllPending("MCP 初始化失败: " + error.message);
    proc.kill();
    throw error;
  }
  log("MCP 握手完成");
}

function accountsChanged() {
  accountsGeneration++;
  connState.clear();
  homeCache.clear();
}

async function callTool(name, args, timeoutMs) {
  const res = await rpc("tools/call", { name, arguments: args || {} }, timeoutMs || 120000);
  if (res.error) return { ok: false, error: res.error.message || "调用失败", text: res.error.message };
  const result = res.result || {};
  const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { ok: !result.isError, isError: !!result.isError, text };
}

function parseToolError(text) {
  try {
    const j = JSON.parse(String(text));
    if (j && j.code) return j;
  } catch { /* not json */ }
  return null;
}

/** 把底层错误翻译成可操作的中文提示 */
function humanizeError(raw) {
  const s = String(raw || "");
  if (/EPERM.*(id_|private|key)|EACCES.*(id_|private|key)/i.test(s)) {
    return s + "\n（提示：进程无法读取私钥文件 —— 若面板是在受限制的沙箱/容器中启动，请改用 start.bat 直接启动；或检查该文件是否被安全软件锁定）";
  }
  if (/All configured authentication methods failed/i.test(s)) {
    return s + "\n（提示：服务器拒绝了当前凭据 —— 请把 ~/.ssh/id_ed25519.pub 加入服务器 ~/.ssh/authorized_keys，或在「账号」页改用密码认证）";
  }
  if (/ECONNREFUSED|connect ETIMEDOUT|Connection timed out/i.test(s)) {
    return s + "\n（提示：网络不可达或被防火墙拦截 —— 先在本机用 ssh 命令验证主机与端口）";
  }
  return s;
}

// ==================== 账号管理 ====================
function loadAccounts() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SSH_CONFIG, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error("无法读取服务器配置，请先修复配置文件：" + e.message);
  }
  const list = Array.isArray(raw) ? raw :
    raw && typeof raw === "object" ? Object.entries(raw).map(([name, a]) => {
      if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("服务器配置项无效：" + name);
      return { ...a, name };
    }) : null;
  if (!list || list.some((a) => !a || typeof a !== "object" || typeof a.name !== "string" || !a.name)) {
    throw new Error("服务器配置必须是带 name 的账号数组或以名称为键的对象");
  }
  if (new Set(list.map((a) => a.name)).size !== list.length) throw new Error("服务器配置存在重复名称");
  return list;
}
function saveAccounts(list) {
  const tmp = SSH_CONFIG + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, SSH_CONFIG);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function publicAccount(a) {
  return {
    name: a.name, host: a.host, port: a.port, username: a.username,
    authType: a.privateKey ? "key" : (a.password ? "password" : "none"),
    privateKey: a.privateKey || "",
    hasPassword: !!a.password,
    whitelist: Array.isArray(a.commandWhitelist) ? a.commandWhitelist : null,
  };
}
function validateAccount(body, list, originalName) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("名称不能为空");
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(name)) throw new Error("名称仅支持字母、数字、点、下划线、短横线（1-48 字符）");
  if (list.some((a) => a.name === name && a.name !== originalName)) throw new Error(`名称「${name}」已存在`);
  const host = String(body.host || "").trim();
  if (!host) throw new Error("主机地址不能为空");
  const port = Number(body.port);
  if (!Number.isInteger(port) || !(port > 0 && port < 65536)) throw new Error("端口必须是 1-65535 的整数");
  const username = String(body.username || "").trim();
  if (!username) throw new Error("用户名不能为空");
  const authType = body.authType === "password" ? "password" : "key";
  const old = list.find((a) => a.name === originalName) || {};
  const acc = { ...old, name, host, port, username };
  if (authType === "password") {
    const pwd = body.password;
    if (typeof pwd === "string" && pwd.length > 0) acc.password = pwd;
    if (!acc.password) throw new Error("密码认证需填写密码");
    delete acc.privateKey;
  } else {
    const key = String(body.privateKey || acc.privateKey || "").trim();
    if (!key) throw new Error("密钥认证需填写私钥路径");
    acc.privateKey = key;
    delete acc.password;
  }
  return acc;
}

// ==================== 连接状态 ====================
function setConn(name, patch) {
  connState.set(name, { ...(connState.get(name) || {}), ...patch, lastCheck: nowStr() });
}
async function probeAccount(name) {
  if (!name) throw new Error("缺少服务器名称");
  setConn(name, { status: "connecting", lastError: null });
  const t0 = Date.now();
  try {
    const r = await callTool("execute-command", {
      connectionName: name, cmdString: "echo __WB_PONG__", timeout: 15000,
    }, 25000);
    const ms = Date.now() - t0;
    if (r.ok && r.text.includes("__WB_PONG__")) {
      setConn(name, { status: "connected", latencyMs: ms, lastError: null });
    } else {
      const e = parseToolError(r.text);
      setConn(name, { status: "error", lastError: humanizeError(e ? e.message : String(r.text || r.error || "")).slice(0, 600) });
    }
  } catch (e) {
    setConn(name, { status: "error", lastError: humanizeError(String(e.message || e)).slice(0, 600) });
  }
  return connState.get(name);
}

// ==================== 工具函数 ====================
function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new Error("请求体过大")); }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
/** 安全引用：拒绝控制字符；Windows 盘符路径拒绝 cmd 元字符（cmd 下 \ 不是转义符） */
function shq(s) {
  const v = String(s);
  if (/[\r\n\0]/.test(v)) throw new Error("路径/关键词包含非法控制字符");
  if (/^[A-Za-z]:[\\/]/.test(v) || v.includes("\\")) {
    if (/[&|<>^%"!]/.test(v)) throw new Error("Windows 路径包含危险字符（& | < > ^ % \" !），已拒绝");
    return '"' + v + '"';
  }
  return '"' + v.replace(/(["\\$`])/g, "\\$1") + '"';
}
/** 临时文件名消毒，防止远端文件名带非法字符或穿越 */
function safeName(n) {
  return String(n || "file.bin").replace(/[^\w.\-]/g, "_").slice(0, 80) || "file.bin";
}
function addTransfer(rec) {
  transfers.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), time: nowStr(), ...rec });
  if (transfers.length > MAX_TRANSFERS) transfers.length = MAX_TRANSFERS;
}

// ==================== 环境检测 / 密钥管理 ====================
const SSH_DIR = path.join(os.homedir(), ".ssh");

/** 执行本地命令，永不 reject（统一返回结构） */
function runCmd(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: err ? String(err.message || err) : "",
      });
    });
  });
}

/** TCP 连通性探测（判断网络/防火墙，比 SSH 更快定位问题） */
function tcpProbe(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - t0, error });
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, `连接超时（${timeout} ms）`));
    sock.once("error", (e) => finish(false, e.code || e.message));
    sock.connect(port, host);
  });
}

/** 扫描 ~/.ssh 下的私钥（能通过 ssh-keygen 解析的才算） */
async function listLocalKeys() {
  if (!fs.existsSync(SSH_DIR)) return { dir: SSH_DIR, keys: [] };
  const skip = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment", "agent.env"]);
  const files = fs.readdirSync(SSH_DIR).filter((f) => !f.endsWith(".pub") && !f.startsWith(".") && !skip.has(f));
  const keys = [];
  for (const f of files) {
    const full = path.join(SSH_DIR, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const fp = await runCmd("ssh-keygen", ["-l", "-f", full]);
    if (!fp.ok) continue;
    const line = fp.stdout.trim();
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*?)\s*\((\S+)\)$/);
    keys.push({
      name: f, path: full, size: st.size, mtime: st.mtime.toISOString().slice(0, 10),
      bits: m ? Number(m[1]) : 0,
      fingerprint: m ? m[2] : line,
      type: m ? m[4] : "未知",
      hasPub: fs.existsSync(full + ".pub"),
      pubPath: full + ".pub",
    });
  }
  return { dir: SSH_DIR, keys };
}

/** 一键环境体检 */
async function checkEnv() {
  const items = [];
  const add = (label, status, detail, advice) => items.push({ label, status, detail, advice: advice || "" });

  add("Node.js 运行时", "ok", `${process.version} · ${process.execPath}`);

  const mcpOk = fs.existsSync(MCP_ENTRY);
  add("ssh-mcp-server 入口", mcpOk ? "ok" : "err",
    mcpOk ? MCP_ENTRY : "未找到 build/index.js",
    mcpOk ? "" : "在 ssh-mcp-server 目录执行 npm install 与 npm run build");

  add("MCP 子进程", mcpAlive ? "ok" : "err",
    mcpAlive ? "运行中，握手完成" : "未运行",
    mcpAlive ? "" : "查看面板控制台日志，或重启面板");

  const accounts = loadAccounts();
  add("服务器配置", accounts.length ? "ok" : "warn",
    `${accounts.length} 台 · ${SSH_CONFIG}`,
    accounts.length ? "" : "到「账号」页添加服务器");

  // OpenSSH 工具链
  const sshV = await runCmd("ssh", ["-V"]);
  add("OpenSSH 客户端", sshV.ok ? "ok" : "warn",
    sshV.ok ? (sshV.stderr || sshV.stdout).trim().split("\n")[0] : "未检测到 ssh 命令",
    sshV.ok ? "" : "Windows：设置 → 应用 → 可选功能 → 添加 OpenSSH 客户端");

  const kg = await runCmd("ssh-keygen", ["-h"]);
  const kgOk = !/ENOENT|不是内部或外部命令|not found/i.test((kg.stderr || "") + kg.error);
  add("ssh-keygen 工具", kgOk ? "ok" : "err",
    kgOk ? "可用（可生成/查看密钥指纹）" : "未检测到 ssh-keygen",
    kgOk ? "" : "安装 OpenSSH 客户端后重试");

  // 本地密钥
  const { keys } = await listLocalKeys();
  add("本地密钥", keys.length ? "ok" : "warn",
    keys.length ? `发现 ${keys.length} 个私钥 · ${SSH_DIR}` : `未发现私钥（${SSH_DIR}）`,
    keys.length ? "" : "点下方「生成新密钥」，推荐 ed25519 算法");

  // 每个账号的私钥可读性
  for (const a of accounts) {
    if (!a.privateKey) { add(`账号「${a.name}」`, "warn", "使用密码认证", "密码认证无需私钥"); continue; }
    const p = a.privateKey;
    let exists = false, readable = false;
    try { exists = fs.existsSync(p); if (exists) { fs.accessSync(p, fs.constants.R_OK); readable = true; } } catch { /* ignore */ }
    add(`账号「${a.name}」私钥`, readable ? "ok" : "err",
      readable ? p : exists ? "文件存在但当前进程不可读" : "文件不存在：" + p,
      readable ? "" : "检查路径拼写，或被安全软件/沙箱限制读取");
  }

  return { ok: true, items, sshDir: SSH_DIR };
}

/** 生成密钥对（调用 ssh-keygen，兼容 OpenSSH 与 ssh2） */
async function generateKey(body) {
  const algorithm = ["ed25519", "rsa", "ecdsa"].includes(body.algorithm) ? body.algorithm : "ed25519";
  const name = String(body.name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error("文件名仅支持字母、数字、点、下划线、短横线（1-40 字符）");
  if (!fs.existsSync(SSH_DIR)) fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  const target = path.join(SSH_DIR, name);
  if (fs.existsSync(target) && !body.overwrite) throw new Error(`已存在同名密钥：${target}（勾选"覆盖"或换个文件名）`);

  const args = [];
  if (algorithm === "rsa") args.push("-t", "rsa", "-b", String(body.bits || 4096));
  else if (algorithm === "ecdsa") args.push("-t", "ecdsa", "-b", String(body.bits || 521));
  else args.push("-t", "ed25519");
  args.push("-f", target, "-N", String(body.passphrase || ""), "-C",
    String(body.comment || `${os.userInfo().username}@${os.hostname()}`));

  const r = await runCmd("ssh-keygen", args, 30000);
  if (!r.ok) throw new Error("ssh-keygen 执行失败：" + (r.stderr || r.error));

  const pubPath = target + ".pub";
  const publicKey = fs.readFileSync(pubPath, "utf8").trim();
  const fp = await runCmd("ssh-keygen", ["-l", "-f", pubPath]);

  return {
    ok: true, algorithm, path: target, pubPath, publicKey,
    fingerprint: fp.stdout.trim(),
    hasPassphrase: !!body.passphrase,
  };
}

/** 打开系统文件管理器（严格限制在 ~/.ssh 内，防 UNC/NTLM 泄露与任意路径探测） */
function openFolder(dir) {
  const raw = String(dir || SSH_DIR);
  if (/^[\\/]{2}/.test(raw)) throw new Error("不允许 UNC 路径");
  const target = path.resolve(raw);
  const rel = path.relative(SSH_DIR, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("仅允许打开 ~/.ssh 及其子目录");
  if (!fs.existsSync(target)) throw new Error("目录不存在：" + target);
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const cp = spawn(cmd, [target], { detached: true, stdio: "ignore" });
  cp.on("error", () => { /* 忽略：无文件管理器不影响主流程 */ });
  cp.unref();
  return { ok: true, dir: target };
}

/** 单台服务器分步诊断：网络 → 认证 → 远程执行 */
async function testAccount(name) {
  const acc = loadAccounts().find((a) => a.name === name);
  if (!acc) throw new Error("账号不存在：" + name);
  const steps = [];

  const tcp = await tcpProbe(acc.host, acc.port, 6000);
  steps.push({
    label: "① 网络连通（TCP）", ok: tcp.ok,
    detail: tcp.ok ? `${tcp.ms} ms 内建立 TCP 连接` : tcp.error,
    advice: tcp.ok ? "" : "检查主机/端口是否正确、防火墙与云安全组是否放行；内网地址需处于同一网络",
  });
  if (!tcp.ok) return { ok: false, steps, account: publicAccount(acc) };

  const st = await probeAccount(name);
  const authOk = st.status === "connected";
  steps.push({
    label: "② SSH 认证", ok: authOk,
    detail: authOk ? `认证成功，往返 ${st.latencyMs} ms` : (st.lastError || "认证失败"),
    advice: authOk ? "" : "把公钥加入服务器 ~/.ssh/authorized_keys，或在「账号」页改用密码认证",
  });
  if (authOk) {
    const r = await callTool("execute-command", {
      connectionName: name, cmdString: "whoami; hostname; uname -srm 2>/dev/null || ver", timeout: 15000,
    }, 25000);
    steps.push({
      label: "③ 远程命令执行", ok: r.ok,
      detail: r.ok ? (r.text || "").trim().split("\n").filter(Boolean).slice(0, 3).join(" | ") : String(r.text).slice(0, 200),
      advice: r.ok ? "" : "账号可能受限（nologin / 只读），检查服务器用户权限",
    });
  }
  return { ok: steps.every((s) => s.ok), steps, account: publicAccount(acc) };
}

/** 识别 ls 类命令的失败（execute-command 把非零退出码当正常输出返回） */
function detectShellFailure(text) {
  const t = String(text || "");
  const exit = t.match(/\[exit code\]\s*(\d+)/);
  if (!exit) return null;
  const code = Number(exit[1]);
  if (!code) return null;
  if (/Permission denied|权限不够/i.test(t)) {
    return { reason: "PERMISSION_DENIED", exitCode: code,
      hint: "当前账号对该目录没有读权限（目录权限位通常是 700/750 且属主不是你），可换有权限的目录、让管理员放开权限，或用有权限的账号登录。" };
  }
  if (/No such file or directory|cannot access|not a directory/i.test(t)) {
    return { reason: "NOT_FOUND", exitCode: code,
      hint: "目录不存在。不同服务器的家目录位置可能不同（如 /home/data/<user>），可点「检测家目录」自动定位。" };
  }
  if (/command not found|不是内部或外部命令|'ls' is not recognized/i.test(t)) {
    return { reason: "NO_LS", exitCode: code,
      hint: "远端系统没有 ls（可能是 Windows 或极简系统）。可用「终端」执行 dir 或手动输入路径。" };
  }
  return { reason: "EXIT_CODE", exitCode: code, hint: "命令返回非零退出码，请查看上方原始输出。" };
}

/** 探测远端真实家目录（不同发行版可能不是 /home/<user>） */
const homeCache = new Map();
let accountsGeneration = 0;
async function detectHome(name) {
  if (!name) throw new Error("缺少服务器名称");
  if (homeCache.has(name)) return homeCache.get(name);
  const generation = accountsGeneration;
  const r = await callTool("execute-command", {
    connectionName: name, cmdString: 'printf "HOME=%s\\n" "$HOME"; id -un; pwd', timeout: 15000,
  }, 25000);
  if (!r.ok) throw new Error(humanizeError(r.text));
  const clean = String(r.text).replace(/\r/g, "");   // SSH 返回 CRLF，避免用户名带上 \r
  const home = (clean.match(/^HOME=(.*)$/m) || [])[1] || "";
  const user = clean.split("\n")[1] || "";
  const res = { ok: true, home, user, raw: clean };
  if (home && generation === accountsGeneration) homeCache.set(name, res);
  return res;
}

// ==================== AI（OpenAI 兼容接口） ====================
const AI_CONFIG = path.join(__dirname, "ai-config.json");
const AI_DEFAULTS = { baseUrl: "", apiKey: "", model: "", models: [], thinking: "off", contextK: 8 };

function loadAiConfig() {
  let c = { ...AI_DEFAULTS };
  try { c = { ...c, ...JSON.parse(fs.readFileSync(AI_CONFIG, "utf8")) }; } catch { /* first run */ }
  if (!c.baseUrl && process.env.OPENAI_BASE_URL) c.baseUrl = process.env.OPENAI_BASE_URL;
  if (!c.apiKey && process.env.OPENAI_API_KEY) c.apiKey = process.env.OPENAI_API_KEY;
  return c;
}
function saveAiConfig(c) { fs.writeFileSync(AI_CONFIG, JSON.stringify(c, null, 2) + "\n", "utf8"); }
function publicAiConfig(c) {
  return {
    baseUrl: c.baseUrl, model: c.model, models: c.models || [],
    thinking: c.thinking, contextK: c.contextK,
    hasKey: !!c.apiKey, configured: aiConfigured(c),
  };
}

function aiConfigured(c) {
  if (!c.baseUrl) return false;
  try {
    const url = new URL(c.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return !!c.apiKey || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

async function aiChat(body) {
  const cfg = loadAiConfig();
  if (!aiConfigured(cfg)) {
    throw new Error("尚未配置 AI 服务：点终端右上角「⚙ AI」填写 Base URL 与 API Key（OpenAI 兼容接口）");
  }
  const thinking = ["off", "low", "medium", "high"].includes(body.thinking) ? body.thinking : (cfg.thinking || "off");
  const contextK = Math.max(2, Math.min(128, Number(body.contextK) || cfg.contextK || 8));
  const model = String(body.model || cfg.model || "").trim();
  if (!model) throw new Error("未指定模型：用 /workbuddy-mode 选择一个模型");

  const maxTokens = { off: 900, low: 1400, medium: 2200, high: 4000 }[thinking] || 900;
  const styleHint = {
    off: "",
    low: "回答尽量简短，直接给命令或结论。",
    medium: "先给结论，再列要点；涉及命令时给出可直接复制的代码块。",
    high: "详细分析：先给结论，再给原理与推理步骤，最后列出风险与验证方法；命令放在代码块中。",
  }[thinking] || "";

  const sys = [
    "你是 WorkBuddy 终端内的运维助手，回答用中文。",
    body.server ? `用户当前连接的服务器：${body.server}（目录 ${body.cwd || "未知"}）。` : "用户当前未连接服务器。",
    "你只能给出建议和命令文本，不能直接执行命令，也不要编造执行结果。",
    styleHint,
  ].filter(Boolean).join("");

  let msgs = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role && m.content) : [];
  msgs = msgs.filter((m) => ["user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: String(m.content) }));

  // 按上下文预算从最新往回保留
  const budget = Math.max(2000, contextK * 1000 * 0.7);
  const kept = [];
  let used = sys.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = msgs[i].content.length;
    if (kept.length && used + len > budget) break;
    kept.unshift(msgs[i]); used += len;
  }
  kept.unshift({ role: "system", content: sys });

  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}) },
      body: JSON.stringify({ model, messages: kept, temperature: 0.3, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new Error("无法连接 AI 服务（" + url + "）：" + (e.message || e));
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AI 接口返回 ${res.status}：${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI 服务未返回有效文本，请检查模型及接口兼容性");
  return {
    ok: true, text, model, thinking, contextK,
    usage: j.usage || null, trimmedChars: used,
  };
}

async function aiListModels() {
  const cfg = loadAiConfig();
  if (!cfg.baseUrl) throw new Error("请先填写 Base URL");
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
  const res = await fetch(url, {
    headers: cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("拉取模型失败 " + res.status);
  const j = await res.json();
  const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 200);
  return { ok: true, models };
}

/** 探测本机可用的模型服务（免配置路径） */
async function aiDetect() {
  const found = [];
  const cfg = loadAiConfig();
  if (aiConfigured(cfg)) {
    found.push({ source: "config", label: "已保存的配置", baseUrl: cfg.baseUrl, models: cfg.models || [], hasKey: !!cfg.apiKey });
  }
  if (process.env.OPENAI_API_KEY) {
    found.push({
      source: "env",
      label: "环境变量 OPENAI_API_KEY",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      models: [], hasKey: true,
    });
  }
  const candidates = [
    { source: "ollama", label: "Ollama（本机 11434）", base: "http://127.0.0.1:11434/v1" },
    { source: "lmstudio", label: "LM Studio（本机 1234）", base: "http://127.0.0.1:1234/v1" },
    { source: "vllm", label: "vLLM / 本地网关（本机 8000）", base: "http://127.0.0.1:8000/v1" },
  ];
  for (const c of candidates) {
    try {
      const r = await fetch(c.base + "/models", { signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const j = await r.json();
      const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 20);
      found.push({ source: c.source, label: c.label, baseUrl: c.base, models, hasKey: false });
    } catch { /* 未运行 */ }
  }
  return { ok: true, found, configured: aiConfigured(cfg) };
}

// ==================== 路由 ====================
const routes = {
  "GET /api/health": async () => ({ ok: true, mcpAlive }),

  "GET /api/monitor": async (_body, _res, query) => {
    const { readMonitor, configVersion } = await import(pathToFileURL(path.join(MCP_DIR, "build", "utils", "operation-audit.js")).href);
    const requestedLimit = query.get("limit");
    const limit = requestedLimit === null ? 100 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: "limit 必须是 1-200 的整数" };
    const source = query.get("source") || "";
    const risk = query.get("risk") || "";
    if (source && !["dashboard", "workbuddy", "mcp-client"].includes(source)) return { ok: false, error: "无效的操作来源" };
    if (risk && !["low", "medium", "high", "critical"].includes(risk)) return { ok: false, error: "无效的风险等级" };
    const data = readMonitor(SSH_CONFIG, {
      limit, source, risk,
      connectionName: query.get("connectionName") || "",
    });
    let version = "";
    try { version = configVersion(fs.readFileSync(SSH_CONFIG, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ok: true, ...data, configVersion: version, configPath: SSH_CONFIG, syncMode: "next-tool-call" };
  },

  "GET /api/overview": async () => ({
    ok: true,
    mcpAlive,
    configPath: SSH_CONFIG,
    accounts: loadAccounts().map(publicAccount),
    conn: Object.fromEntries(connState),
  }),

  "GET /api/servers": async () => {
    const r = await callTool("list-servers", {}, 15000);
    if (!r.ok) return { ok: false, error: r.text || r.error };
    const marker = "Raw JSON:";
    const i = r.text.lastIndexOf(marker);
    let servers = [];
    if (i >= 0) { try { servers = JSON.parse(r.text.slice(i + marker.length).trim()); } catch { /* ignore */ } }
    return { ok: true, servers, text: r.text };
  },

  // ---- 环境检测 / 密钥 ----
  "GET /api/env/check": async () => checkEnv(),

  "GET /api/keys": async () => ({ ok: true, ...(await listLocalKeys()) }),

  "POST /api/keys/generate": async (body) => generateKey(body),

  "POST /api/keys/open-folder": async (body) => openFolder(body.dir ? String(body.dir) : SSH_DIR),

  "GET /api/keys/public": async (req, res, query) => {
    const name = String(query.get("name") || "");
    if (!/^[A-Za-z0-9._-]{1,40}\.pub$/.test(name)) return { ok: false, error: "非法文件名" };
    const p = path.join(SSH_DIR, name);
    if (!fs.existsSync(p)) return { ok: false, error: "公钥文件不存在：" + p };
    return { ok: true, path: p, publicKey: fs.readFileSync(p, "utf8").trim() };
  },

  "POST /api/test": async (body) => {
    const name = String(body.name || "").trim();
    if (!name) return { ok: false, error: "缺少服务器名称" };
    return testAccount(name);
  },

  // ---- AI 助手 ----
  "GET /api/ai/config": async () => ({ ok: true, ...publicAiConfig(loadAiConfig()) }),

  "POST /api/ai/config": async (body) => {
    const c = loadAiConfig();
    const oldHost = (() => { try { return new URL(c.baseUrl).host; } catch { return ""; } })();
    if (typeof body.baseUrl === "string") c.baseUrl = body.baseUrl.trim();
    const newHost = (() => { try { return new URL(c.baseUrl).host; } catch { return ""; } })();
    if (typeof body.model === "string") c.model = body.model.trim();
    if (Array.isArray(body.models)) c.models = body.models;
    if (["off", "low", "medium", "high"].includes(body.thinking)) c.thinking = body.thinking;
    if (body.contextK) c.contextK = Math.max(2, Math.min(128, Number(body.contextK)));
    if (typeof body.apiKey === "string" && body.apiKey.length > 0) c.apiKey = body.apiKey.trim();
    if (body.clearKey) c.apiKey = "";
    // 换了服务地址又不重新填 Key：清空旧 Key，避免把凭据发给新主机
    if (oldHost && newHost && oldHost !== newHost && !(typeof body.apiKey === "string" && body.apiKey.length > 0)) {
      c.apiKey = "";
    }
    saveAiConfig(c);
    return { ok: true, ...publicAiConfig(c), keyCleared: oldHost && newHost && oldHost !== newHost && !c.apiKey };
  },

  "GET /api/ai/detect": async () => aiDetect(),

  "POST /api/ai/models": async () => aiListModels(),

  "POST /api/ai/chat": async (body) => aiChat(body),

  // ---- 账号 CRUD ----
  "POST /api/accounts": async (body) => {
    const list = loadAccounts();
    const acc = validateAccount(body, list, null);
    list.push(acc);
    saveAccounts(list);
    accountsChanged();
    return { ok: true, account: publicAccount(acc), message: `已添加 ${acc.name}，同配置的新版本 MCP 在下一次工具调用时加载` };
  },

  "PUT /api/accounts": async (body, res, query) => {
    const original = String(body.originalName || query.get("name") || "").trim();
    const list = loadAccounts();
    const idx = list.findIndex((a) => a.name === original);
    if (idx < 0) return { ok: false, error: `账号不存在: ${original}` };
    const acc = validateAccount(body, list, original);
    list[idx] = acc;
    saveAccounts(list);
    accountsChanged();
    return { ok: true, account: publicAccount(acc), message: `已更新 ${acc.name}，同配置的新版本 MCP 在下一次工具调用时加载` };
  },

  "DELETE /api/accounts": async (body, res, query) => {
    const name = String(query.get("name") || "").trim();
    const list = loadAccounts();
    const next = list.filter((a) => a.name !== name);
    if (next.length === list.length) return { ok: false, error: `账号不存在: ${name}` };
    saveAccounts(next);
    accountsChanged();
    return { ok: true, message: `已删除 ${name}` };
  },

  // ---- 连接 ----
  "POST /api/connect": async (body) => {
    const name = String(body.name || "").trim();
    if (!loadAccounts().some((a) => a.name === name)) return { ok: false, error: `账号不存在: ${name}` };
    const st = await probeAccount(name);
    return { ok: st.status === "connected", state: st, error: st.lastError || undefined };
  },

  "POST /api/connect-all": async () => {
    const list = loadAccounts();
    const results = [];
    for (const a of list) results.push({ name: a.name, ...(await probeAccount(a.name)) });
    return { ok: true, results };
  },

  // ---- 命令 ----
  "POST /api/exec": async (body) => {
    const { connectionName, cmdString } = body;
    const timeout = Number(body.timeout) || 60000;
    if (!cmdString) return { ok: false, error: "缺少 cmdString" };
    const r = await callTool("execute-command", { cmdString, connectionName, timeout }, timeout + 15000);
    if (r.ok) setConn(connectionName, { status: "connected", lastError: null });
    else {
      const e = parseToolError(r.text);
      if (e && (e.code === "SSH_CONNECTION_FAILED" || e.code === "SSH_AUTH_FAILED")) {
        setConn(connectionName, { status: "error", lastError: humanizeError(e.message).slice(0, 600) });
      }
    }
    return { ok: r.ok, text: r.ok ? r.text : humanizeError(r.text), error: r.ok ? undefined : humanizeError(r.text) };
  },

  // ---- 文件列表 / 读取 / 写入 ----
  "POST /api/files/list": async (body) => {
    const { connectionName } = body;
    const p = String(body.path || "/").trim() || "/";
    const r = await callTool("execute-command", {
      connectionName, cmdString: `LC_ALL=C ls -la ${shq(p)}`, timeout: 30000,
    }, 45000);
    if (!r.ok) return { ok: false, text: humanizeError(r.text), path: p, error: humanizeError(r.text), reason: "CONNECTION" };
    setConn(connectionName, { status: "connected", lastError: null });
    const fail = detectShellFailure(r.text);
    if (fail) {
      return { ok: false, text: r.text, path: p, error: fail.hint, reason: fail.reason, exitCode: fail.exitCode };
    }
    return { ok: true, text: r.text, path: p };
  },

  "POST /api/files/home": async (body) => detectHome(String(body.connectionName || "")),

  "POST /api/files/read": async (body) => {
    const { connectionName, remotePath } = body;
    if (!remotePath) return { ok: false, error: "缺少 remotePath" };
    const r = await callTool("read-file", {
      remotePath, connectionName,
      length: Math.max(1, Math.min(1024 * 1024, Number(body.length) || 200000)),
    }, 60000);
    if (!r.ok) return { ok: false, text: r.text, error: r.text };
    const header = /^\[file\] [\s\S]*?\n\[bytes\] (\d+)-(\d+) of (\d+) \((?:next offset \d+|end of file)\)\n---\n/.exec(r.text);
    if (!header) throw new Error("无法解析 MCP 文件响应，已禁止编辑以避免损坏文件");
    const [start, end, total] = header.slice(1).map(Number);
    return {
      ok: true, text: r.text, content: r.text.slice(header[0].length),
      start, end, total, truncated: start !== 0 || end < total,
    };
  },

  "POST /api/files/write": async (body) => {
    const { connectionName, remotePath, content, append } = body;
    if (!remotePath) return { ok: false, error: "缺少 remotePath" };
    if (typeof content !== "string") return { ok: false, error: "缺少 content" };
    const r = await callTool("write-file", { remotePath, content, append: !!append, connectionName }, 60000);
    return { ok: r.ok, text: r.text, error: r.ok ? undefined : r.text };
  },

  // ---- 文件搜索 ----
  "POST /api/search": async (body) => {
    const { connectionName, query } = body;
    const p = String(body.path || "/").trim() || "/";
    const q = String(query || "").trim();
    if (!q) return { ok: false, error: "请输入搜索关键词" };
    const mode = body.mode === "content" ? "content" : "name";
    const cmd = mode === "name"
      ? `LC_ALL=C find ${shq(p)} -maxdepth 4 -iname ${shq("*" + q + "*")} 2>/dev/null | head -60`
      : `LC_ALL=C grep -rIn --max-count=30 -e ${shq(q)} -- ${shq(p)} 2>/dev/null | head -80`;
    const r = await callTool("execute-command", { connectionName, cmdString: cmd, timeout: 30000 }, 45000);
    return { ok: r.ok, text: r.text, mode, error: r.ok ? undefined : r.text };
  },

  // ---- 传输记录 ----
  "GET /api/transfers": async () => ({ ok: true, transfers }),

  // ---- 后台任务 ----
  "POST /api/job/start": async (body) => {
    const { connectionName, cmdString, directory } = body;
    if (!cmdString) return { ok: false, error: "缺少 cmdString" };
    const r = await callTool("job-start", { cmdString, directory, connectionName }, 60000);
    return { ok: r.ok, text: r.text, error: r.ok ? undefined : r.text };
  },
  "POST /api/job/status": async (body) => {
    const { connectionName, jobId } = body;
    if (!jobId) return { ok: false, error: "缺少 jobId" };
    const r = await callTool("job-status", { jobId, connectionName, tailBytes: 16384 }, 30000);
    return { ok: r.ok, text: r.text, error: r.ok ? undefined : r.text };
  },
  "POST /api/job/kill": async (body) => {
    const { connectionName, jobId } = body;
    const r = await callTool("job-kill", { jobId, connectionName }, 30000);
    return { ok: r.ok, text: r.text, error: r.ok ? undefined : r.text };
  },
};

// ==================== HTTP 服务 ====================
async function handle(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");

  // ---- 同源防护：只接受本机 Host / 同源 Origin，阻断跨站请求与 DNS rebinding ----
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    return sendJson(res, { ok: false, error: "Forbidden: bad host" }, 403);
  }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return sendJson(res, { ok: false, error: "Forbidden: bad origin" }, 403);
  }
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    return sendJson(res, { ok: false, error: "Forbidden: cross-site request" }, 403);
  }

  // 首页
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    const html = fs.readFileSync(INDEX_HTML);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  if (u.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }

  // 上传：边收边写盘（避免整文件进内存），2GB 上限
  if (req.method === "POST" && u.pathname === "/api/transfer/upload") {
    const connectionName = u.searchParams.get("connectionName") || "";
    const remotePath = u.searchParams.get("remotePath") || "";
    const filename = safeName(u.searchParams.get("filename"));
    if (!remotePath) return sendJson(res, { ok: false, error: "缺少 remotePath" }, 400);
    const tmp = path.join(TMP_DIR, `${process.pid}-${crypto.randomUUID()}-${filename}`);
    const MAX_BYTES = 2 * 1024 * 1024 * 1024;
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        req.on("data", (c) => {
          size += c.length;
          if (size > MAX_BYTES) { req.destroy(); ws.destroy(); reject(new Error("文件超过 2GB 上限")); }
        });
        req.on("aborted", () => reject(new Error("上传被中断")));
        req.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        req.pipe(ws);
      });
      const r = await callTool("upload", { localPath: tmp, remotePath, connectionName }, 600000);
      addTransfer({ dir: "up", connectionName, remotePath, bytes: size, ok: r.ok, message: r.ok ? "成功" : String(r.text).slice(0, 200) });
      return sendJson(res, { ok: r.ok, text: r.text, bytes: size, error: r.ok ? undefined : r.text });
    } catch (e) {
      return sendJson(res, { ok: false, error: String(e.message || e) }, 413);
    } finally {
      fs.rm(tmp, { force: true }, (error) => { if (error) log("上传临时文件清理失败:", error.message); });
    }
  }

  // 下载：流式回传；成功、失败、中断都清理临时文件
  if (req.method === "GET" && u.pathname === "/api/transfer/download") {
    const connectionName = u.searchParams.get("connectionName") || "";
    const remotePath = u.searchParams.get("remotePath") || "";
    if (!remotePath) return sendJson(res, { ok: false, error: "缺少 remotePath" }, 400);
    const base = safeName(remotePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop());
    const tmp = path.join(TMP_DIR, `${process.pid}-${crypto.randomUUID()}-${base}`);
    const cleanup = () => fs.rm(tmp, { force: true, recursive: true }, (error) => {
      if (error) log("下载临时文件清理失败:", error.message);
    });
    try {
      const r = await callTool("download", { remotePath, localPath: tmp, connectionName }, 600000);
      if (!r.ok || !fs.existsSync(tmp)) {
        addTransfer({ dir: "down", connectionName, remotePath, bytes: 0, ok: false, message: String(r.text).slice(0, 200) });
        cleanup();
        return sendJson(res, { ok: false, error: r.text || "下载失败" }, 500);
      }
      const stat = fs.statSync(tmp);
      if (!stat.isFile()) throw new Error("浏览器下载仅支持单个文件；目录请使用 MCP download 工具或先在远端打包");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(base)}`,
        "Content-Length": stat.size,
      });
      let logged = false;
      pipeline(fs.createReadStream(tmp), res, (error) => {
        cleanup();
        if (!logged) {
          logged = true;
          addTransfer({ dir: "down", connectionName, remotePath, bytes: stat.size, ok: !error, message: error ? error.message : "成功" });
        }
      });
      return;
    } catch (e) {
      cleanup();
      return sendJson(res, { ok: false, error: String(e.message || e) }, 500);
    }
  }

  // JSON 接口
  const key = req.method + " " + u.pathname;
  const handler = routes[key];
  if (!handler) return sendJson(res, { ok: false, error: "Not Found: " + key }, 404);

  const isWrite = req.method === "POST" || req.method === "PUT";
  if (isWrite) {
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") return sendJson(res, { ok: false, error: "Content-Type 必须为 application/json" }, 415);
  }
  const body = isWrite ? JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8") || "{}") : {};
  const result = await handler(body, res, u.searchParams);
  sendJson(res, result);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) sendJson(res, { ok: false, error: String(e.message || e) }, 500);
      else res.end();
    }
  });
}

function listenWithFallback(port, triesLeft) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && triesLeft > 0) {
        log(`端口 ${port} 被占用，尝试 ${port + 1} ...`);
        resolve(listenWithFallback(port + 1, triesLeft - 1));
      } else reject(e);
    });
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  if (!fs.existsSync(MCP_ENTRY)) {
    console.error("找不到 ssh-mcp-server 入口:", MCP_ENTRY);
    process.exit(1);
  }
  try {
    await startMcp();
  } catch (e) {
    log("MCP 启动失败（面板仍可用，请检查 ssh-config.json）:", e.message);
  }
  const { port } = await listenWithFallback(PORT_PREFERRED, 5);
  log(`面板已启动: http://127.0.0.1:${port}  (仅监听本机)`);
  log("按 Ctrl+C 停止。");
  if (process.argv.includes("--open")) {
    try { spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${port}`], { detached: true, stdio: "ignore" }).unref(); }
    catch { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("启动失败:", e); process.exit(1); });
}

module.exports = { createServer, startMcp, routes };
