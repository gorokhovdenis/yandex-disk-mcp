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
import * as http from "node:http";
import * as https from "node:https";
import * as nodePath from "node:path";
import { pipeline, Transform } from "node:stream";
import * as tls from "node:tls";

interface YandexDiskConfig {
  token: string;
  baseUrl: string;
}

class YandexDiskApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
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
      let code: string | undefined;
      try {
        code = JSON.parse(error).error;
      } catch {}
      throw new YandexDiskApiError(
        response.status,
        `Yandex.Disk API error: ${response.status} ${response.statusText} - ${error}`,
        code
      );
    }

    // DELETE answers 204 with an empty body.
    const text = await response.text();
    return text ? JSON.parse(text) : {};
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

  // Move and, if the API made it asynchronous (202), wait for the operation.
  async moveAndWait(from: string, to: string, overwrite: boolean) {
    const link = await this.moveResource(from, to, overwrite);
    if (typeof link?.href !== "string" || !link.href.includes("/operations/")) return;
    const op = new URL(link.href);
    const opPath = op.pathname.replace(/^\/v1\/disk/, "") + op.search;
    for (let i = 0; i < 120; i++) {
      const { status } = await this.request(opPath);
      if (status === "success") return;
      if (status === "failed") throw new Error(`move ${from} -> ${to} failed`);
      await sleep(1000);
    }
    throw new Error(`move ${from} -> ${to} did not finish in 2 minutes`);
  }

  async statFile(path: string): Promise<{ size: number; md5?: string }> {
    return this.request(`/resources?path=${encodeURIComponent(path)}&fields=size,md5`);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries network errors, 429 and 5xx; `alsoRetry` adds statuses worth waiting
// out, e.g. 404 for a file that was just uploaded and is not visible yet.
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  alsoRetry: number[] = []
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        !(error instanceof YandexDiskApiError) ||
        error.status === 429 ||
        error.status >= 500 ||
        alsoRetry.includes(error.status);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

async function listAllItems(api: YandexDiskAPI, path: string): Promise<any[]> {
  const items: any[] = [];
  for (let offset = 0; ; ) {
    const res = await withRetry(() => api.listDirectory(path, 1000, offset));
    const embedded = res._embedded;
    if (!embedded) throw new Error(`${path} is not a folder on Yandex.Disk`);
    items.push(...embedded.items);
    offset += embedded.items.length;
    if (embedded.items.length === 0 || offset >= embedded.total) return items;
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

  // Folders are listed in parallel, each one fully paginated.
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (pending.length === 0 && inFlight === 0) return resolve();
      while (inFlight < REMOTE_CONCURRENCY && pending.length > 0) {
        const dir = pending.pop()!;
        inFlight++;
        listAllItems(api, dir.path).then((items) => {
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

// ---------- Upload: local files -> Yandex.Disk folder, as a background job ----------

// Yandex.Disk throttles API uploads of video to ~130 KB/s, judging by the
// extension of the target path (seen with .mp4). Uploading under a temporary
// ".part" name and renaming afterwards runs at full speed; the renamed file
// keeps its MD5 and is still recognized as a video.
const UPLOAD_TEMP_SUFFIX = ".part";
const DEFAULT_BYPASS_EXTENSIONS = [
  "mp4", "mov", "m4v", "avi", "mkv", "3gp", "wmv", "webm", "mts", "m2ts", "mpg", "mpeg", "flv",
];
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_IDLE_TIMEOUT_MS = 120_000;
// A freshly uploaded file can take a few seconds to show up for move/stat.
const SETTLE_STATUSES = [404, 423];

type UploadMode = "direct" | "part" | "resume";
type ItemStatus = "pending" | "uploading" | "done" | "skipped" | "failed" | "cancelled";

interface UploadItem {
  rel: string;
  absPath: string;
  size: number;
  remote: string;
  mode: UploadMode;
  status: ItemStatus;
  sent: number;
  phase?: "hashing" | "sending" | "renaming" | "verifying";
  partMd5?: string;
  note?: string;
  error?: string;
}

interface UploadOptions {
  overwrite: boolean;
  include?: string[];
  ignore: string[];
  bypassExtensions: string[];
  concurrency: number;
  proxy?: URL;
  logFile?: string;
}

interface UploadJob {
  id: string;
  localPath: string;
  remotePath: string;
  items: UploadItem[];
  notFound: string[];
  localErrors: string[];
  state: "running" | "done" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  transferred: number;
  abort: AbortController;
  finished: Promise<void>;
  logFile?: string;
  logChain: Promise<void>;
}

const uploadJobs = new Map<string, UploadJob>();
let uploadJobCounter = 0;

const joinRemote = (dir: string, rel: string) => (dir === "/" ? `/${rel}` : `${dir}/${rel}`);
const remoteParent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const remoteName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extOf = (name: string) => nodePath.extname(name).slice(1).toLowerCase();

function parseProxy(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (url.protocol !== "http:") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unsupported proxy ${raw}: only http:// proxies (HTTP CONNECT) are supported`
    );
  }
  return url;
}

// TLS connection to host:port through an HTTP CONNECT proxy.
function openTunnel(proxy: URL, host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (proxy.username) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`proxy ${proxy.host} did not answer CONNECT`)));
    req.once("error", reject);
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy ${proxy.host} refused CONNECT: HTTP ${res.statusCode}`));
      }
      const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
      secure.once("error", reject);
    });
    req.end();
  });
}

// Streams a local file to an upload URL; returns the HTTP status and the MD5
// of the bytes sent.
async function putFile(
  href: string,
  absPath: string,
  size: number,
  proxy: URL | undefined,
  onBytes: (n: number) => void,
  signal: AbortSignal
): Promise<{ status: number; body: string; md5: string }> {
  const url = new URL(href);
  const tunnel = proxy ? await openTunnel(proxy, url.hostname, Number(url.port) || 443) : undefined;
  const hash = createHash("md5");

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "PUT",
      headers: { "Content-Length": size },
      signal,
      ...(tunnel ? { createConnection: () => tunnel } : {}),
    });
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => req.destroy(new Error("upload stalled")));
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 2000) body += chunk;
      });
      res.on("error", reject);
      res.on("end", () => {
        tunnel?.destroy();
        resolve({ status: res.statusCode ?? 0, body, md5: hash.digest("hex") });
      });
    });

    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        onBytes(chunk.length);
        callback(null, chunk);
      },
    });
    pipeline(createReadStream(absPath), counter, req, (error) => {
      if (error) {
        req.destroy(error);
        reject(error);
      }
    });
  });
}

// Files of a remote folder by NFC name, or null if the folder does not exist.
async function listFolderFiles(
  api: YandexDiskAPI,
  path: string
): Promise<Map<string, FileEntry> | null> {
  let items;
  try {
    items = await listAllItems(api, path);
  } catch (error) {
    if (error instanceof YandexDiskApiError && error.status === 404) return null;
    throw error;
  }
  return new Map(
    items
      .filter((item) => item.type === "file")
      .map((item) => [nfc(item.name), { size: item.size ?? 0, md5: item.md5 }])
  );
}

// mkdir -p on Yandex.Disk.
async function ensureFolder(api: YandexDiskAPI, path: string, parentsDone = false): Promise<void> {
  if (path === "/") return;
  try {
    await withRetry(() => api.createFolder(path));
  } catch (error) {
    if (!(error instanceof YandexDiskApiError) || error.status !== 409) throw error;
    if (error.code === "DiskPathPointsToExistentDirectoryError") return;
    if (error.code !== "DiskPathDoesntExistsError" || parentsDone) throw error;
    await ensureFolder(api, remoteParent(path));
    await ensureFolder(api, path, true);
  }
}

async function planUpload(
  api: YandexDiskAPI,
  localPath: string,
  remotePath: string,
  opts: UploadOptions
): Promise<UploadJob> {
  const remoteRoot = normalizeRemoteRoot(remotePath);
  const localRoot = nodePath.resolve(localPath);
  const rootStat = await fs.stat(localRoot).catch(() => null);
  if (!rootStat) {
    throw new McpError(ErrorCode.InvalidParams, `local_path does not exist: ${localRoot}`);
  }

  let local: Map<string, FileEntry>;
  let localErrors: string[] = [];
  const notFound: string[] = [];
  if (rootStat.isDirectory()) {
    const listing = await walkLocal(localRoot, opts.ignore.map(globToRegExp));
    local = listing.files;
    localErrors = listing.errors;
    if (opts.include) {
      const wanted = new Set(
        opts.include.map((p) => nfc(nodePath.isAbsolute(p) ? nodePath.relative(localRoot, p) : p))
      );
      for (const rel of wanted) if (!local.has(rel)) notFound.push(rel);
      local = new Map([...local].filter(([rel]) => wanted.has(rel)));
    }
  } else {
    local = new Map([[nfc(nodePath.basename(localRoot)), { size: rootStat.size, absPath: localRoot }]]);
  }

  const items: UploadItem[] = [...local]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, f]) => ({
      rel,
      absPath: f.absPath!,
      size: f.size,
      remote: joinRemote(remoteRoot, rel),
      mode: "direct",
      status: "pending",
      sent: 0,
    }));

  // Only the destination folders are listed, not the whole remote tree.
  const dirs = [...new Set(items.map((i) => remoteParent(i.remote)))];
  const existing = new Map<string, Map<string, FileEntry> | null>();
  for (let i = 0; i < dirs.length; i += REMOTE_CONCURRENCY) {
    await Promise.all(
      dirs.slice(i, i + REMOTE_CONCURRENCY).map(async (dir) => {
        existing.set(dir, await listFolderFiles(api, dir));
      })
    );
  }
  for (const dir of dirs.filter((d) => existing.get(d) === null).sort((a, b) => a.length - b.length)) {
    await ensureFolder(api, dir);
  }

  for (const item of items) {
    const files = existing.get(remoteParent(item.remote)) ?? new Map<string, FileEntry>();
    const name = remoteName(item.remote);
    const current = files.get(name);
    const part = files.get(name + UPLOAD_TEMP_SUFFIX);
    const bypass = opts.bypassExtensions.includes(extOf(name));
    if (current && !opts.overwrite) {
      if (current.size === item.size) {
        item.status = "skipped";
        item.note = "already on Yandex.Disk with the same size";
      } else {
        item.status = "failed";
        item.error = `already on Yandex.Disk with a different size (${current.size} bytes); pass overwrite=true to replace it`;
      }
    } else if (bypass && part?.size === item.size) {
      item.mode = "resume";
      item.partMd5 = part.md5;
    } else {
      item.mode = bypass ? "part" : "direct";
    }
  }

  return {
    id: `upload-${++uploadJobCounter}`,
    localPath: localRoot,
    remotePath: remoteRoot,
    items,
    notFound,
    localErrors,
    state: "running",
    startedAt: Date.now(),
    transferred: 0,
    abort: new AbortController(),
    finished: Promise.resolve(),
    logFile: opts.logFile,
    logChain: Promise.resolve(),
  };
}

async function uploadWithRetry(
  api: YandexDiskAPI,
  job: UploadJob,
  item: UploadItem,
  target: string,
  overwrite: boolean,
  proxy: URL | undefined
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    item.sent = 0;
    item.phase = "sending";
    try {
      // Upload URLs expire, so every attempt asks for a fresh one.
      const { href } = await withRetry(() => api.getUploadUrl(target, overwrite));
      const res = await putFile(
        href,
        item.absPath,
        item.size,
        proxy,
        (n) => {
          item.sent += n;
          job.transferred += n;
        },
        job.abort.signal
      );
      if (res.status === 201 || res.status === 202) return res.md5;
      throw new YandexDiskApiError(res.status, `upload failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
    } catch (error) {
      const permanent =
        error instanceof YandexDiskApiError && error.status < 500 && error.status !== 429;
      if (job.abort.signal.aborted || permanent || attempt >= UPLOAD_ATTEMPTS) throw error;
      await sleep(2000 * attempt);
    }
  }
}

async function uploadItem(api: YandexDiskAPI, job: UploadJob, item: UploadItem, opts: UploadOptions) {
  const temp = item.remote + UPLOAD_TEMP_SUFFIX;
  let md5: string | undefined;
  if (item.mode === "resume") {
    item.phase = "hashing";
    md5 = await md5File(item.absPath);
    if (item.partMd5 && item.partMd5 !== md5) item.mode = "part";
  }
  if (item.mode !== "resume") {
    const target = item.mode === "part" ? temp : item.remote;
    md5 = await uploadWithRetry(api, job, item, target, item.mode === "part" || opts.overwrite, opts.proxy);
  }
  if (item.mode !== "direct") {
    item.phase = "renaming";
    await withRetry(() => api.moveAndWait(temp, item.remote, opts.overwrite), 7, SETTLE_STATUSES);
  }

  item.phase = "verifying";
  const stat = await withRetry(() => api.statFile(item.remote), 7, SETTLE_STATUSES);
  if (stat.size !== item.size) {
    throw new Error(`size on Yandex.Disk is ${stat.size}, local file has ${item.size}`);
  }
  if (stat.md5 && stat.md5 !== md5) {
    throw new Error(`MD5 on Yandex.Disk ${stat.md5} differs from local ${md5}`);
  }
  item.note = stat.md5 ? "MD5 verified" : "size verified, MD5 not yet available";
}

// Appends are chained so lines land in the order they were logged.
function logUpload(job: UploadJob, line: string) {
  if (!job.logFile) return;
  const text = `${new Date().toISOString()} ${line}\n`;
  job.logChain = job.logChain.then(() => fs.appendFile(job.logFile!, text)).catch(() => {});
}

async function runUpload(api: YandexDiskAPI, job: UploadJob, opts: UploadOptions) {
  const queue = job.items.filter((i) => i.status === "pending");
  logUpload(job, `JOB  ${job.id} ${job.localPath} -> ${job.remotePath}: ${queue.length} to upload`);
  for (const item of job.items) {
    if (item.status === "skipped") logUpload(job, `SKIP ${item.rel} (${item.note})`);
    if (item.status === "failed") logUpload(job, `FAIL ${item.rel} ${item.error}`);
  }

  const worker = async () => {
    for (let item = queue.shift(); item && !job.abort.signal.aborted; item = queue.shift()) {
      const started = Date.now();
      item.status = "uploading";
      try {
        await uploadItem(api, job, item, opts);
        item.status = "done";
        const seconds = (Date.now() - started) / 1000;
        const speed = item.mode === "resume" ? "" : ` ${(item.size / seconds / 1e6).toFixed(1)}MB/s`;
        logUpload(job, `OK   ${item.rel} ${item.size} ${seconds.toFixed(1)}s${speed} ${item.mode}, ${item.note}`);
      } catch (error) {
        if (job.abort.signal.aborted) {
          item.status = "cancelled";
        } else {
          item.status = "failed";
          item.error = error instanceof Error ? error.message : String(error);
          logUpload(job, `FAIL ${item.rel} ${item.error}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  for (const item of job.items) if (item.status === "pending") item.status = "cancelled";
  job.state = job.abort.signal.aborted ? "cancelled" : "done";
  job.finishedAt = Date.now();
  const failed = job.items.filter((i) => i.status === "failed").length;
  logUpload(job, `JOB  ${job.id} ${job.state}, failed: ${failed}`);
  await job.logChain;
}

function uploadStatus(job: UploadJob, maxItems: number) {
  const by = (s: ItemStatus) => job.items.filter((i) => i.status === s);
  const left = job.items.filter((i) => i.status === "pending" || i.status === "uploading");
  const bytesLeft = left.reduce((sum, i) => sum + (i.mode === "resume" ? 0 : i.size - i.sent), 0);
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const speed = elapsed > 0 ? job.transferred / elapsed : 0;
  const cap = <T>(list: T[]) => list.slice(0, maxItems);
  return {
    job_id: job.id,
    state: job.state,
    local_path: job.localPath,
    remote_path: job.remotePath,
    started_at: new Date(job.startedAt).toISOString(),
    finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    elapsed_seconds: Math.round(elapsed),
    files: {
      total: job.items.length,
      done: by("done").length,
      skipped: by("skipped").length,
      failed: by("failed").length,
      cancelled: by("cancelled").length,
      pending: by("pending").length,
      uploading: by("uploading").length,
    },
    bytes: {
      total: job.items.reduce((sum, i) => sum + i.size, 0),
      transferred: job.transferred,
      left: bytesLeft,
    },
    speed_bytes_per_second: Math.round(speed),
    eta_seconds: job.state === "running" && speed > 0 ? Math.round(bytesLeft / speed) : null,
    // "sent" counts bytes handed to the socket; a proxy may buffer them, so a
    // file can sit at sent == size while the server is still receiving it.
    uploading: by("uploading").map((i) => ({
      path: i.rel,
      mode: i.mode,
      phase: i.phase === "sending" && i.sent >= i.size ? "waiting for server" : i.phase,
      sent: i.sent,
      size: i.size,
    })),
    failed: cap(by("failed").map((i) => ({ path: i.rel, error: i.error }))),
    not_found: cap(job.notFound),
    local_errors: cap(job.localErrors),
    log_file: job.logFile ?? null,
  };
}

async function waitForJob(job: UploadJob, seconds: number) {
  if (seconds > 0) await Promise.race([job.finished, sleep(seconds * 1000)]);
}

const server = new Server(
  {
    name: "yandex-disk-mcp",
    version: "0.3.0",
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
        name: "yandex_disk_upload",
        description:
          "Upload a local file or folder (recursively, keeping its structure) into a Yandex.Disk folder. Runs as a background job: returns a job_id and progress after wait_seconds; poll it with yandex_disk_upload_status. Files already on the disk with the same size are skipped, missing folders are created, every upload is verified by MD5. Video is uploaded under a temporary '.part' name and renamed afterwards, because Yandex.Disk throttles API uploads of video to ~130 KB/s; a leftover '.part' of the same size is just renamed. The job lives in the MCP server process and stops if the server exits",
        inputSchema: {
          type: "object",
          properties: {
            local_path: {
              type: "string",
              description: "Absolute path to a local file or folder",
            },
            remote_path: {
              type: "string",
              description:
                "Destination folder on Yandex.Disk (e.g., '/Photo/2017'); created if missing",
            },
            include: {
              type: "array",
              items: { type: "string" },
              description:
                "Upload only these files: paths relative to local_path (as in yandex_disk_compare's only_local) or absolute",
            },
            overwrite: {
              type: "boolean",
              description:
                "Replace files that already exist on Yandex.Disk. When false, an existing file of the same size is skipped and one of a different size is reported as failed (default: false)",
              default: false,
            },
            ignore: {
              type: "array",
              items: { type: "string" },
              description:
                "File/folder name globs skipped when walking a folder (default: ['.DS_Store', '._*'])",
            },
            bypass_extensions: {
              type: "array",
              items: { type: "string" },
              description:
                "Extensions uploaded via a temporary '.part' name (default: common video formats; [] disables)",
            },
            concurrency: {
              type: "number",
              description: "Files uploaded in parallel, 1-4 (default: 1)",
              default: 1,
            },
            proxy: {
              type: "string",
              description:
                "HTTP proxy for the upload traffic (e.g., 'http://127.0.0.1:8078'); API calls go direct. Default: YANDEX_DISK_UPLOAD_PROXY env var; '' disables",
            },
            log_file: {
              type: "string",
              description: "Optional local file to append one line per file (OK/SKIP/FAIL) to",
            },
            wait_seconds: {
              type: "number",
              description:
                "Wait up to this many seconds for the job to finish before returning, 0-900 (default: 30)",
              default: 30,
            },
          },
          required: ["local_path", "remote_path"],
        },
      },
      {
        name: "yandex_disk_upload_status",
        description:
          "Progress of an upload job started by yandex_disk_upload: file counts, bytes, speed, ETA, files in flight and failures. Without job_id lists all jobs of this server process",
        inputSchema: {
          type: "object",
          properties: {
            job_id: {
              type: "string",
              description: "Job id returned by yandex_disk_upload",
            },
            wait_seconds: {
              type: "number",
              description:
                "Wait up to this many seconds for the job to finish before returning, 0-900 (default: 0)",
              default: 0,
            },
            max_items: {
              type: "number",
              description: "Max entries per list in the response (default: 50)",
              default: 50,
            },
          },
        },
      },
      {
        name: "yandex_disk_upload_cancel",
        description:
          "Cancel an upload job. Files in flight are aborted (an incomplete upload leaves nothing on the disk); finished files stay",
        inputSchema: {
          type: "object",
          properties: {
            job_id: {
              type: "string",
              description: "Job id returned by yandex_disk_upload",
            },
          },
          required: ["job_id"],
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

      case "yandex_disk_upload": {
        if (!args?.local_path || !args?.remote_path) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "local_path and remote_path are required"
          );
        }
        const opts: UploadOptions = {
          overwrite: args.overwrite === true,
          include: Array.isArray(args.include) ? (args.include as string[]) : undefined,
          ignore: Array.isArray(args.ignore) ? (args.ignore as string[]) : DEFAULT_IGNORE,
          bypassExtensions: (Array.isArray(args.bypass_extensions)
            ? (args.bypass_extensions as string[])
            : DEFAULT_BYPASS_EXTENSIONS
          ).map((e) => e.replace(/^\./, "").toLowerCase()),
          concurrency: Math.min(4, Math.max(1, Math.floor(Number(args.concurrency) || 1))),
          proxy: parseProxy(
            args.proxy !== undefined ? (args.proxy as string) : process.env.YANDEX_DISK_UPLOAD_PROXY
          ),
          logFile: args.log_file as string | undefined,
        };
        const job = await planUpload(api, args.local_path as string, args.remote_path as string, opts);
        uploadJobs.set(job.id, job);
        job.finished = runUpload(api, job, opts).catch((error) => {
          job.state = "done";
          job.finishedAt = Date.now();
          job.localErrors.push(`job crashed: ${error instanceof Error ? error.message : String(error)}`);
        });
        const wait = args.wait_seconds !== undefined ? Number(args.wait_seconds) : 30;
        await waitForJob(job, Math.min(900, Math.max(0, wait || 0)));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(uploadStatus(job, 50), null, 2),
            },
          ],
        };
      }

      case "yandex_disk_upload_status": {
        const maxItems = (args?.max_items as number) || 50;
        if (!args?.job_id) {
          const jobs = [...uploadJobs.values()].map((job) => {
            const { job_id, state, local_path, remote_path, started_at, files } = uploadStatus(job, 0);
            return { job_id, state, local_path, remote_path, started_at, files };
          });
          return {
            content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }],
          };
        }
        const job = uploadJobs.get(args.job_id as string);
        if (!job) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown upload job: ${args.job_id}`);
        }
        await waitForJob(job, Math.min(900, Math.max(0, Number(args.wait_seconds) || 0)));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(uploadStatus(job, maxItems), null, 2),
            },
          ],
        };
      }

      case "yandex_disk_upload_cancel": {
        const job = args?.job_id ? uploadJobs.get(args.job_id as string) : undefined;
        if (!job) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown upload job: ${args?.job_id}`);
        }
        job.abort.abort();
        await waitForJob(job, 15);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(uploadStatus(job, 50), null, 2),
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
