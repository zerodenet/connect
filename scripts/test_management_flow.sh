#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
gui_root=${ZNET_GUI_ROOT:-"$repo_root/../../rust/gui"}
node_bin=${NODE_BIN:-node}
browser=${ZNET_ACCEPTANCE_BROWSER:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
playwright_entry="$gui_root/node_modules/@playwright/test/index.mjs"

test -x "$node_bin"
test -x "$browser"
test -f "$playwright_entry"

major=$($node_bin -p 'Number(process.versions.node.split(".")[0])')
if [ "$major" -lt 20 ]; then
  echo "Connect management acceptance requires Node.js 20 or newer" >&2
  exit 1
fi

ZNET_PLAYWRIGHT_ENTRY="$playwright_entry" \
CONNECT_MANAGEMENT_PAGE="$repo_root/znet-sink/ui/management.html" \
ZNET_ACCEPTANCE_BROWSER="$browser" \
  "$node_bin" "$repo_root/tests/acceptance/znet_management.mjs"
