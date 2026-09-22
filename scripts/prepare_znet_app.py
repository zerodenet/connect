#!/usr/bin/env python3
"""Stage Connect's signed ZNet Sink application-package inputs."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def stage(output: Path, version: str, registration_out: Path | None = None, public_key: str | None = None) -> None:
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"application output must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    source = (ROOT / "znet-sink/src/foundation.mjs").read_bytes()
    plugin = json.loads((ROOT / "znet-sink/package/plugin.template.json").read_text())
    plugin["version"] = version
    (output / "plugin.json").write_text(json.dumps(plugin, ensure_ascii=False, indent=2) + "\n")
    component = json.loads((ROOT / "znet-sink/package/manifest.template.json").read_text())
    component.update(version=version, source_sha256=hashlib.sha256(source).hexdigest())
    component_root = output / "components/provider-source"
    component_root.mkdir(parents=True)
    (component_root / "manifest.json").write_text(json.dumps(component, ensure_ascii=False, indent=2) + "\n")
    (component_root / "index.mjs").write_bytes(source)
    shutil.copy2(ROOT / "znet-sink/src/background.mjs", component_root / "background.mjs")
    ui_root = output / "ui/manage"
    ui_root.mkdir(parents=True)
    shutil.copy2(ROOT / "znet-sink/ui/management.html", ui_root / "index.html")
    shutil.copy2(ROOT / "znet-sink/ui/page.js", ui_root / "page.js")
    if registration_out is not None:
        if not public_key:
            raise ValueError("publisher public key is required for embedded registration")
        registration = json.loads((ROOT / "znet-sink/package/registration.template.json").read_text())
        registration["publisher"]["public_key"] = public_key
        registration_out.write_text(json.dumps(registration, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--registration-out", type=Path)
    parser.add_argument("--public-key")
    args = parser.parse_args()
    stage(args.out, args.version, args.registration_out, args.public_key)
