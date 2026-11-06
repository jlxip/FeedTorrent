import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary,seed,tracker,wait} from './helpers.mjs';
test.use({hasTouch:true});
test('Pin help, cancellation, shared Unpin and revised Delete post confirmation',async({page},info)=>{
 const root=await temporary();let app,ref,tr;
 try{
  tr=await tracker();ref=await seed(join(root,'source'),[4097],{tracker:true,announce:[tr.http]});app=await startApp(join(root,'app'));
  const password='pin browser test password',pub=c=>app.api('/api/publishing',c);await pub({action:'create_key',password,confirmation:password});
  const a=await pub({action:'create_post',title:'Owned download'}),p=await pub({action:'get_post',id:a.id});p.draft.pages[0].entries.push({kind:'torrent',name:'fixture.torrent',data:ref.bytes});await pub({action:'save_draft',id:a.id,revision:p.revision,draft:p.draft});
  await app.command({type:'add_torrent',data:ref.bytes,origin:{kind:'own',id:a.id}});await wait(async()=>(await app.api()).transfers[0]?.progress===1,'download');
  await page.goto(app.url+'/#/library/'+ref.id);await page.locator('#torrent-more').click();
  await expect(page.locator('#torrent-pin')).toHaveAttribute('aria-checked','false');await page.locator('#torrent-pin-info').hover();
  await expect(page.locator('#torrent-pin-help')).toHaveText('Keep in Library even if the original post is deleted.');
  await page.locator('#torrent-pin-info').click();await expect(page.locator('#torrent-pin-help')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#torrent-pin-help')).toBeHidden();
  await page.locator('#torrent-more').click();await page.locator('#torrent-pin').click();await expect.poll(async()=>(await app.api()).transfers[0].pinned).toBe(true);
  await page.locator('#torrent-more').click();await expect(page.locator('#torrent-remove')).toBeDisabled();await page.locator('#torrent-pin').click();
  await expect.poll(async()=>(await app.api()).transfers[0].pinned).toBe(false);await expect(page.locator('#remove-dialog')).toBeHidden();
  const open=async()=>{await page.locator(`.post-row[data-key="own:${a.id}"]`).getByRole('button',{name:/Actions for/}).click();await page.getByRole('menuitem',{name:'Delete post…',exact:true}).click();await expect(page.locator('#post-remove-submit')).toBeEnabled();};
  await open();await expect(page.locator('#post-remove-description')).toContainText('1 downloaded torrents');
  await app.command({type:'set_pin',id:ref.id,pinned:true});await page.locator('#post-remove-submit').click();await expect(page.locator('#post-remove-error')).toContainText('References changed');await expect(page.locator('#post-remove-description')).toContainText('1 protected by Pin');
  await page.locator('#post-remove-submit').click();await expect(page).toHaveURL(new RegExp('#/library/'+ref.id+'$'));expect((await app.api()).transfers).toHaveLength(1);
  for(const theme of ['light','dark']){
   await page.setViewportSize({width:320,height:740});await page.emulateMedia({colorScheme:theme as 'light'|'dark'});
   await page.locator('#torrent-more').tap();await page.locator('#torrent-pin-info').tap();await expect(page.locator('#torrent-pin-help')).toBeVisible();await page.keyboard.press('Escape');
   await page.locator('#torrent-more').tap();await page.locator('#torrent-pin').tap();await expect(page.locator('#remove-dialog')).toHaveCSS('opacity','1');
   await expect(page.locator('#remove-title')).toHaveText('Unpin and delete?');await expect(page.locator('#remove-dialog [data-close]')).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath('unpin-'+theme+'.png')});await page.keyboard.press('Escape');expect((await app.api()).transfers[0].pinned).toBe(true);
  }
  await page.locator('#torrent-more').click();await page.locator('#torrent-pin').click();await page.locator('#remove-form button[type=submit]').click();await expect(page).toHaveURL(/#\/library$/);await expect.poll(async()=>(await app.api()).transfers.length).toBe(0);
 }finally{await cleanup(root,app,ref,tr);}
});
