"""Promote a successful main build without compiling or executing its binaries."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

TARGETS = ("macos-arm64", "linux-amd64", "openbsd-8.0-amd64")
JOBS = (*TARGETS, "linux-ui-build", "linux-ui-chrome", "linux-ui-firefox",
        "linux-ui-webkit", "linux-package")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pages(get, path, key, **query):
    result = []
    page = 1
    while True:
        items = get(path + "?" + urlencode(dict(query, per_page=100, page=page)))[key]
        result.extend(items)
        if len(items) < 100:
            return result
        page += 1


def select_build(repo, commit, get, now=None):
    now = now or datetime.now(timezone.utc)
    runs = pages(get, "/actions/workflows/build.yml/runs", "workflow_runs",
                 branch="main", event="push", head_sha=commit, status="success")
    for run in runs:
        if not (run["head_sha"] == commit and run["head_branch"] == "main"
                and run["event"] == "push" and run["status"] == "completed"
                and run["conclusion"] == "success"
                and run["path"] == ".github/workflows/build.yml"
                and run["head_repository"]["full_name"].lower() == repo.lower()):
            continue
        run_id = run["id"]
        jobs = pages(get, f"/actions/runs/{run_id}/jobs", "jobs", filter="latest")
        required = [[job for job in jobs if job["name"] == name] for name in JOBS]
        if not all(len(matches) == 1 and matches[0]["status"] == "completed"
                   and matches[0]["conclusion"] == "success" for matches in required):
            continue
        artifacts = pages(get, f"/actions/runs/{run_id}/artifacts", "artifacts")
        selected = []
        for target in TARGETS:
            matches = [a for a in artifacts if a["name"] == "feedtorrent-" + target]
            if len(matches) != 1:
                break
            artifact = matches[0]
            if (artifact["expired"] or artifact["size_in_bytes"] <= 0
                    or datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00")) <= now
                    or artifact["workflow_run"]["id"] != run_id
                    or artifact["workflow_run"]["head_sha"] != commit):
                break
            selected.append(artifact["id"])
        if len(selected) == len(TARGETS):
            return {"run_id": run_id, "run_url": run["html_url"], "artifact_ids": selected}
    raise RuntimeError(f"No complete successful main/push build with three unexpired packages for {commit}. "
                       "Let main finish successfully (or rebuild main if artifacts expired), then rerun this release workflow.")


def inspect_package(path, commit, version, target):
    root = f"feedtorrent-{commit[:12]}-{target}"
    expected = path.with_name(path.name + ".sha256").read_text()
    require(expected == f"{sha(path.read_bytes())}  {path.name}\n", f"Invalid checksum: {path.name}")
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            name = member.name.rstrip("/")
            parts = name.split("/")
            require(parts[0] == root and all(p not in ("", ".", "..") for p in parts)
                    and not PurePosixPath(name).is_absolute()
                    and (member.isfile() or member.isdir()) and name not in names,
                    f"Unsafe or duplicate archive entry: {member.name}")
            names.add(name)
        for name in ("feedtorrent", "BUILD-INFO.json", "THIRD_PARTY.json"):
            require(root + "/" + name in names and archive.getmember(root + "/" + name).isfile(),
                    f"Missing package file: {name}")
        require(any(m.isfile() and m.name.startswith(root + "/licenses/") for m in members),
                "Missing package licenses")
        binary = archive.getmember(root + "/feedtorrent")
        require(stat.S_IMODE(binary.mode) == 0o755, "Executable permissions differ from the tested package")
        info = json.load(archive.extractfile(root + "/BUILD-INFO.json"))
        require(info["commit"] == commit and info["version"] == version and info["target"] == target
                and info["tag"] is None and info["dirty"] is False, "Package commit/version/target/clean state mismatch")
        require(re.fullmatch(r"[0-9a-f]{64}", info["source_sha256"]), "Invalid source hash")
        require(sha(archive.extractfile(binary).read()) == info["binary_sha256"], "Executable hash mismatch")
        return info


def promote_packages(packages, output, plan):
    commit, tag = plan["commit"], plan["tag"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid commit")
    require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", tag), "Invalid release tag")
    require(tag == "v" + plan["version"], "Release tag differs from workspace version")
    expected = {f"feedtorrent-{commit[:12]}-{target}.tar.gz" for target in TARGETS}
    require({p.name for p in packages.iterdir()} == expected | {name + ".sha256" for name in expected},
            "Expected exactly three final packages and their checksums")
    infos = [inspect_package(packages / f"feedtorrent-{commit[:12]}-{target}.tar.gz", commit, tag, target)
             for target in TARGETS]
    require(len({info["source_sha256"] for info in infos}) == 1, "Packages have different source hashes")
    output.mkdir(exist_ok=True)
    require(not any(output.iterdir()), "Release output must be empty")
    # Check every package before creating publishable output. Never extract paths from an archive.
    with tempfile.TemporaryDirectory(prefix=".promotion-", dir=output.parent) as temp:
        stage = Path(temp)
        for target, info in zip(TARGETS, infos):
            old_root = f"feedtorrent-{commit[:12]}-{target}"
            new_root = f"feedtorrent-{tag}-{target}"
            name = new_root + ".tar.gz"
            info = dict(info, tag=tag, promotion={"run_id": plan["run_id"], "run_url": plan["run_url"]})
            with tarfile.open(packages / (old_root + ".tar.gz"), "r:gz") as source, tarfile.open(stage / name, "w:gz") as dest:
                for member in source.getmembers():
                    changed = copy.copy(member)
                    changed.name = new_root + member.name[len(old_root):]
                    changed.pax_headers = {}  # Recompute path/size headers for the renamed root.
                    data = source.extractfile(member) if member.isfile() else None
                    if member.name == old_root + "/BUILD-INFO.json":
                        payload = (json.dumps(info, indent=2) + "\n").encode()
                        data = io.BytesIO(payload)
                        changed.size = len(payload)
                    dest.addfile(changed, data)
                    if data is not None:
                        data.close()
            (stage / (name + ".sha256")).write_text(f"{sha((stage / name).read_bytes())}  {name}\n")
            with tarfile.open(stage / name, "r:gz") as final:
                require(sha(final.extractfile(new_root + "/feedtorrent").read()) == info["binary_sha256"],
                        "Promoted executable changed")
        for path in stage.iterdir():
            path.replace(output / path.name)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Refusing to redirect authenticated GitHub API request")


def main():
    plan_path = Path(".runtime/promotion.json")
    if sys.argv[1:] == ["select"]:
        repo = os.environ["GH_REPO"]
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository")
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        version = tomllib.loads(Path("Cargo.toml").read_text())["workspace"]["package"]["version"]
        tag = os.environ["RELEASE_TAG"]
        require(tag == "v" + version, "Release tag differs from workspace version")
        opener = build_opener(NoRedirect)

        def get(path):
            request = Request("https://api.github.com/repos/" + repo + path,
                              headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                       "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
            with opener.open(request, timeout=30) as response:
                return json.load(response)

        selected = select_build(repo, commit, get)
        plan = dict(selected, commit=commit, version=version, tag=tag)
        plan_path.parent.mkdir(exist_ok=True)
        plan_path.write_text(json.dumps(plan, indent=2) + "\n")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"run-id={selected['run_id']}\nartifact-ids={','.join(map(str, selected['artifact_ids']))}\n")
        print(f"Promoting {commit} from {selected['run_url']}")
    elif sys.argv[1:] == ["packages"]:
        promote_packages(Path("packages"), Path("dist"), json.loads(plan_path.read_text()))
    else:
        raise RuntimeError("Usage: python3 dev/ci/promote.py select|packages")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
