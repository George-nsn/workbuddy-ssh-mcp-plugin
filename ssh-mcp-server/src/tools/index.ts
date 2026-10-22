import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "./execute-command.js";
import { registerJobTools } from "./jobs.js";
import { registerUploadTool } from "./upload.js";
import { registerDownloadTool } from "./download.js";
import { registerListServersTool } from "./list-servers.js";
import { registerFileIoTools } from "./file-io.js";
import type { ToolRuntime, ToolContext } from "../core/tool-runtime.js";

/**
 * Register all tools
 * @param server MCP server instance
 */
export function registerAllTools(server: McpServer, runtime?: ToolRuntime): void {
  const context: ToolContext | undefined = runtime ? { runtime, clientName: () => server.server.getClientVersion()?.name || "mcp-client" } : undefined;
  registerExecuteCommandTool(server, context);
  registerJobTools(server, context);
  registerUploadTool(server, context);
  registerDownloadTool(server, context);
  registerListServersTool(server, context);
  registerFileIoTools(server, context);
} 