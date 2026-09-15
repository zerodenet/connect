#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
  echo "usage: make dev VERSION=0.0.1-dev.YYYYMMDDHHMM" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
zboard_repo=${ZBOARD_REPO:-/Volumes/tool/golang/.codex-worktrees/zboard-unified-marketplace}
znet_sink_repo=${ZNET_SINK_REPO:-/Volumes/tool/rust/.codex-worktrees/gui-unified-marketplace}
marketplace_repo=${MARKETPLACE_REPO:-/Volumes/tool/.codex-worktrees/plugins-unified-marketplace}
cargo_target_dir=${CARGO_TARGET_DIR:-$znet_sink_repo/src-tauri/target}
published_at=${PUBLISHED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
source_commit=$(git -C "$repo_root" rev-parse HEAD)
public_key=$(tr -d '\r\n' < "$repo_root/.local/publisher.key.pub")

test -f "$repo_root/.local/publisher.key"
test -f "$repo_root/.local/publisher.seed"
test -f "$marketplace_repo/scripts/generate_release_manifest.py"

python3 "$repo_root/scripts/prepare_dev.py" \
  --version "$version" \
  --public-key "$public_key" \
  --source-commit "$source_commit" \
  --published-at "$published_at"

mkdir -p "$repo_root/.build/tools" "$repo_root/dist"
go -C "$zboard_repo/backend" build -o "$repo_root/.build/tools/zboard-pluginpackager" ./tools/pluginpackager

CARGO_TARGET_DIR="$cargo_target_dir" cargo build \
  --manifest-path "$znet_sink_repo/src-tauri/Cargo.toml" \
  -p znet-plugin-sandbox \
  --bin znet-plugin
znet_plugin="$cargo_target_dir/debug/znet-plugin"

zboard_package="$repo_root/dist/org.zerodenet.connect.zboard-${version}-linux-amd64.zbplugin"
sink_package="$repo_root/dist/org.zerodenet.connect.znet-sink-${version}-any.zspkg"

"$repo_root/.build/tools/zboard-pluginpackager" \
  -source "$repo_root/.build/zboard" \
  -key "$repo_root/.local/publisher.key" \
  -key-id zerodenet \
  -out "$zboard_package"

"$znet_plugin" pack \
  "$repo_root/.build/znet-sink/manifest.json" \
  "$repo_root/.build/znet-sink/foundation.mjs" \
  "$repo_root/.local/publisher.seed" \
  "$sink_package" \
  "$repo_root/dist/znet-sink-release.json"

PYTHONPATH="$marketplace_repo/scripts" python3 "$marketplace_repo/scripts/generate_release_manifest.py" \
  "$repo_root/.build/release-build.json" \
  --output "$repo_root/dist/marketplace-entry.json"

shasum -a 256 "$zboard_package" "$sink_package" "$repo_root/dist/marketplace-entry.json"
