import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {postFixture} from './post-fixtures.mjs';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';

test('New posts follows signed roots, reads only displayed content and restores reading decisions',async({page})=>{
  const root=await temporary();let app,fx;
  try {
    fx=await postFixture(root);
    const appDir=join(root,'app'),args=['--dht-bootstrap',fx.bootstrap];
    app=await startApp(appDir,args);
    const config={name:'News source',mode:'current_catalog',automatic_limit:1};
    await app.command({type:'follow_post',uri:fx.postMagnet,config});
    await wait(async()=> (await app.api()).news_unread===1,'first unread root');
    await page.goto(app.url);
    const news=page.locator('#news-list');
    await expect(page.locator('#new-nav')).toHaveAttribute('aria-current','page');
    await expect(page.locator('#transfers-nav')).toHaveAttribute('aria-current','false');
    await expect(news.locator('.news-row')).toHaveCount(1);
    await expect(page.locator('#new-count')).toHaveText('1');
    await expect(news.locator('.badge')).toHaveText('Unread');
    const initial=(await app.command({type:'news_page',offset:0,anchor:null})).entries[0];
    await news.locator('.news-title').click();
    await expect(page.locator('#post-view')).toBeVisible();
    await expect(page.locator('#catalog-status')).toContainText('Awaiting approval');
    expect((await app.api()).news_unread).toBe(1);
    expect(fx.head.requests).toBe(0);
    await app.command({type:'approve_transfer',id:fx.head.id});
    await wait(async()=> (await app.api()).news_unread===0,'verified catalog without body counts as read');
    await page.goBack();
    await expect(news.locator('.badge')).toHaveText('Read');

    await news.locator('.news-toggle').click();
    await expect(page.locator('#new-count')).toHaveText('1');
    await page.reload();
    await expect(news.locator('.badge')).toHaveText('Unread');
    const latest=await fx.catalog('Latest page',[{path:['metadata','body.md'],data:Buffer.from('# Latest body\n\nSafe content.')}]);
    await app.command({type:'configure_post',id:fx.postId,config:{...config,automatic_limit:8388608}});
    await fx.publish(latest);await app.command({type:'refresh_post',id:fx.postId});
    await wait(async()=> (await app.api()).news_unread===2,'new root leaves previous unread');
    // The current page is anchored: no row insertion or forced scroll.
    await expect(news.locator('.news-row')).toHaveCount(1);
    await page.locator('#news-refresh').click();
    await expect(news.locator('.news-row')).toHaveCount(2);
    await expect(news.locator('.news-title').first()).toHaveText('Latest page');
    let fail=true;
    await page.route('**/api/commands',async route=>{
      if(fail&&route.request().postDataJSON()?.type==='read_catalog_body') await route.fulfill({status:503,json:{error:'Body read failed by test'}});
      else await route.continue();
    });
    await news.locator('.news-title').first().click();
    await expect(page.locator('#post-error')).toContainText('Body read failed by test');
    expect((await app.api()).news_unread).toBe(2);
    fail=false;await page.goBack();
    await news.locator('.news-title').first().click();
    await expect(page.locator('#post-reader .reader-body')).toContainText('Latest body');
    await wait(async()=> (await app.api()).news_unread===1,'displayed Markdown read');
    await page.goBack();
    await expect(news.locator('.badge').first()).toHaveText('Read');
    await news.locator('.news-title').last().click();
    await expect(page).toHaveURL(new RegExp(fx.head.id));
    await expect(page.locator('#post-reader .reader-entries')).toContainText('note.txt');
    await wait(async()=> (await app.api()).news_unread===0,'old revision selected explicitly');
    await fx.publish(latest,33);await app.command({type:'refresh_post',id:fx.postId});
    await wait(async()=> (await app.api()).posts[0].sequence==='33','unchanged pointer accepted');
    expect((await app.command({type:'news_page',offset:0,anchor:null})).total).toBe(2);
    await app.deletePost('followed',fx.postId);
    expect((await app.command({type:'news_page',offset:0,anchor:null})).total).toBe(0);
    await app.command({type:'follow_post',uri:fx.postMagnet,config:{...config,automatic_limit:8388608}});
    await wait(async()=> (await app.command({type:'news_page',offset:0,anchor:null})).total===2,'follow preserves history');
    expect((await app.api()).news_unread).toBe(0);
    await app.stop();app=await startApp(appDir,args);
    await page.goto(app.url);
    await expect(news.locator('.news-row')).toHaveCount(2);
    await expect(news.locator('.badge').first()).toHaveText('Read');
    await expect(news.locator('.badge').last()).toHaveText('Read');
    expect((await app.api()).news_unread).toBe(0);
    expect(fx.contentRequests).toBe(0);
    expect(initial.sequence).toBe('1');
    const durable=JSON.parse(await readFile(join(appDir,'state','posts.json'),'utf8'));
    expect(durable.checkpoint.posts[fx.postId]).toBeDefined();
    expect(durable.checkpoint.news.entries).toHaveLength(2);
  } finally {if(app)await app.stop();if(fx)await fx.stop();await cleanup(root);}
});

test('New posts anchored pagination, history position and responsive Vega list',async({page,browser},info)=>{
  const root=await temporary();let app;
  try {
    app=await startApp(join(root,'app'));
    let total=105;
    const post='a'.repeat(40);
    const errors:string[]=[],external:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(!r.url().startsWith(app.url))external.push(r.url());});
    await page.route('**/api/commands',async route=>{
      const c=route.request().postDataJSON();
      if(c.type==='news_page'){
        const bound=c.anchor===null?total:Number(c.anchor),all=Array.from({length:bound},(_,i)=>{
          const n=bound-i;return {post,sequence:String(BigInt('9007199254740993')+BigInt(n)),catalog:n.toString(16).padStart(40,'0'),post_name:'Followed source',name:`Catalog ${n}`,detected_ms:1793740000000-n,read:n%2===0,ready:false,state:'Waiting for metadata',error:''};
        });
        await route.fulfill({json:{entries:all.slice(c.offset,c.offset+100),offset:c.offset,total:bound,anchor:String(bound)}});
      }else await route.continue();
    });
    await page.goto(app.url);
    await expect(page.locator('.news-row')).toHaveCount(100);
    await expect(page.locator('#news-range')).toHaveText('1–100 / 105');
    await expect(page.locator('#news-previous')).toBeDisabled();
    await page.locator('#news-next').click();
    await expect(page.locator('.news-row')).toHaveCount(5);
    await expect(page.locator('#news-range')).toHaveText('101–105 / 105');
    await expect(page.locator('#news-next')).toBeDisabled();
    const last=page.locator('.news-title').last();
    await last.click();await expect(page.locator('#post-view')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#news-range')).toHaveText('101–105 / 105');

    total=106;
    await page.locator('#news-previous').click();
    await expect(page.locator('.news-title').first()).toHaveText('Catalog 106');
    await expect(page.locator('#news-range')).toHaveText('1–100 / 106');
    const bottom=page.locator('.news-title').last();
    await bottom.click();await expect(page.locator('#post-view')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#news-view')).toBeVisible();
    // Back navigation need not wait for the news response or scroll restoration.
    await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(100);
    await page.locator('#news-refresh').click();
    for(const width of [1280,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
      await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
      if(width===320){await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden','true');}
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(width===320){
        const box=await page.locator('.news-toggle').first().boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({path:info.outputPath(`news-${width}-${theme}.png`),animations:'disabled'});
    }
    await page.locator('#sections-button').click();
    await page.locator('#sections-button').click();
    expect(errors).toEqual([]);expect(external).toEqual([]);
    console.log(info.project.name,browser.version());
  }finally{await cleanup(root,app);}
});
