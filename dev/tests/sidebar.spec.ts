import {expect, test} from '@playwright/test';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {cleanup, startApp, temporary} from './helpers.mjs';

test('Sidebar navigation, mobile overlay and breakpoint resize', async ({page, browser}, info) => {
  const root = await temporary();
  let app;
  try {
    app = await startApp(join(root, 'app'));
    console.log(info.project.name, browser.version());
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {if (!r.url().startsWith(app.url)) external.push(r.url());});
    const key = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    await app.command({type:'follow_post', uri:'magnet:?xs=urn:btpk:'+key, config:{name:'Reading list', mode:'current_catalog', automatic_limit:8388608}});
    const password = 'isolated UI test password';
    await app.api('/api/publishing', {action:'create_key',password,confirmation:password});
    await app.api('/api/publishing', {action:'create_post',title:'Field notes'});
    await page.setViewportSize({width:1024,height:740});
    await page.goto(app.url);
    const sidebar = page.locator('#sidebar'), toggle = page.locator('#sections-button');
    const nav = sidebar.locator('nav'), selected = sidebar.locator('a[aria-current="page"]');
    await expect(page.locator('#post-tree a[data-kind=own]')).toHaveText('Field notes');
    await expect(sidebar).toHaveAttribute('data-sidebar-initialized','true');
    await expect(sidebar).toHaveAttribute('aria-hidden','false');
    await expect(toggle).toBeHidden();
    await expect.poll(async () => {
      const panel = (await nav.boundingBox())!, main = (await page.locator('.workspace > main').boundingBox())!;
      return main.x >= panel.x + panel.width - 0.5;
    }).toBe(true);
    await expect.poll(() => page.locator('#status').evaluate(e => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    })).toBe(true);
    await expect(sidebar.locator('#new-nav, #transfers-nav, .post-link')).toHaveCount(4);
    for (const link of ['#new-nav','#post-tree a[data-kind=followed]','#post-tree a[data-kind=own]','#transfers-nav']) {
      await page.locator(link).click();
      await expect(selected).toHaveCount(1);
      await expect(page.locator(link)).toHaveAttribute('aria-current','page');
    }
    await page.setViewportSize({width:768,height:740});
    await expect(toggle).toBeHidden();
    await expect(sidebar).toHaveAttribute('aria-hidden','false');
    await page.setViewportSize({width:767,height:740});

    await expect(toggle).toBeVisible();
    await expect(sidebar).toHaveAttribute('aria-hidden','true');
    await expect(sidebar).toHaveAttribute('inert','');
    for (const width of [767,320]) {
      await page.setViewportSize({width,height:740});
      for (const close of ['outside','cross','toggle','same route']) {
        await toggle.click();
        await expect(sidebar).toHaveAttribute('aria-hidden','false');
        await expect(toggle).toHaveAttribute('aria-expanded','true');
        await expect(page.locator('.workspace > main')).toHaveAttribute('inert','');

        const box = (await nav.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(width-32+0.5);
        if (close==='outside') await page.mouse.click(width-4,box.y+100);
        else if (close==='cross') await sidebar.getByRole('button',{name:'Close sections'}).click();
        else if (close==='toggle') await toggle.click();
        else await page.locator('#transfers-nav').click();
        await expect(sidebar).toHaveAttribute('aria-hidden','true');
        await expect(toggle).toHaveAttribute('aria-expanded','false');

        await expect(page.locator('.workspace > main')).not.toHaveAttribute('inert','');
      }
      // Native navigation closes for both followed and owned posts.
      for (const link of ['#new-nav','#post-tree a[data-kind=followed]','#post-tree a[data-kind=own]','#transfers-nav']) {
        await toggle.click();
        await page.locator(link).click();
        await expect(sidebar).toHaveAttribute('aria-hidden','true');

        await expect(selected).toHaveCount(1);
        await expect(page.locator(link)).toHaveAttribute('aria-current','page');
      }
      // Create opens a durable editor and dismisses the mobile overlay.
      await toggle.click();
      await page.locator('#post-add').click();
      await expect(sidebar).toHaveAttribute('aria-hidden','true');
      await expect(page.locator('#creation-view')).toBeVisible();
      await page.locator('#creation-delete').click();
      await expect(page.locator('#creation-view')).toBeHidden();

      await page.locator('#settings-open').click();
      await expect(page.locator('#settings-dialog')).toBeVisible();
      await page.locator('#settings-dialog [data-close]').click();

      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.setViewportSize({width:1024,height:740});
      await expect(sidebar).toHaveAttribute('aria-hidden','false');
      await expect(page.locator('.workspace > main')).not.toHaveAttribute('inert','');
      await expect(toggle).toBeHidden();
      await page.setViewportSize({width,height:740});
      await expect(sidebar).toHaveAttribute('aria-hidden','true');
    }
    const asset = await page.request.get(app.url+'/basecoat-sidebar.js');
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toContain('text/javascript');
    // Navigation and dismissal remain usable when application actions lose their connection.
    await app.stop();
    await expect(page.locator('#open-button')).toBeDisabled();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.locator('#post-add')).toBeDisabled();
    await page.locator('#transfers-nav').click();
    await expect(sidebar).toHaveAttribute('aria-hidden','true');

    await toggle.click();
    await toggle.click();

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {await cleanup(root, app);}
});
