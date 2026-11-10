import {expect, test} from '@playwright/test';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';

import {postFixture} from './post-fixtures.mjs';
import {cleanup, startApp, temporary, wait} from './helpers.mjs';

test(
    'follow real post, catalog item, settings, 320px, reload and Unfollow',
    async ({page, browser}, info) => {
      const root = await temporary();
      let app, fx;
      try {
        fx = await postFixture(root);
        const nextMagnet='magnet:?xs=urn:btpk:'+generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
        app = await startApp(join(root, 'app'), ['--dht-bootstrap', fx.bootstrap]);
        console.log(info.project.name, browser.version());
        await info.attach(
            'browser-version', {body: browser.version(), contentType: 'text/plain'});
        const external: string[] = [];
        page.on('request', r => {
          if (!r.url().startsWith(app.url)) external.push(r.url());
        });
        await page.goto(app.url);
        await expect(page.locator('#open-button')).toBeEnabled();
        await page.locator('#open-button').click();
        await page.locator('#magnet').fill(fx.postMagnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#post-dialog')).toBeVisible();
        await expect(page.locator('#post-mode')).toHaveValue('current_catalog');
        await expect(page.locator('#post-limit')).toHaveValue('8');

        await page.locator('#post-name').fill('My reading list');
        await page.locator('#post-mode').selectOption('mirror_catalogs');
        await page.locator('#post-limit').fill('13');
        for (const dismissal of ['outside', 'cross']) {
          if (dismissal === 'outside') await page.mouse.click(2, 2);
          else if (dismissal === 'cross') await page.locator('#post-dialog [data-close]').click();
          await expect(page.locator('#post-dialog')).toBeHidden();
          await page.locator('#open-button').click();
          await page.locator('#magnet').fill(fx.postMagnet);
          await page.locator('#magnet-form button[type=submit]').click();
          await expect(page.locator('#post-magnet')).toHaveValue(fx.postMagnet);
          await expect(page.locator('#post-name')).toHaveValue('My reading list');
          await expect(page.locator('#post-mode')).toHaveValue('mirror_catalogs');
          await expect(page.locator('#post-limit')).toHaveValue('13');
        }
        await page.locator('#post-mode').selectOption('current_catalog');
        await page.locator('#post-limit').fill('8');
        await page.locator('#post-submit').click();
        await expect(page.locator('#post-dialog')).not.toBeVisible();
        await expect(page.locator('#open-dialog')).not.toBeVisible();
        await expect(page.locator('#post-title')).toHaveText('My reading list');
        await expect(page.locator('#transfers-nav')).toHaveAttribute('aria-current','false');
        await page.locator('#open-button').click();
        await page.locator('#magnet').fill(fx.postMagnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#post-dialog')).toBeHidden();
        await expect(page.locator('#post-title')).toHaveText('My reading list');
        await page.locator('#open-button').click();
        await page.locator('#magnet').fill(nextMagnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#post-magnet')).toHaveValue(nextMagnet);
        await expect(page.locator('#post-name')).toHaveValue('');
        await expect(page.locator('#post-mode')).toHaveValue('current_catalog');
        await expect(page.locator('#post-limit')).toHaveValue('8');
        await page.locator('#post-name').fill('Unsent next post');
        await page.mouse.click(2, 2);
        await expect(page.locator('#post-dialog')).toBeHidden();
        await expect(page.locator('.catalog-row')).toHaveCount(3);
        await expect(page.locator('.catalog-row').first()).toContainText('source');
        await expect(page.locator('.catalog-row').first().getByRole('button', {
          name: 'Download',
          exact: true
        })).toBeVisible();
        const indexed=await app.command({type:'catalog_page',post:fx.postId,catalog:fx.head.id,offset:0});
        expect(indexed.entries[0].source_name).toBe('film.torrent');
        expect(indexed.entries[0].name).toBe('source');
        expect(fx.contentRequests).toBe(0);
        await expect(page.locator('#entry-detail')).toHaveCount(0);
        await page.locator('#post-settings').click();
        await expect(page.locator('#post-unfollow')).toHaveAttribute('data-variant','destructive');
        await page.locator('#post-name').fill('Pending settings');
        await page.locator('#post-mode').selectOption('mirror_catalogs');
        await page.locator('#post-limit').fill('17');
        await page.mouse.click(2, 2);
        await expect(page.locator('#post-dialog')).toBeHidden();
        expect((await app.api()).posts[0].local_name).toBe('My reading list');
        await page.locator('#post-settings').click();
        await expect(page.locator('#post-name')).toHaveValue('Pending settings');
        await expect(page.locator('#post-mode')).toHaveValue('mirror_catalogs');
        await expect(page.locator('#post-limit')).toHaveValue('17');
        await page.locator('#post-name').fill('My reading list');
        await page.locator('#post-mode').selectOption('current_catalog');
        await page.locator('#post-limit').fill('8');
        await page.getByRole('button', {name: 'About download mode'}).hover();
        await expect(page.locator('#post-mode-help')).toBeVisible();
        await page.locator('#post-dialog-title').click();
        await expect(page.locator('#post-mode-help')).not.toBeVisible();
        await expect(page.locator('#post-dialog')).toBeVisible();
        await page.locator('#post-unlimited').check();
        await expect(page.locator('#post-limit')).toBeDisabled();
        await page.locator('#post-submit').click();
        await expect(page.locator('#post-dialog')).toBeHidden();
        await page.locator('#open-button').click();
        await page.locator('#magnet').fill(nextMagnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#post-name')).toHaveValue('Unsent next post');
        await expect(page.locator('#post-magnet')).toHaveValue(nextMagnet);
        await page.mouse.click(2, 2);
        await page.setViewportSize({width: 320, height: 740});
        await expect
            .poll(
                () => page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
        await page.screenshot({path: info.outputPath('post-320.png'), fullPage: true});
        await page.locator('#post-settings').click();
        await expect(page.locator('#post-name')).toHaveValue('My reading list');
        await expect(page.locator('#post-mode')).toHaveValue('current_catalog');
        await expect
            .poll(
                () => page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
        await page.getByRole('button', {name: 'About automatic download limit'}).click();
        await expect(page.locator('#post-limit-help')).toBeVisible();
        await page.screenshot(
            {path: info.outputPath('post-settings-320.png'), fullPage: true});
        await page.locator('#post-dialog-title').click();
        await page.locator('#post-dialog [data-close]').click();
        await page.locator('.catalog-row')
            .first()
            .getByRole('button', {name: 'Download', exact: true})
            .click();
        await expect(page.locator('#post-view')).toBeVisible();
        await wait(
            async () =>
                (await app.api())
                    .transfers.find(t => t.id === fx.content.id && t.progress === 1),
            'real UI item download');
        await page.reload();
        await expect(page.locator('#post-view')).toBeVisible();
        await page.locator('.catalog-row').first().getByRole('link').click();
        await expect(page).toHaveURL(new RegExp('#/posts/'+fx.postId+'/'+fx.head.id+'/torrent/'+fx.content.id+'$'));
        await expect(page.locator('#post-reader .content-heading')).toBeVisible();
        await page.locator('#sections-button').click();
        await page.locator(`#post-tree [data-post="${fx.postId}"]`).click();
        await expect(page.locator('#post-title')).toHaveText('My reading list');
        await page.locator('#post-settings').click();
        await page.locator('#post-mode').selectOption('mirror_all');
        await page.locator('#post-submit').click();
        await expect(page.locator('#post-help')).toContainText('Mirror all');
        const archive = await fx.catalog(
            'Archive', [{path: ['old.txt'], data: Buffer.from('archived item')}],
            {archive: 1});
        const revision = await fx.catalog(
            'Revision', [{path: ['new.txt'], data: Buffer.from('new revision')}], {
              prev: 'magnet:?xt=urn:btih:' + fx.head.id,
              'archive next': 'magnet:?xt=urn:btih:' + archive.id
            });
        await fx.publish(revision);
        await page.locator('#post-settings').click();
        await page.locator('#post-mode').selectOption('mirror_catalogs');
        await page.locator('#post-submit').click();
        await page.locator('#post-refresh').click();
        await page.locator('#post-open-latest').click();
        await expect(page.locator('#post-reader .reader-entries')).toContainText('new.txt');
        await page.locator('#post-history summary').click();
        await page.getByRole('link', {name: 'Archive', exact: true}).click();
        await expect(page.locator('#post-reader .reader-entries')).toContainText('old.txt');
        await page.locator('#post-open-latest').click();
        await expect(page.locator('#post-reader .reader-entries')).toContainText('new.txt');
        await page.locator('#post-history summary').click();
        await page.getByRole('link', {name: 'Previous version', exact: true}).click();
        await expect(page.locator('.catalog-row')).toHaveCount(3);
        await page.locator('#post-settings').click();
        await page.locator('#post-unfollow').click();
        await page.locator('#post-remove-submit').click();
        await expect(page.locator('#transfer-view')).toBeVisible();
        await expect(page.locator('#count')).toHaveText('0 torrents');
        await page.locator('#open-button').click();
        await page.locator('#magnet').fill(fx.content.magnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#post-dialog')).toBeHidden();
        await expect(page.locator('#count')).toHaveText('1 torrent');
        expect(external).toEqual([]);
      } finally {
        if (app) await app.stop();
        if (fx) await fx.stop();
        await cleanup(root)
      }
    });
