import { execFileSync } from "node:child_process";
import { mkdir, copyFile, readdir, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const notices = join(root, "target/release/licenses");
await mkdir(notices, { recursive: true });
for (const name of ["BASECOAT-LICENSE.md", "LUCIDE-LICENSE"])
  await copyFile(join(root, "web/vendor", name), join(notices, name));
await copyFile(
  join(root, "backends/libtorrent/vendor/libtorrent/LICENSE"),
  join(notices, "LIBTORRENT-LICENSE"),
);
await copyFile(join(root, "dev/licenses/Boost-LICENSE"), join(notices, "BOOST-LICENSE"));
await copyFile(join(root, "backends/libtorrent/vendor/libtorrent/deps/try_signal/LICENSE"), join(notices, "TRY-SIGNAL-LICENSE"));
// Use the TLS implementation selected by CMake, including system LibreSSL.
const cache = await readFile(join(root, ".tools/libtorrent-build/CMakeCache.txt"), "utf8");
const include = cache.match(/^OPENSSL_INCLUDE_DIR:[^=]+=(.+)$/m)?.[1];
if (!include) throw Error("CMake did not record the TLS include directory");
const version = await readFile(join(include, "openssl/opensslv.h"), "utf8");
const libreSSL = version.includes("LIBRESSL_VERSION_NUMBER");
const candidates = process.env.TLS_LICENSE_FILE ? [process.env.TLS_LICENSE_FILE] :
  libreSSL ? [join(root, "dev/licenses/LibreSSL-LICENSE")] : [
    join(include, "../LICENSE.txt"),
    join(include, "../share/doc/openssl/LICENSE.txt"),
    join(include, "../share/doc/openssl/LICENSE"),
    "/usr/share/doc/libssl-dev/copyright",
  ];
let tlsLicense;
for (const candidate of candidates) {
  try { await access(candidate); tlsLicense = candidate; break; } catch {}
}
if (!tlsLicense) throw Error("TLS license not found; set TLS_LICENSE_FILE to its installed license");
await copyFile(tlsLicense, join(notices, libreSSL ? "LIBRESSL-LICENSE" : "OPENSSL-LICENSE"));
const metadata = JSON.parse(
  output("cargo", [
    "metadata",
    "--locked",
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
