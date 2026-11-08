// UI state transitions use the same SSE contract with controlled server responses.
import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';
test('publication presentation, shared actions, dates, tabs and disconnect at 320px',async({page,context},info)=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const password='controlled publication password';
  const pub=(body:any)=>app.api('/api/publishing',body);
  await pub({action:'create_key',password,confirmation:password});const {id}=await pub({action:'create_post',title:'Status test'});
  await pub({action:'save_draft',id,revision:1,draft:{root:1,pages:[{id:1,title:'Status test',body:'This snapshot is published.',entries:[{kind:'page',page:2}]},{id:2,title:'Nested',body:'Nested content',entries:[]}]}});
  let state:any=await wait(async()=>{const s=await app.api();return s.publishing.posts.some(p=>p.id===id)&&s},'controlled post snapshot');
  const own=()=>state.publishing.posts.find((p:any)=>p.id===id);let dates:any={},differs=false,operation=40;const calls:any[]=[];
  await context.addInitScript(()=>{
   (window as any).testSources=[];
   (window as any).EventSource=class extends EventTarget{onerror:any;constructor(){super();(window as any).testSources.push(this)}close(){}};
  });
  await context.route('**/api/snapshot',r=>r.fulfill({json:state}));
  await context.route('**/api/publishing',async r=>{
   const body=r.request().postDataJSON();calls.push(body);
   if(body.action==='get_post'){
    const result=await r.fetch(),value=await result.json();await r.fulfill({json:{...value,published_dates:dates,draft_differs:differs}});
   }else if(body.action==='publish'){
    Object.assign(own(),{state:'Publication pending',phase:'Retrying',operation:++operation,pending_revision:own().revision,pending_sequence:own().published_sequence===null?'0':'1',next_retry_at:1794009600,error:'DHT: NoAcknowledgements'});await r.fulfill({json:{operation}});
   }else if(body.action==='retry_publication'||body.action==='cancel_publication')await r.fulfill({json:{}});
   else{const result=await r.fetch(),value=await result.json();if(body.action==='save_draft')own().revision=value.revision;await r.fulfill({response:result,json:value});}
  });
  async function emit(){for(const tab of context.pages())if(tab.url().startsWith(app.url))await tab.evaluate(s=>{for(const source of (window as any).testSources||[])source.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)}))},state)}
  await page.goto(app.url+'/#/own/'+id);await expect(page.locator('#own-body')).toHaveValue('This snapshot is published.');
  const light=page.locator('#own-indicator'),help=page.locator('#own-publication-help');await light.hover();await expect(help).toHaveText(/^(Draft|Unpublished changes)$/);await page.locator('#own-heading').click();await expect(help).toBeHidden();await light.click();await expect(help).toBeVisible();await page.locator('#own-heading').click();await expect(help).toBeHidden();
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1$'));await expect(page.locator('#own-publish-password')).toHaveValue('');await emit();
  await expect(page.locator('#own-preview .reader-dates')).toBeHidden();await expect(page.locator('#own-top-actions #own-cancel')).toBeVisible();await expect(page.locator('#own-retry')).toBeVisible();await expect(page.locator('#own-publish')).toBeDisabled();await expect(light).toHaveAttribute('data-state','pending');await light.hover();for(const text of['Retrying','Next retry:','Publishing Version 0','DHT'])await expect(help).toContainText(text);await expect(help).not.toContainText('Published Version');await expect(help).not.toContainText('draft revision');
  const second=await context.newPage();await second.goto(app.url+'/#/own/'+id);await expect(second.locator('#own-body')).toHaveValue('This snapshot is published.');await expect(second.locator('#own-publish')).toBeDisabled();await expect(second.locator('#own-indicator')).toHaveAttribute('data-state','pending');
  await page.locator('#own-toggle').click();await expect(page.locator('#own-editor-actions #own-cancel')).toBeVisible();await page.locator('#own-body').fill('Edits remain unpublished.');await expect(page.locator('#own-draft-status')).toContainText('Draft saved');await page.locator('#own-toggle').click();await expect(page.locator('#own-top-actions #own-retry')).toBeVisible();await expect(page.locator('#own-retry')).toHaveCount(1);
  await page.locator('#own-retry').click();expect(calls.some(c=>c.action==='retry_publication'&&c.id===id&&c.operation===operation)).toBe(true);
  dates={'1':{created_at:1794009600,updated_at:1794009600}};differs=true;Object.assign(own(),{state:'Published',phase:'Published',error:'',operation:null,pending_sequence:null,published_sequence:'0',sequence:'0',published_revision:2,next_retry_at:null});await emit();
  await expect(light).toHaveAttribute('data-state','draft');await expect(second.locator('#own-indicator')).toHaveAttribute('data-state','draft');
  const datesTab=await context.newPage();await datesTab.goto(app.url+'/#/own/'+id+'/read/1');const row=datesTab.locator('#own-preview .reader-dates');await expect(row).toContainText('Last published version');await expect(row.locator('time')).toHaveCount(2);const initial=await row.locator('time').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('datetime')));expect(initial).toEqual(['2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z']);
  await datesTab.setViewportSize({width:320,height:740});await datesTab.screenshot({path:info.outputPath('last-published-320.png'),animations:'disabled'});
  await page.locator('#own-toggle').click();await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();await emit();await light.hover();await expect(help).toContainText('Publishing Version 1');await expect(help).toContainText('Published Version 0');
  for(const width of[1280,320]){await page.setViewportSize({width,height:900});await light.hover();await page.screenshot({path:info.outputPath(`versions-pending-${width}.png`),animations:'disabled'});const b=await help.boundingBox();expect(b!.x).toBeGreaterThanOrEqual(0);expect(b!.x+b!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
  expect(await row.locator('time').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('datetime')))).toEqual(initial);
  Object.assign(own(),{state:'Published',phase:'Published',error:'',operation:null,pending_sequence:null,published_sequence:'1',sequence:'1',published_revision:own().revision,next_retry_at:null});dates['1'].updated_at=1794009601;differs=false;await emit();await expect(light).toHaveAttribute('data-state','published');await light.hover();await expect(help).toContainText('Published Version 1');await datesTab.reload();await expect(row).not.toContainText('Last published version');await expect(row.locator('time')).toHaveCount(2);await datesTab.close();
  Object.assign(own(),{state:'Error',error:'Incorrect password',sequence:'1'});await emit();await expect(light).toHaveAttribute('data-state','error');await light.hover();await expect(help).toContainText('Incorrect password');await expect(page.locator('#own-error')).toBeHidden();await expect(page.locator('#own-publish')).toBeEnabled();await expect(page.locator('#own-preview')).toBeVisible();expect((await app.api()).transfers).toHaveLength(0);
  Object.assign(own(),{state:'Publication pending',phase:'Retrying',error:'',operation:++operation,pending_sequence:'2',sequence:'2',next_retry_at:1794009600});await emit();await page.goto(app.url+'/#/own/'+id+'/read/2');await expect(page.locator('#own-preview')).toContainText('Nested content');await expect(page.locator('#own-top-actions #own-cancel')).toBeVisible();await page.locator('#own-cancel').click();expect(calls.some(c=>c.action==='cancel_publication'&&c.id===id&&c.operation===operation)).toBe(true);
  Object.assign(own(),{state:'Canceled',phase:'Canceled',operation:null,pending_sequence:null,next_retry_at:null});await emit();await light.hover();for(const text of['Publication canceled','Signed Version 2','Published Version 1'])await expect(help).toContainText(text);await expect(light).toHaveAttribute('data-state','draft');await expect(page.locator('#own-retry')).toBeHidden();await expect(page.locator('#own-cancel')).toBeHidden();await expect(page.locator('#own-publish')).toBeEnabled();await expect(page.locator('#own-preview')).toContainText('Nested content');await expect(page.locator('#own-status')).toHaveCSS('position','absolute');
  await page.locator('#own-heading').click();await expect(help).toBeHidden();await page.evaluate(()=>{for(const source of (window as any).testSources)source.onerror?.()});await expect(light).toHaveAttribute('aria-label','Server disconnected');await expect(light).toHaveAttribute('data-state','draft');await second.close();
 }finally{await cleanup(root,app)}
});

test('verified followed dates use the common reader without the own-draft warning',async({page,context})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const state=await app.api(),id='a'.repeat(40),hash='b'.repeat(40);
  const catalog={id:hash,name:'Verified catalog',total:0,state:'Ready',error:'',ready:true,previous:null,archive:null,foreign_post:null,count:0,indexed:0};
  state.posts=[{id,name:'Followed dates',local_name:'Followed dates',magnet:'magnet:?xs=urn:btpk:'+'c'.repeat(64),mode:'current_catalog',automatic_limit:null,sequence:'0',head:hash,available:hash,state:'Ready',error:'',update_peers:0,last_checked_ms:0,catalogs:[catalog],mirror_status:''}];
  await context.addInitScript(()=>{(window as any).EventSource=class extends EventTarget{close(){}}});
  await context.route('**/api/snapshot',r=>r.fulfill({json:state}));
  await context.route('**/api/commands',async r=>{const body=r.request().postDataJSON();
   if(body.type==='catalog_page')await r.fulfill({json:{catalog,entries:[],offset:0,total:0,created_at:1794009600,updated_at:1794009601}});
   else if(body.type==='read_catalog_body')await r.fulfill({json:{body:null}});
   else if(body.type==='mark_catalog_read')await r.fulfill({json:{}});
   else await r.continue();
  });
  await page.goto(app.url+'/#/posts/'+id+'/'+hash);const row=page.locator('#post-reader .reader-dates');await expect(row.locator('time')).toHaveCount(2);await expect(row).not.toContainText('Last published version');expect(await row.locator('time').evaluateAll(n=>n.map(e=>e.getAttribute('datetime')))).toEqual(['2026-11-07T00:00:00.000Z','2026-11-07T00:00:01.000Z']);
 }finally{await cleanup(root,app)}
});
