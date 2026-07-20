#!/usr/bin/env bash
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bash "$script_dir/setup-key.sh" --pause
