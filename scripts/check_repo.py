#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(relative):
    return json.loads((ROOT / relative).read_text())


contract = load("protocol/v1/operations.json")
product = load("marketplace/product-registration.template.json")
release = load("marketplace/release-build.template.json")
zboard = load("zboard/package/manifest.template.json")
sink = load("znet-sink/package/manifest.template.json")

assert contract["schema_version"] == 1
assert contract["status"] == "p0-wire-v1-frozen"
assert product["id"] == release["product_id"] == release["listing"]["id"] == contract["product_id"]
assert product == release["listing"]
targets = {target["host"]: target for target in product["targets"]}
assert set(targets) == {"zboard", "znet-sink"}
assert targets["zboard"]["package_id"] == zboard["id"] == contract["packages"]["zboard"]
assert targets["znet-sink"]["package_id"] == sink["plugin_id"] == contract["packages"]["znet-sink"]
assert release["publisher"] == product["publisher"]
assert release["source_commit"] == "0" * 40
assert product["publisher"]["public_key"] == "A" * 43 + "="
assert sink["source_sha256"] == "0" * 64
assert zboard["files"] == {}
assert {Path(item["path"]).suffix for item in release["artifacts"]} == {".zbplugin", ".zspkg"}
zboard_platforms = set(zboard["components"]["server"]["executables"])
zboard_artifacts = {
    f"{item['os']}-{item['arch']}"
    for item in release["artifacts"]
    if Path(item["path"]).suffix == ".zbplugin"
}
assert zboard_artifacts == zboard_platforms
assert all(
    platform in item["path"] and platform in item["url"]
    for item in release["artifacts"]
    if Path(item["path"]).suffix == ".zbplugin"
    for platform in [f"{item['os']}-{item['arch']}"]
)
operation_ids = [item["id"] for item in contract["operations"]]
assert len(operation_ids) == len(set(operation_ids))
assert len(contract["errors"]) == len(set(contract["errors"]))
assert set(targets["zboard"]["capabilities"]) == set(zboard["capabilities"])
zboard_pages = {
    (page["surface"], page["id"]): page["purpose"]
    for page in zboard["contributions"]["pages"]
}
assert zboard_pages == {
    ("account", "authorized-devices"): "business",
    ("admin", "client-communication"): "configuration",
}
assert set(targets["znet-sink"]["capabilities"]) == {
    request["capability"] for request in sink["required"] + sink["optional"]
}
assert set(targets["znet-sink"]["surfaces"]) == {"znet-sink.ui.management.v1"}
assert (ROOT / "znet-sink/ui/management.html").is_file()
assert (ROOT / "zboard/ui/account/index.html").is_file()
assert (ROOT / "zboard/ui/admin/index.html").is_file()
prepare_source = (ROOT / "scripts/prepare_dev.py").read_text()
build_source = (ROOT / "scripts/build_dev.sh").read_text()
assert '"required": []' not in prepare_source
assert '"optional": []' not in prepare_source
assert "-X main.pluginVersion=${version}" in build_source
marketplace_source = (ROOT / "scripts/generate_marketplace_entry.py").read_text()
verify_source = (ROOT / "tools/verifydev/main.go").read_text()
assert 'znet-sink.plugin-package.v2' in marketplace_source
assert 'znet-sink.plugin-package.v2' in verify_source
admin_page = (ROOT / "zboard/ui/admin/index.html").read_text()
account_page = (ROOT / "zboard/ui/account/index.html").read_text()
assert "call('config.load')" in admin_page
assert "call('config.save'" in admin_page
assert "type:'ui.resize'" in admin_page
assert "此构建尚未包含 Connect 服务端" not in admin_page
assert "setInterval" not in admin_page
assert "page.call" in account_page and "devices.revoke" in account_page

# Connect adapters may consume only public host contracts. Keep accidental host-internal imports,
# direct database access, and browser network bypasses out of the plugin repository.
for source in (ROOT / "zboard/runtime").glob("*.go"):
    text = source.read_text()
    for forbidden in (
        "github.com/zerodenet/zboard/backend/internal/",
        '"database/sql"',
        '"gorm.io/',
    ):
        assert forbidden not in text, f"{source.relative_to(ROOT)} crosses host boundary: {forbidden}"
for source in [
    ROOT / "znet-sink/ui/management.html",
    *sorted((ROOT / "znet-sink/src").glob("*.mjs")),
]:
    text = source.read_text()
    for forbidden in ("fetch(", "XMLHttpRequest", "__TAURI__", "window.__TAURI__"):
        assert forbidden not in text, f"{source.relative_to(ROOT)} bypasses the public host bridge: {forbidden}"
print("repository contracts are internally consistent and release placeholders remain blocked")
