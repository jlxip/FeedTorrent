import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {startApp,temporary,cleanup} from './helpers.mjs';

test('agreed icons retain accessible names and tooltips without capturing clicks',async({page},info)=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));await page.goto(app.url);
  for(const [id,label] of [['settings-open','Settings'],['open-button','Open'],['news-refresh','Refresh'],['news-previous','Previous'],['news-next','Next']]){
   const b=page.locator('#'+id);await expect(b).toHaveAttribute('aria-label',label);await expect(b.locator('svg')).toHaveAttribute('aria-hidden','true');await expect(b.locator('svg')).toHaveCSS('width','16px');await expect(b).toHaveCSS('height','36px');
  }
  await page.locator('#settings-open').hover();await expect(page.locator('#action-tooltip')).toHaveText('Settings');await expect(page.locator('#action-tooltip')).toHaveCSS('pointer-events','none');await page.locator('#settings-open').click();await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#publishing-keys-open')).toHaveText('Manage keys');await expect(page.locator('#publishing-keys-open svg')).toHaveCount(1);await page.locator('#settings-dialog [data-close]').click();
  await page.locator('#post-add').click();await expect(page.locator('#creation-submit')).toHaveText('OK');await expect(page.locator('#creation-submit svg')).toHaveCount(0);
  for(const id of ['creation-new-page','creation-add-files','creation-delete'])await expect(page.locator('#'+id+' svg')).toHaveCSS('width','16px');
  for(const width of [320,1280])for(const colorScheme of ['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`icons-${width}-${colorScheme}.png`),animations:'disabled'});}
 }finally{await cleanup(root,app);}
});

test('touch targets remain 44px and Sections has no action tooltip',async({browser})=>{
 const root=await temporary();let app:any,context;
 try{
  app=await startApp(join(root,'app'));context=await browser.newContext({hasTouch:true,viewport:{width:320,height:740}});const page=await context.newPage();await page.goto(app.url);
  for(const id of ['settings-open','open-button','sections-button','news-refresh']){const b=page.locator('#'+id),box=await b.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(44);expect(box!.height).toBeGreaterThanOrEqual(44);}
  const header=await page.locator('body > header').boundingBox();expect(header!.height).toBeLessThan(90);
  await expect(page.locator('#sections-button')).not.toHaveAttribute('data-action-tooltip');await page.locator('#sections-button').tap();await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden','false');await page.locator('#sections-button').tap();
  await page.locator('#settings-open').tap();await expect(page.locator('#settings-dialog')).toBeVisible();
 }finally{await context?.close();await cleanup(root,app);}
});
