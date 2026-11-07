"""Contracts of the private cache; no network, packages or application data."""
import contextlib,hashlib,importlib.util,io,json,os,subprocess,sys,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('validation','dev/scripts/openbsd-validation.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class EnvironmentTests(unittest.TestCase):
 def setUp(self):
  Path('.runtime/tests').mkdir(parents=True,exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir='.runtime/tests');self.root=Path(self.temp.name).resolve();self.workspace=self.root/'workspace';self.workspace.mkdir()
 def tearDown(self):self.temp.cleanup()
 def archive(self,files):
  p=self.root/'source.tar'
  with tarfile.open(p,'w') as tar:
   for name,value in files.items():
    b=value.encode();m=tarfile.TarInfo(name);m.size=len(b);tar.addfile(m,io.BytesIO(b))
  return p
 def sync(self,files):
  with patch.object(module,'refresh'),contextlib.redirect_stdout(io.StringIO()):module.sync(self.root,self.archive(files))
 def test_sync_preserves_unchanged_and_unowned_files(self):
  self.sync({'Makefile':'one','web/main.ts':'a'});stamp=(self.workspace/'Makefile').stat().st_mtime_ns
  (self.workspace/'shared-cache').write_text('keep');self.sync({'Makefile':'one','web/next.ts':'b'})
  self.assertEqual((self.workspace/'Makefile').stat().st_mtime_ns,stamp);self.assertFalse((self.workspace/'web/main.ts').exists());self.assertEqual((self.workspace/'shared-cache').read_text(),'keep')
 def test_unsafe_archive_is_rejected(self):
  for name in ['../escape','/absolute','.git/config','.tools/native/file','backends/libtorrent/vendor/x']:
   with self.subTest(name=name),patch.object(module,'refresh'),self.assertRaises(RuntimeError):module.sync(self.root,self.archive({name:'bad'}))
  self.assertFalse((self.root.parent/'escape').exists())
 def test_previous_manifest_cannot_remove_unowned_files(self):
  sentinel=self.root/'user-file';sentinel.write_text('keep');module.write(self.root/'sources.json',{'../user-file':module.sha(sentinel)})
  with patch.object(module,'refresh'),self.assertRaises(RuntimeError):module.sync(self.root,self.archive({'Makefile':'safe'}))
  self.assertEqual(sentinel.read_text(),'keep')
  (self.workspace/'linked').symlink_to(self.root,target_is_directory=True)
  with patch.object(module,'refresh'),self.assertRaises(RuntimeError):module.sync(self.root,self.archive({'linked/user-file':'unsafe'}))
  self.assertEqual(sentinel.read_text(),'keep')
 def test_cache_inputs_invalidate_only_affected_outputs(self):
  archive=self.root/'downloads/deps.tgz';archive.parent.mkdir();archive.write_bytes(b'package');digest=module.sha(archive);prefix=self.root/'prefix';prefix.mkdir();(prefix/'deps.tgz.ready').write_text(digest)
  files={'dev/scripts/native-deps.sh':'native','dev/cmake/openbsd.cmake':'cmake','dev/scripts/test-deps.sh':'addons'}
  for name,value in files.items():p=self.workspace/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
  def record():module.write(self.root/'sources.json',{n:module.sha(self.workspace/n) for n in files})
  record();module.write(self.root/'environment.json',{})
  versions={'cxx':'compiler-a','abi':'1'}
  def output(args,**kw):
   if args[0]=='c++':return versions['cxx']
   if args[0] in ['cmake','ninja']:return versions.get('build','tools-a')
   if args[-1]=='process.versions.modules':return versions['abi']
   return 'version'
  paths=['.tools/native','.tools/libtorrent-build','target','.tools/node-datachannel','dev/node_modules/utp-native/build','dev/node_modules/node-datachannel/build']
  def seed():
   for rel in paths:p=self.workspace/rel;p.mkdir(parents=True,exist_ok=True);(p/'cached').write_text('cache')
  with patch.object(module,'PACKAGES',{'deps.tgz':digest}),patch.object(module,'output',side_effect=output):
   module.refresh(self.root);seed();module.refresh(self.root);self.assertTrue(all((self.workspace/p/'cached').exists() for p in paths))
   versions['abi']='2';module.refresh(self.root);self.assertTrue((self.workspace/'target/cached').exists());self.assertFalse((self.workspace/'.tools/node-datachannel').exists())
   seed();versions['cxx']='compiler-b';module.refresh(self.root);self.assertFalse((self.workspace/'target').exists());self.assertFalse((self.workspace/'.tools/native').exists())
   seed();versions['build']='tools-b';module.refresh(self.root);self.assertFalse((self.workspace/'target').exists());self.assertFalse((self.workspace/'.tools/node-datachannel').exists())
   (self.workspace/'dev/scripts/native-deps.sh').write_text('unrecorded')
   with self.assertRaises(AssertionError):module.refresh(self.root)
 def test_failed_command_is_recorded_and_propagated(self):
  module.write(self.root/'environment.json',{});module.write(self.root/'sources.json',{})
  with patch.object(module,'refresh'),contextlib.redirect_stdout(io.StringIO()):code=module.execute(self.root,[sys.executable,'-c','raise SystemExit(7)'])
  self.assertEqual(code,7);record=json.loads(next((self.root/'runs').glob('*/command.json')).read_text());self.assertEqual(record['exit'],7);self.assertGreaterEqual(record['seconds'],0)
 def test_verified_cache_reuse_requires_no_network(self):
  archive=self.root/'downloads/deps.tgz';archive.parent.mkdir();archive.write_bytes(b'package');digest=module.sha(archive)
  prefix=self.root/'prefix';prefix.mkdir();(prefix/'deps.tgz.ready').write_text(digest)
  python=self.root/'python/bin/python';python.parent.mkdir(parents=True);python.touch()
  (self.workspace/'backends/libtorrent/vendor/libtorrent/.git').mkdir(parents=True)
  real_sha=module.sha
  def hash_file(p):return '8871af5ed32b3fe2f38560e0a87f00cfb54b33d89ac2b5d5c313d917e454f1c7' if str(p).endswith('.whl') else real_sha(p)
  from types import SimpleNamespace
  with patch.object(module,'PACKAGES',{'deps.tgz':digest}),patch.object(module,'sha',side_effect=hash_file),patch.object(module.platform,'system',return_value='OpenBSD'),patch.object(module.platform,'release',return_value='8.0'),patch.object(module.platform,'machine',return_value='amd64'),patch.object(module.urllib.request,'urlopen',side_effect=AssertionError('unexpected network')),patch.object(module,'output',return_value=module.PIN),patch.object(module.subprocess,'run',return_value=SimpleNamespace(returncode=0)):
   module.prepare(self.root)
 def test_unowned_directory_is_not_adopted(self):
  sentinel=self.root/'user-file';sentinel.write_text('keep');r=subprocess.run([sys.executable,'dev/scripts/openbsd-validation.py','--root',str(self.root),'status'],capture_output=True)
  self.assertNotEqual(r.returncode,0);self.assertEqual(sentinel.read_text(),'keep');self.assertFalse((self.root/'OWNER').exists())
if __name__=='__main__':unittest.main()
