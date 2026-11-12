import type {Command,PostConfig,PostMode,Snapshot} from './types.js';
import {markdown, type MarkdownNode} from './markdown.js';
import {activeImages,ImagePanel,type ImageContext} from './images.js';
export interface ReaderDates {created_at?:number|null;updated_at?:number|null;last_published?:boolean;}
export type Crumb={name:string;href:string};
export interface ReaderEntry {
  key:string; name:string; kind:string; size?:number|null; href?:string;
  prepare?:()=>void; action?:()=>void; label?:string; disabled?:boolean; actionDisabled?:boolean; error?:string;
}
const node=(tag:string,value='',cls='')=>{const e=document.createElement(tag);e.textContent=value;e.className=cls;return e;};
export const size=(n:number|null|undefined)=>{
  if(n===null||n===undefined)return '—';const u=['B','KiB','MiB','GiB','TiB'];let i=0;
  while(n>=1024&&i<4){n/=1024;i++;}return `${n.toFixed(i&&n<10?1:0)} ${u[i]}`;
};
export const plainClick=(e:MouseEvent)=>e.button===0&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey;
export type ReadingPosition={route:string;catalog?:string;offset?:number;trail?:Crumb[];scroll?:number;focus?:string|null};
// Delayed history restoration must yield to a newer focus choice, including
// menus/dialogs already opened while asynchronous content was loading.
export function canRestoreFocus(previous:Element|null){
  const current=document.activeElement;
  if(current?.closest('dialog[open],.dropdown-menu:has(>button[aria-expanded="true"])'))return false;
  return !current||current===previous||current===document.body||current===document.documentElement;
}
// One entry per browser history position, never another persisted content inventory.
export class ReaderHistory {
  private route='';private pending=false;private data:ReadingPosition={route:''};
  private entryFocus:Element|null=null;
  private origin:{target:string;from:string}|null=null;
  constructor(private root:HTMLElement,private key:string,private heading:HTMLElement){
    let queued:ReturnType<typeof setTimeout>|undefined;
    const later=()=>{clearTimeout(queued);queued=setTimeout(()=>this.save(),350);};
    window.addEventListener('scroll',later,{passive:true});
    document.addEventListener('focusin',later);
    document.addEventListener('click',e=>{if(this.active()){const a=(e.target as Element).closest<HTMLElement>('a[href],button,summary');if(a)this.save(a.id);
      if(a instanceof HTMLAnchorElement&&plainClick(e)&&new URL(a.href).origin===location.origin&&new URL(a.href).hash.includes('/torrent/'))this.origin={target:new URL(a.href).hash,from:location.hash};
    }},true);
  }
  leave(){this.route='';this.pending=false;}
  saved():ReadingPosition|undefined {const p=history.state?.[this.key];return p?.route===location.hash?p:undefined;}
  enter(){
    if(this.route===location.hash)return;
    const saved=this.saved(),state={...history.state};
    if(this.origin?.target===location.hash)state[this.key+'From']=this.origin.from;
    else if(!saved)delete state[this.key+'From'];
    history.replaceState(state,'');this.origin=null;
    this.route=location.hash;this.pending=true;this.entryFocus=document.activeElement;this.data={...saved,route:this.route};
  }
  back(href:string){if(history.state?.[this.key+'From']===href){history.back();return true;}return false;}
  patch(p:Partial<ReadingPosition>){this.data={...this.data,...p,route:this.route};this.store();}
  private active(){return this.route===location.hash&&!!this.root.getClientRects().length;}
  private store(){if(this.route===location.hash&&JSON.stringify(history.state?.[this.key])!==JSON.stringify(this.data))history.replaceState({...history.state,[this.key]:this.data},'');}
  save(chosen?:string){if(!this.active()||this.pending)return;this.data={...this.data,scroll:scrollY,focus:chosen||(document.activeElement as HTMLElement|null)?.id||null};this.store();}
  restore(){
    if(!this.pending||!this.active())return;this.pending=false;
    const route=this.route,data={...this.data},previousFocus=this.entryFocus;
    requestAnimationFrame(()=>{
      if(location.hash!==route||!this.active()||!canRestoreFocus(previousFocus))return;
      // Preserve the native Sidebar focus return on mobile navigation.
      if(!(matchMedia('(max-width:767px)').matches&&document.activeElement?.id==='sections-button'))
        (data.focus?document.getElementById(data.focus):null)?.focus({preventScroll:true});
      if(!data.focus&&!matchMedia('(max-width:767px)').matches){this.heading.tabIndex=-1;this.heading.focus({preventScroll:true});}
      scrollTo({top:data.scroll||0,behavior:'instant'});this.save(data.focus||undefined);
    });
  }
}
export class Reader {
  readonly body=node('div','','reader-body');
  private dateRow=node('div','','reader-dates');
  readonly crumbs=node('nav','','breadcrumb reader-breadcrumb');
  private contents=node('section','','reader-contents');
  private list=node('div','','reader-entries');
  private empty=node('div','','empty');
  private rows=new Map<string,HTMLElement>();private bodySignature='';private hasBody=false;private images:ImagePanel|null=null;
  constructor(readonly root:HTMLElement,private prefix:string){
    this.crumbs.setAttribute('aria-label','Page');
    this.contents.append(node('h3','Contents'),this.list);
    const header=node('header');header.append(node('h3','No items'));this.empty.append(header);this.empty.setAttribute('role','status');
    root.classList.add('reader');root.append(this.crumbs,this.dateRow,this.body,this.contents,this.empty);this.dateRow.hidden=true;
  }
  breadcrumbs(crumbs:Crumb[],prepare?:(href:string)=>boolean|void){
    const signature=JSON.stringify(crumbs);if(this.crumbs.dataset.signature===signature)return;
    this.crumbs.dataset.signature=signature;this.crumbs.hidden=crumbs.length<2;this.crumbs.replaceChildren();
    const ol=node('ol');crumbs.forEach((c,i)=>{
      if(i){const sep=node('li','/');sep.setAttribute('aria-hidden','true');ol.append(sep);}
      const li=node('li');if(i===crumbs.length-1){const s=node('span',c.name);s.setAttribute('aria-current','page');li.append(s);}
      else{const a=document.createElement('a');a.id=`${this.prefix}-crumb-${i}`;a.href=c.href;a.textContent=c.name;a.onclick=e=>{if(plainClick(e)&&prepare?.(c.href)===true)e.preventDefault();};li.append(a);}ol.append(li);
    });this.crumbs.append(ol);
  }
  dates(value:ReaderDates|null|undefined){
    // These are author-declared dates; formatting always uses the reader's local zone.
    const valid=(n:number|null|undefined)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=253402300799;
    const created=valid(value?.created_at)?value!.created_at!:null,updated=valid(value?.updated_at)?value!.updated_at!:null;
    const formatter=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
    const signature=JSON.stringify([created,updated,!!value?.last_published,Intl.DateTimeFormat().resolvedOptions().timeZone]);
    this.root.insertBefore(this.dateRow,this.body);
    if(this.dateRow.dataset.signature===signature)return;this.dateRow.dataset.signature=signature;
    this.dateRow.replaceChildren();this.dateRow.hidden=created===null&&updated===null&&!value?.last_published;
    const field=(label:string,seconds:number|null)=>{const group=node('span');group.append(node('span',label+' '));
      if(seconds===null)group.append(node('span','unknown'));
      else {const time=document.createElement('time');time.dateTime=new Date(seconds*1000).toISOString();time.textContent=formatter.format(new Date(seconds*1000));group.append(time);}
      this.dateRow.append(group);
    };
    if(!this.dateRow.hidden){field('Created',created);
      if(updated!==null||value?.last_published){const dot=node('span','·');dot.setAttribute('aria-hidden','true');this.dateRow.append(dot);field('Updated',updated);}
      if(value?.last_published){const badge=node('span','Last published version','badge');badge.dataset.variant='secondary';this.dateRow.append(badge);}
    }
  }
  content(key:string,tree:MarkdownNode|null,relative?:(target:string)=>(()=>void)|null,images?:ImageContext){
    const signature=JSON.stringify([key,tree,images?.page]);if(signature===this.bodySignature&&!this.images?.disposed){if(images)this.images?.update(images);return;}
    this.images?.dispose();this.images=images&&tree?new ImagePanel(images):null;
    this.bodySignature=signature;this.body.replaceChildren();this.hasBody=!!tree?.children?.length;
    if(tree)this.body.append(markdown(tree,relative,this.images||undefined));
    if(this.images){this.images.refresh();}
    this.body.querySelectorAll('a').forEach((a,index)=>a.id=`${this.prefix}-body-${index}`);
    this.body.hidden=!this.hasBody;
  }
  entries(entries:ReaderEntry[],ready:boolean){
    for(const [key,row] of this.rows)if(!entries.some(e=>e.key===key)){row.remove();this.rows.delete(key);}
    let index=0;
    for(const e of entries){
      let row=this.rows.get(e.key);
      if(!row){row=node('article','','reader-row catalog-row');row.dataset.entry=e.key;
        row.append(node('span','','reader-icon'),node('div','','reader-name'),node('span','','reader-size muted'),node('div','','reader-action'),node('p','','reader-error transfer-error'));
        this.rows.set(e.key,row);this.list.append(row);
      }
      const at=this.list.children.item(index++);if(at!==row)this.list.insertBefore(row,at);
      const glyph=row.querySelector<HTMLElement>('.reader-icon')!;
      if(glyph.dataset.kind!==e.kind){
        glyph.dataset.kind=e.kind;
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(k,v);
        svg.innerHTML=e.kind==='external_post'?'<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>';
        glyph.replaceChildren(svg);
      }
      const name=row.querySelector<HTMLElement>('.reader-name')!;
      let title=name.firstElementChild as HTMLElement|null;
      if(!title||(e.href?title.tagName!=='A':title.tagName!=='SPAN')){
        title=node(e.href?'a':'span','','entry-name');title.id=`${this.prefix}-entry-${e.key}`;name.replaceChildren(title);
      }
      title.textContent=e.name;
      if(title instanceof HTMLAnchorElement){title.href=e.href!;title.setAttribute('aria-disabled',String(!!e.disabled));title.onclick=ev=>{if(e.disabled){ev.preventDefault();return;}if(plainClick(ev))e.prepare?.();};}
      row.querySelector('.reader-size')!.textContent=e.kind==='page'||e.kind==='external_post'?'':size(e.size);
      const action=row.querySelector<HTMLElement>('.reader-action')!;
      if(e.label){let b=action.firstElementChild as HTMLButtonElement|null;if(!b){b=document.createElement('button');b.type='button';b.className='btn';action.append(b);}
        b.id=`${this.prefix}-action-${e.key}`;b.setAttribute('aria-label',e.label);
        if(b.dataset.label!==e.label){b.dataset.label=e.label;b.textContent=e.label;
          if(e.label==='Show in Folder'){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
            for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(k,v);
            svg.innerHTML='<path d="m6 14 2-4h14l-4 10H2V4h6l2 3h10v3"/>';b.replaceChildren(svg);b.dataset.size='icon-sm';
          }else delete b.dataset.size;
        }b.disabled=!!(e.actionDisabled??e.disabled);b.dataset.variant=e.label==='Download'?'default':'outline';b.onclick=()=>e.action?.();
      }else action.replaceChildren();
      const error=row.querySelector<HTMLElement>('.reader-error')!;error.textContent=e.error||'';error.hidden=!e.error;
    }
    this.contents.hidden=!entries.length;this.empty.hidden=!ready||!!entries.length||this.hasBody;
  }
}

type Field='name'|'mode'|'limit'|'policy';
type Policy='inherit'|'always'|'ask';
interface Draft {
  name:string;mode:PostMode;limit:string;unlimited:boolean;policy:Policy;
  dirty:Map<Field,number>;version:number;busy:boolean;error:string;timer?:ReturnType<typeof setTimeout>;
}
interface Target {id?:string;followed:boolean;route:string;}
interface Host {call:(command:Command)=>Promise<unknown>;remove:(id:string,trigger:HTMLElement)=>void;}
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
let snapshot:Snapshot|null=null,connected=false,host:Host;
let selected:Target|null=null;
const drafts=new Map<string,Draft>();
const dialog=()=>$<HTMLDialogElement>('reader-settings-dialog');
const followed=(id:string)=>snapshot?.posts.find(post=>post.id===id);
function target():Target|null {
  const [,kind,id]=location.hash.split('/');
  if(kind==='own'&&snapshot?.publishing.posts.some(post=>post.id===id))return {id,followed:false,route:location.hash};
  if(kind==='posts'&&id&&followed(id))return {id,followed:true,route:location.hash};
  if(kind==='library'&&activeImages()?.hasExternal)return {followed:false,route:location.hash};
  return null;
}
function rebase(id:string):Draft {
  const post=followed(id),policy=snapshot?.image_preferences.posts[id]||'inherit';
  let draft=drafts.get(id);
  if(!draft){draft={name:'',mode:'current_catalog',limit:'8',unlimited:false,policy:'inherit',dirty:new Map(),version:0,busy:false,error:''};drafts.set(id,draft);}
  if(!draft.dirty.has('name'))draft.name=post?.local_name||'';
  if(!draft.dirty.has('mode'))draft.mode=post?.mode||'current_catalog';
  if(!draft.dirty.has('limit')){draft.unlimited=post?.automatic_limit===null;draft.limit=String(post?.automatic_limit==null?8:post.automatic_limit/1048576);}
  if(!draft.dirty.has('policy'))draft.policy=policy;
  return draft;
}
function validLimit(draft:Draft){const mib=Number(draft.limit);return draft.unlimited||Number.isSafeInteger(mib)&&mib>=1&&Number.isSafeInteger(mib*1048576);}
function fill(draft:Draft){
  $<HTMLInputElement>('reader-post-name').value=draft.name;
  $<HTMLSelectElement>('reader-post-mode').value=draft.mode;
  $<HTMLInputElement>('reader-post-limit').value=draft.limit;
  $<HTMLInputElement>('reader-post-unlimited').checked=draft.unlimited;
  $<HTMLSelectElement>('reader-image-policy').value=draft.policy;
}
function refresh(){
  const current=target();
  for(const button of document.querySelectorAll<HTMLButtonElement>('.reader-settings')){
    button.hidden=!current;button.disabled=!connected||!snapshot?.ready;
    button.setAttribute('aria-label',current?.id?'Post settings':'Reader settings');
  }
  if(!dialog().open||!selected)return;
  if(selected.route!==location.hash||selected.id&&(!current||current.id!==selected.id)){dialog().close();return;}
  const post=selected.id?followed(selected.id):undefined,draft=selected.id?rebase(selected.id):null;
  if(draft)fill(draft);
  $('reader-following-settings').hidden=!selected.followed;
  $('reader-image-policy-field').hidden=!selected.id;
  $('reader-settings-title').textContent=selected.id?'Post settings':'Reader settings';
  $<HTMLInputElement>('reader-post-magnet').value=post?.magnet||'';
  const ready=connected&&!!snapshot?.ready;
  for(const input of dialog().querySelectorAll<HTMLInputElement|HTMLSelectElement>('input:not([readonly]),select'))input.disabled=!ready;
  $<HTMLInputElement>('reader-post-limit').disabled=!ready||!!draft?.unlimited;
  const invalid=!!draft?.dirty.has('limit')&&!validLimit(draft);
  $<HTMLInputElement>('reader-post-limit').setAttribute('aria-invalid',String(invalid));
  const error=draft?.error||(invalid?'Enter a positive whole MiB limit':'');
  $('reader-settings-error').textContent=error;
  $('reader-settings-error').hidden=!error;
  const status=$('reader-settings-status');status.hidden=!draft;
  status.textContent=draft?.busy?'Saving…':draft?.dirty.size?'Not saved':'Saved';
  const retry=$<HTMLButtonElement>('reader-settings-retry');retry.hidden=!draft?.error;retry.disabled=!ready||!!draft?.busy;
  const remove=$<HTMLButtonElement>('reader-post-remove');remove.hidden=!selected.followed;remove.disabled=!ready;
  $('reader-load-images').hidden=!activeImages()?.pendingExternal;
}
function changed(field:Field,immediate=false){
  const id=selected?.id;if(!id)return;
  const draft=rebase(id);
  if(field==='name')draft.name=$<HTMLInputElement>('reader-post-name').value;
  if(field==='mode')draft.mode=$<HTMLSelectElement>('reader-post-mode').value as PostMode;
  if(field==='limit'){draft.limit=$<HTMLInputElement>('reader-post-limit').value;draft.unlimited=$<HTMLInputElement>('reader-post-unlimited').checked;}
  if(field==='policy')draft.policy=$<HTMLSelectElement>('reader-image-policy').value as Policy;
  draft.dirty.set(field,++draft.version);draft.error='';clearTimeout(draft.timer);
  if(immediate)void flush(id);else draft.timer=setTimeout(()=>void flush(id),400);
  refresh();
}
// Capture entity and field versions before awaiting; a later edit or page cannot
// be cleared by the response to an earlier save.
async function flush(id:string){
  const draft=rebase(id);clearTimeout(draft.timer);
  if(draft.busy||!draft.dirty.size)return;
  if(!connected||!snapshot?.ready){draft.error='Server disconnected. Restart FeedTorrent to reconnect.';refresh();return;}
  const post=followed(id),fields=[...draft.dirty].filter(([field])=>field!=='limit'||validLimit(draft));
  const configFields=fields.filter(([field])=>field!=='policy'&&post);
  const policy=fields.find(([field])=>field==='policy');
  if(!configFields.length&&!policy)return;
  draft.busy=true;draft.error='';refresh();
  const saved=(entries:[Field,number][])=>{for(const [field,version] of entries)if(draft.dirty.get(field)===version)draft.dirty.delete(field);};
  try{
    if(post&&configFields.length){
      const config:PostConfig={name:post.local_name,mode:post.mode,automatic_limit:post.automatic_limit};
      for(const [field] of configFields){
        if(field==='name')config.name=draft.name.trim();
        if(field==='mode')config.mode=draft.mode;
        if(field==='limit')config.automatic_limit=draft.unlimited?null:Number(draft.limit)*1048576;
      }
      await host.call({type:'configure_post',id,config});saved(configFields);
    }
    if(policy){
      // Read the current draft only when its request starts, so the captured
      // version and value always describe the same update.
      const version=draft.dirty.get('policy');
      if(version!==undefined){const value=draft.policy;await host.call({type:'set_image_preferences',update:{scope:'post',id,policy:value==='inherit'?null:value}});saved([['policy',version]]);}
    }
  }catch(error){draft.error=String(error);}
  finally{draft.busy=false;rebase(id);refresh();}
  if(!draft.error&&[...draft.dirty.keys()].some(field=>field!=='limit'||validLimit(draft)))void flush(id);
}
export function settingsButton(prefix:string){
  const button=document.createElement('button');button.type='button';button.id=prefix+'-settings';button.className='btn reader-settings';button.dataset.variant='ghost';button.dataset.size='icon-sm';button.setAttribute('aria-label','Post settings');button.hidden=true;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
  svg.innerHTML='<path d="m9.7 4.2.5-2.2h3.6l.5 2.2 1.5.9 2.2-.7 1.8 3.2-1.7 1.5v1.8l1.7 1.5-1.8 3.2-2.2-.7-1.5.9-.5 2.2h-3.6l-.5-2.2-1.5-.9-2.2.7-1.8-3.2 1.7-1.5V9.1L4.3 7.6l1.8-3.2 2.2.7z" transform="translate(0 2)"/><circle cx="12" cy="12" r="3"/>';
  button.append(svg);return button;
}
export function initReaderSettings(value:Host){
  host=value;
  document.addEventListener('click',event=>{
    if(!(event.target as Element).closest('.reader-settings'))return;
    const current=target();if(!current||!connected||!snapshot?.ready)return;
    selected=current;if(current.id)fill(rebase(current.id));dialog().showModal();refresh();
  });
  $('reader-settings-form').onsubmit=event=>{event.preventDefault();if(selected?.id)void flush(selected.id);};
  $('reader-post-name').oninput=()=>changed('name');$('reader-post-limit').oninput=()=>changed('limit');
  $('reader-post-mode').onchange=()=>changed('mode',true);$('reader-post-unlimited').onchange=()=>changed('limit',true);
  $('reader-image-policy').onchange=()=>changed('policy',true);
  $('reader-settings-retry').onclick=()=>{if(selected?.id)void flush(selected.id);};
  $('reader-load-images').onclick=()=>{const images=activeImages();if(selected?.route===location.hash&&images?.pendingExternal){images.loadExternal();dialog().close();}};
  $('reader-post-remove').onclick=()=>{const id=selected?.id;if(id)host.remove(id,$('reader-post-remove'));};
  dialog().addEventListener('close',()=>{const id=selected?.id;selected=null;if(id&&!drafts.get(id)?.error)void flush(id);});
  window.addEventListener('hashchange',()=>{if(dialog().open)dialog().close();refresh();});
  document.addEventListener('reader-images-change',refresh);
}
export function readerSettingsState(state:Snapshot|null,online:boolean){snapshot=state;connected=online;refresh();}

export function readerSettingsRemoved(id:string){clearTimeout(drafts.get(id)?.timer);drafts.delete(id);if(selected?.id===id){selected=null;dialog().close();}}
