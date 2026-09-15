#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"0\.0\.1-dev\.[0-9]{12}")


def load(relative):
    return json.loads((ROOT / relative).read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--published-at", required=True)
    args = parser.parse_args()

    if not VERSION.fullmatch(args.version):
        raise SystemExit("version must match 0.0.1-dev.YYYYMMDDHHMM")
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_commit) or args.source_commit == "0" * 40:
        raise SystemExit("source commit must be a real full Git SHA")
    try:
        public_key = base64.b64decode(args.public_key, validate=True)
    except Exception as error:
        raise SystemExit("publisher public key must be valid base64") from error
    if len(public_key) != 32 or args.public_key == "A" * 43 + "=":
        raise SystemExit("publisher public key must be a real Ed25519 public key")

    build = ROOT / ".build"
    shutil.rmtree(build, ignore_errors=True)
    (ROOT / "dist").mkdir(exist_ok=True)

    zboard = load("zboard/package/manifest.template.json")
    zboard.update({
        "name": "Connect for ZBoard (Dev Foundation)",
        "description": "Validates signed installation and embedded pages only; business integration is not enabled.",
        "version": args.version,
        "capabilities": ["zboard.ui.page.v1"],
        "components": {"ui": {"account": "ui/index.html", "admin": "ui/index.html"}},
        "files": {},
    })
    for page in zboard["contributions"]["pages"]:
        page["purpose"] = "business"
    zboard_root = build / "zboard"
    shutil.copytree(ROOT / "zboard/ui", zboard_root / "ui")
    write(zboard_root / "manifest.json", zboard)

    source = (ROOT / "znet-sink/src/foundation.mjs").read_text()
    sink = load("znet-sink/package/manifest.template.json")
    sink.update({
        "component_id": "foundation",
        "version": args.version,
        "requires_host": ">=0.0.1, <0.1.0",
        "required": [],
        "optional": [],
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
    })
    sink_root = build / "znet-sink"
    write(sink_root / "manifest.json", sink)
    sink_root.joinpath("foundation.mjs").write_text(source)

    listing = load("marketplace/product-registration.template.json")
    listing["publisher"]["public_key"] = args.public_key
    release = load("marketplace/release-build.template.json")
    release.update({
        "publisher": listing["publisher"],
        "source_commit": args.source_commit,
        "published_at": args.published_at,
        "channel": "dev",
        "notes_url": f"https://github.com/zerodenet/connect/releases/tag/v{args.version}",
        "listing": listing,
    })
    release["host_versions"]["znet-sink"]["min"] = "0.0.1"
    for artifact in release["artifacts"]:
        suffix = Path(artifact["path"]).suffix
        if suffix == ".zbplugin":
            name = f"org.zerodenet.connect.zboard-{args.version}-linux-amd64.zbplugin"
        else:
            name = f"org.zerodenet.connect.znet-sink-{args.version}-any.zspkg"
        artifact["path"] = f"../dist/{name}"
        artifact["url"] = f"https://github.com/zerodenet/connect/releases/download/v{args.version}/{name}"
    write(build / "product-registration.json", listing)
    write(build / "release-build.json", release)
    print(f"prepared dev package inputs for {args.version}")


if __name__ == "__main__":
    main()
