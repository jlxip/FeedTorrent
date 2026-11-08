import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,cleanup,wait} from './helpers.mjs';
async function post(app:any){const password='version test password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});const {id}=await app.api('/api/publishing',{action:'create_post',title:'Versions'});await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft:{root:1,pages:[{id:1,title:'Versions',body:'Root page',entries:[{kind:'page',page:2}]},{id:2,title:'Nested',body:'Nested page',entries:[]}]}});return {id,password};}
test('exact version labels cover unsigned, pending, confirmed, canceled and unknown states',async({page})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const {id}=await post(app),base=await wait(async()=>{const s=await app.api();return s.publishing.posts.some(p=>p.id===id)&&s;},'own snapshot');let state=structuredClone(base);
  await page.addInitScript(()=>{(window as any).EventSource=class extends EventTarget{close(){}};});
  await page.route('**/api/snapshot',r=>r.fulfill({json:state}));
  const cases=[
   {fields:{state:'Queued',operation:1,phase:'Queued'},yes:['Queued'],no:['Version'],color:'pending'},
   {fields:{state:'Publication pending',operation:1,phase:'Publishing',sequence:'0',pending_sequence:'0'},yes:['Publishing Version 0'],no:['Published Version'],color:'pending'},
   {fields:{state:'Published',published_revision:2,published_sequence:'0',sequence:'0'},yes:['Published Version 0'],no:['Publishing Version','Signed Version'],color:'published'},
   {fields:{state:'Published',published_revision:1,published_sequence:'0',sequence:'0'},yes:['Unpublished changes','Published Version 0'],no:['Publishing Version'],color:'draft'},
   {fields:{state:'Publication pending',phase:'Preparing',operation:1,published_revision:1,published_sequence:'7',sequence:'8'},yes:['Preparing','Published Version 7'],no:['Publishing Version','Signed Version'],color:'pending'},
   {fields:{state:'Publication pending',phase:'Retrying',operation:1,published_revision:1,published_sequence:'9007199254740992',sequence:'9007199254740993',pending_sequence:'9007199254740993'},yes:['Publishing Version 9007199254740993','Published Version 9007199254740992'],no:['9007199254740994'],color:'pending'},
   {fields:{state:'Canceled',published_revision:2,published_sequence:'7',sequence:'8'},yes:['Publication canceled','Signed Version 8','Published Version 7'],no:['Publishing Version'],color:'draft'},
   {fields:{state:'Canceled',published_revision:1,published_sequence:'7',sequence:'9'},yes:['Publication canceled','Signed Version 9','Published Version 7'],no:['Publishing Version'],color:'draft'},
   {fields:{state:'Error',error:'Test failure',published_revision:1,published_sequence:'7',sequence:'9'},yes:['Publication error','Signed Version 9','Published Version 7'],no:['Publishing Version'],color:'error'},
   {fields:{state:'Canceled',published_revision:1,sequence:'8'},yes:['Signed Version 8','Published Version unknown'],no:['Published Version 7','Published Version 8'],color:'draft'}
  ];
  for(const c of cases){state=structuredClone(base);Object.assign(state.publishing.posts[0],c.fields);await page.setViewportSize({width:c.fields.sequence?.startsWith('9007')?320:1280,height:900});await page.goto(app.url+'/#/own/'+id);await page.reload();await expect(page.locator('#own-body')).toHaveValue('Root page');const indicator=page.locator('#own-indicator'),tooltip=page.locator('#own-publication-help');await indicator.hover();for(const text of c.yes)await expect(tooltip).toContainText(text);for(const text of c.no)await expect(tooltip).not.toContainText(text);await expect(tooltip).not.toContainText(/draft revision/i);await expect(indicator).toHaveAttribute('data-state',c.color);if(c.fields.sequence?.startsWith('9007')){const bounds=await tooltip.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(320);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}}
 }finally{await cleanup(root,app);}
});
test('Publish navigation waits for queue acceptance and respects cancellation, failures and later navigation',async({page})=>{
 const root=await temporary();let app:any;let held:any=null;
 try{
  app=await startApp(join(root,'app'));const {id,password}=await post(app);let mode='reject';
  await page.route('**/api/publishing',async route=>{const body=route.request().postDataJSON();if(body.action==='publish'){if(mode==='reject')await route.fulfill({status:503,json:{error:'Queue unavailable'}});else if(mode==='hold')held=route;else await route.fulfill({json:{operation:731}});}else if(body.action==='save_draft'&&mode==='save-fail')await route.fulfill({status:503,json:{error:'Save unavailable'}});else await route.continue();});
  await page.goto(app.url+'/#/own/'+id);await expect(page.locator('#own-body')).toHaveValue('Root page');
  await page.locator('#own-publish').click();await page.locator('#own-publish-dialog [data-close]').click();await expect(page.locator('#own-editor')).toBeVisible();await expect(page).toHaveURL(new RegExp('#/own/'+id+'$'));
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect(page.locator('#own-publish-error')).toContainText('Queue unavailable');await expect(page.locator('#own-editor')).toBeVisible();await page.locator('#own-publish-dialog [data-close]').click();
  mode='save-fail';await page.locator('#own-body').fill('Unsaved root');await expect(page.locator('#own-draft-status')).toContainText('Not saved');await page.locator('#own-publish').click();await expect(page.locator('#own-publish-dialog')).toBeHidden();await expect(page.locator('#own-error')).toContainText('Save unavailable');await expect(page.locator('#own-editor')).toBeVisible();
  mode='accept';await page.locator('#own-body').fill('Root page');await expect(page.locator('#own-draft-status')).toContainText('Draft saved');
  await page.goto(app.url+'/#/own/'+id+'/read/2');await expect(page.locator('#own-preview .reader-body')).toContainText('Nested page');await page.locator('#own-toggle').click();await expect(page.locator('#own-body')).toHaveValue('Nested page');
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/2$'));await expect(page.locator('#own-preview .reader-body')).toContainText('Nested page');
  // Closing a submitted dialog preserves the editor even if acceptance arrives later.
  await page.reload();await expect(page.locator('#own-preview .reader-body')).toContainText('Nested page');await page.locator('#own-toggle').click();mode='hold';
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect.poll(()=>!!held).toBe(true);await page.locator('#own-publish-dialog [data-close]').click();await expect(page.locator('#own-publish-dialog')).toBeHidden();await held.fulfill({json:{operation:732}});held=null;await expect(page.locator('#own-publish-submit')).toBeEnabled();await expect(page.locator('#own-editor')).toBeVisible();await expect(page).toHaveURL(new RegExp('#/own/'+id+'$'));
  // Leaving and returning to the same root route still invalidates the old navigation intent.
  await page.reload();await expect(page.locator('#own-body')).toHaveValue('Root page');
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect.poll(()=>!!held).toBe(true);await page.evaluate(()=>location.hash='#/library');await expect(page.locator('#own-publish-dialog')).toBeHidden();await page.evaluate(id=>location.hash='#/own/'+id,id);await expect(page.locator('#own-body')).toHaveValue('Root page');await held.fulfill({json:{operation:733}});held=null;await expect(page.locator('#own-publish-submit')).toBeEnabled();await expect(page.locator('#own-editor')).toBeVisible();await expect(page).toHaveURL(new RegExp('#/own/'+id+'$'));
  await page.reload();await expect(page.locator('#own-body')).toHaveValue('Root page');mode='hold';await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect.poll(()=>!!held).toBe(true);expect(held.request().postDataJSON().id).toBe(id);
  await page.evaluate(()=>location.hash='#/library');await expect(page).toHaveURL(/#\/library$/);await held.fulfill({json:{operation:732}});held=null;await expect(page.locator('#own-publish-dialog')).toBeHidden();await expect(page).toHaveURL(/#\/library$/);
 }finally{if(held)await held.abort();await cleanup(root,app);}
});
