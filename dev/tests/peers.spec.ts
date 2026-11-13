import {expect,test} from '@playwright/test';
import {join} from 'node:path';
import {cleanup,startApp,temporary} from './helpers.mjs';

async function fixture(page){
  const root=await temporary(),app=await startApp(join(root,'app')),snapshot=await app.api();
  snapshot.transfers=['a','b'].map(c=>({id:c.repeat(40),name:`Torrent ${c}`,state:'Downloading',error:'',warning:'',active:true,verified:100,total:1000,progress:.1,down:2000000,up:100000,peers:23,files:[{name:'data.bin',length:1000,verified:100,ready:false}],save_path:'/Downloads',held:false,approval_size:null,kind:'',post:null,pinned:false,protected_by:[],used_by:[]}));
  const calls:string[]=[],peers=Array.from({length:23},(_,i)=>({address:i===4?'2001:4860:4860:1234:5678:90ab:cdef:1234':`203.0.113.${i+1}`,port:4000+i,connected:i<17,down:i===16?0:(23-i)*1024*1024,up:i===16?0:(i+1)*1024,country:i===22?null:['DE','FR','ES'][i%3]}));
  let failure=false,hold:((()=>void)|null)=null,release:(()=>void)|null=null;
  await page.addInitScript(()=>{class Events extends EventTarget{onerror=null;constructor(){super();(window as any).peerEvents=this;}}(window as any).EventSource=Events;});
  await page.route('**/api/snapshot',route=>route.fulfill({json:snapshot}));
  await page.route('**/api/commands',async route=>{
    const c=route.request().postDataJSON(),t=snapshot.transfers.find(t=>t.id===c.id);
    if(c.type==='read_content')return route.fulfill({json:{id:c.id,name:t.name,total:1000,kind:'torrent',files:[{index:0,name:'data.bin',length:1000,ready:false}],entries:[],count:0,offset:0,body:null,body_state:'absent',body_error:'',error:''}});
    if(c.type==='read_peers'){
      calls.push(c.id);if(hold){const notify=hold;hold=null;await new Promise<void>(resolve=>{release=resolve;notify();});}
      return failure?route.fulfill({status:503,json:{error:'Engine busy'}}):route.fulfill({json:{id:c.id,peers:c.id[0]==='a'?peers:[{address:'8.8.8.8',port:53,connected:true,down:0,up:1024,country:'US'}]}});
    }
    if(c.type==='pause'||c.type==='resume'){t.active=c.type==='resume';t.state=t.active?'Downloading':'Paused';}
    return route.fulfill({json:{ok:true}});
  });
  const publish=()=>page.evaluate(s=>(window as any).peerEvents.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(s)})),snapshot);
  return {root,app,snapshot,calls,peers,publish,fail:(v:boolean)=>failure=v,hold:()=>new Promise<void>(resolve=>{hold=resolve;}),release:()=>release?.()};
}

test('compact peers preserve rows and scroll, wrap IPv6, retain errors and show both directions',async({page,browser},info)=>{
  const f=await fixture(page),errors:string[]=[],outside:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(f.app.url))outside.push(r.url());});
  try{
    await page.goto(f.app.url+'/#/library/'+f.snapshot.transfers[0].id);
    const list=page.locator('#library-reader .peer-list'),rows=list.locator('tbody tr'),scroll=list.locator('.peer-scroll');
    await expect(rows).toHaveCount(23);await expect(rows.first()).toContainText('23 MiB/s');
    const counter=page.locator('#library-reader .content-rates').getByText('17 / 23 peers',{exact:true});await expect(counter).toBeVisible();
    const idle=rows.filter({has:page.getByText('203.0.113.17',{exact:true})});await expect(idle.locator('td').nth(1)).toHaveText('0 B/s');await expect(idle.locator('td').nth(2)).toHaveText('0 B/s');
    for(let i=17;i<23;i++){const row=rows.filter({has:page.getByText(f.peers[i].address,{exact:true})});await expect(row.locator('td').nth(1)).toBeEmpty();await expect(row.locator('td').nth(2)).toBeEmpty();}
    await expect(rows.nth(16)).toContainText('203.0.113.17');
    await expect(rows.locator('td').first()).not.toContainText('Connected');await expect(list.getByRole('img',{name:'Country unknown'})).toBeVisible();
    await expect(list.getByText('IP Geolocation by DB-IP')).toBeHidden();
    const country=rows.first().getByRole('button',{name:'About country: Germany'}),tip=list.getByRole('tooltip');
    await country.hover();await expect(tip).toBeVisible();await expect(tip).toContainText('Germany');await expect(tip).not.toContainText('Approximate IP location');
    await expect(tip.getByRole('link',{name:'IP Geolocation by DB-IP'})).toHaveAttribute('href','https://db-ip.com');
    await page.keyboard.press('Escape');await expect(tip).toBeHidden();
    await country.blur();await country.focus();await expect(tip).toBeVisible();await page.keyboard.press('Escape');
    await country.click();await expect(tip).toBeVisible();await page.mouse.click(0,0);await expect(tip).toBeHidden();
    await country.click();await page.mouse.move(0,0);await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight;});await expect(tip).toBeHidden();
    await scroll.evaluate(e=>{e.scrollTop=0;});
    await page.evaluate(()=>{const list=document.querySelector('#library-reader .peer-list')!;(window as any).peerRow=list.querySelector('tbody tr');list.querySelector('.peer-scroll')!.scrollTop=120;});
    // Snapshot counters never override the peer response, even with stale totals.
    f.snapshot.transfers[0].peers=999;await f.publish();await expect(counter).toBeVisible();
    f.peers[0].connected=false;
    await expect(page.locator('#library-reader .content-rates')).toContainText('16 / 23 peers');
    const offline=rows.filter({has:page.getByText('203.0.113.1',{exact:true})});await expect(offline.locator('td').nth(1)).toBeEmpty();await expect(offline.locator('td').nth(2)).toBeEmpty();
    expect(await offline.evaluate(e=>e===(window as any).peerRow)).toBe(true);
    f.peers[0].connected=true;f.peers[0].down=24*1024*1024;
    await expect(rows.first()).toContainText('24 MiB/s');
    expect(await page.evaluate(()=>document.querySelector('#library-reader .peer-list tbody tr')===(window as any).peerRow)).toBe(true);
    expect(await scroll.evaluate(e=>e.scrollTop)).toBeGreaterThan(100);
    f.snapshot.transfers[0].name='Perfect.Days.2023.2160p.WEB.H265-'+('PancakeBreakfastPizzaLunchSteakDinner'.repeat(4));
    f.snapshot.transfers[0].error='Disk full (ENOSPC): /'+('directory'.repeat(50));
    f.snapshot.transfers[0].warning='ca1192 (https://tracker.'+('foreverpirates'.repeat(30))+'.co:443/announce) skipping tracker announce (unreachable)';await f.publish();
    for(const width of [2560,1280,1024,320])for(const theme of ['light','dark'] as const){
      await page.setViewportSize({width,height:800});await page.emulateMedia({colorScheme:theme});
      await expect.poll(()=>page.locator('html').evaluate(e=>e.classList.contains('dark'))).toBe(theme==='dark');
      await expect.poll(()=>scroll.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await list.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      const layout=await page.locator('#library-reader').evaluate(e=>{
        const identity=e.querySelector('.content-identity')!.getBoundingClientRect(),contents=e.querySelector('.reader-contents')!.getBoundingClientRect(),activity=e.querySelector('.content-sharing')!.getBoundingClientRect();
        return {gap:contents.top-identity.bottom,contentsRight:contents.right,contentsTop:contents.top,activityLeft:activity.left,activityBottom:activity.bottom};
      });
      if(width>=1100){expect(layout.gap).toBeGreaterThanOrEqual(0);expect(layout.gap).toBeLessThanOrEqual(24);expect(layout.contentsRight).toBeLessThanOrEqual(layout.activityLeft);}
      else expect(layout.contentsTop).toBeGreaterThanOrEqual(layout.activityBottom);

      for(const alert of await page.locator('#library-reader .content-sharing .alert:visible').all())expect(await alert.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      const flag=rows.first().getByRole('button');await flag.click();await expect(tip).toBeVisible();
      await page.waitForTimeout(1100);await expect(tip).toBeVisible();
      expect(await tip.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
      await page.screenshot({path:info.outputPath(`country-${width}-${theme}.png`),animations:'disabled'});
      await page.keyboard.press('Escape');
      expect(await rows.evaluateAll(rs=>rs.every(r=>{const cells=[...r.children].map(c=>c.getBoundingClientRect());return cells[0].right<=cells[1].left+1&&cells[1].right<=cells[2].left+1;}))).toBe(true);
      expect(await list.locator('.peer-address').evaluateAll(spans=>spans.every(span=>{const cell=span.parentElement!.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(span);return [...range.getClientRects()].every(rect=>rect.right<=cell.right+1);}))).toBe(true);
      await scroll.evaluate(e=>{e.scrollTop=0;});await page.screenshot({path:info.outputPath(`peers-${width}-${theme}.png`),animations:'disabled'});
    }
    f.snapshot.transfers[0].error='Disk full (ENOSPC)';f.snapshot.transfers[0].warning='Tracker unavailable';await f.publish();
    await expect(page.locator('#torrent-error')).toContainText('ENOSPC');await expect(list).toBeVisible();await expect(page.locator('#library-reader .alert').last()).toContainText('Tracker unavailable');
    f.snapshot.transfers[0].held=true;await f.publish();await expect(page.locator('#torrent-approve')).toBeVisible();f.snapshot.transfers[0].held=false;await f.publish();
    f.fail(true);await expect(list).toContainText('Peer list unavailable');await expect(page.locator('#library-reader .content-rates')).toContainText('— peers');f.fail(false);f.peers.splice(0);await expect(list).toContainText('No known peers');await expect(page.locator('#library-reader .content-rates')).toContainText('0 / 0 peers');
    await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Resume');await page.locator('#torrent-toggle').click();await expect(page.locator('#torrent-toggle')).toHaveAccessibleName('Pause');
    expect(errors).toEqual([]);expect(outside).toEqual([]);console.log(info.project.name,browser.version());
  }finally{f.release();await cleanup(f.root,f.app);}
});

test('peer polling stops off-screen, does not overlap and ignores old torrent replies',async({page})=>{
  const f=await fixture(page);
  try{
    await page.goto(f.app.url+'/#/library/'+f.snapshot.transfers[0].id);const list=page.locator('#library-reader .peer-list');await expect(list.locator('tbody tr')).toHaveCount(23);
    const held=f.hold();await held;const count=f.calls.length;
    await page.waitForTimeout(1200);expect(f.calls).toHaveLength(count);
    await page.evaluate(hash=>location.hash=hash,'#/library/'+f.snapshot.transfers[1].id);f.release();
    await expect(list.locator('tbody tr')).toHaveCount(1);await expect(list).toContainText('8.8.8.8');await expect(page.locator('#library-reader .content-rates')).toContainText('1 / 1 peers');await expect(list).not.toContainText('203.0.113');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    const hidden=f.calls.length;await page.waitForTimeout(1200);expect(f.calls).toHaveLength(hidden);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await expect.poll(()=>f.calls.length).toBeGreaterThan(hidden);
    await page.evaluate(()=>{(window as any).peerEvents.onerror();});await expect(list).toContainText('Server disconnected');await expect(list.locator('tbody tr')).toHaveCount(0);await expect(page.locator('#library-reader .content-rates')).toContainText('— peers');
    await f.publish();await expect(list.locator('tbody tr')).toHaveCount(1);
    await page.evaluate(()=>location.hash='#/library');await expect(list).toBeHidden();
    const away=f.calls.length;await page.waitForTimeout(1200);expect(f.calls).toHaveLength(away);
  }finally{f.release();await cleanup(f.root,f.app);}
});
