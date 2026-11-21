import {runRoot} from './runtime.mjs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const binary=join(runRoot,'rtc-admission');
execFileSync(process.env.CXX||'c++',['-std=c++17','-Wall','-Wextra','-Werror','-I'+resolve('backends/libtorrent/src/native/include'),'dev/tests/rtc-admission.cpp','-o',binary],{stdio:'inherit'});
execFileSync(binary,[],{stdio:'inherit'});
