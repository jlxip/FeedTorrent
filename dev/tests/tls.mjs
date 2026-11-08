import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { request } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import bencode from "bencode";
import { temporary, tracker, seed, startApp, exact, cleanup } from "./helpers.mjs";

// Verify the selected OpenSSL/LibreSSL implementation with a real HTTPS tracker
// and a local CA. The independent seeder uses the underlying HTTP tracker.
const root = await temporary();
let tr, ref, app, proxy;
try {
  const ca = join(root, "ca.pem"), cert = join(root, "server.pem"), key = join(root, "server.key");
  const openssl = (args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  await writeFile(join(root,"ca.conf"), "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=FeedTorrent test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
  openssl(["req", "-x509", "-sha256", "-config", join(root,"ca.conf"), "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=FeedTorrent test CA", "-keyout", join(root,"ca.key"), "-out", ca]);
  openssl(["req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", join(root,"server.csr")]);
  await writeFile(join(root,"extensions"), "basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  openssl(["x509", "-req", "-sha256", "-in", join(root,"server.csr"), "-CA", ca, "-CAkey", join(root,"ca.key"), "-CAserial", join(root,"ca.srl"), "-CAcreateserial", "-days", "1", "-extfile", join(root,"extensions"), "-out", cert]);
  openssl(["verify", "-purpose", "sslserver", "-CAfile", ca, cert]);
  tr = await tracker();
  const protocols=[];
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},(incoming,outgoing)=>{
    protocols.push(incoming.socket.getProtocol());
    const forward=request(new URL(incoming.url,tr.http),{method:incoming.method},response=>{
      outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);
    });
    forward.on("error",error=>outgoing.destroy(error));
    incoming.pipe(forward);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  proxy={stop:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
  ref=await seed(join(root,"seed"),[17001],{tracker:true,announce:[tr.http]});
  const metadata=bencode.decode(Buffer.from(ref.bytes));
  const url=Buffer.from(`https://127.0.0.1:${server.address().port}/announce`);
  metadata.announce=url;metadata["announce-list"]=[[url]];
  const env={...process.env,SSL_CERT_FILE:ca};
  if(process.platform === "openbsd") {
    const shim=join(root,"tls-ca.so");
    execFileSync("cc",["-shared","-fPIC","-std=c11","-Wall","-Wextra","-Werror","dev/fixtures/tls-ca.c","-lssl","-lcrypto","-o",shim]);
    env.LD_PRELOAD=[shim,env.LD_PRELOAD].filter(Boolean).join(":");
    env.FEEDTORRENT_TEST_CA=ca;
  }
  app=await startApp(root,[],{env});
  await app.command({type:"add_torrent",data:Array.from(bencode.encode(metadata))});
  await exact(app,ref);
  assert(protocols.some(version=>/^TLSv1\.[23]$/.test(version)));
  console.log("PASS trusted HTTPS tracker negotiates TLS and downloads exact bytes with the native crypto backend");
} catch (error) {
  if (app) console.error("TLS fixture diagnostics", JSON.stringify(await app.api()), app.logs);
  throw error;
} finally {
  await cleanup(root,proxy,tr,ref,app);
}
