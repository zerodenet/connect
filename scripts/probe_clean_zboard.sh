#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
zboard_root=${ZBOARD_ROOT:?set ZBOARD_ROOT to a clean ZBoard worktree}
backend_root="$zboard_root/backend"

test -f "$repo_root/.local/publisher.key"
test -f "$backend_root/go.mod"
test -z "$(git -C "$zboard_root" status --porcelain)"

probe_root=$(mktemp -d)
cleanup() {
  case "$probe_root" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/tmp.*) rm -rf -- "$probe_root" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$probe_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

go_os=$(go env GOOS)
go_arch=$(go env GOARCH)
platform="$go_os-$go_arch"
version="0.0.2-clean-host-probe.1"
source_dir="$probe_root/source"
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
  -out "$probe_root/connect.zbplugin"
go -C "$repo_root" run ./tools/keyderive \
  "$repo_root/.local/publisher.key" \
  "$probe_root/publisher.key.pub"

printf '{"Replace":{"%s":"%s"}}\n' \
  "$backend_root/internal/plugins/runtime_integration_test.go" \
  "$repo_root/tests/acceptance/zboard_clean_baseline_probe_test.go" \
  > "$probe_root/overlay.json"

publisher_public_key=$(tr -d '\r\n' < "$probe_root/publisher.key.pub")
(
  cd "$backend_root"
  CONNECT_ZBOARD_PACKAGE="$probe_root/connect.zbplugin" \
  CONNECT_PUBLISHER_PUBLIC_KEY="$publisher_public_key" \
    go test \
      -overlay="$probe_root/overlay.json" \
      -tags=zboard_connect_clean_baseline_probe \
      ./internal/plugins \
      -run '^TestConnectPackageIsRejectedByCleanHostCapabilityBoundary$' \
      -count=1 \
      -v
)

printf 'Confirmed: clean ZBoard %s rejects Connect at its public capability boundary.\n' \
  "$(git -C "$zboard_root" rev-parse HEAD)"
