import {expect,test} from '@playwright/test';
import {generateKeyPairSync} from 'node:crypto';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';
async function fixture(page:any){
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));const ids:string[]=[];
    for(const name of ['First','Second']){
      const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
      const uri='magnet:?xs=urn:btpk:'+key,{id}=await app.command({type:'inspect_source',uri});ids.push(id);
      await app.command({type:'follow_post',uri,config:{name,mode:'current_catalog',automatic_limit:8388608}});
    }
    const open=async(id=ids[0])=>{if(page.url().startsWith(app!.url)){if(await page.locator('#reader-settings-dialog').isVisible())await page.locator('#reader-settings-dialog [data-close]').click();await page.evaluate(value=>{location.hash='#/posts/'+value;},id);}else await page.goto(app!.url+'/#/posts/'+id);await page.locator('#post-settings').click();await expect(page.locator('#reader-settings-dialog')).toBeVisible();};
    return {root,app,ids,open,post:async(id=ids[0])=>(await app!.api()).posts.find((p:any)=>p.id===id)};
  }catch(error){await cleanup(root,app);throw error;}
}
const close=async(page:any)=>{await page.locator('#reader-settings-dialog [data-close]').click();await expect(page.locator('#reader-settings-dialog')).toBeHidden();};

test('post configuration lives beside the title and automatically saves valid fields, including on dismissal',async({page},info)=>{
  const x=await fixture(page);
  try{
    await x.open();await expect(page.locator('#reader-settings-title')).toHaveText('Post settings');
    await expect(page.locator('#reader-settings-dialog').getByRole('button',{name:'Save',exact:true})).toHaveCount(0);
    expect(await page.locator('#post-settings').evaluate(e=>e.previousElementSibling?.classList.contains('help-control'))).toBe(true);
    await expect(page.locator('#reader-post-magnet')).toHaveAttribute('readonly','');
    await expect(page.locator('.reader-body select,.reader-body #reader-load-images')).toHaveCount(0);
    await expect(page.locator('#reader-load-images')).toBeHidden();
    await page.locator('#reader-post-name').fill('Renamed');await expect.poll(async()=>(await x.post()).local_name).toBe('Renamed');
    await expect(page.locator('#reader-settings-dialog')).toBeVisible();
    await page.locator('#reader-post-mode').selectOption('mirror_catalogs');await expect.poll(async()=>(await x.post()).mode).toBe('mirror_catalogs');
    await page.locator('#reader-post-limit').fill('17');await close(page);await expect.poll(async()=>(await x.post()).automatic_limit).toBe(17*1048576);
    await page.locator('#post-settings').click();await expect(page.locator('#reader-post-limit')).toHaveValue('17');
    await page.locator('#reader-post-unlimited').check();await expect(page.locator('#reader-post-limit')).toBeDisabled();await expect.poll(async()=>(await x.post()).automatic_limit).toBe(null);
    await page.locator('#reader-post-name').fill('Outside dismissal');await page.mouse.click(2,2);await expect(page.locator('#reader-settings-dialog')).toBeHidden();await expect.poll(async()=>(await x.post()).local_name).toBe('Outside dismissal');
    for(const width of [320,1280])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await page.locator('#post-settings').click();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await page.locator('#reader-settings-dialog .dialog-surface').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`followed-settings-${width}-${theme}.png`),fullPage:true,animations:'disabled'});await close(page);
    }
  }finally{await cleanup(x.root,x.app);}
});

test('edits queued during a save survive its response, snapshots and closing the settings',async({page})=>{
  const x=await fixture(page);let release=()=>{};
  try{
    await x.open();let held=true,seen=false,active=0,maximum=0;const commands:any[]=[];
    const gate=new Promise<void>(r=>release=r);
    await page.route('**/api/commands',async route=>{
      const command=route.request().postDataJSON();if(command.type!=='configure_post'){await route.continue();return;}
      commands.push(command);++active;maximum=Math.max(maximum,active);
      try{if(held){held=false;seen=true;await gate;}await route.continue();}finally{--active;}
    });
    await page.locator('#reader-post-name').fill('First save');await page.locator('#reader-post-mode').selectOption('mirror_catalogs');await expect.poll(()=>seen).toBe(true);
    await page.locator('#reader-post-name').fill('Newer edit');await page.locator('#reader-post-limit').fill('23');await page.locator('#reader-image-policy').selectOption('always');await page.locator('#reader-image-policy').selectOption('ask');await close(page);
    await page.locator('#post-settings').click();await expect(page.locator('#reader-post-name')).toHaveValue('Newer edit');await expect(page.locator('#reader-post-limit')).toHaveValue('23');
    release();await expect.poll(async()=>{const p=await x.post();return [p.local_name,p.mode,p.automatic_limit];}).toEqual(['Newer edit','mirror_catalogs',23*1048576]);
    await expect(page.locator('#reader-settings-status')).toHaveText('Saved');expect(commands).toHaveLength(2);expect(maximum).toBe(1);expect((await x.app.api()).image_preferences.posts[x.ids[0]]).toBe('ask');
    await expect(page.locator('#reader-post-name')).toHaveValue('Newer edit');await expect(page.locator('#reader-settings-dialog')).toBeVisible();
  }finally{release();await cleanup(x.root,x.app);}
});

test('save errors and invalid limits retain entity drafts without automatic retries or blocking other valid edits',async({page,context})=>{
  const x=await fixture(page);
  try{
    await x.open();let reject=true,attempts=0;
    await page.route('**/api/commands',async route=>{
      if(route.request().postDataJSON().type==='configure_post'){++attempts;if(reject){await route.fulfill({status:503,json:{error:'Configuration unavailable'}});return;}}
      await route.continue();
    });
    await page.locator('#reader-post-name').fill('Keep this draft');await expect(page.locator('#reader-settings-error')).toContainText('Configuration unavailable');
    const failed=attempts;await close(page);await x.open(x.ids[1]);await expect(page.locator('#reader-post-name')).toHaveValue('Second');
    await x.app.command({type:'configure_post',id:x.ids[0],config:{name:'Other tab',mode:'mirror_catalogs',automatic_limit:8388608}});
    await x.open();await expect(page.locator('#reader-post-name')).toHaveValue('Keep this draft');await expect(page.locator('#reader-post-mode')).toHaveValue('mirror_catalogs');expect(attempts).toBe(failed);
    reject=false;await page.locator('#reader-settings-retry').click();await expect.poll(async()=>(await x.post()).local_name).toBe('Keep this draft');await expect(page.locator('#reader-settings-status')).toHaveText('Saved');
    await page.locator('#reader-post-limit').fill('0');await page.locator('#reader-post-name').fill('Valid name');await expect.poll(async()=>(await x.post()).local_name).toBe('Valid name');
    expect((await x.post()).automatic_limit).toBe(8388608);await expect(page.locator('#reader-post-limit')).toHaveAttribute('aria-invalid','true');
    await close(page);await page.locator('#post-settings').click();await expect(page.locator('#reader-post-limit')).toHaveValue('0');
    const other=await context.newPage();await other.goto(x.app.url+'/#/posts/'+x.ids[0]);await other.locator('#post-settings').click();
    await other.locator('#reader-post-mode').selectOption('mirror_all');await expect(page.locator('#reader-post-mode')).toHaveValue('mirror_all');await expect(page.locator('#reader-post-limit')).toHaveValue('0');
    await page.locator('#reader-post-limit').fill('3');await expect.poll(async()=>(await x.post()).automatic_limit).toBe(3*1048576);await expect(other.locator('#reader-post-limit')).toHaveValue('3');
    await other.close();
  }finally{await cleanup(x.root,x.app);}
});

test('navigation flushes valid edits without letting late saves reopen settings, and Follow post still needs confirmation',async({page})=>{
  const x=await fixture(page);let release=()=>{};
  try{
    await x.open();const gate=new Promise<void>(r=>release=r);let seen=false;
    await page.route('**/api/commands',async route=>{if(route.request().postDataJSON().type==='configure_post'){seen=true;await gate;}await route.continue();});
    await page.locator('#reader-post-name').fill('Saved after leaving');await page.evaluate(id=>{location.hash='#/posts/'+id;},x.ids[1]);
    await expect(page.locator('#reader-settings-dialog')).toBeHidden();await expect.poll(()=>seen).toBe(true);
    await page.locator('#post-settings').click();await expect(page.locator('#reader-post-name')).toHaveValue('Second');release();
    await expect.poll(async()=>(await x.post()).local_name).toBe('Saved after leaving');await expect(page.locator('#reader-post-name')).toHaveValue('Second');await close(page);
    await page.locator('#open-button').click();const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');await page.locator('#magnet').fill('magnet:?xs=urn:btpk:'+key);await page.locator('#magnet-form button[type=submit]').click();
    await expect(page.locator('#post-dialog')).toBeVisible();await expect(page.locator('#post-submit')).toHaveText('Follow post');
    await page.locator('#post-name').fill('Not followed yet');await page.locator('#post-mode').selectOption('mirror_catalogs');await page.locator('#post-dialog [data-close]').click();expect((await x.app.api()).posts).toHaveLength(2);
    await expect(page).toHaveURL(new RegExp(x.ids[1]+'$'));
  }finally{release();await cleanup(x.root,x.app);}
});
