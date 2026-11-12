import {expect,test} from '@playwright/test';
import {createServer} from 'node:http';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';
import {png,imageTorrent,preloadImages} from './image-fixtures.mjs';
async function fixture(page:any){
 const root=await temporary();let app;
 const requests:{path:string;referer:string|undefined}[]=[],delays=new Map<string,Promise<void>>();
 const server=createServer(async(req,res)=>{requests.push({path:req.url!,referer:req.headers.referer});if(delays.has(req.url!))await delays.get(req.url!);if(res.destroyed)return;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','image/png');res.end(req.url==='/broken'?'broken PNG':png(640,400));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(server.address() as any).port;
 try{
  app=await startApp(join(root,'app'));const file=join(root,'photo.png');await writeFile(file,png());
  const sources=await app.api('/api/creation',{action:'sources',paths:[file]});const password='image reader passphrase';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const {id}=await app.api('/api/publishing',{action:'create_post',title:'Photos'});
  const body=`![Attached photo](photo.png)\n\n[![External one](${url}/one)](${url}/linked)\n\n![External\ntwo](${url}/two)\n\n![Broken photo](${url}/broken)\n\n![Invalid URL](http://user:password@127.0.0.1/invalid)\n\n[Child](Child.torrent)`;
  const draft={root:1,pages:[{id:1,title:'Photos',body,entries:[...sources.entries,{kind:'page',page:2}]},{id:2,title:'Child',body:`![Child photo](${url}/one)`,entries:[]}]};
  await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft});
  await expect.poll(async()=>(await app!.api()).publishing.posts.some((p:any)=>p.id===id)).toBe(true);
  const open=async()=>{await page.goto(app!.url+`/#/own/${id}/read/1`);await expect(page.locator('.markdown-image').filter({hasText:'Attached photo'}).locator('img')).toBeVisible();};
  const row=(name:string)=>page.locator('.markdown-image').filter({hasText:name});
  return {root,app,id,url,requests,server,open,row,body,delays};
 }catch(e){server.close();await cleanup(root,app);throw e;}
}
async function finish(x:any){await new Promise<void>(r=>x.server.close(()=>r()));await cleanup(x.root,x.app);}

async function settings(page:any){
 if(!await page.locator('#reader-settings-dialog[open]').count())await page.locator('.reader-settings:visible').click();
 await expect(page.locator('#reader-settings-dialog')).toBeVisible();
}
async function closeSettings(page:any){await page.locator('#reader-settings-dialog [data-close]').click();await expect(page.locator('#reader-settings-dialog')).toBeHidden();}
async function loadExternal(page:any){await settings(page);await page.locator('#reader-load-images').click();await expect(page.locator('#reader-settings-dialog')).toBeHidden();}
async function policy(page:any,value:string){await settings(page);await page.locator('#reader-image-policy').selectOption(value);await expect(page.locator('#reader-settings-status')).toHaveText('Saved');await closeSettings(page);}

test('Markdown images show attachments and require HTTP consent, with session-scoped page grants and stable retries',async({page},info)=>{
 const x=await fixture(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await x.open();expect(x.requests).toEqual([]);await expect(page.locator('.reader-body select,.reader-body #reader-load-images')).toHaveCount(0);
  await settings(page);await expect(page.locator('#reader-image-policy')).toHaveValue('inherit');await expect(page.locator('#reader-load-images')).toBeEnabled();await expect(page.locator('#reader-load-images')).toHaveText('Load external images now');await closeSettings(page);
  await x.row('External one').getByRole('button',{name:'Load image',exact:true}).click();await expect(x.row('External one').locator('img')).toBeVisible();
  expect(x.requests.filter(r=>r.path==='/linked')).toEqual([]);await expect(x.row('External two').locator('img')).toHaveCount(0);
  await page.locator('.reader-body').getByRole('link',{name:'Child',exact:true}).click();await expect(page).toHaveURL(/\/read\/2$/);await expect(x.row('Child photo').getByRole('button',{name:'Load image',exact:true})).toBeVisible();
  await page.goBack();await expect(x.row('External one').locator('img')).toBeVisible();await expect(x.row('External two').getByRole('button',{name:'Load image',exact:true})).toBeVisible();
  await loadExternal(page);await expect(x.row('External two').locator('img')).toBeVisible();await expect(x.row('Broken photo').getByRole('button',{name:'Retry image',exact:true})).toBeVisible();
  const failures=x.requests.filter(r=>r.path==='/broken').length;
  await x.app.command({type:'configure',settings:(await x.app.api()).settings});await expect(page.locator('#reader-image-policy')).toHaveValue('inherit');expect(x.requests.filter(r=>r.path==='/broken')).toHaveLength(failures);
  await x.row('Broken photo').getByRole('button',{name:'Retry image',exact:true}).click();await expect.poll(()=>x.requests.filter(r=>r.path==='/broken').length).toBe(failures+1);await expect(x.row('Broken photo').getByRole('button',{name:'Retry image',exact:true})).toBeVisible();
  await expect(x.row('Invalid URL').locator('img')).toHaveCount(0);await expect(page.locator('img[src=""]')).toHaveCount(0);
  expect(x.requests.every(r=>r.referer===undefined)).toBe(true);expect((await x.app.api()).image_preferences).toEqual({automatic:false,posts:{}});
  for(const width of [320,1280])for(const theme of ['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`images-${width}-${theme}.png`),fullPage:true,animations:'disabled'});await settings(page);expect(await page.locator('#reader-settings-dialog .dialog-surface').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`reader-settings-${width}-${theme}.png`),fullPage:true,animations:'disabled'});await closeSettings(page);}
  await page.reload();await expect(x.row('External one').getByRole('button',{name:'Load image',exact:true})).toBeVisible();await expect(x.row('External two').locator('img')).toHaveCount(0);await page.getByRole('button',{name:'Edit',exact:true}).click();await settings(page);await expect(page.locator('#reader-image-policy')).toHaveValue('inherit');await expect(page.locator('#reader-following-settings')).toBeHidden();await expect(page.locator('#reader-load-images')).toBeHidden();await closeSettings(page);await page.getByRole('button',{name:'Public view',exact:true}).click();await expect(x.row('Attached photo').locator('img')).toBeVisible();expect(errors).toEqual([]);
 }finally{await finish(x);}
});

test('HTTP image settings cover all global/post combinations and stay independent of download settings across tabs',async({page,context})=>{
 const x=await fixture(page);
 try{
  for(const automatic of [false,true])for(const policy of [null,'always','ask']){
   await page.goto('about:blank');await x.app.command({type:'set_image_preferences',update:{scope:'global',automatic}});await x.app.command({type:'set_image_preferences',update:{scope:'post',id:x.id,policy}});
   const count=x.requests.filter(r=>r.path==='/one').length;await x.open();
   if(policy==='always'||policy===null&&automatic){await expect(x.row('External one').locator('img')).toBeVisible();await expect.poll(()=>x.requests.filter(r=>r.path==='/one').length).toBe(count+1);}
   else{await expect(x.row('External one').getByRole('button',{name:'Load image',exact:true})).toBeVisible();expect(x.requests.filter(r=>r.path==='/one')).toHaveLength(count);}
  }
  const other=await context.newPage();await other.goto(x.app.url+`/#/own/${x.id}/read/1`);await settings(other);await expect(other.locator('#reader-image-policy')).toHaveValue('ask');
  const downloadSettings=(await x.app.api()).settings;await page.locator('#settings-open').click();await page.locator('#external-images-automatic').uncheck();await expect.poll(async()=>(await x.app.api()).image_preferences.automatic).toBe(false);await page.locator('#settings-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await policy(page,'always');await expect(other.locator('#reader-image-policy')).toHaveValue('always');await expect(other.locator('.markdown-image').filter({hasText:'External one'}).locator('img')).toBeVisible();
  expect((await x.app.api()).settings).toEqual(downloadSettings);
  await page.locator('#settings-open').click();await x.app.command({type:'set_image_preferences',update:{scope:'global',automatic:true}});await expect(page.locator('#external-images-automatic')).toBeChecked();
  await page.locator('#seed-by-default').uncheck();await expect.poll(async()=>(await x.app.api()).settings.seed_by_default).toBe(false);expect((await x.app.api()).image_preferences.automatic).toBe(true);
  await page.locator('#settings-dialog').getByRole('button',{name:'Close',exact:true}).click();
  let reject=true;await page.route('**/api/commands',async r=>{if(reject&&r.request().postDataJSON().type==='set_image_preferences'){reject=false;await r.fulfill({status:503,json:{error:'Cannot save image setting'}});}else await r.continue();});
  await settings(page);await page.locator('#reader-image-policy').selectOption('ask');await expect(page.locator('#reader-settings-error')).toContainText('Cannot save image setting');await expect(page.locator('#reader-image-policy')).toHaveValue('ask');
  await page.locator('#reader-settings-retry').click();await expect(other.locator('#reader-image-policy')).toHaveValue('ask');
  await other.close();
 }finally{await finish(x);}
});

test('followed and nested readers use verified attachments, post overrides and pending states without changing transfers',async({page},info)=>{
 const x=await fixture(page);
 try{
  const t=imageTorrent('Pictures',x.body);await preloadImages(x.root,x.app,t);await x.app.command({type:'pause',id:t.id});
  const parent=imageTorrent('Picture root',x.body,true,[{path:['child.torrent'],data:t.bytes}]);await preloadImages(x.root,x.app,parent);await x.app.command({type:'pause',id:parent.id});
  const data=await x.app.command({type:'read_content',id:parent.id,offset:0}),snapshot=await x.app.api(),id='c'.repeat(40);
  const catalog={id:parent.id,name:parent.name,total:100,ready:true,state:'Paused',error:'',previous:null,archive:null,foreign_post:null,count:1,indexed:1};
  snapshot.posts=[{id,name:'Followed photos',local_name:'',magnet:'',mode:'current_catalog',automatic_limit:8388608,sequence:'1',head:parent.id,available:parent.id,state:'Following',error:'',update_peers:0,last_checked_ms:null,mirror_status:'',catalogs:[catalog]}];
  snapshot.image_preferences={automatic:true,posts:{[id]:'ask'}};
  await page.addInitScript(()=>{(window as any).EventSource=class extends EventTarget{onerror:any=null;constructor(){super();(window as any).__imagesEvents=this;}};});
  await page.route('**/api/snapshot',r=>r.fulfill({json:snapshot}));
  const commands:any[]=[];
  await page.route('**/api/commands',async r=>{const c=r.request().postDataJSON();commands.push(c);if(c.type==='read_catalog_body')await r.fulfill({json:{body:data.body}});else if(c.type==='catalog_page')await r.fulfill({json:{catalog,entries:[],offset:0,total:0}});else if(c.type==='mark_catalog_read')await r.fulfill({json:{ok:true}});else await r.continue();});
  let pending=true;
  await page.route('**/api/image?**',async r=>{const u=new URL(r.request().url());if(pending&&u.searchParams.get('inspect')==='true'&&u.searchParams.get('context')==='torrent')await r.fulfill({json:{state:'pending'}});else await r.continue();});
  for(const route of [`#/posts/${id}`,`#/posts/${id}/${parent.id}/torrent/${t.id}`]){
   pending=true;await page.goto(x.app.url+'/'+route);await expect(x.row('Attached photo')).toContainText('Image is not downloaded and verified');await expect(x.row('External one').getByRole('button',{name:'Load image',exact:true})).toBeVisible();await settings(page);await expect(page.locator('#reader-settings-title')).toHaveText('Post settings');await expect(page.locator('#reader-image-policy')).toHaveValue('ask');await closeSettings(page);
   pending=false;const current=snapshot.transfers.find((v:any)=>v.id===(route.includes('/torrent/')?t.id:parent.id))!;current.state='Seeding';await page.evaluate(s=>(window as any).__imagesEvents.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)})),snapshot);await expect(x.row('Attached photo').locator('img')).toBeVisible();current.state='Paused';
  }
  expect(x.requests).toEqual([]);expect(commands.filter(c=>!['catalog_page','read_catalog_body','read_content','mark_catalog_read'].includes(c.type))).toEqual([]);
  const actual=(await x.app.api()).transfers.find((v:any)=>v.id===t.id);expect(actual.active).toBe(false);expect(actual.pinned).toBe(true);
  await page.goto(x.app.url+`/#/library/${t.id}`);await expect(x.row('External one').locator('img')).toBeVisible();await settings(page);await expect(page.locator('#reader-settings-title')).toHaveText('Reader settings');await expect(page.locator('#reader-image-policy')).toBeHidden();await expect(page.locator('#reader-load-images')).toBeEnabled();await expect(page.locator('#reader-load-images')).toHaveText('Load external images now');await closeSettings(page);
  snapshot.image_preferences.automatic=false;await page.reload();await expect(x.row('External one').getByRole('button',{name:'Load image',exact:true})).toBeVisible();await loadExternal(page);await expect(x.row('External one').locator('img')).toBeVisible();
  expect(commands.filter(c=>!['catalog_page','read_catalog_body','read_content','mark_catalog_read'].includes(c.type))).toEqual([]);
  for(const width of [320,1280])for(const theme of ['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await settings(page);await expect(page.locator('#reader-settings-title')).toHaveText('Reader settings');expect(await page.locator('#reader-settings-dialog .dialog-surface').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath(`library-settings-${width}-${theme}.png`),fullPage:true,animations:'disabled'});await closeSettings(page);}
 }finally{await finish(x);}
});


test('late image responses cannot replace another page and a new draft version asks again',async({page})=>{
 const x=await fixture(page);let release=()=>{},releaseAttachment=()=>{};
 try{
  await x.open();x.delays.set('/one',new Promise<void>(r=>release=r));
  await x.row('External one').getByRole('button',{name:'Load image',exact:true}).click();await expect.poll(()=>x.requests.filter(r=>r.path==='/one').length).toBe(1);
  await page.locator('.reader-body').getByRole('link',{name:'Child',exact:true}).click();await expect(x.row('Child photo').getByRole('button',{name:'Load image',exact:true})).toBeVisible();release();
  let seen=false;const gate=new Promise<void>(r=>releaseAttachment=r);
  await page.route('**/api/image?**',async r=>{const u=new URL(r.request().url());if(u.searchParams.get('context')==='own'&&u.searchParams.get('page')==='1'&&u.searchParams.get('inspect')==='true'){seen=true;await gate;await r.fulfill({json:{state:'ready'}}).catch(()=>{});}else await r.continue();});
  let downloads=0;page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/image'&&u.searchParams.get('page')==='1'&&!u.searchParams.has('inspect'))++downloads;});
  await page.goBack();await expect.poll(()=>seen).toBe(true);await page.locator('.reader-body').getByRole('link',{name:'Child',exact:true}).click();releaseAttachment();
  await expect(x.row('Child photo').getByRole('button',{name:'Load image',exact:true})).toBeVisible();await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));expect(downloads).toBe(0);
  await page.unroute('**/api/image?**');await page.goBack();await expect(x.row('External one').locator('img')).toBeVisible();
  const count=x.requests.filter(r=>r.path==='/one').length,post=await x.app.api('/api/publishing',{action:'get_post',id:x.id});post.draft.pages[0].body+='\n\nRevised page.';
  await x.app.api('/api/publishing',{action:'save_draft',id:x.id,revision:post.revision,draft:post.draft});
  await expect(page.locator('#own-preview .reader-body')).toContainText('Revised page.');await expect(x.row('External one').getByRole('button',{name:'Load image',exact:true})).toBeVisible();expect(x.requests.filter(r=>r.path==='/one')).toHaveLength(count);
 }finally{release();releaseAttachment();await finish(x);}
});
