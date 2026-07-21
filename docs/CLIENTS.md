# Connect an MCP client

This is a standard local `stdio` MCP server. It does not contain code that is specific to one AI client.

## Before connecting

1. Install Node.js 20 or newer.
2. Clone this repository and run `npm install`.
3. Run `npm run setup-key` if you want Bing tools.
4. Copy the absolute path to `src/server.mjs`.

The examples below use `/ABSOLUTE/PATH/bing-webmaster-aeo-mcp`. Replace it with the real folder on your computer.

## Codex

Run this inside the repository:

```bash
codex mcp add bing-webmaster-aeo -- node "$PWD/src/server.mjs"
```

Restart Codex, then ask: `List the websites connected to my Bing Webmaster account.`

## Claude Code

```bash
claude mcp add --transport stdio --scope user bing-webmaster-aeo -- \
  node /ABSOLUTE/PATH/bing-webmaster-aeo-mcp/src/server.mjs
```

Check it with:

```bash
claude mcp list
```

See Anthropic's [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for its current configuration options.

## Cursor

Add this to a private Cursor MCP configuration. Do not commit a configuration containing a secret:

```json
{
  "mcpServers": {
    "bing-webmaster-aeo": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/bing-webmaster-aeo-mcp/src/server.mjs"],
      "env": {
        "BING_WEBMASTER_API_KEY_FILE": "/ABSOLUTE/PRIVATE/PATH/bing-key",
        "MCP_MODULES": "bing,seo,aeo,indexnow"
      }
    }
  }
}
```

See Cursor's [MCP documentation](https://docs.cursor.com/en/tools/mcp) for the correct configuration location in your version.

## VS Code

Create a user-level MCP configuration, or a workspace `.vscode/mcp.json` that does not contain secrets:

```json
{
  "servers": {
    "bingWebmasterAeo": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/bing-webmaster-aeo-mcp/src/server.mjs"],
      "env": {
        "BING_WEBMASTER_API_KEY_FILE": "/ABSOLUTE/PRIVATE/PATH/bing-key",
        "MCP_MODULES": "bing,seo,aeo,indexnow"
      }
    }
  }
}
```

See VS Code's [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for user settings, inputs, and secret handling.

## Other MCP clients

For OpenClaw and other compatible hosts, add a local `stdio` server with:

- Command: `node`
- Argument: the absolute path to `src/server.mjs`
- Working directory: the repository folder, if the host asks for one
- Optional environment: the credential file paths and `MCP_MODULES`

The exact settings filename differs by client. Use that client's current MCP instructions rather than copying a filename from another client. The transport behavior follows the official [MCP `stdio` specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio).

## Load fewer tools

`MCP_MODULES` accepts a comma-separated list:

```text
bing
seo,aeo
bing,indexnow
bing,seo,aeo,indexnow
```

Leave it unset, or use `all`, to load all 46 tools.

## Credentials

The easiest private setup is:

```bash
npm run setup-key
npm run setup-indexnow-key
```

The server also accepts:

- `BING_WEBMASTER_API_KEY` or `BING_WEBMASTER_API_KEY_FILE`
- `INDEXNOW_KEY` or `INDEXNOW_KEY_FILE`
- `INDEXNOW_KEY_LOCATION` for a same-host custom public key-file URL
- `BING_WEBMASTER_MCP_CONFIG_DIR` for a custom private configuration folder

Do not paste keys into prompts or commit them to GitHub.

## WordPress

This server prepares a fix and shows a diff, but never publishes it. Connect a separate WordPress MCP if you want your AI client to publish after you approve the exact changes.
