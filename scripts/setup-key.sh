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
secret_file="$secret_dir/bing-webmaster-api-key"

printf '\nBing Webmaster MCP secure setup\n'
printf 'Paste your Bing Webmaster API key, then press Enter.\n'
printf 'The key will be hidden while you type: '
IFS= read -r -s bing_webmaster_key
printf '\n'

if [ "${#bing_webmaster_key}" -lt 8 ]; then
  printf 'That key looks too short. Nothing was saved.\n'
  exit 1
fi

umask 077
mkdir -p "$secret_dir"
temporary_key_file="$(mktemp "$secret_dir/.bing-webmaster-key.XXXXXX")"
trap 'rm -f "$temporary_key_file"' EXIT
printf '%s\n' "$bing_webmaster_key" > "$temporary_key_file"
chmod 600 "$temporary_key_file"
mv "$temporary_key_file" "$secret_file"
unset bing_webmaster_key
trap - EXIT

printf 'Key saved securely. Restart your MCP client before using the Bing tools.\n'

if [ "${1:-}" = "--pause" ]; then
  printf 'Press Enter to close.\n'
  IFS= read -r _
fi
