import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import bencode from 'bencode';
import {wait} from './helpers.mjs';
const sha=b=>createHash('sha1').update(b).digest();
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^(n&1?0xedb88320:0);}return (n^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);}
export function png(width=32,height=20){const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;const pixels=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(width*3+1)+1+x*3;pixels[at]=30;pixels[at+1]=120+x%40;pixels[at+2]=70+y%40;}return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n','binary'),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
export function imageTorrent(name,body='![Local photo](photo.png)',catalog=true,extra=[]){
 const files=[{path:['metadata','body.md'],data:Buffer.from(body)},{path:['.pad','16384'],data:Buffer.alloc(16384),padding:true},{path:['photo.png'],data:png()},...extra];
 const all=Buffer.concat(files.map(f=>f.data)),pieces=[];for(let at=0;at<all.length;at+=16384)pieces.push(sha(all.subarray(at,at+16384)));
 const info={name,files:files.map(f=>({path:f.path,length:f.data.length,...(f.padding?{attr:'p'}:catalog?{sha1:sha(f.data)}:{})})),'piece length':16384,pieces:Buffer.concat(pieces),...(catalog?{bep49:{}}:{})};
 return {id:sha(bencode.encode(info)).toString('hex'),name,bytes:Buffer.from(bencode.encode({info})),files};
}
export async function preloadImages(root,app,t){
 for(const f of t.files){if(f.padding)continue;const p=join(root,'app','downloads',t.id,t.name,...f.path);await mkdir(dirname(p),{recursive:true});await writeFile(p,f.data);}
 await app.command({type:'add_torrent',data:Array.from(t.bytes)});
 await wait(async()=>{const v=(await app.api()).transfers.find(v=>v.id===t.id);return v?.progress===1&&v.files.every(f=>f.ready);},'image fixture verified');
}
