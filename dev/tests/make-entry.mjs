import assert from "node:assert/strict";
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const runtime = resolve(".runtime");
await mkdir(runtime, { recursive: true });
const root = await mkdtemp(join(runtime, "make-entry-"));
try {
  const project = join(root, "project"), cwd = join(root, "working elsewhere");
  await mkdir(join(project, "dev"), { recursive: true });
  await mkdir(cwd);
  await copyFile("Makefile", join(project, "Makefile"));
  await writeFile(join(project, "dev/build.mk"), `ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
.PHONY: build run clean common
build: common
\t@printf '%s\\n' '$(ROOT)'
run: common
\t@printf '<%s>\\n' '$(CURDIR)' $(ARGS) '$(NATIVE_JOBS)'
common:
\t@printf x >> '$(ROOT)/count'
clean:
\trm '$(ROOT)/keep'
`);
  const env = { ...process.env };
  // Exercise a fresh user invocation, independent of the parent test runner's
  // jobserver and recursive GNU Make directory-reporting flags.
  for (const name of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS"]) delete env[name];
  const make = (args) => execFileSync("make", ["-f", join(project, "Makefile"), ...args], { cwd, env, encoding: "utf8" });
  assert.equal(make([]).trim(), project);
  assert.equal(make(["run", "ARGS='two words' plain", "NATIVE_JOBS=2"]).trim(), `<${cwd}>\n<two words>\n<plain>\n<2>`);
  await writeFile(join(project, "count"), "");
  make(["-j2", "build", "run"]);
  assert.equal(await readFile(join(project, "count"), "utf8"), "x");
  await writeFile(join(project, "keep"), "preserved");
  make(["-n", "clean"]);
  assert.equal(await readFile(join(project, "keep"), "utf8"), "preserved");
  console.log("PASS native make forwards default target, external CWD, quoted arguments, overrides, shared parallel goals and dry-run without deleting files");
} finally {
  await rm(root, { recursive: true, force: true });
}
