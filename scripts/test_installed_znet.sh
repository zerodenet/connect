#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
gui_root=${ZNET_GUI_ROOT:-"$repo_root/../../rust/gui"}
manifest_path="$gui_root/src-tauri/Cargo.toml"

test -f "$repo_root/.local/publisher.key"
test -f "$manifest_path"
if ! rg -q 'fn external_local_package_import_runs_in_vm_when_requested' "$gui_root"; then
  echo "ZNet Sink installed-package acceptance is unavailable: the host has no Connect external-package acceptance hook" >&2
  exit 1
fi

accept_root=$(mktemp -d)
cleanup() {
  case "$accept_root" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/tmp.*) rm -rf -- "$accept_root" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$accept_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

version="0.0.2-dev.$(date -u +%Y%m%d%H%M)"
go -C "$repo_root" run ./tests/acceptance/prepare_znet \
  -template "$repo_root/znet-sink/package/manifest.template.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -out "$accept_root/manifest.json" \
  -version "$version"
go -C "$repo_root" run ./tools/packageznet \
  -manifest "$accept_root/manifest.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -registration "$repo_root/znet-sink/package/registration.template.json" \
  -management-page "$repo_root/znet-sink/ui/management.html" \
  -management-page-id manage \
  -management-page-title "Connect 管理" \
  -key "$repo_root/.local/publisher.key" \
  -out "$accept_root/connect.zspkg" \
  -metadata "$accept_root/release.json"

ZNET_EXTERNAL_PLUGIN_PACKAGE="$accept_root/connect.zspkg" \
ZNET_EXTERNAL_PLUGIN_ID="org.zerodenet.connect.znet-sink" \
  cargo test --manifest-path "$manifest_path" \
    external_local_package_import_runs_in_vm_when_requested \
    -- --nocapture

printf 'ZNet Sink installed-package acceptance passed for %s.\n' "$version"
