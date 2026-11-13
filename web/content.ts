import {PeerList} from './peers.js';
import {settingsButton} from './reader.js';
import {torrentImages} from './images.js';
import {Reader, ReaderHistory, size, type Crumb, type ReaderEntry} from './reader.js';
import type {Command, ContentData, Snapshot, Transfer, PostEntry, PostHistoryData} from './types.js';

const node=(tag:string,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;};
const button=(label:string)=>{const b=document.createElement('button');b.type='button';b.className='btn';b.textContent=label;return b;};
function glyph(kind:'pause'|'play'|'more'){
  const e=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))e.setAttribute(k,v);
  e.innerHTML=kind==='pause'?'<path d="M9 4H5v16h4zM19 4h-4v16h4z"/>':kind==='play'?'<path d="m6 3 14 9-14 9z"/>':'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>';
  return e;
}
type Menu=HTMLElement&{close:(focus?:boolean)=>void;refresh:()=>void};
export interface ContentHost {openMagnet:(uri:string)=>Promise<void>;call:(command:Command,refresh?:boolean)=>Promise<any>;remove:(id:string)=>void;download?:(id:string,command:Command)=>Promise<unknown>;follow?:(magnet:string)=>void;pin?:(id:string,pinned:boolean)=>Promise<unknown>|void;}
export interface Summary {
  title:string;id?:string;t?:Transfer;connected:boolean;total?:number|null;error?:string;warning?:string;info?:string;source?:string;
  download?:()=>Promise<unknown>;action?:(c:Command)=>Promise<unknown>;remove?:()=>void;noTorrent?:boolean;busy?:boolean;
  pin?:(id:string,pinned:boolean)=>Promise<unknown>|void;protectedNames?:string[];
  approval?:{id:string;ready:boolean};
}
export class ContentHeader {
  readonly peerList=new PeerList();
  readonly root=node('header','','content-heading');
  readonly identity=node('div','','content-identity');
  private defaultIdentity=node('div','','field-label reader-title');
  private title=node('h2');private gear:HTMLButtonElement;private info=button('ⓘ');private help=node('span','','field-tooltip');
  private sharing=node('section','','content-sharing');private controls=node('div','','content-controls');private meter=node('div','','content-meter');
  private totals=node('div','','content-totals');private status=node('span','','state');private percent=node('span');private amount=node('span','','muted');
  private bar=node('div','','progress');private fill=node('span');private toggle=button('');
  private menu=node('div','','dropdown-menu') as Menu;private more=button('');private folder=button('Show in Folder');private remove=button('Remove');
  private pin=button('Pin');private pinInfo=button('ⓘ');private pinTip=node('span','','field-tooltip pin-tooltip');
  private down=node('span');private up=node('span');private peers=node('span');private error=node('div','','alert');private warning=node('div','','alert');private approve=button('Download once');
  private value:Summary={title:'',connected:false,noTorrent:true};private failure='';private id='';private pending=false;private generation=0;
  constructor(private prefix:string,identity?:HTMLElement){
    this.peerList.setCounter(this.peers);
    this.gear=settingsButton(prefix);
    this.title.id=prefix+'-heading';this.title.tabIndex=-1;
    this.info.id=prefix+'-info';this.info.className='btn help-control';this.info.dataset.variant='ghost';this.info.dataset.size='icon-sm';
    this.help.id=prefix+'-help';this.help.hidden=true;this.help.setAttribute('role','tooltip');this.info.dataset.help=this.help.id;this.info.setAttribute('aria-describedby',this.help.id);
    this.defaultIdentity.append(this.title,this.info,this.gear,this.help);this.identity.append(this.defaultIdentity);
    this.sharing.setAttribute('aria-label','Torrent activity');this.totals.append(this.status,this.percent,this.amount);
    this.bar.setAttribute('role','progressbar');this.bar.setAttribute('aria-valuemin','0');this.bar.setAttribute('aria-valuemax','1');this.bar.append(this.fill);this.meter.append(this.totals,this.bar);
    this.toggle.id=prefix+'-toggle';this.toggle.dataset.size='icon-sm';this.toggle.classList.add('content-toggle');
    this.more.id=prefix+'-more';this.more.dataset.variant='ghost';this.more.dataset.size='icon-sm';this.more.setAttribute('aria-label','More torrent actions');this.more.setAttribute('aria-haspopup','menu');this.more.setAttribute('aria-expanded','false');this.more.append(glyph('more'));
    const pop=node('div','','content-popover'),items=node('div');pop.setAttribute('data-popover','');pop.setAttribute('aria-hidden','true');items.id=prefix+'-menu';items.setAttribute('role','menu');items.setAttribute('aria-labelledby',this.more.id);this.more.setAttribute('aria-controls',items.id);
    this.folder.id=prefix+'-folder';this.remove.id=prefix+'-remove';
    for(const b of [this.folder,this.remove]){b.setAttribute('role','menuitem');b.type='button';}this.remove.dataset.variant='destructive';
    const pinRow=node('div','','pin-menu-row');pinRow.setAttribute('role','none');
    this.pin.id=prefix+'-pin';this.pin.setAttribute('role','menuitemcheckbox');this.pin.setAttribute('aria-checked','false');
    this.pinInfo.id=prefix+'-pin-info';this.pinInfo.setAttribute('role','menuitem');this.pinInfo.setAttribute('aria-label','About Pin');this.pinInfo.dataset.help=prefix+'-pin-help';this.pinInfo.setAttribute('aria-describedby',prefix+'-pin-help');
    this.pinTip.id=prefix+'-pin-help';this.pinTip.hidden=true;this.pinTip.setAttribute('role','tooltip');this.pinTip.textContent='Keep in Library even if the original post is deleted.';
    this.root.append(this.pinTip);pinRow.append(this.pin,this.pinInfo);items.append(this.folder,pinRow,this.remove);pop.append(items);this.menu.append(this.more,pop);
    this.controls.append(this.meter,this.toggle,this.menu);const rates=node('div','','content-rates muted');rates.append(this.down,this.up,this.peers);
    this.error.id=prefix+'-error';this.error.dataset.variant='destructive';this.error.setAttribute('role','alert');this.error.append(node('section'));
    this.warning.setAttribute('role','status');this.warning.append(node('section'));this.approve.id=prefix+'-approve';
    this.sharing.append(this.controls,rates,this.peerList.root,this.error,this.warning,this.approve);this.root.append(this.identity,this.sharing);
    // WebKit touch may omit click on non-interactive text. Let Basecoat close
    // this menu on an outside touch, without changing its mouse/key handling.
    document.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'&&!this.menu.contains(event.target as Node))this.menu.close?.(false);});
    this.toggle.onclick=()=>{const m=this.value;if(m.t)void this.run(()=>m.action?.({type:m.t!.active?'pause':'resume',id:m.t!.id}));else if(m.download)void this.run(m.download);};
    // Close through Basecoat before pending disables menu items or a modal takes focus.
    this.folder.onclick=()=>{const value=this.value;this.menu.close?.();if(value.t)void this.run(()=>value.action?.({type:'reveal',id:value.t!.id,file:null}));};
    this.remove.onclick=()=>{const remove=this.value.remove;this.menu.close?.();queueMicrotask(()=>remove?.());};
    const positionPinHelp=()=>{const box=this.more.getBoundingClientRect();this.pinTip.style.left=`${Math.max(8,Math.min(innerWidth-272,box.right-256))}px`;this.pinTip.style.top=`${Math.max(8,Math.min(innerHeight-120,box.bottom+8))}px`;};
    this.pinInfo.addEventListener('mouseenter',positionPinHelp);this.pinInfo.addEventListener('focus',positionPinHelp);
    this.pinInfo.onclick=()=>queueMicrotask(()=>{this.menu.close?.();this.more.focus();positionPinHelp();this.pinTip.hidden=false;});
    this.pin.onclick=()=>{const t=this.value.t;this.menu.close?.();if(t)void this.run(()=>this.value.pin?.(t.id,!t.pinned));};
    this.approve.onclick=()=>{const id=this.value.approval?.ready?this.value.approval.id:this.value.t?.id;if(id)void this.run(()=>this.value.action?.({type:'approve_transfer',id}));};
    if(identity)this.adopt(identity);
  }
  init(){window.basecoat.init('dropdown-menu');}
  mountStatus(element:HTMLElement){this.sharing.append(element);}
  adopt(identity:HTMLElement){
    if(this.identity.firstElementChild===identity)return;
    this.identity.replaceChildren(identity);
    if(!identity.querySelector('.help-control'))identity.append(this.info,this.help);
    if(!identity.querySelector('.reader-settings'))identity.querySelector('.help-control')!.after(this.gear);
  }
  restoreIdentity(){this.defaultIdentity.append(this.info,this.gear,this.help);this.identity.replaceChildren(this.defaultIdentity);}
  private async run(fn:()=>Promise<unknown>|unknown){
    if(!this.value.connected||this.value.busy||this.pending)return;const generation=this.generation,focused=this.root.contains(document.activeElement)?document.activeElement as HTMLElement:null;this.failure='';this.pending=true;this.draw();
    try{await fn();}catch(e){if(generation===this.generation)this.failure=String(e);}finally{if(generation===this.generation){this.pending=false;this.draw();if(focused&&(document.activeElement===document.body||document.activeElement===focused))focused.focus({preventScroll:true});}}
  }
  update(value:Summary){
    const context=location.hash+'/'+(value.id||'');if(this.id!==context){this.id=context;this.generation++;this.pending=false;this.failure='';this.pinTip.hidden=true;this.menu.close?.(false);for(const tip of this.identity.querySelectorAll<HTMLElement>('[role=tooltip]'))tip.hidden=true;}
    this.value=value;this.draw();
  }
  private draw(){
    const m=this.value,t=m.t,enabled=m.connected&&!m.busy&&!this.pending;
    this.root.hidden=false;const heading=this.identity.querySelector('h2');if(heading)heading.textContent=m.title;
    const info=this.identity.querySelector<HTMLButtonElement>('.help-control')||this.info,help=this.identity.querySelector<HTMLElement>('.field-tooltip:not(.publication-tooltip)')||this.help;
    info.setAttribute('aria-label',`About ${m.title}`);help.textContent=[m.id,t?.save_path,m.source,m.info].filter(Boolean).join('\n');info.hidden=!help.textContent;
    this.sharing.hidden=!!m.noTorrent;
    this.peerList.update(m.noTorrent?null:t?.id||null,m.connected);
    const total=t?.files.length?t.approval_size??t.total:m.total;
    this.status.textContent=!m.connected?'Server disconnected':t?.state||'Not downloaded';
    this.percent.textContent=t?`${Math.floor(Math.max(0,Math.min(1,t.progress))*100)}%`:total!==undefined&&total!==null?'0%':'';
    this.amount.textContent=`${size(t?.verified||0)} / ${size(total)}`;
    this.bar.hidden=!t||t.progress>=1||!t.active||!m.connected||t.held||t.state!=='Downloading';
    this.bar.setAttribute('aria-label',`${m.title} download progress`);this.bar.setAttribute('aria-valuenow',String(t?.progress||0));this.fill.style.width=`${Math.max(0,Math.min(1,t?.progress||0))*100}%`;
    const label=t?(t.active?'Pause':'Resume'):'Download';this.toggle.setAttribute('aria-label',label);this.toggle.dataset.label=label;
    if(t){this.toggle.dataset.size='icon-sm';const signature=t.active?'pause':'play';if(this.toggle.dataset.icon!==signature){this.toggle.replaceChildren(glyph(signature));this.toggle.dataset.icon=signature;}}
    else{this.toggle.textContent='Download';delete this.toggle.dataset.icon;delete this.toggle.dataset.size;}
    this.toggle.hidden=!t&&!m.download;this.toggle.disabled=!enabled||(!t&&!m.download)||!!(t?.held&&!t.active);
    this.more.hidden=!t;this.more.disabled=!enabled;this.folder.disabled=!enabled||!t;this.remove.disabled=!enabled||!t||!!t.protected_by?.length;
    this.pin.disabled=!enabled||!t;this.pin.setAttribute('aria-checked',String(!!t?.pinned));
    const inherited=!t?.pinned&&!!t?.protected_by?.length;
    this.pinTip.textContent='Keep in Library even if the original post is deleted.'+(inherited?' Protected by Pin on '+(m.protectedNames||['another catalog']).join(', ')+'. Unpin that catalog first.':'');
    this.remove.setAttribute('aria-description',t?.protected_by?.length?'Protected by Pin. Unpin its source before deleting.':'');
    this.down.textContent=`↓ ${m.connected?size(t?.down||0)+'/s':'—'}`;this.up.textContent=`↑ ${m.connected?size(t?.up||0)+'/s':'—'}`;
    const approvalReady=!!(m.approval?.ready||(t?.held&&t.files.length));
    const error=[m.error,t?.error,this.failure].filter(Boolean).join('\n'),warning=[m.warning,t?.warning,approvalReady?'Download approval required.':''].filter(Boolean).join('\n');
    this.error.firstElementChild!.textContent=error;this.error.hidden=!error;this.warning.firstElementChild!.textContent=warning;this.warning.hidden=!warning;
    this.approve.hidden=!approvalReady;this.approve.disabled=!enabled;this.menu.refresh?.();
  }
}

export class ContentReader extends Reader {
  readonly header:ContentHeader;
  constructor(root:HTMLElement,prefix:string,identity?:HTMLElement,headerPrefix=prefix){
    super(root,prefix);this.header=new ContentHeader(headerPrefix,identity);root.insertBefore(this.header.root,this.body);this.header.init();
  }
}
/** Local published roots, fetched only while the post's History is open. */
export class PostHistory {
  readonly root:HTMLDetailsElement;
  private list=node('div');private key='';private route='';private signature='';private request=0;
  private kind:'own'|'followed'='own';private id='';private connected=false;
  constructor(private call:(c:Command,refresh?:boolean)=>Promise<any>,root?:HTMLDetailsElement){
    this.root=root||document.createElement('details');this.root.classList.add('reader-history','post-version-history');this.root.hidden=true;
    const summary=node('summary','History','btn');summary.dataset.variant='ghost';this.root.replaceChildren(summary,this.list);
    this.root.addEventListener('toggle',()=>{if(this.root.open)void this.load();else this.request++;});
    document.addEventListener('pointerdown',e=>{if(!this.root.contains(e.target as Node))this.root.open=false;});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')this.root.open=false;});
    window.addEventListener('hashchange',()=>{this.request++;this.root.open=false;});
  }
  update(kind:'own'|'followed',id:string|null,state:Snapshot|null,connected:boolean){
    const group=id?state?.library_posts?.find(p=>p.post_kind===kind&&p.id===id):undefined;
    const route=location.hash,key=group?`${kind}/${id}`:'';
    if(key!==this.key||route!==this.route){this.request++;this.root.open=false;this.list.replaceChildren();this.signature='';}
    this.key=key;this.route=route;this.kind=kind;this.id=id||'';this.root.hidden=!group;this.connected=connected;
    const signature=JSON.stringify([group,group?.catalog_ids.map(id=>{const t=state?.transfers.find(t=>t.id===id);return t&&[t.id,t.state,t.progress,t.total,t.pinned,t.error];}),connected]);
    if(this.signature!==signature){this.signature=signature;if(this.root.open)void this.load();}
  }
  private async load(){
    const request=++this.request,key=this.key,route=this.route;
    this.list.replaceChildren(node('p',this.connected?'Loading…':'Server disconnected','muted'));
    if(!key||!this.connected)return;
    try{
      const data=await this.call({type:'read_post_history',post_kind:this.kind,id:this.id},false) as PostHistoryData;
      if(request!==this.request||key!==this.key||route!==location.hash||!this.root.open)return;
      if(data.id!==this.id||data.post_kind!==this.kind||!Array.isArray(data.versions))throw Error('History unavailable');
      const rows=data.versions.map(v=>{
        const link=node('a','','btn') as HTMLAnchorElement;link.dataset.variant='ghost';link.href=`#/library/${v.id}`;
        const stamp=v.updated_at??v.created_at,valid=typeof stamp==='number'&&Number.isSafeInteger(stamp)&&stamp>=0&&stamp<=253402300799;
        link.append(node('span',valid?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(stamp*1000)):'Unknown date'),node('span',v.total===0&&!v.ready?'—':size(v.total)));
        if(v.pinned)link.append(node('span','Pin','badge'));if(v.error||!v.ready)link.append(node('span',v.error||v.state,'muted'));
        return link;
      });
      this.list.replaceChildren(...rows);if(!rows.length)this.list.append(node('p','No local published versions','muted'));
    }catch{if(request===this.request&&route===location.hash&&this.root.open)this.list.replaceChildren(node('p','History unavailable','muted'));}
  }
}

export const torrentRoute=()=>{
  const parts=location.hash.split('/'),at=parts.lastIndexOf('torrent');
  if(at<0||at+2!==parts.length||!/^[0-9a-f]{40}$/.test(parts[at+1]))return null;
  return {id:parts[at+1],parent:parts.slice(0,at).reverse().find(p=>/^[0-9a-f]{40}$/.test(p)),base:parts.slice(0,at).join('/')};
};
export interface PageOptions {
  id:string;parent?:string;post?:string;state:Snapshot|null;connected:boolean;crumbs:Crumb[];position?:ReaderHistory;
  load?:(offset:number)=>Promise<ContentData>;download?:(data:ContentData)=>Promise<unknown>;signature?:string;source?:string;shown?:(data:ContentData)=>Promise<unknown>;entryDownload?:(entry:PostEntry)=>Promise<unknown>;
}
export class ContentPage {
  private options:PageOptions|null=null;private data:ContentData|null=null;private key='';private signature='';private loading=false;private request=0;private error='';private offset=0;private adding=new Set<string>();
  private status=node('p','','content-status muted');private pager=node('nav','','catalog-pages');private previous=button('Previous');private next=button('Next');private range=node('span','','muted');
  private history=node('details','','reader-history') as HTMLDetailsElement;private historyLinks=node('div');
  constructor(private reader:ContentReader,private host:ContentHost){
    reader.header.peerList.setReader(id=>host.call({type:'read_peers',id},false));
    reader.header.mountStatus(this.status);this.status.setAttribute('role','status');this.pager.setAttribute('aria-label','Contents pages');this.pager.append(this.previous,this.range,this.next);reader.root.append(this.pager);
    this.previous.onclick=()=>this.move(-100);this.next.onclick=()=>this.move(100);
    const summary=node('summary','History','btn');summary.dataset.variant='ghost';this.history.append(summary,this.historyLinks);this.historyLinks.setAttribute('aria-label','Catalog history');reader.root.insertBefore(this.history,reader.body);
    document.addEventListener('pointerdown',e=>{if(!this.history.contains(e.target as Node))this.history.open=false;});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')this.history.open=false;});
  }
  leave(){this.request++;this.key='';this.signature='';this.options=null;this.loading=false;this.pager.hidden=true;this.status.hidden=true;this.history.hidden=true;this.history.open=false;}
  crumbs():Crumb[]{return this.options?[...this.options.crumbs,{name:this.data?.name||this.options.state?.transfers.find(t=>t.id===this.options!.id)?.name||'Torrent',href:this.key}]:[];}
  render(o:PageOptions){
    const key=location.hash;if(this.key!==key){this.request++;this.key=key;this.data=null;this.history.open=false;this.error='';this.signature='';this.loading=false;this.offset=o.position?.saved()?.offset||0;}
    this.options=o;this.draw();const t=o.state?.transfers.find(t=>t.id===o.id),parent=o.state?.transfers.find(t=>t.id===o.parent);
    const signature=JSON.stringify([o.id,o.parent,this.offset,o.signature,t?.state,t?.error,t?.files.map(f=>[f.name,f.ready]),parent?.state,parent?.files.map(f=>[f.name,f.ready])]);
    if(o.connected&&!this.loading&&signature!==this.signature){this.signature=signature;void this.load();}
  }
  private async load(){
    const o=this.options;if(!o)return;const request=++this.request,key=this.key;this.loading=true;this.draw();
    try{const data=o.load?await o.load(this.offset):await this.host.call({type:'read_content',id:o.id,parent:o.parent,offset:this.offset},false) as ContentData;
      if(request!==this.request||location.hash!==key)return;if(data.id!==o.id)throw Error('Content identity mismatch');this.data=data;this.error='';this.draw();if(o.shown)await o.shown(data);
    }catch(e){if(request===this.request&&location.hash===key)this.error=String(e);}
    finally{if(request===this.request&&location.hash===key){this.loading=false;this.draw();}}
  }
  private draw(){
    const o=this.options;if(!o)return;const registered=o.state?.transfers.find(t=>t.id===o.id),missing=!registered&&!o.parent&&!o.load&&!!o.state?.ready;
    const d=missing?null:this.data,t=o.parent&&!d?undefined:registered,title=missing||this.error&&!d?'Torrent unavailable':d?.name||t?.name||'Loading…';
    const download=d&&(!d.error)&&(o.download||d.source||d.source_uri)?()=>o.download?o.download(d):this.download(o.id,d.source?{type:'add_torrent',data:d.source}:{type:'add_magnet',uri:d.source_uri!},o.parent||o.id):undefined;
    this.reader.header.update({title,id:o.id,t,connected:o.connected,total:d?.total,error:this.error||d?.error,source:o.source,download,action:c=>this.host.call(c),remove:()=>this.host.remove(o.id),pin:this.host.pin,protectedNames:t?.protected_by?.map(id=>o.state?.transfers.find(t=>t.id===id)?.name||'catalog'),warning:d?.body_error});
    this.reader.breadcrumbs([...o.crumbs,{name:title,href:location.hash}],href=>o.position?.back(href));
    this.reader.dates(d);
    this.reader.content(`${o.id}/${d?.body_state}`,d?.body||null,target=>()=>void this.relative(target),torrentImages(o.id,o.post,o.state));
    this.status.hidden=false;this.status.textContent=this.loading&&!d?'Loading…':!o.connected?'Server disconnected':d?.body_state==='metadata'?'Waiting for metadata.':d?.body_state==='pending'?'Markdown is not downloaded and verified.':'';this.status.hidden=!this.status.textContent;
    const entries:ReaderEntry[]=d?.kind==='catalog'&&t?(d.entries||[]).map(e=>{
      const entry:ReaderEntry={key:String(e.index),name:e.name,kind:e.kind,size:e.total??(e.kind==='file'?e.length:null),error:e.error};
      if(e.kind==='torrent'||e.kind==='catalog'){entry.href=location.hash+'/torrent/'+e.infohash;entry.disabled=!e.infohash;
        if(e.infohash&&!o.state?.transfers.some(t=>t.id===e.infohash)&&!e.error){entry.label='Download';entry.actionDisabled=!o.connected||this.adding.has(e.infohash);entry.action=()=>void this.downloadEntry(e);}
      }
      else if(e.post_magnet){entry.label='Follow post';entry.disabled=!o.connected;entry.action=()=>this.host.follow?.(e.post_magnet!);}
      else if(e.kind==='file'){entry.label='Show in Folder';entry.disabled=!o.connected;entry.action=()=>void this.run({type:'reveal_entry',catalog:o.id,index:e.index});}
      return entry;
    }):(d?.files||[]).map(f=>({key:String(f.index),name:f.name,kind:'file',size:f.length,label:t?'Show in Folder':undefined,disabled:!o.connected||!t||!f.ready,action:()=>void this.run({type:'reveal',id:o.id,file:f.index})}));
    this.reader.entries(entries,!!d&&d.body_state!=='pending'&&d.body_state!=='metadata');
    this.pager.hidden=!d||d.count<=100;this.range.textContent=d?.count?`${this.offset+1}–${this.offset+(d.entries?.length||0)} / ${d.count}`:'';
    this.previous.disabled=!o.connected||this.loading||!this.offset;this.next.disabled=!o.connected||this.loading||!d||this.offset+(d.entries?.length||0)>=d.count;
    const historySignature=JSON.stringify([this.key,d?.previous,d?.archive]);
    if(this.history.dataset.signature!==historySignature){this.history.dataset.signature=historySignature;this.historyLinks.replaceChildren();
      for(const [label,id] of [['Previous version',d?.previous],['Archive',d?.archive]] as const)if(id){const a=document.createElement('a');a.href=this.key+'/torrent/'+id;a.textContent=label;a.className='btn';a.dataset.variant='ghost';this.historyLinks.append(a);}
    }
    this.history.hidden=!this.historyLinks.children.length;
    if(d){o.position?.patch({offset:this.offset});o.position?.restore();}
  }
  private async downloadEntry(entry:PostEntry){
    const o=this.options,route=this.key,id=entry.infohash;if(!o||!id||!o.connected||this.adding.has(id)||o.state?.transfers.some(t=>t.id===id))return;
    this.adding.add(id);this.draw();
    try{if(o.entryDownload){await o.entryDownload(entry);return;}const data=await this.host.call({type:'read_content',id,parent:o.id,offset:0},false) as ContentData;
      if(location.hash!==route)return;if(data.id!==id)throw Error('Content identity mismatch');
      if(data.source)await this.download(id,{type:'add_torrent',data:data.source});else throw Error('Torrent metadata unavailable');
    }catch(e){if(location.hash===route)this.error=String(e);}finally{this.adding.delete(id);if(location.hash===route)this.draw();}
  }
  private download(id:string,c:Command,parent=this.options?.id){if((c.type==='add_torrent'||c.type==='add_magnet')&&!c.origin&&parent)c={...c,origin:{kind:'catalog',parent}};return this.host.download?this.host.download(id,c):this.host.call(c);}
  private async run(c:Command){try{await this.host.call(c);}catch(e){this.error=String(e);this.draw();}}
  private move(delta:number){const o=this.options;if(!o||this.loading)return;o.position?.save();this.offset=Math.max(0,this.offset+delta);o.position?.patch({offset:this.offset,scroll:0,focus:null});this.signature='';this.render(o);scrollTo({top:0,behavior:'instant'});}
  private async relative(target:string){
    const o=this.options,d=this.data,route=location.hash;if(!o||!d)return;
    try{
      if(target.startsWith('magnet:')){await this.host.openMagnet(target);return;}
      const name=decodeURIComponent(target).replace(/^\.\//,'');if(!name||name.startsWith('/')||name.split('/').includes('..'))throw Error('Link unavailable');
      let entry=d.entries.find(e=>e.source_name===name);
      for(let offset=0;!entry&&offset<d.count;offset+=100){const page=await this.host.call({type:'read_content',id:o.id,parent:o.parent,offset},false) as ContentData;if(location.hash!==route)return;entry=page.entries.find(e=>e.source_name===name);}
      if(entry?.infohash&&(entry.kind==='catalog'||entry.kind==='torrent')){
        if(entry.kind==='torrent'&&!this.options?.state?.transfers.some(t=>t.id===entry!.infohash))await this.downloadEntry(entry);else location.hash=route+'/torrent/'+entry.infohash;return;
      }
      if(entry?.post_magnet){this.host.follow?.(entry.post_magnet);return;}
      if(entry?.kind==='file'){await this.run({type:'reveal_entry',catalog:o.id,index:entry.index});return;}
      const file=d.files.find(f=>f.name===name||f.name===d.name+'/'+name);if(file?.ready){await this.run({type:'reveal',id:o.id,file:file.index});return;}
      throw Error('Link unavailable');
    }catch(e){if(location.hash===route){this.error=String(e);this.draw();}}
  }
}
