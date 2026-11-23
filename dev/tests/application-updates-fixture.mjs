// HTTPS-only releases and independent future programs; never a real installer target.
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,chmod,symlink,rm,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export async function releaseFixture(root){
 await mkdir(root,{recursive:true});
 const key=join(root,'key.pem'),ca=join(root,'ca.pem'),caKey=join(root,'ca-key.pem'),cert=join(root,'server.pem'),csr=join(root,'server.csr'),extensions=join(root,'server.ext');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=FeedTorrent isolated update fixture','-addext','subjectAltName=IP:127.0.0.1','-keyout',caKey,'-out',ca],{stdio:'ignore'});
 execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=FeedTorrent fixture server','-keyout',key,'-out',csr],{stdio:'ignore'});
 await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
 execFileSync('openssl',['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAserial',join(root,'ca.srl'),'-CAcreateserial','-out',cert,'-days','1','-extfile',extensions],{stdio:'ignore'});
 const interpreters=await mkdtemp(join(tmpdir(),'ft-update-'));
 const state={requests:[],assets:new Map(),releases:[],rate:false,slow:false,delay:0};
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  state.requests.push(req.url);if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
  const url=new URL(req.url,'https://fixture');
  if(url.pathname==='/releases'){
   if(state.rate){res.writeHead(429,{'Retry-After':'3600'});res.end('{}');return;}
   const page=Number(url.searchParams.get('page')||1);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state.releases.slice((page-1)*100,page*100)));return;
  }
  const bytes=state.assets.get(url.pathname);
  if(!bytes){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Length',bytes.length);
  if(state.slow&&url.pathname.endsWith('.tar.gz')){res.write(bytes.subarray(0,1));const timer=setTimeout(()=>res.end(bytes.subarray(1)),10000);res.on('close',()=>clearTimeout(timer));}else res.end(bytes);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`https://127.0.0.1:${server.address().port}/`;
 const target=process.platform==='darwin'?'macos-arm64':process.platform==='openbsd'?'openbsd-8.0-amd64':'linux-amd64';
 const env={...process.env,FEEDTORRENT_UPDATE_TEST_ORIGIN:origin,FEEDTORRENT_UPDATE_TEST_CA:ca};
 async function packageRelease(tag='v99.0.0',mode='success'){
  const interpreter=join(interpreters,'python-'+mode);const python=execFileSync('which',['python3'],{encoding:'utf8'}).trim();
  await rm(interpreter,{force:true});await symlink(python,interpreter);
  const program=`#!${interpreter}
import sys,os,json,signal,http.server
VERSION=${JSON.stringify(tag)}
if '--version' in sys.argv:
 print('feedtorrent '+VERSION);sys.exit(0)
if ${JSON.stringify(mode)}=='probe-fail':sys.exit(23)
def value(flag,default=None):
 return sys.argv[sys.argv.index(flag)+1] if flag in sys.argv else default
data=value('--data-dir');probe='/probe/' in data
os.makedirs(data,exist_ok=True)
if not probe:
 with open(os.path.join(data,'fixture-restarted.json'),'w') as f:json.dump({'pid':os.getpid(),'argv':sys.argv,'cwd':os.getcwd(),'sentinel':os.environ.get('FEEDTORRENT_UPDATE_SENTINEL')},f)
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Set-Cookie','fixture=ready; Path=/');self.end_headers()
  if self.path=='/api/snapshot':v={'ready':True}
  elif self.path=='/api/updates':
   with open(os.path.join(data,'updates/install.json')) as f:j=json.load(f)
   j['status']='installed'
   with open(os.path.join(data,'updates/install.json'),'w') as f:json.dump(j,f)
   v={'current':VERSION,'instance':'independent-future-'+str(os.getpid()),'phase':'idle','operation':None,'offer':None,'completed':{'operation':j['operation'],'version':VERSION,'status':'installed','recovery':j['backup']}}
  else:v={}
  self.wfile.write(json.dumps(v).encode())
def stop(*a):
 if probe and ${JSON.stringify(mode)}=='exec-fail':os.unlink(${JSON.stringify(interpreter)})
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
server=http.server.HTTPServer(('127.0.0.1',int(value('--http-port','0'))),Handler)
print('FeedTorrent http://127.0.0.1:'+str(server.server_address[1])+'/',flush=True)
server.serve_forever()
`;
  const base=`feedtorrent-${tag}-${target}`,directory=join(root,base+'-'+mode);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'feedtorrent'),program);await chmod(join(directory,'feedtorrent'),0o755);
  await mkdir(join(directory,'licenses'),{recursive:true});await writeFile(join(directory,'licenses','FIXTURE-LICENSE'),'Independent test program.');
  await writeFile(join(directory,'THIRD_PARTY.json'),'[]');
  await writeFile(join(directory,'BUILD-INFO.json'),JSON.stringify({version:mode==='wrong-version'?'v98.0.0':tag,tag,target,dirty:false,binary_sha256:sha(program)}));
  const output=join(root,base+'-'+mode+'.tar.gz');
  const pack=`import tarfile,sys,io\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n t.add(sys.argv[2],arcname=sys.argv[3])\n if sys.argv[4]=='traversal':\n  h=tarfile.TarInfo(sys.argv[3]+'/../../escaped');h.size=1;t.addfile(h,io.BytesIO(b'x'))\n if sys.argv[4]=='link':\n  h=tarfile.TarInfo(sys.argv[3]+'/licenses/bad');h.type=tarfile.SYMTYPE;h.linkname='/tmp';t.addfile(h)\n`;
  execFileSync('python3',['-c',pack,output,directory,base,mode]);
  const bytes=await readFile(output),name=base+'.tar.gz',path='/assets/'+name;
  state.assets.set(path,bytes);state.assets.set(path+'.sha256',Buffer.from(`${mode==='checksum'?'0'.repeat(64):sha(bytes)}  ${name}\n`));
  const asset=(suffix,id)=>({id,name:name+suffix,browser_download_url:origin.slice(0,-1)+path+suffix,size:state.assets.get(path+suffix).length});
  const release={id:900,tag_name:tag,draft:false,prerelease:tag.includes('-'),published_at:'2026-11-23T00:00:00Z',assets:[asset('',901),asset('.sha256',902)]};
  state.releases=[release];return {release,bytes,program,interpreter};
 }
 return {state,origin,target,env,ca,packageRelease,async close(){await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(interpreters,{recursive:true,force:true});}};
}
