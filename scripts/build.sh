#!/bin/sh
# Compiles the extension into dist/, which is a complete extension directory.
set -eu
cd "$(dirname "$0")/.."

rm -rf dist
npx tsc
cp metadata.json stylesheet.css dist/
mkdir -p dist/schemas
cp schemas/*.gschema.xml dist/schemas/
glib-compile-schemas --strict dist/schemas
