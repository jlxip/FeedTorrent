#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
mkdir -p .tools web/dist
temp=$(mktemp -d "$root/.tools/web.XXXXXXXX")
trap 'rm -rf "$temp"' EXIT
trap 'exit 1' HUP INT TERM
node dev/node_modules/typescript/bin/tsc -p web/tsconfig.json --outDir "$temp"
for file in index.html app.css theme.js; do cp "web/$file" "$temp/$file"; done
for asset in basecoat-vega-1.0.2.min.css:basecoat.css lucide-0.468.0.min.js:lucide.js basecoat-runtime-1.0.2.min.js:basecoat-runtime.js basecoat-tabs-1.0.2.min.js:basecoat-tabs.js basecoat-sidebar-1.0.2.min.js:basecoat-sidebar.js basecoat-dropdown-menu-1.0.2.min.js:basecoat-dropdown-menu.js; do
  cp "web/vendor/${asset%%:*}" "$temp/${asset#*:}"
done
for file in "$temp"/*; do
  target="web/dist/${file##*/}"
  if ! cmp -s "$file" "$target"; then cp "$file" "$target"; fi
done
touch web/dist/.ready
