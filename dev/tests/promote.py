"""Release promotion contracts; synthetic archives and GitHub responses, no network/publishing."""
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import stat
import tarfile
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("promotion", "dev/ci/promote.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
COMMIT = "a" * 40
OTHER = "b" * 40
REPO = "owner/repo"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def run(number=1):
    return dict(id=number, head_sha=COMMIT, head_branch="main", event="push", status="completed",
                conclusion="success", path=".github/workflows/build.yml", head_repository={"full_name": REPO},
                html_url=f"https://github.com/{REPO}/actions/runs/{number}")


def jobs():
    return [dict(name=name, status="completed", conclusion="success") for name in p.JOBS]


def artifacts(number=1):
    return [dict(id=number * 10 + i, name="feedtorrent-" + target, expired=False, size_in_bytes=100,
                 expires_at="2026-01-15T00:00:00Z", workflow_run=dict(id=number, head_sha=COMMIT))
            for i, target in enumerate(p.TARGETS)]


class Selection(unittest.TestCase):
    def select(self, runs=None, job_list=None, artifact_list=None):
        self.calls = []

        def get(url):
            self.calls.append(url)
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["per_page"], ["100"])
            if url.startswith("/actions/workflows/"):
                self.assertEqual(query["head_sha"], [COMMIT])
                self.assertEqual(query["branch"], ["main"])
                self.assertEqual(query["event"], ["push"])
                return {"workflow_runs": [run()] if runs is None else runs}
            if "/jobs?" in url:
                self.assertEqual(query["filter"], ["latest"])
                return {"jobs": jobs() if job_list is None else job_list}
            return {"artifacts": artifacts() if artifact_list is None else artifact_list}

        return p.select_build(REPO, COMMIT, get, NOW)

    def test_exact_successful_build_selects_only_final_artifacts(self):
        result = self.select(artifact_list=artifacts() + [dict(name="candidate-linux-amd64")])
        self.assertEqual(result["run_id"], 1)
        self.assertEqual(result["artifact_ids"], [10, 11, 12])

    def test_wrong_commit_repo_event_branch_workflow_and_non_success_are_ineligible(self):
        for change in [dict(head_sha=OTHER), dict(head_branch="feature"), dict(event="workflow_dispatch"),
                       dict(status="in_progress"), dict(conclusion="failure"), dict(path="other.yml"),
                       dict(head_repository={"full_name": "fork/repo"})]:
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, "No complete successful"):
                self.select(runs=[dict(run(), **change)])
        with self.assertRaises(RuntimeError):
            self.select(runs=[])

    def test_missing_failed_or_skipped_required_job_is_not_validation(self):
        for changed in [jobs()[:-1], jobs() + [jobs()[0]]]:
            with self.assertRaises(RuntimeError):
                self.select(job_list=changed)
        for conclusion in ["failure", "skipped", "cancelled", None]:
            changed = jobs()
            changed[4]["conclusion"] = conclusion
            with self.subTest(conclusion=conclusion), self.assertRaises(RuntimeError):
                self.select(job_list=changed)

    def test_expired_missing_empty_duplicate_or_different_commit_artifacts_rejected(self):
        for change in [dict(expired=True), dict(size_in_bytes=0), dict(expires_at="2025-12-31T00:00:00Z"),
                       dict(workflow_run=dict(id=2, head_sha=COMMIT)), dict(workflow_run=dict(id=1, head_sha=OTHER))]:
            changed = artifacts()
            changed[1].update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.select(artifact_list=changed)
        for changed in [artifacts()[:-1], artifacts() + [artifacts()[0]]]:
            with self.assertRaises(RuntimeError):
                self.select(artifact_list=changed)

    def test_pagination_and_older_eligible_run(self):
        calls = []

        def get(url):
            calls.append(url)
            page = int(parse_qs(urlsplit(url).query)["page"][0])
            if "/workflows/" in url:
                return {"workflow_runs": [dict(run(i), conclusion="failure") for i in range(100)] if page == 1 else [run(2)]}
            if "/jobs?" in url:
                return {"jobs": jobs()}
            return {"artifacts": [dict(name="diagnostic")] * 100 if page == 1 else artifacts(2)}

        self.assertEqual(p.select_build(REPO, COMMIT, get, NOW)["artifact_ids"], [20, 21, 22])
        self.assertEqual(sum("page=2" in url for url in calls), 2)


class Packages(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feedtorrent-promotion-test-")
        self.root = Path(self.temp.name)
        self.packages = self.root / "packages"
        self.packages.mkdir()
        self.output = self.root / "dist"
        self.plan = dict(commit=COMMIT, tag="v1.2.3-rc47", version="1.2.3-rc47", run_id=1, run_url=run()["html_url"])
        for target in p.TARGETS:
            self.archive(target)

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, target, info_changes=None, corrupt_binary=False, unsafe=None, mode=0o755):
        root = f"feedtorrent-{COMMIT[:12]}-{target}"
        path = self.packages / (root + ".tar.gz")
        binary = b"foreign executable: never run during promotion " + target.encode()
        info = dict(commit=COMMIT, version=self.plan["tag"], tag=None, dirty=False, target=target,
                    binary_sha256=p.sha(binary), source_sha256="c" * 64, tools={"rustc": "original"},
                    dependencies=["original base library"], native={"webtorrent": True})
        info.update(info_changes or {})
        files = {"feedtorrent": binary + (b"corrupt" if corrupt_binary else b""),
                 "BUILD-INFO.json": json.dumps(info).encode(), "THIRD_PARTY.json": b'{"license":"same"}',
                 "licenses/MIT.txt": b"original license"}
        with tarfile.open(path, "w:gz") as tar:
            directory = tarfile.TarInfo(root)
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            tar.addfile(directory)
            for name, data in files.items():
                entry = tarfile.TarInfo(root + "/" + name)
                entry.size = len(data)
                entry.mode = mode if name == "feedtorrent" else 0o644
                tar.addfile(entry, io.BytesIO(data))
            if unsafe:
                name, kind = unsafe
                entry = tarfile.TarInfo(name.replace("ROOT", root))
                entry.type = kind
                entry.linkname = "/tmp/outside"
                tar.addfile(entry)
        Path(str(path) + ".sha256").write_text(f"{p.sha(path.read_bytes())}  {path.name}\n")
        return files

    def promote(self):
        p.promote_packages(self.packages, self.output, self.plan)

    def test_promotes_all_targets_preserving_bytes_permissions_licenses_and_provenance(self):
        # BSD tar can include the regular-file type bits in the mode field.
        self.archive(p.TARGETS[-1], mode=0o100755)
        before = {path.name: path.read_bytes() for path in self.packages.iterdir()}
        self.promote()
        self.assertEqual(len(list(self.output.iterdir())), 6)
        self.assertEqual({path.name: path.read_bytes() for path in self.packages.iterdir()}, before)
        for target in p.TARGETS:
            path = self.output / f"feedtorrent-{self.plan['tag']}-{target}.tar.gz"
            self.assertEqual(Path(str(path) + ".sha256").read_text(), f"{p.sha(path.read_bytes())}  {path.name}\n")
            with tarfile.open(path) as tar:
                root = path.name.removesuffix(".tar.gz")
                self.assertEqual(tar.extractfile(root + "/feedtorrent").read(), b"foreign executable: never run during promotion " + target.encode())
                self.assertEqual(stat.S_IMODE(tar.getmember(root + "/feedtorrent").mode), 0o755)
                self.assertEqual(tar.extractfile(root + "/licenses/MIT.txt").read(), b"original license")
                self.assertEqual(tar.extractfile(root + "/THIRD_PARTY.json").read(), b'{"license":"same"}')
                info = json.load(tar.extractfile(root + "/BUILD-INFO.json"))
                self.assertEqual(info["tag"], self.plan["tag"])
                self.assertEqual(info["commit"], COMMIT)
                self.assertEqual(info["tools"], {"rustc": "original"})
                self.assertEqual(info["promotion"]["run_id"], 1)

    def test_metadata_binary_and_mode_mismatch_leave_no_publishable_output(self):
        for change in [dict(commit=OTHER), dict(version="v9.9.9"), dict(target="wrong"), dict(dirty=True),
                       dict(tag="v1.2.3-rc47"), dict(source_sha256="d" * 64)]:
            self.archive(p.TARGETS[-1], info_changes=change)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.promote()
            self.assertFalse(self.output.exists())
        for options in [dict(corrupt_binary=True), dict(mode=0o644)]:
            self.archive(p.TARGETS[-1], **options)
            with self.assertRaises(RuntimeError):
                self.promote()
            self.assertFalse(self.output.exists())

    def test_traversal_links_duplicate_and_foreign_roots_rejected_without_extraction(self):
        for name, kind in [("ROOT/../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("other/file", tarfile.REGTYPE), ("ROOT/link", tarfile.SYMTYPE),
                           ("ROOT/link", tarfile.LNKTYPE), ("ROOT/feedtorrent", tarfile.REGTYPE)]:
            self.archive(p.TARGETS[-1], unsafe=(name, kind))
            with self.subTest(name=name, kind=kind), self.assertRaises(RuntimeError):
                self.promote()
            self.assertFalse(self.output.exists())

    def test_select_cli_records_exact_download_ids_and_packages_cli_uses_that_plan(self):
        class Response(io.BytesIO):
            pass

        class Opener:
            def open(inner, request, timeout):
                self.assertEqual(timeout, 30)
                self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
                if "/workflows/" in request.full_url:
                    value = {"workflow_runs": [run()]}
                elif "/jobs?" in request.full_url:
                    value = {"jobs": jobs()}
                else:
                    value = {"artifacts": artifacts()}
                return Response(json.dumps(value).encode())

        (self.root / "Cargo.toml").write_text('[workspace.package]\nversion = "1.2.3-rc47"\n')
        output = self.root / "github-output"
        output.write_text("existing-output=keep\n")
        real_select = p.select_build
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, GH_REPO=REPO, GH_TOKEN="fixture-token", RELEASE_TAG=self.plan["tag"],
                            GITHUB_OUTPUT=str(output)), patch.object(sys, "argv", ["promote.py", "select"]), \
                    patch.object(p.subprocess, "check_output", return_value=COMMIT + "\n"), \
                    patch.object(p, "build_opener", return_value=Opener()), \
                    patch.object(p, "select_build", side_effect=lambda repo, commit, get: real_select(repo, commit, get, NOW)):
                p.main()
            self.assertEqual(output.read_text(), "existing-output=keep\nrun-id=1\nartifact-ids=10,11,12\n")
            with patch.object(sys, "argv", ["promote.py", "packages"]):
                p.main()
            self.assertEqual(len(list(self.output.iterdir())), 6)
        finally:
            os.chdir(previous)

    def test_select_cli_rejects_a_different_version_before_contacting_github(self):
        (self.root / "Cargo.toml").write_text('[workspace.package]\nversion = "9.9.9"\n')
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, GH_REPO=REPO, RELEASE_TAG=self.plan["tag"]), \
                    patch.object(sys, "argv", ["promote.py", "select"]), \
                    patch.object(p.subprocess, "check_output", return_value=COMMIT + "\n"), \
                    patch.object(p, "build_opener") as opener, self.assertRaisesRegex(RuntimeError, "workspace version"):
                p.main()
            opener.assert_not_called()
            self.assertFalse((self.root / ".runtime/promotion.json").exists())
        finally:
            os.chdir(previous)

    def test_tag_checksum_incomplete_and_extra_payloads_rejected(self):
        self.plan["tag"] = "v8.8.8"
        with self.assertRaises(RuntimeError):
            self.promote()
        self.plan["tag"] = "v1.2.3-rc47"
        extra = self.packages / "extra"
        extra.write_text("unexpected")
        with self.assertRaises(RuntimeError):
            self.promote()
        extra.unlink()
        checksum = next(self.packages.glob("*.sha256"))
        checksum.write_text("0" * 64 + "  wrong-name\n")
        with self.assertRaises(RuntimeError):
            self.promote()
        checksum.unlink()
        with self.assertRaises(RuntimeError):
            self.promote()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
