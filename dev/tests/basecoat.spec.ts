import {expect, test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup, startApp, temporary} from './helpers.mjs';

test('native removal surface, inline failure, progress accessibility and mobile CSP', async ({page, browserName}) => {
  const root = await temporary(); let app;
  try {
    app = await startApp(join(root, 'app'));
    const id = 'a'.repeat(40);
    await app.command({type:'add_magnet', uri:'magnet:?xt=urn:btih:'+id});
    const errors: string[] = [], csp: string[] = [], external: string[] = [];
    const nativeSelectWarnings: string[] = [];
    if (browserName === 'webkit') {
      // WebKit 27.2 checks its own native select styles against CSP:
      // https://github.com/microsoft/playwright/issues/43497
      // Measure that exact warning on a page without application CSS/JS;
      // a deliberate violation must still produce an additional failure.
      const control = await page.context().newPage();
      try {
        const response = await page.request.get(app.url);
        const policy = response.headers()['content-security-policy'];
        const metaPolicy = (await response.text()).match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)![1];
        const messages: string[] = [];
        control.on('console', m => {if (/content security|refused to/i.test(m.text())) messages.push(m.text());});
        const url = app.url + '/native-select-csp-control';
        await control.route(url, route => route.fulfill({contentType:'text/html',
          headers:{'Content-Security-Policy':policy},
          body:`<!doctype html><meta http-equiv="Content-Security-Policy" content="${metaPolicy}"><select><option>Native</option></select>`}));
        const settle = () => control.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await control.goto(url);await settle();
        nativeSelectWarnings.push(...messages);
        await control.evaluate(() => {const e=document.createElement('p');e.setAttribute('style','color:red');document.body.append(e);});
        await settle();
        expect(messages.length).toBeGreaterThan(nativeSelectWarnings.length);
      } finally {await control.close();}
    }
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {if (/content security|refused to/i.test(m.text())) csp.push(m.text());});
    page.on('request', r => {if (!r.url().startsWith(app.url)) external.push(r.url());});
    await page.goto(app.url);
    const row = page.locator(`[data-id="${id}"]`), progress = row.getByRole('progressbar');
    await expect(progress).toHaveAttribute('aria-valuemin','0');
    await expect(progress).toHaveAttribute('aria-valuemax','1');
    await expect(progress).toHaveAttribute('aria-valuenow','0');
    await expect(progress).toHaveAccessibleName(/download progress/);
    await row.getByRole('button',{name:'Remove',exact:true}).click();
    const dialog = page.locator('#remove-dialog'), surface = dialog.locator(':scope > .dialog-surface');
    await page.route('**/api/commands', async route => {
      if (route.request().postDataJSON()?.type === 'remove') await route.fulfill({status:503,json:{error:'Removal refused by test'}});
      else await route.continue();
    });
    await page.locator('#delete-files').check();
    await dialog.getByRole('button',{name:'Remove',exact:true}).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#remove-error')).toContainText('Removal refused by test');
    await expect(page.locator('#delete-files')).toBeChecked();
    await page.unroute('**/api/commands');
    await page.keyboard.press('Escape');
    await row.getByRole('button',{name:'Remove',exact:true}).click();
    await expect(page.locator('#delete-files')).not.toBeChecked();
    await expect(page.locator('#remove-error')).toBeEmpty();
    const bounds = (await surface.boundingBox())!;
    await page.mouse.click(bounds.x+8,bounds.y+8);
    await expect(dialog).toBeVisible();
    const title = (await page.locator('#remove-title').boundingBox())!;
    await page.mouse.move(title.x+5,title.y+5);await page.mouse.down();await page.mouse.move(2,2);await page.mouse.up();
    await expect(dialog).toBeVisible();
    await page.mouse.click(2,2);await expect(dialog).toBeHidden();
    await page.setViewportSize({width:320,height:740});
    await page.emulateMedia({colorScheme:'dark'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for (const asset of ['basecoat.css','basecoat-runtime.js','basecoat-tabs.js','basecoat-sidebar.js'])
      expect((await page.request.get(app.url+'/'+asset)).status()).toBe(200);
    expect(errors).toEqual([]);expect(csp).toEqual(nativeSelectWarnings);expect(external).toEqual([]);
  } finally {await cleanup(root, app);}
});

test('feed field errors, native nested key forms, secret cleanup and breadcrumb navigation', async ({page}) => {
  const root = await temporary();let app;
  try {
    app = await startApp(join(root,'app'));
    await page.goto(app.url);
    await expect(page.locator('#follow-open')).toBeEnabled();
    await page.locator('#follow-open').click();
    await page.locator('#feed-limit').fill('0');
    await page.locator('#feed-submit').click();
    await expect(page.locator('#feed-limit')).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#feed-limit')).toHaveAttribute('aria-describedby',/follow-error/);
    await page.locator('#feed-unlimited').check();
    await expect(page.locator('#feed-limit')).toBeDisabled();
    await expect(page.locator('#feed-limit')).not.toHaveAttribute('aria-invalid','true');
    await page.locator('#feed-dialog [data-close]').click();
    await page.locator('#own-create').click();
    await page.locator('#own-create-title').fill('Integration feed');
    const password = 'native UI integration passphrase';
    await page.locator('#own-key-password').fill(password);
    await page.locator('#own-key-confirm').fill('different passphrase');
    await page.locator('#own-create-submit').click();
    await expect(page.locator('#own-create-error')).toContainText('Passwords do not match');
    await expect(page.locator('#own-key-confirm')).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#own-key-password')).toHaveValue('');
    await page.locator('#own-key-password').fill(password);await page.locator('#own-key-confirm').fill(password);
    await page.locator('#own-create-submit').click();
    await expect(page.locator('#own-create-dialog')).toBeHidden();
    await page.locator('#own-new-page').click();
    await page.locator('#own-title').fill('Child page');
    await expect(page.locator('#own-breadcrumb [aria-current=page]')).toHaveText('Child page');
    await page.locator('#own-breadcrumb').getByRole('button',{name:'Integration feed',exact:true}).click();
    await expect(page.locator('#own-title')).toHaveValue('Integration feed');
    await page.locator('#settings-open').click();
    await page.locator('#publishing-keys-open').click();
    await page.setViewportSize({width:320,height:740});
    const keys = page.locator('#publishing-keys-dialog');
    await page.locator('#own-import-file').setInputFiles({name:'invalid.tar',mimeType:'application/x-tar',buffer:Buffer.from('not an archive')});
    await page.locator('#own-import-password').fill(password);
    await page.locator('#own-import-form').getByRole('button',{name:'Import',exact:true}).click();
    await expect(page.locator('#own-import-error')).not.toBeEmpty();
    await expect(page.locator('#own-import-password')).toHaveValue('');
    await page.locator('#own-old-password').fill(password);await page.locator('#own-new-password').fill('another passphrase');await page.locator('#own-confirm-password').fill('mismatch');
    await page.locator('#own-password-form').getByRole('button',{name:'Change password',exact:true}).click();
    await expect(page.locator('#own-password-error')).toContainText('Passwords do not match');
    await expect(page.locator('#own-confirm-password')).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#own-old-password')).toHaveValue('');
    await expect.poll(async () => (await app.api()).publishing.feeds.length).toBe(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.keyboard.press('Escape');await expect(keys).toBeHidden();await expect(page.locator('#settings-dialog')).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.locator('#settings-dialog')).toBeHidden();
  } finally {await cleanup(root,app);}
});
