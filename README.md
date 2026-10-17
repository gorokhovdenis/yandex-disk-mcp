# Yandex.Disk MCP Server

**English** | [Русский](README.ru.md)

MCP Server for Yandex.Disk REST API integration with Claude and other MCP clients.

## Features

This MCP server provides tools to interact with Yandex.Disk:

- 📊 Get disk information (total/used space)
- 📁 List files and folders
- 📄 Get file/folder metadata (with pagination for large folders)
- 🔍 Compare a local folder with a Yandex.Disk folder (recursive, by size and optionally MD5)
- ➕ Create folders
- ⬆️ Upload files and folders as a background job (resumable, MD5-verified, fast for video)
- 🔗 Get an upload URL for your own uploader
- ⬇️ Download files (get download URL)
- 🗑️ Delete files/folders
- 📋 Copy files/folders
- 🔄 Move/rename files/folders
- 🕐 Get recently uploaded files

## Prerequisites

- Node.js 18 or higher
- Yandex.Disk OAuth token

## Getting OAuth Token

1. Go to [Yandex OAuth](https://oauth.yandex.ru/client/new)
2. Create a new OAuth application
3. Select required permissions:
   - `cloud_api:disk.read` - read files
   - `cloud_api:disk.write` - write files
   - `cloud_api:disk.info` - disk information
4. Get your Client ID
5. Open this URL in browser (replace `<CLIENT_ID>` with your actual Client ID):
   ```
   https://oauth.yandex.ru/authorize?response_type=token&client_id=<CLIENT_ID>
   ```
6. Copy the token from the authorization page
7. Save the token securely

## Installation

### Option 1: Install from npm (recommended)

```bash
npm install -g yandex-disk-mcp
```

### Option 2: Install from GitHub

```bash
git clone https://github.com/gorokhovdenis/yandex-disk-mcp.git
cd yandex-disk-mcp
npm install
npm run build
```

## Configuration

Add to your Claude Code configuration file (`~/.claude.json`):

```json
{
  "mcpServers": {
    "yandex-disk": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/yandex-disk-mcp/dist/index.js"],
      "env": {
        "YANDEX_DISK_TOKEN": "your_oauth_token_here"
      }
    }
  }
}
```

**Note:** Replace `/path/to/yandex-disk-mcp` with the actual path where you cloned the repository.

Optional: set `YANDEX_DISK_UPLOAD_PROXY` (e.g. `http://127.0.0.1:8078`) in `env` to send upload traffic of `yandex_disk_upload` through an HTTP proxy. API calls always go direct.

## Available Tools

### yandex_disk_info
Get information about your Yandex.Disk (total space, used space, etc.)

**Parameters:** None

**Example:**
```
Claude, get my Yandex.Disk info
```

### yandex_disk_list_files
List all files on Yandex.Disk (flat list)

**Parameters:**
- `limit` (number, optional): Maximum number of files to return (default: 20)
- `offset` (number, optional): Offset for pagination (default: 0)

**Example:**
```
Claude, list 50 files from my Yandex.Disk
```

### yandex_disk_get_metadata
Get metadata for a specific file or folder. For a folder, `_embedded.items` holds one page of its contents and `_embedded.total` the full count.

**Parameters:**
- `path` (string, required): Path to the file or folder (e.g., '/Documents/file.txt')
- `limit` (number, optional): Folder items per page (default: 20)
- `offset` (number, optional): Offset in the folder listing (default: 0)

**Example:**
```
Claude, get metadata for /Documents/report.pdf on Yandex.Disk
```

### yandex_disk_compare
Recursively compare a local folder with a folder on Yandex.Disk — e.g. to check that a backup on an external drive matches the cloud copy.

Files are matched by relative path and size, optionally by MD5. Paths are Unicode-normalized (NFC), so names with letters like «й»/«ё» coming from macOS still match. Remote folders are listed in parallel with retries on 429/5xx.

**Parameters:**
- `remote_path` (string, required): Folder on Yandex.Disk (e.g., '/Backups/Photos')
- `local_path` (string, required): Absolute path to the local folder (e.g., '/Volumes/USB/Photos')
- `check_md5` (boolean, optional): Also compare MD5 of files with equal size. Reads every such local file, so it is slow for large folders (default: false)
- `ignore` (string[], optional): File/folder name globs skipped on both sides (default: `['.DS_Store', '._*']`)
- `max_items` (number, optional): Max entries per list in the response (default: 100)
- `output_file` (string, optional): Local path to write the full, untruncated JSON report

**Returns:** totals for both sides, counts of `matching` / `only_local` / `only_remote` / `size_mismatch` / `md5_mismatch` / `case_mismatch` (same name differing only by letter case), differences grouped by top-level folder, and the lists themselves (capped by `max_items`, see `truncated`).

**Example:**
```
Claude, compare /Volumes/USB/Photos with /Photos on Yandex.Disk
```

### yandex_disk_create_folder
Create a new folder

**Parameters:**
- `path` (string, required): Path for the new folder (e.g., '/Documents/NewFolder')

**Example:**
```
Claude, create folder /Backups/2026 on Yandex.Disk
```

### yandex_disk_upload
Upload a local file or a whole folder (recursively, keeping its structure) into a folder on Yandex.Disk.

The upload runs as a background job inside the MCP server, so multi-gigabyte uploads don't hit tool-call timeouts: the tool waits `wait_seconds`, then returns a `job_id` with progress. Poll it with `yandex_disk_upload_status`.

- Files that already exist on the disk with the same size are skipped, so re-running the same upload resumes it.
- Missing destination folders are created.
- Every uploaded file is verified against the local MD5.
- **Video is uploaded under a temporary `.part` name and renamed afterwards.** Yandex.Disk throttles API uploads of video files to ~130 KB/s, judging by the extension of the target path; the same bytes under another name go at full speed. The renamed file keeps its MD5 and is recognized as a video, with its EXIF date. A leftover `.part` of the same size from an interrupted run is just renamed.
- The job lives in the server process: if the MCP client restarts the server, the job stops. Re-run the same call to continue.

**Parameters:**
- `local_path` (string, required): Absolute path to a local file or folder
- `remote_path` (string, required): Destination folder on Yandex.Disk (e.g., '/Photo/2017'); created if missing
- `include` (string[], optional): Upload only these files — paths relative to `local_path` (as in `yandex_disk_compare`'s `only_local`) or absolute
- `overwrite` (boolean, optional): Replace existing files. When false, an existing file of the same size is skipped and one of a different size is reported as failed (default: false)
- `ignore` (string[], optional): File/folder name globs skipped when walking a folder (default: `['.DS_Store', '._*']`)
- `bypass_extensions` (string[], optional): Extensions uploaded via a temporary `.part` name (default: common video formats — mp4, mov, m4v, avi, mkv, 3gp, wmv, webm, mts, m2ts, mpg, mpeg, flv; `[]` disables)
- `concurrency` (number, optional): Files uploaded in parallel, 1–4 (default: 1)
- `proxy` (string, optional): HTTP proxy for the upload traffic (e.g., 'http://127.0.0.1:8078'). Default: `YANDEX_DISK_UPLOAD_PROXY`; `''` disables
- `log_file` (string, optional): Local file to append one line per file to (`OK` / `SKIP` / `FAIL`) — handy for `tail -f`
- `wait_seconds` (number, optional): Wait up to this long for the job to finish before returning, 0–900 (default: 30)

**Returns:** job status (see below).

**Example:**
```
Claude, upload /Volumes/USB/DCIM/Camera to /Photo/2017 on Yandex.Disk
```

### yandex_disk_upload_status
Progress of an upload job: file counts (`done` / `skipped` / `failed` / `pending` / ...), bytes, average speed, ETA, files in flight and the errors of failed ones. Without `job_id` it lists all jobs of the server process.

**Parameters:**
- `job_id` (string, optional): Job id returned by `yandex_disk_upload`
- `wait_seconds` (number, optional): Wait up to this long for the job to finish before returning, 0–900 (default: 0)
- `max_items` (number, optional): Max entries per list in the response (default: 50)

### yandex_disk_upload_cancel
Cancel an upload job. Files in flight are aborted — an incomplete upload leaves nothing on the disk; finished files stay.

**Parameters:**
- `job_id` (string, required): Job id returned by `yandex_disk_upload`

### yandex_disk_get_upload_url
Get URL for uploading a file with your own client (curl, etc.). For most cases `yandex_disk_upload` is simpler

**Parameters:**
- `path` (string, required): Path where to upload the file
- `overwrite` (boolean, optional): Whether to overwrite if file exists (default: true)

**Example:**
```
Claude, get upload URL for /Documents/report.pdf on Yandex.Disk
```

### yandex_disk_get_download_url
Get URL for downloading a file

**Parameters:**
- `path` (string, required): Path to the file to download

**Example:**
```
Claude, get download URL for /Documents/report.pdf from Yandex.Disk
```

### yandex_disk_delete
Delete a file or folder

**Parameters:**
- `path` (string, required): Path to the file or folder to delete
- `permanently` (boolean, optional): Delete permanently (true) or move to trash (false, default)

**Example:**
```
Claude, delete /temp/old_file.txt from Yandex.Disk
```

### yandex_disk_copy
Copy a file or folder

**Parameters:**
- `from` (string, required): Source path
- `to` (string, required): Destination path
- `overwrite` (boolean, optional): Overwrite if destination exists (default: true)

**Example:**
```
Claude, copy /Documents/file.txt to /Backups/file.txt on Yandex.Disk
```

### yandex_disk_move
Move or rename a file or folder

**Parameters:**
- `from` (string, required): Source path
- `to` (string, required): Destination path
- `overwrite` (boolean, optional): Overwrite if destination exists (default: true)

**Example:**
```
Claude, move /temp/file.txt to /Documents/file.txt on Yandex.Disk
```

### yandex_disk_last_uploaded
Get list of recently uploaded files

**Parameters:**
- `limit` (number, optional): Maximum number of files to return (default: 10)

**Example:**
```
Claude, show me 20 recently uploaded files on Yandex.Disk
```

## Usage Examples

Once configured, you can use natural language with Claude:

1. **Check disk space:**
   ```
   "Show me how much space I have on Yandex.Disk"
   ```

2. **Upload files:**
   ```
   "Upload /Users/me/Desktop/report.pdf to /Documents on Yandex.Disk"
   ```

3. **Organize files:**
   ```
   "Create a folder /Projects/2026 and move all files from /temp there on Yandex.Disk"
   ```

4. **Backup files:**
   ```
   "Copy all .md files from current directory to /Backups on Yandex.Disk"
   ```

5. **Verify a backup:**
   ```
   "Compare /Volumes/USB/Archive with /Archive on Yandex.Disk and tell me what is missing in the cloud"
   ```

6. **Fill the gaps:**
   ```
   "Upload the files that are only local to /Archive"
   ```
   (Claude passes `only_local` from the comparison as `include` to `yandex_disk_upload`)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (for development)
npm run watch

# Run in development mode
npm run dev
```

## API Reference

This server uses the [Yandex.Disk REST API](https://yandex.ru/dev/disk/api/concepts/quickstart.html).

**API Endpoint:** `https://cloud-api.yandex.net/v1/disk`

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Author

Denis Gorokhov <gorokhovdenis@protonmail.com>

## Links

- [GitHub Repository](https://github.com/gorokhovdenis/yandex-disk-mcp)
- [Yandex.Disk API Documentation](https://yandex.ru/dev/disk/api/concepts/quickstart.html)
- [MCP Protocol](https://modelcontextprotocol.io/)
