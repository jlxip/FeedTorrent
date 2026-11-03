import { test, expect } from "@playwright/test";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import DHT from "bittorrent-dht";
import { temporary, startApp, cleanup, wait } from "./helpers.mjs";

test("publication indicator, signed retry, snapshots, cancellation and keyboard at 320px", async ({ page, context, browser }, info) => {
  const root = await temporary(), nodes: any[] = [];
  let app: any;
  let rejectPuts = true;
  const password = "indicator test publishing password";
  try {
    for (let i = 0; i < 6; i++) {
      const n = new DHT({ bootstrap: false, host: "127.0.0.1", verify: (signature: Buffer, message: Buffer, key: Buffer) => {
        try { return verify(null, message, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" }), signature); }
        catch { return false; }
      } });
      n.on("error", () => {});
      // Withhold write tokens to exercise zero-confirmation retries without
      // waiting for the public-network timeout. Restore standard GET afterwards.
      const get = n._onget.bind(n);
      n._onget = (query: unknown, peer: unknown) => rejectPuts ? n._rpc.response(peer, query, {id:n.nodeId}) : get(query, peer);
      await new Promise<void>(resolve => n.listen(0, "127.0.0.1", resolve));
      nodes.push(n);
    }
    for (const a of nodes) for (const b of nodes) if (a !== b) a.addNode({ host: "127.0.0.1", port: b.address().port });
    await wait(() => nodes.every(n => n.nodes.toArray().length >= 5), "indicator DHT fixture");
    app = await startApp(join(root, "app"), ["--dht-bootstrap", `127.0.0.1:${nodes[0].address().port}`]);
    const pub = (command: unknown) => app.api("/api/publishing", command);
    await pub({action:"create_key", password, confirmation:password});
    const {id} = await pub({action:"create_feed", title:"Status test"});
    let {draft, revision} = await pub({action:"get_feed", id});
    draft.pages[0].body = "This snapshot is published.";
    revision = (await pub({action:"save_draft", id, revision, draft})).revision;
    const external: string[] = [];
    page.on("request", r => { if (!r.url().startsWith(app.url)) external.push(r.url()); });
    await page.goto(app.url + "/#/own/" + id);
    await expect(page.locator("#own-body")).toHaveValue("This snapshot is published.");
    const indicator = page.locator("#own-indicator"), tooltip = page.locator("#own-publication-help");
    await expect(indicator).toHaveAttribute("data-state", "draft");
    await indicator.focus();
    await expect(tooltip).toBeVisible();
    // Loading the saved draft can refine the initial label before focus.
    await expect(tooltip).toHaveText(/^(Draft|Unpublished changes)$/);
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await indicator.click();
    await expect(tooltip).toBeVisible();
    await page.locator("#own-heading").click();
    await expect(tooltip).toBeHidden();
    await page.locator("#own-publish").click();
    await page.locator("#own-publish-password").fill(password);
    await page.locator("#own-publish-submit").click();
    await expect(page.locator("#own-publish-dialog")).toBeHidden();
    await expect(page.locator("#own-publish-password")).toHaveValue("");
    await expect(indicator).toHaveAttribute("data-state", "pending");
    await expect(page.locator("#own-publish")).toBeDisabled();
    await expect(page.locator("#own-cancel")).toBeVisible();
    await expect(page.locator("#own-retry")).toBeVisible({timeout:90000});
    const before = JSON.parse(await readFile(join(root,"app/state/publishing/library.json"), "utf8"));
    const operation = before.feeds[id].pending.id;
    expect(before.feeds[id].pending.signed).toEqual(before.feeds[id].record);
    expect(JSON.stringify(before)).not.toContain(password);
    await indicator.focus();
    await expect(tooltip).toContainText("Retrying");
    await expect(tooltip).toContainText("Next retry:");
    await expect(tooltip).toContainText("DHT");
    const secondTab = await context.newPage();
    await secondTab.goto(app.url + "/#/own/" + id);
    await expect(secondTab.locator("#own-publish")).toBeDisabled();
    await expect(secondTab.locator("#own-indicator")).toHaveAttribute("data-state", "pending");
    await page.locator("#own-body").fill("Edits remain unpublished.");
    await expect(page.locator("#own-draft-status")).toContainText("Draft saved");
    rejectPuts = false;
    await page.locator("#own-retry").click();
    await expect.poll(async () => (await app.api()).publishing.feeds[0].state).toBe("Published");
    await expect(indicator).toHaveAttribute("data-state", "draft");
    const after = JSON.parse(await readFile(join(root,"app/state/publishing/library.json"), "utf8"));
    expect(after.feeds[id].record).toEqual(before.feeds[id].record);
    expect(after.feeds[id].published_revision).toBe(revision);
    expect(after.feeds[id].revision).toBeGreaterThan(revision);
    expect(after.feeds[id].pending).toBeNull();
    await expect(secondTab.locator("#own-indicator")).toHaveAttribute("data-state", "draft");
    await expect(page.locator("#transfers article")).toHaveCount((await app.api()).transfers.length);
    // A later publication includes the edits, and only then turns the light green.
    await page.locator("#own-publish").click();
    await page.locator("#own-publish-password").fill(password);
    await page.locator("#own-publish-submit").click();
    await expect(indicator).toHaveAttribute("data-state", "published", {timeout:90000});
    await indicator.hover();
    await expect(tooltip).toContainText("Published draft revision");
    await expect(page.locator("#own-status")).toHaveCSS("position", "absolute");
    // A failed new publication cannot silently republish the previous record
    // or seed changed catalogs before the password has been checked.
    const beforeIncorrect = (await app.api()).transfers.map((t: any) => t.id).sort();
    await page.locator("#own-body").fill("A draft that must not be seeded with an incorrect password.");
    await expect(page.locator("#own-draft-status")).toContainText("Draft saved");
    await page.locator("#own-publish").click();
    await page.locator("#own-publish-password").fill("incorrect password");
    await page.locator("#own-publish-submit").click();
    await expect(indicator).toHaveAttribute("data-state", "error", {timeout:90000});
    await indicator.focus();
    await expect(tooltip).toContainText("Incorrect password");
    await expect(page.locator("#own-error")).toBeHidden();
    expect((await app.api()).transfers.map((t: any) => t.id).sort()).toEqual(beforeIncorrect);
    await expect(page.locator("#own-publish")).toBeEnabled();
    // Nested pages share the feed's indicator, and Cancel only stops publication.
    await page.locator("#own-new-page").click();
    await expect(page.locator("#own-breadcrumb")).toBeVisible();
    await page.locator("#own-body").fill("Nested content");
    await expect(page.locator("#own-draft-status")).toContainText("Draft saved");
    await page.locator("#own-publish").click();
    await page.locator("#own-publish-password").fill(password);
    await page.locator("#own-publish-submit").click();
    await expect(page.locator("#own-cancel")).toBeVisible();
    await page.locator("#own-cancel").click();
    await expect(indicator).toHaveAttribute("data-state", "draft");
    await indicator.focus();
    await expect(tooltip).toContainText("Publication canceled");
    const canceled = (await app.api()).publishing.feeds[0];
    expect(canceled.operation).toBeNull();
    await expect(page.locator("#own-publish")).toBeEnabled();
    await expect(page.locator("#own-cancel")).toBeHidden();
    await expect(page.locator("#own-retry")).toBeHidden();
    await expect(page.locator("#own-body")).toHaveValue("Nested content");
    const stale = await page.request.post(app.url+"/api/publishing", {headers:{Origin:app.url},data:{action:"cancel_publication",id,operation}});
    expect(stale.ok()).toBe(false);
    expect((await app.api()).transfers.every((t: any) => t.active)).toBe(true);
    await secondTab.close();
    await page.setViewportSize({width:320,height:900});
    await indicator.focus();
    await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await app.stop();
    await expect(indicator).toHaveAttribute("aria-label", "Server disconnected");
    await expect(indicator).toHaveAttribute("data-state", "draft");
    expect(external).toEqual([]);
    await info.attach("browser-version", {body:browser.version(),contentType:"text/plain"});
  } finally {
    await cleanup(root, app);
    await Promise.all(nodes.map(n => new Promise<void>(r => n.destroy(r))));
  }
});
