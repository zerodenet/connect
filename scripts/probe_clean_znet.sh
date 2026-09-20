#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
gui_root=${ZNET_GUI_ROOT:?set ZNET_GUI_ROOT to a clean ZNet Sink worktree}

test -f "$repo_root/.local/publisher.key"
test -f "$gui_root/src-tauri/crates/plugin-sandbox/Cargo.toml"
test -z "$(git -C "$gui_root" status --porcelain)"

probe_root=$(mktemp -d)
cleanup() {
  case "$probe_root" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/tmp.*) rm -rf -- "$probe_root" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$probe_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

version="0.0.2-clean-host-probe.1"
go -C "$repo_root" run ./tests/acceptance/prepare_znet \
  -template "$repo_root/znet-sink/package/manifest.template.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -out "$probe_root/manifest.json" \
  -version "$version"
go -C "$repo_root" run ./tools/packageznet \
  -manifest "$probe_root/manifest.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -registration "$repo_root/znet-sink/package/registration.template.json" \
  -management-page "$repo_root/znet-sink/ui/management.html" \
  -management-page-id manage \
  -management-page-title "Connect 管理" \
  -key "$repo_root/.local/publisher.key" \
  -out "$probe_root/connect.zspkg" \
  -metadata "$probe_root/release.json"

cp -R "$repo_root/tests/acceptance/znet_clean_probe" "$probe_root/crate"
mkdir -p "$probe_root/gui/src-tauri/crates" "$probe_root/gui/sdk"
ln -s "$gui_root/src-tauri/crates/plugin-sandbox" "$probe_root/gui/src-tauri/crates/plugin-sandbox"
ln -s "$gui_root/src-tauri/crates/client-core" "$probe_root/gui/src-tauri/crates/client-core"
ln -s "$gui_root/src-tauri/crates/client-capabilities" "$probe_root/gui/src-tauri/crates/client-capabilities"
ln -s "$gui_root/sdk/rust" "$probe_root/gui/sdk/rust"

CONNECT_ZNET_PACKAGE="$probe_root/connect.zspkg" \
  CARGO_TARGET_DIR="${CONNECT_CARGO_TARGET_DIR:-$repo_root/.build/clean-znet-probe-target}" \
  cargo test --manifest-path "$probe_root/crate/Cargo.toml" -- --nocapture

printf 'Confirmed: clean ZNet Sink %s rejects Connect at its public capability boundary.\n' \
  "$(git -C "$gui_root" rev-parse HEAD)"
