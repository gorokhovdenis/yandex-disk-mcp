#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as nodePath from "node:path";

interface YandexDiskConfig {
  token: string;
  baseUrl: string;
}

class YandexDiskApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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
      throw new YandexDiskApiError(
        response.status,
        `Yandex.Disk API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    return response.json();
  }

  async getDiskInfo() {
    return this.request("/");
  }

  async getMetadata(path: string, limit?: number, offset?: number) {
    let query = `path=${encodeURIComponent(path)}`;
    if (limit !== undefined) query += `&limit=${limit}`;
    if (offset !== undefined) query += `&offset=${offset}`;
    return this.request(`/resources?${query}`);
  }

  // Compact folder listing: only the fields needed to walk a tree.
  async listDirectory(path: string, limit: number, offset: number) {
    const fields = [
      "_embedded.items.name",
      "_embedded.items.path",
      "_embedded.items.type",
      "_embedded.items.size",
      "_embedded.items.md5",
      "_embedded.total",
    ].join(",");
    return this.request(
      `/resources?path=${encodeURIComponent(path)}&limit=${limit}&offset=${offset}&fields=${fields}`
    );
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

// ---------- Folder comparison: local folder <-> Yandex.Disk folder ----------

const REMOTE_CONCURRENCY = 8;
const DEFAULT_IGNORE = [".DS_Store", "._*"];

interface FileEntry {
  size: number;
  md5?: string;
  absPath?: string;
}

interface TreeListing {
  files: Map<string, FileEntry>;
  dirs: number;
  errors: string[];
}

interface CompareOptions {
  checkMd5: boolean;
  ignore: string[];
  maxItems: number;
  outputFile?: string;
}

// macOS returns some names in NFD while Yandex.Disk stores NFC, so letters
// like "й" or "ё" differ byte-wise. All relative paths are compared in NFC.
const nfc = (s: string) => s.normalize("NFC");

function normalizeRemoteRoot(path: string): string {
  let p = path.replace(/^disk:/, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        !(error instanceof YandexDiskApiError) ||
        error.status === 429 ||
        error.status >= 500;
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}

async function walkRemote(
  api: YandexDiskAPI,
  root: string,
  ignore: RegExp[]
): Promise<TreeListing> {
  const files = new Map<string, FileEntry>();
  const pending: Array<{ path: string; rel: string }> = [{ path: root, rel: "" }];
  let dirs = 0;
  let inFlight = 0;

  const listAll = async (path: string) => {
    const items: any[] = [];
    for (let offset = 0; ; ) {
      const res = await withRetry(() => api.listDirectory(path, 1000, offset));
      const embedded = res._embedded;
      if (!embedded) throw new Error(`${path} is not a folder on Yandex.Disk`);
      items.push(...embedded.items);
      offset += embedded.items.length;
      if (embedded.items.length === 0 || offset >= embedded.total) return items;
    }
  };

  // Folders are listed in parallel, each one fully paginated.
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (pending.length === 0 && inFlight === 0) return resolve();
      while (inFlight < REMOTE_CONCURRENCY && pending.length > 0) {
        const dir = pending.pop()!;
        inFlight++;
        listAll(dir.path).then((items) => {
          dirs++;
          for (const item of items) {
            if (ignore.some((re) => re.test(item.name))) continue;
            const rel = dir.rel ? `${dir.rel}/${item.name}` : item.name;
            if (item.type === "dir") {
              pending.push({ path: item.path, rel });
            } else {
              files.set(nfc(rel), { size: item.size ?? 0, md5: item.md5 });
            }
          }
          inFlight--;
          pump();
        }, reject);
      }
    };
    pump();
  });

  return { files, dirs, errors: [] };
}

async function walkLocal(root: string, ignore: RegExp[]): Promise<TreeListing> {
  const files = new Map<string, FileEntry>();
  const errors: string[] = [];
  const stack = [""];
  let dirs = 0;

  while (stack.length > 0) {
    const rel = stack.pop()!;
    const dirPath = rel ? nodePath.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      errors.push(`${rel || "."}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    dirs++;

    const stats: Promise<void>[] = [];
    for (const entry of entries) {
      if (ignore.some((re) => re.test(entry.name))) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        const absPath = nodePath.join(root, childRel);
        stats.push(
          fs.stat(absPath).then(
            (st) => {
              files.set(nfc(childRel), { size: st.size, absPath });
            },
            (error) => {
              errors.push(`${childRel}: ${error.message}`);
            }
          )
        );
      }
    }
    await Promise.all(stats);
  }

  return { files, dirs, errors };
}

function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function groupByTopFolder(paths: string[], files: Map<string, FileEntry>) {
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const p of paths) {
    const slash = p.indexOf("/");
    const folder = slash === -1 ? "." : p.slice(0, slash);
    const group = groups.get(folder) ?? { files: 0, bytes: 0 };
    group.files++;
    group.bytes += files.get(p)?.size ?? 0;
    groups.set(folder, group);
  }
  return [...groups]
    .map(([folder, g]) => ({ folder, ...g }))
    .sort((a, b) => b.files - a.files);
}

async function compareFolders(
  api: YandexDiskAPI,
  remotePath: string,
  localPath: string,
  opts: CompareOptions
) {
  const remoteRoot = normalizeRemoteRoot(remotePath);
  const localRoot = nodePath.resolve(localPath);
  const rootStat = await fs.stat(localRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new McpError(ErrorCode.InvalidParams, `local_path is not a directory: ${localRoot}`);
  }

  const ignore = opts.ignore.map(globToRegExp);
  const [local, remote] = await Promise.all([
    walkLocal(localRoot, ignore),
    walkRemote(api, remoteRoot, ignore),
  ]);

  const onlyLocal: string[] = [];
  const onlyRemote: string[] = [];
  const sizeMismatch: string[] = [];
  const sameSize: string[] = [];
  for (const [path, l] of local.files) {
    const r = remote.files.get(path);
    if (!r) onlyLocal.push(path);
    else if (l.size !== r.size) sizeMismatch.push(path);
    else sameSize.push(path);
  }
  for (const path of remote.files.keys()) {
    if (!local.files.has(path)) onlyRemote.push(path);
  }

  // The same file whose name differs only by letter case on one side.
  const caseMismatch: Array<{ local: string; remote: string }> = [];
  const remoteByLower = new Map(onlyRemote.map((p) => [p.toLowerCase(), p]));
  const matchedRemote = new Set<string>();
  const onlyLocalFinal = onlyLocal.filter((p) => {
    const r = remoteByLower.get(p.toLowerCase());
    if (r === undefined || matchedRemote.has(r)) return true;
    matchedRemote.add(r);
    caseMismatch.push({ local: p, remote: r });
    return false;
  });
  const onlyRemoteFinal = onlyRemote.filter((p) => !matchedRemote.has(p));

  // Sequential on purpose: parallel reads only thrash a spinning disk.
  const md5Mismatch: string[] = [];
  let md5Checked = 0;
  if (opts.checkMd5) {
    for (const path of sameSize) {
      const remoteMd5 = remote.files.get(path)!.md5;
      if (!remoteMd5) continue;
      try {
        const localMd5 = await md5File(local.files.get(path)!.absPath!);
        md5Checked++;
        if (localMd5 !== remoteMd5) md5Mismatch.push(path);
      } catch (error) {
        local.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  onlyLocalFinal.sort(byPath);
  onlyRemoteFinal.sort(byPath);
  sizeMismatch.sort(byPath);
  md5Mismatch.sort(byPath);

  const totalBytes = (m: Map<string, FileEntry>) =>
    [...m.values()].reduce((sum, f) => sum + f.size, 0);

  const full = {
    remote_path: remoteRoot,
    local_path: localRoot,
    summary: {
      local_files: local.files.size,
      local_dirs: local.dirs,
      local_bytes: totalBytes(local.files),
      remote_files: remote.files.size,
      remote_dirs: remote.dirs,
      remote_bytes: totalBytes(remote.files),
      matching: sameSize.length - md5Mismatch.length,
      only_local: onlyLocalFinal.length,
      only_remote: onlyRemoteFinal.length,
      size_mismatch: sizeMismatch.length,
      md5_mismatch: md5Mismatch.length,
      case_mismatch: caseMismatch.length,
      md5_checked: opts.checkMd5 ? md5Checked : null,
    },
    only_local_by_folder: groupByTopFolder(onlyLocalFinal, local.files),
    only_remote_by_folder: groupByTopFolder(onlyRemoteFinal, remote.files),
    only_local: onlyLocalFinal.map((path) => ({ path, size: local.files.get(path)!.size })),
    only_remote: onlyRemoteFinal.map((path) => ({ path, size: remote.files.get(path)!.size })),
    size_mismatch: sizeMismatch.map((path) => ({
      path,
      local_size: local.files.get(path)!.size,
      remote_size: remote.files.get(path)!.size,
    })),
    md5_mismatch: md5Mismatch,
    case_mismatch: caseMismatch,
    local_errors: local.errors,
  };

  if (opts.outputFile) {
    await fs.writeFile(opts.outputFile, JSON.stringify(full, null, 2));
  }

  // The response itself is capped so a big diff does not flood the context.
  const truncated: Record<string, number> = {};
  const cap = <T>(name: string, list: T[]): T[] => {
    if (list.length <= opts.maxItems) return list;
    truncated[name] = list.length;
    return list.slice(0, opts.maxItems);
  };

  return {
    ...full,
    only_local_by_folder: cap("only_local_by_folder", full.only_local_by_folder),
    only_remote_by_folder: cap("only_remote_by_folder", full.only_remote_by_folder),
    only_local: cap("only_local", full.only_local),
    only_remote: cap("only_remote", full.only_remote),
    size_mismatch: cap("size_mismatch", full.size_mismatch),
    md5_mismatch: cap("md5_mismatch", full.md5_mismatch),
    case_mismatch: cap("case_mismatch", full.case_mismatch),
    local_errors: cap("local_errors", full.local_errors),
    truncated: Object.keys(truncated).length > 0 ? truncated : null,
    report_file: opts.outputFile ?? null,
  };
}

const server = new Server(
  {
    name: "yandex-disk-mcp",
    version: "0.2.0",
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
        description:
          "Get metadata for a file or folder. For a folder, _embedded.items holds one page of its contents and _embedded.total the full count; use limit/offset to page through it",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file or folder (e.g., '/Documents/file.txt')",
            },
            limit: {
              type: "number",
              description: "Folder items per page (default: 20)",
              default: 20,
            },
            offset: {
              type: "number",
              description: "Offset in the folder listing (default: 0)",
              default: 0,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "yandex_disk_compare",
        description:
          "Recursively compare a local folder with a folder on Yandex.Disk. Files are matched by relative path (Unicode-normalized) and size, optionally by MD5. Returns totals, differences grouped by top-level folder and capped lists of differing files; the full report can be saved to a local JSON file",
        inputSchema: {
          type: "object",
          properties: {
            remote_path: {
              type: "string",
              description: "Folder on Yandex.Disk (e.g., '/Backups/Photos')",
            },
            local_path: {
              type: "string",
              description: "Absolute path to the local folder (e.g., '/Volumes/USB/Photos')",
            },
            check_md5: {
              type: "boolean",
              description:
                "Also compare MD5 of files with equal size. Reads every such local file, slow for large folders (default: false)",
              default: false,
            },
            ignore: {
              type: "array",
              items: { type: "string" },
              description:
                "File/folder name globs skipped on both sides (default: ['.DS_Store', '._*'])",
            },
            max_items: {
              type: "number",
              description: "Max entries per list in the response (default: 100)",
              default: 100,
            },
            output_file: {
              type: "string",
              description: "Optional local path to write the full, untruncated JSON report",
            },
          },
          required: ["remote_path", "local_path"],
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
        const metadata = await api.getMetadata(
          args.path as string,
          args.limit as number | undefined,
          args.offset as number | undefined
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      case "yandex_disk_compare": {
        if (!args?.remote_path || !args?.local_path) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "remote_path and local_path are required"
          );
        }
        const report = await compareFolders(
          api,
          args.remote_path as string,
          args.local_path as string,
          {
            checkMd5: args.check_md5 === true,
            ignore: Array.isArray(args.ignore) ? (args.ignore as string[]) : DEFAULT_IGNORE,
            maxItems: (args.max_items as number) || 100,
            outputFile: args.output_file as string | undefined,
          }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
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
