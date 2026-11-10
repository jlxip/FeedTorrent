import type {Command, Snapshot, Transfer} from './types.js';
import {ContentReader, ContentPage, torrentRoute, type ContentHost} from './content.js';
import {ReaderHistory,canRestoreFocus} from './reader.js';

const $ = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id)! as T;
function node(tag:string, value='', cls='') {
  const e=document.createElement(tag);e.textContent=value;e.className=cls;return e;
}
function bytes(n:number) {
  if(n<1024)return `${n} B`;
  const units=['KiB','MiB','GiB','TiB'];let i=-1;
  do{n/=1024;i++;}while(n>=1024&&i<3);
  return `${n.toFixed(n<10?1:0)} ${units[i]}`;
}
// Lucide shapes from the locally vendored icon set; no remote assets or content.
function icon(name:'info'|'file'|'folder'|'rss') {
  const paths={info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder:'<path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>',
    rss:'<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(k,v);
  svg.innerHTML=paths[name];return svg;
}
function progress(t:Transfer, e:HTMLElement) {
  const value=Math.max(0,Math.min(1,t.progress));
  e.setAttribute('aria-valuenow',String(value));e.setAttribute('aria-label',`${t.name} download progress`);
  (e.firstElementChild as HTMLElement).style.width=`${value*100}%`;
}
const percent=(t:Transfer)=>`${Math.floor(Math.max(0,Math.min(1,t.progress))*100)}%`;
const total=(t:Transfer)=>t.files.length?bytes(t.approval_size??t.total):'—';
const amount=(t:Transfer)=>`${bytes(t.verified)} / ${total(t)}${t.approval_size!==null&&t.approval_size!==t.total?' incl. padding':''}`;
type Position={scroll:number;focus:string|null;token:string};
interface Host extends ContentHost {action:(c:Command)=>void;}

export class LibraryUI {
  private state:Snapshot|null=null;
  private connected=false;
  private route='';
  private restoring='';
  private pendingOrigin:string|null=null;
  private sidebarRoute='';
  private restoringSidebar=false;
  private cards=new Map<string,HTMLElement>();
  private reader=new ContentReader($('library-reader'),'library-reader',undefined,'torrent');
  private position=new ReaderHistory($('library-detail'),'torrentReader',$('torrent-heading'));
  private content:ContentPage;
  private tooltipId:string|null=null;
  private tooltipTrigger:HTMLButtonElement|null=null;
  private leaving:ReturnType<typeof setTimeout>|undefined;
  constructor(private host:Host) {
    this.content=new ContentPage(this.reader,host);
    $('library-back').onclick=e=>{
      if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&history.state?.libraryFrom){e.preventDefault();history.back();}
    };
    let saving:ReturnType<typeof setTimeout>|undefined;
    const later=()=>{clearTimeout(saving);saving=setTimeout(()=>this.save(),350);};
    window.addEventListener('scroll',()=>{later();this.positionTooltip();},{passive:true});
    window.addEventListener('resize',()=>this.positionTooltip());
    document.addEventListener('focusin',later);
    document.addEventListener('click',e=>{
      const link=(e.target as Element).closest<HTMLAnchorElement>('a[href]');
      this.sidebarRoute=link?.closest('#sidebar')&&matchMedia('(max-width:767px)').matches?new URL(link.href).hash:'';
      if(this.route==='#/library'&&location.hash==='#/library'&&link){
        this.save(link.id||undefined);
        if(link.classList.contains('transfer-name')&&e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey)
          this.pendingOrigin=history.state?.library?.token||null;
      }
    },true);
    const list=$('transfers'),tip=$('library-tooltip');
    const trigger=(target:EventTarget|null)=>(target instanceof Element?target.closest<HTMLButtonElement>('[data-library-info]'):null);
    list.addEventListener('pointerover',e=>{const b=trigger(e.target);if(b)this.showTooltip(b);});
    list.addEventListener('pointerout',e=>{if(trigger(e.target))this.leaveTooltip();});
    list.addEventListener('focusin',e=>{const b=trigger(e.target);if(b)this.showTooltip(b);});
    list.addEventListener('focusout',e=>{if(trigger(e.target))this.hideTooltip();});
    list.addEventListener('click',e=>{const b=trigger(e.target);if(b)this.showTooltip(b);});
    tip.addEventListener('pointerenter',()=>clearTimeout(this.leaving));
    tip.addEventListener('pointerleave',()=>this.leaveTooltip());
    document.addEventListener('pointerdown',e=>{
      if(!this.tooltipTrigger?.contains(e.target as Node)&&!tip.contains(e.target as Node))this.hideTooltip();
    });
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&this.tooltipId){e.preventDefault();e.stopImmediatePropagation();this.hideTooltip();}
    },true);
  }
  open(id?:string) {
    this.save();location.hash=id?`#/library/${encodeURIComponent(id)}`:'#/library';
  }
  removed(id:string) {
    if(this.currentId()===id){history.replaceState(history.state,'','#/library');this.render(this.state,this.connected);}
  }
  private currentId() {const parts=location.hash.split('/');return parts[1]==='library'?(torrentRoute()?.id||parts[2]||''):'';}
  private current() {return this.state?.transfers.find(t=>t.id===this.currentId());}
  private save(chosen?:string) {
    if(this.route!=='#/library'||location.hash!=='#/library'||this.restoring)return;
    const old:Position|undefined=history.state?.library;
    const focus=chosen||(document.activeElement as HTMLElement|null)?.id||null;
    if(old?.token&&old.scroll===scrollY&&old.focus===focus)return;
    history.replaceState({...history.state,library:{scroll:scrollY,focus,token:old?.token||crypto.randomUUID()}},'');
  }
  render(state:Snapshot|null,connected:boolean) {
    this.state=state;this.connected=connected;
    const route=location.hash,active=route.split('/')[1]==='library',catalog=route==='#/library';
    if(route!==this.route){
      this.hideTooltip();this.route=route;this.restoring=active?route:'';
      this.restoringSidebar=this.sidebarRoute===route;this.sidebarRoute='';
      if(active&&!catalog&&this.pendingOrigin)history.replaceState({...history.state,libraryFrom:this.pendingOrigin},'');
      this.pendingOrigin=null;
    }
    $('library-catalog').hidden=!catalog;$('library-detail').hidden=!active||catalog;
    if(!active){this.content.leave();this.position.leave();return;}
    const transfers=state?.transfers||[];
    $('count').textContent=`${transfers.length} torrent${transfers.length===1?'':'s'}`;
    $('empty').hidden=!!transfers.length||!state?.ready;
    this.drawCards(transfers);
    if(!catalog){this.position.enter();this.drawDetail();}else{this.content.leave();this.position.leave();}
    this.drawTooltip();
    if(this.restoring&&state){
      this.restoring='';if(!catalog)return;const saved:Position|undefined=catalog?history.state?.library:undefined;
      const fromSidebar=this.restoringSidebar,previousFocus=document.activeElement;
      requestAnimationFrame(()=>{
        if(location.hash!==route||!canRestoreFocus(previousFocus))return;
        const focus=saved?.focus?document.getElementById(saved.focus):null;
        // The mobile Sidebar owns focus when closing after its own navigation.
        if(!fromSidebar)(focus||$(catalog?'library-heading':'torrent-heading')).focus({preventScroll:true});
        scrollTo({top:saved?.scroll||0,behavior:'instant'});this.save(saved?.focus||undefined);
      });
    }
  }
  private drawCards(transfers:Transfer[]) {
    const list=$('transfers');
    for(const [id,card] of this.cards)if(!transfers.some(t=>t.id===id)){if(id===this.tooltipId)this.hideTooltip();card.remove();this.cards.delete(id);}
    let position=0;
    for(const t of transfers){
      let card=this.cards.get(t.id);
      if(!card){
        card=node('article','','card transfer');card.dataset.size='sm';card.dataset.id=t.id;
        const header=node('header'),title=node('h3'),link=document.createElement('a');
        link.className='transfer-name';link.id=`library-open-${t.id}`;link.href=`#/library/${encodeURIComponent(t.id)}`;title.append(link);
        const info=document.createElement('button');info.type='button';info.className='btn card-action library-info';info.dataset.variant='ghost';info.dataset.size='icon-sm';info.dataset.libraryInfo=t.id;info.append(icon('info'));
        header.append(title,info);
        const summary=node('section','','library-card-summary');summary.append(icon(t.kind==='catalog'?'rss':t.files.length>1?'folder':'file'),node('span','','muted library-size'));
        const footer=node('footer'),status=node('div','','library-card-status'),badge=node('span','','badge state');badge.dataset.variant='secondary';status.append(badge,node('span','','muted library-percent'));
        const bar=node('div','','progress');bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','1');bar.append(node('span'));
        footer.append(status,bar);card.append(header,summary,footer);this.cards.set(t.id,card);list.append(card);
      }
      const at=list.children.item(position++);if(at!==card)list.insertBefore(card,at);
      card.querySelector('.transfer-name')!.textContent=t.name;
      card.querySelector('.library-info')!.setAttribute('aria-label',`Status of ${t.name}`);
      card.querySelector('.library-size')!.textContent=total(t);
      const badge=card.querySelector<HTMLElement>('.state')!;badge.textContent=t.state;badge.dataset.variant=t.error?'destructive':'secondary';
      card.querySelector('.library-percent')!.textContent=percent(t);
      const bar=card.querySelector<HTMLElement>('.progress')!;progress(t,bar);bar.classList.toggle('complete',t.progress>=1);
      bar.setAttribute('aria-hidden',String(t.progress>=1));
    }
  }
  private drawDetail() {
    const nested=torrentRoute(),id=this.currentId(),crumbs=[];
    $('library-back').hidden=!!nested;
    if(nested){
      crumbs.push({name:'Library',href:'#/library'});
      const parts=location.hash.split('/');
      for(let i=2;i<parts.length-1;i++)if(/^[0-9a-f]{40}$/.test(parts[i]))crumbs.push({name:this.state?.transfers.find(t=>t.id===parts[i])?.name||'Catalog',href:parts.slice(0,i+1).join('/')});
    }
    this.content.render({id,parent:nested?.parent,state:this.state,connected:this.connected,crumbs,position:this.position,source:'Library'});
  }
  private showTooltip(trigger:HTMLButtonElement) {
    clearTimeout(this.leaving);
    if(this.tooltipTrigger!==trigger)this.hideTooltip();
    this.tooltipTrigger=trigger;this.tooltipId=trigger.dataset.libraryInfo!;
    trigger.setAttribute('aria-describedby','library-tooltip');this.drawTooltip();
  }
  private hideTooltip() {
    clearTimeout(this.leaving);$('library-tooltip').hidden=true;this.tooltipTrigger?.removeAttribute('aria-describedby');this.tooltipId=null;this.tooltipTrigger=null;
  }
  private leaveTooltip() {
    clearTimeout(this.leaving);this.leaving=setTimeout(()=>{if(document.activeElement!==this.tooltipTrigger&&!$('library-tooltip').matches(':hover'))this.hideTooltip();},100);
  }
  private drawTooltip() {
    if(!this.tooltipId)return;
    const t=this.state?.transfers.find(t=>t.id===this.tooltipId);if(!t){this.hideTooltip();return;}
    const tip=$('library-tooltip');tip.hidden=false;
    tip.querySelector('.tooltip-state')!.textContent=t.state;tip.querySelector('.tooltip-percent')!.textContent=percent(t);
    tip.querySelector('.tooltip-amount')!.textContent=amount(t);
    tip.querySelector('.tooltip-down')!.textContent=this.connected?`↓ ${bytes(t.down)}/s`:'↓ —';
    tip.querySelector('.tooltip-up')!.textContent=this.connected?`↑ ${bytes(t.up)}/s`:'↑ —';
    tip.querySelector('.tooltip-peers')!.textContent=this.connected?`${t.peers} peers`:'— peers';
    const message=[t.error,t.warning|| (t.held&&t.files.length?'Download approval required.':'')].filter(Boolean).join('\n');
    const warning=tip.querySelector<HTMLElement>('.tooltip-message')!;warning.textContent=message;warning.hidden=!message;
    tip.querySelector<HTMLElement>('.tooltip-offline')!.hidden=this.connected;this.positionTooltip();
  }
  private positionTooltip() {
    if(!this.tooltipTrigger||$('library-tooltip').hidden)return;
    const trigger=this.tooltipTrigger.getBoundingClientRect(),tip=$('library-tooltip');
    if(trigger.bottom<0||trigger.top>innerHeight){this.hideTooltip();return;}
    const rect=tip.getBoundingClientRect();
    tip.style.left=`${Math.max(8,Math.min(trigger.right-rect.width,innerWidth-rect.width-8))}px`;
    tip.style.top=`${Math.max(8,Math.min(trigger.bottom+8+rect.height<=innerHeight-8?trigger.bottom+8:trigger.top-rect.height-8,innerHeight-rect.height-8))}px`;
  }
}
