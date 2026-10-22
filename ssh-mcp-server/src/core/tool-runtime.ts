import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { OperationAudit, assessOperation, configVersion, type OperationArgs, type OperationEvent } from "../utils/operation-audit.js";
import { Logger } from "../utils/logger.js";

export class ToolRuntime {
  private readonly audit: OperationAudit;
  private version: string;
  private active = 0;
  private waiting = 0;
  private idleWaiters: Array<() => void> = [];
  private admissions: Promise<void> = Promise.resolve();
  private closed = false;
  private configError = "";
  private client = "uninitialized";
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly configFile: string,
    private readonly manager: SSHConnectionManager,
  ) {
    const content = fs.readFileSync(configFile, "utf8");
    this.manager.setConfig(CommandLineParser.parseConfigContent(content));
    this.version = configVersion(content);
    this.audit = new OperationAudit(configFile);
    this.publish();
    this.timer = setInterval(() => {
      try { this.publish(); }
      catch { Logger.log("Failed to publish MCP monitor heartbeat; check local disk permissions/space.", "error"); }
    }, 5000);
    this.timer.unref();
  }

  private publish(): void {
    this.audit.heartbeat({
      client: this.client, configVersion: this.version,
      configError: this.configError, state: this.closed ? "stopped" : "running",
      activeOperations: this.active,
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.publish();
  }

  private async admit(signal?: AbortSignal): Promise<void> {
    const admission = this.admissions.then(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("MCP runtime is shutting down");
      try {
        const content = fs.readFileSync(this.configFile, "utf8");
        const version = configVersion(content);
        if (version !== this.version) {
          if (this.active) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
          signal?.throwIfAborted();
          if (this.closed) throw new Error("MCP runtime is shutting down");
          const latest = fs.readFileSync(this.configFile, "utf8");
          this.manager.setConfig(CommandLineParser.parseConfigContent(latest));
          this.version = configVersion(latest);
        }
        this.configError = "";
      } catch (error) {
        this.configError = "CONFIG_RELOAD_FAILED";
        throw error;
      }
      this.active++;
    });
    this.admissions = admission.catch(() => {});
    await admission;
  }

  async run(tool: string, args: OperationArgs, action: () => Promise<CallToolResult>, signal?: AbortSignal, clientName = "mcp-client"): Promise<CallToolResult> {
    const started = Date.now();
    const client = clientName.slice(0, 100);
    this.client = client;
    const event: OperationEvent = {
      id: randomUUID(), time: new Date().toISOString(), instanceId: this.audit.instanceId,
      client, source: client === "ssh-dashboard" ? "dashboard" : /workbuddy/i.test(client) ? "workbuddy" : "mcp-client",
      tool, connectionName: typeof args.connectionName === "string" ? args.connectionName.slice(0, 100) : "(default selection pending)",
      ...assessOperation(tool, args), phase: "started", status: "running",
    };
    if (this.waiting + this.active >= 128) {
      try {
        this.audit.append({ ...event, phase: "completed", status: "failed", failureCode: "MCP_BUSY", durationMs: 0 });
      } catch { Logger.log("Cannot persist rejected-operation audit event.", "error"); }
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "MCP_BUSY", message: "Too many active/queued operations; retry later.", retriable: true }) }] };
    }
    this.waiting++;
    let admitted = false;
    let recorded = false;
    let executed = false;
    try {
      this.audit.append(event);
      recorded = true;
      await this.admit(signal);
      admitted = true;
      this.waiting--;
      signal?.throwIfAborted();
      if (tool === "list-servers") event.connectionName = "(all)";
      else if (!args.connectionName) event.connectionName = this.manager.getAllServerInfos()[0]?.name || "(none)";
      event.admitted = true;
      this.audit.append(event);
      executed = true;
      const result = await action();
      const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const exit = /(?:^|\n)\[exit code\]\s*(-?\d+)\s*$/.exec(text);
      const exitCode = exit ? Number(exit[1]) : undefined;
      this.audit.append({
        ...event, time: new Date().toISOString(), phase: "completed",
        status: result.isError || (exitCode !== undefined && exitCode !== 0) ? "failed" : "succeeded",
        durationMs: Date.now() - started, ...(exitCode !== undefined ? { exitCode } : {}),
        ...(result.isError ? { failureCode: "TOOL_ERROR" } : {}),
      });
      return result;
    } catch {
      const failureCode = signal?.aborted ? "REQUEST_CANCELLED" :
        this.configError || (executed ? "OPERATION_OR_AUDIT_FAILED" : "AUDIT_OR_RUNTIME_UNAVAILABLE");
      Logger.log(`MCP operation ${tool} failed: ${failureCode}. Check configuration and local audit storage.`, "error");
      if (recorded) {
        try {
          this.audit.append({ ...event, time: new Date().toISOString(), phase: "completed", status: "failed", durationMs: Date.now() - started, failureCode });
        } catch { Logger.log("Cannot persist final audit event; operation outcome may be unknown.", "error"); }
      }
      return { isError: true, content: [{ type: "text", text: JSON.stringify({
        code: failureCode, retriable: !executed,
        message: executed
          ? "Operation may have executed, but completion/audit failed. Verify remote state before retrying."
          : "Operation was not executed. Check configuration, cancellation, or local audit storage.",
      }) }] };
    } finally {
      if (admitted) {
        this.active--;
        if (!this.active) this.idleWaiters.splice(0).forEach((resolve) => resolve());
      } else {
        this.waiting--;
      }
      try { this.publish(); }
      catch { Logger.log("Failed to publish MCP monitor heartbeat after operation.", "error"); }
    }
  }
}

export type ToolContext = { runtime: ToolRuntime; clientName: () => string };

export function runTool(context: ToolContext | undefined, tool: string, args: OperationArgs, action: () => Promise<CallToolResult>, signal?: AbortSignal): Promise<CallToolResult> {
  return context ? context.runtime.run(tool, args, action, signal, context.clientName()) : action();
}
