import {expect,test} from '@playwright/test';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';
test.use({actionTimeout:15000});
async function fixture(page){
  const root=await temporary(),app=await startApp(join(root,'app'));
  const pub=(c:any)=>app.api('/api/publishing',c),password='remove post test password';
  await pub({action:'create_key',password,confirmation:password});
  const own=await pub({action:'create_post',title:'My notes'}),child=await pub({action:'create_post',title:'Child'});
  const ids=[];
  for(const [index,mode] of ['current_catalog','mirror_catalogs','mirror_all'].entries()){
    const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    await app.command({type:'follow_post',uri:'magnet:?xs=urn:btpk:'+key,config:{name:'Reading '+index,mode,automatic_limit:8388608}});
    ids.push((await app.api()).posts.find(f=>f.name==='Reading '+index).id);
  }
  const torrent='a'.repeat(40);await app.command({type:'add_magnet',uri:'magnet:?xt=urn:btih:'+torrent});await app.command({type:'pause',id:torrent});
  await wait(async()=>{const s=await app.api();return s.organization.nodes.length===5;},'organization');
  const change=async(key,action,parent=null)=>{const s=await app.api();return app.command({type:'organize_post',key,action,parent,before:null,revision:s.organization.revision});};
  await page.goto(app.url+'/#/new');
  const row=(key)=>page.locator(`.post-row[data-key="${key}"]`);
  const open=async(key)=>{await row(key).getByRole('button',{name:/Actions for/}).click();await page.getByRole('menuitem',{name:'Delete post…',exact:true}).click();await expect(page.locator('#post-remove-dialog')).toHaveCSS('opacity','1');};
  return {root,app,pub,own:own.id,child:child.id,ids,torrent,change,row,open};
}
test('own removal confirms, preserves Library and key, survives reload/restart and shows unavailable routes',async({page},info)=>{
  const x=await fixture(page);let restarted;
  try{
    const file=join(x.root,'app/state/publishing/library.json'),before=JSON.parse(await readFile(file,'utf8'));
    await page.goto(x.app.url+'/#/own/'+x.own+'/read');await expect(page.locator('#own-preview')).toBeVisible();
    await x.row('own:'+x.own).getByRole('button',{name:/Actions for/}).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await expect(x.row('own:'+x.own).getByRole('button',{name:/Actions for/})).toHaveAttribute('aria-activedescendant',/-remove$/);await page.keyboard.press('Enter');
    await expect(page.locator('#post-remove-dialog')).toHaveCSS('opacity','1');
    await expect(page.locator('#post-remove-description')).toContainText('draft');
    await page.screenshot({path:info.outputPath('remove-1280.png')});
    await expect(page.locator('#post-remove-dialog [data-close]')).toBeFocused();await page.keyboard.press('Escape');
    expect((await x.app.api()).publishing.posts).toHaveLength(2);
    await x.open('own:'+x.own);await page.mouse.click(2,2);await expect(page.locator('#post-remove-dialog')).toBeHidden();
    await x.open('own:'+x.own);await page.locator('#post-remove-submit').click();await expect(page).toHaveURL(/#\/library$/);
    await expect(page.locator('#library-heading')).toBeFocused();await expect(x.row('own:'+x.own)).toHaveCount(0);
    const state=await x.app.api();expect(state.transfers).toHaveLength(1);expect(state.transfers[0].id).toBe(x.torrent);expect(state.transfers[0].active).toBe(false);
    const after=JSON.parse(await readFile(file,'utf8'));expect(after.vault).toEqual(before.vault);expect(after.posts[x.child]).toEqual(before.posts[x.child]);expect(after.posts[x.own]).toBeUndefined();
    await page.goto(x.app.url+'/#/own/'+x.own+'/read');await expect(page.locator('#own-unavailable')).toContainText('Post unavailable');await expect(page.locator('#own-preview')).toBeHidden();
    await page.reload();await expect(page.locator('#own-unavailable')).toBeVisible();
    await x.app.stop();restarted=await startApp(join(x.root,'app'));
    expect((await restarted.api()).publishing.posts.map(f=>f.id)).toEqual([x.child]);
    await page.goto(restarted.url+'/#/own/'+x.own);await expect(page.locator('#own-unavailable')).toContainText('Post unavailable');
    expect((await restarted.api()).transfers[0].active).toBe(false);
  }finally{await cleanup(x.root,x.app,restarted);}
});
test('shared menu/settings removal preserves other routes, children and all followed modes',async({page})=>{
  const x=await fixture(page);
  try{
    await x.change('own:'+x.child,'move','own:'+x.own);await x.change('own:'+x.own,'archive');
    await expect(page.locator('#post-archive')).toBeVisible();await page.locator('#post-archive > summary').click();
    await x.open('own:'+x.own);await page.locator('#post-remove-submit').click();await expect(page.locator('#post-remove-dialog')).toBeHidden();
    await expect(page).toHaveURL(/#\/new$/);await expect.poll(async()=>(await x.app.api()).organization.nodes.find(n=>n.key==='own:'+x.child).parent).toBe(null);
    expect((await x.app.api()).organization.nodes.find(n=>n.key==='own:'+x.child).archived).toBe(true);
    const first=x.ids[0];await page.goto(x.app.url+'/#/posts/'+first);await page.locator('#post-settings').click();await expect(page.locator('#post-unfollow')).toHaveText('Delete post…');
    await page.locator('#post-unfollow').click();await expect(page.locator('#post-remove-description')).toContainText('Delete this post');
    await page.keyboard.press('Escape');await expect(page.locator('#post-dialog')).toBeVisible();await expect(page.locator('#post-unfollow')).toBeFocused();
    await page.locator('#post-unfollow').click();await page.locator('#post-remove-submit').click();await expect(page.locator('#post-dialog')).toBeHidden();await expect(page).toHaveURL(/#\/library$/);
    for(const id of x.ids.slice(1)){
      await page.goto(x.app.url+'/#/new');await x.open('followed:'+id);await page.locator('#post-remove-submit').click();await expect(page.locator('#post-remove-dialog')).toBeHidden();await expect(page).toHaveURL(/#\/new$/);
    }
    const state=await x.app.api();expect(state.posts).toHaveLength(0);expect(state.transfers).toHaveLength(1);expect(state.publishing.posts.map(f=>f.id)).toEqual([x.child]);
    await page.goto(x.app.url+'/#/posts/'+first);await expect(page.locator('#post-title')).toHaveText('Post unavailable');
  }finally{await cleanup(x.root,x.app);}
});
test('failure keeps draft and dialog; autosave and duplicate submission cannot resurrect a removed post',async({page})=>{
  const x=await fixture(page),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(x.app.url+'/#/own/'+x.own);await expect(page.locator('#own-body')).toBeVisible();
    await page.route('**/api/commands',async route=>{
      if(route.request().postDataJSON().type==='delete_post')await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Disk write refused'})});else await route.continue();
    });
    await page.locator('#own-body').fill('Keep this draft');await x.open('own:'+x.own);await page.locator('#post-remove-submit').click();
    await expect(page.locator('#post-remove-error')).toContainText('Disk write refused');await expect(page.locator('#post-remove-dialog')).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.locator('#own-body')).toHaveValue('Keep this draft');await expect(page.locator('#own-body')).toBeEnabled();
    await page.unroute('**/api/commands');
    let release:()=>void;const held=new Promise<void>(r=>release=r);let sawSave:()=>void;const saving=new Promise<void>(r=>sawSave=r);let removes=0;
    await page.route('**/api/publishing',async route=>{
      const action=route.request().postDataJSON().action;
      if(action==='save_draft'){sawSave();await held;}

      await route.continue();
    });
    await page.route('**/api/commands',async route=>{if(route.request().postDataJSON().type==='delete_post')removes++;await route.continue();});
    await page.locator('#own-body').fill('In flight');await saving;
    await x.open('own:'+x.own);await page.locator('#post-remove-submit').click();await expect(page.locator('#post-remove-submit')).toBeDisabled();
    await page.locator('#post-remove-form').evaluate((e:HTMLFormElement)=>{e.requestSubmit();e.requestSubmit();});release!();
    await expect(page).toHaveURL(/#\/library$/);expect(removes).toBe(1);await page.unroute('**/api/publishing');
    await page.goto(x.app.url+'/#/own/'+x.own);await expect(page.locator('#own-unavailable')).toBeVisible();expect((await x.app.api()).publishing.posts.some(f=>f.id===x.own)).toBe(false);expect(errors).toEqual([]);
  }finally{await cleanup(x.root,x.app);}
});
test('mobile confirmation supports touch, themes, keyboard and disconnect without changing data',async({browser},info)=>{
  const context=await browser.newContext({viewport:{width:320,height:740},hasTouch:true}),page=await context.newPage(),x=await fixture(page);
  try{
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>{localStorage.setItem('theme',theme);document.documentElement.classList.toggle('dark',theme==='dark');},theme);
      await page.locator('#sections-button').tap();await x.open('own:'+x.own);
      await expect(page.locator('#post-remove-dialog [data-close]')).toBeFocused();
      const box=(await page.locator('#post-remove-dialog > .dialog-surface').boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
      await page.screenshot({path:info.outputPath('remove-320-'+theme+'.png')});
      await page.locator('#post-remove-dialog [data-close]').tap();await expect(page.locator('#post-remove-dialog')).toBeHidden();
    }
    await page.locator('#sections-button').tap();await x.open('own:'+x.own);await x.app.stop();
    await expect(page.locator('#post-remove-submit')).toBeDisabled();await expect(page.locator('#post-remove-name')).toHaveText('My notes');
    await page.keyboard.press('Escape');await expect(page.locator('#post-remove-dialog')).toBeHidden();
    const library=JSON.parse(await readFile(join(x.root,'app/state/publishing/library.json'),'utf8'));expect(Object.keys(library.posts)).toHaveLength(2);
  }finally{await context.close();await cleanup(x.root,x.app);}
});

test('a late reader response after removal in another tab cannot restore the draft',async({page})=>{
  const x=await fixture(page);let release=()=>{};
  try{
    const held=new Promise<void>(r=>release=r);let saw=()=>{};const requested=new Promise<void>(r=>saw=r);
    await page.route('**/api/publishing',async route=>{
      const c=route.request().postDataJSON();
      if(c.action==='get_post'&&c.id===x.own){const response=await route.fetch();saw();await held;await route.fulfill({response});}else await route.continue();
    });
    await page.goto(x.app.url+'/#/own/'+x.own+'/read');await requested;
    await x.app.deletePost('own',x.own);await expect(page.locator('#own-unavailable')).toBeVisible();release();
    await page.goto(x.app.url+'/#/own/'+x.child);await expect(page.locator('#own-title')).toHaveValue('Child');
    await page.goto(x.app.url+'/#/own/'+x.own);await expect(page.locator('#own-unavailable')).toContainText('Post unavailable');await expect(page.locator('#own-editor')).toBeHidden();
    expect((await x.app.api()).publishing.posts.map(f=>f.id)).toEqual([x.child]);
  }finally{release();await cleanup(x.root,x.app);}
});
