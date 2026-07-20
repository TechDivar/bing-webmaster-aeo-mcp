#!/usr/bin/env bash
set -euo pipefail

secret_dir="$HOME/Library/Application Support/Codex/secrets"
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

printf 'Key saved securely. Host the matching <key>.txt file on your site, then restart Codex.\n'
