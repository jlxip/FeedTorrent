import {expect,test} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import bencode from 'bencode';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';

const sha=(data:Uint8Array|string)=>createHash('sha1').update(data).digest();
function torrent(name:string,files:{path:string[];data:Buffer}[],catalog=false,fields={}){
  const all=Buffer.concat(files.map(f=>f.data)),pieces:Buffer[]=[];
  for(let at=0;at<all.length;at+=16384)pieces.push(sha(all.subarray(at,at+16384)));
  const info={name,files:files.map(f=>({path:f.path,length:f.data.length,...(catalog?{sha1:sha(f.data)}:{})})),'piece length':16384,pieces:Buffer.concat(pieces),...(catalog?{bep49:fields}:{})};
  return {id:sha(bencode.encode(info)).toString('hex'),name,bytes:Buffer.from(bencode.encode({info})),files};
}
async function preload(root:string,app,t){
  for(const f of t.files){const path=join(root,'app','downloads',t.id,t.name,...f.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,f.data);}
  await app.command({type:'add_torrent',data:Array.from(t.bytes)});
  await wait(async()=>{const t0=(await app.api()).transfers.find(x=>x.id===t.id);return t0?.progress===1&&t0.files.every(f=>f.ready);},'preloaded pieces verified');
}

test('Library reads verified Markdown and ordinary files through the common view',async({page},info)=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const withBody=torrent('Field notes',[{path:['metadata','body.md'],data:Buffer.from('# Workshop\n\nA **verified** page.\n\n<script>window.remoteRan=true</script>')},{path:['notes.txt'],data:Buffer.from('abc')}]);
    const plain=torrent('Ordinary files',[{path:['notes.txt'],data:Buffer.from('xyz')}]);
    await preload(root,app,withBody);await preload(root,app,plain);
    const before=await readFile(join(root,'app','state','transfers.json')).catch(()=>null);
    const data=await app.command({type:'read_content',id:withBody.id,offset:0});expect(data.body_state).toBe('ready');expect(data.body.kind).toBe('document');expect(data).not.toHaveProperty('body_path');if(before)expect(await readFile(join(root,'app','state','transfers.json'))).toEqual(before);
    await page.goto(app.url+'/#/library/'+withBody.id);
    await expect(page.locator('#library-reader .reader-body')).toContainText('A verified page.');
    expect(await page.evaluate(()=>(window as any).remoteRan)).toBeUndefined();
    await expect(page.locator('#library-reader .reader-row')).toHaveCount(1);
    await expect(page.locator('#torrent-heading')).toHaveText('Field notes');await expect(page.locator('.content-identity .content-totals')).toHaveCount(0);
    await expect(page.locator('#library-reader .content-sharing .progress')).toBeHidden();
    await page.screenshot({path:info.outputPath('common-body-1280-light.png'),animations:'disabled'});
    await page.setViewportSize({width:320,height:740});await page.screenshot({path:info.outputPath('common-body-320-light.png'),animations:'disabled'});
    await page.emulateMedia({colorScheme:'dark'});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(true);await page.screenshot({path:info.outputPath('common-body-320-dark.png'),animations:'disabled'});
    await page.emulateMedia({colorScheme:'light'});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(false);await page.setViewportSize({width:1280,height:740});
    await page.locator('#torrent-more').click();await expect(page.getByRole('menuitem',{name:'Show in Folder',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');await expect(page.locator('#torrent-more')).toBeFocused();
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAttribute('aria-label','Resume');
    await page.reload();await expect(page.locator('#library-reader .reader-body')).toContainText('A verified page.');
    await page.locator('#library-back').click();await page.locator('#library-open-'+plain.id).click();
    await expect(page.locator('#library-reader .reader-body')).toBeHidden();await expect(page.locator('#library-reader .reader-row')).toHaveCount(1);
    for(const width of[1280,320])for(const theme of['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`common-${width}-${theme}.png`),animations:'disabled'});}
    expect((await app.api()).transfers).toHaveLength(2);
    expect(errors).toEqual([]);
  }finally{await cleanup(root,app);}
});

test('a catalog reference previews without registration, then Download stays in context',async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));
    const child=torrent('Model files',[{path:['model.txt'],data:Buffer.from('payload')}]);
    const parent=torrent('Catalog',[{path:['metadata','body.md'],data:Buffer.from('A catalog page.')},{path:['model.torrent'],data:child.bytes}],true);
    await preload(root,app,parent);
    const before=(await app.api()).transfers.map(t=>({id:t.id,active:t.active}));
    const data=await app.command({type:'read_content',id:child.id,parent:parent.id,offset:0});expect(data.name).toBe('Model files');expect(data.source_index).toBe(1);expect(data.files[0].length).toBe(7);
    expect((await app.api()).transfers.map(t=>({id:t.id,active:t.active}))).toEqual(before);
    await expect(app.command({type:'read_content',id:'f'.repeat(40),parent:parent.id,offset:0})).rejects.toThrow('not available from this catalog');
    await page.goto(app.url+'/#/library/'+parent.id);await expect(page.locator('#library-reader .reader-body')).toContainText('A catalog page.');
    await page.getByRole('link',{name:'Model files',exact:true}).click();
    await expect(page.locator('#torrent-heading')).toHaveText('Model files');await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Download');
    expect(await page.locator('#torrent-toggle').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);expect((await app.api()).transfers).toHaveLength(1);await page.reload();await expect(page.locator('#torrent-heading')).toHaveText('Model files');expect((await app.api()).transfers).toHaveLength(1);
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Pause');
    await expect(page).toHaveURL(new RegExp('#/library/'+parent.id+'/torrent/'+child.id+'$'));expect((await app.api()).transfers).toHaveLength(2);
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');
    await page.goBack();await expect(page.locator('#library-reader .reader-body')).toContainText('A catalog page.');
    await page.goForward();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');
    expect((await app.api()).transfers.find(t=>t.id===child.id).active).toBe(false);
    const childState=(await app.api()).transfers.find(t=>t.id===child.id);expect(childState.pinned).toBe(false);expect(childState.protected_by).toEqual([parent.id]);
    await page.locator('#torrent-more').click();await expect(page.locator('#torrent-remove')).toBeDisabled();await expect(page.locator('#torrent-pin')).toHaveAttribute('aria-checked','false');
    await page.locator('#torrent-pin-info').hover();await expect(page.locator('#torrent-pin-help')).toContainText('Catalog');await page.keyboard.press('Escape');
    await page.goto(app.url+'/#/library/'+parent.id);await page.locator('#torrent-more').click();await page.locator('#torrent-pin').click();
    await expect(page.locator('#remove-title')).toHaveText('Unpin and delete?');await expect(page.locator('#remove-preview')).toContainText('2 unreferenced torrents');
    await page.keyboard.press('Escape');expect((await app.api()).transfers.find(t=>t.id===parent.id).pinned).toBe(true);
    await page.locator('#torrent-more').click();await page.locator('#torrent-pin').click();await page.locator('#remove-form button[type=submit]').click();
    await expect(page).toHaveURL(/#\/library$/);await expect.poll(async()=>(await app.api()).transfers.length).toBe(0);
  }finally{await cleanup(root,app);}
});


test('catalog History previews exact pointers and bodies distinguish pending and invalid text',async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));
    const previous=torrent('Previous page',[{path:['readme.txt'],data:Buffer.from('older')}],true);
    const uri='magnet:?xt=urn:btih:'+previous.id+'&dn=Previous';
    const parent=torrent('Current page',[{path:['readme.txt'],data:Buffer.from('current')}],true,{prev:uri});
    await preload(root,app,parent);
    const preview=await app.command({type:'read_content',id:previous.id,parent:parent.id,offset:0});expect(preview.source_uri).toBe(uri);expect((await app.api()).transfers).toHaveLength(1);
    await page.goto(app.url+'/#/library/'+parent.id);await page.locator('#library-reader summary').click();
    await page.getByRole('link',{name:'Previous version',exact:true}).click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Download');
    await page.reload();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Download');expect((await app.api()).transfers).toHaveLength(1);
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Pause');expect((await app.api()).transfers).toHaveLength(2);
    const pending=torrent('Pending Markdown',[{path:['metadata','body.md'],data:Buffer.from('Not on disk')}]);await app.command({type:'add_torrent',data:Array.from(pending.bytes)});
    expect((await app.command({type:'read_content',id:pending.id,offset:0})).body_state).toBe('pending');
    const invalid=torrent('Invalid text',[{path:['metadata','body.md'],data:Buffer.from([255,254,253])}]);await preload(root,app,invalid);
    const result=await app.command({type:'read_content',id:invalid.id,offset:0});expect(result.body_state).toBe('error');expect(result.body_error).toBeTruthy();expect(result.body).toBeNull();
  }finally{await cleanup(root,app);}
});


test('a simultaneous addition is reused without resuming the existing torrent',async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));
    const child=torrent('Shared model',[{path:['model.txt'],data:Buffer.from('payload')}]);
    const parent=torrent('Catalog',[{path:['model.torrent'],data:child.bytes}],true);await preload(root,app,parent);
    await page.addInitScript(()=>{class Events extends EventTarget{};(window as any).EventSource=Events;});
    await page.goto(app.url+'/#/library/'+parent.id+'/torrent/'+child.id);await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Download');
    await app.command({type:'add_torrent',data:Array.from(child.bytes)});await app.command({type:'pause',id:child.id});
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');
    await expect(page.locator('#torrent-error')).toBeHidden();const snapshot=await app.api();expect(snapshot.transfers.filter(t=>t.id===child.id)).toHaveLength(1);expect(snapshot.transfers.find(t=>t.id===child.id).active).toBe(false);
  }finally{await cleanup(root,app);}
});


test('Read own post keeps nested catalog provenance and removal returns to preview',async({page})=>{
  const root=await temporary();let app;
  try{
    app=await startApp(join(root,'app'));
    const child=torrent('Nested model',[{path:['model.txt'],data:Buffer.from('payload')}]);
    const parent=torrent('Draft catalog',[{path:['metadata','body.md'],data:Buffer.from('Nested draft page')},{path:['model.torrent'],data:child.bytes}],true);await preload(root,app,parent);
    const password='content test password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
    const {id}=await app.api('/api/publishing',{action:'create_post',title:'My notebook'});
    await app.api('/api/publishing',{action:'save_draft',id,revision:1,draft:{root:1,pages:[{id:1,title:'My notebook',body:'',entries:[{kind:'torrent',name:'page.torrent',data:Array.from(parent.bytes)}]}]}});
    const unpin=await app.command({type:'preview_removal',target:{kind:'unpin',id:parent.id}});expect(unpin.deleting).toHaveLength(0);await app.command({type:'set_pin',id:parent.id,pinned:false,revision:unpin.revision});
    const before=await app.api('/api/publishing',{action:'get_post',id});
    await page.goto(app.url+'/#/own/'+id+'/read/1/torrent/'+parent.id);await expect(page.locator('#own-preview .reader-body')).toContainText('Nested draft page');
    await page.getByRole('link',{name:'Nested model',exact:true}).click();await expect(page.locator('#own-reader-toggle')).toHaveAccessibleName('Download');
    await page.reload();await expect(page.locator('#own-reader-toggle')).toHaveAccessibleName('Download');expect((await app.api()).transfers).toHaveLength(1);
    await page.locator('#own-reader-toggle').click();await expect(page.locator('#own-reader-toggle')).toHaveAccessibleName('Pause');
    await page.locator('#own-reader-more').click();await page.locator('#own-reader-remove').click();await page.locator('#remove-form button[type=submit]').click();
    await expect(page.locator('#own-reader-toggle')).toHaveAccessibleName('Download');await expect(page).toHaveURL(new RegExp('/torrent/'+parent.id+'/torrent/'+child.id+'$'));
    expect((await app.api()).transfers).toHaveLength(1);expect(await app.api('/api/publishing',{action:'get_post',id})).toEqual(before);
  }finally{await cleanup(root,app);}
});
