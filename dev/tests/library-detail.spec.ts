import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

// Isolated presentation snapshots exercise every state without waiting for peers.
async function fixture(page, count=6) {
  const root=await temporary();const app=await startApp(join(root,'app'));
  const snapshot=await app.api();
  const states=['Downloading','Seeding','Paused','Completed','Awaiting approval','Error'];
  snapshot.transfers=Array.from({length:count},(_,i)=>({
    id:(i+1).toString(16).padStart(40,'0'),
    name:['Debian 13.1.0 amd64','Field notes','Photos — October','Blender 4.5 source','Research archive','Project files'][i]||`Archive ${i}`,
    state:states[i%6],error:i%6===5?'Storage unavailable (EACCES)':'',warning:'',active:i%6!==2,
    verified:i%6===1||i%6===3?4294967296:1460288881,total:4294967296,progress:i%6===1||i%6===3?1:.34,
    down:2516582,up:86016,peers:12,save_path:'/Downloads/Archive',held:i%6===4,approval_size:null,
    kind:i===1?'catalog':'',post:null,
    files:[{name:'archive/data.bin',length:4294967296,verified:1460288881,ready:false},{name:'archive/notes.txt',length:1200,verified:1200,ready:true}],
  }));
  const commands:any[]=[];let refuse=false;
  await page.addInitScript(()=>{
    class Events extends EventTarget {onerror:any=null;constructor(){super();(window as any).__libraryEvents=this;}}
    (window as any).EventSource=Events;
  });
  await page.route('**/api/snapshot',route=>route.fulfill({json:snapshot}));
  await page.route('**/api/commands',async route=>{
    const c=route.request().postDataJSON();if(c.type!=='read_content')commands.push(c);
    if(c.type==='read_content'){const t=snapshot.transfers.find(t=>t.id===c.id);if(!t){await route.fulfill({status:400,json:{error:'Torrent unavailable'}});return;}await route.fulfill({json:{id:t.id,name:t.name,total:t.files.length?t.total:null,kind:'torrent',files:t.files.map((f,index)=>({...f,index})),entries:[],count:0,offset:0,body:null,body_state:t.files.length?'absent':'metadata',body_error:'',error:''}});return;}
    if(c.type==='preview_removal'){await route.fulfill({json:{revision:'fixture-1',target:c.target,deleting:[c.target.id],shared:[],protected:[],bytes:4294967296,names:[],shared_names:[],protected_names:[],used_by:[]}});return;}
    if(c.type==='remove'&&refuse){await route.fulfill({status:503,json:{error:'Removal refused by fixture'}});return;}
    const t=snapshot.transfers.find(t=>t.id===c.id);
    if(c.type==='remove')snapshot.transfers=snapshot.transfers.filter(t=>t.id!==c.id);
    if(c.type==='pause'&&t){t.active=false;t.state='Paused';}
    if(c.type==='resume'&&t){t.active=true;t.state='Downloading';}
    if(c.type==='approve_transfer'&&t){t.held=false;t.state='Downloading';}
    await route.fulfill({json:{ok:true}});
  });
  const publish=async()=>page.evaluate(s=>{
    (window as any).__libraryEvents.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)}));
  },snapshot);
  return {root,app,snapshot,commands,publish,refuse:(v:boolean)=>{refuse=v;}};
}

test('catalogue and compact live tooltip, responsive themes and torrent states',async({page,browser},info)=>{
  const f=await fixture(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(f.app.url+'/#/library');
    await expect(page.locator('.transfer')).toHaveCount(6);
    await expect(page.locator('#file-section')).toBeHidden();
    await expect(page.locator('#transfers .actions')).toHaveCount(0);
    const first=page.locator('.transfer').first(),help=first.getByRole('button');
    await help.hover();const tip=page.locator('#library-tooltip');await expect(tip).toBeVisible();
    await expect(tip).toContainText('↓ 2.4 MiB/s');await expect(tip).toContainText('↑ 84 KiB/s');
    await expect(tip).toContainText('12 peers');await expect(tip).not.toContainText('Downloaded');
    await expect(tip).not.toContainText('Status');await expect(tip).not.toContainText('Debian');
    await page.evaluate(()=>{(window as any).__libraryCard=document.querySelector('.transfer');});
    f.snapshot.transfers[0].down=5242880;f.snapshot.transfers[0].peers=9;await f.publish();
    await expect(tip).toContainText('↓ 5.0 MiB/s');
    expect(await page.evaluate(()=>(window as any).__libraryCard===document.querySelector('.transfer'))).toBe(true);
    await page.locator('#library-heading').click();await expect(tip).toBeHidden();await expect(page).toHaveURL(/#\/library$/);
    await help.click();await expect(tip).toBeVisible();await page.locator('#library-heading').click();await expect(tip).toBeHidden();
    for(const width of [1280,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
      await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const columns=await page.locator('#transfers').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(width===1280?3:1);
      await page.screenshot({path:info.outputPath(`catalogue-${width}-${theme}.png`),animations:'disabled'});
      await help.click();await expect(tip).toBeVisible();
      const box=(await tip.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
      await page.screenshot({path:info.outputPath(`tooltip-${width}-${theme}.png`),animations:'disabled'});
      await page.locator('#library-heading').click();
    }
    for(const t of f.snapshot.transfers){
      await page.locator(`[data-id="${t.id}"] .transfer-name`).click();
      await expect(page.locator('#torrent-heading')).toHaveText(t.name);
      await expect(page.locator('#library-detail .state')).toHaveText(t.state);
      await expect(page.locator('#torrent-approve')).toBeVisible({visible:t.held});
      if(t.error)await expect(page.locator('#torrent-error')).toContainText(t.error);
      expect(await page.locator('#transfers-nav').getAttribute('aria-current')).toBe('page');
      await page.locator('#library-back').click();await expect(page).toHaveURL(/#\/library$/);
    }
    const t=f.snapshot.transfers[0];
    await page.locator(`[data-id="${t.id}"] .transfer-name`).click();
    for(const width of [1280,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:740});await page.emulateMedia({colorScheme:theme});
      await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`detail-${width}-${theme}.png`),animations:'disabled'});
    }
    await page.evaluate(()=>{(window as any).__libraryEvents.onerror();});
    await expect(page.locator('#library-detail .content-totals .state')).toHaveText('Server disconnected');
    await expect(page.locator('#torrent-toggle')).toBeDisabled();await expect(page.locator('#torrent-more')).toBeDisabled();
    await page.locator('#library-back').click();await help.click();
    await expect(tip).toContainText('Server disconnected');await expect(tip).not.toContainText('/s');
    expect(errors).toEqual([]);console.log(info.project.name,browser.version());
  }finally{await cleanup(f.root,f.app);}
});

test('held magnet does not claim approval before metadata is known',async({page})=>{
  const f=await fixture(page);
  try{
    const t=f.snapshot.transfers[4];t.state='Waiting for metadata';t.files=[];t.total=0;t.verified=0;t.progress=0;
    await page.goto(f.app.url+'/#/library');
    const card=page.locator(`[data-id="${t.id}"]`);
    await card.getByRole('button').hover();
    const tip=page.locator('#library-tooltip');await expect(tip).toBeVisible();
    await expect(tip).not.toContainText('Download approval required.');
    await card.locator('.transfer-name').click();
    await expect(page.locator('#torrent-approve')).toBeHidden();
    t.state='Awaiting approval';t.files=[{name:'catalog.torrent',length:20*1048576,verified:0,ready:false}];t.total=t.files[0].length;
    await f.publish();
    await expect(page.locator('#torrent-approve')).toBeEnabled();
    await page.locator('#library-back').click();
    await card.getByRole('button').hover();
    await expect(tip).toContainText('Download approval required.');
  }finally{await cleanup(f.root,f.app);}
});

test('catalogue scroll survives Back, Forward, reload and direct detail links',async({page,context})=>{
  const f=await fixture(page,36);
  try{
    await page.goto(f.app.url+'/#/library');const t=f.snapshot.transfers[33];
    const link=page.locator(`#library-open-${t.id}`);
    await link.scrollIntoViewIfNeeded();const top=await page.evaluate(()=>scrollY);expect(top).toBeGreaterThan(500);
    await link.click();await expect(page).toHaveURL(new RegExp('#/library/'+t.id+'$'));
    expect(await page.evaluate(()=>scrollY)).toBe(0);
    await page.goBack();await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(top);
    await page.goForward();await expect(page.locator('#torrent-heading')).toHaveText(t.name);
    await page.reload();await expect(page.locator('#torrent-heading')).toHaveText(t.name);
    await page.locator('#library-back').click();await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(top);
    // A new tab has no catalogue origin in its history.
    const direct=await context.newPage();
    await direct.addInitScript(()=>{class Events extends EventTarget{};(window as any).EventSource=Events;});
    await direct.route('**/api/snapshot',r=>r.fulfill({json:f.snapshot}));
    await direct.route('**/api/commands',r=>{const c=r.request().postDataJSON();const t=f.snapshot.transfers.find(t=>t.id===c.id);return r.fulfill({json:{id:t.id,name:t.name,total:t.total,kind:'torrent',files:t.files.map((f,index)=>({...f,index})),entries:[],count:0,offset:0,body:null,body_state:'absent',body_error:'',error:''}});});
    await direct.goto(f.app.url+'/#/library/'+t.id);await expect(direct.locator('#torrent-heading')).toHaveText(t.name);
    await direct.locator('#library-back').click();await expect(direct).toHaveURL(/#\/library$/);await direct.close();
    await page.goto(f.app.url+'/#/library/not-registered');
    await expect(page.locator('#torrent-heading')).toHaveText('Torrent unavailable');await expect(page.locator('#file-section')).toBeHidden();
    await expect(page.locator('#torrent-remove')).toBeHidden();await page.locator('#library-back').click();
    await expect(page.locator('#library-catalog')).toBeVisible();
  }finally{await cleanup(f.root,f.app);}
});

test('detail retains commands, approval, file availability, removal failure and missing metadata',async({page})=>{
  const f=await fixture(page);
  try{
    const t=f.snapshot.transfers[4];await page.goto(f.app.url+'/#/library/'+t.id);
    await expect(page.locator('#torrent-approve')).toBeVisible();await page.locator('#torrent-approve').click();
    await expect(page.locator('#torrent-approve')).toBeHidden();expect(f.commands.at(-1)).toMatchObject({type:'approve_transfer',id:t.id});
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Pause');
    const files=page.locator('#library-reader .reader-row');await expect(files).toHaveCount(2);
    await expect(files.first().getByRole('button')).toBeDisabled();await expect(files.last().getByRole('button')).toBeEnabled();
    await files.last().getByRole('button').click();expect(f.commands.at(-1)).toMatchObject({type:'reveal',id:t.id,file:1});
    await expect(page.locator('#torrent-more')).toBeEnabled();await page.locator('#torrent-more').click();t.peers++;await f.publish();await expect(page.locator('#torrent-menu')).toBeVisible();await page.locator('#torrent-folder').click();expect(f.commands.at(-1)).toMatchObject({type:'reveal',id:t.id,file:null});await expect(page.locator('#torrent-menu')).toBeHidden();
    f.refuse(true);await page.locator('#torrent-more').click();await page.locator('#torrent-remove').click();await page.locator('#delete-files').check();
    await page.locator('#remove-form button[type=submit]').click();await expect(page.locator('#remove-error')).toContainText('Removal refused');
    await expect(page.locator('#delete-files')).toBeChecked();await expect(page).toHaveURL(new RegExp('#/library/'+t.id+'$'));
    f.refuse(false);await page.locator('#remove-form button[type=submit]').click();await expect(page).toHaveURL(/#\/library$/);
    expect(f.commands.at(-1)).toMatchObject({type:'remove',id:t.id,delete_files:true});
    await expect(page.locator('#remove-dialog')).toBeHidden();await expect(page.locator(`[data-id="${t.id}"]`)).toHaveCount(0);
    const unknown=f.snapshot.transfers[0];unknown.files=[];unknown.total=0;
    await f.publish();await page.locator(`[data-id="${unknown.id}"] .transfer-name`).click();
    await expect(page.locator('#library-reader .content-status')).toBeVisible();await expect(page.locator('#library-reader .reader-row')).toHaveCount(0);
    f.snapshot.transfers=f.snapshot.transfers.filter(t=>t.id!==unknown.id);await f.publish();
    await expect(page.locator('#torrent-heading')).toHaveText('Torrent unavailable');
    await expect(page.locator('#torrent-toggle')).toBeHidden();await expect(page.locator('#torrent-content')).toBeHidden();
  }finally{await cleanup(f.root,f.app);}
});
