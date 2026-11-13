import {runRoot} from './runtime.mjs';
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import WebTorrent from "webtorrent";
import Tracker from "bittorrent-tracker/server";
import DHT from "bittorrent-dht";
const fixtureTrackers = new Map();
export const hash = (b) => createHash("sha256").update(b).digest("hex");
export function payload(n, s = 0) {
  // Large fixtures must not allocate an additional JS number array per byte.
  const bytes = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + s) % 251;
  return bytes;
}
export async function wait(fn, label = "condition", timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("Timed out: " + label);
}
export async function temporary() {
  await mkdir(join(runRoot,"data"), { recursive: true });
  return mkdtemp(join(runRoot,"data/native-"));
}
export async function startApp(root, extra = [], options = {}) {
  await mkdir(root, { recursive: true });
  const defaults = [
    "--no-open",
    "--isolated",
    "--data-dir",
    join(root, "state"),
    "--download-dir",
    join(root, "downloads"),
    "--peer-port",
    "0",
    "--http-port",
    "0",
  ];
  if (options.defaultHttp) defaults.splice(defaults.indexOf("--http-port"), 2);
  if (options.openBrowser) defaults.splice(defaults.indexOf("--no-open"), 1);
  for (const flag of ["--download-dir", "--peer-port", "--data-dir", "--http-port"]) {
    if (extra.includes(flag) && defaults.includes(flag)) {
      const index = defaults.indexOf(flag);
      defaults.splice(index, 2);
    }
  }
  if (options.defaultDownloads && defaults.includes("--download-dir"))
    defaults.splice(defaults.indexOf("--download-dir"), 2);
  if (options.defaultData && defaults.includes("--data-dir"))
    defaults.splice(defaults.indexOf("--data-dir"), 2);
  const child = spawn(
    resolve("target/release/feedtorrent"),
    [...defaults, ...extra],
    { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd, env: options.env },
  );
  let logs = "";
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  const url = await wait(
    () => {
      if (child.exitCode !== null)
        throw Error(`App exited ${child.exitCode}: ${logs}`);
      return logs.match(/FeedTorrent (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    },
    "app startup",
    15000,
  );
  const r = await fetch(url + "/");
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const api = async (path = "/api/snapshot", body) => {
    const response = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || JSON.stringify(data));
    return data;
  };
  return {
    child,
    url,
    cookie,
    api,
    get logs() {
      return logs;
    },
    command: (c) => api("/api/commands", c),
    deletePost: async (post_kind,id) => {
      const p=await api('/api/commands',{type:'preview_removal',target:{kind:'post',post_kind,id}});
      return api('/api/commands',{type:'delete_post',post_kind,id,revision:p.revision});
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      const end = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      const [code, signal] = await end;
      clearTimeout(timer);
      if (code !== 0) throw Error(`App stopped ${code}/${signal}: ${logs}`);
    },
  };
}
export async function reference({
  utp = false,
  dht = false,
  tracker = false,
  uploadLimit = -1,
  utPex = true,
} = {}) {
  const client = new WebTorrent({
    utp,
    dht,
    tracker,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    uploadLimit,
    utPex,
  });
  const errors = [];
  client.on("error", (e) => errors.push(e.message));
  client.on("warning", (e) => errors.push(e.message));
  await new Promise((r) =>
    client.listening ? r() : client.once("listening", r),
  );
  return {
    client,
    errors,
    stop: () => new Promise((r) => client.destroy(() => r())),
  };
}
export async function seed(root, lengths = [17001, 49101, 0], opts = {}) {
  const folder = join(root, "source");
  await mkdir(folder, { recursive: true });
  const originals = [];
  for (let i = 0; i < lengths.length; i++) {
    const bytes = payload(lengths[i], i);
    originals.push(bytes);
    await writeFile(join(folder, `file-${i}.bin`), bytes);
  }
  const ref = await reference(opts);
  const torrent = await new Promise((yes, no) => {
    ref.client.once("error", no);
    ref.client.seed(
      folder,
      {
        name: "source",
        announce: opts.announce || [],
        pieceLength: 16384,
        private: false,
      },
      yes,
    );
  });
  await new Promise((yes, no) =>
    torrent.store.get(0, (error, bytes) => {
      if (error) return no(error);
      if (hash(bytes) !== hash(Buffer.concat(originals).subarray(0, 16384)))
        return no(Error("Independent seeder store mismatch"));
      yes();
    }),
  );
  if (opts.tracker && opts.announce?.length) {
    await new Promise((yes, no) => {
      const timer = setTimeout(
        () => no(Error("Seeder tracker announce timed out")),
        10000,
      );
      torrent.once("trackerAnnounce", () => {
        clearTimeout(timer);
        yes();
      });
      torrent.discovery.tracker.update();
    });
  }
  for (const address of opts.announce || []) {
    const fixture = fixtureTrackers.get(address);
    if (fixture)
      await wait(
        () =>
          new Promise((resolve) =>
            fixture.getSwarm(torrent.infoHash, (_error, swarm) =>
              resolve(swarm?.complete > 0),
            ),
          ),
        "seeder present in tracker",
        10000,
      );
  }
  return {
    ...ref,
    torrent,
    originals,
    id: torrent.infoHash,
    magnet: torrent.magnetURI,
    bytes: Array.from(torrent.torrentFile),
  };
}
export async function tracker() {
  const server = new Tracker({
    udp: true,
    http: true,
    ws: false,
    stats: false,
    interval: 2000,
  });
  server.on("error", () => {});
  await new Promise((r) =>
    server.listen(0, { http: "127.0.0.1", udp: "127.0.0.1", udp6: "::1" }, r),
  );
  fixtureTrackers.set(
    `http://127.0.0.1:${server.http.address().port}/announce`,
    server,
  );
  fixtureTrackers.set(`udp://127.0.0.1:${server.udp.address().port}`, server);
  return {
    server,
    http: `http://127.0.0.1:${server.http.address().port}/announce`,
    udp: `udp://127.0.0.1:${server.udp.address().port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}
export async function dhtNetwork({verify} = {}) {
  const nodes = [];
  for (let i = 0; i < 3; i++) {
    const n = new DHT({ bootstrap: false, host: "127.0.0.1", verify });
    n.on("error", () => {});
    await new Promise((r) => n.listen(0, "127.0.0.1", r));
    nodes.push(n);
  }
  for (const a of nodes)
    for (const b of nodes)
      if (a !== b) a.addNode({ host: "127.0.0.1", port: b.address().port });
  return {
    nodes,
    bootstrap: nodes.map((n) => ({
      host: "127.0.0.1",
      port: n.address().port,
    })),
    stop: () => Promise.all(nodes.map((n) => new Promise((r) => n.destroy(r)))),
  };
}
export async function complete(app, id) {
  return wait(async () => {
    const s = await app.api();
    return s.transfers.find(
      (t) => t.id === id && t.state === "Seeding" && t.progress === 1,
    );
  }, "verified seeding");
}
export async function exact(app, ref) {
  const t = await complete(app, ref.id);
  for (let i = 0; i < ref.originals.length; i++) {
    const f = t.files.find((f) => f.name.endsWith(`file-${i}.bin`));
    if (!f) throw Error("Missing file");
    if (
      hash(await readFile(join(t.save_path, f.name))) !== hash(ref.originals[i])
    )
      throw Error("File hash mismatch");
  }
  return t;
}
export async function reverse(app, ref, root, { utp = false } = {}) {
  const s = await app.api();
  const target = `127.0.0.1:${s.listen_port}`;
  // Only the native application may serve this download. PEX would admit other
  // fixture peers, and a TCP connection could win before uTP finishes connecting.
  const downloader = await reference({ utp, utPex: false });
  const wires = [];
  try {
    if (utp) {
      if (!downloader.client.utp) throw Error("Independent uTP transport unavailable");
      await new Promise((yes, no) =>
        downloader.client._connPool.tcpServer.close(error => error ? no(error) : yes()),
      );
    }
    const t = downloader.client.add(Buffer.from(ref.bytes), {
      path: join(root, "reverse-" + (utp ? "utp" : "tcp")),
      announce: [],
    });
    t.on("wire", (wire, address) => {
      const connection = { type: wire.type, address, downloaded: 0 };
      wires.push(connection);
      wire.on("download", bytes => { connection.downloaded += bytes; });
      if (utp && (wire.type !== "utpOutgoing" || address !== target)) wire.destroy();
    });
    await new Promise((r) => t.once("infoHash", r));
    t.addPeer(target);
    await wait(() => t.done, "independent reverse download");
    for (let i = 0; i < ref.originals.length; i++) {
      const f = t.files.find((f) => f.name === `file-${i}.bin`);
      if (hash(Buffer.from(await f.arrayBuffer())) !== hash(ref.originals[i]))
        throw Error("Reverse mismatch");
    }
    if (utp && !wires.some(wire => wire.type === "utpOutgoing" && wire.address === target && wire.downloaded > 0))
      throw Error("Reverse transfer did not use uTP");
    return t.downloaded;
  } catch (error) {
    throw new Error(`${error.message}; reverse diagnostics: ${JSON.stringify({ target, utp, wires, errors: downloader.errors })}`, { cause: error });
  } finally {
    await downloader.stop();
  }
}
export async function cleanup(root, ...resources) {
  for (const r of resources.reverse()) if (r) await r.stop();
  await rm(root, { recursive: true, force: true });
}

export async function retainForRemoval(app,id,bytes){
  const password='removal fixture password';
  if(!(await app.api()).publishing.has_key)await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const post=await app.api('/api/publishing',{action:'create_post',title:'Removal fixture'});
  const p=await app.api('/api/publishing',{action:'get_post',id:post.id});
  p.draft.pages[0].entries.push({kind:'torrent',name:'fixture.torrent',data:Array.from(bytes)});
  await app.api('/api/publishing',{action:'save_draft',id:post.id,revision:p.revision,draft:p.draft});
  const v=await app.command({type:'preview_removal',target:{kind:'unpin',id}});
  if(v.deleting.length)throw Error('Removal fixture did not retain torrent');
  await app.command({type:'set_pin',id,pinned:false,revision:v.revision});
}
