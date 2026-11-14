#!/bin/sh
# Symlinks dist/ into the user's extension directory for development.
set -eu
cd "$(dirname "$0")/.."

uuid=$(node -p 'JSON.parse(require("fs").readFileSync("metadata.json", "utf8")).uuid')
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

mkdir -p "$(dirname "$target")"
ln -sfn "$PWD/dist" "$target"
echo "$target -> $PWD/dist"
