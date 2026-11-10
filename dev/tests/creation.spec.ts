import {verify,createPublicKey} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {temporary,startApp,cleanup,dhtNetwork,wait} from './helpers.mjs';
import {evidencePath} from './runtime.mjs';
const verifyMutable=(signature,message,key)=>{try{return verify(null,Buffer.from(message),createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key)]),type:'spki',format:'der'}),Buffer.from(signature));}catch{return false;}};
test('direct keyless editor, retained mode fields, server picker, copy policy and conventional torrent',async({page},info)=>{
  const root=await temporary();let app:any;
  try{
    const sources=join(root,'sources');await mkdir(sources,{recursive:true});await writeFile(join(sources,'payload.txt'),'bytes from the server');app=await startApp(join(root,'app'));
    const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();
    await expect(page.locator('#creation-post')).toBeChecked();await expect(page.locator('#creation-copy')).toBeChecked();expect((await app.api()).publishing.has_key).toBe(false);
    await page.locator('#creation-title').fill('Shared files');await page.locator('#creation-body').fill('A body kept only in post mode');
    await page.locator('#creation-post').uncheck();await expect(page.locator('#creation-body-field')).toBeHidden();await expect(page.locator('#creation-excluded')).toBeVisible();
    await page.locator('[data-help=creation-post-help]').click();await expect(page.locator('#creation-post-help')).toHaveText('Disable for creating a common torrent');
    await page.locator('#creation-add-files').click();await expect(page.locator('#source-dialog')).toBeVisible();
    await page.locator('#source-path').fill(sources);await page.locator('#source-path-form').getByRole('button',{name:'Browse',exact:true}).click();
    await page.getByRole('checkbox',{name:'Select payload.txt',exact:true}).check();await page.locator('#source-dialog [data-close]').click();
    await page.locator('#creation-add-files').click();await expect(page.getByRole('checkbox',{name:'Select payload.txt',exact:true})).toBeChecked();await page.locator('#source-add').click();
    await expect(page.locator('#creation-entries')).toContainText('payload.txt');await page.locator('#creation-copy').uncheck();await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    const route=new URL(page.url()).hash,id=route.split('/')[2];await page.locator('#transfers-nav').click();await expect(page.locator('#creation-library')).toContainText('Shared files');await page.locator('#creation-library a').click();await expect(page.locator('#creation-copy')).not.toBeChecked();
    await page.reload();await expect(page.locator('#creation-title')).toHaveValue('Shared files');await expect(page.locator('#creation-copy')).not.toBeChecked();
    await page.locator('#creation-post').check();await expect(page.locator('#creation-body')).toHaveValue('A body kept only in post mode');await page.locator('#creation-post').uncheck();
    await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    for(const scheme of ['light','dark'] as const){
      await page.emulateMedia({colorScheme:scheme});
      for(const width of [320,1280]){
        await page.setViewportSize({width,height:850});
        await expect(page.locator('#sidebar')).toHaveAttribute('aria-hidden',width===320?'true':'false');
        await expect(page.locator('.workspace > main')).not.toHaveAttribute('inert','');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        await page.screenshot({path:evidencePath('creation-'+info.project.name+'-'+scheme+'-'+width+'.png'),animations:'disabled'});
      }
    }
    await page.locator('#creation-submit').click();await expect(page).toHaveURL(/#\/library\/[0-9a-f]{40}$/);await expect(page.locator('#creation-share')).toBeVisible();await expect(page.locator('#creation-download')).toHaveAttribute('href',/api\/torrent\?id=/);
    const hash=new URL(page.url()).hash.split('/')[2];await wait(async()=> (await app.api()).transfers.some(t=>t.id===hash&&t.state==='Seeding'),'new torrent seeding');
    expect((await app.api()).publishing.has_key).toBe(false);expect(errors).toEqual([]);
    await expect.poll(async()=>{try{await app.api('/api/creation',{action:'get_draft',id});return false;}catch{return true;}}).toBe(true);
  }finally{await cleanup(root,app);}
});
test('post file inclusion, linked option and key creation deferred to Publish',async({page})=>{
  const root=await temporary();let app:any,network:any;
  try{
    const sources=join(root,'sources');await mkdir(sources,{recursive:true});await writeFile(join(sources,'included.txt'),'embedded data');network=await dhtNetwork({verify:verifyMutable});app=await startApp(join(root,'app'),['--dht-bootstrap',network.bootstrap.map(n=>n.host+':'+n.port).join(',')]);
    await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();await page.locator('#creation-title').fill('Post files');await page.locator('#creation-body').fill('Post body');
    await page.locator('#creation-add-files').click();await page.locator('#source-path').fill(sources);await page.locator('#source-path-form').getByRole('button',{name:'Browse',exact:true}).click();await page.getByRole('checkbox',{name:'Select included.txt',exact:true}).check();await page.locator('#source-add').click();
    const select=page.getByRole('combobox',{name:'Include included.txt',exact:true});await expect(select).toHaveValue('include');await select.selectOption('link');await page.waitForTimeout(1700);await select.selectOption('include');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    await page.locator('#creation-submit').click();await expect(page.locator('#creation-password-dialog')).toBeVisible();expect((await app.api()).publishing.has_key).toBe(false);
    const password='creation browser password';await page.locator('#creation-password').fill(password);await page.locator('#creation-confirm').fill('wrong confirmation');await page.locator('#creation-password-submit').click();await expect(page.locator('#creation-password-error')).toContainText('Passwords do not match');await expect(page.locator('#creation-password')).toHaveValue('');expect((await app.api()).publishing.has_key).toBe(false);
    await page.locator('#creation-password').fill(password);await page.locator('#creation-confirm').fill(password);await page.locator('#creation-password-submit').click();await expect(page).toHaveURL(/#\/own\/[0-9a-f]{40}\/read/);await expect(page.locator('#own-preview')).toContainText('Post body');await expect(page.locator('#own-preview')).toContainText('included.txt');
    await page.locator('#own-toggle').click();await expect(page.locator('#own-copy-files')).toBeChecked();await expect(page.locator('#own-post-mode')).toBeDisabled();await page.locator('#own-copy-files').uncheck();await expect(page.locator('#own-draft-status')).toContainText('Draft saved');
  }finally{await cleanup(root,app);if(network)await network.stop();}
});
