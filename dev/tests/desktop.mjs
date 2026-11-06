// OpenBSD integration: exercise the real server's desktop calls with an opener
// fixture. No graphical session or external browser is needed on a test server.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { temporary, startApp, seed, tracker, exact, cleanup, wait } from "./helpers.mjs";

assert.equal(process.platform, "openbsd");
const root = await temporary();
let app, ref, tr;
try {
  const bin = join(root, "desktop tools"), log = join(root, "desktop.log"), fail = join(root, "fail");
  await mkdir(bin);
  await writeFile(join(bin, "xdg-open"), `#!/bin/sh
printf '%s\n' "$1" >> "$FEEDTORRENT_DESKTOP_LOG"
[ ! -f "$FEEDTORRENT_DESKTOP_FAIL" ]
`, { mode: 0o755 });
  tr = await tracker();
  ref = await seed(join(root, "seed"), [17001], { tracker: true, announce: [tr.http] });
  app = await startApp(root, [], { openBrowser: true, env: { ...process.env,
    PATH: bin + ":" + process.env.PATH, FEEDTORRENT_DESKTOP_LOG: log, FEEDTORRENT_DESKTOP_FAIL: fail } });
  await wait(async () => (await readFile(log, "utf8").catch(() => "")).includes(app.url + "/"), "browser opener");
  await app.command({ type: "add_torrent", data: ref.bytes });
  const transfer = await exact(app, ref);
  await app.command({ type: "reveal", id: ref.id, file: 0 });
  const parent = dirname(await realpath(join(transfer.save_path, transfer.files[0].name)));
  assert((await readFile(log, "utf8")).split("\n").includes(parent));
  await writeFile(fail, "fail");
  await assert.rejects(app.command({ type: "reveal", id: ref.id }), /File manager could not open/);
  console.log("PASS OpenBSD browser URL, containing folder and desktop failure through the real server API");
} finally {
  await cleanup(root, app, ref, tr);
}
