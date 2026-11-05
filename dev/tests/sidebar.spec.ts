import {expect, test} from '@playwright/test';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {cleanup, startApp, temporary} from './helpers.mjs';

test('Sidebar navigation, mobile overlay, focus, Escape and breakpoint resize', async ({page, browser}, info) => {
  const root = await temporary();
  let app;
  try {
    app = await startApp(join(root, 'app'));
    console.log(info.project.name, browser.version());
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {if (!r.url().startsWith(app.url)) external.push(r.url());});
    const key = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    await app.command({type:'follow_feed', uri:'magnet:?xs=urn:btpk:'+key, config:{name:'Reading list', mode:'current_catalog', automatic_limit:8388608}});
    const password = 'isolated UI test password';
    await app.api('/api/publishing', {action:'create_key',password,confirmation:password});
    await app.api('/api/publishing', {action:'create_feed',title:'Field notes'});
    await page.setViewportSize({width:1024,height:740});
    await page.goto(app.url);
    const sidebar = page.locator('#sidebar'), toggle = page.locator('#sections-button');
    const nav = sidebar.locator('nav'), selected = sidebar.locator('a[aria-current="page"]');
    await expect(page.locator('#own-nav a')).toHaveText('Field notes');
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
    await expect(sidebar.locator('ul > li > a')).toHaveCount(4);
    for (const link of ['#new-nav','#feed-nav a','#own-nav a','#transfers-nav']) {
      await page.locator(link).click();
      await expect(selected).toHaveCount(1);
      await expect(page.locator(link)).toHaveAttribute('aria-current','page');
    }
    await page.setViewportSize({width:768,height:740});
    await expect(toggle).toBeHidden();
    await expect(sidebar).toHaveAttribute('aria-hidden','false');
    await page.locator('#open-button').focus();
    await page.setViewportSize({width:767,height:740});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.locator('#open-button')).toBeFocused();
    await expect(toggle).toBeVisible();
    await expect(sidebar).toHaveAttribute('aria-hidden','true');
    await expect(sidebar).toHaveAttribute('inert','');
    for (const width of [767,320]) {
      await page.setViewportSize({width,height:740});
      for (const close of ['escape','outside','cross','toggle','same route']) {
        await toggle.click();
        await expect(sidebar).toHaveAttribute('aria-hidden','false');
        await expect(toggle).toHaveAttribute('aria-expanded','true');
        await expect(page.locator('.workspace > main')).toHaveAttribute('inert','');
        await expect(page.locator('#new-nav')).toBeFocused();
        // Tab stays in the overlay and its Sections toggle.
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(toggle).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(page.locator('#own-nav a')).toBeFocused();
        const box = (await nav.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(width-32+0.5);
        if (close==='escape') await page.keyboard.press('Escape');
        else if (close==='outside') await page.mouse.click(width-4,box.y+100);
        else if (close==='cross') await sidebar.getByRole('button',{name:'Close sections'}).click();
        else if (close==='toggle') await toggle.click();
        else await page.locator('#transfers-nav').click();
        await expect(sidebar).toHaveAttribute('aria-hidden','true');
        await expect(toggle).toHaveAttribute('aria-expanded','false');
        await expect(toggle).toBeFocused();
        await expect(page.locator('.workspace > main')).not.toHaveAttribute('inert','');
      }
      // Native navigation closes for both followed and owned feeds.
      for (const link of ['#new-nav','#feed-nav a','#own-nav a','#transfers-nav']) {
        await toggle.click();
        await page.locator(link).click();
        await expect(sidebar).toHaveAttribute('aria-hidden','true');
        await expect(toggle).toBeFocused();
        await expect(selected).toHaveCount(1);
        await expect(page.locator(link)).toHaveAttribute('aria-current','page');
      }
      // A sidebar action opens its dialog without focus being stolen by the close adaptation.
      await toggle.click();
      await page.locator('#follow-open').click();
      await expect(sidebar).toHaveAttribute('aria-hidden','true');
      await expect(page.locator('#feed-magnet')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.locator('#own-create').click();
      await expect(page.locator('#own-create-dialog')).toBeVisible();
      await expect(page.locator('#own-create-title')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(toggle).toBeFocused();
      await page.locator('#settings-open').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#download-dir')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#settings-open')).toBeFocused();
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
    await expect(page.locator('#follow-open')).toBeDisabled();
    await expect(page.locator('#own-create')).toBeDisabled();
    await page.locator('#transfers-nav').click();
    await expect(sidebar).toHaveAttribute('aria-hidden','true');
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {await cleanup(root, app);}
});
