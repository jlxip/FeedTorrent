import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';
const hash=(n:number)=>n.toString(16).padStart(40,'0');
async function fixture(page){
 const root=await temporary(),app=await startApp(join(root,'app')),password='library presentation password';
 await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
 const {id}=await app.api('/api/publishing',{action:'create_post',title:'Prueba'});
 const value=await app.api('/api/publishing',{action:'get_post',id});value.draft.pages[0].body='Unpublished draft in reading mode';
 await app.api('/api/publishing',{action:'save_draft',id,revision:value.revision,draft:value.draft});
 const state=await wait(async()=>{const s=await app.api();return s.publishing.posts.some(p=>p.id===id&&p.revision>=2)&&s;},'own post snapshot after draft save');
 const transfer=(n:number,total:number)=>({id:hash(n),name:'Prueba',total,verified:total,state:'Seeding',active:true,progress:1,down:0,up:0,peers:0,files:[{name:'metadata/body.md',length:total,verified:total,ready:true}],save_path:'/Downloads',kind:'owned_catalog',post:null,error:'',warning:'',held:false,approval_size:null,pinned:n===1,protected_by:[],used_by:['own:'+id]});
 state.transfers=[transfer(1,150),transfer(2,213),transfer(3,221),transfer(4,300),{...transfer(5,1024),kind:'content'}, {...transfer(6,500),kind:'catalog',used_by:[]}];
 const followed='f'.repeat(40),catalog={id:hash(4),name:'Prueba',total:300,ready:true,state:'Ready',error:'',previous:null,archive:null,foreign_post:null,count:0,indexed:0};
 state.posts=[{id:followed,name:'Prueba',local_name:'Prueba',magnet:'magnet:?xs=urn:btpk:'+'a'.repeat(64),mode:'mirror_catalogs',automatic_limit:null,sequence:'1',head:hash(4),available:hash(4),state:'Ready',error:'',update_peers:0,last_checked_ms:0,catalogs:[catalog],mirror_status:''}];
 state.library_posts=[{post_kind:'own',id,name:'Prueba',representative:hash(3),catalog_ids:[hash(1),hash(2),hash(3)],state:'Published',error:''},{post_kind:'followed',id:followed,name:'Prueba',representative:hash(4),catalog_ids:[hash(3),hash(4)],state:'Ready',error:''}];
 const commands:any[]=[];let fail=false,held:((()=>void)|null)=null,release:(()=>void)|null=null;
 await page.addInitScript(()=>{class Events extends EventTarget{onerror=null;constructor(){super();(window as any).libraryEvents=this;}}(window as any).EventSource=Events;});
 await page.route('**/api/snapshot',r=>r.fulfill({json:state}));
 await page.route('**/api/commands',async r=>{
  const c=r.request().postDataJSON();commands.push(c);
  if(c.type==='read_post_history'){
   if(held){const notify=held;held=null;await new Promise<void>(resolve=>{release=resolve;notify();});}
   const rows=(c.post_kind==='own'?[3,2,1]:[4,3]).map(n=>({id:hash(n),name:'Prueba',total:state.transfers.find(t=>t.id===hash(n))?.total||0,created_at:null,updated_at:n===1?null:1794009600+n,state:state.transfers.find(t=>t.id===hash(n))?.state||'Seeding',error:'',ready:!!state.transfers.find(t=>t.id===hash(n))?.files.length,pinned:n===1}));
   return fail?r.fulfill({status:503,json:{error:'History busy'}}):r.fulfill({json:{post_kind:c.post_kind,id:c.id,versions:rows}});
  }
  if(c.type==='read_content')return r.fulfill({json:{id:c.id,name:'Prueba',total:221,kind:'torrent',files:[],entries:[],count:0,offset:0,body:null,body_state:'absent',body_error:'',error:''}});
  if(c.type==='read_peers')return r.fulfill({json:{id:c.id,peers:[]}});
  if(c.type==='catalog_page')return r.fulfill({json:{catalog,entries:[],offset:0,total:0}});
  if(c.type==='read_catalog_body')return r.fulfill({json:{body:null}});
  return r.fulfill({json:{ok:true}});
 });
 return {root,app,state,id,followed,commands,publish:()=>page.evaluate(s=>(window as any).libraryEvents.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)})),state),fail:(v:boolean)=>fail=v,hold:()=>new Promise<void>(resolve=>{held=resolve;}),release:()=>release?.()};
}

test('Library groups identities and shared catalogs, retains payloads and keeps cards across publication changes',async({page})=>{
 const f=await fixture(page);
 try{
  await page.goto(f.app.url+'/#/library');const own=page.locator(`[data-id="post-own-${f.id}"]`),follow=page.locator(`[data-id="post-followed-${f.followed}"]`);
  await expect(page.locator('#count')).toHaveText('4 items');await expect(page.locator('#transfers article')).toHaveCount(4);
  await expect(own).toContainText('221 B');await expect(follow).toContainText('300 B');await expect(own.locator('a')).toHaveAttribute('href',`#/own/${f.id}/read`);
  await expect(follow.locator('a')).toHaveAttribute('href',`#/posts/${f.followed}`);
  await expect(page.locator(`[data-id="${hash(5)}"]`)).toContainText('1.0 KiB');await expect(page.locator(`[data-id="${hash(6)}"]`)).toBeVisible();
  await own.evaluate(e=>(window as any).originalPostCard=e);
  f.state.transfers.push({...f.state.transfers[2],id:hash(7),total:400});f.state.library_posts[0].catalog_ids.push(hash(7));f.state.library_posts[0].representative=hash(7);await f.publish();
  await expect(own).toContainText('400 B');expect(await own.evaluate(e=>e===(window as any).originalPostCard)).toBe(true);await expect(page.locator('#count')).toHaveText('4 items');
  f.state.library_posts[0].representative=hash(99);await f.publish();await expect(own.locator('.library-size')).toHaveText('—');await expect(own.locator('.library-percent')).toBeEmpty();
  f.state.library_posts.splice(0,1);f.state.publishing.posts=[];f.state.transfers=f.state.transfers.filter(t=>[hash(1),hash(3),hash(4),hash(5),hash(6)].includes(t.id));await f.publish();
  await expect(page.locator(`[data-id="${hash(1)}"]`)).toBeVisible();await expect(own).toHaveCount(0);await expect(page.locator('#count')).toHaveText('4 items');
 }finally{f.release();await cleanup(f.root,f.app);}
});

test('own card opens draft in reading and local History preserves content through errors and updates',async({page},info)=>{
 const f=await fixture(page);
 try{
  await page.goto(f.app.url+'/#/library');await page.locator(`[data-id="post-own-${f.id}"] a`).click();
  await expect(page.locator('#own-preview')).toContainText('Unpublished draft in reading mode');await expect(page.locator('#own-editor')).toBeHidden();
  const history=page.locator('#own-local-history');expect(f.commands.filter(c=>c.type==='read_post_history')).toHaveLength(0);
  await history.locator('summary').click();await expect(history.locator('a')).toHaveCount(3);await expect(history).toContainText('Unknown date');await expect(history).toContainText('Pin');await expect(history).toContainText('221 B');
  for(const width of [1280,320])for(const theme of ['light','dark'] as const){
   await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
   expect(await history.locator('div').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
   expect(await history.evaluate(e=>Math.abs(e.querySelector('div')!.getBoundingClientRect().left-e.querySelector('summary')!.getBoundingClientRect().left))).toBeLessThanOrEqual(1);
   await expect.poll(()=>history.locator('a').first().evaluate(e=>getComputedStyle(e).color===getComputedStyle(document.body).color)).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`post-history-${width}-${theme}.png`),animations:'disabled'});
  }
  f.state.transfers[1].total=0;f.state.transfers[1].files=[];f.state.transfers[1].state='Waiting for metadata';await f.publish();
  await expect(history).toContainText('Waiting for metadata');await expect(history).toContainText('—');await expect(history.getByText('0 B',{exact:true})).toHaveCount(0);
  f.fail(true);f.state.transfers[0].pinned=false;await f.publish();await expect(history).toContainText('History unavailable');await expect(history.locator('a')).toHaveCount(0);await expect(page.locator('#own-preview')).toContainText('Unpublished draft in reading mode');
  f.fail(false);await history.locator('summary').click();await history.locator('summary').click();await expect(history.locator('a')).toHaveCount(3);
  await history.locator(`a[href="#/library/${hash(1)}"]`).click();await expect(page).toHaveURL(new RegExp('#/library/'+hash(1)+'$'));await expect(page.locator('#torrent-heading')).toHaveText('Prueba');
  expect(f.commands.some(c=>['add_torrent','add_magnet','resume','pause','set_pin'].includes(c.type))).toBe(false);
 }finally{f.release();await cleanup(f.root,f.app);}
});

test('followed History and old direct links survive Back and discard replies from the previous post',async({page})=>{
 const f=await fixture(page);
 try{
  await page.goto(f.app.url+'/#/library');await page.locator(`[data-id="post-followed-${f.followed}"] a`).click();const history=page.locator('#post-history');
  await history.locator('summary').click();await expect(history.locator('a')).toHaveCount(2);await history.locator(`a[href="#/library/${hash(3)}"]`).click();await expect(page).toHaveURL(new RegExp('#/library/'+hash(3)+'$'));
  await page.goBack();await expect(page).toHaveURL(new RegExp('#/posts/'+f.followed+'$'));await history.locator('summary').click();await expect(history.locator('a')).toHaveCount(2);
  await page.goto(f.app.url+'/#/own/'+f.id+'/read');const own=page.locator('#own-local-history'),waiting=f.hold();await own.locator('summary').click();await waiting;
  await page.goto(f.app.url+'/#/posts/'+f.followed);f.release();await expect(own).toBeHidden();await history.locator('summary').click();await expect(history.locator('a')).toHaveCount(2);await expect(history).not.toContainText('150 B');
 }finally{f.release();await cleanup(f.root,f.app);}
});
