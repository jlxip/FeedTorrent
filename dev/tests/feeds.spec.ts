import {expect, test} from '@playwright/test';
import {join} from 'node:path';

import {feedFixture} from './feed-fixtures.mjs';
import {cleanup, startApp, temporary, wait} from './helpers.mjs';

test(
    'follow real feed, catalog item, settings, 320px, reload and Unfollow',
    async ({page, browser}, info) => {
      const root = await temporary();
      let app, fx;
      try {
        fx = await feedFixture(root);
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
        await page.locator('#magnet').fill(fx.feedMagnet);
        await page.locator('#magnet-form button[type=submit]').click();
        await expect(page.locator('#feed-dialog')).toBeVisible();
        await expect(page.locator('#feed-mode')).toHaveValue('current_catalog');
        await expect(page.locator('#feed-limit')).toHaveValue('8');
        await expect(page.locator('#feed-magnet')).toBeFocused();
        await page.locator('#feed-name').fill('My reading list');
        await page.locator('#feed-mode').selectOption('mirror_catalogs');
        await page.locator('#feed-limit').fill('13');
        for (const dismissal of ['outside', 'cross', 'escape']) {
          if (dismissal === 'outside') await page.mouse.click(2, 2);
          else if (dismissal === 'cross') await page.locator('#feed-dialog [data-close]').click();
          else await page.keyboard.press('Escape');
          await expect(page.locator('#feed-dialog')).toBeHidden();
          await page.locator('#follow-open').click();
          await expect(page.locator('#feed-magnet')).toHaveValue(fx.feedMagnet);
          await expect(page.locator('#feed-name')).toHaveValue('My reading list');
          await expect(page.locator('#feed-mode')).toHaveValue('mirror_catalogs');
          await expect(page.locator('#feed-limit')).toHaveValue('13');
        }
        await page.locator('#feed-mode').selectOption('current_catalog');
        await page.locator('#feed-limit').fill('8');
        await page.locator('#feed-submit').click();
        await expect(page.locator('#feed-dialog')).not.toBeVisible();
        await expect(page.locator('#open-dialog')).not.toBeVisible();
        await expect(page.locator('#feed-title')).toHaveText('My reading list');
        await expect(page.locator('#transfers-nav')).toHaveAttribute('aria-current','false');
        await page.locator('#follow-open').click();
        await expect(page.locator('#feed-magnet')).toHaveValue('');
        await expect(page.locator('#feed-name')).toHaveValue('');
        await expect(page.locator('#feed-mode')).toHaveValue('current_catalog');
        await expect(page.locator('#feed-limit')).toHaveValue('8');
        await page.locator('#feed-name').fill('Unsent next feed');
        await page.mouse.click(2, 2);
        await expect(page.locator('#feed-dialog')).toBeHidden();
        await expect(page.locator('.catalog-row')).toHaveCount(3);
        await expect(page.locator('.catalog-row').first()).toContainText('Torrent');
        await expect(page.locator('.catalog-row').first().getByRole('button', {
          name: 'Download',
          exact: true
        })).toBeVisible();
        expect(fx.contentRequests).toBe(0);
        await page.locator('.entry-name').first().click();
        await expect(page.locator('#entry-detail')).toBeVisible();
        await expect(page.locator('#entry-detail .file')).toHaveCount(3);
        await page.locator('#feed-settings').click();
        await expect(page.locator('#feed-unfollow')).toHaveAttribute('data-variant','destructive');
        await page.locator('#feed-name').fill('Pending settings');
        await page.locator('#feed-mode').selectOption('mirror_catalogs');
        await page.locator('#feed-limit').fill('17');
        await page.mouse.click(2, 2);
        await expect(page.locator('#feed-dialog')).toBeHidden();
        expect((await app.api()).feeds[0].local_name).toBe('My reading list');
        await page.locator('#feed-settings').click();
        await expect(page.locator('#feed-name')).toHaveValue('Pending settings');
        await expect(page.locator('#feed-mode')).toHaveValue('mirror_catalogs');
        await expect(page.locator('#feed-limit')).toHaveValue('17');
        await page.locator('#feed-name').fill('My reading list');
        await page.locator('#feed-mode').selectOption('current_catalog');
        await page.locator('#feed-limit').fill('8');
        await page.getByRole('button', {name: 'About download mode'}).focus();
        await expect(page.locator('#feed-mode-help')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#feed-mode-help')).not.toBeVisible();
        await expect(page.locator('#feed-dialog')).toBeVisible();
        await page.locator('#feed-unlimited').check();
        await expect(page.locator('#feed-limit')).toBeDisabled();
        await page.locator('#feed-submit').click();
        await expect(page.locator('#feed-dialog')).toBeHidden();
        await page.locator('#follow-open').click();
        await expect(page.locator('#feed-name')).toHaveValue('Unsent next feed');
        await expect(page.locator('#feed-magnet')).toHaveValue('');
        await page.mouse.click(2, 2);
        await page.setViewportSize({width: 320, height: 740});
        await expect
            .poll(
                () => page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
        await page.screenshot({path: info.outputPath('feed-320.png'), fullPage: true});
        await page.locator('#feed-settings').click();
        await expect(page.locator('#feed-name')).toHaveValue('My reading list');
        await expect(page.locator('#feed-mode')).toHaveValue('current_catalog');
        await expect
            .poll(
                () => page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth))
            .toBe(true);
        await page.getByRole('button', {name: 'About automatic download limit'}).click();
        await expect(page.locator('#feed-limit-help')).toBeVisible();
        await page.screenshot(
            {path: info.outputPath('feed-settings-320.png'), fullPage: true});
        await page.keyboard.press('Escape');
        await page.locator('#feed-dialog [data-close]').click();
        await page.locator('.catalog-row')
            .first()
            .getByRole('button', {name: 'Download', exact: true})
            .click();
        await expect(page.locator('#transfer-view')).toBeVisible();
        await wait(
            async () =>
                (await app.api())
                    .transfers.find(t => t.id === fx.content.id && t.progress === 1),
            'real UI item download');
        await page.reload();
        await expect(page.locator('#count')).toHaveText('2 transfers');
        await page.locator('#sections-button').click();
        await page.locator(`#feed-nav [data-feed="${fx.feedId}"]`).click();
        await expect(page.locator('#feed-title')).toHaveText('My reading list');
        await page.locator('#feed-settings').click();
        await page.locator('#feed-mode').selectOption('mirror_all');
        await page.locator('#feed-submit').click();
        await expect(page.locator('#feed-status')).toContainText('Mirror all');
        const archive = await fx.catalog(
            'Archive', [{path: ['old.txt'], data: Buffer.from('archived item')}],
            {archive: 1});
        const revision = await fx.catalog(
            'Revision', [{path: ['new.txt'], data: Buffer.from('new revision')}], {
              prev: 'magnet:?xt=urn:btih:' + fx.head.id,
              'archive next': 'magnet:?xt=urn:btih:' + archive.id
            });
        await fx.publish(revision);
        await page.locator('#feed-settings').click();
        await page.locator('#feed-mode').selectOption('mirror_catalogs');
        await page.locator('#feed-submit').click();
        await page.locator('#feed-refresh').click();
        await expect(page.locator('#catalog-entries')).toContainText('new.txt');
        await page.getByRole('button', {name: 'Archive', exact: true}).click();
        await expect(page.locator('#catalog-entries')).toContainText('old.txt');
        await page.getByRole('button', {name: 'Current catalog', exact: true}).click();
        await expect(page.locator('#catalog-entries')).toContainText('new.txt');
        await page.getByRole('button', {name: 'Previous catalog', exact: true}).click();
        await expect(page.locator('.catalog-row')).toHaveCount(3);
        await page.locator('#feed-settings').click();
        await page.locator('#feed-unfollow').click();
        await expect(page.locator('#transfer-view')).toBeVisible();
        await expect(page.locator('#count')).toHaveText('4 transfers');
        expect(external).toEqual([]);
      } finally {
        if (app) await app.stop();
        if (fx) await fx.stop();
        await cleanup(root)
      }
    });
