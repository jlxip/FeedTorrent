import {size} from './reader.js';
import type {Snapshot} from './types.js';
export interface SourceFile {path:string[];source:string;length:number;modified:string;}
export interface FilesEntry {kind:'files';name:string;files:SourceFile[];linked:boolean;copy:boolean;}
type Entry=FilesEntry|{kind:'page';page:number}|{kind:'torrent';name:string;data:number[]};
interface Page {id:number;title:string;body:string;entries:Entry[];}
interface Draft {root:number;pages:Page[];}
interface DraftView {id:string;revision:number;post:boolean;copy_files:boolean;draft:Draft;phase:string;error:string;done:number;total:number;operation:number;result:string|null;}
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
function el(tag:string,text='',cls=''){const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;}
function button(text:string,fn:()=>void,variant='outline'){const b=el('button',text,'btn') as HTMLButtonElement;b.type='button';b.dataset.variant=variant;b.onclick=fn;return b;}
export async function creationCall(command:unknown){
  const r=await fetch('./api/creation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
  const value=await r.json();if(!r.ok)throw Error(value.error||`Creation failed (${r.status})`);return value;
}
let picker:{resolve:(entries:FilesEntry[]|null)=>void;selected:Set<string>;path:string;offset:number;total:number;epoch:number}|null=null;
let pickerSerial=0;
const selections=new Map<string,Set<string>>();
async function browse(path?:string,offset=0){
  const current=picker;if(!current)return;const epoch=++current.epoch;
  $('source-error').textContent='';$('source-add').setAttribute('disabled','');
  try{
    const result=await creationCall({action:'browse',path:path||null,offset});
    if(picker!==current||epoch!==current.epoch)return;
    current.path=result.path;current.offset=offset;current.total=result.total;const pathInput=$<HTMLInputElement>('source-path');pathInput.placeholder=result.path;if(document.activeElement!==pathInput)pathInput.value=result.path;
    const list=$('source-entries');list.replaceChildren();
    for(const entry of result.entries){
      const row=el('div','','source-row'),check=document.createElement('input');check.type='checkbox';check.className='input';check.disabled=entry.disabled;check.checked=current.selected.has(entry.path);check.setAttribute('aria-label',`Select ${entry.name}`);
      check.onchange=()=>{if(check.checked)current.selected.add(entry.path);else current.selected.delete(entry.path);updateSelection();};
      const name=entry.directory?button(entry.name,()=>void browse(entry.path),'ghost'):el('label',entry.name);
      const id=`source-check-${pickerSerial}-${list.children.length}`;check.id=id;if(name instanceof HTMLLabelElement)name.htmlFor=id;name.classList.add('source-name');
      if(name instanceof HTMLButtonElement)name.disabled=entry.disabled;
      row.append(check,name,el('span',entry.directory?'Folder':size(entry.length),'muted'));list.append(row);
    }
    $<HTMLButtonElement>('source-parent').disabled=!result.parent;$('source-parent').onclick=()=>void browse(result.parent);
    $('source-more').hidden=offset+result.entries.length>=result.total;$('source-more').onclick=()=>void browse(current.path,offset+result.entries.length);
    updateSelection();
  }catch(e){if(picker===current&&epoch===current.epoch){$('source-error').textContent=String(e);updateSelection();}}
}
function updateSelection(){if(!picker)return;$('source-count').textContent=`${picker.selected.size} selected`;$<HTMLButtonElement>('source-add').disabled=!picker.selected.size;}
export function pickServerFiles(scope:string):Promise<FilesEntry[]|null>{
  if(picker)return Promise.reject(Error('A file selection is already open'));
  return new Promise(resolve=>{picker={resolve,selected:selections.get(scope)||new Set(),path:'',offset:0,total:0,epoch:0};selections.set(scope,picker.selected);pickerSerial++;
    $('source-path-form').onsubmit=e=>{e.preventDefault();void browse($<HTMLInputElement>('source-path').value||picker?.path);};
    $('source-select-directory').onclick=()=>{if(picker?.path){picker.selected.add(picker.path);updateSelection();}};
    $('source-add').onclick=async()=>{const current=picker;if(!current)return;$<HTMLButtonElement>('source-add').disabled=true;
      try{const result=await creationCall({action:'sources',paths:[...current.selected]});if(picker!==current)return;picker=null;selections.delete(scope);current.resolve(result.entries);$<HTMLDialogElement>('source-dialog').close();}
      catch(e){if(picker===current){$('source-error').textContent=String(e);updateSelection();}}
    };
    $<HTMLDialogElement>('source-dialog').showModal();void browse($<HTMLInputElement>('source-path').value||undefined);
  });
}
export class CreationUI {
  private state:Snapshot|null=null;
  private connected=false;
  private drafts:DraftView[]=[];
  private current:DraftView|null=null;
  private pageId=1;
  private edits=0;
  private saved=0;
  private queue:Promise<void>=Promise.resolve();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private polling=false;
  private busy=false;
  private loading='';
  private listSignature='';
  constructor(){
    $('post-add').onclick=()=>void this.create();$('post-add').setAttribute('aria-label','Create');
    $('source-dialog').addEventListener('close',()=>{if(picker){const current=picker;picker=null;current.resolve(null);}});
    $('creation-title').oninput=()=>{const p=this.page();if(p){p.title=$<HTMLInputElement>('creation-title').value;$('creation-heading').textContent=p.title||'Untitled';this.changed();}};
    $('creation-body').oninput=()=>{const p=this.page();if(p){p.body=$<HTMLTextAreaElement>('creation-body').value;this.changed();}};
    $('creation-post').onchange=()=>{if(!this.current)return;this.current.post=$<HTMLInputElement>('creation-post').checked;this.pageId=this.current.draft.root;this.changed();this.draw();};
    $('creation-copy').onchange=()=>{if(!this.current)return;this.current.copy_files=$<HTMLInputElement>('creation-copy').checked;for(const p of this.current.draft.pages)for(const e of p.entries)if(e.kind==='files')e.copy=this.current.copy_files;this.changed();};
    $('creation-add-files').onclick=()=>void this.addFiles();
    $('creation-new-page').onclick=()=>{const d=this.current,p=this.page();if(!d||!p)return;const id=Math.max(...d.draft.pages.map(p=>p.id))+1;d.draft.pages.push({id,title:'Untitled page',body:'',entries:[]});p.entries.push({kind:'page',page:id});this.pageId=id;this.changed();this.draw();};
    $('creation-add-torrent').onclick=()=>$<HTMLInputElement>('creation-torrent').click();
    $('creation-torrent').onchange=()=>void this.addTorrent();
    $('creation-submit').onclick=()=>void this.submit();
    $('creation-cancel').onclick=()=>{if(this.current)void creationCall({action:'cancel',id:this.current.id,operation:this.current.operation}).then(()=>this.poll()).catch(e=>this.error(e));};
    $('creation-delete').onclick=()=>void this.remove();
    $('creation-password-form').onsubmit=e=>{e.preventDefault();void this.publish();};
    $('creation-password-dialog').addEventListener('close',()=>{$<HTMLInputElement>('creation-password').value='';$<HTMLInputElement>('creation-confirm').value='';});
    $('creation-copy-magnet').onclick=()=>void navigator.clipboard.writeText('magnet:?xt=urn:btih:'+location.hash.split('/')[2]).catch(e=>this.error(e));
    window.addEventListener('hashchange',()=>{void this.flush().catch(e=>this.error(e));this.render(this.state,this.connected);});
    setInterval(()=>{if(this.connected)void this.poll();},1500);
  }
  private title(d:DraftView){return d.draft.pages.find(p=>p.id===d.draft.root)?.title||'Untitled';}
  private page(){return this.current?.draft.pages.find(p=>p.id===this.pageId);}
  private error(e:unknown){$('creation-error').textContent=String(e);}
  private async create(){if(this.busy||!this.connected)return;this.busy=true;
    try{await this.flush();const d:DraftView=await creationCall({action:'create_draft'});this.current=d;this.edits=this.saved=0;this.pageId=d.draft.root;this.drafts.push(d);location.hash=`#/create/${d.id}`;this.draw();this.drawLists();}
    catch(e){this.error(e);}finally{this.busy=false;}
  }
  private changed(){this.edits++;this.error('');$('creation-status').textContent='Saving…';if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>void this.flush().catch(e=>this.error(e)),400);}
  private async flush(){
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    const d=this.current;if(!d||this.edits===this.saved)return this.queue;
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      if(this.current!==d||this.edits===this.saved)return;
      const edit=this.edits,copy=structuredClone(d);const result:DraftView=await creationCall({action:'save_draft',id:d.id,revision:d.revision,post:copy.post,copy_files:copy.copy_files,draft:copy.draft});
      d.revision=result.revision;this.saved=edit;if(this.current===d)$('creation-status').textContent=this.edits===this.saved?'Draft saved':'Saving…';
      const i=this.drafts.findIndex(x=>x.id===d.id);if(i>=0)this.drafts[i]=d;this.drawLists();
    });return this.queue;
  }
  private async addFiles(){const d=this.current,p=this.page();if(!d||!p)return;
    try{const files=await pickServerFiles(d.id+'/'+p.id);if(!files||this.current!==d)return;for(const e of files){e.copy=d.copy_files;p.entries.push(e);}this.changed();this.drawEntries();}catch(e){this.error(e);}
  }
  private async addTorrent(){const input=$<HTMLInputElement>('creation-torrent'),f=input.files?.[0],d=this.current,p=this.page();
    try{if(!f||!d||!p)return;if(f.size>8*1024*1024)throw Error('Torrent metadata exceeds 8 MiB');const data=Array.from(new Uint8Array(await f.arrayBuffer()));if(this.current!==d)return;p.entries.push({kind:'torrent',name:f.name,data});this.changed();this.drawEntries();}catch(e){this.error(e);}finally{input.value='';}
  }
  private async remove(){const d=this.current;if(!d||this.busy)return;this.busy=true;
    try{await this.flush();await creationCall({action:'delete_draft',id:d.id,revision:d.revision});this.current=null;this.drafts=this.drafts.filter(x=>x.id!==d.id);location.hash='#/library';this.drawLists();}catch(e){this.error(e);}finally{this.busy=false;}
  }
  private async submit(){const d=this.current;if(!d||this.busy)return;this.busy=true;
    try{await this.flush();if(this.current!==d)return;if(d.post){$('creation-password-error').textContent='';$('creation-confirm-field').hidden=!!this.state?.publishing.has_key;$<HTMLInputElement>('creation-confirm').required=!this.state?.publishing.has_key;$<HTMLDialogElement>('creation-password-dialog').showModal();}
      else{await creationCall({action:'create_torrent',id:d.id,revision:d.revision});await this.poll();}
    }catch(e){this.error(e);}finally{this.busy=false;}
  }
  private async publish(){const d=this.current;if(!d||this.busy)return;this.busy=true;$<HTMLButtonElement>('creation-password-submit').disabled=true;
    const password=$<HTMLInputElement>('creation-password').value;
    try{await this.flush();const result=await creationCall({action:'bind_post',id:d.id,revision:d.revision,password,confirmation:$<HTMLInputElement>('creation-confirm').value});
      const r=await fetch('./api/publishing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'publish',id:result.id,revision:result.revision,password})});
      if(!r.ok){const value=await r.json();throw Error(value.error||'Publication failed');}
      $<HTMLDialogElement>('creation-password-dialog').close();await creationCall({action:'delete_draft',id:d.id,revision:d.revision});this.current=null;location.hash=`#/own/${result.id}/read`;void this.poll();
    }catch(e){$('creation-password-error').textContent=String(e);}finally{this.busy=false;$<HTMLButtonElement>('creation-password-submit').disabled=false;$<HTMLInputElement>('creation-password').value='';$<HTMLInputElement>('creation-confirm').value='';}
  }
  private async poll(){if(this.polling||!this.connected)return;this.polling=true;
    try{const result=await creationCall({action:'list'});this.drafts=result.drafts;this.drawLists();const d=this.current,remote=this.drafts.find(x=>x.id===d?.id);
      if(d&&remote&&this.edits===this.saved&&remote.revision>=d.revision){
        if(remote.result){
          const route=`#/create/${d.id}`;if(location.hash===route){this.current=null;location.hash=remote.post?`#/own/${remote.result}`:`#/library/${remote.result}`;void creationCall({action:'delete_draft',id:d.id,revision:remote.revision}).catch(()=>{});}return;
        }
        const changed=d.revision!==remote.revision;if(changed){const fresh:DraftView=await creationCall({action:'get_draft',id:d.id});if(this.current===d&&this.edits===this.saved){this.current=fresh;this.draw();}}else{d.phase=remote.phase;d.error=remote.error;d.done=remote.done;d.total=remote.total;d.operation=remote.operation;this.status();}
      }
    }catch(e){if(location.hash.startsWith('#/create/'))this.error(e);}finally{this.polling=false;}
  }
  render(state:Snapshot|null,connected:boolean){
    const before=this.connected;this.state=state;this.connected=connected;
    const route=location.hash.split('/'),active=route[1]==='create';$('creation-view').hidden=!active;
    if(active){for(const id of ['transfer-view','library-catalog','library-detail','own-view','post-view','news-view'])$(id).hidden=true;}
    const share=route[1]==='library'&&/^[0-9a-f]{40}$/.test(route[2]||'')&&!!state?.transfers.some(t=>t.id===route[2]);$('creation-share').hidden=!share;
    if(share){const link=$<HTMLAnchorElement>('creation-download');link.href=`./api/torrent?id=${route[2]}`;link.download='torrent.torrent';}
    if(active&&this.current?.id!==route[2]&&this.loading!==route[2]){
      this.loading=route[2];const id=route[2];
      void this.flush().catch(e=>this.error(e)).then(()=>creationCall({action:'get_draft',id})).then((d:DraftView)=>{if(location.hash!==`#/create/${id}`)return;this.current=d;this.pageId=d.draft.root;this.edits=this.saved=0;this.draw();}).catch(e=>this.error(e)).finally(()=>{if(this.loading===id)this.loading='';});
    }
    this.status();if(connected&&!before)void this.poll();this.drawLists();
    if(this.drafts.some(d=>!d.result&&d.post))$('no-posts').hidden=true;
    if(this.drafts.some(d=>!d.result&&!d.post))$('empty').hidden=true;
    for(const a of $('creation-post-drafts').querySelectorAll<HTMLAnchorElement>('a'))a.setAttribute('aria-current',a.hash===location.hash?'page':'false');
  }
  private status(){const d=this.current;if(!d)return;const working=!['Draft','Created','Bound'].includes(d.phase);
    for(const input of $('creation-view').querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLButtonElement|HTMLSelectElement>('input,textarea,button,select'))input.disabled=!this.connected||working;
    $('creation-cancel').hidden=!working;$<HTMLButtonElement>('creation-cancel').disabled=!this.connected;
    const submit=$('creation-submit'),label=d.post?'Publish':d.error?'Retry':'Create torrent';
    if(submit.textContent!==label)submit.textContent=label;
    $('creation-status').textContent=working?`${d.phase}${d.total?` · ${size(d.done)} / ${size(d.total)}`:''}`:this.edits!==this.saved?'Saving…':'Draft saved';
    if(d.error)this.error(d.error);
  }
  private draw(){const d=this.current,p=this.page();if(!d||!p)return;
    $<HTMLInputElement>('creation-post').checked=d.post;$<HTMLInputElement>('creation-copy').checked=d.copy_files;
    $<HTMLInputElement>('creation-title').value=p.title;$('creation-heading').textContent=this.title(d);$<HTMLTextAreaElement>('creation-body').value=p.body;
    for(const id of ['creation-body-field','creation-new-page','creation-add-torrent'])$(id).hidden=!d.post;
    $('creation-excluded').hidden=d.post||!d.draft.pages.some(p=>p.body||p.entries.some(e=>e.kind!=='files'));
    const nav=$('creation-pages');nav.replaceChildren();nav.hidden=!d.post||d.draft.pages.length===1;
    if(d.post)for(const page of d.draft.pages){const b=button(page.title,()=>{this.pageId=page.id;this.draw();},'ghost');b.setAttribute('aria-current',String(page.id===this.pageId));nav.append(b);}
    this.drawEntries();this.status();
  }
  private drawEntries(){const d=this.current,p=this.page();if(!d||!p)return;const list=$('creation-entries');list.replaceChildren();
    const entries=(d.post?[p]:d.draft.pages).flatMap(page=>page.entries.map((entry,index)=>({page,entry,index}))).filter(x=>d.post||x.entry.kind==='files');
    for(const {page,entry:e,index} of entries){
      const row=el('div','','own-entry creation-entry');const name=e.kind==='page'?d.draft.pages.find(p=>p.id===e.page)?.title||'Page':e.name;
      row.append(e.kind==='page'?button(name,()=>{this.pageId=e.page;this.draw();},'link'):el('span',name,'own-entry-name'));
      if(e.kind==='files'){
        row.append(el('span',`${e.files.length} file${e.files.length===1?'':'s'} · ${size(e.files.reduce((n,f)=>n+f.length,0))}`,'muted'));
        if(d.post){const select=document.createElement('select');select.className='select';select.setAttribute('aria-label',`Include ${name}`);select.add(new Option('Include files','include'));select.add(new Option('Link as torrent','link'));select.value=e.linked?'link':'include';select.onchange=()=>{e.linked=select.value==='link';this.changed();};row.append(select);}
        const details=el('details');details.append(el('summary','Files'));for(const file of e.files)details.append(el('div',`${file.path.join('/')} · ${size(file.length)}`,'muted'));row.append(details);
      }
      const up=button('↑',()=>{[page.entries[index-1],page.entries[index]]=[page.entries[index],page.entries[index-1]];this.changed();this.drawEntries();},'ghost');up.disabled=index===0;up.setAttribute('aria-label',`Move ${name} up`);row.append(up);
      const remove=button('×',()=>{page.entries.splice(index,1);const seen=new Set<number>();const walk=(id:number)=>{if(seen.has(id))return;seen.add(id);for(const e of d.draft.pages.find(p=>p.id===id)?.entries||[])if(e.kind==='page')walk(e.page);};walk(d.draft.root);d.draft.pages=d.draft.pages.filter(p=>seen.has(p.id));this.changed();this.draw();},'ghost');remove.setAttribute('aria-label',`Remove ${name}`);row.append(remove);list.append(row);
    }
    if(!entries.length)list.append(el('p','No items','muted'));
  }
  private drawLists(){
    const drafts=this.drafts.filter(d=>!d.result);const signature=JSON.stringify(drafts.map(d=>[d.id,d.post,this.title(d),d.phase]));if(signature===this.listSignature)return;this.listSignature=signature;
    const posts=$('creation-post-drafts'),library=$('creation-library');posts.replaceChildren();library.replaceChildren();
    for(const d of drafts){const link=el('a',this.title(d)) as HTMLAnchorElement;link.href=`#/create/${d.id}`;
      if(d.post){const li=el('li');link.className='btn post-link';link.dataset.variant='ghost';link.append(el('span',' · Draft','muted'));li.append(link);posts.append(li);}
      else{const card=el('article','','card transfer'),header=el('header'),title=el('h3');link.className='transfer-name';title.append(link);header.append(title);card.append(header,el('section',d.phase==='Draft'?'Draft':d.phase,'muted'));library.append(card);}
    }
    library.hidden=!drafts.some(d=>!d.post);if(drafts.some(d=>d.post))$('no-posts').hidden=true;if(drafts.some(d=>!d.post))$('empty').hidden=true;
  }
}
