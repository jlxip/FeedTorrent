// Independent FTKV v1 codec. Node 22 lacks native Argon2id; use the JS
// reference on that host, keeping the production Rust implementation separate.
import assert from 'node:assert/strict';
import crypto,{createCipheriv,createDecipheriv,randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {argon2id} from '@noble/hashes/argon2.js';
const magic=Buffer.from([70,84,75,86,1]);
const derive=(password,salt)=>crypto.argon2Sync
  ? crypto.argon2Sync('argon2id',{message:Buffer.from(password),nonce:salt,memory:65536,passes:3,parallelism:4,tagLength:32})
  : Buffer.from(argon2id(Buffer.from(password),salt,{m:65536,t:3,p:4,dkLen:32,version:0x13}));
export function publicKey(seed){return createPublicKey(createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'})).export({format:'der',type:'spki'}).subarray(-32);}
export function encryptVault(seed,password,pub=publicKey(seed).toString('hex')){
  const header=Buffer.concat([magic,randomBytes(16),randomBytes(12)]),key=derive(password,header.subarray(5,21));
  try{const c=createCipheriv('chacha20-poly1305',key,header.subarray(21),{authTagLength:16});c.setAAD(Buffer.concat([header,Buffer.from(pub,'hex')]));return Buffer.concat([header,c.update(seed),c.final(),c.getAuthTag()]);}finally{key.fill(0);}
}
export function decryptVault(vault,password){
  const data=Buffer.from(vault.ciphertext);assert.equal(data.length,81);assert(data.subarray(0,5).equals(magic));const key=derive(password,data.subarray(5,21));
  try{const c=createDecipheriv('chacha20-poly1305',key,data.subarray(21,33),{authTagLength:16});c.setAAD(Buffer.concat([data.subarray(0,33),Buffer.from(vault.public_key,'hex')]));c.setAuthTag(data.subarray(65));const seed=Buffer.concat([c.update(data.subarray(33,65)),c.final()]);assert.equal(publicKey(seed).toString('hex'),vault.public_key);return seed;}finally{key.fill(0);}
}
