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
go -C "$repo_root" run ./tools/keyderive "$repo_root/.local/publisher.key" "$repo_root/.local/publisher.key.pub"
public_key=$(tr -d '\r\n' < "$repo_root/.local/publisher.key.pub")
python3 "$repo_root/scripts/prepare_znet_app.py" \
  --out "$probe_root/app" --version "$version" \
  --registration-out "$probe_root/registration.json" --public-key "$public_key"

cp -R "$repo_root/tests/acceptance/znet_clean_probe" "$probe_root/crate"
mkdir -p "$probe_root/gui/src-tauri/crates" "$probe_root/gui/sdk"
ln -s "$gui_root/src-tauri/crates/plugin-sandbox" "$probe_root/gui/src-tauri/crates/plugin-sandbox"
ln -s "$gui_root/src-tauri/crates/client-core" "$probe_root/gui/src-tauri/crates/client-core"
ln -s "$gui_root/src-tauri/crates/client-capabilities" "$probe_root/gui/src-tauri/crates/client-capabilities"
ln -s "$gui_root/sdk/rust" "$probe_root/gui/sdk/rust"

# Compile the exact SDK method used by Connect before merely checking whether
# the host can parse the package envelope. Package acceptance alone does not
# prove that the installed host can execute every method used by the plugin.
CARGO_TARGET_DIR="${CONNECT_CARGO_TARGET_DIR:-$repo_root/.build/clean-znet-probe-target}" \
  cargo test --manifest-path "$probe_root/crate/Cargo.toml" --no-run

cargo build --manifest-path "$gui_root/src-tauri/Cargo.toml" -p znet-plugin-sandbox --bin znet-plugin --locked
plugin_target=${CARGO_TARGET_DIR:-"$gui_root/src-tauri/target"}
"$plugin_target/debug/znet-plugin" pack \
  "$probe_root/app" "$repo_root/.local/publisher.seed" \
  "$probe_root/connect.zspkg" "$probe_root/release.json" "$probe_root/registration.json"

CONNECT_ZNET_PACKAGE="$probe_root/connect.zspkg" \
  CARGO_TARGET_DIR="${CONNECT_CARGO_TARGET_DIR:-$repo_root/.build/clean-znet-probe-target}" \
  cargo test --manifest-path "$probe_root/crate/Cargo.toml" -- --nocapture

printf 'Confirmed: clean ZNet Sink %s accepts the signed Connect application package.\n' \
  "$(git -C "$gui_root" rev-parse HEAD)"
