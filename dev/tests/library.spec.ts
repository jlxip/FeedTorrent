import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

test('Library replaces Transfers, preserves legacy history and opens manual magnets from New posts',async({page,browser},info)=>{
  const root=await temporary();let app;
  try {
    app=await startApp(join(root,'app'));
    const errors:string[]=[],external:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(!r.url().startsWith(app.url))external.push(r.url());});
    await page.goto(app.url);
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.locator('#news-view')).toBeVisible();
    const library=page.getByRole('link',{name:'Library',exact:true});
    await expect(library).toHaveAttribute('href','#/library');
    await expect(page.getByRole('link',{name:'Transfers',exact:true})).toHaveCount(0);
    const length=await page.evaluate(()=>history.length);
    await page.evaluate(()=>location.hash='#/transfers');
    await expect(page).toHaveURL(/#\/library$/);
    expect(await page.evaluate(()=>history.length)).toBe(length+1);
    await expect(page.locator('#transfer-view h2').first()).toHaveText('Library');
    await expect(page.locator('#empty')).toHaveText('No torrents');
    await expect(page.locator('#count')).toHaveText('0 torrents');
    await page.goBack();await expect(page).toHaveURL(/#\/new$/);
    await page.goForward();await expect(page).toHaveURL(/#\/library$/);
    await page.locator('#new-nav').click();
    const id='a'.repeat(40);
    await page.locator('#open-button').click();await page.locator('#magnet').fill(id);
    await page.locator('#magnet-form button[type=submit]').click();
    await expect(page.locator('#open-dialog')).toBeHidden();
    await expect(page).toHaveURL(/#\/library$/);
    await expect(page.locator('#count')).toHaveText('1 torrent');
    const row=page.locator(`[data-id="${id}"]`);
    await expect(row).toBeVisible();await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow','0');
    await expect(page.locator('#file-section')).toBeHidden();
    await expect(row.getByRole('button',{name:'Pause',exact:true})).toHaveCount(0);
    await row.locator('.transfer-name').click();
    await expect(page).toHaveURL(new RegExp('#/library/'+id+'$'));
    await page.locator('#torrent-toggle').click();
    await expect.poll(async()=>(await app.api()).transfers[0].active).toBe(false);
    await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');
    await page.locator('#torrent-toggle').click();
    await expect.poll(async()=>(await app.api()).transfers[0].active).toBe(true);
    expect(await page.locator('#transfers-nav').getAttribute('aria-current')).toBe('page');
    expect(await page.locator('#new-nav').getAttribute('aria-current')).toBe('false');
    await page.locator('#library-back').click();
    await expect(page).toHaveURL(/#\/library$/);
    const gap=await page.evaluate(()=>{
      const a=document.querySelector('#new-nav')!.getBoundingClientRect(),b=document.querySelector('#transfers-nav')!.getBoundingClientRect();return b.top-a.bottom;
    });expect(gap).toBe(4);
    for(const width of [1280,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
      await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`library-${width}-${theme}.png`),animations:'disabled'});
    }
    await row.locator('.transfer-name').click();
    await page.locator('#torrent-more').click();await expect(page.locator('#torrent-remove')).toBeDisabled();await page.locator('#torrent-pin').click();
    await expect(page.locator('#remove-title')).toHaveText('Unpin and delete?');
    await expect(page.locator('#delete-files')).toBeHidden();
    await page.locator('#remove-form button[type=submit]').click();
    await expect(row).toHaveCount(0);await expect(page.locator('#empty')).toHaveText('No torrents');
    expect((await app.api()).transfers).toHaveLength(0);
    await page.locator('#sections-button').click();await expect(page.locator('#new-nav')).toBeFocused();
    await page.keyboard.press('Tab');await expect(library).toBeFocused();
    await page.keyboard.press('Escape');await expect(page.locator('#sections-button')).toBeFocused();
    expect(errors).toEqual([]);expect(external).toEqual([]);
    console.log(info.project.name,browser.version());
  }finally{await cleanup(root,app);}
});


test('legacy post destinations normalize the complete route without another history entry',async({page})=>{
 const root=await temporary();let app;
 try{
  app=await startApp(join(root,'app'));await page.goto(app.url+'/#/new');
  const suffix='a'.repeat(40)+'/'+'b'.repeat(40)+'/seq/42',length=await page.evaluate(()=>history.length);
  await page.evaluate(suffix=>location.hash='#/feeds/'+suffix,suffix);await expect(page).toHaveURL(app.url+'/#/posts/'+suffix);
  expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await page.goBack();await expect(page).toHaveURL(/#\/new$/);await page.goForward();await expect(page).toHaveURL(app.url+'/#/posts/'+suffix);
  const before=await page.evaluate(()=>history.length);await page.reload();expect(await page.evaluate(()=>history.length)).toBe(before);await expect(page.locator('#post-title')).toHaveText('Post unavailable');
 }finally{await cleanup(root,app);}
});
