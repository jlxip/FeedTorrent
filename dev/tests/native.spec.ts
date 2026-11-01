import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  temporary,
  startApp,
  seed,
  tracker,
  complete,
  exact,
  reverse,
  cleanup,
  wait,
} from "./helpers.mjs";
async function magnet(page, uri) {
  await page.locator("#open-button").click();
  await page.locator("#magnet").fill(uri);
  await page.locator("#magnet-form button[type=submit]").click();
  await expect(page.locator("#open-dialog")).not.toBeVisible();
}
async function remove(page, id, files = false) {
  await page.locator(`[data-id="${id}"] .danger`).click();
  await expect(page.locator("#delete-files")).not.toBeChecked();
  if (files) await page.locator("#delete-files").check();
  await page.locator("#remove-form button[type=submit]").click();
  await expect(page.locator(`[data-id="${id}"]`)).toHaveCount(0);
}
test("native torrent, exact files, reverse seeding, reload and multi-tab control", async ({
  page,
  context,
  browser,
}, info) => {
  const root = await temporary(),
    tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "seed"), [17001, 49101, 0], {
      tracker: true,
      announce: [tr.http],
    });
    app = await startApp(root);
    console.log(info.project.name, browser.version());
    await info.attach("browser-version", {
      body: browser.version(),
      contentType: "text/plain",
    });
    const external = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(app.url)) external.push(r.url());
    });
    await page.goto(app.url);
    await expect(page.locator("#settings-open")).toBeEnabled();
    await page.locator("#open-button").click();
    await page.getByRole("tab", { name: "Torrent file", exact: true }).click();
    const chooserEvent = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Choose file", exact: true })
      .click();
    const chooser = await chooserEvent;
    await chooser.setFiles({
      name: "fixture.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.from(ref.bytes),
    });
    await expect(page.locator("#torrent-name")).toHaveText("fixture.torrent");
    await page.locator("#torrent-form button[type=submit]").click();
    await expect(page.locator(".state")).toHaveText("Seeding · 100%");
    const t = await exact(app, ref);
    expect(t.files).toHaveLength(3);
    await page.locator(".transfer-name").click();
    await expect(page.locator(".file button").first()).toBeEnabled();
    await page.reload();
    await expect(page.locator(".state")).toHaveText("Seeding · 100%");
    const second = await context.newPage();
    await second.goto(app.url);
    await expect(second.locator(".state")).toHaveText("Seeding · 100%");
    await second.locator(".actions button").first().click();
    await expect(page.locator(".state")).toHaveText("Paused · 100%");
    await second.close();
    await page.locator(".actions button").first().click();
    await expect(page.locator(".state")).toHaveText("Seeding · 100%");
    await ref.stop();
    ref.stop = async () => {};
    await reverse(app, ref, root);
    await expect
      .poll(async () => (await app.api()).transfers[0].warning)
      .not.toMatch(/^Peer:/);
    await page.close();
    expect((await app.api()).transfers[0].state).toBe("Seeding");
    const last = await context.newPage();
    await last.goto(app.url);
    await expect(last.locator(".state")).toHaveText("Seeding · 100%");
    await remove(last, ref.id);
    expect(await readFile(join(t.save_path, t.files[0].name))).toHaveLength(
      ref.originals[0].length,
    );
    await app.command({ type: "add_torrent", data: ref.bytes });
    await complete(app, ref.id);
    await last.reload();
    await remove(last, ref.id, true);
    await expect
      .poll(async () => {
        try {
          await readFile(join(t.save_path, t.files[0].name));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(external).toEqual([]);
  } finally {
    await cleanup(root, tr, ref, app);
  }
});
test("magnet metadata, unlimited activity, errors, settings and compact layout", async ({
  page,
}) => {
  const root = await temporary(),
    tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "seed"), [33333], {
      tracker: true,
      announce: [tr.udp],
    });
    app = await startApp(root);
    await page.goto(app.url);
    await expect(page.locator("#settings-open")).toBeEnabled();
    await magnet(page, ref.magnet);
    await expect(page.locator(".state")).toHaveText("Seeding · 100%");
    await exact(app, ref);
    await page.locator("#open-button").click();
    await page.locator("#magnet").fill(ref.magnet);
    await page.locator("#magnet-form button[type=submit]").click();
    await expect(page.locator("#magnet-error")).toContainText("already exists");
    await page.locator("#open-dialog [data-close]").click();
    for (let i = 1; i <= 5; i++)
      await app.command({
        type: "add_magnet",
        uri: "magnet:?xt=urn:btih:" + i.toString(16).padStart(40, "0"),
      });
    await expect(page.locator(".transfer")).toHaveCount(6);
    expect((await app.api()).transfers.filter((t) => t.active)).toHaveLength(6);
    await expect(page.locator("#status")).toHaveText("6 active");
    const last = page.locator(".transfer").last();
    await last.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(last.locator(".state")).toContainText("Paused");
    await last.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(last.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    expect((await app.api()).transfers.filter((t) => t.active)).toHaveLength(6);
    await app.command({ type: "pause", id: "1".padStart(40, "0") });
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.locator("#settings-open").click();
    await expect(page.locator("#settings-form [title]")).toHaveCount(0);
    const folderHelp = page.getByRole("button", { name: "About download folder", exact: true });
    const folderTooltip = page.locator("#download-dir-help");
    await expect(folderHelp).toBeVisible();
    await expect(folderTooltip).toBeHidden();
    await folderHelp.hover();
    await expect(folderTooltip).toHaveText("Relative to server's working directory");
    await expect(folderTooltip).toBeVisible();
    const bounds = await folderTooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await page.locator("#download-dir").hover();
    await expect(folderTooltip).toBeHidden();
    await folderHelp.focus();
    await expect(folderTooltip).toBeVisible();
    await folderHelp.press("Escape");
    await expect(folderTooltip).toBeHidden();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await folderHelp.click();
    await expect(folderTooltip).toBeVisible();
    await page.locator("#download-dir").click();
    await expect(folderTooltip).toBeHidden();
    const portHelp = page.getByRole("button", { name: "About listening port", exact: true });
    await portHelp.focus();
    await expect(page.locator("#peer-port-help")).toHaveText("Requires a server restart");
    await expect(page.locator("#peer-port-help")).toBeVisible();
    await portHelp.press("Escape");
    await expect(page.locator("#settings-form .muted")).toHaveCount(0);
    await expect(page.locator("#seed-by-default")).toBeChecked();
    await page.locator("#seed-by-default").uncheck();
    await page.locator("#download-dir").fill(join(root, "changed"));
    await page.locator("#settings-form button[type=submit]").click();
    await expect(page.locator("#settings-dialog")).not.toBeVisible();
    expect((await app.api()).settings.download_dir).toBe(join(root, "changed"));
    expect((await app.api()).settings.seed_by_default).toBe(false);
    // Disabling the default leaves an existing seed active.
    expect((await app.api()).transfers.find((t) => t.id === ref.id).active).toBe(true);
    await app.command({ type: "pause", id: ref.id });
    const state = await app.api();
    await app.stop();
    app = await startApp(root);
    expect(
      (await app.api()).transfers.find((t) => t.id === ref.id).active,
    ).toBe(false);
    expect((await app.api()).settings.seed_by_default).toBe(false);
    await page.goto(app.url);
    await expect(page.locator(`[data-id="${ref.id}"] .state`)).toContainText(
      "Paused",
    );
    expect(state.transfers.filter((t) => t.active)).toHaveLength(4);
    const restored = (await app.api()).transfers;
    expect(restored).toHaveLength(6);
    expect(restored.filter((t) => t.active)).toHaveLength(4);
    expect(restored.find((t) => t.id === "1".padStart(40, "0")).active).toBe(false);
  } finally {
    await cleanup(root, tr, ref, app);
  }
});

test("Open tabs, drafts, explicit file confirmation, inline errors and keyboard", async ({
  page,
}) => {
  const root = await temporary(),
    tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "open"), [32001], {
      tracker: true,
      announce: [tr.http],
    });
    app = await startApp(root);
    await page.goto(app.url);
    await expect(
      page.getByRole("button", { name: "Open", exact: true }),
    ).toHaveCount(1);
    await page.locator("#open-button").click();
    const dialog = page.getByRole("dialog", { name: "Open", exact: true });
    await expect(page.locator("#magnet-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#magnet")).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.y).toBeGreaterThan(0);
    await expect(
      page.locator("#magnet-form button[type=submit]"),
    ).toBeDisabled();
    await page.locator("#magnet").fill("not a hash");
    await page.locator("#magnet-form button[type=submit]").click();
    await expect(page.locator("#magnet-error")).toContainText("v1 infohash");
    await expect(page.locator("#magnet")).toHaveValue("not a hash");
    await page.locator("#torrent-tab").click();
    await page.locator("#torrent-file").setInputFiles({
      name: "fixture.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.from(ref.bytes),
    });
    expect((await app.api()).transfers).toHaveLength(0);
    await page.locator("#magnet-tab").click();
    await expect(page.locator("#magnet")).toHaveValue("not a hash");
    await page.locator("#torrent-tab").click();
    expect(
      await page
        .locator("#torrent-file")
        .evaluate((e: HTMLInputElement) => e.files?.[0]?.name),
    ).toBe("fixture.torrent");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#open-button").click();
    await expect(page.locator("#magnet-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.locator("#magnet-tab").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#torrent-tab")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("#magnet-tab")).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator("#torrent-tab")).toBeFocused();
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.locator("#torrent-form button[type=submit]").click();
    await expect(dialog).not.toBeVisible();
    await complete(app, ref.id);
    await page.locator("#open-button").click();
    await expect(page.locator("#magnet")).toHaveValue("");
    await page.locator("#torrent-tab").click();
    expect(
      await page
        .locator("#torrent-file")
        .evaluate((e: HTMLInputElement) => e.files?.length),
    ).toBe(0);
    await page.locator("#torrent-file").setInputFiles({
      name: "bad.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.from("invalid"),
    });
    await page.locator("#torrent-form button[type=submit]").click();
    await expect(page.locator("#torrent-error")).not.toBeEmpty();
    await expect(dialog).toBeVisible();
    await page.locator("#torrent-file").setInputFiles({
      name: "large.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.alloc(8 * 1024 * 1024 + 1),
    });
    await expect(page.locator("#torrent-error")).toContainText("8 MiB");
    await expect(
      page.locator("#torrent-form button[type=submit]"),
    ).toBeDisabled();
    await page.locator("#magnet-tab").click();
    await page.locator("#magnet").fill(ref.id.toUpperCase());
    await page.locator("#magnet-form button[type=submit]").click();
    await expect(page.locator("#magnet-error")).toContainText("already exists");
    await page.locator("#magnet").fill(ref.id);
    await app.stop();
    await expect(
      page.locator("#magnet-form button[type=submit]"),
    ).toBeDisabled();
  } finally {
    await cleanup(root, tr, ref, app);
  }
});

test("no-seed downloads stay enabled as Completed across pause and restart", async ({ page }) => {
  const root = await temporary(), tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "no-seed"), [37001], { tracker: true, announce: [tr.http] });
    app = await startApp(root);
    await page.goto(app.url);
    await expect(page.locator("#settings-open")).toBeEnabled();
    await page.locator("#settings-open").click();
    await expect(page.locator("#seed-by-default")).toBeChecked();
    await page.locator("#seed-by-default").uncheck();
    await page.locator("#settings-form button[type=submit]").click();
    await magnet(page, ref.magnet);
    const row = page.locator(`[data-id="${ref.id}"]`);
    await expect(row.locator(".state")).toHaveText("Completed · 100%");
    await expect(row.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    expect((await app.api()).transfers[0].active).toBe(true);
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(row.locator(".state")).toHaveText("Paused · 100%");
    await row.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(row.locator(".state")).toHaveText("Completed · 100%");
    await app.stop();
    app = await startApp(root);
    await page.goto(app.url);
    await expect(row.locator(".state")).toHaveText("Completed · 100%");
    expect((await app.api()).transfers[0].active).toBe(true);
    await page.locator("#settings-open").click();
    await expect(page.locator("#seed-by-default")).not.toBeChecked();
  } finally { await cleanup(root, tr, ref, app); }
});
