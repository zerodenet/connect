#!/usr/bin/env python3
"""Build and strictly validate marketplace-entry.json from signed packages."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
import zipfile

HOSTS = {"zboard", "znet-sink"}
CHANNELS = {"stable", "rc", "dev"}
OPERATING_SYSTEMS = {"any", "linux", "darwin", "windows", "android", "ios"}
ARCHITECTURES = {"any", "amd64", "arm64"}
SURFACES = {"zboard": {"admin", "public", "account"}, "znet-sink": set()}
ID = re.compile(r"[a-z0-9][a-z0-9._-]{1,159}")
SEMVER = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
COMMIT = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"[a-f0-9]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, required, optional=()):
    require(isinstance(value, dict), "expected an object")
    allowed = set(required) | set(optional)
    require(set(required) <= value.keys() <= allowed, "missing or unknown fields")


def text(value, maximum=2000):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def strings(value, maximum=2000):
    return isinstance(value, list) and len(value) == len(set(value)) and all(text(item, maximum) for item in value)


def https(value):
    require(text(value), "expected HTTPS URL")
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
            and not parsed.fragment and not parsed.query and parsed.port in (None, 443),
            "URL must be credential-free HTTPS without query or fragment")
    return parsed


def github_repository(value):
    parsed = https(value)
    require(parsed.hostname == "github.com" and re.fullmatch(r"/[\w.-]+/[\w.-]+", parsed.path),
            "repository must identify one GitHub source repository")


def validate_publisher(value):
    fields(value, ("id", "public_key"))
    require(ID.fullmatch(value["id"]) and len(value["id"]) <= 80, "invalid publisher ID")
    try:
        key = base64.b64decode(value["public_key"], validate=True)
    except (TypeError, ValueError):
        key = b""
    require(len(key) == 32, "publisher must provide an Ed25519 public key")


def validate_release_source(value):
    fields(value, ("type", "metadata_asset"))
    require(value["type"] == "github-releases", "unsupported release source")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json", value["metadata_asset"]),
            "release metadata asset must be a simple JSON filename")


def validate_target(value):
    fields(value, ("host", "package_id", "surfaces", "capabilities"))
    host = value["host"]
    require(host in HOSTS and ID.fullmatch(value["package_id"]), "invalid host or package identity")
    require(strings(value["surfaces"], 80) and set(value["surfaces"]) <= SURFACES[host],
            "invalid UI surface ceiling")
    require(strings(value["capabilities"], 160), "capabilities must be a unique string array")
    require(all(ID.fullmatch(capability) and (host == "zboard") == capability.startswith("zboard.")
                for capability in value["capabilities"]), "capability belongs to another host or is invalid")


def validate_product(value):
    fields(value, ("id", "name", "description", "categories", "license", "maintainers", "repository",
                   "publisher", "release_source", "targets"),
           ("homepage", "documentation", "security", "icon", "screenshots", "withdrawn"))
    require(ID.fullmatch(value["id"]), "invalid product ID")
    require(text(value["name"], 160) and text(value["description"]) and text(value["license"], 160),
            "invalid product information")
    require(strings(value["categories"], 80) and len(value["categories"]) <= 10
            and all(ID.fullmatch(item) for item in value["categories"]), "invalid categories")
    require(strings(value["maintainers"], 160) and 0 < len(value["maintainers"]) <= 20,
            "invalid maintainers")
    github_repository(value["repository"])
    validate_publisher(value["publisher"])
    validate_release_source(value["release_source"])
    for key in ("homepage", "documentation", "security", "icon"):
        if key in value:
            https(value[key])
    if "screenshots" in value:
        require(strings(value["screenshots"]) and len(value["screenshots"]) <= 8, "invalid screenshots")
        for screenshot in value["screenshots"]:
            https(screenshot)
    require(isinstance(value["targets"], list) and 0 < len(value["targets"]) <= len(HOSTS),
            "product must declare at least one host target")
    seen = set()
    for target in value["targets"]:
        validate_target(target)
        require(target["host"] not in seen, "duplicate host target")
        seen.add(target["host"])
    require(value.get("withdrawn") in (None, True), "withdrawn is either absent or true")


def validate_artifact(value, repository, tag):
    fields(value, ("os", "arch", "url", "size", "sha256", "signature"))
    require(value["os"] in OPERATING_SYSTEMS and value["arch"] in ARCHITECTURES, "unsupported platform")
    require(value["os"] == "any" or value["arch"] != "any", "specific operating systems require an architecture")
    require(isinstance(value["size"], int) and 0 < value["size"] <= 128 * 1024 * 1024, "invalid artifact size")
    require(DIGEST.fullmatch(value["sha256"]), "invalid artifact digest")
    fields(value["signature"], ("algorithm", "value"))
    require(value["signature"]["algorithm"] == "ed25519" and text(value["signature"]["value"], 256),
            "invalid artifact signature")
    parsed = https(value["url"])
    expected = urlsplit(repository)
    prefix = expected.path.rstrip("/") + "/releases/download/" + tag + "/"
    require(parsed.hostname == "github.com" and parsed.path.startswith(prefix)
            and "/" not in parsed.path[len(prefix):], "artifact must be an immutable asset in this release")


def validate_release_manifest(value, product=None):
    fields(value, ("schema_version", "product_id", "repository", "publisher", "source", "release"), ("listing",))
    require(value["schema_version"] == 1 and ID.fullmatch(value["product_id"]), "unsupported release manifest")
    github_repository(value["repository"])
    validate_publisher(value["publisher"])
    fields(value["source"], ("tag", "commit"))
    require(re.fullmatch(r"v" + SEMVER.pattern, value["source"]["tag"]) and COMMIT.fullmatch(value["source"]["commit"]),
            "invalid release source")
    release = value["release"]
    fields(release, ("version", "channel", "published_at", "notes_url", "targets"))
    require(SEMVER.fullmatch(release["version"]) and value["source"]["tag"] == "v" + release["version"],
            "version and tag differ")
    require(release["channel"] in CHANNELS and text(release["published_at"], 40), "invalid channel or timestamp")
    https(release["notes_url"])
    require(isinstance(release["targets"], list) and 0 < len(release["targets"]) <= len(HOSTS),
            "release must contain target packages")
    registration = {item["host"]: item for item in (product or {}).get("targets", [])}
    seen = set()
    for target in release["targets"]:
        fields(target, ("host", "package_id", "host_version", "surfaces", "capabilities", "artifacts"))
        host = target["host"]
        require(host in HOSTS and host not in seen and ID.fullmatch(target["package_id"]), "invalid or duplicate release target")
        seen.add(host)
        fields(target["host_version"], ("min",), ("max_exclusive",))
        require(SEMVER.fullmatch(target["host_version"]["min"]), "invalid minimum host version")
        if "max_exclusive" in target["host_version"]:
            require(SEMVER.fullmatch(target["host_version"]["max_exclusive"]), "invalid maximum host version")
        require(strings(target["surfaces"], 80) and set(target["surfaces"]) <= SURFACES[host], "invalid release surfaces")
        require(strings(target["capabilities"], 160)
                and all(ID.fullmatch(item) and (host == "zboard") == item.startswith("zboard.")
                        for item in target["capabilities"]), "invalid release capabilities")
        require(isinstance(target["artifacts"], list) and 0 < len(target["artifacts"]) <= 20,
                "release target needs artifacts")
        platforms = set()
        for artifact in target["artifacts"]:
            validate_artifact(artifact, value["repository"], value["source"]["tag"])
            platform = (artifact["os"], artifact["arch"])
            require(platform not in platforms, "duplicate target platform")
            platforms.add(platform)
        if product:
            require(host in registration and registration[host]["package_id"] == target["package_id"],
                    "release target is not registered")
            require(set(target["surfaces"]) <= set(registration[host]["surfaces"]), "release exceeds surface ceiling")
            require(set(target["capabilities"]) <= set(registration[host]["capabilities"]),
                    "release exceeds capability ceiling")
    if product:
        require(value["product_id"] == product["id"] and value["repository"] == product["repository"]
                and value["publisher"] == product["publisher"], "release trust identity differs from registration")
    if "listing" in value:
        validate_product(value["listing"])
        require(value["listing"]["id"] == value["product_id"]
                and value["listing"]["repository"] == value["repository"]
                and value["listing"]["publisher"] == value["publisher"], "onboarding listing identity differs from release")
        validate_release_manifest({key: item for key, item in value.items() if key != "listing"}, value["listing"])


def read_zboard(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) > 514 or len(set(name.lower() for name in names)) != len(names):
            raise ValueError("unsafe or duplicate ZBoard package paths")
        manifest = json.loads(archive.read("manifest.json"))
        signature = json.loads(archive.read("signature.json"))
    return {"host": "zboard", "package_id": manifest["id"], "version": manifest["version"],
            "surfaces": manifest.get("surfaces", []), "capabilities": manifest.get("capabilities", []),
            "signature": signature["signature"]}


def read_znet_sink(path):
    envelope = json.loads(path.read_text())
    if envelope.get("format") != "znet-sink.plugin-package.v1":
        raise ValueError("unsupported ZNet Sink package")
    payload = json.loads(base64.b64decode(envelope["payload"], validate=True))
    if payload.get("host") != "znet-sink" or not payload.get("components"):
        raise ValueError("invalid ZNet Sink package identity")
    capabilities = set()
    for component in payload["components"]:
        manifest = component["manifest"]
        if manifest["plugin_id"] != payload["plugin_id"] or manifest["version"] != payload["version"]:
            raise ValueError("ZNet Sink component identity differs from package")
        capabilities.update(permission["capability"] for permission in manifest.get("required", []))
        capabilities.update(permission["capability"] for permission in manifest.get("optional", []))
    return {"host": "znet-sink", "package_id": payload["plugin_id"], "version": payload["version"],
            "surfaces": [], "capabilities": sorted(capabilities), "signature": envelope["signature"]}


def inspect(path):
    if path.suffix == ".zbplugin":
        return read_zboard(path)
    if path.suffix == ".zspkg":
        return read_znet_sink(path)
    raise ValueError("package extension must be .zbplugin or .zspkg")


def build(spec, root):
    grouped = {}
    version = None
    for record in spec["artifacts"]:
        path = (root / record["path"]).resolve()
        package = inspect(path)
        if version is None:
            version = package["version"]
        if package["version"] != version:
            raise ValueError("all packages in one release must use the same version")
        target = grouped.setdefault(package["host"], {
            "host": package["host"], "package_id": package["package_id"],
            "host_version": spec["host_versions"][package["host"]],
            "surfaces": package["surfaces"], "capabilities": package["capabilities"], "artifacts": [],
        })
        if target["package_id"] != package["package_id"] or target["surfaces"] != package["surfaces"] \
                or target["capabilities"] != package["capabilities"]:
            raise ValueError("packages for one target must declare identical identity and boundaries")
        data = path.read_bytes()
        target["artifacts"].append({
            "os": record["os"], "arch": record["arch"], "url": record["url"],
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "signature": {"algorithm": "ed25519", "value": package["signature"]},
        })
    if version is None:
        raise ValueError("at least one signed package is required")
    document = {
        "schema_version": 1, "product_id": spec["product_id"], "repository": spec["repository"],
        "publisher": spec["publisher"], "source": {"tag": "v" + version, "commit": spec["source_commit"]},
        "release": {"version": version, "channel": spec["channel"], "published_at": spec["published_at"],
                    "notes_url": spec["notes_url"], "targets": [grouped[key] for key in sorted(grouped)]},
    }
    if "listing" in spec:
        document["listing"] = spec["listing"]
    validate_release_manifest(document)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--output", type=Path, default=Path("marketplace-entry.json"))
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    document = build(spec, args.spec.parent)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    print(args.output)


if __name__ == "__main__":
    main()
