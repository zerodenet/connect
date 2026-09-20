#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
zboard_root=${ZBOARD_ROOT:-"$repo_root/../../golang/zboard"}
backend_root="$zboard_root/backend"

test -f "$repo_root/.local/publisher.key"
test -f "$backend_root/go.mod"

accept_root=$(mktemp -d)
cleanup() {
  case "$accept_root" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/tmp.*) rm -rf -- "$accept_root" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$accept_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

go_os=$(go env GOOS)
go_arch=$(go env GOARCH)
platform="$go_os-$go_arch"
version="0.0.2-dev.$(date -u +%Y%m%d%H%M)"
source_dir="$accept_root/zboard-source"
runtime_relative="runtimes/$platform/connect"
if [ "$go_os" = windows ]; then
  runtime_relative="$runtime_relative.exe"
fi

mkdir -p "$source_dir/ui" "$(dirname "$source_dir/$runtime_relative")"
cp -R "$repo_root/zboard/ui/." "$source_dir/ui/"
CGO_ENABLED=0 go -C "$repo_root" build -trimpath \
  -ldflags "-s -w -X main.pluginVersion=$version" \
  -o "$source_dir/$runtime_relative" ./zboard/runtime
go -C "$repo_root" run ./tests/acceptance/prepare_zboard \
  -template "$repo_root/zboard/package/manifest.template.json" \
  -out "$source_dir/manifest.json" \
  -version "$version" \
  -platform "$platform" \
  -runtime "$runtime_relative"
go -C "$repo_root" run ./tools/packagezboard \
  -source "$source_dir" \
  -key "$repo_root/.local/publisher.key" \
  -key-id zerodenet \
  -out "$accept_root/connect.zbplugin"
go -C "$repo_root" run ./tools/keyderive \
  "$repo_root/.local/publisher.key" \
  "$accept_root/publisher.key.pub"

cp "$backend_root/go.mod" "$accept_root/zboard-acceptance.mod"
cp "$backend_root/go.sum" "$accept_root/zboard-acceptance.sum"
go mod edit -modfile="$accept_root/zboard-acceptance.mod" \
  -replace="github.com/zerodenet/zboard/backend/pkg/pluginapi=$backend_root/pkg/pluginapi"
go mod edit -modfile="$accept_root/zboard-acceptance.mod" \
  -require=github.com/zerodenet/connect@v0.0.0
go mod edit -modfile="$accept_root/zboard-acceptance.mod" \
  -replace="github.com/zerodenet/connect=$repo_root"

logical_test="$backend_root/internal/plugins/runtime_integration_test.go"
acceptance_test="$repo_root/tests/acceptance/zboard_installed_host_test.go"
printf '{"Replace":{"%s":"%s"}}\n' "$logical_test" "$acceptance_test" > "$accept_root/overlay.json"

publisher_public_key=$(tr -d '\r\n' < "$accept_root/publisher.key.pub")
(
  cd "$backend_root"
  CONNECT_ZBOARD_PACKAGE="$accept_root/connect.zbplugin" \
  CONNECT_PUBLISHER_PUBLIC_KEY="$publisher_public_key" \
    go test -mod=mod \
      -modfile="$accept_root/zboard-acceptance.mod" \
      -overlay="$accept_root/overlay.json" \
      -tags=zboard_connect_installed_acceptance \
      ./internal/plugins \
      -run '^TestConnectInstalledHostEndToEnd$' \
      -count=1 \
      -v
)

printf 'ZBoard installed-package acceptance passed for %s (%s).\n' "$version" "$platform"
