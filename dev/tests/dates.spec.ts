import {expect,test} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import bencode from 'bencode';
import {cleanup,startApp,temporary,wait} from './helpers.mjs';
const sha=(b:Buffer)=>createHash('sha1').update(b).digest();
function torrent(name:string,dates:string|null,catalog=true,created?:number){
  const files=[{path:['metadata','body.md'],data:Buffer.from('A verified page.')}];
  if(dates!==null)files.push({path:['metadata','dates.json'],data:Buffer.from(dates)});
  const all=Buffer.concat(files.map(f=>f.data)),pieces:Buffer[]=[];
  for(let i=0;i<all.length;i+=16384)pieces.push(sha(all.subarray(i,i+16384)));
  const info={name,files:files.map(f=>({path:f.path,length:f.data.length,...(catalog?{sha1:sha(f.data)}:{})})),'piece length':16384,pieces:Buffer.concat(pieces),...(catalog?{bep49:{}}:{})};
  return {id:sha(Buffer.from(bencode.encode(info))).toString('hex'),name,files,bytes:Buffer.from(bencode.encode({info,...(created===undefined?{}:{'creation date':created})}))};
}
async function add(root:string,app:any,t:ReturnType<typeof torrent>,verified=true){
  if(verified)for(const f of t.files){const p=join(root,'app/downloads',t.id,t.name,...f.path);await mkdir(dirname(p),{recursive:true});await writeFile(p,f.data);}
  await app.command({type:'add_torrent',data:Array.from(t.bytes)});
  if(verified)await wait(async()=>{const r=(await app.api()).transfers.find(t0=>t0.id===t.id);return r?.progress===1&&r.files.every(f=>f.ready);},'date fixture verified');
}
test('optional dates are bounded, verified and never authorize a download',async()=>{
  const root=await temporary();let app:any;
  try{
    app=await startApp(join(root,'app'));
    const valid=torrent('Known','{"created_at":100,"updated_at":200}');
    const unknown=torrent('Unknown','{"created_at":null,"updated_at":200}');
    const cases=[torrent('Absent',null),torrent('Invalid','{"created_at":300,"updated_at":200}'),torrent('Oversized','{"created_at":100,"updated_at":200}'+ ' '.repeat(4096)),torrent('Unverified','{"created_at":100,"updated_at":200}')];
    for(const t of [valid,unknown,...cases])await add(root,app,t,t!==cases[3]);
    const before=(await app.api()).transfers.map(t=>({id:t.id,active:t.active}));
    let d=await app.command({type:'read_content',id:valid.id,offset:0});expect(d.created_at).toBe(100);expect(d.updated_at).toBe(200);expect(d.body_state).toBe('ready');expect(d.files).toHaveLength(0);
    d=await app.command({type:'read_content',id:unknown.id,offset:0});expect(d.created_at).toBeNull();expect(d.updated_at).toBe(200);
    for(const t of cases){const d=await app.command({type:'read_content',id:t.id,offset:0});expect(d.created_at).toBeNull();expect(d.updated_at).toBeNull();if(t!==cases[3])expect(d.body_state).toBe('ready');}
    // Native progress alone is insufficient: reject altered bytes with the same length.
    const p=join(root,'app/downloads',valid.id,valid.name,'metadata/dates.json');await writeFile(p,'{"created_at":101,"updated_at":201}');
    d=await app.command({type:'read_content',id:valid.id,offset:0});expect(d.updated_at).toBeNull();expect(d.body_state).toBe('ready');
    expect((await app.api()).transfers.map(t=>({id:t.id,active:t.active}))).toEqual(before);
    expect((await app.api()).transfers.find(t=>t.id===cases[3].id).progress).toBe(0);
  }finally{await cleanup(root,app);}
});
test('the common dates row handles local zones, unknown origin and conventional torrents at 320px',async({page,browser},info)=>{
  const root=await temporary();let app:any,other:any;
  try{
    app=await startApp(join(root,'app'));
    const known=torrent('Known','{"created_at":1794009600,"updated_at":1794009600}',true,1794009600);
    const unknown=torrent('Unknown','{"created_at":null,"updated_at":1794009600}');
    const plain=torrent('Epoch',null,false,0),absent=torrent('No date',null,false),legacy=torrent('Legacy',null);
    for(const t of [known,unknown,plain,absent,legacy])await add(root,app,t);
    await page.goto(app.url+'/#/library/'+known.id);const row=page.locator('#library-reader .reader-dates');await expect(row).toBeVisible();
    await expect(row.locator('time')).toHaveCount(2);expect(await row.locator('time').allTextContents()).toEqual([await row.locator('time').first().textContent(),await row.locator('time').first().textContent()]);
    await expect(row.locator('time').first()).toHaveAttribute('datetime','2026-11-07T00:00:00.000Z');
    expect(await row.evaluate(e=>e.nextElementSibling?.classList.contains('reader-body'))).toBe(true);
    for(const width of[1280,320])for(const theme of['light','dark'] as const){await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`dates-${width}-${theme}.png`),animations:'disabled'});}
    const initial=await row.locator('time').first().textContent();
    const zone=await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone)==='Asia/Tokyo'?'America/Los_Angeles':'Asia/Tokyo';
    other=await browser.newContext({timezoneId:zone,viewport:{width:320,height:740}});const changed=await other.newPage();await changed.goto(app.url+'/#/library/'+known.id);await expect(changed.locator('.reader-dates time').first()).toHaveAttribute('datetime','2026-11-07T00:00:00.000Z');await expect(changed.locator('.reader-dates time').first()).not.toHaveText(initial!);
    await page.goto(app.url+'/#/library/'+unknown.id);await expect(row).toContainText('Created unknown');await expect(row.locator('time')).toHaveCount(1);
    await page.goto(app.url+'/#/library/'+plain.id);await expect(row).toContainText('Created');await expect(row).not.toContainText('Updated');await expect(row.locator('time')).toHaveAttribute('datetime','1970-01-01T00:00:00.000Z');
    for(const t of[absent,legacy]){await page.goto(app.url+'/#/library/'+t.id);await expect(page.locator('#torrent-heading')).toHaveText(t.name);await expect(row).toBeHidden();}
  }finally{if(other)await other.close();await cleanup(root,app);}
});
