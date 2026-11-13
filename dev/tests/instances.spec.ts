import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,cleanup} from './helpers.mjs';

test('three instances keep independent authenticated sessions in one browser context',async({context})=>{
 const root=await temporary(),apps:any[]=[],pages:any[]=[];
 try{
  for(let i=0;i<3;i++){
   const app=await startApp(join(root,String(i)),[],{defaultHttp:true});apps.push(app);
   const page=await context.newPage();pages.push(page);await page.goto(app.url);
   await expect(page.locator('#settings-open')).toBeEnabled();
  }
  const cookies=await context.cookies();
  for(const app of apps){
   const cookie=cookies.find(c=>c.name===`ft_session_${new URL(app.url).port}`);
   expect(cookie).toBeDefined();expect(cookie!.httpOnly).toBe(true);expect(cookie!.sameSite).toBe('Strict');
  }
  for(let i=0;i<3;i++){
   const page=pages[i];await page.locator('#settings-open').click();
   await expect(page.locator('#seed-by-default')).toBeChecked();await page.locator('#seed-by-default').uncheck();
   await expect.poll(async()=>(await apps[i].api()).settings.seed_by_default).toBe(false);
   for(let j=i+1;j<3;j++)expect((await apps[j].api()).settings.seed_by_default).toBe(true);
   await page.reload();await expect(page.locator('#settings-open')).toBeEnabled();
   expect(await page.evaluate(async()=>{const r=await fetch('/api/snapshot');return r.status})).toBe(200);
  }
  // A restart renews only this port's token; the other tabs retain their sessions.
  const previous=apps[1],port=new URL(previous.url).port;await previous.stop();
  apps[1]=await startApp(join(root,'1'),['--http-port',port]);
  await pages[1].goto(apps[1].url);
  for(const page of pages)expect(await page.evaluate(async()=>{const r=await fetch('/api/snapshot');return r.status})).toBe(200);
 }finally{for(const page of pages)await page.close();await cleanup(root,...apps)}
});
