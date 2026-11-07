import {evidencePath} from './runtime.mjs';
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  temporary,
  startApp,
  seed,
  tracker,
  exact,
  reverse,
  cleanup,
  wait,
} from "./helpers.mjs";
const endpoint = "http://127.0.0.1:8793";
let session, driver, root, tr, ref, app;
const report = {
  time: new Date().toISOString(),
  status: "blocked",
  checks: [],
};
async function api(method, path, body) {
  const r = await fetch(endpoint + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (j.value?.error) throw Error(j.value.message);
  return j.value;
}
const call = (m, p, b) => api(m, `/session/${session}${p}`, b);
const js = (script, args = []) =>
  call("POST", "/execute/sync", { script, args });
async function click(s) {
  await js("document.querySelector(arguments[0]).click()", [s]);
}
async function seeding() {
  await wait(
    () =>
      js(
        "return document.querySelector('.state')?.textContent==='Seeding · 100%'",
      ),
    "Safari verified seeding",
  );
}
try {
  driver = spawn("/usr/bin/safaridriver", ["-p", "8793"], { stdio: "ignore" });
  await wait(
    async () => {
      try {
        return (await fetch(endpoint + "/status")).ok;
      } catch {
        return false;
      }
    },
    "Safari driver",
    5000,
  );
  const value = await api("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  session = value.sessionId;
  report.status = "running";
  report.version = value.capabilities.browserVersion;
  root = await temporary();
  tr = await tracker();
  ref = await seed(join(root, "safari"), [17001, 49101, 0], {
    tracker: true,
    announce: [tr.http],
  });
  app = await startApp(root);
  await call("POST", "/url", { url: app.url });
  await wait(
    () => js("return !document.querySelector('#settings-open').disabled"),
    "Safari ready",
  );
  await click("#open-button");
  await click("#torrent-tab");
  await js(
    "const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(arguments[0])],'fixture.torrent'));const input=document.querySelector('#torrent-file');input.files=dt.files;input.dispatchEvent(new Event('change'))",
    [ref.bytes],
  );
  await click("#torrent-form button[type=submit]");
  await seeding();
  await exact(app, ref);
  report.checks.push("torrent download and exact disk files");
  await call("POST", "/refresh", {});
  await seeding();
  report.checks.push("reload reconnects to native process");
  await click(".actions button");
  await wait(
    () =>
      js(
        "return document.querySelector('.state')?.textContent==='Paused · 100%'",
      ),
    "Safari paused",
  );
  await click(".actions button");
  await seeding();
  await ref.stop();
  ref.stop = async () => {};
  await reverse(app, ref, root);
  report.checks.push("pause/resume and independent reverse seeding");
  await app.stop();
  app = await startApp(root);
  await call("POST", "/url", { url: app.url });
  await seeding();
  await exact(app, ref);
  report.checks.push("native restart and verification");
  await click(".actions .danger");
  if (await js("return document.querySelector('#delete-files').checked"))
    throw Error("Deletion enabled by default");
  await click("#remove-form button[type=submit]");
  await wait(
    () => js("return document.querySelectorAll('.transfer').length===0"),
    "Safari removal",
  );
  report.checks.push("remove preserves files by default");
  report.status = "pass";
} catch (e) {
  report.status = session ? "fail" : "blocked";
  report.error = e.message;
  console.error(e.message);
  process.exitCode = report.status === "blocked" ? 2 : 1;
} finally {
  if (session)
    try {
      await api("DELETE", "/session/" + session);
    } catch {}
  if (driver) driver.kill();
  if (root) await cleanup(root, tr, ref, app);
  await mkdir(evidencePath(), { recursive: true });
  await writeFile(
    evidencePath("native-safari.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
