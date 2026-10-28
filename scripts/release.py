#!/usr/bin/env python3
"""Validate, package, publish, and verify coordinated SDK releases."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
GO_MODULE_BASE = "github.com/helius-labs/laserstream-sdk/go"
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
PLATFORM_PACKAGES = {
    "x86_64-apple-darwin": ("helius-laserstream-darwin-x64", "darwin", "x64", "laserstream-napi.darwin-x64.node"),
    "aarch64-apple-darwin": ("helius-laserstream-darwin-arm64", "darwin", "arm64", "laserstream-napi.darwin-arm64.node"),
    "x86_64-unknown-linux-gnu": ("helius-laserstream-linux-x64-gnu", "linux", "x64", "laserstream-napi.linux-x64-gnu.node"),
    "aarch64-unknown-linux-gnu": ("helius-laserstream-linux-arm64-gnu", "linux", "arm64", "laserstream-napi.linux-arm64-gnu.node"),
    "x86_64-unknown-linux-musl": ("helius-laserstream-linux-x64-musl", "linux", "x64", "laserstream-napi.linux-x64-musl.node"),
    "aarch64-unknown-linux-musl": ("helius-laserstream-linux-arm64-musl", "linux", "arm64", "laserstream-napi.linux-arm64-musl.node"),
}


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, value: str) -> "Version":
        match = SEMVER.fullmatch(value)
        if match is None:
            raise ValueError(f"version must be MAJOR.MINOR.PATCH, found {value!r}")
        return cls(*(int(part) for part in match.groups()))

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


def run(command: list[str], *, cwd: Path = ROOT, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def canonical_version() -> str:
    return str(Version.parse(VERSION_FILE.read_text().strip()))


def expected_go_module(version: str) -> str:
    major = Version.parse(version).major
    return GO_MODULE_BASE if major < 2 else f"{GO_MODULE_BASE}/v{major}"


def go_module_path() -> str:
    match = re.search(r"^module\s+(\S+)\s*$", (ROOT / "go/go.mod").read_text(), re.MULTILINE)
    if match is None:
        raise ValueError("go/go.mod: module directive not found")
    return match.group(1)


def check_go_module(version: str) -> None:
    expected = expected_go_module(version)
    actual = go_module_path()
    if actual != expected:
        raise ValueError(f"go/go.mod: version {version} requires module {expected!r}, found {actual!r}")

    major_suffix = f"/v{Version.parse(version).major}"
    stale = []
    if expected != GO_MODULE_BASE:
        for pattern in ("*.go", "*.proto"):
            for path in (ROOT / "go").rglob(pattern):
                content = path.read_text()
                for match in re.finditer(re.escape(GO_MODULE_BASE), content):
                    if content[match.end() :].startswith(major_suffix):
                        continue
                    stale.append(path.relative_to(ROOT))
                    break
    if stale:
        names = ", ".join(str(path) for path in sorted(set(stale)))
        raise ValueError(f"Go major-version migration is incomplete in: {names}")


def package_version(path: Path, package_name: str) -> str:
    import tomllib

    data = tomllib.loads(path.read_text())
    for package in data["package"]:
        if package["name"] == package_name:
            return package["version"]
    raise ValueError(f"{path}: package {package_name!r} not found")


def cargo_manifest_version(path: Path) -> str:
    import tomllib

    return tomllib.loads(path.read_text())["package"]["version"]


def recorded_versions() -> dict[str, str]:
    package_json = json.loads((ROOT / "javascript/package.json").read_text())
    package_lock = json.loads((ROOT / "javascript/package-lock.json").read_text())
    versions = {
        "javascript/package.json": package_json["version"],
        "javascript/package-lock.json": package_lock["version"],
        "javascript/package-lock.json root package": package_lock["packages"][""]["version"],
        "javascript/Cargo.toml": cargo_manifest_version(ROOT / "javascript/Cargo.toml"),
        "javascript/Cargo.lock": package_version(ROOT / "javascript/Cargo.lock", "laserstream-napi"),
        "rust/Cargo.toml": cargo_manifest_version(ROOT / "rust/Cargo.toml"),
        "rust/Cargo.lock": package_version(ROOT / "rust/Cargo.lock", "helius-laserstream"),
    }
    for package_name, version in package_json["optionalDependencies"].items():
        versions[f"javascript/package.json optionalDependency {package_name}"] = version
    for package_name, version in package_lock["packages"][""]["optionalDependencies"].items():
        versions[f"javascript/package-lock.json optionalDependency {package_name}"] = version
    return versions


def check_versions() -> None:
    expected = canonical_version()
    check_recorded_versions(expected)
    check_go_module(expected)
    print(f"All rendered SDK versions match {expected}")


def check_templates() -> None:
    check_recorded_versions(TEMPLATE_VERSION)
    check_go_module(canonical_version())
    print("All SDK manifests contain version templates")


def check_recorded_versions(expected: str) -> None:
    mismatches = {
        location: actual for location, actual in recorded_versions().items() if actual != expected
    }
    if mismatches:
        for location, actual in mismatches.items():
            print(f"{location}: expected {expected}, found {actual}", file=sys.stderr)
        raise SystemExit(1)



def replace_once_text(path: Path, content: str, pattern: str, replacement: str) -> str:
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ValueError(f"{path}: expected one version field, replaced {count}")
    return updated


def rendered_version_files(version: str) -> dict[Path, str]:
    Version.parse(version)
    outputs: dict[Path, str] = {}

    package_path = ROOT / "javascript/package.json"
    package_data = json.loads(package_path.read_text())
    package_data["version"] = version
    for package_name in package_data["optionalDependencies"]:
        package_data["optionalDependencies"][package_name] = version
    outputs[package_path] = json.dumps(package_data, indent=2) + "\n"

    lock_path = ROOT / "javascript/package-lock.json"
    lock_data = json.loads(lock_path.read_text())
    lock_data["version"] = version
    lock_data["packages"][""]["version"] = version
    for package_name in lock_data["packages"][""]["optionalDependencies"]:
        lock_data["packages"][""]["optionalDependencies"][package_name] = version
    outputs[lock_path] = json.dumps(lock_data, indent=2) + "\n"

    replacements = [
        (ROOT / "javascript/Cargo.toml", r'(?s)(\[package\].*?\nversion = ")[^"]+("\n)'),
        (ROOT / "javascript/Cargo.lock", r'(?s)(\[\[package\]\]\nname = "laserstream-napi"\nversion = ")[^"]+("\n)'),
        (ROOT / "rust/Cargo.toml", r'(?s)(\[package\].*?\nversion = ")[^"]+("\n)'),
        (ROOT / "rust/Cargo.lock", r'(?s)(\[\[package\]\]\nname = "helius-laserstream"\nversion = ")[^"]+("\n)'),
    ]
    for path, pattern in replacements:
        outputs[path] = replace_once_text(path, path.read_text(), pattern, rf"\g<1>{version}\g<2>")
    return outputs


def write_validated_files(outputs: dict[Path, str]) -> None:
    temporary: list[tuple[Path, Path]] = []
    try:
        for path, content in outputs.items():
            handle, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            temp_path = Path(name)
            with os.fdopen(handle, "w") as file:
                file.write(content)
            temporary.append((path, temp_path))
        for path, temp_path in temporary:
            os.replace(temp_path, path)
    finally:
        for _, temp_path in temporary:
            temp_path.unlink(missing_ok=True)


def set_version(version: str) -> None:
    Version.parse(version)
    check_go_module(version)
    write_validated_files({VERSION_FILE: f"{version}\n"})
    check_templates()


def render() -> None:
    check_templates()
    write_validated_files(rendered_version_files(canonical_version()))
    check_versions()


def restore_templates() -> None:
    write_validated_files(rendered_version_files(TEMPLATE_VERSION))
    check_templates()


def request_json(url: str) -> dict | None:
    request = urllib.request.Request(url, headers={"User-Agent": "laserstream-sdk-release"})
    last_error = "unknown registry error"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code != 429 and error.code < 500:
                raise RuntimeError(f"registry request failed with HTTP {error.code}: {url}") from error
            last_error = f"HTTP {error.code}"
        except urllib.error.URLError as error:
            last_error = str(error.reason)
        if attempt < 3:
            time.sleep(2**attempt)
    raise RuntimeError(f"registry request failed after retries: {url}: {last_error}")


def npm_metadata(package_name: str, version: str) -> dict | None:
    encoded = urllib.parse.quote(package_name, safe="@")
    return request_json(f"https://registry.npmjs.org/{encoded}/{version}")


def crate_metadata(version: str) -> dict | None:
    return request_json(f"https://crates.io/api/v1/crates/helius-laserstream/{version}")


def go_tag_sha(version: str) -> str | None:
    tag = f"refs/tags/go/v{version}"
    peeled = run(["git", "ls-remote", "--tags", "origin", f"{tag}^{{}}"], capture=True).stdout.strip()
    direct = run(["git", "ls-remote", "--tags", "origin", tag], capture=True).stdout.strip()
    line = peeled or direct
    return line.split()[0] if line else None


def check_available() -> None:
    version = canonical_version()
    check_versions()
    published = []
    for package_name in NPM_PACKAGES:
        if npm_metadata(package_name, version) is not None:
            published.append(f"npm:{package_name}@{version}")
    if crate_metadata(version) is not None:
        published.append(f"crates.io:helius-laserstream@{version}")
    if go_tag_sha(version) is not None:
        published.append(f"go:refs/tags/go/v{version}")
    if published:
        print("Version is already published:", file=sys.stderr)
        for package in published:
            print(f"  {package}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Version {version} is available on npm, crates.io, and Go")


def version_at_revision(revision: str) -> str:
    version = subprocess.run(["git", "show", f"{revision}:VERSION"], cwd=ROOT, text=True, capture_output=True)
    if version.returncode == 0:
        return str(Version.parse(version.stdout.strip()))
    cargo = run(["git", "show", f"{revision}:rust/Cargo.toml"], capture=True).stdout
    import tomllib

    return str(Version.parse(tomllib.loads(cargo)["package"]["version"]))


def check_pr_policy(base_sha: str, no_release: bool) -> None:
    current = canonical_version()
    base = version_at_revision(base_sha)
    check_versions()
    if no_release:
        if current != base:
            raise SystemExit(f"PRs labeled no-release must keep VERSION at {base}, found {current}")
        print(f"VERSION remains {current}; registry availability check skipped")
        return
    if Version.parse(current) <= Version.parse(base):
        raise SystemExit(f"release version must be greater than base version {base}, found {current}")
    check_available()


def release_channel(version: str) -> str:
    metadata = npm_metadata("helius-laserstream", "latest")
    if metadata is None:
        return "latest"
    latest = Version.parse(str(metadata["version"]))
    candidate = Version.parse(version)
    return "latest" if candidate > latest else f"release-v{candidate.major}"


def check_release_source(tag: str, sha: str) -> None:
    version = canonical_version()
    check_versions()
    if tag != f"v{version}":
        raise SystemExit(f"release tag {tag} does not match v{version}")
    if run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip() != sha:
        raise SystemExit(f"checked-out commit does not match release SHA {sha}")
    tag_sha = run(["git", "rev-parse", f"refs/tags/{tag}^{{}}"], capture=True).stdout.strip()
    if tag_sha != sha:
        raise SystemExit(f"release tag {tag} points to {tag_sha}, expected {sha}")

    run(["git", "fetch", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    refs = run(
        ["git", "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/origin/release/*"],
        capture=True,
    ).stdout.splitlines()
    if not refs:
        raise SystemExit("no allowed release branches were fetched")
    if not any(
        subprocess.run(["git", "merge-base", "--is-ancestor", sha, ref], cwd=ROOT).returncode == 0
        for ref in refs
    ):
        raise SystemExit(f"release commit {sha} is not on main or a release/* branch")
    print(f"Release {tag} is valid from {sha}; npm dist-tag will be {release_channel(version)}")


def _write_package_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def _pack_directory(directory: Path, output: Path) -> Path:
    result = run(
        ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", str(output)],
        cwd=directory,
        capture=True,
    )
    records = json.loads(result.stdout)
    if len(records) != 1:
        raise RuntimeError(f"npm pack returned {len(records)} records for {directory}")
    tarball = output / records[0]["filename"]
    if not tarball.is_file():
        raise RuntimeError(f"npm pack did not create {tarball}")
    return tarball


def prepare_release(artifacts: Path, output: Path, sha: str, allow_dirty: bool) -> None:
    version = canonical_version()
    check_versions()
    output = output.resolve()
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir(parents=True)

    cargo_command = ["cargo", "package", "--locked"]
    if allow_dirty:
        cargo_command.append("--allow-dirty")
    run(cargo_command, cwd=ROOT / "rust")

    run(["npm", "run", "prepublishOnly"], cwd=ROOT / "javascript")
    staging = Path(tempfile.mkdtemp(prefix="laserstream-npm-", dir=output.parent))
    try:
        for target, (name, os_name, cpu, binary_name) in PLATFORM_PACKAGES.items():
            candidates = list((artifacts / f"bindings-{target}").rglob(binary_name))
            if len(candidates) != 1:
                raise RuntimeError(
                    f"expected one {binary_name} artifact for {target}, found {len(candidates)}"
                )
            package_dir = staging / name
            package_dir.mkdir(parents=True)
            shutil.copy2(candidates[0], package_dir / binary_name)
            _write_package_json(
                package_dir / "package.json",
                {
                    "name": name,
                    "version": version,
                    "description": f"Platform-specific binary for helius-laserstream ({target})",
                    "main": binary_name,
                    "files": ["*.node"],
                    "os": [os_name],
                    "cpu": [cpu],
                    "license": "MIT",
                    "repository": {"type": "git", "url": "git+https://github.com/helius-labs/laserstream.git"},
                    "publishConfig": {"access": "public"},
                    "gitHead": sha,
                },
            )
            _pack_directory(package_dir, output)

        main_dir = staging / "helius-laserstream"
        main_dir.mkdir()
        package_data = json.loads((ROOT / "javascript/package.json").read_text())
        package_data["gitHead"] = sha
        package_data["optionalDependencies"] = {
            package: version for package in package_data["optionalDependencies"]
        }
        _write_package_json(main_dir / "package.json", package_data)
        for relative in package_data["files"]:
            source = ROOT / "javascript" / relative
            destination = main_dir / relative
            if source.is_dir():
                shutil.copytree(source, destination)
            elif source.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
            else:
                raise RuntimeError(f"main npm package file is missing: {relative}")
        for optional in ("README.md", "LICENSE"):
            source = ROOT / "javascript" / optional
            if source.is_file() and not (main_dir / optional).exists():
                shutil.copy2(source, main_dir / optional)
        _pack_directory(main_dir, output)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    tarballs = sorted(output.glob("*.tgz"))
    if len(tarballs) != len(NPM_PACKAGES):
        raise RuntimeError(f"expected {len(NPM_PACKAGES)} npm tarballs, found {len(tarballs)}")
    print(f"Prepared Rust crate and {len(tarballs)} npm tarballs for {version}")


def package_identity(tarball: Path) -> tuple[str, str]:
    with tarfile.open(tarball, "r:gz") as archive:
        file = archive.extractfile("package/package.json")
        if file is None:
            raise RuntimeError(f"{tarball}: package/package.json is missing")
        package = json.load(file)
    return package["name"], package["version"]


def publish_npm(packages: Path, sha: str) -> None:
    version = canonical_version()
    channel = release_channel(version)
    packages = packages.resolve()
    tarballs = []
    for tarball in packages.glob("*.tgz"):
        name, packaged_version = package_identity(tarball)
        if packaged_version != version or name not in NPM_PACKAGES:
            raise RuntimeError(f"unexpected npm tarball {name}@{packaged_version}")
        tarballs.append((name == "helius-laserstream", name, tarball))
    if len(tarballs) != len(NPM_PACKAGES):
        raise RuntimeError(f"expected {len(NPM_PACKAGES)} npm tarballs, found {len(tarballs)}")
    names = {name for _, name, _ in tarballs}
    if names != set(NPM_PACKAGES):
        raise RuntimeError(f"npm tarball set does not match expected packages: {sorted(names)}")

    for _, name, tarball in sorted(tarballs):
        metadata = npm_metadata(name, version)
        if metadata is not None:
            published_sha = metadata.get("gitHead")
            if published_sha != sha:
                raise RuntimeError(f"{name}@{version} came from {published_sha!r}, expected {sha}")
            print(f"{name}@{version} already matches {sha}; skipping")
            continue
        run(["npm", "publish", str(tarball), "--tag", channel, "--access", "public"])
    print(f"Published npm packages with dist-tag {channel}")


def published_crate_sha(version: str) -> str:
    with tempfile.TemporaryDirectory() as directory:
        url = f"https://crates.io/api/v1/crates/helius-laserstream/{version}/download"
        request = urllib.request.Request(url, headers={"User-Agent": "laserstream-sdk-release"})
        archive_path = Path(directory) / "crate.tar.gz"
        with urllib.request.urlopen(request, timeout=30) as response:
            archive_path.write_bytes(response.read())
        with tarfile.open(archive_path, "r:gz") as archive:
            member = next(item for item in archive.getmembers() if item.name.endswith("/.cargo_vcs_info.json"))
            file = archive.extractfile(member)
            if file is None:
                raise RuntimeError("published crate is missing .cargo_vcs_info.json")
            data = json.load(file)
    return data["git"]["sha1"]


def publish_rust(sha: str, allow_dirty: bool) -> None:
    version = canonical_version()
    if crate_metadata(version) is not None:
        published_sha = published_crate_sha(version)
        if published_sha != sha:
            raise RuntimeError(f"helius-laserstream@{version} came from {published_sha}, expected {sha}")
        print(f"helius-laserstream@{version} already matches {sha}; skipping")
        return
    command = ["cargo", "publish", "--locked"]
    if allow_dirty:
        command.append("--allow-dirty")
    run(command, cwd=ROOT / "rust")


def publish_go(sha: str) -> None:
    version = canonical_version()
    tag = f"go/v{version}"
    existing = go_tag_sha(version)
    if existing is not None:
        if existing != sha:
            raise RuntimeError(f"{tag} points to {existing}, expected {sha}")
        print(f"{tag} already matches {sha}; skipping")
        return
    run(["git", "config", "user.name", "github-actions[bot]"])
    run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"])
    run(["git", "tag", "-a", tag, "-m", f"Go SDK v{version}", sha])
    run(["git", "push", "origin", f"refs/tags/{tag}"])


def verify_release(sha: str, attempts: int = 24, delay: int = 10) -> None:
    version = canonical_version()
    for attempt in range(attempts):
        npm_ok = all(
            (metadata := npm_metadata(package, version)) is not None and metadata.get("gitHead") == sha
            for package in NPM_PACKAGES
        )
        crate_ok = crate_metadata(version) is not None
        tag_ok = go_tag_sha(version) == sha
        proxy_ok = subprocess.run(
            ["go", "list", "-m", f"{expected_go_module(version)}@v{version}"],
            cwd=ROOT / "go",
            env={**os.environ, "GOPROXY": "https://proxy.golang.org"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
        if npm_ok and crate_ok and tag_ok and proxy_ok and published_crate_sha(version) == sha:
            print(f"Verified npm, Rust, and Go SDK {version} from {sha}")
            return
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise SystemExit(f"release {version} was not fully visible with provenance {sha}")


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

    policy_parser = subparsers.add_parser("check-pr-policy")
    policy_parser.add_argument("--base-sha", required=True)
    policy_parser.add_argument("--no-release", action="store_true")

    preflight_parser = subparsers.add_parser("preflight-release")
    preflight_parser.add_argument("--tag", required=True)
    preflight_parser.add_argument("--sha", required=True)

    prepare_parser = subparsers.add_parser("prepare-release")
    prepare_parser.add_argument("--artifacts", type=Path, required=True)
    prepare_parser.add_argument("--output", type=Path, required=True)
    prepare_parser.add_argument("--sha", required=True)
    prepare_parser.add_argument("--allow-dirty", action="store_true")

    npm_parser = subparsers.add_parser("publish-npm")
    npm_parser.add_argument("--packages", type=Path, required=True)
    npm_parser.add_argument("--sha", required=True)

    rust_parser = subparsers.add_parser("publish-rust")
    rust_parser.add_argument("--sha", required=True)
    rust_parser.add_argument("--allow-dirty", action="store_true")

    go_parser = subparsers.add_parser("publish-go")
    go_parser.add_argument("--sha", required=True)

    verify_parser = subparsers.add_parser("verify-release")
    verify_parser.add_argument("--sha", required=True)

    args = parser.parse_args()
    if args.command == "check":
        check_versions()
    elif args.command == "check-template":
        check_templates()
    elif args.command == "check-available":
        check_available()
    elif args.command == "render":
        render()
    elif args.command == "restore-template":
        restore_templates()
    elif args.command == "set":
        set_version(args.version)
    elif args.command == "check-pr-policy":
        check_pr_policy(args.base_sha, args.no_release)
    elif args.command == "preflight-release":
        check_release_source(args.tag, args.sha)
    elif args.command == "prepare-release":
        prepare_release(args.artifacts, args.output, args.sha, args.allow_dirty)
    elif args.command == "publish-npm":
        publish_npm(args.packages, args.sha)
    elif args.command == "publish-rust":
        publish_rust(args.sha, args.allow_dirty)
    elif args.command == "publish-go":
        publish_go(args.sha)
    else:
        verify_release(args.sha)


if __name__ == "__main__":
    main()
