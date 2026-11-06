import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const root = await mkdtemp(resolve('.runtime/posts-consumer-'));
try {
  await mkdir(join(root, 'src'));
  await writeFile(
      join(root, 'Cargo.toml'),
      `[package]\nname="posts-consumer"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nfeedtorrent-posts={path=${
          JSON.stringify(resolve('posts'))}}\nfeedtorrent-bep={path=${JSON.stringify(resolve('bep'))}}\n`);
  await writeFile(
      join(root, 'src/main.rs'), `use feedtorrent_posts::{Config,PostManager,Mode,Action};
fn main(){let signer=feedtorrent_bep::bep44::Bep44Signer::from_seed(&[9;32]);let key=feedtorrent_bep::bep44::MutableKey::new(signer.public_key(),vec![7;32]).unwrap();let mut d=feedtorrent_posts::publishing::Draft::new("portable".into());d.pages[0].body="# Portable".into();let built=d.build(&key,&Default::default()).unwrap();assert_eq!(built.catalogs.len(),1);feedtorrent_posts::markdown::parse(&d.pages[0].body).unwrap();let mut m=PostManager::new();let id=m.follow("magnet:?xs=urn:btpk:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",Config::default(),0).unwrap();assert!(m.drain_actions().is_empty());let checkpoint=m.checkpoint().unwrap();m.acknowledge_checkpoint();assert!(m.drain_actions().iter().any(|a|matches!(a,Action::Watch{..})));let mut restored=PostManager::restore(&checkpoint).unwrap();restored.start(0);assert_eq!(restored.views()[0].id,id);assert_eq!(restored.views()[0].mode,Mode::CurrentCatalog);}
`);
  const options = {cwd: root, encoding: 'utf8'};
  execFileSync('cargo', ['run', '--offline', '--quiet'], options);
  const graph = JSON.parse(
      execFileSync('cargo', ['metadata', '--offline', '--format-version', '1'], options));
  const names = graph.packages.map(p => p.name);
  for (const x
           of ['feedtorrent', 'feedtorrent-libtorrent', 'feedtorrent-pubsub-udp', 'cxx',
               'cxx-build', 'axum', 'tokio', 'socket2', 'getrandom'])
    assert(!names.includes(x), x);
  execFileSync(
      'cargo', ['check', '--locked', '--offline', '--target', 'wasm32-unknown-unknown'],
      options);
  console.log(
      'PASS standalone host-driven post consumer runs natively and compiles for WASM without native/application dependencies');
  await mkdir('.runtime/evidence', {recursive: true});
  await writeFile(
      '.runtime/evidence/posts-consumer.json',
      JSON.stringify(
          {time: new Date().toISOString(), status: 'pass', packages: names}, null, 2) +
          '\n');
} finally {
  await rm(root, {recursive: true, force: true})
}
