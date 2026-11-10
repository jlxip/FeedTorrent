import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';
test.use({actionTimeout:15000});

async function fixture(page){
  const root=await temporary(),app=await startApp(join(root,'app'));
  const pub=(c:any)=>app.api('/api/publishing',c),password='organization test password';
  await pub({action:'create_key',password,confirmation:password});
  const a=await pub({action:'create_post',title:'Alpha'}),b=await pub({action:'create_post',title:'Beta'});
  const publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  await app.command({type:'follow_post',uri:'magnet:?xs=urn:btpk:'+publicKey,config:{name:'Reading',mode:'current_catalog',automatic_limit:8388608}});
  await wait(async()=>{const s=await app.api();return s.organization.nodes.length===3&&s;},'tree synchronized');
  const s=await app.api(),keys={a:'own:'+a.id,b:'own:'+b.id,f:'followed:'+s.posts[0].id};
  const change=async(key:string,action:string,parent:string|null=null,before:string|null=null)=>{const s=await app.api();return app.command({type:'organize_post',key,action,parent,before,revision:s.organization.revision});};
  const row=(key:string)=>page.locator(`.post-row[data-key="${key}"]`);
  await page.goto(app.url+'/#/library');
  await expect(page.locator('#post-tree .post-link')).toHaveCount(3);
  return {root,app,pub,keys,change,row};
}

test('mixed tree, content activity, no-op saves, archive and durable organization',async({page,browser},info)=>{
  const x=await fixture(page),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));console.log(info.project.name,browser.version());
  try{
    const {a,b,f}=x.keys;
    await expect(page.locator('#own-posts-label')).toHaveCount(0);
    await expect(x.row(a).getByRole('img',{name:'Your post'})).toBeVisible();
    await expect(x.row(f).getByRole('img',{name:'Followed post'})).toBeVisible();
    await x.change(a,'move',f);await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText('Alpha');
    await x.change(b,'move',f,a);await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText(['Beta','Alpha']);
    const draft=await x.pub({action:'get_post',id:a.slice(4)});draft.draft.pages[0].body='Saved edit';
    await x.pub({action:'save_draft',id:a.slice(4),draft:draft.draft,revision:draft.revision});
    await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText(['Alpha','Beta']);
    await x.change(b,'move',f,a);const unchanged=await x.pub({action:'get_post',id:a.slice(4)});
    const result=await x.pub({action:'save_draft',id:a.slice(4),draft:unchanged.draft,revision:unchanged.revision});expect(result.revision).toBe(unchanged.revision);
    await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText(['Beta','Alpha']);
    await x.row(f).getByRole('button',{name:'Toggle children of Reading'}).click();await expect(x.row(a)).toBeHidden();
    await page.reload();await expect(x.row(f)).toBeVisible();await expect(x.row(a)).toBeHidden();await x.row(f).getByRole('button',{name:'Toggle children of Reading'}).click();
    await x.row(f).getByRole('button',{name:'Actions for Reading'}).click();await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
    await expect(page.locator('#post-tree .post-link')).toHaveCount(0);await expect(page.locator('#archived-posts .post-link')).toHaveCount(3);
    await expect(x.row(f)).toBeHidden();await page.locator('#post-archive > summary').click();await expect(x.row(f)).toBeVisible();
    const archived=await x.app.api();expect(archived.posts).toHaveLength(1);expect(archived.publishing.posts.every(f=>f.active)).toBe(true);
    const edit=await x.pub({action:'get_post',id:a.slice(4)});edit.draft.pages[0].body+=' again';await x.pub({action:'save_draft',id:a.slice(4),draft:edit.draft,revision:edit.revision});
    await expect.poll(async()=>{const s=await x.app.api();return Number(s.organization.revision)>Number(archived.organization.revision);}).toBe(true);
    await expect(page.locator('#archived-posts .post-link')).toHaveCount(3);
    await page.reload();await expect(page.locator('#archived-posts .post-link')).toHaveCount(3);
    await expect(x.row(f)).toBeVisible();await x.row(f).getByRole('button',{name:'Actions for Reading'}).click();await page.getByRole('menuitem',{name:'Restore',exact:true}).click();
    await expect(page.locator('#post-tree .post-link')).toHaveCount(3);
    const disk=JSON.parse(await readFile(join(x.root,'app/state/posts.json'),'utf8'));expect(disk.organization.nodes.some(n=>n.key===a&&n.parent===f)).toBe(true);
    // Unfollow promotes children instead of losing their navigation entries.
    await x.app.deletePost('followed',f.slice(9));await expect(page.locator('#post-tree > li > .post-row > .post-link')).toHaveText(['Alpha','Beta']);
    expect(errors).toEqual([]);
  }finally{await cleanup(x.root,x.app);}
});

test('pointer nesting, sibling positions, root and concurrent drag conflicts',async({page},info)=>{
  const x=await fixture(page),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    const {a,b,f}=x.keys;
    async function drag(key:string,target:string,part:number){
      await expect(x.row(key).getByRole('button',{name:/Actions for/})).toBeEnabled();
      const grip=await x.row(key).locator('.post-link').boundingBox(),box=await x.row(target).boundingBox();
      await page.mouse.move(grip!.x+grip!.width/2,grip!.y+grip!.height/2);await page.mouse.down();
      await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height*part,{steps:8});
      await expect(page.locator('#post-root-drop')).toBeVisible();
    }
    await drag(a,f,.5);await page.mouse.up();await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===a).parent)).toBe(f);
    await drag(b,f,.5);await page.mouse.up();await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===b).parent)).toBe(f);
    await drag(a,b,.1);await page.mouse.up();await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText(['Alpha','Beta']);
    await drag(a,b,.9);await page.mouse.up();await expect(page.locator(`#post-tree li[data-key="${f}"] > ul .post-link`)).toHaveText(['Beta','Alpha']);
    await drag(a,b,.1);await x.change(f,'archive');await page.mouse.up();await expect(page.locator('#organization-error')).toContainText('another tab');
    await x.change(f,'restore');await expect(x.row(a)).toBeVisible();
    await drag(a,b,.5);const root=await page.locator('#post-root-drop').boundingBox();await page.mouse.move(root!.x+root!.width/2,root!.y+root!.height/2);await page.mouse.up();
    await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===a).parent)).toBe(null);
    for(const width of [1280,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
      if(width===320&&await page.locator('#sidebar').getAttribute('aria-hidden')==='true')await page.locator('#sections-button').click();
      await expect(page.locator('#post-tree')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`tree-${width}-${theme}.png`),animations:'disabled'});
    }
    expect(errors).toEqual([]);
  }finally{await cleanup(x.root,x.app);}
});

test('touch alternative, move drafts, mobile menus and first/last positions',async({page,browser,browserName})=>{
  const x=await fixture(page);
  try{
    await page.setViewportSize({width:320,height:740});await page.locator('#sections-button').click();
    const {a,f}=x.keys;
    await x.row(a).getByRole('button',{name:'Actions for Alpha'}).click();await page.getByRole('menuitem',{name:'Move…'}).click();
    await expect(page.locator('#post-move-dialog')).toBeVisible();
    await page.locator('#post-move-parent').selectOption(f);await page.locator('#post-move-position').selectOption('last');
    await page.locator('#post-move-dialog [data-close]').click();await page.locator('#sections-button').click();await x.row(a).getByRole('button',{name:'Actions for Alpha'}).click();await page.getByRole('menuitem',{name:'Move…'}).click();
    await expect(page.locator('#post-move-parent')).toHaveValue(f);await expect(page.locator('#post-move-position')).toHaveValue('last');await page.locator('#post-move-submit').click();
    await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===a).parent)).toBe(f);
    await page.locator('#sections-button').click();await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();
    await page.locator('#creation-delete').click();
    // Real touch input opens the accessible alternative; Chromium also drives a native touch drag.
    const context=await browser.newContext({viewport:{width:320,height:740},hasTouch:true});const touch=await context.newPage();
    await touch.goto(x.app.url+'/#/library');await touch.locator('#sections-button').tap();
    const grip=touch.locator(`.post-row[data-key="${a}"] .post-link`);
    await touch.locator(`.post-row[data-key="${a}"]`).getByRole('button',{name:'Actions for Alpha'}).tap();await touch.getByRole('menuitem',{name:'Move…'}).tap();
    await expect(touch.locator('#post-move-dialog')).toBeVisible();await touch.locator('#post-move-parent').selectOption('');await touch.locator('#post-move-submit').tap();
    await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===a).parent)).toBe(null);
    if(browserName==='chromium'){
      await touch.locator('#sections-button').tap();await expect(grip).toBeEnabled();
      // Native touch injection uses coordinates; wait for the sidebar animation
      // just as Playwright does for an ordinary tap.
      await grip.tap({trial:true});
      const from=(await grip.boundingBox())!,to=(await touch.locator(`.post-row[data-key="${f}"]`).boundingBox())!;
      const cdp=await context.newCDPSession(touch),sx=from.x+from.width/2,sy=from.y+from.height/2,tx=to.x+to.width/2,ty=to.y+to.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:sx,y:sy,id:1}]});
      await expect(touch.locator('#post-root-drop')).toBeVisible();
      for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:sx+(tx-sx)*i/8,y:sy+(ty-sy)*i/8,id:1}]});
      await expect(touch.locator('#post-root-drop')).toBeVisible();await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===a).parent)).toBe(f);
      for(let i=0;i<20;i++){
        const pk=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
        await x.app.command({type:'follow_post',uri:'magnet:?xs=urn:btpk:'+pk,config:{name:`Scroll ${i}`,mode:'current_catalog',automatic_limit:8388608}});
      }
      await expect(touch.locator('#post-tree .post-link')).toHaveCount(23);
      const scroller=touch.locator('#sidebar nav > section');await scroller.evaluate(e=>{e.scrollTop=0;});
      const first=touch.locator('#post-tree > li > .post-row > .post-link').first();await first.tap({trial:true});
      const point=(await first.boundingBox())!,px=point.x+point.width/2,py=point.y+point.height/2;
      const revision=(await x.app.api()).organization.revision,status=await touch.locator('#organization-status').textContent();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:px,y:py,id:2}]});
      for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:px,y:py-i*10,id:2}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await expect.poll(()=>scroller.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
      await expect(touch.locator('#post-root-drop')).toBeHidden();expect((await x.app.api()).organization.revision).toBe(revision);await expect(touch.locator('#organization-status')).toHaveText(status!);
      await cdp.detach();
    }
    await context.close();
  }finally{await cleanup(x.root,x.app);}
});


test('whole rows drag from icon and padding while ordinary clicks and controls stay usable',async({page})=>{
  const x=await fixture(page);
  try{
    const {a,b,f}=x.keys;
    await expect(page.locator('.post-grip')).toHaveCount(0);
    await x.row(b).locator('.post-link').click();await expect(page.locator('#own-preview')).toBeVisible();await expect(page.locator('#own-heading')).toHaveText('Beta');
    await page.locator('#transfers-nav').click();
    async function start(key:string,part:'icon'|'padding'){
      await expect(x.row(key).getByRole('button',{name:/Actions for/})).toBeEnabled();
      const from=(await (part==='icon'?x.row(key).locator('.post-link svg'):x.row(key)).boundingBox())!;
      await page.mouse.move(from.x+(part==='padding'?3:from.width/2),from.y+from.height/2);await page.mouse.down();
      const to=(await x.row(f).boundingBox())!;await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});
      await expect(page.locator('#post-root-drop')).toBeVisible();await page.mouse.up();
      await expect.poll(async()=>((await x.app.api()).organization.nodes.find(n=>n.key===key).parent)).toBe(f);
      await expect(page).toHaveURL(/#\/library$/);
    }
    await start(a,'icon');await start(b,'padding');
    const fold=x.row(f).getByRole('button',{name:'Toggle children of Reading'});await fold.click();await expect(x.row(a)).toBeHidden();
    await fold.click();await expect(x.row(a)).toBeVisible();await expect(page.locator('#post-root-drop')).toBeHidden();
    await x.row(f).getByRole('button',{name:'Actions for Reading'}).click();await expect(page.getByRole('menuitem',{name:'Move…'})).toBeVisible();
    await expect(page.locator('#post-root-drop')).toBeHidden();await x.row(f).getByRole('button',{name:'Actions for Reading'}).click();
    await x.row(a).locator('.post-link').click();await expect(page.locator('#own-preview')).toBeVisible();await expect(page.locator('#own-heading')).toHaveText('Alpha');
  }finally{await cleanup(x.root,x.app);}
});
