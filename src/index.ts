#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

interface YandexDiskConfig {
  token: string;
  baseUrl: string;
}

class YandexDiskAPI {
  private config: YandexDiskConfig;

  constructor(token: string) {
    this.config = {
      token,
      baseUrl: "https://cloud-api.yandex.net/v1/disk",
    };
  }

  private async request(
    path: string,
    options: RequestInit = {}
  ): Promise<any> {
    const url = `${this.config.baseUrl}${path}`;
    const headers = {
      Authorization: `OAuth ${this.config.token}`,
      "Content-Type": "application/json",
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Yandex.Disk API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    return response.json();
  }

  async getDiskInfo() {
    return this.request("/");
  }

  async getMetadata(path: string) {
    return this.request(`/resources?path=${encodeURIComponent(path)}`);
  }

  async listFiles(limit: number = 20, offset: number = 0) {
    return this.request(`/resources/files?limit=${limit}&offset=${offset}`);
  }

  async createFolder(path: string) {
    return this.request(`/resources?path=${encodeURIComponent(path)}`, {
      method: "PUT",
    });
  }

  async getUploadUrl(path: string, overwrite: boolean = true) {
    return this.request(
      `/resources/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite}`
    );
  }

  async getDownloadUrl(path: string) {
    return this.request(`/resources/download?path=${encodeURIComponent(path)}`);
  }

  async deleteResource(path: string, permanently: boolean = false) {
    return this.request(
      `/resources?path=${encodeURIComponent(path)}&permanently=${permanently}`,
      { method: "DELETE" }
    );
  }

  async copyResource(from: string, to: string, overwrite: boolean = true) {
    return this.request(
      `/resources/copy?from=${encodeURIComponent(from)}&path=${encodeURIComponent(to)}&overwrite=${overwrite}`,
      { method: "POST" }
    );
  }

  async moveResource(from: string, to: string, overwrite: boolean = true) {
    return this.request(
      `/resources/move?from=${encodeURIComponent(from)}&path=${encodeURIComponent(to)}&overwrite=${overwrite}`,
      { method: "POST" }
    );
  }

  async getLastUploaded(limit: number = 10) {
    return this.request(`/resources/last-uploaded?limit=${limit}`);
  }
}

const server = new Server(
  {
    name: "yandex-disk-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const token = process.env.YANDEX_DISK_TOKEN;
if (!token) {
  console.error("Error: YANDEX_DISK_TOKEN environment variable is required");
  process.exit(1);
}

const api = new YandexDiskAPI(token);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "yandex_disk_info",
        description: "Get information about Yandex.Disk (total space, used space, etc.)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "yandex_disk_list_files",
        description: "List all files on Yandex.Disk (flat list)",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of files to return (default: 20)",
              default: 20,
            },
            offset: {
              type: "number",
              description: "Offset for pagination (default: 0)",
              default: 0,
            },
          },
        },
      },
      {
        name: "yandex_disk_get_metadata",
        description: "Get metadata for a file or folder",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file or folder (e.g., '/Documents/file.txt')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_create_folder",
        description: "Create a new folder on Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path for the new folder (e.g., '/Documents/NewFolder')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_get_upload_url",
        description: "Get URL for uploading a file to Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path where to upload the file (e.g., '/Documents/file.txt')",
            },
            overwrite: {
              type: "boolean",
              description: "Whether to overwrite if file exists (default: true)",
              default: true,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_get_download_url",
        description: "Get URL for downloading a file from Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to download (e.g., '/Documents/file.txt')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_delete",
        description: "Delete a file or folder from Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file or folder to delete",
            },
            permanently: {
              type: "boolean",
              description: "Delete permanently (true) or move to trash (false, default)",
              default: false,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_copy",
        description: "Copy a file or folder on Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Source path",
            },
            to: {
              type: "string",
              description: "Destination path",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite if destination exists (default: true)",
              default: true,
            },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "yandex_disk_move",
        description: "Move or rename a file or folder on Yandex.Disk",
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Source path",
            },
            to: {
              type: "string",
              description: "Destination path",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite if destination exists (default: true)",
              default: true,
            },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "yandex_disk_last_uploaded",
        description: "Get list of recently uploaded files",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of files to return (default: 10)",
              default: 10,
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "yandex_disk_info": {
        const info = await api.getDiskInfo();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_list_files": {
        const limit = (args?.limit as number) || 20;
        const offset = (args?.offset as number) || 0;
        const files = await api.listFiles(limit, offset);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_get_metadata": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const metadata = await api.getMetadata(args.path as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_create_folder": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const result = await api.createFolder(args.path as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_get_upload_url": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const overwrite = args?.overwrite !== false;
        const result = await api.getUploadUrl(args.path as string, overwrite);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_get_download_url": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const result = await api.getDownloadUrl(args.path as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_delete": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const permanently = args?.permanently === true;
        const result = await api.deleteResource(
          args.path as string,
          permanently
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_copy": {
        if (!args?.from || !args?.to) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "from and to are required"
          );
        }
        const overwrite = args?.overwrite !== false;
        const result = await api.copyResource(
          args.from as string,
          args.to as string,
          overwrite
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_move": {
        if (!args?.from || !args?.to) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "from and to are required"
          );
        }
        const overwrite = args?.overwrite !== false;
        const result = await api.moveResource(
          args.from as string,
          args.to as string,
          overwrite
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_last_uploaded": {
        const limit = (args?.limit as number) || 10;
        const files = await api.getLastUploaded(limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Yandex.Disk MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
