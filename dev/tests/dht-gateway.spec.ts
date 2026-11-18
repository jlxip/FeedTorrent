import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,cleanup} from './helpers.mjs';
import {fixture,freePort,reserve,proxy} from './dht-gateway-fixture.mjs';
import {evidencePath} from './runtime.mjs';

test('DHT gateway settings apply live, recover failures and remain accessible',async({page},testInfo)=>{
 const root=await temporary();let app:any,occupied:any;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  app=await startApp(root);await page.goto(app.url);await page.locator('#settings-open').click();
  const enabled=page.locator('#dht-gateway-enabled'),listen=page.locator('#dht-gateway-listen');
  await expect(enabled).not.toBeChecked();await expect(listen).toHaveValue('127.0.0.1:8793');await expect(page.locator('#dht-gateway-status')).toHaveText('Off');
  await listen.fill('localhost:8793');await page.locator('#settings-title').click();await expect(listen).toHaveAttribute('aria-invalid','true');
  const port=await freePort();await listen.fill('127.0.0.1:'+port);await page.locator('#settings-title').click();await enabled.check();
  await expect.poll(async()=>(await app.api()).dht_gateway.running).toBe(true);await expect(page.locator('#dht-gateway-status')).toHaveText('Listening on 127.0.0.1:'+port);
  const next=await freePort();occupied=await reserve(next);await listen.fill('127.0.0.1:'+next);await page.locator('#settings-title').click();await expect(page.locator('#settings-error')).toContainText('Cannot open DHT gateway');
  expect((await app.api()).settings.dht_gateway.listen).toBe('127.0.0.1:'+port);await occupied.stop();occupied=null;
  await listen.press('Enter');await expect.poll(async()=>(await app.api()).dht_gateway.listen).toBe('127.0.0.1:'+next);
  for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});for(const width of [1280,320]){
   await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'About DHT gateway',exact:true}).click();await expect(page.locator('#dht-gateway-listen-help')).toBeVisible();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:evidencePath('dht-gateway-settings-'+testInfo.project.name+'-'+scheme+'-'+width+'.png')});await page.keyboard.press('Escape');await expect(page.locator('#dht-gateway-listen-help')).toBeHidden();
  }}
  await page.locator('#settings-dialog [data-close]').click();await expect(page.locator('#settings-dialog')).toBeHidden();
  await app.stop();occupied=await reserve(next);app=await startApp(root);await page.goto(app.url);await page.locator('#settings-open').click();await expect(page.locator('#dht-gateway-status')).toContainText('Cannot open');
  await occupied.stop();occupied=null;await page.locator('#dht-gateway-retry').click();await expect.poll(async()=>(await app.api()).dht_gateway.running).toBe(true);
  await enabled.uncheck();await expect.poll(async()=>(await app.api()).dht_gateway.running).toBe(false);
  await page.mouse.click(2,2);await expect(page.locator('#settings-dialog')).toBeHidden();expect(errors).toEqual([]);
 }finally{await occupied?.stop();await cleanup(root,app)}
});

test('secure cross-origin consumer verifies public DHT data through an HTTPS proxy',async({browser})=>{
 const root=await temporary();let f:any,p:any,context:any;
 try{
  f=await fixture(root);p=await proxy(join(root,'proxy'),f.url);context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(p.page);
  const result=await page.evaluate(async({url,target,key,salt}:any)=>{
   const get=async(path:string)=>{const r=await fetch(url+path,{credentials:'omit',headers:{'Content-Type':'application/json'}});return {status:r.status,value:await r.json()}};
   return {secure:isSecureContext,immutable:await get('/dht/immutable/'+target),mutable:await get('/dht/mutable/'+key+'?salt='+salt),invalid:await get('/dht/immutable/no')};
  },{url:p.url,target:f.target,key:f.mutable.key,salt:f.mutable.salt});
  expect(result.secure).toBe(true);expect(result.immutable).toEqual({status:200,value:{target:f.target,value:f.value}});expect(result.mutable).toEqual({status:200,value:f.mutable});expect(result.invalid.status).toBe(400);expect(errors).toEqual([]);
 }finally{await context?.close();await p?.stop();await f?.app.stop();await f?.network.stop();await cleanup(root)}
});

test('DHT gateway touch controls autosave and close after saving',async({browser})=>{
 const root=await temporary();let app:any,context:any;
 try{
  app=await startApp(root);context=await browser.newContext({hasTouch:true,viewport:{width:320,height:900}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  for(const scheme of ['light','dark'] as const){
   await page.emulateMedia({colorScheme:scheme});await page.locator('#settings-open').tap();
   const port=await freePort();await page.locator('#dht-gateway-listen').fill('127.0.0.1:'+port);await page.locator('#dht-gateway-enabled').tap();
   await expect.poll(async()=>(await app.api()).dht_gateway.running).toBe(true);
   await page.getByRole('button',{name:'About DHT gateway',exact:true}).tap();await expect(page.locator('#dht-gateway-listen-help')).toBeVisible();
   await page.locator('#dht-gateway-listen').tap();await expect(page.locator('#dht-gateway-listen-help')).toBeHidden();
   await page.locator('#dht-gateway-enabled').tap();await expect.poll(async()=>(await app.api()).dht_gateway.running).toBe(false);
   await page.locator('#settings-dialog [data-close]').tap();await expect(page.locator('#settings-dialog')).toBeHidden();
  }
  expect(errors).toEqual([]);
 }finally{await context?.close();await cleanup(root,app)}
});
