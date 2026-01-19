# Yandex.Disk MCP Server

MCP Server for Yandex.Disk REST API integration with Claude and other MCP clients.

## Features

This MCP server provides tools to interact with Yandex.Disk:

- 📊 Get disk information (total/used space)
- 📁 List files and folders
- 📄 Get file/folder metadata
- ➕ Create folders
- ⬆️ Upload files (get upload URL)
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
Get metadata for a specific file or folder

**Parameters:**
- `path` (string, required): Path to the file or folder (e.g., '/Documents/file.txt')

**Example:**
```
Claude, get metadata for /Documents/report.pdf on Yandex.Disk
```

### yandex_disk_create_folder
Create a new folder

**Parameters:**
- `path` (string, required): Path for the new folder (e.g., '/Documents/NewFolder')

**Example:**
```
Claude, create folder /Backups/2026 on Yandex.Disk
```

### yandex_disk_get_upload_url
Get URL for uploading a file

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

2. **Upload a file:**
   ```
   "Upload this file to /Documents/report.pdf on Yandex.Disk"
   ```
   (Claude will get the upload URL, then you can use curl or other tools to actually upload)

3. **Organize files:**
   ```
   "Create a folder /Projects/2026 and move all files from /temp there on Yandex.Disk"
   ```

4. **Backup files:**
   ```
   "Copy all .md files from current directory to /Backups on Yandex.Disk"
   ```

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

## Security

⚠️ **Important Security Notes:**

1. Never commit your OAuth token to git
2. Store token in environment variables or secure files
3. Limit OAuth application permissions to only what's needed
4. Token expires after 1 year - you'll need to get a new one
5. Use `chmod 600` on token files to restrict access

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
