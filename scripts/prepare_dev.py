#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(?:0\.0\.1(?:-dev\.[0-9]{12})?|0\.0\.2-dev\.[0-9]{12})")


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
        raise SystemExit("version must be 0.0.1 or match a supported 0.0.1/0.0.2 dev version")
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_commit) or args.source_commit == "0" * 40:
        raise SystemExit("source commit must be a real full Git SHA")
    try:
        public_key = base64.b64decode(args.public_key, validate=True)
    except Exception as error:
        raise SystemExit("publisher public key must be valid base64") from error
    if len(public_key) != 32 or args.public_key == "A" * 43 + "=":
        raise SystemExit("publisher public key must be a real Ed25519 public key")

    readiness_path = ROOT / "zboard/release-readiness.json"
    if not readiness_path.is_file():
        raise SystemExit(
            "Connect package build is blocked: the ZBoard server runtime, governed Host APIs, "
            "device authorization, subscription projection, message synchronization, and end-to-end "
            "acceptance are not complete"
        )
    readiness = load("zboard/release-readiness.json")
    required_acceptance = {
        "host_apis",
        "server_runtime",
        "device_authorization",
        "subscription_projection",
        "message_synchronization",
        "client_e2e",
    }
    if readiness.get("accepted") is not True or set(readiness.get("checks", [])) != required_acceptance:
        raise SystemExit("Connect package build is blocked: ZBoard release readiness is incomplete")

    build = ROOT / ".build"
    shutil.rmtree(build, ignore_errors=True)
    (ROOT / "dist").mkdir(exist_ok=True)

    channel = "dev" if "-dev." in args.version else "stable"
    zboard = load("zboard/package/manifest.template.json")
    zboard.update({
        "name": "Connect",
        "version": args.version,
        "files": {},
    })
    executables = zboard["components"]["server"]["executables"]
    for platform, relative in executables.items():
        zboard_root = build / "zboard" / platform
        shutil.copytree(ROOT / "zboard/ui", zboard_root / "ui")
        runtime_source = ROOT / "zboard/runtime/bin" / platform / Path(relative).name
        if not runtime_source.is_file():
            raise SystemExit(
                f"Connect package build is blocked: the ZBoard {platform} runtime is missing"
            )
        runtime_target = zboard_root / relative
        runtime_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(runtime_source, runtime_target)
        platform_manifest = json.loads(json.dumps(zboard))
        platform_manifest["components"]["server"]["executables"] = {
            platform: relative
        }
        write(zboard_root / "manifest.json", platform_manifest)

    source = (ROOT / "znet-sink/src/foundation.mjs").read_text()
    sink = load("znet-sink/package/manifest.template.json")
    sink.update({
        "component_id": "provider-source",
        "version": args.version,
        "lifecycle": ["host_start"],
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
    })
    sink_root = build / "znet-sink"
    write(sink_root / "manifest.json", sink)
    sink_root.joinpath("foundation.mjs").write_text(source)
    sink_root.joinpath("management.html").write_text(
        (ROOT / "znet-sink/ui/management.html").read_text()
    )

    listing = load("marketplace/product-registration.template.json")
    listing["publisher"]["public_key"] = args.public_key
    release = load("marketplace/release-build.template.json")
    release.update({
        "publisher": listing["publisher"],
        "source_commit": args.source_commit,
        "published_at": args.published_at,
        "channel": channel,
        "notes_url": f"https://github.com/zerodenet/connect/releases/tag/v{args.version}",
        "listing": listing,
    })
    for artifact in release["artifacts"]:
        suffix = Path(artifact["path"]).suffix
        if suffix == ".zbplugin":
            name = (
                f"org.zerodenet.connect.zboard-{args.version}-"
                f"{artifact['os']}-{artifact['arch']}.zbplugin"
            )
        else:
            name = f"org.zerodenet.connect.znet-sink-{args.version}-any.zspkg"
        artifact["path"] = f"../dist/{name}"
        artifact["url"] = f"https://github.com/zerodenet/connect/releases/download/v{args.version}/{name}"
    write(build / "product-registration.json", listing)
    write(build / "release-build.json", release)
    print(f"prepared {channel} package inputs for {args.version}")


if __name__ == "__main__":
    main()
