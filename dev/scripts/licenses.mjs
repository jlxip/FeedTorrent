import { execFileSync } from "node:child_process";
import { mkdir, copyFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const notices = join(root, "target/release/licenses");
await mkdir(notices, { recursive: true });
for (const name of ["BASECOAT-LICENSE.md", "LUCIDE-LICENSE"])
  await copyFile(join(root, "web/vendor", name), join(notices, name));
await copyFile(
  join(root, "backends/libtorrent/vendor/libtorrent/LICENSE"),
  join(notices, "LIBTORRENT-LICENSE"),
);
await copyFile(
  join(output("brew", ["--prefix", "openssl@3"]), "LICENSE.txt"),
  join(notices, "OPENSSL-LICENSE"),
);
const metadata = JSON.parse(
  output("cargo", [
    "metadata",
    "--locked",
    "--offline",
    "--format-version",
    "1",
  ]),
);
const packages = [];
for (const p of metadata.packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
)) {
  if (metadata.workspace_members.includes(p.id)) continue;
  packages.push({ name: p.name, version: p.version, license: p.license });
  for (const item of await readdir(dirname(p.manifest_path), {
    withFileTypes: true,
  })) {
    if (!item.isFile() || !/^(license|licence|copying|notice)/i.test(item.name))
      continue;
    const target = join(notices, `${p.name}-${p.version}`);
    await mkdir(target, { recursive: true });
    await copyFile(
      join(dirname(p.manifest_path), item.name),
      join(target, item.name),
    );
  }
}
await writeFile(
  join(root, "target/release/THIRD_PARTY.json"),
  JSON.stringify(packages, null, 2) + "\n",
);
