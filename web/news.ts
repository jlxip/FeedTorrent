import type {Command, NewsEntry, NewsPage, Snapshot} from "./types.js";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const node = (tag: string, value = "", cls = "") => {
  const e = document.createElement(tag); e.textContent = value; e.className = cls; return e;
};
type Position = {offset:number;anchor:string|null;scroll:number;focus:string|null};
export class NewsUI {
  private state: Snapshot|null = null;
  private connected = false;
  private active = false;
  private page: NewsPage|null = null;
  private offset = 0;
  private anchor: string|null = null;
  private signature = "";
  private request = 0;
  private busy = false;
  private rows = new Map<string, HTMLElement>();
  private pending = new Set<string>();
  constructor(private call: (c:Command,refresh?:boolean)=>Promise<any>) {
    $("news-refresh").onclick = () => this.first();
    $("news-previous").onclick = () => {
      this.offset = Math.max(0,this.offset-100);
      if (!this.offset) this.anchor = null;
      void this.load(true);
    };
    $("news-next").onclick = () => {this.offset += 100; void this.load(true);};
    $("new-nav").addEventListener("click", () => {
      this.offset = 0; this.anchor = null; this.page = null; this.signature = "";
      if (this.active) void this.load(true);
    });
    document.addEventListener("click", e => {
      const link=(e.target as Element).closest<HTMLAnchorElement>("a[href]");
      // WebKit mouse clicks need not focus an anchor. Preserve the chosen link explicitly.
      if (this.active && link) this.save(link.id||undefined);
    }, true);
  }
  private key(e: NewsEntry) {return `${e.feed}:${e.sequence}`;}
  private save(chosen?:string) {
    if (!this.active) return;
    const focus = chosen || (document.activeElement as HTMLElement|null)?.id || null;
    history.replaceState({...history.state,news:{offset:this.offset,anchor:this.anchor,scroll:scrollY,focus}}, "");
  }
  private first() {this.offset=0;this.anchor=null;void this.load(true);}
  private error(message: string) {
    $("news-error").hidden=!message; $("news-error").firstElementChild!.textContent=message;
  }
  render(state:Snapshot|null,connected:boolean) {
    this.state=state; this.connected=connected;
    const active=location.hash.split('/')[1] === 'new';
    const entering=active&&!this.active;
    if (!active && this.active) {this.request++;this.busy=false;}
    this.active=active;
    $("news-view").hidden=!active;
    $("news-feed-error").hidden=!state?.feed_error;
    $("news-feed-error").firstElementChild!.textContent=state?.feed_error||"";
    $("new-nav").setAttribute("aria-current",active?'page':'false');
    $("new-count").textContent=String(state?.news_unread||0);
    $("new-count").hidden=!state?.news_unread;
    $("new-count").setAttribute("aria-label",`${state?.news_unread||0} unread updates`);
    if (!active) return;
    if (entering) {
      const saved:Position|undefined=history.state?.news;
      this.offset=saved?.offset||0;this.anchor=saved?.anchor??null;
      this.signature="";
    }
    $("news-refresh").toggleAttribute("disabled",!connected||!state?.ready||this.busy);
    $("news-status").textContent=!connected?'Server disconnected':!state?.ready?'Starting…':this.busy&&!this.page?'Loading…':'';
    const signature=JSON.stringify([state?.news_revision,state?.feeds.map(f=>[f.id,f.name])]);
    if (connected&&state?.ready&&!this.busy&&signature!==this.signature) {
      this.signature=signature;void this.load(false,entering?history.state?.news:undefined);
    }
    this.draw();
  }
  private async load(top=false,restore?:Position) {
    if (!this.connected||!this.state?.ready||!this.active) return;
    const request=++this.request;
    this.busy=true;this.error("");
    this.draw();
    try {
      const page=await this.call({type:'news_page',offset:this.offset,anchor:this.anchor},false) as NewsPage;
      if (request!==this.request||!this.active) return;
      if (page.offset>0 && page.offset>=page.total) {
        this.offset=page.total?Math.floor((page.total-1)/100)*100:0;
        this.anchor=page.anchor;void this.load(top,restore);return;
      }
      this.page=page;this.offset=page.offset;this.anchor=page.anchor;
      this.draw();
      if (top) {scrollTo({top:0,behavior:"instant"});$("news-heading").setAttribute('tabindex','-1');$("news-heading").focus({preventScroll:true});}
      if (restore) requestAnimationFrame(()=> {
        if (this.active&&request===this.request) {
          scrollTo({top:restore.scroll,behavior:"instant"});if(restore.focus)document.getElementById(restore.focus)?.focus({preventScroll:true});
          this.save();
        }
      });
      if (!restore) this.save();
    } catch(e) {if(request===this.request)this.error(String(e));}
    finally {if(request===this.request){this.busy=false;this.draw();}}
  }
  private draw() {
    if (!this.active) return;
    $("news-refresh").toggleAttribute('disabled',!this.connected||this.busy||!this.state?.ready);
    $("news-previous").toggleAttribute('disabled',!this.connected||this.busy||!this.offset);
    $("news-next").toggleAttribute('disabled',!this.connected||this.busy||!this.page||this.offset+this.page.entries.length>=this.page.total);
    $("news-pages").hidden=!this.page?.total;
    $("news-empty").hidden=!this.page||!!this.page.entries.length;
    if (this.page) $("news-range").textContent=this.page.total?`${this.offset+1}–${this.offset+this.page.entries.length} / ${this.page.total}`:'';
    $("news-status").textContent=!this.connected?"Server disconnected":!this.state?.ready?"Starting…":this.busy&&!this.page?"Loading…":"";
    $("news-list").setAttribute("aria-busy",String(this.busy));
    const entries=this.page?.entries||[];
    let position=0;
    for(const [key,row] of this.rows) if(!entries.some(e=>this.key(e)===key)){row.remove();this.rows.delete(key);}
    for(const entry of entries) {
      const key=this.key(entry);
      let row=this.rows.get(key);
      if(!row) {
        row=node('article','','news-row');row.setAttribute('role','listitem');row.dataset.update=key;
        const a=document.createElement('a');a.className='btn news-title';a.dataset.variant='link';a.id=`news-open-${key}`;
        a.href=`#/feeds/${entry.feed}/${entry.catalog}/${entry.sequence}`;
        const feed=node('span','','news-feed muted');
        const date=node('time','','news-date muted');
        const status=node('span','','news-availability muted');
        const badge=node('span','','badge');badge.dataset.variant='secondary';
        const toggle=document.createElement('button');toggle.type='button';toggle.className='btn news-toggle';toggle.dataset.variant='ghost';toggle.id=`news-read-${key}`;
        toggle.onclick=async()=> {
          if(!this.connected||this.pending.has(key))return;
          this.pending.add(key);toggle.disabled=true;
          try {
            const current=this.page?.entries.find(e=>this.key(e)===key);if(!current)return;
            const read=!current.read;
            await this.call({type:'set_update_read',feed:current.feed,sequence:current.sequence,read});
            current.read=read;this.error('');
          } catch(e){this.error(String(e));}
          finally {this.pending.delete(key);this.draw();}
        };
        row.append(a,feed,date,status,badge,toggle);this.rows.set(key,row);$("news-list").append(row);
      }
      const at=$("news-list").children.item(position++);
      if(at!==row)$("news-list").insertBefore(row,at);
      const f=this.state?.feeds.find(f=>f.id===entry.feed);
      const c=f?.catalogs.find(c=>c.id===entry.catalog);
      row.querySelector('.news-title')!.textContent=c?.name||entry.name;
      row.querySelector('.news-feed')!.textContent=f?.name||entry.feed_name;
      row.dataset.read=String(entry.read);
      const date=row.querySelector('time')!;
      if(entry.detected_ms!==null && Number.isFinite(new Date(entry.detected_ms).getTime())) {
        const time=new Date(entry.detected_ms);
        date.dateTime=time.toISOString();date.textContent=`Detected ${time.toLocaleString()}`;
        date.setAttribute('aria-label',`Detected ${time.toLocaleString()}`);
      } else date.textContent='Detection time unavailable';
      row.querySelector('.news-availability')!.textContent=(c?.error||entry.error)||(c?.ready?'':c?.state||entry.state);
      row.querySelector('.badge')!.textContent=entry.read?'Read':'Unread';
      const toggle=row.querySelector<HTMLButtonElement>('.news-toggle')!;
      toggle.textContent=entry.read?'Mark unread':'Mark read';toggle.disabled=!this.connected||this.pending.has(key);
      toggle.setAttribute('aria-label',`${toggle.textContent}: ${c?.name||entry.name}`);
    }
  }
}
