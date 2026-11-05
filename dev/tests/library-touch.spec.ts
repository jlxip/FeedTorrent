import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

test('touch opens only the info tooltip, long names fit, and the grid has two intermediate columns',async({browser})=>{
  const root=await temporary();let app,context;
  try{
    app=await startApp(join(root,'app'));
    const id='c'.repeat(40);await app.command({type:'add_magnet',uri:id});
    const snapshot=await app.api();snapshot.transfers[0].name='Archive '+ 'x'.repeat(180);
    context=await browser.newContext({viewport:{width:320,height:740},hasTouch:true});
    const page=await context.newPage();
    await page.addInitScript(()=>{class Events extends EventTarget{};(window as any).EventSource=Events;});
    await page.route('**/api/snapshot',r=>r.fulfill({json:snapshot}));
    await page.goto(app.url+'/#/library');
    const info=page.locator('.library-info'),tip=page.locator('#library-tooltip');
    const box=(await info.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
    await info.tap();await expect(tip).toBeVisible();await expect(page).toHaveURL(/#\/library$/);
    await expect(tip).toContainText('—');await page.locator('#library-heading').tap();await expect(tip).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.locator('.transfer-name').tap();await expect(page).toHaveURL(new RegExp('#/library/'+id+'$'));
    await expect(page.locator('#files-waiting')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.locator('#library-back').tap();await expect(page.locator('.transfer-name')).toBeFocused();
    await page.setViewportSize({width:1000,height:740});
    await expect.poll(()=>page.locator('#transfers').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length)).toBe(2);
  }finally{await context?.close();await cleanup(root,app);}
});
