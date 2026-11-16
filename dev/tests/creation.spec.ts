import bencode from 'bencode';
import {verify,createPublicKey,createHash} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {temporary,startApp,cleanup,dhtNetwork,wait} from './helpers.mjs';
import {evidencePath} from './runtime.mjs';
const verifyMutable=(signature,message,key)=>{try{return verify(null,Buffer.from(message),createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key)]),type:'spki',format:'der'}),Buffer.from(signature));}catch{return false;}};
test('direct keyless editor, retained mode fields, native picker, durable imports and conventional torrent',async({page},info)=>{
  const root=await temporary();let app:any;
  try{
    const sources=join(root,'sources');await mkdir(sources,{recursive:true});await writeFile(join(sources,'payload.txt'),'bytes from the server');app=await startApp(join(root,'app'));
    const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();
    await expect(page.locator('#creation-post')).toBeChecked();expect((await app.api()).publishing.has_key).toBe(false);
    await page.locator('#creation-title').fill('Shared files');await page.locator('#creation-body').fill('A body kept only in post mode');
    await page.locator('#creation-regular').check();await expect(page.locator('#creation-body-field')).toBeHidden();await expect(page.locator('#creation-excluded')).toBeVisible();
    await page.locator('#creation-add-files').click();
    const chooser=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:'Files…',exact:true}).click();await (await chooser).setFiles(join(sources,'payload.txt'));
    await expect(page.locator('#creation-entries')).toContainText('payload.txt');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    const route=new URL(page.url()).hash,id=route.split('/')[2];await page.locator('#transfers-nav').click();await expect(page.locator('#creation-library')).toContainText('Shared files');await page.locator('#creation-library a').click();await expect(page.locator('#creation-regular')).toBeChecked();
    await page.reload();await expect(page.locator('#creation-title')).toHaveValue('Shared files');await expect(page.locator('#creation-regular')).toBeChecked();
    await page.locator('#creation-post').check();await expect(page.locator('#creation-body')).toHaveValue('A body kept only in post mode');await page.locator('#creation-regular').check();
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
    await page.locator('#creation-add-files-files').setInputFiles(join(sources,'included.txt'));await expect(page.locator('#creation-entries')).toContainText('included.txt');
    const select=page.getByRole('combobox',{name:'Include included.txt',exact:true});await expect(select).toHaveValue('include');await select.selectOption('link');await page.waitForTimeout(1700);await select.selectOption('include');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    await page.locator('#creation-submit').click();await expect(page.locator('#creation-password-dialog')).toBeVisible();expect((await app.api()).publishing.has_key).toBe(false);
    const password='creation browser password';await page.locator('#creation-password').fill(password);await page.locator('#creation-confirm').fill('wrong confirmation');await page.locator('#creation-password-submit').click();await expect(page.locator('#creation-password-error')).toContainText('Passwords do not match');await expect(page.locator('#creation-password')).toHaveValue('');expect((await app.api()).publishing.has_key).toBe(false);
    await page.locator('#creation-password').fill(password);await page.locator('#creation-confirm').fill(password);await page.locator('#creation-password-submit').click();await expect(page).toHaveURL(/#\/own\/[0-9a-f]{40}\/read/);await expect(page.locator('#own-preview')).toContainText('Post body');await expect(page.locator('#own-preview')).toContainText('included.txt');
    await page.locator('#own-toggle').click();await expect(page.locator('#own-copy-files')).toHaveCount(0);await expect(page.locator('#own-draft-status')).toContainText('Draft saved');
  }finally{await cleanup(root,app);if(network)await network.stop();}
});

test('background draft refresh preserves Publish between pointerdown and pointerup',async({page})=>{
  const root=await temporary();let app:any,release:(()=>void)|undefined;
  try{
    app=await startApp(join(root,'app'));await page.goto(app.url);await page.locator('#post-add').click();
    await page.locator('#creation-title').fill('Stable Publish');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
    let hold=true,ready:()=>void;const waiting=new Promise<void>(resolve=>ready=resolve);
    await page.route('**/api/creation',async route=>{
      if(route.request().postDataJSON().action!=='list'||!hold){await route.continue();return;}
      hold=false;const response=await route.fetch();await new Promise<void>(resolve=>{release=resolve;ready();});await route.fulfill({response});
    });
    await waiting;
    const button=page.locator('#creation-submit'),box=await button.boundingBox();expect(box).not.toBeNull();
    await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();
    const response=page.waitForResponse(r=>r.url().endsWith('/api/creation')&&r.request().postDataJSON().action==='list');release!();await response;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await page.mouse.up();await expect(page.locator('#creation-password-dialog')).toBeVisible();
  }finally{release?.();await cleanup(root,app);}
});

test('a Cancel press cannot publish after an operation finishes during the press',async({page})=>{
 const root=await temporary();let app:any;
 try{
  app=await startApp(join(root,'app'));await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();
  let working=true;const calls:string[]=[];
  await page.route('**/api/creation',async route=>{const c=route.request().postDataJSON();calls.push(c.action);if(c.action==='list'){const r=await route.fetch(),v=await r.json();for(const d of v.drafts){d.phase=working?'Hashing':'Draft';d.operation=7;}await route.fulfill({json:v});}else await route.continue();});
  const button=page.locator('#creation-submit');await expect(button).toHaveAttribute('aria-label','Cancel');
  const box=await button.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();working=false;
  await expect(button).toHaveAttribute('aria-label','OK');await page.mouse.up();
  await expect(page.locator('#creation-password-dialog')).not.toBeVisible();expect(calls).not.toContain('create_torrent');expect(calls).not.toContain('bind_post');
 }finally{await cleanup(root,app);}
});

test('native Folder selection retains nested metainfo originals and rejects invalid type changes',async({page})=>{
 const root=await temporary();let app:any;
 try{
  const folder=join(root,'bundle');await mkdir(join(folder,'nested'),{recursive:true});
  const bytes=Buffer.from('abc'),meta=Buffer.from(bencode.encode({info:{name:'payload.txt',length:3,'piece length':16384,pieces:createHash('sha1').update(bytes).digest()}}));
  await writeFile(join(folder,'nested','VALID.TORRENT'),meta);await writeFile(join(folder,'note.txt'),bytes);
  app=await startApp(join(root,'app'));await page.goto(app.url);await page.locator('#post-add').click();
  await page.locator('#creation-add-files').click();const chooser=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:'Folder…',exact:true}).click();await (await chooser).setFiles(folder);
  await expect(page.locator('#creation-entries')).toContainText('VALID.TORRENT');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
  const id=new URL(page.url()).hash.split('/')[2],get=()=>app.api('/api/creation',{action:'get_draft',id});
  let d=await get();expect(d.draft.pages[0].entries.find((e:any)=>e.kind==='torrent').original.path).toEqual(['bundle','nested','VALID.TORRENT']);
  await page.locator('#creation-regular').check();await expect(page.locator('#creation-add-files')).toBeEnabled();
  await page.locator('#creation-add-files-files').setInputFiles({name:'bad.torrent',mimeType:'application/x-bittorrent',buffer:Buffer.from('bad')});await expect(page.locator('#creation-entries')).toContainText('bad.torrent');await expect(page.locator('#creation-status')).toHaveText('Draft saved');
  d=await get();await page.locator('#creation-post').click();await expect(page.locator('#creation-error')).toContainText('Invalid .torrent');await expect(page.locator('#creation-regular')).toBeChecked();expect(await get()).toEqual(d);
 }finally{await cleanup(root,app);}
});

test('file import completes on its original draft after internal navigation',async({page})=>{
 const root=await temporary();let app:any,release:(()=>void)|undefined;
 try{
  app=await startApp(join(root,'app'));await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();const original=new URL(page.url()).hash.split('/')[2];
  let ready:()=>void;const waiting=new Promise<void>(resolve=>ready=resolve);
  await page.route('**/api/file-imports/*/0',async route=>{await new Promise<void>(resolve=>{release=resolve;ready();});await route.continue();});
  await page.locator('#creation-add-files-files').setInputFiles({name:'background.txt',mimeType:'text/plain',buffer:Buffer.from('background')});await waiting;await expect(page.locator('#creation-submit')).toHaveAttribute('aria-label','Cancel');
  await page.locator('#post-add').click();await expect.poll(()=>new URL(page.url()).hash.split('/')[2]).not.toBe(original);const newer=new URL(page.url()).hash.split('/')[2];release!();
  await expect.poll(async()=> (await app.api('/api/creation',{action:'get_draft',id:original})).draft.pages[0].entries.length).toBe(1);
  expect((await app.api('/api/creation',{action:'get_draft',id:newer})).draft.pages[0].entries).toEqual([]);await expect(page.locator('#creation-entries')).toContainText('No items');
 }finally{release?.();await cleanup(root,app);}
});

test('the primary Cancel aborts a file import and preserves the previous draft',async({page})=>{
 const root=await temporary();let app:any,release:(()=>void)|undefined;
 try{
  app=await startApp(join(root,'app'));await page.goto(app.url);await page.locator('#post-add').click();await expect(page.locator('#creation-view')).toBeVisible();const id=new URL(page.url()).hash.split('/')[2],before=await app.api('/api/creation',{action:'get_draft',id});
  let ready:()=>void;const waiting=new Promise<void>(resolve=>ready=resolve);
  await page.route('**/api/file-imports/*/0',async route=>{await new Promise<void>(resolve=>{release=resolve;ready();});try{await route.continue();}catch{}});
  await page.locator('#creation-add-files-files').setInputFiles({name:'cancel.txt',mimeType:'text/plain',buffer:Buffer.from('cancel')});await waiting;await expect(page.locator('#creation-submit')).toHaveAttribute('aria-label','Cancel');await page.locator('#creation-submit').click();
  await expect(page.locator('#creation-submit')).toHaveAttribute('aria-label','OK');release!();await expect(page.locator('#creation-entries')).toContainText('No items');expect(await app.api('/api/creation',{action:'get_draft',id})).toEqual(before);
 }finally{release?.();await cleanup(root,app);}
});
