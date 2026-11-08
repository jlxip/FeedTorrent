#!/usr/bin/env python3
"""Private, reusable OpenBSD build environment; make/Cargo remain the runners.

Copy this script to Piensa. prepare once, sync a source-only tar, then exec make.
No global installation or access to the user's application data is performed.
"""
import argparse,base64,fcntl,hashlib,json,os,platform,shutil,subprocess,sys,tarfile,time,urllib.request,uuid
from pathlib import Path
PACKAGES={
 'boost-1.91.0p1v0.tgz':'b4c1bec827ff42b7b65913eae2b953493cb9924983f2e577706337b7a997da24',
 'brotli-1.2.0.tgz':'7b58f9aafe244fa921d86c18408e5458abd0d47e0b0bd9edb41a22e4ffe72fbb',
 'nghttp2-1.70.0.tgz':'0c4ea7b5100472943a541de0e8d37964d11ef5f9dd136ec68a60a38cea19f987',
 'nghttp3-1.18.0.tgz':'bb5149f4c1559d3e3d6dfdcee5739171c7b27fde0a156d13324de93c7b93e002',
 'node-24.21.0v0.tgz':'74126bb294a3225337adec282ee358d77fee26e8496a2ea37a68a12dee30de74'}
PIN='6da363d2994f17c0b3c0450d124cf73a31a73847'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def output(args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
def write(p,value):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2)+'\n')
def prepare(root):
 if platform.system()!='OpenBSD' or platform.release()!='8.0' or platform.machine()!='amd64':raise RuntimeError('Package manifest supports OpenBSD 8.0 amd64 only; update and verify it for a different host.')
 downloads=root/'downloads';downloads.mkdir(exist_ok=True);url='https://cdn.openbsd.org/pub/OpenBSD/8.0/packages/amd64/'
 manifest=None
 prefix=root/'prefix';prefix.mkdir(exist_ok=True)
 for name,digest in PACKAGES.items():
  archive=downloads/name
  if not archive.exists() or sha(archive)!=digest:
   if manifest is None:manifest=urllib.request.urlopen(url+'SHA256',timeout=90).read().decode()
   declared=next(line.split(' = ',1)[1].strip() for line in manifest.splitlines() if line.startswith('SHA256 ('+name+') = '))
   assert declared==base64.b64encode(bytes.fromhex(digest)).decode(),name
   temp=archive.with_suffix('.partial')
   with urllib.request.urlopen(url+name,timeout=90) as src,temp.open('wb') as dest:shutil.copyfileobj(src,dest)
   assert sha(temp)==digest,name;temp.replace(archive)
  marker=prefix/(name+'.ready')
  if not marker.exists() or marker.read_text()!=digest:
   with tarfile.open(archive) as tar:tar.extractall(prefix,members=[m for m in tar.getmembers() if not m.name.startswith('+')],filter='data')
   marker.write_text(digest)
 if not (root/'local').exists():(root/'local').symlink_to(prefix,target_is_directory=True)
 env=environment(root)
 write(root/'environment.json',{'platform':platform.platform(),'packages':PACKAGES,'rustc':output(['rustc','--version']),'cxx':output(['c++','--version']),'node':output([str(prefix/'bin/node'),'--version'],env=env),'python':sys.version})
 vendor=root/'workspace/backends/libtorrent/vendor/libtorrent';vendor.parent.mkdir(parents=True,exist_ok=True)
 if not (vendor/'.git').exists():
  subprocess.run(['git','clone','--no-checkout','--depth','1','https://github.com/arvidn/libtorrent.git',str(vendor)],check=True)
  subprocess.run(['git','-C',str(vendor),'fetch','--depth','1','origin',PIN],check=True)
  subprocess.run(['git','-C',str(vendor),'checkout','--detach',PIN],check=True)
 subprocess.run(['git','-C',str(vendor),'submodule','update','--init','--depth','1','deps/try_signal'],check=True)
 assert output(['git','-C',str(vendor),'rev-parse','HEAD'])==PIN
 subprocess.run(['git','-C',str(vendor),'diff','--exit-code','HEAD'],check=True)
def environment(root):
 env=os.environ.copy();env.update(PATH=str(root/'prefix/bin')+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LD_LIBRARY_PATH=str(root/'prefix/lib')+':/usr/local/lib:/usr/local/lib/eopenssl35',BOOST_ROOT=str(root/'prefix'),NODE_PREFIX=str(root/'prefix'),NATIVE_JOBS='2',CARGO_BUILD_JOBS='2');return env
def source_path(workspace,name):
 p=workspace/name
 if not p.resolve().is_relative_to(workspace.resolve()):raise RuntimeError('Source path escapes managed workspace: '+str(name))
 return p
def sync(root,archive):
 workspace=root/'workspace';workspace.mkdir(exist_ok=True);previous=json.loads((root/'sources.json').read_text()) if (root/'sources.json').exists() else {};current={}
 with tarfile.open(archive) as tar:
  for m in tar:
   path=Path(m.name)
   if not m.isfile() or path.is_absolute() or '..' in path.parts or any(x in path.parts for x in ['.git','.runtime','.tools','node_modules','target','dist']) or str(path).startswith('backends/libtorrent/vendor/'):raise RuntimeError('Not a source-only archive: '+m.name)
   value=tar.extractfile(m).read();name=str(path);current[name]=hashlib.sha256(value).hexdigest();dest=source_path(workspace,path)
   if not dest.exists() or sha(dest)!=current[name]:dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(value)
 for name in set(previous)-set(current):
  p=source_path(workspace,name)
  if p.is_file():p.unlink()
 write(root/'sources.json',current)
 refresh(root)
 print(json.dumps({'source_files':len(current),'source_sha256':hashlib.sha256(json.dumps(current,sort_keys=True,separators=(',',':')).encode()).hexdigest()}))
def refresh(root):
 # Invalidate only the native/tool environment. Cargo handles Rust/source changes;
 # npm's lockfile prerequisite handles JS dependency changes.
 workspace=root/'workspace';sources=json.loads((root/'sources.json').read_text());env=environment(root)
 for name,digest in PACKAGES.items():
  assert (root/'prefix'/(name+'.ready')).read_text()==digest,name
  assert sha(root/'downloads'/name)==digest,name
 for name,digest in sources.items():assert sha(source_path(workspace,name))==digest,'Source changed without sync: '+name
 native={'cxx':output(['c++','--version']),'platform':platform.platform(),'packages':PACKAGES,'script':sources['dev/scripts/native-deps.sh'],'cmake':sources['dev/cmake/openbsd.cmake']}
 flags={k:env[k] for k in ['CC','CXX','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','CMAKE_PREFIX_PATH','OPENSSL_ROOT_DIR','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_BUILD_TARGET'] if env.get(k)}
 if flags:native['flags']=flags
 addon={**native,'node_abi':output([str(root/'prefix/bin/node'),'-p','process.versions.modules'],env=env),'script':sources['dev/scripts/test-deps.sh']}
 for name,key,paths in [('native',native,['.tools/native','.tools/libtorrent-build','target']),('addons',addon,['.tools/node-datachannel','dev/node_modules/utp-native/build','dev/node_modules/node-datachannel/build'])]:
  marker=root/(name+'-inputs.json');old=json.loads(marker.read_text()) if marker.exists() else None
  if old!=key:
   for rel in paths:
    p=workspace/rel
    if p.exists():shutil.rmtree(p)
   write(marker,key)

 recorded=json.loads((root/'environment.json').read_text());recorded.pop('wheel_sha256',None);tools={'tls':output(['openssl','version']),'cmake':output(['cmake','--version']).splitlines()[0],'ninja':output(['ninja','--version'])}
 tool_marker=root/'build-tool-inputs.json';previous_tools=json.loads(tool_marker.read_text()) if tool_marker.exists() else None
 if previous_tools is not None and previous_tools!=tools:
  for rel in ['.tools/native','.tools/libtorrent-build','target','.tools/node-datachannel','dev/node_modules/utp-native/build','dev/node_modules/node-datachannel/build']:
   p=workspace/rel
   if p.exists():shutil.rmtree(p)
 write(tool_marker,tools)
 recorded.update(rustc=output(['rustc','--version']),cxx=output(['c++','--version']),node=output([str(root/'prefix/bin/node'),'--version'],env=env),**tools)
 write(root/'environment.json',recorded)

def execute(root,command):
 if not command:raise RuntimeError('Missing command')
 refresh(root)
 run=root/'runs'/uuid.uuid4().hex;run.mkdir(parents=True);env=environment(root);env['FEEDTORRENT_TEST_RUN_DIR']=str(run)
 record={'command':command,'source_sha256':sha(root/'sources.json'),'environment':json.loads((root/'environment.json').read_text()),'started_at':time.time()};start=time.monotonic()
 print('Validation artifacts: '+str(run),flush=True)
 try:result=subprocess.run(command,cwd=root/'workspace',env=env);record['exit']=result.returncode
 finally:record['seconds']=time.monotonic()-start;write(run/'command.json',record)
 return result.returncode
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path.home()/'.cache/feedtorrent-validation');s=p.add_subparsers(dest='action',required=True);s.add_parser('prepare');q=s.add_parser('sync');q.add_argument('archive');q=s.add_parser('exec');q.add_argument('command',nargs=argparse.REMAINDER);s.add_parser('status');a=p.parse_args();root=a.root.expanduser().resolve();root.mkdir(parents=True,exist_ok=True)
 marker=root/'OWNER';expected='FeedTorrent reusable validation environment v1\n'
 if marker.exists():assert marker.read_text()==expected
 elif list(root.iterdir()):raise RuntimeError('Refusing unowned nonempty directory')
 else:marker.write_text(expected)
 with (root/'lease').open('w') as lease:
  fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if a.action=='prepare':prepare(root)
  elif a.action=='sync':sync(root,a.archive)
  elif a.action=='exec':return execute(root,a.command)
  else:print(json.dumps({'root':str(root),'environment':json.loads((root/'environment.json').read_text()),'sources':len(json.loads((root/'sources.json').read_text())) if (root/'sources.json').exists() else 0,'runs':[p.name for p in (root/'runs').glob('*')]}))
 return 0
if __name__=='__main__':sys.exit(main())
