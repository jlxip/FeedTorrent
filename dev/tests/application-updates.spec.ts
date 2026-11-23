import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,cleanup,wait} from './helpers.mjs';
const offer={id:'official-offer',version:'v99.0.0',target:'test',size:1234};
function initial(){return {current:'v0.0.7-alpha',instance:'old',supported:true,phase:'idle',offer,last_check:Date.now()/1000,next_check:0,error:'',check_error:'',operation:null,done:0,total:0,recovery:'',completed:null};}
async function mock(page:any,view:any,action:(body:any)=>Promise<any>){
 await page.addInitScript(()=>{(window as any).EventSource=class extends EventTarget{constructor(){super();(window as any).__updates=this;}close(){}};});
 await page.route('**/api/updates',async(r:any)=>{
  if(r.request().method()==='POST'){try{await r.fulfill({json:await action(r.request().postDataJSON())});}catch(e){await r.fulfill({status:409,json:{error:String(e)}});}}
  else await r.fulfill({json:view});
 });
}
test('update banner, Settings, progress and cancellation fit desktop and 320px',async({page})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const view:any=initial();let checks=0,cancels=0;
  await mock(page,view,async(body)=>{
   if(body.action==='check'){checks++;view.check_error='GitHub rate limit exceeded';}
   if(body.action==='install'){view.phase='waiting';view.operation='operation-1';return {operation:view.operation};}
   if(body.action==='cancel'){cancels++;view.phase='idle';view.error='Application update cancelled';}
   return {ok:true};
  });
  await page.goto(app.url);await expect(page.locator('#application-update')).toBeVisible();await expect(page.locator('#application-update-title')).toContainText('v99.0.0');
  for(const width of [1280,320]){
   await page.setViewportSize({width,height:800});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const banner=await page.locator('#application-update').boundingBox();const content=await page.locator('#news-heading').boundingBox();if(content)expect(banner!.y).toBeLessThan(content.y);
   await expect(page.locator('#application-update-install')).toBeVisible();
  }
  if(await page.locator('.workspace > main').evaluate(e=>(e as HTMLElement).inert))await page.locator('#sections-button').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#application-version-current')).toHaveText('FeedTorrent v0.0.7-alpha');await page.locator('#application-update-check').click();
  await page.evaluate((value:any)=>(window as any).__updates.dispatchEvent(new MessageEvent('application_update',{data:JSON.stringify(value)})),view);
  expect(checks).toBe(1);await expect(page.locator('#application-version-status')).toContainText('rate limit');await expect(page.locator('#application-update-error')).toBeEmpty();
  await page.locator('#settings-dialog [data-close]').click();await page.locator('#application-update-install').click();
  await expect(page.locator('#application-update-status')).toContainText('Waiting for publications');
  await expect(page.locator('#application-update-cancel')).toBeVisible();await page.locator('#application-update-cancel').click();
  await expect.poll(()=>cancels).toBe(1);await expect(page.locator('#application-update-error')).toContainText('cancelled');await expect(page.locator('#open-button')).toBeEnabled();
  view.phase='downloading';view.operation='download-2';view.done=512;view.total=1024;view.error='';
  await page.evaluate((value:any)=>(window as any).__updates.dispatchEvent(new MessageEvent('application_update',{data:JSON.stringify(value)})),view);
  await expect(page.locator('#application-update-progress')).toHaveAttribute('value','50');
 }finally{await cleanup(root,app);}
});
test('failed draft save aborts installation and preserves editor contents',async({page})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const password='updater browser test password';
  await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const {id}=await app.api('/api/publishing',{action:'create_post',title:'Draft before update'});
  await wait(async()=>{const s=await app.api();return s.ready&&s.publishing.posts.some((p:any)=>p.id===id);},'own draft in initial snapshot');
  const view:any=initial();let installs=0;
  await mock(page,view,async(body)=>{if(body.action==='install')installs++;return {operation:'unexpected'};});
  await page.route('**/api/publishing',async route=>{
   if(route.request().postDataJSON().action==='save_draft')await route.fulfill({status:503,json:{error:'Draft save unavailable'}});else await route.continue();
  });
  await page.goto(app.url+'/#/own/'+id);await expect(page.locator('#own-body')).toBeVisible();
  await page.locator('#own-body').fill('Preserve this unsaved draft.');await page.locator('#application-update-install').click();
  await expect(page.locator('#application-update-error')).toContainText('Draft save unavailable');expect(installs).toBe(0);
  await expect(page.locator('#own-body')).toHaveValue('Preserve this unsaved draft.');await expect(page.locator('#own-body')).toBeEditable();
 }finally{await cleanup(root,app);}
});

test('restart reloads only for the selected operation and version from a new instance',async({page})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));await wait(async()=>(await app.api()).ready);
  const value:any=initial();let polls=0,navigations=0;
  await page.addInitScript(()=>{(window as any).EventSource=class extends EventTarget{close(){}};});
  await page.route('**/api/updates',async route=>{
   if(route.request().method()==='POST'){
    Object.assign(value,{phase:'restarting',operation:'wanted'});
    await route.fulfill({json:{operation:'wanted'}});
   }else{polls++;await route.fulfill({json:value});}
  });
  page.on('load',()=>navigations++);
  await page.goto(app.url);await page.locator('#application-update-install').click();
  await expect(page.locator('#application-update-status')).toContainText('Restarting');
  Object.assign(value,{instance:'old',current:'v99.0.0',completed:{operation:'wanted',status:'installed',version:'v99.0.0',recovery:''}});
  let before=polls;await expect.poll(()=>polls).toBeGreaterThan(before+1);expect(navigations).toBe(1);
  Object.assign(value,{instance:'foreign',completed:{operation:'other',status:'installed',version:'v99.0.0',recovery:''}});
  before=polls;await expect.poll(()=>polls).toBeGreaterThan(before+1);expect(navigations).toBe(1);
  Object.assign(value,{instance:'new',current:'v98.0.0',completed:{operation:'wanted',status:'installed',version:'v99.0.0',recovery:''}});
  before=polls;await expect.poll(()=>polls).toBeGreaterThan(before+1);expect(navigations).toBe(1);
  Object.assign(value,{current:'v99.0.0',phase:'idle',offer:null,operation:null});
  await expect.poll(()=>navigations).toBe(2);
  await expect(page.locator('#application-version-current')).toHaveText('FeedTorrent v99.0.0');
 }finally{await cleanup(root,app);}
});
