import {evidencePath} from './runtime.mjs';
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
    await expect(page.locator("#post-add")).toBeEnabled();
    await expect(page.locator("#post-add")).toHaveAccessibleName("Create post");
    await expect(page.locator("#post-add-menu")).toHaveCount(0);
    await page.locator("#post-add").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#own-create-dialog")).toBeVisible();
    await expect(page.locator("#own-create-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#own-create-dialog")).toBeHidden();
    await expect(page.locator("#post-add")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator("#own-create-dialog")).toBeVisible();
    await page.locator("#own-create-dialog [data-close]").click();
    await expect(page.locator("#post-add")).toBeFocused();
    await page.locator("#post-add").click();
    await expect(page.locator("#own-create-dialog")).toBeVisible();
    await expect(
      page.locator("#own-create-dialog [data-close] svg"),
    ).toBeVisible();
    await page.locator("#own-create-title").fill("Field notes");
    await page.mouse.click(2, 2);
    await expect(page.locator("#own-create-dialog")).toBeHidden();
    await page.locator("#post-add").click();
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
    await page.locator("#own-publish-dialog [data-close]").click();
    await expect(page.locator("#own-publish-password")).toHaveValue("");
    await page.locator("#own-publish").click();
    await page.mouse.click(2, 2);
    await expect(page.locator("#own-publish-dialog")).toBeHidden();
    await page.locator("#settings-open").click();
    await page.locator("#publishing-keys-open").click();
    await expect(page.locator("#publishing-keys-dialog")).toBeVisible();
    await page.locator("#publishing-keys-dialog [data-close]").click();
    await page.locator("#settings-dialog [data-close]").click();
    await page.screenshot({
      path: evidencePath("publishing-editor-") + info.project.name + ".png",
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


test('title snapshots cannot move Public view between pointerdown and pointerup',async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));const pub=(body:unknown)=>app.api('/api/publishing',body);
    const password='stable title fixture password',longTitle='A'.repeat(240);
    await pub({action:'create_key',password,confirmation:password});
    const {id}=await pub({action:'create_post',title:longTitle});
    await expect.poll(async()=>(await app.api()).publishing.posts.find(p=>p.id===id)?.title).toBe(longTitle);
    const stale=await app.api();
    await page.addInitScript(()=>{
      (window as any).sources=[];
      (window as any).EventSource=class extends EventTarget{close(){}constructor(){super();(window as any).sources.push(this)}};
    });
    await page.route('**/api/snapshot',route=>route.fulfill({json:stale}));
    const emit=async(state:unknown)=>page.evaluate(s=>{
      for(const source of (window as any).sources)source.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)}));
    },state);
    await page.setViewportSize({width:320,height:900});
    await page.goto(app.url+'/#/own/'+id);
    await expect(page.locator('#own-title')).toHaveValue(longTitle);
    await page.locator('#own-title').fill('Field notes');
    await expect(page.locator('#own-draft-status')).toHaveText('Draft saved');
    await expect.poll(async()=>(await app.api()).publishing.posts.find(p=>p.id===id)?.title).toBe('Field notes');
    const latest=await app.api(),toggle=page.locator('#own-toggle');
    await toggle.click({trial:true});const before=(await toggle.boundingBox())!;
    const point={x:before.x+before.width/2,y:before.y+before.height/2};
    const underPointer=()=>page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('#own-toggle')?.id,point);
    await page.mouse.move(point.x,point.y);await page.mouse.down();
    await emit(stale);expect(await underPointer()).toBe('own-toggle');
    await emit(latest);expect(await underPointer()).toBe('own-toggle');
    await page.mouse.up();
    await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1$'));
    await expect(page.locator('#own-preview')).toBeVisible();await expect(page.locator('#own-heading')).toHaveText('Field notes');
  }finally{await cleanup(root,app);}
});
