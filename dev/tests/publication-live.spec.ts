import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';
import {dhtNetwork} from './helpers.mjs';
test('real Publish acceptance opens the same page and confirmed DHT publication updates both tabs',async({page,context})=>{
 const root=await temporary();let app:any,network:any;
 try{
  network=await dhtNetwork();app=await startApp(join(root,'app'),['--dht-bootstrap',network.bootstrap.map(n=>`${n.host}:${n.port}`).join(',')]);
  const password='live publication browser password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});const {id}=await app.api('/api/publishing',{action:'create_post',title:'Live publication'});
  await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft:{root:1,pages:[{id:1,title:'Live publication',body:'Live body',entries:[]}]}});
  await page.goto(app.url+'/#/own/'+id);await expect(page.locator('#own-body')).toHaveValue('Live body');
  const second=await context.newPage();await second.goto(app.url+'/#/own/'+id);await expect(second.locator('#own-body')).toHaveValue('Live body');
  const external:string[]=[];page.on('request',r=>{if(!r.url().startsWith(app.url))external.push(r.url())});
  await page.locator('#own-publish').click();await page.locator('#own-publish-password').fill(password);await page.locator('#own-publish-submit').click();
  await expect(page).toHaveURL(new RegExp('#/own/'+id+'/read/1$'));await expect(page.locator('#own-preview')).toContainText('Live body');await expect(page.locator('#own-publish-password')).toHaveValue('');
  await wait(async()=> (await app.api()).publishing.posts.find(p=>p.id===id)?.published_sequence==='0','live browser DHT ACK',90000);
  for(const tab of[page,second]){await expect(tab.locator('#own-indicator')).toHaveAttribute('data-state','published');await tab.locator('#own-indicator').hover();await expect(tab.locator('#own-publication-help')).toContainText('Published Version 0');}
  await page.locator('#transfers-nav').click();const library=await app.api();const grouped=new Set(library.library_posts.flatMap(p=>p.catalog_ids));await expect(page.locator('#transfers article')).toHaveCount(library.library_posts.length+library.transfers.filter(t=>!grouped.has(t.id)).length);await page.locator(`#post-tree a[data-post="${id}"]`).click();await expect(page.locator('#own-preview')).toContainText('Live body');
  expect(external).toEqual([]);await second.close();
 }finally{await cleanup(root,app);if(network)await network.stop();}
});
