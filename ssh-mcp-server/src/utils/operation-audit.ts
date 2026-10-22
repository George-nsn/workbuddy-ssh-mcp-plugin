import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type OperationArgs = Record<string, unknown>;
export type OperationEvent = {
  id: string;
  time: string;
  instanceId: string;
  client: string;
  source: "dashboard" | "workbuddy" | "mcp-client";
  tool: string;
  connectionName: string;
  summary: string;
  risk: RiskLevel;
  reason: string;
  phase: "started" | "completed";
  admitted?: boolean;
  status: "running" | "succeeded" | "failed";
  durationMs?: number;
  exitCode?: number;
  failureCode?: string;
};

export const AUDIT_RETENTION_MS = 7 * 86400000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 5;
const OWN_FILE = /^(?:events|instance)-[0-9]+-[0-9a-f-]{36}(?:-[0-4])?\.(?:jsonl|json)$/;

export function configVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function monitorDirectory(configFile: string): string {
  const absolute = path.resolve(configFile);
  const identity = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  return path.join(path.dirname(absolute), ".ssh-mcp-monitor",
    configVersion(identity).slice(0, 16));
}

export function assessOperation(tool: string, args: OperationArgs): { risk: RiskLevel; reason: string; summary: string } {
  if (tool === "execute-command" || tool === "job-start") {
    const command = typeof args.cmdString === "string" ? args.cmdString : "";
    const first = /^\s*([a-zA-Z0-9_.-]+)/.exec(command)?.[1] || "";
    const known = /^(?:ls|cat|head|tail|pwd|whoami|hostname|uname|id|df|du|free|ps|echo|printf|grep|find|rm|sudo|chmod|chown|kill|bash|sh|python|python3|node|curl|wget|git|docker|npm|systemctl|reboot|shutdown)$/;
    const summary = `${known.test(first) ? first : "custom-command"} [arguments omitted]`;
    if (/\b(?:mkfs(?:\.\w+)?|format)\b|\bdd\b[\s\S]*\bof=\/dev\/|:\(\)\s*\{/.test(command) ||
        /\brm\s+[\s\S]*-[a-zA-Z]*r[a-zA-Z]*[\s\S]*\s(?:["']?\/(?:\*|["']?(?:\s|$))|~(?:\s|$)|["']?\$(?:HOME|\{HOME\})["']?(?:\s|$))/.test(command)) {
      return { risk: "critical", reason: "DESTRUCTIVE_COMMAND", summary };
    }
    if (/\b(?:sudo|su|rm|rmdir|del|erase|chmod|chown|kill|pkill|killall|reboot|shutdown|systemctl|service|iptables|ufw|mount|umount|truncate|tee)\b|[>]|(?:curl|wget)[\s\S]*\|[\s\S]*\b(?:sh|bash)\b/i.test(command)) {
      return { risk: "high", reason: "PRIVILEGED_OR_MUTATING", summary };
    }
    if (tool === "execute-command" &&
        /^(?:ls|cat|head|tail|pwd|whoami|hostname|uname|id|df|du|free|ps|echo)\b/.test(command.trim()) &&
        !/[;&|`$()<>\\\r\n]/.test(command)) {
      return { risk: "low", reason: "READ_ONLY_PATTERN", summary };
    }
    return { risk: "medium", reason: "UNCLASSIFIED_COMMAND", summary };
  }
  if (tool === "write-file" || tool === "upload") {
    const target = typeof args.remotePath === "string" ? args.remotePath : "";
    const privileged = /(?:^\/(?:etc|boot|usr|bin|sbin)(?:\/|$)|authorized_keys|sudoers|crontab|system32)/i.test(target);
    return { risk: privileged ? "high" : "medium", reason: "FILE_WRITE", summary: tool };
  }
  if (tool === "job-kill") return { risk: "high", reason: "JOB_CONTROL", summary: tool };
  if (tool === "download") return { risk: "medium", reason: "REMOTE_DATA_READ", summary: tool };
  if (["list-servers", "read-file", "job-status", "job-list"].includes(tool)) {
    return { risk: "low", reason: "READ_ONLY_TOOL", summary: tool };
  }
  return { risk: "medium", reason: "UNCLASSIFIED_COMMAND", summary: tool };
}

export class OperationAudit {
  readonly instanceId = `${process.pid}-${randomUUID()}`;
  readonly directory: string;
  private segment = 0;

  constructor(configFile: string) {
    this.directory = monitorDirectory(configFile);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - AUDIT_RETENTION_MS;
    for (const file of fs.readdirSync(this.directory)) {
      if (!OWN_FILE.test(file)) continue;
      const full = path.join(this.directory, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  append(event: OperationEvent): void {
    let file = path.join(this.directory, `events-${this.instanceId}-${this.segment}.jsonl`);
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > 16384) throw new Error("Audit event exceeds 16 KiB limit");
    let size = 0;
    try { size = fs.statSync(file).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      this.segment = (this.segment + 1) % MAX_SEGMENTS;
      file = path.join(this.directory, `events-${this.instanceId}-${this.segment}.jsonl`);
      fs.writeFileSync(file, "", { mode: 0o600 });
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  }

  heartbeat(state: Record<string, unknown>): void {
    const file = path.join(this.directory, `instance-${this.instanceId}.json`);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...state, instanceId: this.instanceId, pid: process.pid, lastSeen: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

export type MonitorFilter = { limit?: number; source?: string; risk?: string; connectionName?: string };

export function readMonitor(configFile: string, filter: MonitorFilter = {}) {
  const directory = monitorDirectory(configFile);
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit || 100)));
  const warnings: string[] = [];
  let files: Array<{ name: string; mtime: number; size: number }>;
  try {
    files = fs.readdirSync(directory).filter((name) => OWN_FILE.test(name)).flatMap((name) => {
      try {
        const stat = fs.statSync(path.join(directory, name));
        return stat.isFile() && stat.mtimeMs >= Date.now() - AUDIT_RETENTION_MS
          ? [{ name, mtime: stat.mtimeMs, size: stat.size }] : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }).sort((a, b) => b.mtime - a.mtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], instances: [], warnings: ["尚无监控数据，请重启使用本项目新版构建的 MCP 连接器。"], truncated: false };
    }
    throw error;
  }
  const instances: Array<Record<string, unknown>> = [];
  const events = new Map<string, OperationEvent>();
  const statusFiles = files.filter((f) => f.name.startsWith("instance-"));
  const logFiles = files.filter((f) => f.name.startsWith("events-"));
  let truncated = statusFiles.length > 100 || logFiles.length > 20;
  for (const file of statusFiles.slice(0, 100)) {
    try {
      if (file.size > 16384) throw new Error("oversized heartbeat");
      const status = JSON.parse(fs.readFileSync(path.join(directory, file.name), "utf8"));
      if (!status || typeof status.instanceId !== "string" || typeof status.lastSeen !== "string") throw new Error("invalid heartbeat");
      instances.push({ ...status, active: status.state !== "stopped" && Date.now() - Date.parse(status.lastSeen) < 20000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push("部分实例状态无法读取");
    }
  }
  for (const file of logFiles.slice(0, 20)) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(directory, file.name), "r");
      const start = Math.max(0, file.size - 262144);
      if (start > 0) truncated = true;
      const buffer = Buffer.alloc(Math.min(file.size, 262144));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
      if (start > 0) lines.shift();
      for (const line of lines) {
        if (!line) continue;
        try {
          const event: OperationEvent = JSON.parse(line);
          if (!event || typeof event.id !== "string" || typeof event.time !== "string" ||
              typeof event.tool !== "string" || !["started", "completed"].includes(event.phase)) throw new Error("invalid event");
          const previous = events.get(event.id);
          const priority = event.phase === "completed" ? 2 : event.admitted ? 1 : 0;
          const previousPriority = previous?.phase === "completed" ? 2 : previous?.admitted ? 1 : 0;
          if (!previous || priority > previousPriority ||
              (priority === previousPriority && event.time >= previous.time)) events.set(event.id, event);
        } catch {
          warnings.push("部分日志行不完整或无效，未显示该行");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const matching = [...events.values()]
    .filter((e) => (!filter.source || e.source === filter.source) &&
      (!filter.risk || e.risk === filter.risk) &&
      (!filter.connectionName || e.connectionName === filter.connectionName))
    .sort((a, b) => b.time.localeCompare(a.time));
  if (matching.length > limit) truncated = true;
  return { events: matching.slice(0, limit), instances, warnings: [...new Set(warnings)], truncated };
}
