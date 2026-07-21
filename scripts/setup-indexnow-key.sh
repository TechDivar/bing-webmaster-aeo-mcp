#!/usr/bin/env bash
set -euo pipefail

if [ -n "${BING_WEBMASTER_MCP_CONFIG_DIR:-}" ]; then
  mcp_config_root="$BING_WEBMASTER_MCP_CONFIG_DIR"
else
  case "$(uname -s)" in
    Darwin*) mcp_config_root="$HOME/Library/Application Support/bing-webmaster-aeo-mcp" ;;
    MINGW*|MSYS*|CYGWIN*) mcp_config_root="${APPDATA:-$HOME/AppData/Roaming}/bing-webmaster-aeo-mcp" ;;
    *) mcp_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/bing-webmaster-aeo-mcp" ;;
  esac
fi
secret_dir="$mcp_config_root/secrets"
secret_file="$secret_dir/indexnow-key"

printf '\nIndexNow secure setup\n'
printf 'Enter your 8 to 128 character IndexNow key, then press Enter.\n'
printf 'The key will be hidden while you type: '
IFS= read -r -s indexnow_key
printf '\n'

if ! [[ "$indexnow_key" =~ ^[A-Za-z0-9-]{8,128}$ ]]; then
  printf 'That key does not match the official IndexNow format. Nothing was saved.\n'
  exit 1
fi

umask 077
mkdir -p "$secret_dir"
temporary_key_file="$(mktemp "$secret_dir/.indexnow-key.XXXXXX")"
trap 'rm -f "$temporary_key_file"' EXIT
printf '%s\n' "$indexnow_key" > "$temporary_key_file"
chmod 600 "$temporary_key_file"
mv "$temporary_key_file" "$secret_file"
unset indexnow_key
trap - EXIT

printf 'Key saved securely. Host the matching <key>.txt file on your site, then restart your MCP client.\n'
