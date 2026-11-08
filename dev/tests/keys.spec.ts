import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {cleanup,startApp,temporary} from './helpers.mjs';
import {decryptVault} from './key-vault-fixture.mjs';

test('Manage keys is visible, preserves passwords only during submission, and changes the same identity once',async({page},info)=>{
 const root=await temporary();let app;
 try{
  app=await startApp(join(root,'app'));const password='UI original key password',next='UI replacement key password';
  await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const file=join(root,'app/state/publishing/library.json'),before=await readFile(file),original=JSON.parse(before.toString()),seed=decryptVault(original.vault,password);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(app.url);
  await page.getByRole('button',{name:'Settings',exact:true}).click();const manage=page.getByRole('button',{name:'Manage keys',exact:true});
  await expect(manage).toHaveAttribute('data-variant','outline');await expect.poll(async()=>(await manage.boundingBox())?.height||0).toBeGreaterThanOrEqual(44);const box=(await manage.boundingBox())!;const parent=(await page.locator('#settings-form').boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(parent.width-1);
  await manage.click();await expect(page.getByRole('heading',{name:'Manage keys',exact:true})).toBeVisible();
  const old=page.locator('#own-old-password'),fresh=page.locator('#own-new-password'),confirm=page.locator('#own-confirm-password'),submit=page.locator('#own-password-form button');
  await old.fill('incorrect');await fresh.fill(next);await confirm.fill(next);await submit.click();await expect(page.locator('#own-password-error')).toContainText('Incorrect password');expect(await readFile(file)).toEqual(before);for(const field of [old,fresh,confirm])await expect(field).toHaveValue('');
  await old.fill(password);await fresh.fill(next);await confirm.fill('mismatch');await submit.click();await expect(page.locator('#own-password-error')).toContainText('match');await expect(confirm).toHaveAttribute('aria-invalid','true');expect(await readFile(file)).toEqual(before);
  let requests=0;await page.route('**/api/publishing',async route=>{if(route.request().postDataJSON().action==='change_password'){requests++;await new Promise(r=>setTimeout(r,500));}await route.continue();});
  await old.fill(password);await fresh.fill(next);await confirm.fill(next);await submit.click();await expect(submit).toBeDisabled();await page.locator('#own-password-form').evaluate((f:HTMLFormElement)=>f.requestSubmit());
  await expect(page.locator('#own-keys-status')).toHaveText('Password changed');expect(requests).toBe(1);await expect(submit).toBeEnabled();for(const field of [old,fresh,confirm])await expect(field).toHaveValue('');await expect(confirm).not.toHaveAttribute('aria-invalid','true');
  const changed=JSON.parse((await readFile(file)).toString());expect(changed.vault.public_key).toBe(original.vault.public_key);expect(decryptVault(changed.vault,next)).toEqual(seed);expect(()=>decryptVault(changed.vault,password)).toThrow();seed.fill(0);
  for(const width of [1280,320])for(const theme of ['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`keys-${width}-${theme}.png`),animations:'disabled'});}
  await old.fill(next);await fresh.fill('discard');await confirm.fill('discard');await page.locator('#publishing-keys-dialog [data-close]').click();await expect(page.locator('#publishing-keys-dialog')).toBeHidden();for(const field of [old,fresh,confirm])await expect(field).toHaveValue('');
  await manage.click();await old.fill(next);await page.mouse.click(2,2);await expect(page.locator('#publishing-keys-dialog')).toBeHidden();await expect(old).toHaveValue('');
  expect(errors).toEqual([]);expect(app.logs).not.toContain(password);expect(app.logs).not.toContain(next);
 }finally{await cleanup(root,app);}
});

test('Manage keys exports both encrypted backups and imports with the matching password',async({page})=>{
 const root=await temporary();let app,restored;
 try{
  app=await startApp(join(root,'publisher'));const password='UI backup key password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  await page.goto(app.url);await page.locator('#settings-open').click();await page.getByRole('button',{name:'Manage keys',exact:true}).click();
  let backup:Buffer|undefined;
  for(const id of ['own-export-keys','own-export-full']){const download=page.waitForEvent('download');await page.locator('#'+id).click();const file=await download;expect(file.suggestedFilename()).toMatch(/\.tar$/);const bytes=await readFile((await file.path())!);expect(bytes.length).toBeGreaterThan(0);if(id==='own-export-full')backup=bytes;}
  restored=await startApp(join(root,'restored'));await page.goto(restored.url);await page.locator('#settings-open').click();await page.getByRole('button',{name:'Manage keys',exact:true}).click();
  await page.locator('#own-import-file').setInputFiles({name:'publishing.tar',mimeType:'application/x-tar',buffer:backup!});await page.locator('#own-import-password').fill('incorrect');await page.locator('#own-import-form button').click();await expect(page.locator('#own-import-error')).toContainText('Incorrect password');expect((await restored.api()).publishing.has_key).toBe(false);await expect(page.locator('#own-import-password')).toHaveValue('');
  await page.locator('#own-import-password').fill(password);await page.locator('#own-import-form button').click();await expect(page.locator('#own-keys-status')).toContainText('Backup restored');await expect(page.locator('#own-import-password')).toHaveValue('');
  await expect.poll(async()=>(await restored.api()).publishing.public_key).toBe((await app.api()).publishing.public_key);
  const original=JSON.parse((await readFile(join(root,'publisher/state/publishing/library.json'))).toString()),copy=JSON.parse((await readFile(join(root,'restored/state/publishing/library.json'))).toString());expect(decryptVault(copy.vault,password)).toEqual(decryptVault(original.vault,password));
 }finally{await cleanup(root,app,restored);}
});
