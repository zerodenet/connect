#!/usr/bin/env python3
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    "host_apis",
    "server_runtime",
    "device_authorization",
    "subscription_projection",
    "message_synchronization",
    "client_e2e",
}
HOSTS = {"znet-sink", "zboard"}
SHA = re.compile(r"^[0-9a-f]{40}$")


def main():
    path = ROOT / "zboard/release-readiness.json"
    if not path.is_file():
        raise SystemExit(
            "Connect package build is blocked: installed-host acceptance is incomplete"
        )
    value = json.loads(path.read_text())
    if value.get("accepted") is not True or set(value.get("checks", [])) != REQUIRED:
        raise SystemExit("Connect package build is blocked: release readiness is incomplete")
    baselines = value.get("host_baselines")
    if not isinstance(baselines, dict) or set(baselines) != HOSTS:
        raise SystemExit("Connect package build is blocked: clean host baselines are missing")
    for host in sorted(HOSTS):
        baseline = baselines[host]
        if (
            not isinstance(baseline, dict)
            or not SHA.fullmatch(str(baseline.get("commit", "")))
            or baseline.get("clean") is not True
            or baseline.get("package_probe") != "passed"
        ):
            raise SystemExit(
                f"Connect package build is blocked: {host} clean-host evidence is incomplete"
            )
    if value.get("host_source_changes") is not False:
        raise SystemExit(
            "Connect package build is blocked: acceptance must not include host source changes"
        )


if __name__ == "__main__":
    main()
