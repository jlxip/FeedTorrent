import {runRoot} from './runtime.mjs';
// Isolate Gecko application bookkeeping from the user's macOS-protected Firefox data.
// https://github.com/microsoft/playwright/issues/42768
import { firefox } from "@playwright/test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
export function firefoxOptions() {
  if (process.platform !== "darwin") return {};
  const binary = firefox.executablePath(),
    resources = resolve(dirname(binary), "../Resources"),
    root = join(runRoot, `firefox-${process.pid}`);
  if (!existsSync(join(resources, "browser"))) return {};
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(join(resources, "browser"))) {
    const target = join(root, name);
    if (name !== "application.ini" && !existsSync(target))
      symlinkSync(join(resources, "browser", name), target);
  }
  const ini = readFileSync(join(resources, "application.ini"), "utf8")
    .replace("Vendor=Mozilla", "Vendor=FeedTorrentTests")
    .replace("Name=Firefox", "Name=FeedTorrentTests")
    .replace("RemotingName=firefox-default", "RemotingName=feedtorrent-tests");
  writeFileSync(join(root, "application.ini"), ini);
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'",
    wrapper = join(root, "launch");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${quote(binary)} -app ${quote(join(root, "application.ini"))} "$@"\n`.replaceAll(
      "\\n",
      "\n",
    ),
  );
  chmodSync(wrapper, 0o755);
  return { executablePath: wrapper };
}
