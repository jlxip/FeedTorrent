import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditDependencies,auditMacTarget} from '../ci/package.mjs';
test('macOS minimum ignores SDK/linker versions and enforces the advertised OS floor',()=>{
  auditMacTarget('cmd LC_BUILD_VERSION\n platform 1\n minos 15.0\n sdk 27.2\n tool 3\n version 27106.1');
  auditMacTarget('cmd LC_VERSION_MIN_MACOSX\n version 14.0\n sdk 15.0');
  for(const minimum of ['15.1','16.0','26.0'])assert.throws(()=>auditMacTarget(`cmd LC_BUILD_VERSION\n minos ${minimum}`));
  assert.throws(()=>auditMacTarget('cmd LC_SOURCE_VERSION\n version 0.0'));
});
test('macOS package cannot depend on Homebrew or unresolved runtime paths',()=>{
  assert.deepEqual(auditDependencies('darwin','binary:\n\t/usr/lib/libc++.1.dylib (compatibility version 1)'),['/usr/lib/libc++.1.dylib']);
  for(const path of ['/opt/homebrew/lib/libssl.dylib','@rpath/libssl.dylib'])assert.throws(()=>auditDependencies('darwin',`binary:\n\t${path} (compatibility version 1)`));
});
test('Linux package rejects dynamic TLS, missing and private libraries',()=>{
  assert.equal(auditDependencies('linux','linux-vdso.so.1 (0x0)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n/lib64/ld-linux-x86-64.so.2 (0x0)').length,2);
  for(const line of ['libssl.so.3 => /lib/x86_64-linux-gnu/libssl.so.3 (0x0)','libfoo.so => not found','libc.so.6 => /tmp/build/libc.so.6 (0x0)'])assert.throws(()=>auditDependencies('linux',line));
});
test('OpenBSD package uses base libraries only',()=>{
  assert.equal(auditDependencies('openbsd','Start End Type Open Ref GrpRef Name\n0000 0001 rlib 0 1 0 /usr/lib/libssl.so.60.2\n0000 0000 ld.so 0 1 0 /usr/libexec/ld.so').length,2);
  assert.throws(()=>auditDependencies('openbsd','0000 0001 rlib 0 1 0 /usr/local/lib/libssl.so.60.2'));
  assert.throws(()=>auditDependencies('openbsd','Start End Type Open Ref GrpRef Name'));
});
