import type {ImagePreferences,Snapshot} from './types.js';
import type {MarkdownNode} from './markdown.js';
export interface ImageContext {
  page:string;post?:string;route:string;availability:string;
  attachment:(path:string)=>string|null;
}
const preferences=():ImagePreferences=>snapshot?.image_preferences||{automatic:false,posts:{}};
let snapshot:Snapshot|null=null;
const panels=new Set<ImagePanel>();
const permissions=new Map<string,{all:boolean;urls:Set<string>}>();
export function imageState(state:Snapshot|null){
  snapshot=state;for(const panel of panels)panel.refresh();
}
export const activeImages=()=>[...panels].reverse().find(panel=>panel.current());
window.addEventListener('hashchange',()=>{for(const p of panels)if(!p.current())p.dispose();});
export function torrentImages(id:string,post:string|undefined,state:Snapshot|null):ImageContext {
  const t=state?.transfers.find(t=>t.id===id);
  return {page:`torrent/${post||''}/${id}`,post,route:location.hash,
    availability:JSON.stringify([t?.state,t?.error,t?.files.map(f=>[f.name,f.ready])]),
    attachment:path=>'./api/image?'+new URLSearchParams({context:'torrent',id,path})};
}
export function ownImages(id:string,page:number,revision:number,edits:number,saved:number):ImageContext {
  return {page:`own/${id}/${page}/${revision}/${edits}`,post:id,route:location.hash,
    availability:JSON.stringify([revision,edits===saved]),
    attachment:path=>edits===saved?'./api/image?'+new URLSearchParams({context:'own',id,page:String(page),revision:String(revision),path}):null};
}
type Phase='blocked'|'pending'|'loading'|'loaded'|'error';
type Row={root:HTMLElement;image:HTMLImageElement;label:HTMLElement;status:HTMLElement;button:HTMLButtonElement;remote:boolean;target:string;phase:Phase;request:number;abort?:AbortController;link?:()=>HTMLAnchorElement|null};
const element=(tag:string,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;};
const button=(text:string)=>{const b=element('button',text,'btn') as HTMLButtonElement;b.type='button';b.dataset.variant='outline';return b;};
const alt=(node:MarkdownNode):string=>node.kind==='br'?' ':(node.text||'')+(node.children||[]).map(alt).join('');
export class ImagePanel {
  private rows:Row[]=[];private lastAvailability='';private summary='';
  disposed=false;
  constructor(private context:ImageContext){panels.add(this);}
  get hasExternal(){return this.rows.some(row=>row.remote);}
  get pendingExternal(){return this.rows.some(row=>row.remote&&(row.phase==='blocked'||row.phase==='error'));}
  loadExternal(){
    if(!this.current()||!this.pendingExternal)return;
    this.grant().all=true;
    for(const row of this.rows)if(row.remote&&row.phase==='error')row.phase='blocked';
    this.refresh();
  }
  current(){return !this.disposed&&this.context.route===location.hash;}
  private grant(){let p=permissions.get(this.context.page);if(!p){p={all:false,urls:new Set()};permissions.set(this.context.page,p);}return p;}
  private allowed(row:Row){const p=preferences(),policy=this.context.post?p.posts[this.context.post]:undefined;
    const grant=permissions.get(this.context.page);return grant?.all||grant?.urls.has(row.target)||(policy==='always'||policy!=='ask'&&p.automatic);}
  update(context:ImageContext){this.context=context;this.refresh();}
  draw(node:MarkdownNode,link?:()=>HTMLAnchorElement|null):HTMLElement {
    const root=element('span','','markdown-image'),image=document.createElement('img'),description=alt(node);
    image.alt=description;image.decoding='async';image.referrerPolicy='no-referrer';image.hidden=true;
    const label=element('span',description||'Image','image-description'),status=element('span','','image-status muted'),load=button('Load image');
    root.append(label,status,load);
    let target=node.target||'',remote=/^https?:\/\//i.test(target);
    try{if(remote){const url=new URL(target);if(url.username||url.password)throw Error();target=url.href;}else target=decodeURIComponent(target);}catch{target='';remote=false;}
    const row:Row={root,image,label,status,button:load,remote,target,phase:target?(remote?'blocked':'pending'):'error',request:0,link};this.rows.push(row);
    load.onclick=e=>{e.preventDefault();e.stopPropagation();if(row.remote){this.grant().urls.add(row.target);row.phase='blocked';this.refresh();}else void this.loadAttachment(row);};
    this.paint(row);return root;
  }
  refresh(){
    if(!this.current())return;
    const changed=this.lastAvailability!==this.context.availability;this.lastAvailability=this.context.availability;
    for(const row of this.rows){
      if(row.remote&&row.phase==='blocked'&&this.allowed(row))this.loadImage(row,row.target);
      else if(!row.remote&&row.phase==='pending'&&changed)void this.loadAttachment(row);
      this.paint(row);
    }
    const summary=JSON.stringify([this.hasExternal,this.pendingExternal]);
    if(summary!==this.summary){this.summary=summary;document.dispatchEvent(new Event('reader-images-change'));}
  }
  private paint(row:Row){
    row.label.hidden=row.phase==='loaded';row.image.hidden=row.phase!=='loaded';
    row.status.textContent=row.phase==='blocked'?'External image':row.phase==='pending'?'Image is not downloaded and verified':row.phase==='loading'?'Loading image…':row.phase==='error'?'Could not load image':'';
    row.status.hidden=!row.status.textContent;
    row.button.hidden=!(row.target&&(row.phase==='error'||row.remote&&row.phase==='blocked'));
    row.button.textContent=row.phase==='error'?'Retry image':'Load image';
  }
  private loadImage(row:Row,url:string){
    if(!url||!this.current()||row.phase==='loading'||row.phase==='loaded')return;
    const request=++row.request;row.phase='loading';
    const image=row.image;
    if(image.parentElement?.tagName==='A')image.parentElement.remove();
    const parent=row.link?.();if(parent){parent.append(image);row.root.prepend(parent);}else row.root.prepend(image);
    image.onload=()=>{if(this.current()&&request===row.request){row.phase='loaded';this.paint(row);this.refresh();}};
    image.onerror=()=>{if(this.current()&&request===row.request){row.phase='error';image.removeAttribute('src');this.paint(row);this.refresh();}};
    image.src=url;this.paint(row);
  }
  private async loadAttachment(row:Row){
    if(!this.current()||row.phase==='loading'||row.phase==='loaded'||!row.target)return;
    const url=this.context.attachment(row.target);if(!url){row.phase='pending';this.paint(row);return;}
    const availability=this.context.availability;
    row.abort?.abort();const abort=new AbortController();row.abort=abort;const request=++row.request;row.phase='loading';this.paint(row);
    try{
      const response=await fetch(url+'&inspect=true',{signal:abort.signal});const result=await response.json();
      if(!this.current()||request!==row.request)return;
      if(!response.ok)throw Error('Image unavailable');
      row.phase='pending';if(result.state==='ready')this.loadImage(row,url);
    }catch(e){if(!abort.signal.aborted&&this.current()&&request===row.request)row.phase='error';}
    finally{if(this.current()&&request===row.request){this.paint(row);if(row.phase==='pending'&&availability!==this.context.availability)void this.loadAttachment(row);}}
  }
  dispose(){this.disposed=true;panels.delete(this);document.dispatchEvent(new Event('reader-images-change'));for(const row of this.rows){++row.request;row.abort?.abort();row.image.onload=null;row.image.onerror=null;row.image.removeAttribute('src');}}
}
