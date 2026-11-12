import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

const torrent='56f31e2d486209003454e245d11561cd252be30f';
const torrentMagnet='magnet:?xt=urn:btih:K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP&dn=Equivalent';
const freshTorrent='9'.repeat(40),catalog='8'.repeat(40);
const text=(text:string)=>({kind:'text',text,children:[]});
const transfer=(id=torrent)=>({id,name:'Existing torrent',state:'Seeding',active:true,progress:1,verified:12,total:12,down:0,up:0,peers:0,held:false,approval_size:null,files:[],save_path:'/Downloads',kind:'torrent',post:null,error:'',warning:'',pinned:false});
function followed(own:any){return {id:own.id,name:own.title,local_name:'Preserved name',magnet:own.magnet,mode:'mirror_all',automatic_limit:4194304,sequence:'1',head:catalog,available:catalog,state:'Following',error:'',update_peers:0,last_checked_ms:0,mirror_status:'',catalogs:[{id:catalog,name:'Home',total:12,ready:true,state:'Seeding',error:'',previous:null,archive:null,foreign_post:null,count:0,indexed:0}]};}
async function fixture(page:any){
 const root=await temporary(),app=await startApp(join(root,'app'));
 try{
  const password='magnet reader test passphrase';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const own:any[]=[];
  for(const title of ['jlxip','Genesis','Following','New post']){
   const {id}=await app.api('/api/publishing',{action:'create_post',title});
   await expect.poll(async()=>(await app.api()).publishing.posts.some((p:any)=>p.id===id)).toBe(true);
   own.push((await app.api()).publishing.posts.find((p:any)=>p.id===id));
  }
  const [origin,genesis,target,fresh]=own;
  const links={Genesis:genesis.magnet+'&dn=Equivalent',Following:target.magnet,Torrent:torrentMagnet,'New torrent':'magnet:?xt=urn:btih:'+freshTorrent,'New post':fresh.magnet,Invalid:'magnet:?xt=urn:btih:invalid'};
  const body={kind:'document',children:Object.entries(links).map(([label,target])=>({kind:'p',children:[{kind:'link',target,children:[text(label)]}]}))};
  for(const post of [origin,genesis])await app.api('/api/publishing',{action:'save_draft',id:post.id,revision:1,draft:{root:1,pages:[{id:1,title:post.title,body:post===origin?Object.entries(links).map(([label,uri])=>`[${label}](${uri})`).join('\n\n'):'Genesis body',entries:[]}]}});
  const snapshot=await app.api();snapshot.publishing.posts=snapshot.publishing.posts.filter((p:any)=>[origin.id,genesis.id].includes(p.id));
  snapshot.posts=[followed(origin),followed(target),followed(genesis)];snapshot.transfers=[transfer()];
  const commands:any[]=[],gates=new Map<string,Promise<void>>();
  await page.addInitScript(()=>{class Events extends EventTarget{onerror:any=null;};(window as any).EventSource=Events;});
  await page.route('**/api/snapshot',r=>r.fulfill({json:snapshot}));
  await page.route('**/api/commands',async r=>{
   const c=r.request().postDataJSON();commands.push(c);
   if(c.type==='inspect_source'){if(gates.has(c.uri))await gates.get(c.uri);await r.continue();}
   else if(c.type==='catalog_page')await r.fulfill({json:{catalog:followed(origin).catalogs[0],entries:[],offset:0,total:0}});
   else if(c.type==='read_catalog_body')await r.fulfill({json:{body}});
   else if(c.type==='read_content')await r.fulfill({json:{id:c.id,name:'Nested page',total:12,kind:'catalog',files:[],entries:[],count:0,offset:0,body,body_state:'ready',body_error:'',error:''}});
   else if(c.type==='follow_post'){snapshot.posts.push(followed(fresh));await r.fulfill({json:{ok:true}});}
   else if(c.type==='add_magnet'){const id=c.uri.includes(freshTorrent)?freshTorrent:torrent;const old=snapshot.transfers.find((t:any)=>t.id===id);if(old)old.pinned=true;else snapshot.transfers.push(transfer(id));await r.fulfill({json:{ok:true}});}
   else await r.continue();
  });
  const mutations=()=>commands.filter(c=>['add_magnet','follow_post','configure_post','set_pin','resume','pause'].includes(c.type));
  const open=async(reader='own')=>{
   const hash=reader==='own'?`#/own/${origin.id}/read/1`:reader==='followed'?`#/posts/${origin.id}`:`#/posts/${origin.id}/torrent/${catalog}`;
   await page.goto(app.url+'/'+hash);await expect(page.getByRole('link',{name:'Genesis',exact:true})).toBeVisible();return hash;
  };
  return {root,app,origin,genesis,target,fresh,links,snapshot,commands,gates,mutations,open};
 }catch(error){await cleanup(root,app);throw error;}
}
for(const reader of ['own','followed','nested'])test(`${reader} magnet links open existing targets without changing download state`,async({page})=>{
 const x=await fixture(page);
 try{
  const origin=await x.open(reader);
  await page.getByRole('link',{name:'Genesis',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`#/own/${x.genesis.id}/read/1$`));await expect(page.locator('#own-preview')).toContainText('Genesis body');
  await expect(page.locator('dialog[open]')).toHaveCount(0);await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  for(const state of ['Following','Downloading','Paused','Error']){
   const post=x.snapshot.posts.find((p:any)=>p.id===x.target.id)!;post.state=state;post.error=state==='Error'?'Test error':'';
   const before=JSON.stringify(post);await page.getByRole('link',{name:'Following',exact:true}).click();await expect(page).toHaveURL(new RegExp(`#/posts/${post.id}$`));
   expect(JSON.stringify(post)).toBe(before);await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  }
  for(const state of ['Seeding','Downloading','Paused','Error']){
   const t=x.snapshot.transfers[0];Object.assign(t,{state,active:!['Paused','Error'].includes(state),progress:state==='Seeding'?1:.2,error:state==='Error'?'Test error':'',pinned:false});
   const before=JSON.stringify(t);await page.getByRole('link',{name:'Torrent',exact:true}).click();await expect(page).toHaveURL(new RegExp(`#/library/${torrent}$`));
   await expect(page.locator('dialog[open]')).toHaveCount(0);expect(JSON.stringify(t)).toBe(before);await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  }
  expect(x.mutations()).toEqual([]);
 }finally{await cleanup(x.root,x.app);}
});

test('new magnets request confirmation, retain the origin on cancellation and fit mobile and desktop',async({page},info)=>{
 const x=await fixture(page);
 try{
  const origin=await x.open();
  for(const [label,dialog] of [['New torrent','#open-dialog'],['New post','#post-dialog']]){
   await page.getByRole('link',{name:label,exact:true}).click();await expect(page.locator(dialog)).toBeVisible();
   expect(x.mutations()).toEqual([]);await expect(page).toHaveURL(new RegExp(origin+'$'));
   for(const width of [320,1280])for(const theme of ['light','dark'] as const){
    await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
    await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
    expect(await page.locator(dialog).evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth;})).toBe(true);
    await page.screenshot({path:info.outputPath(`${label}-${width}-${theme}.png`),animations:'disabled'});
   }
   await page.locator(dialog).getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator(dialog)).toBeHidden();await expect(page).toHaveURL(new RegExp(origin+'$'));
  }
  await page.getByRole('link',{name:'New torrent',exact:true}).click();await expect(page.locator('#magnet')).toHaveValue(x.links['New torrent']);
  await page.locator('#magnet-form button[type=submit]').click();await expect(page).toHaveURL(/#\/library$/);expect(x.mutations()).toEqual([{type:'add_magnet',uri:x.links['New torrent']}]);
  await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  await page.getByRole('link',{name:'New post',exact:true}).click();await expect(page.locator('#post-magnet')).toHaveValue(x.links['New post']);
  await page.locator('#post-submit').click();await expect(page).toHaveURL(new RegExp(`#/posts/${x.fresh.id}$`));
  expect(x.mutations().filter(c=>c.type==='follow_post')).toHaveLength(1);
 }finally{await cleanup(x.root,x.app);}
});

test('confirmation rechecks targets added in another tab, while manual Open keeps its download intent',async({page})=>{
 const x=await fixture(page);
 try{
  const origin=await x.open();
  await page.getByRole('link',{name:'New torrent',exact:true}).click();await expect(page.locator('#open-dialog')).toHaveJSProperty('open',true);await expect(page.locator('#open-dialog')).toBeVisible();
  const t={...transfer(freshTorrent),state:'Paused',active:false,pinned:false};x.snapshot.transfers.push(t);
  await page.locator('#magnet-form button[type=submit]').click();await expect(page).toHaveURL(new RegExp(`#/library/${freshTorrent}$`));expect(t.pinned).toBe(false);expect(x.mutations()).toEqual([]);
  await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  await page.getByRole('link',{name:'New post',exact:true}).click();await expect(page.locator('#post-dialog')).toHaveJSProperty('open',true);await expect(page.locator('#post-dialog')).toBeVisible();
  x.snapshot.publishing.posts.push(x.fresh);
  await page.locator('#post-submit').click();await expect(page).toHaveURL(new RegExp(`#/own/${x.fresh.id}/read/1$`));await expect(page.locator('#post-dialog')).toBeHidden();expect(x.mutations()).toEqual([]);
  await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));
  x.snapshot.publishing.posts=x.snapshot.publishing.posts.filter((p:any)=>p.id!==x.fresh.id);
  await page.getByRole('link',{name:'New post',exact:true}).click();await expect(page.locator('#post-dialog')).toHaveJSProperty('open',true);await expect(page.locator('#post-dialog')).toBeVisible();
  const post=followed(x.fresh);post.state='Paused';x.snapshot.posts.push(post);const before=JSON.stringify(post);
  await page.locator('#post-submit').click();await expect(page).toHaveURL(new RegExp(`#/posts/${x.fresh.id}$`));expect(JSON.stringify(post)).toBe(before);expect(x.mutations()).toEqual([]);
  await page.locator('#open-button').click();await page.locator('#magnet').fill(torrentMagnet);await page.locator('#magnet-form button[type=submit]').click();await expect(page).toHaveURL(/#\/library$/);
  expect(x.mutations()).toEqual([{type:'add_magnet',uri:torrentMagnet}]);expect(x.snapshot.transfers[0].pinned).toBe(true);
 }finally{await cleanup(x.root,x.app);}
});

test('invalid magnets and late identification cannot add targets or replace a newer click or page',async({page})=>{
 const x=await fixture(page);const releases:(()=>void)[]=[];
 const finish=async(release:()=>void,uri:string)=>{
  const response=page.waitForResponse(r=>r.url().endsWith('/api/commands')&&r.request().postDataJSON()?.uri===uri);
  release();await (await response).finished();await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
 };
 const delay=(uri:string)=>{let release!:()=>void;x.gates.set(uri,new Promise<void>(r=>release=r));releases.push(release);return release;};
 try{
  const origin=await x.open();await page.getByRole('link',{name:'Invalid',exact:true}).click();await expect(page.locator('#notice')).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);expect(x.mutations()).toEqual([]);
  const release=delay(x.links['New post']);await page.getByRole('link',{name:'New post',exact:true}).click();await expect.poll(()=>x.commands.filter(c=>c.uri===x.links['New post']).length).toBe(1);
  await page.getByRole('link',{name:'New torrent',exact:true}).dblclick();await expect(page.locator('#open-dialog')).toHaveJSProperty('open',true);await expect(page.locator('#open-dialog')).toBeVisible();await finish(release,x.links['New post']);
  await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(page.locator('#post-dialog')).toBeHidden();await page.locator('#open-dialog').getByRole('button',{name:'Close',exact:true}).click();
  const release2=delay(x.links['New post']);await page.getByRole('link',{name:'New post',exact:true}).click();await expect.poll(()=>x.commands.filter(c=>c.uri===x.links['New post']).length).toBe(2);
  await page.locator('#transfers-nav').click();await expect(page).toHaveURL(/#\/library$/);await page.goBack();await expect(page).toHaveURL(new RegExp(origin+'$'));await finish(release2,x.links['New post']);await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByRole('link',{name:'Torrent',exact:true}).click();await expect(page).toHaveURL(new RegExp(`#/library/${torrent}$`));await expect(page.locator('dialog[open]')).toHaveCount(0);expect(x.mutations()).toEqual([]);
 }finally{for(const release of releases)release();await cleanup(x.root,x.app);}
});
