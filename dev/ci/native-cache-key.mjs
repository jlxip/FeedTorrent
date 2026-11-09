// A native archive is reusable only with the same source and C++ toolchain.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..');
const run=(name,args)=>execFileSync(name,args,{cwd:root,encoding:'utf8'}).trim();
const target=process.env.NATIVE_CACHE_TARGET;
if(!['macos-arm64','linux-amd64'].includes(target))throw Error('Unknown native cache target');

const inputs={
  target,
  libtorrent:run('git',['-C','backends/libtorrent/vendor/libtorrent','rev-parse','HEAD']),
  trySignal:run('git',['-C','backends/libtorrent/vendor/libtorrent/deps/try_signal','rev-parse','HEAD']),
  platform:run('uname',['-s','-m']),
  compiler:run('c++',['--version']),
  cmake:run('cmake',['--version']),
  ninja:run('ninja',['--version']),
  pkgConfig:run('pkg-config',['--version']),
  scripts:['dev/scripts/native-deps.sh','dev/cmake/openbsd.cmake','.gitmodules'].map(file=>
    [file,createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')]),
  environment:Object.fromEntries(['CC','CXX','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS',
    'OPENSSL_ROOT_DIR','BOOST_ROOT','CMAKE_PREFIX_PATH','MACOSX_DEPLOYMENT_TARGET']
    .map(name=>[name,process.env[name]??''])),
};
if(target==='macos-arm64'){
  inputs.packages=run('brew',['list','--versions','boost','openssl@3','cmake','ninja','pkg-config']);
  inputs.sdk=run('xcrun',['--show-sdk-path']);
  inputs.deployment='15.0'; // native-deps.sh's default and dev/ci/run.sh's target
}else{
  inputs.packages=run('dpkg-query',['-W','-f=${Package}=${Version}\n',
    'g++','libc6-dev','libboost-dev','libssl-dev','cmake','ninja-build','pkg-config']);
}
const digest=createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
const key=`libtorrent-v2-${target}-${digest}`;
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`key=${key}\n`);
console.log(key);
