import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

test('reader info, nested pages and file actions work with touch',async({browser})=>{
 const root=await temporary();let app,context;
 try{
  app=await startApp(join(root,'app'));const snapshot=await app.api(),id='d'.repeat(40),home='1'.repeat(40),child='2'.repeat(40),commands:any[]=[];
  const catalog=(id:string,name:string)=>({id,name,total:12,state:'Seeding',error:'',ready:true,previous:null,archive:null,foreign_post:null,count:2,indexed:2});
  snapshot.posts=[{id,name:'Notebook',local_name:'Notebook',magnet:'',mode:'current_catalog',automatic_limit:8388608,sequence:'1',head:home,available:home,state:'Following',error:'',update_peers:3,last_checked_ms:0,mirror_status:'',catalogs:[catalog(home,'Home'),catalog(child,'Child')]}];
  snapshot.transfers=[{id:child,name:'Child',state:'Seeding',active:true,progress:1,verified:12,total:12,down:0,up:0,peers:0,held:false,approval_size:null,files:[],save_path:'/Downloads',kind:'catalog',post:id,error:'',warning:''}];
  context=await browser.newContext({viewport:{width:320,height:740},hasTouch:true});const page=await context.newPage();
  await page.addInitScript(()=>{class Events extends EventTarget{};(window as any).EventSource=Events;});
  await page.route('**/api/snapshot',r=>r.fulfill({json:snapshot}));
  await page.route('**/api/commands',r=>{
   const c=r.request().postDataJSON();commands.push(c);
   if(c.type==='read_content')return r.fulfill({json:{id:child,name:'Child',total:12,kind:'catalog',files:[],entries:[],count:0,offset:0,body:{kind:'document',children:[{kind:'p',children:[{kind:'text',text:'Child text',children:[]}]}]},body_state:'ready',body_error:'',error:''}});
   if(c.type==='catalog_page')return r.fulfill({json:{catalog:snapshot.posts[0].catalogs.find(p=>p.id===c.catalog),offset:0,total:2,entries:[{index:0,name:'Child',source_name:'child.torrent',length:100,total:null,kind:'catalog',infohash:child,state:'Available',error:'',post_magnet:null,files:[]},{index:1,name:'notes.txt',source_name:'notes.txt',length:12,total:null,kind:'file',infohash:null,state:'Available',error:'',post_magnet:null,files:[]}]}});
   if(c.type==='read_catalog_body')return r.fulfill({json:{body:{kind:'document',children:[{kind:'p',children:[{kind:'text',text:c.catalog===home?'Home text':'Child text',children:[]}]}]}}});
   return r.fulfill({json:{ok:true}});
  });
  await page.goto(app.url+'/#/posts/'+id);await expect(page.locator('#post-reader .reader-body')).toContainText('Home text');
  const info=page.locator('#post-info');const box=(await info.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
  await info.tap();await expect(page.locator('#post-help')).toBeVisible();await page.locator('#post-title').tap();await expect(page.locator('#post-help')).toBeHidden();
  await page.locator('#post-reader .reader-name a').first().tap();await expect(page.locator('#post-reader .reader-body')).toContainText('Child text');
  await page.locator('#post-more').tap();await expect(page.locator('#post-menu')).toBeVisible();await page.locator('#post-title').tap();await expect(page.locator('#post-menu')).toBeHidden();
  await page.locator('#post-reader .reader-breadcrumb a').first().tap();await expect(page.locator('#post-reader .reader-body')).toContainText('Home text');
  await page.locator('#post-reader').getByRole('button',{name:'Show in Folder',exact:true}).tap();await expect.poll(()=>commands.some(c=>c.type==='reveal_entry'&&c.index===1)).toBe(true);
  await expect(page).toHaveURL(new RegExp('#/posts/'+id+'$'));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await context?.close();await cleanup(root,app);}
});
