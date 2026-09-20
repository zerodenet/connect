#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
  echo "usage: make dev VERSION=0.0.1-dev.YYYYMMDDHHMM or VERSION=0.0.2-dev.YYYYMMDDHHMM; make release VERSION=0.0.1" >&2
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

python3 "$repo_root/scripts/check_release_readiness.py"

build_runtime() {
  target_os=$1
  target_arch=$2
  suffix=$3
  target="$repo_root/zboard/runtime/bin/${target_os}-${target_arch}/connect${suffix}"
  mkdir -p "$(dirname "$target")"
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
    go -C "$repo_root" build -trimpath \
      -ldflags "-s -w -X main.pluginVersion=${version}" \
      -o "$target" ./zboard/runtime
}

build_runtime linux amd64 ""
build_runtime linux arm64 ""
build_runtime darwin amd64 ""
build_runtime darwin arm64 ""
build_runtime windows amd64 ".exe"

python3 "$repo_root/scripts/prepare_dev.py" \
  --version "$version" \
  --public-key "$public_key" \
  --source-commit "$source_commit" \
  --published-at "$published_at"

mkdir -p "$repo_root/dist"

sink_package="$repo_root/dist/org.zerodenet.connect.znet-sink-${version}-any.zspkg"
sink_metadata="$repo_root/dist/znet-sink-release-${version}.json"
rm -f "$repo_root"/dist/org.zerodenet.connect.zboard-"${version}"-*.zbplugin \
  "$sink_package" "$sink_metadata" "$repo_root/dist/marketplace-entry.json"

package_zboard() {
  platform=$1
  output="$repo_root/dist/org.zerodenet.connect.zboard-${version}-${platform}.zbplugin"
  go -C "$repo_root" run ./tools/packagezboard \
    -source "$repo_root/.build/zboard/${platform}" \
    -key "$repo_root/.local/publisher.key" \
    -key-id zerodenet \
    -out "$output"
}

package_zboard linux-amd64
package_zboard linux-arm64
package_zboard darwin-amd64
package_zboard darwin-arm64
package_zboard windows-amd64

go -C "$repo_root" run ./tools/packageznet \
  -manifest "$repo_root/.build/znet-sink/manifest.json" \
  -source "$repo_root/.build/znet-sink/foundation.mjs" \
  -registration "$repo_root/znet-sink/package/registration.template.json" \
  -management-page "$repo_root/.build/znet-sink/management.html" \
  -management-page-id "manage" \
  -management-page-title "Connect 管理" \
  -key "$repo_root/.local/publisher.key" \
  -out "$sink_package" \
  -metadata "$sink_metadata"

python3 "$repo_root/scripts/generate_marketplace_entry.py" \
  "$repo_root/.build/release-build.json" \
  --output "$repo_root/dist/marketplace-entry.json"

set -- \
  "$repo_root/.local/publisher.key.pub" \
  "$sink_package" \
  "$version"
for platform in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64; do
  set -- "$@" "$repo_root/dist/org.zerodenet.connect.zboard-${version}-${platform}.zbplugin"
done
go -C "$repo_root" run ./tools/verifydev "$@"

shasum -a 256 "$repo_root"/dist/org.zerodenet.connect.zboard-"${version}"-*.zbplugin \
  "$sink_package" "$repo_root/dist/marketplace-entry.json"
