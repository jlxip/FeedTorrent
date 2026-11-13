import {size} from './reader.js';
import type {Peer, PeersData} from './types.js';
const node=(tag:string,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;};
let nextTooltip=0;
type Row={root:HTMLTableRowElement;country:HTMLButtonElement;flag:HTMLElement;address:HTMLElement;down:HTMLElement;up:HTMLElement};

/** Connection details are fetched only for the visible torrent, outside snapshots. */
export class PeerList {
  readonly root=node('section','','peer-list');
  private scroll=node('div','','peer-scroll');
  private body=document.createElement('tbody');
  private status=node('p','Loading peers…','muted peer-status');
  private rows=new Map<string,Row>();
  private counter?:HTMLElement;
  private tooltip=node('div','','peer-tooltip');
  private countryName=node('span');
  private anchor?:HTMLButtonElement;
  private leaveTimer?:ReturnType<typeof setTimeout>;
  private timer?:ReturnType<typeof setTimeout>;
  private read?:((id:string)=>Promise<PeersData>);
  private id='';private route='';private connected=false;private pending=false;private generation=0;
  private names=new Intl.DisplayNames(['en'],{type:'region'});
  constructor(){
    this.root.setAttribute('aria-label','Peers');this.root.hidden=true;
    const table=document.createElement('table');table.className='table peer-table';
    const head=document.createElement('thead'),tr=document.createElement('tr');
    for(const [text,label] of [['Peer','Peer'],['↓','Download per second'],['↑','Upload per second']]){
      const th=document.createElement('th');th.scope='col';th.textContent=text;th.setAttribute('aria-label',label);tr.append(th);
    }
    head.append(tr);table.append(head,this.body);this.scroll.append(table);
    this.status.setAttribute('role','status');
    this.tooltip.id=`peer-country-help-${++nextTooltip}`;this.tooltip.hidden=true;this.tooltip.setAttribute('role','tooltip');
    const credit=node('a','IP Geolocation by DB-IP') as HTMLAnchorElement;
    credit.href='https://db-ip.com';credit.target='_blank';credit.rel='noopener noreferrer';
    this.tooltip.append(this.countryName,credit);
    this.root.append(this.scroll,this.status,this.tooltip);
    this.tooltip.addEventListener('mouseenter',()=>clearTimeout(this.leaveTimer));
    this.tooltip.addEventListener('mouseleave',()=>this.leave());
    this.tooltip.addEventListener('focusout',()=>this.leave());
    window.addEventListener('scroll',()=>this.trackCountry(),true);
    window.addEventListener('resize',()=>this.hideCountry());
    document.addEventListener('pointerdown',e=>{if(!this.anchor?.contains(e.target as Node)&&!this.tooltip.contains(e.target as Node))this.hideCountry();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!this.tooltip.hidden){e.preventDefault();const anchor=this.anchor;anchor?.focus({preventScroll:true});this.hideCountry();}});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.suspend();else this.schedule(0);});
    window.addEventListener('hashchange',()=>{if(location.hash!==this.route)this.suspend();});
  }
  private hideCountry(){clearTimeout(this.leaveTimer);this.tooltip.hidden=true;this.anchor=undefined;}
  private leave(){
    clearTimeout(this.leaveTimer);this.leaveTimer=setTimeout(()=>{
      if(document.activeElement!==this.anchor&&!this.tooltip.contains(document.activeElement)&&!this.tooltip.matches(':hover'))this.hideCountry();
    },100);
  }
  private trackCountry(){
    if(!this.anchor)return;
    const rect=this.anchor.getBoundingClientRect(),scroll=this.scroll.getBoundingClientRect();
    if(rect.bottom<=Math.max(0,scroll.top)||rect.top>=Math.min(innerHeight,scroll.bottom))this.hideCountry();
    else this.showCountry(this.anchor);
  }
  private showCountry(anchor:HTMLButtonElement){
    clearTimeout(this.leaveTimer);this.anchor=anchor;this.countryName.textContent=anchor.dataset.country||'Country unknown';this.tooltip.hidden=false;
    const rect=anchor.getBoundingClientRect(),tip=this.tooltip.getBoundingClientRect();
    this.tooltip.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-tip.width-8))}px`;
    this.tooltip.style.top=`${Math.max(8,rect.bottom+6+tip.height<=innerHeight-8?rect.bottom+6:rect.top-tip.height-6)}px`;
  }
  setReader(read:(id:string)=>Promise<PeersData>){this.read=read;this.schedule(0);}
  setCounter(counter:HTMLElement){this.counter=counter;this.count(null);}
  private count(peers:Peer[]|null){if(this.counter)this.counter.textContent=peers?`${peers.filter(p=>p.connected).length} / ${peers.length} peers`:'— peers';}
  update(id:string|null,connected:boolean){
    const next=id||'',route=location.hash;
    if(next!==this.id||route!==this.route||connected!==this.connected){
      this.suspend();this.id=next;this.route=route;this.connected=connected;
      this.rows.clear();this.body.replaceChildren();this.scroll.scrollTop=0;
      this.count(null);
      this.message(connected?'Loading peers…':'Server disconnected');
    }
    this.root.hidden=!this.id;
    if(this.connected&&this.id)this.schedule(0);
  }
  private visible(){return !!(this.id&&this.connected&&!document.hidden&&location.hash===this.route&&this.root.getClientRects().length);}
  private suspend(){this.hideCountry();this.generation++;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
  private schedule(delay:number){
    if(this.timer!==undefined||this.pending||!this.id||!this.connected||!this.read)return;
    this.timer=setTimeout(()=>{this.timer=undefined;if(this.visible())void this.poll();},delay);
  }
  private message(text:string){if(text)this.hideCountry();this.status.textContent=text;this.status.hidden=!text;this.scroll.hidden=!!text;}
  private async poll(){
    if(!this.read||!this.visible()||this.pending)return;
    this.pending=true;const generation=this.generation,id=this.id;
    try{
      const value=await this.read(id);
      if(generation!==this.generation||!this.visible())return;
      if(value.id!==id||!Array.isArray(value.peers))throw Error('Peer list unavailable');
      this.draw(value.peers);
    }catch{
      if(generation===this.generation&&this.visible()){
        this.rows.clear();this.body.replaceChildren();this.message('Peer list unavailable');
        this.count(null);
      }
    }finally{this.pending=false;if(this.visible())this.schedule(1000);}
  }
  private draw(peers:Peer[]){
    this.count(peers);this.message(peers.length?'':'No known peers');
    const ordered=[...peers].sort((a,b)=>Number(b.connected)-Number(a.connected)||(a.connected?(b.down-a.down||b.up-a.up):0)||a.address.localeCompare(b.address)||a.port-b.port);
    const keys=new Set(ordered.map(p=>`${p.address}/${p.port}`)),top=this.scroll.scrollTop;
    for(const [key,row] of this.rows)if(!keys.has(key)){if(this.anchor===row.country)this.hideCountry();row.root.remove();this.rows.delete(key);}
    ordered.forEach((p,index)=>{
      const key=`${p.address}/${p.port}`;let row=this.rows.get(key);
      if(!row){
        const root=document.createElement('tr'),peer=document.createElement('td'),country=document.createElement('button'),flag=node('span'),address=node('span','','peer-address');
        country.type='button';country.className='peer-country';country.setAttribute('aria-describedby',this.tooltip.id);country.append(flag);
        country.addEventListener('mouseenter',()=>this.showCountry(country));country.addEventListener('focus',()=>this.showCountry(country));country.addEventListener('click',()=>this.showCountry(country));
        country.addEventListener('mouseleave',()=>this.leave());country.addEventListener('blur',()=>this.leave());
        peer.append(country,address);const down=document.createElement('td'),up=document.createElement('td');
        root.append(peer,down,up);row={root,country,flag,address,down,up};this.rows.set(key,row);
      }
      const code=p.country&&/^[A-Z]{2}$/.test(p.country)&&p.country!=='ZZ'?p.country:null;
      row.flag.textContent=code?String.fromCodePoint(...[...code].map(c=>127397+c.charCodeAt(0))):'🌐';
      const name=code?this.names.of(code)||code:'Country unknown';
      row.flag.setAttribute('role','img');row.flag.setAttribute('aria-label',code?`Approximate country: ${name}`:name);
      row.country.dataset.country=name;row.country.setAttribute('aria-label',`About country: ${name}`);
      if(this.anchor===row.country)this.countryName.textContent=name;
      row.address.textContent=p.address;row.down.textContent=p.connected?size(p.down)+'/s':'';row.up.textContent=p.connected?size(p.up)+'/s':'';
      const at=this.body.children[index];if(at!==row.root)this.body.insertBefore(row.root,at||null);
    });
    // Bound the first five actual rows, including wrapped IPv6 addresses.
    const height=()=>{const rows=[...this.body.children].slice(0,5);return rows.reduce((h,r)=>h+r.getBoundingClientRect().height,0)+(this.body.previousElementSibling?.getBoundingClientRect().height||0)+2;};
    this.scroll.style.maxHeight=`${height()}px`;
    this.scroll.style.maxHeight=`${height()}px`;
    this.scroll.scrollTop=top;
    this.trackCountry();
  }
}
