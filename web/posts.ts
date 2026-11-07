import type {MarkdownNode} from "./markdown.js";
import {plainClick, ReaderHistory, size, type Crumb, type ReaderEntry} from "./reader.js";
import {ContentReader,ContentPage,torrentRoute,type ContentHost} from './content.js';
import type {CatalogPage, Command, Post, PostConfig, PostEntry, PostMode, Snapshot} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
const node = (tag: string, value: string, cls = '') => {
  const n = document.createElement(tag);
  n.textContent = value;
  n.className = cls;
  return n;
};
const button = (label: string, action: () => void, variant = 'default', cls = '') => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = ['btn', cls].filter(Boolean).join(' ');
  b.dataset.variant = variant;
  b.onclick = action;
  return b;
};
interface Host extends ContentHost {
  call: (command: Command, refresh?: boolean) => Promise<any>;
  transfer: (id: string) => void;
  removePost: (id:string,trigger:HTMLElement) => void;
  followed: () => void
}
interface PostDraft {
  uri: string;
  name: string;
  mode: PostMode;
  limit: string;
  unlimited: boolean;
}
const emptyPostDraft = (): PostDraft => ({
  uri: '', name: '', mode: 'current_catalog', limit: '8', unlimited: false
});
export class PostsUI {
  private state: Snapshot|null = null;
  private connected = false;
  private postId = '';
  private catalogId = '';
  private offset = 0;
  private reader=new ContentReader($('post-reader'),'post',$('post-title').parentElement!);
  private content:ContentPage;
  private position=new ReaderHistory($('post-view'),'postReader',$('post-title'));
  private trail:Crumb[]=[];
  private pendingTrail:Crumb[]|null=null;
  private body:MarkdownNode|null=null;
  private bodyLoaded=false;
  private busy=new Set<number>();
  private page: CatalogPage|null = null;
  private request = 0;
  private signature = '';
  private viewRoute = '';
  private readKey = '';
  private readError = '';
  private editing: string|null = null;
  private loading = false;
  private draft = emptyPostDraft();
  private editDrafts = new Map<string, PostDraft>();
  constructor(private host: Host) {
    this.content=new ContentPage(this.reader,host);this.reader.header.mountStatus($('catalog-status'));
    $('follow-open').onclick = () => this.follow();
    $('post-refresh').onclick = () => {this.readKey='';this.readError='';void this.run({type: 'refresh_post', id: this.postId});};
    $('post-settings').onclick = () => {
      const f = this.post();
      if (f) this.settings(f);
    };
    $<HTMLInputElement>('post-unlimited').onchange = () => {
      const limit = $<HTMLInputElement>('post-limit');
      limit.disabled = $<HTMLInputElement>('post-unlimited').checked;
      if (limit.disabled && limit.getAttribute('aria-invalid') === 'true') {
        limit.removeAttribute('aria-invalid');
        $('follow-error').textContent = '';
      }
    };
    $('post-form').onsubmit = async event => {
      event.preventDefault();
      await this.submit();
    };
    $('post-unfollow').onclick = () => {
      if(this.editing)this.host.removePost(this.editing,$('post-unfollow'));
    };
    // Keep unsent edits independently of which dismissal method is used.
    $('post-form').addEventListener('input', () => this.saveDraft());
    $('post-form').addEventListener('change', () => this.saveDraft());
    window.addEventListener('hashchange', () => this.render(this.state,this.connected));
    document.addEventListener('pointerdown',e=>{if(!$('post-history').contains(e.target as Node))$<HTMLDetailsElement>('post-history').open=false;});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')$<HTMLDetailsElement>('post-history').open=false;});
  }
  removed(id:string){
    this.editDrafts.delete(id);
    if(this.editing===id){this.editing=null;$<HTMLDialogElement>('post-dialog').close();}
  }
  private saveDraft() {
    const draft: PostDraft = {
      uri: $<HTMLInputElement>('post-magnet').value,
      name: $<HTMLInputElement>('post-name').value,
      mode: $<HTMLSelectElement>('post-mode').value as PostMode,
      limit: $<HTMLInputElement>('post-limit').value,
      unlimited: $<HTMLInputElement>('post-unlimited').checked
    };
    if (this.editing) this.editDrafts.set(this.editing, draft);
    else this.draft = draft;
  }
  private fillDraft(draft: PostDraft) {
    this.fill(draft.uri, {
      name: draft.name, mode: draft.mode,
      automatic_limit: draft.unlimited ? null : Number(draft.limit) * 1048576
    });
    $<HTMLInputElement>('post-limit').value = draft.limit;
  }
  follow(uri?: string) {
    this.editing = null;
    if (uri && uri !== this.draft.uri.trim()) this.draft = {...emptyPostDraft(), uri};
    this.fillDraft(this.draft);
    $('post-dialog-title').textContent = 'Follow post';
    $('post-submit').textContent = 'Follow post';
    $('post-unfollow').hidden = true;
    $<HTMLInputElement>('post-magnet').readOnly = false;
    $<HTMLDialogElement>('post-dialog').showModal();
    $<HTMLInputElement>('post-magnet').focus();
  }
  private fill(uri: string, c: PostConfig) {
    $<HTMLInputElement>('post-magnet').value = uri;
    $<HTMLInputElement>('post-name').value = c.name;
    $<HTMLSelectElement>('post-mode').value = c.mode;
    $<HTMLInputElement>('post-limit').value =
        String(c.automatic_limit === null ? 8 : c.automatic_limit / 1048576);
    $<HTMLInputElement>('post-unlimited').checked = c.automatic_limit === null;
    $<HTMLInputElement>('post-limit').disabled = c.automatic_limit === null;
    $('follow-error').textContent = '';
    for (const field of $('post-form').querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
  }
  private settings(f: Post) {
    this.editing = f.id;
    const draft = this.editDrafts.get(f.id);
    if (draft) this.fillDraft(draft);
    else this.fill(
        f.magnet, {name: f.local_name, mode: f.mode, automatic_limit: f.automatic_limit});
    $('post-dialog-title').textContent = 'Post settings';
    $('post-submit').textContent = 'Save';
    $('post-unfollow').hidden = false;
    $<HTMLInputElement>('post-magnet').readOnly = true;
    $<HTMLDialogElement>('post-dialog').showModal();
  }
  private async submit() {
    $('follow-error').textContent = '';
    const submit = $<HTMLButtonElement>('post-submit');
    submit.disabled = true;
    try {
      const unlimited = $<HTMLInputElement>('post-unlimited').checked;
      const mib = Number($<HTMLInputElement>('post-limit').value);
      if (!unlimited &&
          (!Number.isSafeInteger(mib) || mib < 1 || !Number.isSafeInteger(mib * 1048576)))
        { $<HTMLInputElement>('post-limit').setAttribute('aria-invalid', 'true');
          throw Error('Enter a positive whole MiB limit'); }
      const config: PostConfig = {
        name: $<HTMLInputElement>('post-name').value.trim(),
        mode: $<HTMLSelectElement>('post-mode').value as PostMode,
        automatic_limit: unlimited ? null : mib * 1048576
      };
      let id = this.editing;
      if (id) {
        await this.host.call({type: 'configure_post', id, config});
        this.editDrafts.delete(id);
      } else {
        const uri = $<HTMLInputElement>('post-magnet').value.trim();
        const inspected = await this.host.call({type: 'inspect_source', uri}, false);
        if (inspected.kind !== 'post') {
          $<HTMLInputElement>('post-magnet').setAttribute('aria-invalid', 'true');
          throw Error('Enter a BEP 46 post magnet');
        }
        id = inspected.id as string;
        if (!this.state?.posts.some(f => f.id === id)) {
          await this.host.call({type: 'follow_post', uri, config});
        }
        this.host.followed();
        this.draft = emptyPostDraft();
        this.fillDraft(this.draft);
      }
      $<HTMLDialogElement>('post-dialog').close();
      this.signature = '';
      location.hash = `#/posts/${id}`;
    } catch (e) {
      $('follow-error').textContent = String(e);
      if (/BEP 46|InvalidMagnet|InvalidKey|magnet link|infohash/i.test(String(e))) $('post-magnet').setAttribute('aria-invalid', 'true');
    } finally {
      submit.disabled = !this.connected;
    }
  }
  private showError(message: string) {
    const error = $('post-error');
    if (error.firstElementChild!.textContent !== message) error.firstElementChild!.textContent = message;
    error.hidden = !message;
  }
  private post() {
    return this.state?.posts.find(f => f.id === this.postId);
  }
  private async run(command: Command) {
    try {
      await this.host.call(command);
      this.signature = '';
      this.render(this.state, this.connected);
    } catch (e) {
      this.showError(String(e));
    }
  }
  render(state: Snapshot|null, connected: boolean) {
    this.state=state;this.connected=connected;
    const route=location.hash.split('/'),active=route[1]==='posts';
    const isLibrary=!active&&route[1]!=='own'&&route[1]!=='new';
    $('transfer-view').hidden=!isLibrary;$('post-view').hidden=!active;
    $('transfers-nav').setAttribute('aria-current',isLibrary?'page':'false');
    this.postId=active?route[2]||'':'';
    for(const id of ['follow-open','post-submit','post-unfollow','post-refresh','post-settings'])$<HTMLButtonElement>(id).disabled=!connected||!state?.ready;
    if(!active){this.content.leave();this.position.leave();if(this.viewRoute){this.viewRoute='';this.request++;this.loading=false;}$('post-help').hidden=true;return;}
    if(this.viewRoute!==location.hash){
      const previous=this.viewRoute,departing=this.content.crumbs(),descended=!!previous&&location.hash.startsWith(previous+'/torrent/');
      const priorTrail=descended?(departing.length?departing:this.trail):[];
      this.viewRoute=location.hash;this.request++;this.loading=false;this.signature='';this.catalogId='';this.readKey='';this.readError='';this.page=null;this.body=null;this.bodyLoaded=false;
      this.position.enter();const saved=this.position.saved();this.offset=saved?.offset||0;this.trail=this.pendingTrail||saved?.trail||priorTrail;this.pendingTrail=null;
      this.reader.content(location.hash,null);this.reader.entries([],false);this.reader.breadcrumbs([]);$<HTMLDetailsElement>('post-history').open=false;
    }
    const f=this.post();
    if(!f){this.content.leave();this.reader.content('unavailable',null);this.reader.breadcrumbs([]);this.reader.header.update({title:state?'Post unavailable':'Loading…',connected,noTorrent:true});this.reader.entries([],!!state);$('catalog-status').textContent='';$('post-new-version').hidden=true;return;}
    $('post-title').textContent=f.name;
    const target=route[3]||this.catalogId||this.position.saved()?.catalog||f.available||f.head||'';
    if(target!==this.catalogId){this.catalogId=target;this.signature='';this.bodyLoaded=false;this.body=null;this.page=null;this.readKey='';}
    const c=f.catalogs.find(c=>c.id===target);
    if(!this.trail.length){this.trail=[{name:f.name,href:location.hash.split('/torrent/')[0]}];
    }
    if(this.trail.length>1&&c?.name)this.trail[this.trail.length-1].name=c.name;
    this.position.patch({catalog:target,offset:this.offset,trail:this.trail});
    const age=f.last_checked_ms===null?'Not checked yet':`${Math.floor(Math.max(0,(state?.post_time_ms||0)-f.last_checked_ms)/60000)} min since check`;
    $('post-help').textContent=[connected?f.state:'Server disconnected',{current_catalog:'Current catalog',mirror_catalogs:'Mirror catalogs',mirror_all:'Mirror all'}[f.mode],f.mode==='current_catalog'?'':f.mirror_status,`${f.update_peers} update peers`,age,c?`${c.state} · ${size(c.total)}`:''].filter(Boolean).join(' · ');
    $('post-info').setAttribute('aria-label',`About ${f.name}`);
    const latest=f.head&&f.head!==target?f.catalogs.find(c=>c.id===f.head):null;
    $('post-new-version').hidden=!latest;
    $('post-version-status').textContent=latest?.ready?'New version available':latest?.state||'';
    $<HTMLButtonElement>('post-open-latest').disabled=!connected||!latest?.ready;
    $('post-open-latest').onclick=()=>{if(latest?.ready)this.go(latest.id,f.name,true,f.sequence);};
    const links=$('catalog-links');const linkSig=JSON.stringify([c?.previous,c?.archive,target]);
    if(links.dataset.signature!==linkSig){links.dataset.signature=linkSig;links.replaceChildren();
      for(const [name,id] of [['Previous version',c?.previous],['Archive',c?.archive]] as const)if(id){
        const a=document.createElement('a');a.href=`#/posts/${f.id}/${id}`;a.textContent=name;a.className='btn';a.dataset.variant='ghost';
        a.onclick=e=>{if(plainClick(e)){this.prepare(id,name,true);$<HTMLDetailsElement>('post-history').open=false;}};links.append(a);
      }
    }
    $('post-history').hidden=!links.children.length;
    const status=!connected?'Server disconnected':!target?'Resolving post…':!c?.ready?c?.state||'Waiting for metadata':'';
    $('catalog-status').textContent=status;
    this.showError(f.error||state?.post_error||c?.error||latest?.error||this.readError);
    const nested=torrentRoute();
    if(nested){
      $('post-history').hidden=true;$('catalog-pages').hidden=true;$('catalog-status').textContent='';
      const crumbs=this.trail.length?[...this.trail]:[{name:f.name,href:`#/posts/${f.id}/${target}`}],parts=location.hash.split('/');
      for(let i=4;i<parts.length-1;i++)if(/^[0-9a-f]{40}$/.test(parts[i])&&!crumbs.some(c=>c.href===parts.slice(0,i+1).join('/')))crumbs.push({name:state?.transfers.find(t=>t.id===parts[i])?.name||'Catalog',href:parts.slice(0,i+1).join('/')});
      this.content.render({id:nested.id,parent:nested.parent,state,connected,crumbs,position:this.position,source:f.name,entryDownload:f.catalogs.some(c=>c.id===nested.id)?e=>this.downloadContent(e.infohash!,{type:'download_entry',post:f.id,catalog:nested.id,index:e.index}):undefined,shown:async data=>{
        const catalog=f.catalogs.find(c=>c.id===data.id),key=f.id+'/'+data.id;
        if(data.kind==='catalog'&&catalog?.ready&&!['metadata','pending','error'].includes(data.body_state)&&this.readKey!==key){this.readKey=key;await this.host.call({type:'mark_catalog_read',post:f.id,catalog:data.id,sequence:null});}
      },download:async data=>{
        if(state?.posts.find(x=>x.id===f.id)?.catalogs.some(c=>c.id===nested.parent)&&data.source_index!==undefined)await this.downloadContent(nested.id,{type:'download_entry',post:f.id,catalog:nested.parent!,index:data.source_index});
        else if(data.source)await this.downloadContent(nested.id,{type:'add_torrent',data:data.source,origin:{kind:'catalog',parent:nested.parent!}});
        else if(data.source_uri)await this.downloadContent(nested.id,{type:'add_magnet',uri:data.source_uri,origin:{kind:'catalog',parent:nested.parent!}});
      }});return;
    }
    this.content.leave();this.draw();
    const nextSignature=JSON.stringify([this.postId,target,this.offset,c,connected]);
    if(target&&connected&&!this.loading&&nextSignature!==this.signature){this.signature=nextSignature;void this.load();}
  }
  private prepare(id:string,name:string,reset=false,sequence?:string|null){
    const href=`#/posts/${this.postId}/${id}${sequence?'/'+sequence:''}`;
    this.pendingTrail=reset?[{name,href}]:[...this.trail,{name,href}];return href;
  }
  private go(id:string,name='Page',reset=false,sequence?:string|null){$<HTMLDetailsElement>('post-history').open=false;location.hash=this.prepare(id,name,reset,sequence);}
  private async load(){
    const request=++this.request,post=this.postId,catalog=this.catalogId,offset=this.offset,route=location.hash;
    const current=()=>request===this.request&&location.hash===route&&post===this.postId&&catalog===this.catalogId;
    this.loading=true;
    try{
      if(!current())return;
      const page=await this.host.call({type:'catalog_page',post,catalog,offset},false) as CatalogPage;
      if(!current())return;this.page=page;this.draw();
      if(page.catalog.ready&&!this.bodyLoaded){
        const value=await this.host.call({type:'read_catalog_body',post,catalog},false);if(!current())return;
        this.body=value.body||null;this.bodyLoaded=true;this.draw();
      }
      if(page.catalog.ready&&this.bodyLoaded){
        this.position.restore();
        const sequence=location.hash.split('/')[4]||null,key=`${post}/${catalog}/${sequence||''}`;
        if(this.readKey!==key){this.readKey=key;
          try{await this.host.call({type:'mark_catalog_read',post,catalog,sequence});}
          catch(e){if(current()){this.readError=`Could not save reading state: ${e}`;this.showError(this.readError);}}
        }
      }
    }catch(e){if(current()){this.readError=String(e);this.showError(this.readError);}}
    finally{if(current()){this.loading=false;this.draw();}}
  }
  private draw(){
    if(torrentRoute())return;
    const page=this.page,f=this.post(),c=f?.catalogs.find(c=>c.id===this.catalogId),t=this.state?.transfers.find(t=>t.id===this.catalogId);
    const latest=f?.head&&f.head!==this.catalogId?f.catalogs.find(c=>c.id===f.head):null,approval=latest?.state==='Awaiting approval'?latest:c;
    const age=f?.last_checked_ms==null?'Not checked yet':`${Math.floor(Math.max(0,(this.state?.post_time_ms||0)-f.last_checked_ms)/60000)} min since check`;
    this.reader.header.update({pin:this.host.pin,protectedNames:t?.protected_by?.map(id=>this.state?.transfers.find(t=>t.id===id)?.name||'catalog'),title:this.trail.length>1?(c?.name||f?.name||'Page'):(f?.name||'Post unavailable'),id:this.catalogId,t,connected:this.connected,total:c?.total,
      error:f?.error||c?.error||this.readError,source:f?.name,info:f?`${{current_catalog:'Current catalog',mirror_catalogs:'Mirror catalogs',mirror_all:'Mirror all'}[f.mode]} · ${age}`:'',action:cmd=>this.host.call(cmd),remove:()=>this.host.remove(this.catalogId),
      download:!t&&f&&this.catalogId?()=>this.host.call({type:'open_catalog',post:f.id,id:this.catalogId}):undefined,
      approval:approval?.state==='Awaiting approval'?{id:approval.id,ready:!!this.state?.transfers.find(t=>t.id===approval.id)?.files.length}:undefined});
    this.reader.breadcrumbs(this.trail,href=>{const index=this.trail.findIndex(c=>c.href===href);if(index>=0)this.pendingTrail=this.trail.slice(0,index+1);});
    this.reader.dates(page);
    this.reader.content(`${this.postId}/${this.catalogId}`,this.body,target=>{
      if(target.startsWith('magnet:'))return ()=>{if(target.includes('urn:btpk:'))this.follow(target);else void this.run({type:'add_magnet',uri:target});};
      return ()=>void this.relative(target);
    });
    const entries=(page?.entries||[]).map(e=>this.entry(e));
    this.reader.entries(entries,!!page?.catalog.ready&&this.bodyLoaded);
    const pager=$('catalog-pages');pager.hidden=!page||page.total<=100;
    $('catalog-range').textContent=page?.total?`${this.offset+1}–${this.offset+page.entries.length} / ${page.total}`:'';
    $<HTMLButtonElement>('catalog-previous').disabled=!this.connected||!this.offset;
    $<HTMLButtonElement>('catalog-next').disabled=!this.connected||!page||this.offset+page.entries.length>=page.total;
    const move=(offset:number)=>{this.position.save();this.offset=offset;this.signature='';this.position.patch({offset,scroll:0,focus:null});void this.load();scrollTo({top:0,behavior:'instant'});};
    $('catalog-previous').onclick=()=>move(Math.max(0,this.offset-100));$('catalog-next').onclick=()=>move(this.offset+100);
  }
  private entry(e:PostEntry):ReaderEntry{
    const registered=!!e.infohash&&!!this.state?.transfers.some(t=>t.id===e.infohash);
    const item:ReaderEntry={key:String(e.index),name:e.name,kind:e.kind,size:e.total??(e.kind==='file'?e.length:null),error:e.error,disabled:!this.connected||!this.page?.catalog.ready||this.busy.has(e.index)};
    if((e.kind==='catalog'||e.kind==='torrent')&&e.infohash){
      item.href=(location.hash.split('/')[3]?location.hash:`#/posts/${this.postId}/${this.catalogId}`)+`/torrent/${e.infohash}`;item.disabled=false;item.prepare=()=>{this.pendingTrail=[...this.trail];};
      item.label=registered?undefined:'Download';item.actionDisabled=!this.connected||!this.page?.catalog.ready||this.busy.has(e.index);item.action=()=>void this.download(e);
    }
    else if(e.post_magnet){item.label='Follow post';item.action=()=>this.follow(e.post_magnet!);}
    else if(e.kind==='file'){item.label='Show in Folder';item.action=()=>void this.run({type:'reveal_entry',catalog:this.catalogId,index:e.index});}
    return item;
  }
  private downloadContent(id:string,c:Command){return this.host.download?this.host.download(id,c):this.host.call(c);}
  private async download(e:PostEntry){
    if(this.busy.has(e.index))return;
    const route=location.hash;this.busy.add(e.index);this.draw();
    try{if(e.infohash&&this.state?.transfers.some(t=>t.id===e.infohash))return;
      await this.downloadContent(e.infohash!,{type:'download_entry',post:this.postId,catalog:this.catalogId,index:e.index});
    }catch(error){if(location.hash===route)this.showError(String(error));}
    finally{this.busy.delete(e.index);if(location.hash===route)this.draw();}
  }
  private async relative(target:string){
    const route=location.hash,post=this.postId,catalog=this.catalogId;
    try{
      const name=decodeURIComponent(target).replace(/^\.\//,'');
      if(!name||name.startsWith('/')||name.split('/').includes('..'))throw Error('Link unavailable');
      let page=this.page;if(!page)return;
      let entry=page.entries.find(e=>(e.source_name||e.name)===name);
      for(let offset=0;!entry&&offset<page.total;offset+=100){
        if(offset===page.offset)continue;
        const next=await this.host.call({type:'catalog_page',post,catalog,offset},false) as CatalogPage;
        if(location.hash!==route)return;entry=next.entries.find(e=>(e.source_name||e.name)===name);
      }
      if(!entry)throw Error('Link unavailable');
      const item=this.entry(entry);if(item.disabled)return;
      if(entry.kind==='torrent'&&!this.state?.transfers.some(t=>t.id===entry!.infohash))item.action?.();else if(item.href&&entry.infohash)location.hash=item.href;else item.action?.();
    }catch(e){if(location.hash===route)this.showError(String(e));}
  }
}
