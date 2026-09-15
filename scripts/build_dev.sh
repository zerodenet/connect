#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
  echo "usage: make dev VERSION=0.0.1-dev.YYYYMMDDHHMM" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
published_at=${PUBLISHED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
source_commit=$(git -C "$repo_root" rev-parse HEAD)

test -f "$repo_root/.local/publisher.key"
go -C "$repo_root" run ./tools/keyderive \
  "$repo_root/.local/publisher.key" \
  "$repo_root/.local/publisher.key.pub"
public_key=$(tr -d '\r\n' < "$repo_root/.local/publisher.key.pub")

python3 "$repo_root/scripts/prepare_dev.py" \
  --version "$version" \
  --public-key "$public_key" \
  --source-commit "$source_commit" \
  --published-at "$published_at"

mkdir -p "$repo_root/dist"

zboard_package="$repo_root/dist/org.zerodenet.connect.zboard-${version}-linux-amd64.zbplugin"
sink_package="$repo_root/dist/org.zerodenet.connect.znet-sink-${version}-any.zspkg"
sink_metadata="$repo_root/dist/znet-sink-release-${version}.json"
rm -f "$zboard_package" "$sink_package" "$sink_metadata" "$repo_root/dist/marketplace-entry.json"

go -C "$repo_root" run ./tools/packagezboard \
  -source "$repo_root/.build/zboard" \
  -key "$repo_root/.local/publisher.key" \
  -key-id zerodenet \
  -out "$zboard_package"

go -C "$repo_root" run ./tools/packageznet \
  -manifest "$repo_root/.build/znet-sink/manifest.json" \
  -source "$repo_root/.build/znet-sink/foundation.mjs" \
  -key "$repo_root/.local/publisher.key" \
  -out "$sink_package" \
  -metadata "$sink_metadata"

python3 "$repo_root/scripts/generate_marketplace_entry.py" \
  "$repo_root/.build/release-build.json" \
  --output "$repo_root/dist/marketplace-entry.json"

go -C "$repo_root" run ./tools/verifydev \
  "$repo_root/.local/publisher.key.pub" \
  "$zboard_package" \
  "$sink_package" \
  "$version"

shasum -a 256 "$zboard_package" "$sink_package" "$repo_root/dist/marketplace-entry.json"
