import bencode from "bencode";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { temporary, startApp, cleanup } from "./helpers.mjs";
test("own publishing editor, durable drafts, safe Markdown, keys and 320px", async ({
  page,
  browser,
}, info) => {
  const root = await temporary();
  let app;
  try {
    app = await startApp(join(root, "app"));
    console.log(info.project.name, browser.version());
    await info.attach("browser-version", {
      body: browser.version(),
      contentType: "text/plain",
    });
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(app.url)) external.push(r.url());
    });
    await page.goto(app.url);
    await expect(page.locator("#own-create")).toBeEnabled();
    await page.locator("#post-add").click();
    await page.locator("#own-create").click();
    await expect(
      page.locator("#own-create-dialog [data-close] svg"),
    ).toBeVisible();
    await page.locator("#own-create-title").fill("Field notes");
    await page.mouse.click(2, 2);
    await expect(page.locator("#own-create-dialog")).toBeHidden();
    await page.locator("#post-add").click();
    await page.locator("#own-create").click();
    await expect(page.locator("#own-create-title")).toHaveValue("Field notes");
    await page
      .locator("#own-key-password")
      .fill("a test publishing passphrase");
    await page.locator("#own-key-confirm").fill("a test publishing passphrase");
    await page.locator("#own-create-submit").click();
    await expect(page.locator("#own-create-dialog")).toBeHidden();
    await expect(page.locator("#own-title")).toHaveValue("Field notes");
    await expect(page.locator("#own-editor")).toBeVisible();
    await expect(page.locator("#own-toggle")).toHaveText("Public view");
    await expect(page.locator("#own-breadcrumb")).toBeHidden();
    await expect(page.locator("#transfers-nav")).toHaveAttribute("aria-current","false");
    await expect(page.locator("#post-tree a[data-kind=own]").first()).toHaveAttribute("aria-current","page");
    await expect(page.locator("#own-editor label").last()).not.toContainText("optional");
    await page.locator("#transfers-nav").click();
    await expect(page.locator("#transfers-nav")).toHaveAttribute("aria-current","page");
    await expect(page.locator("#post-tree a[data-kind=own]").first()).toHaveAttribute("aria-current","false");
    await page.locator("#post-tree a[data-kind=own]").first().click();
    await expect(page.locator("#own-preview")).toBeVisible();
    await expect(page.locator("#own-editor")).toBeHidden();
    await expect(page.locator("#own-toggle")).toHaveText("Edit");
    await page.reload();await expect(page.locator("#own-preview")).toBeVisible();
    await page.locator("#own-toggle").click();
    await expect(page.locator("#transfers-nav")).toHaveAttribute("aria-current","false");
    await expect(page.locator("#own-key-password")).toHaveValue("");
    await page
      .locator("#own-body")
      .fill(
        "# A page\n\n**Readable** text.\n\n<script>window.bad=true</script>\n\n![alt](https://example.invalid/image.svg)\n\n[Download](payload.torrent) [Missing](absent.torrent)",
      );
    await expect(page.locator("#own-draft-status")).toHaveText("Draft saved");
    const bytes = Buffer.from("abc");
    const meta = Buffer.from(
      bencode.encode({
        info: {
          name: Buffer.from("payload.txt"),
          length: 3,
          "piece length": 16384,
          pieces: createHash("sha1").update(bytes).digest(),
        },
      }),
    );
    await page
      .locator("#own-torrent")
      .setInputFiles({
        name: "payload.torrent",
        mimeType: "application/x-bittorrent",
        buffer: meta,
      });
    await expect(page.locator("#own-draft-status")).toHaveText("Draft saved");
    expect((await app.api()).transfers).toHaveLength(0);
    await page.locator("#own-new-page").click();
    await expect(page.locator("#own-breadcrumb")).toBeVisible();
    await page.locator("#own-title").fill("Harbour");
    await page.locator("#own-body").fill("A child page.");
    await expect(page.locator("#own-draft-status")).toHaveText("Draft saved");
    await page
      .locator("#own-breadcrumb")
      .getByRole("button", { name: "Field notes", exact: true })
      .click();
    await expect(page.locator(".own-entry-name").last()).toHaveText("Harbour");
    await page.reload();
    await expect(page.locator("#own-title")).toHaveValue("Field notes");
    await page.locator("#own-toggle").click();
    await expect(page.locator("#own-preview strong")).toHaveText("Readable");
    await expect(page.locator("#own-preview .reader-body a")).toHaveCount(1);
    await expect(page.locator("#own-preview")).toContainText("Missing");
    await expect(page.locator("#own-preview")).toContainText("<script>");
    await expect(page.locator("#own-preview img")).toHaveCount(0);
    await expect(page.locator("#own-preview script")).toHaveCount(0);
    expect(
      await page.evaluate(() => Reflect.get(window, "bad")),
    ).toBeUndefined();
    await page.locator("#own-toggle").click();
    await page.locator("#own-publish").click();
    await page.locator("#own-publish-password").fill("not retained");
    await page.keyboard.press("Escape");
    await expect(page.locator("#own-publish-password")).toHaveValue("");
    await page.locator("#own-publish").click();
    await page.mouse.click(2, 2);
    await expect(page.locator("#own-publish-dialog")).toBeHidden();
    await page.locator("#settings-open").click();
    await page.locator("#publishing-keys-open").click();
    await expect(page.locator("#publishing-keys-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: ".runtime/evidence/publishing-editor-" + info.project.name + ".png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.locator("#own-title")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.locator("#own-title").fill("A".repeat(240));
    await expect(page.locator("#own-draft-status")).toHaveText("Draft saved");
    await expect(page.locator("#own-heading")).toHaveText("A".repeat(240));
    await page.locator("#own-toggle").click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.locator("#own-toggle").click();
    await page.locator("#own-title").fill("Field notes");
    await expect(page.locator("#own-draft-status")).toHaveText("Draft saved");
    expect(external).toEqual([]);
    await page.locator("#own-toggle").click();
    await page.locator("#own-preview .reader-body a").click();
    await expect.poll(async () => (await app.api()).transfers.length).toBe(1);
    await expect(page.locator("#own-preview")).toBeVisible();
    const added=(await app.api()).transfers[0];
    await expect(page).toHaveURL(/#\/own\/.*\/read\/1$/);
    await page.locator("#own-preview").getByRole("link",{name:/Movie|torrent/}).click();
    await expect(page).toHaveURL(new RegExp("#/own/.*?/read/1/torrent/"+added.id+"$"));
    await expect(page.locator("#own-preview h2")).toHaveText("payload.txt");
  } finally {
    await cleanup(root, app);
  }
});


test("existing posts open Public view at their actual root without an extra history entry",async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));const password='public view test password';
    await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
    const {id}=await app.api('/api/publishing',{action:'create_post',title:'Existing notebook'});
    await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft:{root:7,pages:[{id:7,title:'Existing notebook',body:'Saved page',entries:[]}]}});
    await page.goto(app.url+'/#/library');const link=page.locator(`#post-tree a[data-post="${id}"]`);
    await expect(link).toHaveAttribute('href',`#/own/${id}/read`);await link.click();
    await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/7$'));await expect(page.locator('#own-preview')).toContainText('Saved page');await expect(page.locator('#own-editor')).toBeHidden();
    await page.goBack();await expect(page).toHaveURL(/#\/library$/);await page.goForward();await expect(page.locator('#own-preview')).toContainText('Saved page');
    await page.reload();await expect(page.locator('#own-preview')).toContainText('Saved page');
    await page.getByRole('button',{name:'Edit',exact:true}).click();await expect(page.locator('#own-editor')).toBeVisible();await expect(page.locator('#own-title')).toHaveValue('Existing notebook');
    await page.setViewportSize({width:320,height:740});await page.getByRole('button',{name:'Public view',exact:true}).click();await expect(page.locator('#own-preview')).toContainText('Saved page');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{await cleanup(root,app);}
});
