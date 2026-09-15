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
assert contract["status"] == "p0-draft"
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
operation_ids = [item["id"] for item in contract["operations"]]
assert len(operation_ids) == len(set(operation_ids))
assert len(contract["errors"]) == len(set(contract["errors"]))
assert set(targets["zboard"]["capabilities"]) == set(zboard["capabilities"])
assert set(targets["znet-sink"]["capabilities"]) == {
    request["capability"] for request in sink["required"] + sink["optional"]
}
print("repository contracts are internally consistent and release placeholders remain blocked")
