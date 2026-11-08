import {sourceHash} from './runtime.mjs';
import assert from "node:assert/strict";
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm, stat, readdir, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const repo = resolve(".");
await mkdir(".runtime", { recursive: true });
const root = await mkdtemp(resolve(".runtime/make-entry-"));
const env = { ...process.env };
for (const key of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS"]) delete env[key];
try {
  const project = join(root, "project"), elsewhere = join(root, "elsewhere"), bin = join(root, "bin");
  for (const dir of ["dev/scripts", "dev/tests", "dev/cmake", "dev/node_modules/typescript/bin", "app", "web/vendor", ".runtime"]) await mkdir(join(project, dir), { recursive: true });
  await mkdir(elsewhere); await mkdir(bin);
  await copyFile("Makefile", join(project, "Makefile"));
  await copyFile("dev/scripts/web.sh", join(project, "dev/scripts/web.sh"));
  // Real Make graph and TypeScript emitter, with expensive native tools replaced
  // at their process boundaries. No shared caches or application data are used.
  await writeFile(join(project, "dev/node_modules/typescript/bin/tsc"), `import ${JSON.stringify(join(repo,"dev/node_modules/typescript/bin/tsc"))};\n`);
  for (const file of ["Cargo.toml", "app/Cargo.toml", ".gitmodules", "dev/cmake/openbsd.cmake", "dev/package.json", "dev/package-lock.json"]) await writeFile(join(project,file), "{}\n");
  await writeFile(join(project,"app/Cargo.toml"), '[package]\nname = "feedtorrent"\n');
  await writeFile(join(project,"web/tsconfig.json"), JSON.stringify({compilerOptions:{target:"ES2022",module:"ES2022",strict:true},include:["*.ts"]}));
  await writeFile(join(project,"web/main.ts"), "export const value = 1;\n");
  for (const file of ["index.html","app.css","theme.js"]) await writeFile(join(project,"web",file),file);
  for (const file of ["basecoat-vega-1.0.2.min.css","lucide-0.468.0.min.js","basecoat-runtime-1.0.2.min.js","basecoat-tabs-1.0.2.min.js","basecoat-sidebar-1.0.2.min.js","basecoat-dropdown-menu-1.0.2.min.js"]) await writeFile(join(project,"web/vendor",file),file);
  await copyFile("dev/scripts/unit.mjs",join(project,"dev/scripts/unit.mjs"));
  await copyFile("dev/scripts/clippy.sh",join(project,"dev/scripts/clippy.sh"));
  await copyFile("dev/tests/runtime.mjs",join(project,"dev/tests/runtime.mjs"));
  await writeFile(join(project,"dev/scripts/ui.mjs"),"import{appendFileSync}from\"node:fs\";appendFileSync(process.env.BUILD_LOG,\"ui:\"+process.argv.slice(2).join(\" \")+\"\\n\");\n");
  await writeFile(join(project,"dev/scripts/test-deps.sh"),"#!/bin/sh\nprintf \"test-deps\\n\" >> \"$BUILD_LOG\"\n");
  const suites="bep44 bep50 network tls edge-cases open-cwd posts publishing key-vault retention organization".split(" ");
  for(const name of [...suites,"make-entry","desktop","bep-consumer","posts-consumer"])
    await writeFile(join(project,"dev/tests",name+".mjs"),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:'+name+'\\n");\n');
  await writeFile(join(project,'dev/tests/validation-env.py'),'print("validation fixture")\n');
  await writeFile(join(project,'dev/tests/package.test.mjs'),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:package\\n");\n');
  await writeFile(join(project,'dev/tests/release.test.mjs'),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:release\\n");\n');
  await writeFile(join(project,'dev/tests/pre-commit.test.mjs'),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:pre-commit\\n");\n');
  await writeFile(join(project,'dev/tests/test-deps.test.mjs'),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:test-deps\\n");\n');
  await writeFile(join(project,'dev/tests/disk-image.test.mjs'),'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"suite:disk-image\\n");\n');
  const log = join(root,"calls"); env.BUILD_LOG=log; env.PATH=bin+":"+env.PATH;
  await writeFile(join(bin,"npm"), '#!/bin/sh\nprintf "npm\\n" >> "$BUILD_LOG"\n', {mode:0o755});
  await writeFile(join(project,"dev/scripts/native-deps.sh"), '#!/bin/sh\nif [ "${1:-}" = --verify-source ]; then printf "verify\\n" >> "$BUILD_LOG"; else mkdir -p .tools/native; printf "native:%s\\n" "$NATIVE_JOBS" >> "$BUILD_LOG"; fi\n');
  await writeFile(join(project,"dev/scripts/licenses.mjs"), 'import{appendFileSync}from"node:fs";appendFileSync(process.env.BUILD_LOG,"licenses\\n");\n');
  await writeFile(join(bin,"cargo"), `#!/bin/sh
printf 'cargo:%s\n' "$*" >> "$BUILD_LOG"
if [ -f .runtime/fail-cargo ]; then exit 17; fi
if [ "$1" = test ]; then
  if [ -f .runtime/empty-tests ]; then printf 'test result: ok. 0 passed; 0 failed;\n'; else printf 'test result: ok. 1 passed; 0 failed;\n'; fi
fi
if [ "$1" = build ]; then
  mkdir -p target/release
  printf '#!/bin/sh\nprintf "APP:<%%s>\\n" "$PWD" "$@"\n' > target/release/feedtorrent
  chmod +x target/release/feedtorrent
fi
`, {mode:0o755});
  const make = (args, cwd=project) => execFileSync("make",args,{cwd,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  const calls = async () => (await readFile(log,"utf8")).trim().split("\n");
  const count = async prefix => (await calls()).filter(x=>x.startsWith(prefix)).length;
  const age = file => utimes(join(project,file),new Date(0),new Date(0));
  const stamp = async file => (await stat(join(project,file),{bigint:true})).mtimeNs;
  make(["NATIVE_JOBS=2"]);
  assert.equal(await count("npm"),1); assert.equal(await count("native:2"),1);
  const original = await readFile(join(project,"web/dist/main.js")), emitted = await stamp("web/dist/main.js"), web = await stamp("web/dist/.ready");
  make(["build"]);
  assert.equal(await count("npm"),1); assert.equal(await count("native:"),1);
  assert.equal(await stamp("web/dist/.ready"),web);
  await writeFile(join(project,"Makefile"),(await readFile(join(project,"Makefile"),"utf8"))+"\n# test recipe edit\n");
  make(["build"]);
  assert.equal(await stamp("web/dist/.ready"),web); assert.equal(await count("native:"),1);
  // GNU Make 3.81 can compare timestamps at second resolution. Make the
  // intended invalidations explicit rather than relying on how fast this runs.
  await age("dev/node_modules/.feedtorrent-ready"); await age("web/dist/.ready");
  await writeFile(join(project,"dev/package.json"),'{}\n\n'); make(["build"]);
  assert.equal(await count("npm"),2); assert.equal(await stamp("web/dist/main.js"),emitted);
  await writeFile(log,"");
  const output=make(["-j2","build","check-native","run","ARGS='two words' plain","NATIVE_JOBS=2"]);
  assert.equal(await count("cargo:build --locked --release"),1); assert.equal(await count("licenses"),1);
  assert(output.includes(`APP:<${project}>\nAPP:<two words>\nAPP:<plain>`));
  await age("web/dist/.ready");
  const ready=await stamp("web/dist/.ready");
  await writeFile(join(project,"web/main.ts"),'not valid TypeScript ???');
  assert.throws(()=>make(["web"]));
  assert.deepEqual(await readFile(join(project,"web/dist/main.js")),original); assert.equal(await stamp("web/dist/.ready"),ready);
  assert(!(await readdir(join(project,".tools"))).some(x=>x.startsWith("web.")));
  await writeFile(join(project,"web/main.ts"),"export const value = 2;\n"); make(["web"]);
  assert.notDeepEqual(await readFile(join(project,"web/dist/main.js")),original);
  await writeFile(join(project,".runtime/fail-cargo"),"");const licenses=await count("licenses");
  assert.throws(()=>make(["run"]));assert.equal(await count("licenses"),licenses);
  await rm(join(project,".runtime/fail-cargo"));
  // Removing an input must invalidate the web stage even though it no longer
  // appears in Make's wildcard list. Keep other prerequisites older than ready.
  for(const dir of ["web","web/vendor"]){
    for(const name of await readdir(join(project,dir))){const file=join(dir,name);if((await stat(join(project,file))).isFile())await utimes(join(project,file),new Date(1000000),new Date(1000000));}
    await utimes(join(project,dir),new Date(1000000),new Date(1000000));
  }
  for(const file of ["dev/scripts/web.sh","dev/package.json","dev/package-lock.json","dev/node_modules/.feedtorrent-ready"])await utimes(join(project,file),new Date(1000000),new Date(1000000));
  await utimes(join(project,"web/dist/.ready"),new Date(2000000),new Date(2000000));
  const missingReady=await stamp("web/dist/.ready"),current=await readFile(join(project,"web/dist/main.js"));
  await rm(join(project,"web/vendor/lucide-0.468.0.min.js"));
  assert.throws(()=>make(["web"]));
  assert.equal(await stamp("web/dist/.ready"),missingReady);assert.deepEqual(await readFile(join(project,"web/dist/main.js")),current);
  await writeFile(join(project,"web/vendor/lucide-0.468.0.min.js"),"lucide-0.468.0.min.js");
  for(const path of ["downloads","dist/pkg",".runtime/state"]){await mkdir(join(project,path),{recursive:true});await writeFile(join(project,path,"keep"),"keep");}
  make(["-n","clean"]);assert((await stat(join(project,"web/dist"))).isDirectory());
  await mkdir(join(elsewhere,"target"));await writeFile(join(elsewhere,"target/keep"),"keep");
  // A different Rust/web project must not satisfy the root guard either.
  await mkdir(join(elsewhere,"app")); await mkdir(join(elsewhere,"web"));
  await writeFile(join(elsewhere,"Makefile"),"# unrelated project\n");
  await writeFile(join(elsewhere,"Cargo.toml"),"[workspace]\n");
  await writeFile(join(elsewhere,"app/Cargo.toml"),'[package]\nname = "unrelated"\n');
  await writeFile(join(elsewhere,"web/tsconfig.json"),"{}\n");
  assert.throws(()=>make(["-f",join(project,"Makefile"),"clean"],elsewhere));assert.equal(await readFile(join(elsewhere,"target/keep"),"utf8"),"keep");
  make(["clean"]);
  for(const path of ["target","web/dist"]) await assert.rejects(stat(join(project,path)),{code:"ENOENT"});
  for(const path of ["downloads","dist/pkg",".runtime/state"]) assert.equal(await readFile(join(project,path,"keep"),"utf8"),"keep");
  assert((await stat(join(project,".tools/native"))).isDirectory());assert((await stat(join(project,"dev/node_modules"))).isDirectory());
  make(["build"]);assert.deepEqual(await readFile(join(project,"web/dist/main.js")),Buffer.from("export const value = 2;\n"));
  // Focused entries keep Cargo filters, never hide an empty selection, and
  // do not pull unrelated layers into a test invocation.
  await writeFile(log,"");
  make(["test-unit","UNIT_ARGS=-p feedtorrent exact_filter"]);
  assert((await calls()).includes("cargo:test --locked -p feedtorrent exact_filter"));
  assert.equal(await count("cargo:build"),0);assert.equal(await count("ui:"),0);
  await writeFile(join(project,".runtime/empty-tests"),"");assert.throws(()=>make(["test-unit"]));await rm(join(project,".runtime/empty-tests"));
  await writeFile(log,"");
  make(["test-integration","NATIVE_SUITES=publishing key-vault"]);
  assert.deepEqual((await calls()).filter(x=>x.startsWith("suite:")),["suite:publishing","suite:key-vault"]);
  assert.equal(await count("cargo:test"),0);
  assert.throws(()=>make(["test-integration","NATIVE_SUITES="]));
  assert.throws(()=>make(["test-integration","NATIVE_SUITES=bep46"]));
  await writeFile(log,"");make(["test-ui","UI_ARGS=version.spec.ts --project=chrome"]);
  assert((await calls()).includes("ui:version.spec.ts --project=chrome"));assert.equal(await count("cargo:test"),0);
  await writeFile(log,"");make(["test"]);
  assert((await calls()).includes("cargo:test --locked --workspace"));
  assert.equal(await count("cargo:build --locked --release"),2); // app and independent examples
  assert.equal(await count("test-deps"),1);
  for(const name of suites)assert((await calls()).includes("suite:"+name));
  assert((await calls()).includes("suite:make-entry"));
  assert.equal((await calls()).includes("ui:"),process.platform!=="openbsd");
  assert.equal((await calls()).some(x=>x.includes("--target wasm32-unknown-unknown")),process.platform!=="openbsd");
  assert.equal((await calls()).includes("suite:desktop"),process.platform==="openbsd");
  const beforeSource=sourceHash(project);
  await writeFile(join(project,"downloads/not-a-source.bin"),Buffer.alloc(4096));
  assert.equal(sourceHash(project),beforeSource,"ignored application data must not enter source identity");
  await writeFile(join(project,"web/main.ts"),"export const value = 3;\n");
  assert.notEqual(sourceHash(project),beforeSource,"real source edits must change identity");
  const managed=join(root,"managed"),mirror=join(managed,"workspace");await mkdir(mirror,{recursive:true});
  await writeFile(join(managed,"OWNER"),"FeedTorrent reusable validation environment v1\n");
  await writeFile(join(managed,"sources.json"),JSON.stringify({"source.txt":"validated-by-sync"}));
  await writeFile(join(mirror,"source.txt"),"one");const managedHash=sourceHash(mirror);
  await writeFile(join(mirror,"not-a-source.bin"),Buffer.alloc(4096));assert.equal(sourceHash(mirror),managedHash);
  await writeFile(join(mirror,"source.txt"),"two");assert.notEqual(sourceHash(mirror),managedHash);
  console.log("PASS source identity: real edits, ignored data and managed non-Git mirror");
  console.log("PASS focused make: default/full suites, filters, empty/unknown selection, shared preparation and failure propagation");
  console.log("PASS native make: default, incremental invalidation, unchanged output dates, parallel shared goals, ARGS/jobs, failure propagation, clean/rebuild and wrong-CWD safety");
} finally {
  await rm(root,{recursive:true,force:true});
}
