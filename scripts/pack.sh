#!/bin/sh
# Packs dist/ into an installable <uuid>.shell-extension.zip.
set -eu
cd "$(dirname "$0")/.."

gnome-extensions pack dist --force --out-dir . --extra-source=mdstat.js
