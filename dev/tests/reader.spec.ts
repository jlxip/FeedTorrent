import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import bencode from 'bencode';
import {cleanup,startApp,temporary} from './helpers.mjs';

const hash=(n:number)=>n.toString(16).padStart(40,'0');
async function followed(page){
 const root=await temporary(),app=await startApp(join(root,'app')),snapshot=await app.api();
 const catalog=(n:number,name:string,count=1)=>({id:hash(n),name,total:100,ready:true,state:'Seeding',error:'',previous:n===1?hash(9):null,archive:n===1?hash(8):null,foreign_post:null,count,indexed:count});
 const f={id:hash(100),name:'Field notes',local_name:'Field notes',magnet:'magnet:?xs=urn:btpk:'+'b'.repeat(64),mode:'current_catalog',automatic_limit:8388608,sequence:'42',head:hash(1),available:hash(1),state:'Following',error:'',update_peers:12,last_checked_ms:0,mirror_status:'',catalogs:[catalog(1,'Home',105),catalog(2,'Updated'),catalog(3,'Wiring notes'),catalog(8,'Archive'),catalog(9,'Previous')]};
 snapshot.posts=[f];
 snapshot.transfers=[{id:hash(3),name:'Wiring notes',state:'Seeding',active:true,progress:1,verified:12,total:12,down:0,up:0,peers:0,held:false,approval_size:null,files:[],save_path:'/Downloads',kind:'catalog',post:f.id,error:'',warning:''}];
 const entries=Array.from({length:105},(_,index)=>({index,source_name:`file-${index}.txt`,name:`file-${index}.txt`,length:12,kind:'file',infohash:null,total:null,state:'Available',error:'',post_magnet:null,files:[]}));
 Object.assign(entries[0],{source_name:'wiring.torrent',name:'Wiring notes',kind:'catalog',infohash:hash(3)});
 Object.assign(entries[1],{source_name:'models.torrent',name:'Readable model name',kind:'torrent',infohash:hash(4),total:4096});
 const text=(s:string)=>({kind:'document',children:[{kind:'p',children:[{kind:'text',text:s,children:[]}]}]});
 const body={kind:'document',children:[{kind:'h1',children:[{kind:'text',text:'Workshop notes',children:[]}]},{kind:'p',children:[{kind:'link',target:'models.torrent',children:[{kind:'text',text:'Get models',children:[]}]},{kind:'text',text:' · ',children:[]},{kind:'link',target:'file-104.txt',children:[{kind:'text',text:'Last file',children:[]}]}]}]};
 const commands:any[]=[];
 await page.addInitScript(()=>{class Events extends EventTarget{onerror:any=null;constructor(){super();(window as any).__readerEvents=this;}};(window as any).EventSource=Events;});
 await page.route('**/api/snapshot',r=>r.fulfill({json:snapshot}));
 await page.route('**/api/commands',async route=>{
  const c=route.request().postDataJSON();commands.push(c);
  if(c.type==='read_content'){await route.fulfill({json:{id:c.id,name:c.id===hash(3)?'Wiring notes':'Readable model name',total:4096,kind:c.id===hash(3)?'catalog':'torrent',files:[],entries:c.id===hash(3)?[{...entries[2],index:0,name:'child.txt',source_name:'child.txt'}]:[],count:c.id===hash(3)?1:0,offset:0,body:c.id===hash(3)?text('Child page'):null,body_state:c.id===hash(3)?'ready':'absent',body_error:'',error:''}});}
  else if(c.type==='catalog_page'){
   const data=c.catalog===hash(1)?entries:[{...entries[2],index:0,name:c.catalog===hash(2)?'new.txt':'child.txt',source_name:'child.txt'}];
   await route.fulfill({json:{catalog:f.catalogs.find(x=>x.id===c.catalog),entries:data.slice(c.offset,c.offset+100),offset:c.offset,total:data.length}});
  }else if(c.type==='read_catalog_body')await route.fulfill({json:{body:c.catalog===hash(1)?body:text(c.catalog===hash(3)?'Child page':'New text')}});
  else {
   if(c.type==='download_entry')snapshot.transfers.push({id:hash(4),name:'Readable model name',state:'Downloading',active:true,progress:.2,verified:0,total:4096,down:0,up:0,peers:0,held:false,approval_size:null,files:[],save_path:'/Downloads',kind:'',post:null,error:'',warning:''});
   await route.fulfill({json:{ok:true}});
  }
 });
 return {root,app,snapshot,f,commands,publish:()=>page.evaluate(s=>(window as any).__readerEvents.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)})),snapshot)};
}

test('followed reader keeps reading, resolves original names across pages and pins versions',async({page},info)=>{
 const x=await followed(page),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(x.app.url+'/#/posts/'+x.f.id);
  await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  await expect(page.locator('#entry-detail')).toHaveCount(0);await expect(page.locator('#catalog-range')).toHaveText('1–100 / 105');
  await page.getByRole('link',{name:'Last file',exact:true}).click();
  await expect.poll(()=>x.commands.some(c=>c.type==='reveal_entry'&&c.index===104)).toBe(true);
  await page.getByRole('link',{name:'Get models',exact:true}).click();
  await expect(page.locator('#post-reader').getByRole('link',{name:'Readable model name',exact:true})).toBeVisible();
  await expect(page.locator('#post-reader .reader-entries').getByRole('button',{name:'Download',exact:true})).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp('#/posts/'+x.f.id+'$'));
  expect(x.commands.filter(c=>c.type==='download_entry')).toHaveLength(1);
  await page.locator('#catalog-next').click();await expect(page.locator('#catalog-range')).toHaveText('101–105 / 105');
  await page.locator('#catalog-previous').click();
  const link=page.getByRole('link',{name:'Wiring notes',exact:true});await link.click();
  await expect(page.locator('#post-reader .reader-body')).toContainText('Child page');
  await expect(page.locator('#post-reader .reader-breadcrumb')).toContainText('Wiring notes');
  await page.goBack();await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  await page.goForward();await expect(page.locator('#post-reader .reader-body')).toContainText('Child page');
  await page.locator('#post-reader .reader-breadcrumb a').first().click();await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  x.f.head=hash(2);x.f.available=hash(2);x.f.sequence='43';await x.publish();
  await expect(page.locator('#post-new-version')).toContainText('New version available');
  await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  await page.locator('#post-refresh').click();await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  await page.locator('#post-open-latest').click();await expect(page.locator('#post-reader .reader-body')).toContainText('New text');
  await page.goBack();await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  for(const width of [1280,320])for(const theme of ['light','dark'] as const){
   await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
   await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`reader-${width}-${theme}.png`),animations:'disabled'});
  }
  const help=page.locator('#post-info');await help.hover();await expect(page.locator('#post-help')).toBeVisible();await page.locator('#post-title').click();await expect(page.locator('#post-help')).toBeHidden();
  await page.evaluate(()=>(window as any).__readerEvents.onerror());await expect(page.locator('#catalog-status')).toHaveText('Server disconnected');
  await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  expect(errors).toEqual([]);
 }finally{await cleanup(x.root,x.app);}
});

test('pending versions can be approved without replacing the page and late body failures stay in their origin',async({page})=>{
 const x=await followed(page);
 try{
  await page.goto(x.app.url+'/#/posts/'+x.f.id);
  await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  x.f.head=hash(2);x.f.available=hash(1);x.f.catalogs[1].ready=false;x.f.catalogs[1].state='Awaiting approval';x.snapshot.transfers.push({...x.snapshot.transfers[0],id:hash(2),held:true,active:false,state:'Awaiting approval',files:[{name:'metadata/body.md',length:100,verified:0,ready:false}]});await x.publish();
  await expect(page.locator('#post-approve')).toBeVisible();await page.locator('#post-approve').click();
  expect(x.commands.at(-1)).toMatchObject({type:'approve_transfer',id:hash(2)});
  await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  let release:()=>void=()=>{};const gate=new Promise<void>(r=>release=r);let waiting=false;
  await page.route('**/api/commands',async r=>{
   const c=r.request().postDataJSON();
   if(c.type==='read_catalog_body'&&c.catalog===hash(9)){waiting=true;await gate;await r.fulfill({status:503,json:{error:'Late previous page error'}});}
   else await r.fallback();
  });
  await page.goto(x.app.url+'/#/posts/'+x.f.id+'/'+hash(9));await expect.poll(()=>waiting).toBe(true);
  await page.locator('#post-tree a[data-kind=followed]').click();await expect(page.locator('#post-reader .reader-body')).toContainText('Workshop notes');
  release();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator('#post-error')).not.toContainText('Late previous page error');
  expect(x.commands.some(c=>c.type==='mark_catalog_read'&&c.catalog===hash(9))).toBe(false);
 }finally{await cleanup(x.root,x.app);}
});

test('own reader derives exact IDs without writes, supports deep pages and never adds an existing torrent',async({page},info)=>{
 const root=await temporary();let app;
 try{
  app=await startApp(join(root,'app'));const password='reader test passphrase';
  await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const {id}=await app.api('/api/publishing',{action:'create_post',title:'My notebook'});
  const meta=Buffer.from(bencode.encode({info:{name:Buffer.from('payload.txt'),length:3,'piece length':16384,pieces:createHash('sha1').update('abc').digest()}}));
  const infohash=createHash('sha1').update(bencode.encode(bencode.decode(meta).info)).digest('hex');
  await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft:{root:1,pages:[{id:1,title:'My notebook',body:'**Current draft**\n\n[Models](models.torrent)',entries:[{kind:'page',page:2},{kind:'torrent',name:'models.torrent',data:Array.from(meta)}]},{id:2,title:'Child',body:'A nested page.',entries:[]}]}});
  const path=join(root,'app','state','publishing','library.json'),before=await readFile(path);
  const value=await app.api('/api/publishing',{action:'get_post',id});expect(value.torrent_ids).toEqual([{page:1,index:1,infohash}]);
  const inspected=await app.api('/api/publishing',{action:'inspect_entry',id,page:1,infohash});expect(inspected.id).toBe(infohash);expect(inspected.total).toBe(3);
  await expect(app.api('/api/publishing',{action:'inspect_entry',id,page:2,infohash})).rejects.toThrow();expect(await readFile(path)).toEqual(before);expect((await app.api()).transfers).toHaveLength(0);
  let adds=0;page.on('request',r=>{if(r.url().endsWith('/api/commands')&&r.postDataJSON()?.type==='add_torrent')adds++;});
  await page.goto(app.url+'/#/own/'+id+'/read/2');await expect(page.locator('#own-preview')).toContainText('A nested page.');
  await page.locator('#own-preview .reader-breadcrumb a').click();await expect(page.locator('#own-preview strong')).toHaveText('Current draft');
  await page.locator('#own-preview').getByRole('button',{name:'Download',exact:true}).click();
  await expect(page.locator('#own-preview').getByRole('link',{name:'models.torrent',exact:true})).toBeVisible();
  await expect(page.locator('#own-preview').getByRole('button',{name:'Download',exact:true})).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1$'));expect(adds).toBe(1);
  await app.command({type:'pause',id:infohash});
  await page.getByRole('link',{name:'Models',exact:true}).click();await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1/torrent/'+infohash+'$'));
  expect((await app.api()).transfers.find(t=>t.id===infohash).active).toBe(false);expect(adds).toBe(1);
  await page.locator('#own-reader-more').click();await page.locator('#own-reader-remove').click();await page.locator('#remove-form button[type=submit]').click();
  await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1/torrent/'+infohash+'$'));await expect(page.locator('#own-reader-toggle')).toHaveAccessibleName('Download');expect((await app.api()).transfers).toHaveLength(0);
  expect((await app.api('/api/publishing',{action:'get_post',id})).revision).toBe(value.revision);
  await page.goBack();await expect(page.locator('#own-preview strong')).toHaveText('Current draft');
  for(const width of [1280,320])for(const theme of ['light','dark'] as const){
   await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
   await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`own-reader-${width}-${theme}.png`),animations:'disabled'});
  }
  await page.locator('#own-toggle').click();await expect(page.locator('#own-editor')).toBeVisible();await expect(page.locator('#own-title')).toHaveValue('My notebook');
  await page.goto(app.url+'/#/own/'+id+'/read/999');await expect(page.locator('#own-preview')).toContainText('Page unavailable');
  await expect(page.locator('#own-preview .reader-row')).toHaveCount(0);
 }finally{await cleanup(root,app);}
});
