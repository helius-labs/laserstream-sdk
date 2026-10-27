#!/usr/bin/env python3
"""Keep SDK versions aligned and reject versions already published."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
TEMPLATE_VERSION = "0.0.0"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
NPM_PACKAGES = [
    "helius-laserstream",
    "helius-laserstream-darwin-arm64",
    "helius-laserstream-darwin-x64",
    "helius-laserstream-linux-arm64-gnu",
    "helius-laserstream-linux-arm64-musl",
    "helius-laserstream-linux-x64-gnu",
    "helius-laserstream-linux-x64-musl",
]


def canonical_version() -> str:
    version = VERSION_FILE.read_text().strip()
    if not SEMVER.fullmatch(version):
        raise ValueError(f"VERSION must contain MAJOR.MINOR.PATCH, found {version!r}")
    return version


def package_version(path: Path, package_name: str) -> str:
    data = tomllib.loads(path.read_text())
    for package in data["package"]:
        if package["name"] == package_name:
            return package["version"]
    raise ValueError(f"{path}: package {package_name!r} not found")


def recorded_versions() -> dict[str, str]:
    package_json = json.loads((ROOT / "javascript/package.json").read_text())
    package_lock = json.loads((ROOT / "javascript/package-lock.json").read_text())
    js_cargo = tomllib.loads((ROOT / "javascript/Cargo.toml").read_text())
    rust_cargo = tomllib.loads((ROOT / "rust/Cargo.toml").read_text())
    versions = {
        "javascript/package.json": package_json["version"],
        "javascript/package-lock.json": package_lock["version"],
        "javascript/package-lock.json root package": package_lock["packages"][""]["version"],
        "javascript/Cargo.toml": js_cargo["package"]["version"],
        "javascript/Cargo.lock": package_version(
            ROOT / "javascript/Cargo.lock", "laserstream-napi"
        ),
        "rust/Cargo.toml": rust_cargo["package"]["version"],
        "rust/Cargo.lock": package_version(
            ROOT / "rust/Cargo.lock", "helius-laserstream"
        ),
    }
    for package_name, version in package_json["optionalDependencies"].items():
        versions[f"javascript/package.json optionalDependency {package_name}"] = version
    for package_name, version in package_lock["packages"][""][
        "optionalDependencies"
    ].items():
        versions[f"javascript/package-lock.json optionalDependency {package_name}"] = version
    return versions


def check_versions() -> None:
    expected = canonical_version()
    check_recorded_versions(expected)
    print(f"All rendered SDK versions match {expected}")


def check_templates() -> None:
    check_recorded_versions(TEMPLATE_VERSION)
    print("All SDK manifests contain version templates")


def check_recorded_versions(expected: str) -> None:
    mismatches = {
        location: actual
        for location, actual in recorded_versions().items()
        if actual != expected
    }
    if mismatches:
        for location, actual in mismatches.items():
            print(f"{location}: expected {expected}, found {actual}", file=sys.stderr)
        raise SystemExit(1)


def replace_once(path: Path, pattern: str, replacement: str) -> None:
    content = path.read_text()
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ValueError(f"{path}: expected one version field, replaced {count}")
    path.write_text(updated)


def write_rendered_version(version: str) -> None:
    package_path = ROOT / "javascript/package.json"
    package_data = json.loads(package_path.read_text())
    package_data["version"] = version
    for package_name in package_data["optionalDependencies"]:
        package_data["optionalDependencies"][package_name] = version
    package_path.write_text(json.dumps(package_data, indent=2) + "\n")

    lock_path = ROOT / "javascript/package-lock.json"
    lock_data = json.loads(lock_path.read_text())
    lock_data["version"] = version
    lock_data["packages"][""]["version"] = version
    for package_name in lock_data["packages"][""]["optionalDependencies"]:
        lock_data["packages"][""]["optionalDependencies"][package_name] = version
    lock_path.write_text(json.dumps(lock_data, indent=2) + "\n")

    replace_once(
        ROOT / "javascript/Cargo.toml",
        r'(?s)(\[package\].*?\nversion = ")[^"]+("\n)',
        rf"\g<1>{version}\g<2>",
    )
    replace_once(
        ROOT / "javascript/Cargo.lock",
        r'(?s)(\[\[package\]\]\nname = "laserstream-napi"\nversion = ")[^"]+("\n)',
        rf"\g<1>{version}\g<2>",
    )
    replace_once(
        ROOT / "rust/Cargo.toml",
        r'(?s)(\[package\].*?\nversion = ")[^"]+("\n)',
        rf"\g<1>{version}\g<2>",
    )
    replace_once(
        ROOT / "rust/Cargo.lock",
        r'(?s)(\[\[package\]\]\nname = "helius-laserstream"\nversion = ")[^"]+("\n)',
        rf"\g<1>{version}\g<2>",
    )


def set_version(version: str) -> None:
    if not SEMVER.fullmatch(version):
        raise ValueError(f"version must be MAJOR.MINOR.PATCH, found {version!r}")
    VERSION_FILE.write_text(f"{version}\n")
    check_templates()


def render_version() -> None:
    version = canonical_version()
    check_templates()
    write_rendered_version(version)
    check_versions()


def restore_templates() -> None:
    write_rendered_version(TEMPLATE_VERSION)
    check_templates()


def url_exists(url: str) -> bool:
    request = urllib.request.Request(url, headers={"User-Agent": "laserstream-sdk-release-check"})
    try:
        with urllib.request.urlopen(request, timeout=30):
            return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def check_available() -> None:
    version = canonical_version()
    check_templates()
    published = []

    for package_name in NPM_PACKAGES:
        encoded_name = urllib.parse.quote(package_name, safe="@")
        if url_exists(f"https://registry.npmjs.org/{encoded_name}/{version}"):
            published.append(f"npm:{package_name}@{version}")

    if url_exists(
        f"https://crates.io/api/v1/crates/helius-laserstream/{version}"
    ):
        published.append(f"crates.io:helius-laserstream@{version}")

    go_tag = f"refs/tags/go/v{version}"
    result = subprocess.run(
        ["git", "ls-remote", "--exit-code", "--tags", "origin", go_tag],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        published.append(f"go:{go_tag}")
    elif result.returncode != 2:
        raise RuntimeError(f"git ls-remote failed: {result.stderr.strip()}")

    if published:
        print("Version is already published:", file=sys.stderr)
        for package in published:
            print(f"  {package}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Version {version} is available on npm, crates.io, and Go")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check")
    subparsers.add_parser("check-template")
    subparsers.add_parser("check-available")
    subparsers.add_parser("render")
    subparsers.add_parser("restore-template")
    set_parser = subparsers.add_parser("set")
    set_parser.add_argument("version")
    args = parser.parse_args()

    if args.command == "check":
        check_versions()
    elif args.command == "check-template":
        check_templates()
    elif args.command == "check-available":
        check_available()
    elif args.command == "render":
        render_version()
    elif args.command == "restore-template":
        restore_templates()
    else:
        set_version(args.version)


if __name__ == "__main__":
    main()
