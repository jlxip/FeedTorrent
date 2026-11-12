import {test,expect} from '@playwright/test';
import bencode from 'bencode';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';

test('own Public view unifies actions, wraps safely and preserves controls across refreshes',async({page,context},info)=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));const pub=(body:any)=>app.api('/api/publishing',body),password='header fixture password';
  await pub({action:'create_key',password,confirmation:password});const {id}=await pub({action:'create_post',title:'Notes'});
  const torrentInfo={name:'payload.txt',length:3,'piece length':16384,pieces:createHash('sha1').update('abc').digest()};
  const bytes=Buffer.from(bencode.encode({info:torrentInfo})),hash=createHash('sha1').update(bencode.encode(torrentInfo)).digest('hex');
  const longTitle='Long page title '+ 'unbroken'.repeat(25);
  await pub({action:'save_draft',id,revision:1,draft:{root:7,pages:[{id:7,title:'Notes',body:'Root body',entries:[{kind:'page',page:8}]},{id:8,title:longTitle,body:'Nested body',entries:[{kind:'torrent',name:'Payload',data:[...bytes]}]}]}});
  const state:any=await wait(async()=>{const s=await app.api();return s.publishing.posts.some(p=>p.id===id)&&s},'header snapshot');
  const own=state.publishing.posts.find((p:any)=>p.id===id);Object.assign(own,{state:'Published',phase:'Published',sequence:'0',published_sequence:'0',published_revision:own.revision});
  const calls:any[]=[];
  await context.addInitScript(()=>{
   (window as any).sources=[];(window as any).EventSource=class extends EventTarget{close(){}constructor(){super();(window as any).sources.push(this)}};
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{(window as any).copied=value}}});
  });
  await context.route('**/api/snapshot',r=>r.fulfill({json:state}));
  await context.route('**/api/publishing',async r=>{
   const body=r.request().postDataJSON();calls.push(body);
   if(body.action==='retry_publication'||body.action==='cancel_publication')await r.fulfill({json:{}});
   else if(body.action==='get_post'){const response=await r.fetch(),value=await response.json();await r.fulfill({json:{...value,published_dates:{7:{created_at:1794009600,updated_at:1794009601},8:{created_at:1794009600,updated_at:1794009601}},draft_differs:false}})}
   else await r.continue();
  });
  async function emit(){await page.evaluate(s=>{for(const source of (window as any).sources)source.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)}))},state)}
  const actions=page.locator('#own-top-actions'),identity=page.locator('#own-preview .content-identity'),heading=page.locator('#own-heading'),toggle=page.locator('#own-toggle');
  async function layout(label:string,pending=false){
   for(const width of[1280,900,320]){
    await page.setViewportSize({width,height:900});await expect(identity.locator('#own-top-actions')).toBeVisible();
    const {title,group,header}=await identity.evaluate(e=>{
     const box=(n:Element|null)=>{const r=n!.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
     return {title:box(e.querySelector('.own-heading-group')),group:box(e.querySelector('#own-top-actions')),header:box(e.closest('.content-heading'))};
    });
    if(width===1280)expect(Math.abs(title!.y+title!.height/2-group!.y-group!.height/2)).toBeLessThan(1);
    if(width===320)expect(group!.y).toBeGreaterThanOrEqual(title!.y+title!.height);
    expect(title.x+title.width<=group.x+1||title.y+title.height<=group.y+1).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const boxes=await actions.locator('button:visible').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,r:b.right,b:b.bottom,sw:n.scrollWidth,cw:n.clientWidth}}));
    for(let i=0;i<boxes.length;i++){const a=boxes[i];expect(a.x).toBeGreaterThanOrEqual(0);expect(a.r).toBeLessThanOrEqual(width);expect(a.sw).toBeLessThanOrEqual(a.cw);for(const b of boxes.slice(i+1))expect(a.r<=b.x+1||b.r<=a.x+1||a.b<=b.y+1||b.b<=a.y+1).toBe(true)}
    const dates=page.locator('#own-preview .reader-dates');if(await dates.isVisible())expect((await dates.boundingBox())!.y).toBeGreaterThanOrEqual(header!.y+header!.height);
    await expect(page.locator('#own-view>.list-heading').first()).toBeHidden();
    await expect(page.locator('#own-publish')).toBeHidden();
    if(pending)for(const name of['Retry','Cancel'])await expect(actions.getByRole('button',{name,exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath(`${label}-${width}.png`),animations:'disabled'});
   }
  }
  await page.goto(app.url+'/#/own/'+id+'/read/7');await expect(heading).toHaveText('Notes');await expect(page.locator('#own-preview .reader-dates time')).toHaveCount(2);await layout('root');
  await page.evaluate(()=>{const w=window as any;w.controls=['own-copy','own-toggle','own-retry','own-cancel','own-indicator','own-info','own-settings'].map(id=>document.getElementById(id));w.moves=0;new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(w.controls.some((c:Node)=>c&&(n===c||n.contains(c))))w.moves++}).observe(document.getElementById('own-view')!,{subtree:true,childList:true})});
  await actions.locator('#own-copy').click();await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toBe(own.magnet);
  await emit();expect(await page.evaluate(()=>(window as any).moves)).toBe(0);
  await toggle.click();await expect(page.locator('#own-editor')).toBeVisible();await expect(page.locator('#own-view>.list-heading #own-top-actions')).toBeVisible();await toggle.click();await expect(identity.locator('#own-toggle')).toBeVisible();
  await page.locator('#own-indicator').hover();await expect(page.locator('#own-publication-help')).toContainText('Published Version 0');await heading.click();await expect(page.locator('#own-publication-help')).toBeHidden();
  await page.locator('#own-info').hover();await expect(page.locator('#own-post-help')).toBeVisible();await heading.click();await expect(page.locator('#own-post-help')).toBeHidden();
  await page.locator('#own-preview').getByRole('link',{name:longTitle,exact:true}).click();await expect(heading).toHaveText(longTitle);await layout('nested-long');
  Object.assign(own,{state:'Publication pending',phase:'Retrying',operation:42,pending_revision:own.revision,pending_sequence:'1',next_retry_at:1794009600});await emit();await expect(actions.locator('#own-retry')).toBeVisible();await layout('pending-long',true);
  await actions.locator('#own-retry').click();expect(calls.some(c=>c.action==='retry_publication'&&c.operation===42)).toBe(true);await emit();await expect(actions.locator('#own-retry')).toBeEnabled();await emit();await expect(actions.locator('#own-retry')).toBeEnabled();
  await page.locator('#own-cancel').click();expect(calls.some(c=>c.action==='cancel_publication'&&c.operation===42)).toBe(true);
  await toggle.click();await expect(page.locator('#own-editor-actions #own-retry')).toBeVisible();await expect(page.locator('#own-editor-actions #own-cancel')).toBeVisible();await expect(page.locator('#own-title')).toHaveValue(longTitle);await toggle.click();
  await page.locator('#own-preview').getByRole('link',{name:'Payload',exact:true}).click();await expect(page).toHaveURL(new RegExp('/read/8/torrent/'+hash+'$'));await expect(heading).toHaveText('payload.txt');
  await layout('nested-torrent',true);const activity=page.locator('#own-preview .content-sharing');await expect(activity).toBeVisible();
  for(const width of[1280,900,320]){await page.setViewportSize({width,height:900});const a=await activity.boundingBox(),i=await identity.boundingBox();expect(a!.y).toBeGreaterThanOrEqual(i!.y+i!.height);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
  expect(await page.evaluate(()=>(window as any).controls.every((c:HTMLElement)=>c===document.getElementById(c.id)))).toBe(true);
  expect((await app.api()).transfers).toHaveLength(0);
 }finally{await cleanup(root,app)}
});
