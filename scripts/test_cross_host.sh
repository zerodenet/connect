#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
zboard_root=${ZBOARD_ROOT:-"$repo_root/../../golang/zboard"}
gui_root=${ZNET_GUI_ROOT:-"$repo_root/../../rust/gui"}
backend_root="$zboard_root/backend"
gui_manifest="$gui_root/src-tauri/Cargo.toml"

test -f "$repo_root/.local/publisher.key"
test -f "$backend_root/go.mod"
test -f "$gui_manifest"
if ! rg -q 'fn external_local_package_import_runs_in_vm_when_requested' "$gui_root"; then
  echo "Cross-host acceptance is unavailable: ZNet Sink has no Connect external-package acceptance hook" >&2
  exit 1
fi

accept_root=$(mktemp -d)
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    touch "$accept_root/stop"
    wait "$server_pid" 2>/dev/null || true
  fi
  case "$accept_root" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/tmp.*) rm -rf -- "$accept_root" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$accept_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

version="0.0.2-dev.$(date -u +%Y%m%d%H%M)"
go_os=$(go env GOOS)
go_arch=$(go env GOARCH)
platform="$go_os-$go_arch"
zboard_source="$accept_root/zboard-source"
zboard_runtime="runtimes/$platform/connect"
if [ "$go_os" = windows ]; then
  zboard_runtime="$zboard_runtime.exe"
fi
mkdir -p "$zboard_source/ui" "$(dirname "$zboard_source/$zboard_runtime")"
cp -R "$repo_root/zboard/ui/." "$zboard_source/ui/"
CGO_ENABLED=0 go -C "$repo_root" build -trimpath \
  -ldflags "-s -w -X main.pluginVersion=$version" \
  -o "$zboard_source/$zboard_runtime" ./zboard/runtime
go -C "$repo_root" run ./tests/acceptance/prepare_zboard \
  -template "$repo_root/zboard/package/manifest.template.json" \
  -out "$zboard_source/manifest.json" \
  -version "$version" \
  -platform "$platform" \
  -runtime "$zboard_runtime"
go -C "$repo_root" run ./tools/packagezboard \
  -source "$zboard_source" \
  -key "$repo_root/.local/publisher.key" \
  -key-id zerodenet \
  -out "$accept_root/connect.zbplugin"

go -C "$repo_root" run ./tests/acceptance/prepare_znet \
  -template "$repo_root/znet-sink/package/manifest.template.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -out "$accept_root/znet-manifest.json" \
  -version "$version"
go -C "$repo_root" run ./tools/packageznet \
  -manifest "$accept_root/znet-manifest.json" \
  -source "$repo_root/znet-sink/src/foundation.mjs" \
  -registration "$repo_root/znet-sink/package/registration.template.json" \
  -management-page "$repo_root/znet-sink/ui/management.html" \
  -management-page-id manage \
  -management-page-title "Connect 管理" \
  -key "$repo_root/.local/publisher.key" \
  -out "$accept_root/connect.zspkg" \
  -metadata "$accept_root/release.json"
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
printf '{"Replace":{"%s":"%s"}}\n' \
  "$backend_root/internal/plugins/runtime_integration_test.go" \
  "$repo_root/tests/acceptance/zboard_installed_host_test.go" \
  > "$accept_root/overlay.json"

publisher_public_key=$(tr -d '\r\n' < "$accept_root/publisher.key.pub")
(
  cd "$backend_root"
  CONNECT_ZBOARD_PACKAGE="$accept_root/connect.zbplugin" \
  CONNECT_PUBLISHER_PUBLIC_KEY="$publisher_public_key" \
  CONNECT_ACCEPTANCE_READY="$accept_root/bootstrap.json" \
  CONNECT_ACCEPTANCE_STOP="$accept_root/stop" \
  CONNECT_ACCEPTANCE_CA="$accept_root/ca.pem" \
    go test -mod=mod \
      -modfile="$accept_root/zboard-acceptance.mod" \
      -overlay="$accept_root/overlay.json" \
      -tags=zboard_connect_installed_acceptance \
      ./internal/plugins \
      -run '^TestConnectInstalledHostServer$' \
      -count=1 \
      -v
) > "$accept_root/zboard-server.log" 2>&1 &
server_pid=$!

attempt=0
while [ ! -s "$accept_root/bootstrap.json" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$accept_root/zboard-server.log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 300 ]; then
    cat "$accept_root/zboard-server.log" >&2
    echo "ZBoard acceptance server did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done

ZNET_EXTERNAL_PLUGIN_PACKAGE="$accept_root/connect.zspkg" \
ZNET_EXTERNAL_PLUGIN_ID="org.zerodenet.connect.znet-sink" \
ZNET_EXTERNAL_PLUGIN_BOOTSTRAP="$accept_root/bootstrap.json" \
ZNET_EXTERNAL_PLUGIN_CA="$accept_root/ca.pem" \
  cargo test --manifest-path "$gui_manifest" \
    --features acceptance-test-utils \
    external_local_package_import_runs_in_vm_when_requested \
    -- --nocapture

touch "$accept_root/stop"
wait "$server_pid"
server_pid=""
cat "$accept_root/zboard-server.log"
printf 'Cross-host installed-package acceptance passed for %s (%s).\n' "$version" "$platform"
