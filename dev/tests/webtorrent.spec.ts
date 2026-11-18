import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {temporary,startApp,wait,complete,hash,payload,cleanup,dhtNetwork} from './helpers.mjs';
import {signaling} from './webtorrent-fixture.mjs';
import {evidencePath} from './runtime.mjs';
test.use({ignoreHTTPSErrors:true});

async function browserClient(page:any,url:string) {
  await page.goto(url);
  expect(await page.evaluate(()=>typeof navigator.storage.getDirectory)).toBe('undefined');
  await page.evaluate(()=>{
    const w=window as any;w.wireTypes=[];w.errors=[];
    w.client=new w.WebTorrent({dht:false,lsd:false,webSeeds:false,tracker:{rtcConfig:{iceServers:[]}}});
    w.client.on('error',(e:any)=>w.errors.push(e.message));
  });
}
async function download(page:any,id:string,tracker:string) {
  return page.evaluate(({id,tracker}:any)=>new Promise<any>((resolve,reject)=>{
    const w=window as any;
    const t=w.client.add('magnet:?xt=urn:btih:'+id,{announce:[tracker]});
    t.on('error',reject);t.on('wire',(wire:any)=>w.wireTypes.push(wire.type));
    t.on('done',async()=>{try{resolve({files:await Promise.all(t.files.map(async(f:any)=>({name:f.path,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}))),wires:w.wireTypes,errors:w.errors});}catch(e){reject(e);}});
  }),{id,tracker});
}
for(const [name,lengths] of [['single file',[65539]],['multiple files',[32769,19001,0]]] as const) {
  test('browser publishes '+name+' and restarted native serves an independent WebRTC download',async({page,browser})=>{
    const root=await temporary();let tr:any,app:any,receiverContext:any;
    try {
      tr=await signaling(join(root,'tls'));app=await startApp(join(root,'app'),[],{env:tr.env});
      await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:''}});
      await browserClient(page,tr.page);
      const originals=lengths.map((n,i)=>Array.from(payload(n,i)));
      const seeded=await page.evaluate(({originals,tracker}:any)=>new Promise<any>((resolve,reject)=>{
        const w=window as any,files=originals.map((b:any,i:number)=>new File([new Uint8Array(b)],'file-'+i+'.bin'));
        w.client.once('error',reject);
        const t=w.client.seed(files,{name:files.length===1?'file-0.bin':'browser-source',announce:[tracker],pieceLength:16384},(torrent:any)=>resolve({id:torrent.infoHash}));
        t.on('wire',(wire:any)=>w.wireTypes.push(wire.type));
      }),{originals,tracker:tr.url});
      await app.command({type:'add_magnet',uri:'magnet:?xt=urn:btih:'+seeded.id});
      const transfer=await complete(app,seeded.id);
      for(const file of transfer.files){const index=Number(file.name.match(/file-(\d+)\.bin$/)![1]);expect(hash(await readFile(join(transfer.save_path,file.name)))).toBe(hash(Buffer.from(originals[index])));}
      expect(await page.evaluate(()=>(window as any).wireTypes)).toContain('webrtc');
      expect(await page.evaluate(()=>(window as any).wireTypes.every((t:any)=>t==='webrtc'))).toBe(true);
      await app.command({type:'pause',id:seeded.id});expect((await app.api()).transfers[0].active).toBe(false);
      await app.command({type:'resume',id:seeded.id});await complete(app,seeded.id);
      await page.context().close();
      await app.stop();app=await startApp(join(root,'app'),[],{env:tr.env});await complete(app,seeded.id);
      receiverContext=await browser.newContext({ignoreHTTPSErrors:true});
      const receiver=await receiverContext.newPage();await browserClient(receiver,tr.page);
      const downloaded=await download(receiver,seeded.id,tr.url);
      expect(downloaded.wires.length).toBeGreaterThan(0);expect(downloaded.wires.every((t:string)=>t==='webrtc')).toBe(true);expect(downloaded.errors).toEqual([]);
      for(const file of downloaded.files){const index=Number(file.name.match(/file-(\d+)\.bin$/)![1]);expect(hash(Buffer.from(file.bytes))).toBe(hash(Buffer.from(originals[index])));}
    } finally {try{await receiverContext?.close();await page.context().close();}finally{await cleanup(root,app,tr);}}
  });
}

test('native-generated published catalog downloads by magnet over WebRTC',async({page})=>{
  const root=await temporary();let tr:any,app:any,network:any;
  try {
    tr=await signaling(join(root,'tls'));network=await dhtNetwork();
    app=await startApp(join(root,'app'),['--dht-bootstrap',network.bootstrap.map((n:any)=>n.host+':'+n.port).join(',')],{env:tr.env});
    await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:''}});
    const password='private catalog WebRTC fixture';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
    const {id}=await app.api('/api/publishing',{action:'create_post',title:'WebRTC catalog'});
    const post=await app.api('/api/publishing',{action:'get_post',id});post.draft.pages[0].body='Catalog shared from the native client over WebRTC.';
    const {revision}=await app.api('/api/publishing',{action:'save_draft',id,revision:post.revision,draft:post.draft});
    await app.api('/api/publishing',{action:'publish',id,revision,password});
    const catalog=await wait(async()=>{const t=(await app.api()).transfers.find((t:any)=>t.kind==='owned_catalog'&&t.progress===1);return t;},'native catalog seeding');
    await browserClient(page,tr.page);const downloaded=await download(page,catalog.id,tr.url);
    expect(downloaded.wires.length).toBeGreaterThan(0);expect(downloaded.wires.every((t:string)=>t==='webrtc')).toBe(true);
    for(const file of catalog.files){const result=downloaded.files.find((f:any)=>f.name===file.name);expect(result).toBeTruthy();expect(hash(Buffer.from(result.bytes))).toBe(hash(await readFile(join(catalog.save_path,file.name))));}
    expect(downloaded.files.some((f:any)=>f.name.endsWith('/body.md'))).toBe(true);
  } finally {await page.evaluate(()=>new Promise<void>(resolve=>{const c=(window as any).client;if(c&&!c.destroyed)c.destroy(resolve);else resolve();})).catch(()=>{});await cleanup(root,app,tr);if(network)await network.stop();}
});

test('WebRTC settings validate, autosave, retain explicit empty values and fit mobile',async({page},testInfo)=>{
  const root=await temporary();let app:any;
  try {
    app=await startApp(root);await page.goto(app.url);await page.locator('#settings-open').click();
    const trackers=page.locator('#webtorrent-trackers'),stun=page.locator('#webtorrent-stun-server');
    await expect(trackers).toHaveValue('wss://tracker.btorrent.xyz\nwss://tracker.openwebtorrent.com\nwss://tracker.webtorrent.dev');await expect(stun).toHaveValue('stun.l.google.com:19302');
    await trackers.fill('https://invalid.test');await stun.click();await expect(trackers).toHaveAttribute('aria-invalid','true');await expect(page.locator('#webtorrent-trackers-error')).toContainText('wss://');
    await trackers.fill('wss://localhost:8443/announce\nwss://localhost:8443/announce');await stun.click();await expect.poll(async()=>(await app.api()).settings.webtorrent_trackers).toEqual(['wss://localhost:8443/announce']);
    await stun.fill('stun://host:3478');await trackers.click();await expect(stun).toHaveAttribute('aria-invalid','true');
    await stun.fill('localhost:3478');await trackers.click();await expect.poll(async()=>(await app.api()).settings.webtorrent_stun_server).toBe('localhost:3478');
    for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});for(const width of [1280,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:evidencePath('webtorrent-settings-'+testInfo.project.name+'-'+width+'-'+scheme+'.png')});}}
    await trackers.fill('');await stun.fill('');await page.locator('#settings-title').click();await expect.poll(async()=>(await app.api()).settings.webtorrent_trackers).toEqual([]);await expect.poll(async()=>(await app.api()).settings.webtorrent_stun_server).toBe('');
    await page.locator('#settings-dialog [data-close]').click();await expect(page.locator('#settings-dialog')).toBeHidden();
    await app.stop();app=await startApp(root);await page.goto(app.url);await page.locator('#settings-open').click();await expect(trackers).toHaveValue('');await expect(stun).toHaveValue('');
  } finally {await cleanup(root,app);}
});
