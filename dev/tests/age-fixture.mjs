// Independent, test-only age v1 scrypt/one-chunk codec using Node crypto.
// https://c2sp.org/age : Header MAC, Payload, scrypt recipient stanza.
import assert from "node:assert/strict";
import {
  scryptSync,
  hkdfSync,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
const b64 = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "");
const hkdf = (key, salt, info) =>
  Buffer.from(hkdfSync("sha256", key, salt, info, 32));
const wrap = (password, salt, logN) =>
  scryptSync(
    password,
    Buffer.concat([Buffer.from("age-encryption.org/v1/scrypt"), salt]),
    32,
    { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** 31 },
  );
function seal(key, nonce, data) {
  const c = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function open(key, nonce, data) {
  const c = createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  c.setAuthTag(data.subarray(-16));
  return Buffer.concat([c.update(data.subarray(0, -16)), c.final()]);
}
const finalNonce = () => Buffer.from("000000000000000000000001", "hex");
export function encryptAge(seed, password) {
  assert.equal(seed.length, 32);
  const salt = randomBytes(16),
    key = randomBytes(16),
    nonce = randomBytes(16),
    logN = 14;
  const stanza = b64(seal(wrap(password, salt, logN), Buffer.alloc(12), key));
  const header = Buffer.from(
    `age-encryption.org/v1\n-> scrypt ${b64(salt)} ${logN}\n${stanza}\n---`,
  );
  const mac = createHmac("sha256", hkdf(key, Buffer.alloc(0), "header"))
    .update(header)
    .digest();
  return Buffer.concat([
    header,
    Buffer.from(" " + b64(mac) + "\n"),
    nonce,
    seal(hkdf(key, nonce, "payload"), finalNonce(), seed),
  ]);
}
export function decryptAge(bytes, password) {
  const mark = bytes.indexOf("\n--- ");
  assert(mark > 0);
  const end = bytes.indexOf("\n", mark + 1);
  const header = bytes.subarray(0, end).toString("ascii");
  const match =
    /^age-encryption.org\/v1\n-> scrypt ([A-Za-z0-9+/]+) ([1-9][0-9]*)\n([A-Za-z0-9+/]+)\n--- ([A-Za-z0-9+/]+)$/.exec(
      header,
    );
  assert(match);
  const logN = Number(match[2]);
  assert(logN <= 20);
  const key = open(
    wrap(password, Buffer.from(match[1], "base64"), logN),
    Buffer.alloc(12),
    Buffer.from(match[3], "base64"),
  );
  const mac = createHmac("sha256", hkdf(key, Buffer.alloc(0), "header"))
    .update(bytes.subarray(0, mark + 4))
    .digest();
  assert(timingSafeEqual(mac, Buffer.from(match[4], "base64")));
  const nonce = bytes.subarray(end + 1, end + 17);
  const seed = open(
    hkdf(key, nonce, "payload"),
    finalNonce(),
    bytes.subarray(end + 17),
  );
  assert.equal(seed.length, 32);
  return seed;
}
