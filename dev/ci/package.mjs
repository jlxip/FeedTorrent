// Package only audited executables. No compiler or source tree is needed to run them.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,copyFile,cp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';

const command=(name,args=[],options={})=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function auditMacTarget(commands){
  // A build command also lists linker tool versions; those are not OS versions.
  const minimums=[...commands.matchAll(/cmd LC_BUILD_VERSION[\s\S]*?\n\s+minos (\d+\.\d+(?:\.\d+)?)/g),...commands.matchAll(/cmd LC_VERSION_MIN_MACOSX[\s\S]*?\n\s+version (\d+\.\d+(?:\.\d+)?)/g)].map(m=>m[1]);
  assert(minimums.length&&minimums.every(v=>{const [major,...rest]=v.split('.').map(Number);return major<15||(major===15&&rest.every(n=>n===0))}),'Executable requires macOS newer than 15; rebuild with MACOSX_DEPLOYMENT_TARGET=15.0');
}
export function auditDependencies(platform,output){
  assert(!/not found/.test(output),'Unresolved runtime library');
  const dependencies=[];
  for(const line of output.split('\n')){
    let path;
    if(platform==='darwin'){
      if(!/^\s/.test(line))continue;
      path=line.trim().split(/\s/)[0];
      assert(path.startsWith('/usr/lib/')||path.startsWith('/System/Library/Frameworks/'),`External macOS library: ${path}`);
    }else if(platform==='linux'){
      if(/linux-vdso/.test(line))continue;
      path=line.includes('=>')?line.split('=>')[1].trim().split(/\s/)[0]:line.trim().split(/\s/)[0];
      assert(/^\/(?:usr\/)?lib(?:64)?\//.test(path),`External Linux library: ${path}`);
      assert(/^(?:lib(?:c|m|pthread|dl|rt|stdc\+\+|gcc_s|atomic)\.so(?:\.|$)|ld-linux[^/]*\.so)/.test(basename(path)),`Unexpected Linux library: ${path}`);
    }else if(platform==='openbsd'){
      const fields=line.trim().split(/\s+/);
      if(!['rlib','ld.so'].includes(fields[2]))continue;
      path=fields.at(-1);
      assert(/^\/usr\/lib\/lib(?:ssl|crypto|c\+\+|c\+\+abi|pthread|c|m)\.so\./.test(path)||path==='/usr/libexec/ld.so',`External OpenBSD library: ${path}`);
    }else throw Error(`Unsupported platform: ${platform}`);
    dependencies.push(path);
  }
  assert(dependencies.length,'No runtime dependencies inspected');
  return dependencies;
}

export async function smoke(binary){
  const root=await mkdtemp(join(tmpdir(),'feedtorrent-smoke-'));
  let child,exit;
  try{
    await mkdir(join(root,'home'));
    child=spawn(binary,['--no-open','--isolated','--data-dir',join(root,'state'),'--download-dir',join(root,'downloads'),'--peer-port','0'],{cwd:root,env:{...process.env,HOME:join(root,'home'),PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
    let logs='';
    child.stdout.on('data',b=>{logs+=b});child.stderr.on('data',b=>{logs+=b});
    exit=once(child,'exit');
    const deadline=Date.now()+30000;let url;
    while(!(url=logs.match(/FeedTorrent (http:\/\/127\.0\.0\.1:\d+)/)?.[1])){
      assert(child.exitCode===null,`Packaged executable failed: ${logs}`);
      assert(Date.now()<deadline,`Packaged executable startup timed out: ${logs}`);
      await new Promise(r=>setTimeout(r,50));
    }
    const response=await fetch(url+'/',{headers:{Connection:'close'}});assert.equal(response.status,200);
    const html=await response.text(),cookie=response.headers.get('set-cookie')?.split(';')[0];
    assert(cookie,'Missing application session');
    const assets=[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m=>new URL(m[1],url+'/')).filter(asset=>/\.(?:css|js)$/.test(asset.pathname));
    assert(assets.length,'No embedded assets found');
    // Drain every body; abandoned fetch streams can keep Axum's graceful
    // shutdown waiting on an unfinished response, notably with BSD buffers.
    for(const asset of assets){
      assert.equal(asset.origin,url,'External interface asset');
      const resource=await fetch(asset,{headers:{Connection:'close'}});assert.equal(resource.status,200,String(asset));
      assert(resource.headers.get('content-type')?.startsWith(asset.pathname.endsWith('.css')?'text/css':'text/javascript'));
      assert((await resource.arrayBuffer()).byteLength>0,'Empty embedded asset');
    }
    const snapshot=await fetch(url+'/api/snapshot',{headers:{Cookie:cookie,Origin:url,Connection:'close'}});
    assert.equal(snapshot.status,200);assert.equal(typeof await snapshot.json(),'object');
    // Match the service/native-suite shutdown in non-interactive CI sessions.
    child.kill('SIGTERM');
    const [code]=await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Packaged executable did not stop')),15000);timer.unref()})]);
    assert.equal(code,0,'Packaged executable shutdown failed');
    return {http:200,api:200,assets:assets.length,shutdown:code};
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit.catch(()=>{})}
    await rm(root,{recursive:true,force:true});
  }
}

export async function packageRelease(){
  const platform=process.platform,arch=process.arch;
  assert(['darwin','linux','openbsd'].includes(platform));
  assert.equal(arch,platform==='darwin'?'arm64':'x64','Unsupported package architecture');
  const release=command('uname',['-r']);
  if(platform==='openbsd')assert.equal(release,'8.0');
  const root=resolve('.'),output=resolve('dist');await mkdir(output,{recursive:true});
  const revision=command('git',['rev-parse','HEAD']);
  const tag=process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:null;
  const version=tag||revision.slice(0,12);assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version));
  const os=platform==='darwin'?'macos':platform==='openbsd'?'openbsd-8.0':'linux';
  const target=`${os}-${arch==='x64'?'amd64':'arm64'}`;
  const name=`feedtorrent-${version}-${target}`,binary=resolve('target/release/feedtorrent');
  const linkage=command(platform==='darwin'?'otool':'ldd',platform==='darwin'?['-L',binary]:[binary]);
  const dependencies=auditDependencies(platform,linkage);
  if(platform==='darwin'){
    auditMacTarget(command('otool',['-l',binary]));
  }
  const cache=await readFile('.tools/libtorrent-build/CMakeCache.txt','utf8');
  const include=cache.match(/^OPENSSL_INCLUDE_DIR:[^=]+=(.+)$/m)?.[1];assert(include,'Missing native TLS headers');
  const tlsHeaders=await readFile(join(include,'openssl/opensslv.h'),'utf8');
  const native={libtorrent:(await readFile('.tools/native/lib/pkgconfig/libtorrent-rasterbar.pc','utf8')).match(/^Version: (.+)$/m)?.[1],libtorrent_commit:command('git',['-C','backends/libtorrent/vendor/libtorrent','rev-parse','HEAD']),tls:tlsHeaders.match(/^#\s*define\s+(?:LIBRESSL_VERSION_TEXT|OPENSSL_VERSION_TEXT)\s+"([^"]+)"/m)?.[1]};
  const boost=cache.match(/^Boost_INCLUDE_DIR:[^=]+=(.+)$/m)?.[1];
  if(boost)native.boost=(await readFile(join(boost,'boost/version.hpp'),'utf8')).match(/^#define BOOST_LIB_VERSION "([^"]+)"/m)?.[1];
  const temp=await mkdtemp(join(output,'.package-'));
  try{
    const stage=join(temp,name);await mkdir(stage);
    await copyFile(binary,join(stage,'feedtorrent'));await chmod(join(stage,'feedtorrent'),0o755);
    await cp('target/release/licenses',join(stage,'licenses'),{recursive:true});
    await copyFile('target/release/THIRD_PARTY.json',join(stage,'THIRD_PARTY.json'));
    const sourceFiles=command('git',['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean).sort();
    const sources=[];for(const file of sourceFiles){try{sources.push([file,sha(await readFile(file))])}catch(error){if(error.code!=='EISDIR'&&error.code!=='ENOENT')throw error}}
    const info={commit:revision,tag,dirty:!!command('git',['status','--porcelain']),target,host_release:release,compatibility:platform==='darwin'?'macOS >=15':platform==='linux'?'Ubuntu 24.04 x86_64':'OpenBSD 8.0 amd64',source_sha256:sha(JSON.stringify(sources)),binary_sha256:sha(await readFile(binary)),tools:{rustc:command('rustc',['--version']),cargo:command('cargo',['--version']),node:process.version,cxx:command('c++',['--version']).split('\n')[0],cmake:command('cmake',['--version']).split('\n')[0]},native,dependencies,linkage};
    await writeFile(join(stage,'BUILD-INFO.json'),JSON.stringify(info,null,2)+'\n');
    const archive=join(output,name+'.tar.gz');command('tar',['-czf',archive,'-C',temp,name],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    // Exercise the actual extracted payload, outside both the source and build trees.
    const extracted=await mkdtemp(join(tmpdir(),'feedtorrent-package-'));
    try{command('tar',['-xzf',archive,'-C',extracted]);console.log(JSON.stringify({package:basename(archive),smoke:await smoke(join(extracted,name,'feedtorrent')),dependencies},null,2))}finally{await rm(extracted,{recursive:true,force:true})}
    await writeFile(archive+'.sha256',`${sha(await readFile(archive))}  ${basename(archive)}\n`);
    return archive;
  }finally{await rm(temp,{recursive:true,force:true})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await packageRelease();
