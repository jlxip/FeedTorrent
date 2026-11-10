import {size} from './reader.js';
import type {Command, OrganizationNode, Snapshot, RemovalPreview} from './types.js';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
const el=(tag:string,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;e.className=cls;return e;};
const button=(text:string,label:string)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className='btn';b.dataset.variant='ghost';b.dataset.size='icon-sm';b.setAttribute('aria-label',label);return b;};
function icon(own:boolean){
  const e=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round',role:'img','aria-label':own?'Your post':'Followed post'}))e.setAttribute(k,v);
  // Lucide RSS and SquarePen, from the existing 0.468.0 icon set.
  e.innerHTML=own?'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M16 3a2.12 2.12 0 0 1 3 3L9 16l-4 1 1-4Z"/>':'<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>';
  return e;
}
type Item=OrganizationNode & {name:string;href:string};
type Menu=HTMLElement & {close:(focus?:boolean)=>void};
type Drag={key:string;pointer:number;x:number;y:number;active:boolean;revision:string;parent:string|null;before:string|null;valid:boolean;target:HTMLElement|null;capture:HTMLElement;frame:number;touch:boolean;timer:ReturnType<typeof setTimeout>|null};

export class OrganizationUI {
  private state:Snapshot|null=null;
  private connected=false;
  private items:Item[]=[];
  private signature='';
  private folded=new Set<string>();
  private drag:Drag|null=null;
  private moving='';
  private moveRevision='';
  private drafts=new Map<string,{parent:string;position:string}>();
  private busy=false;
  private suppressClick=false;
  private removing:Item|null=null;
  private removeBusy=false;
  private removePreview:RemovalPreview|null=null;
  private previewRequest=0;
  private returnFocus:HTMLElement|null=null;
  constructor(private call:(c:Command)=>Promise<unknown>,private removeOwn:(id:string,revision:string)=>Promise<void>,private removedFollowed:(id:string)=>void){
    $('post-remove-form').onsubmit=e=>{e.preventDefault();void this.submitRemove();};
    $('post-remove-dialog').addEventListener('close',()=>{
      requestAnimationFrame(()=>{const focus=this.returnFocus;if(focus?.isConnected&&(!document.querySelector('dialog[open]')||focus.closest<HTMLDialogElement>('dialog')?.open))focus.focus();});
    });
    try{const saved=JSON.parse(localStorage.getItem('postTreeFolded')||localStorage.getItem('feedTreeFolded')||'[]');if(Array.isArray(saved))this.folded=new Set(saved.filter(x=>typeof x==='string'));}catch{}
    $('post-archive').addEventListener('toggle',()=>{try{localStorage.setItem('postArchiveOpen',String(($('post-archive') as HTMLDetailsElement).open));}catch{}});
    try{($('post-archive') as HTMLDetailsElement).open=(localStorage.getItem('postArchiveOpen')??localStorage.getItem('feedArchiveOpen'))==='true';}catch{}
    $('post-move-parent').onchange=()=>{this.positions();this.rememberMove();};
    $('post-move-position').onchange=()=>this.rememberMove();
    $('post-move-form').onsubmit=e=>{e.preventDefault();void this.submitMove();};
    document.addEventListener('pointermove',e=>this.pointerMove(e),{passive:false});
    document.addEventListener('pointerup',e=>{if(this.drag&&!this.drag.touch&&this.drag.pointer===e.pointerId)this.endDrag(false);});
    document.addEventListener('pointercancel',e=>{if(this.drag&&!this.drag.touch&&this.drag.pointer===e.pointerId)this.endDrag(true);});
    document.addEventListener('touchmove',e=>this.touchMove(e),{passive:false});
    for(const type of ['touchend','touchcancel'] as const)document.addEventListener(type,e=>{
      if(this.drag?.touch&&[...e.changedTouches].some(t=>t.identifier===this.drag!.pointer))this.endDrag(type==='touchcancel');
    });
    document.addEventListener('pointerdown',()=>{if(!this.drag)this.suppressClick=false;},true);
    document.addEventListener('click',e=>{if(this.suppressClick&&e.detail>0){e.preventDefault();e.stopImmediatePropagation();this.suppressClick=false;}},true);
    document.addEventListener('contextmenu',e=>{if(this.drag?.touch)e.preventDefault();});
    window.addEventListener('blur',()=>this.endDrag(true));
    document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(this.drag){e.preventDefault();e.stopPropagation();this.endDrag(true);return;}const open=document.querySelector<Menu>('.dropdown-menu:has(>button[aria-expanded=true])');if(open&&!document.querySelector('dialog[open]')){e.preventDefault();e.stopPropagation();open.close();}},true);
    // Basecoat owns menu keyboard/focus behavior. Native popovers escape the
    // scrolling sidebar; only placement and top-layer visibility are adapted.
    new MutationObserver(changes=>{let closed=false;for(const c of changes){const p=c.target as HTMLElement;if(!p.isConnected||!p.matches('.tree-popover'))continue;
      if(p.getAttribute('aria-hidden')==='false'){
        const trigger=p.previousElementSibling as HTMLElement,rect=trigger.getBoundingClientRect();
        p.showPopover();const box=p.getBoundingClientRect();
        p.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-box.width-8))}px`;
        p.style.top=`${Math.max(8,Math.min(rect.bottom+4,innerHeight-box.height-8))}px`;
      }else{if(p.matches(':popover-open'))p.hidePopover();closed=true;}
    }
      // Finish bubbling the click before replacing nodes: Basecoat's sidebar
      // treats a detached menu target as a click outside its navigation.
      if(closed)requestAnimationFrame(()=>this.render(this.state,this.connected));
    }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['aria-hidden']});
    window.addEventListener('hashchange',()=>this.render(this.state,this.connected));
  }
  private rememberMove(){this.drafts.set(this.moving,{parent:$<HTMLSelectElement>('post-move-parent').value,position:$<HTMLSelectElement>('post-move-position').value});}
  private branch(key:string){const result=new Set([key]);let size=0;while(size!==result.size){size=result.size;for(const n of this.items)if(n.parent&&result.has(n.parent))result.add(n.key);}return result;}
  private menu(item:Item){
    const wrapper=el('div','','dropdown-menu post-row-menu');wrapper.dataset.keepMobileSidebarOpen='';
    const trigger=button('⋯',`Actions for ${item.name}`),id=`post-actions-${item.key.replace(':','-')}`;
    trigger.dataset.focus=`menu:${item.key}`;trigger.id=id;trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-controls',id+'-menu');trigger.setAttribute('aria-expanded','false');
    const popover=el('div','','tree-popover');popover.setAttribute('data-popover','');popover.setAttribute('popover','manual');popover.setAttribute('aria-hidden','true');
    const menu=el('div');menu.id=id+'-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-labelledby',id);
    for(const [label,action] of [['Move…','move'],[item.archived?'Restore':'Archive',item.archived?'restore':'archive']]){
      const b=el('button',label) as HTMLButtonElement;b.id=id+'-'+action;b.type='button';b.setAttribute('role','menuitem');
      b.onclick=()=>{(wrapper as Menu).close();if(action==='move')this.openMove(item.key);else void this.change(item.key,action as 'archive'|'restore');};menu.append(b);
    }
    const remove=el('button','Delete post…') as HTMLButtonElement;
    remove.id=id+'-remove';remove.type='button';remove.setAttribute('role','menuitem');remove.dataset.variant='destructive';
    remove.onclick=()=>{(wrapper as Menu).close();this.openRemove(item.key,trigger);};menu.append(remove);
    popover.append(menu);wrapper.append(trigger,popover);return wrapper;
  }
  openRemove(key:string,trigger?:HTMLElement){
    if(!this.connected||!this.state?.ready||this.removeBusy)return;
    const item=this.items.find(n=>n.key===key);if(!item)return;
    this.removing=item;this.returnFocus=trigger||document.activeElement as HTMLElement;
    $('post-remove-name').textContent=item.name;
    this.removePreview=null;this.previewRequest++;
    $('post-remove-description').textContent='Checking downloaded content…';
    $('post-remove-error').textContent='';
    $<HTMLButtonElement>('post-remove-submit').disabled=true;
    $<HTMLDialogElement>('post-remove-dialog').showModal();
    $('post-remove-dialog').querySelector<HTMLButtonElement>('[data-close]')!.focus();
    void this.loadRemovePreview();
  }
  private async loadRemovePreview(){
    const item=this.removing;if(!item)return;const request=++this.previewRequest;this.removePreview=null;
    const [kind,id]=item.key.split(':');
    try{
      const p=await this.call({type:'preview_removal',target:{kind:'post',post_kind:kind as 'own'|'followed',id}}) as RemovalPreview;
      if(request!==this.previewRequest||this.removing?.key!==item.key)return;
      this.removePreview=p;
      const amount=size(p.bytes);
      $('post-remove-description').textContent=`Delete this post${kind==='own'?' and its draft':''} and ${p.deleting.length} downloaded torrents (${amount}). Keep ${p.shared.length} shared and ${p.protected.length} protected by Pin. Shared copies may remain available.`+[p.names?.length?' Delete: '+p.names.join(', ')+'.':'',p.shared_names?.length?' Shared: '+p.shared_names.join(', ')+'.':'',p.protected_names?.length?' Pin: '+p.protected_names.join(', ')+'.':''].join('');
    }catch(e){if(request===this.previewRequest)$('post-remove-error').textContent=String(e);}
    finally{if(request===this.previewRequest)$<HTMLButtonElement>('post-remove-submit').disabled=!this.removePreview||!this.connected||!this.state?.ready;}
  }
  private async submitRemove(){
    const item=this.removing;if(!item||!this.removePreview||this.removeBusy||!this.connected||!this.state?.ready)return;
    this.removeBusy=true;$<HTMLButtonElement>('post-remove-submit').disabled=true;
    const [kind,id]=item.key.split(':');
    try{
      const revision=this.removePreview.revision;
      if(kind==='own')await this.removeOwn(id,revision);
      else {await this.call({type:'delete_post',post_kind:'followed',id,revision});this.removedFollowed(id);}
      $<HTMLDialogElement>('post-remove-dialog').close();
      this.removing=null;
      const route=location.hash.split('/');
      if(route[1]===(kind==='own'?'own':'posts')&&route[2]===id){
        this.returnFocus=null;location.hash='#/library';requestAnimationFrame(()=>$('library-heading').focus());
      }else{
        const next=document.querySelector<HTMLElement>('#sidebar .post-link[aria-current="page"]')||document.querySelector<HTMLElement>('#sidebar a[aria-current="page"]');
        if(!this.returnFocus?.isConnected)next?.focus();
      }
      $('organization-status').textContent=this.state?.cleanup?.some(j=>j.target.kind==='post'&&j.target.id===id&&j.target.post_kind===kind)?'Post deleted; cleanup pending':'Post deleted';
    }catch(e){$('post-remove-error').textContent=String(e);if(/References changed/.test(String(e)))await this.loadRemovePreview();}
    finally{this.removeBusy=false;$<HTMLButtonElement>('post-remove-submit').disabled=!this.removePreview||!this.connected||!this.state?.ready;}
  }
  render(state:Snapshot|null,connected:boolean){
    this.state=state;this.connected=connected;
    $<HTMLButtonElement>('post-remove-submit').disabled=this.removeBusy||!this.removePreview||!connected||!state?.ready;
    if(this.drag)return;
    const names=new Map<string,{name:string;href:string}>();
    for(const f of state?.posts||[])names.set('followed:'+f.id,{name:f.name,href:`#/posts/${f.id}`});
    for(const f of state?.publishing.posts||[])names.set('own:'+f.id,{name:f.title,href:`#/own/${f.id}/read`});
    const nodes=(state?.organization?.nodes||[]).filter(n=>names.has(n.key));
    for(const key of names.keys())if(!nodes.some(n=>n.key===key))nodes.push({key,parent:null,archived:false});
    this.items=nodes.map(n=>({...n,...names.get(n.key)!}));
    const signature=JSON.stringify([this.items,[...this.folded],connected,!!state?.ready]);
    // Live draft saves can reorder the tree between pointerdown and click.
    // Keep the current menu/keyboard selection intact until Basecoat closes it.
    // Removal, archiving, disconnect and unavailable state still invalidate it.
    const openRow=document.querySelector<HTMLElement>('#sidebar .post-row:has(.post-row-menu > button[aria-expanded="true"])');
    const keepMenu=connected&&state?.ready&&openRow&&this.items.some(n=>n.key===openRow.dataset.key&&n.archived===!!openRow.closest('#archived-posts'));
    if(signature!==this.signature&&!keepMenu){
      this.signature=signature;
      const focus=(document.activeElement as HTMLElement)?.dataset.focus,returnFocus=this.returnFocus?.dataset.focus;
      for(const archived of [false,true]){
        const list=$(archived?'archived-posts':'post-tree');list.replaceChildren();
        const draw=(parent:string|null,container:HTMLElement)=>{
          for(const item of this.items.filter(n=>n.parent===parent&&n.archived===archived)){
            const li=el('li'),row=el('div','','post-row');li.dataset.key=item.key;row.dataset.key=item.key;
            const children=this.items.some(n=>n.parent===item.key),fold=button(this.folded.has(item.key)?'›':'⌄',`Toggle children of ${item.name}`);
            fold.dataset.keepMobileSidebarOpen='';fold.dataset.focus='fold:'+item.key;fold.classList.add('post-fold');fold.hidden=!children;fold.setAttribute('aria-expanded',String(!this.folded.has(item.key)));
            fold.onclick=e=>{e.stopPropagation();if(this.folded.has(item.key))this.folded.delete(item.key);else this.folded.add(item.key);try{localStorage.setItem('postTreeFolded',JSON.stringify([...this.folded]));}catch{}this.render(this.state,this.connected);};
            const link=document.createElement('a');link.href=item.href;link.className='btn post-link';link.dataset.variant='ghost';link.dataset.kind=item.key.startsWith('own:')?'own':'followed';link.dataset.post=item.key.split(':')[1];link.dataset.focus='link:'+item.key;
            link.draggable=false;link.append(icon(item.key.startsWith('own:')),el('span',item.name));
            row.onpointerdown=e=>this.startDrag(e,item.key,row);
            row.ontouchstart=e=>this.startTouch(e,item.key,row);
            row.ondragstart=e=>e.preventDefault();
            row.append(fold,link,this.menu(item));
            for(const b of row.querySelectorAll<HTMLButtonElement>('button'))b.disabled=!connected||!state?.ready||this.busy;
            li.append(row);if(children){const ul=el('ul');ul.hidden=this.folded.has(item.key);draw(item.key,ul);li.append(ul);}container.append(li);
          }
        };draw(null,list);
      }
      for(const e of document.querySelectorAll<HTMLElement>('#sidebar [data-focus]')){
        if(focus&&e.dataset.focus===focus)e.focus();
        if(returnFocus&&e.dataset.focus===returnFocus)this.returnFocus=e;
      }
      window.basecoat.init('dropdown-menu');
    }
    for(const a of document.querySelectorAll<HTMLAnchorElement>('.post-link')){const root=a.hash.split('/').slice(0,3).join('/');a.setAttribute('aria-current',location.hash===root||location.hash.startsWith(root+'/')?'page':'false');}
    $('no-posts').hidden=this.items.some(n=>!n.archived);
    $('post-archive').hidden=!this.items.some(n=>n.archived);
    const error=state?.organization?.error||'';if(error)$('organization-error').textContent=error;
  }
  private positions(){
    const select=$<HTMLSelectElement>('post-move-position'),parent=$<HTMLSelectElement>('post-move-parent').value||null,item=this.items.find(n=>n.key===this.moving);
    select.replaceChildren(new Option('First','first'),new Option('Last','last'));
    for(const n of this.items.filter(n=>n.key!==this.moving&&n.parent===parent&&n.archived===item?.archived))select.add(new Option(`Before ${n.name}`,'before:'+n.key));
  }
  private openMove(key:string){
    if(!this.connected||!this.state?.ready||this.busy)return;
    const item=this.items.find(n=>n.key===key);if(!item)return;
    this.moving=key;this.moveRevision=this.state?.organization?.revision||'0';
    const select=$<HTMLSelectElement>('post-move-parent');select.replaceChildren(new Option('Root',''));
    const branch=this.branch(key);
    const depth=(n:Item):number=>n.parent?1+depth(this.items.find(x=>x.key===n.parent)!):0;
    for(const n of this.items.filter(n=>!branch.has(n.key)&&n.archived===item.archived))select.add(new Option(`${'· '.repeat(depth(n))}${n.name}`,n.key));
    const draft=this.drafts.get(key);select.value=draft?.parent??item.parent??'';if(select.selectedIndex<0)select.value='';
    this.positions();if(draft){$<HTMLSelectElement>('post-move-position').value=draft.position;if($<HTMLSelectElement>('post-move-position').selectedIndex<0)$<HTMLSelectElement>('post-move-position').value='first';}
    $('post-move-error').textContent='';$('post-move-title').textContent=`Move ${item.name}`;
    $<HTMLDialogElement>('post-move-dialog').showModal();select.focus();
  }
  private async submitMove(){
    const item=this.items.find(n=>n.key===this.moving);if(!item)return;
    const parent=$<HTMLSelectElement>('post-move-parent').value||null,value=$<HTMLSelectElement>('post-move-position').value;
    const before=value==='first'?this.items.find(n=>n.key!==item.key&&n.parent===parent&&n.archived===item.archived)?.key||null:value.startsWith('before:')?value.slice(7):null;
    $<HTMLButtonElement>('post-move-submit').disabled=true;
    try{await this.send(item.key,'move',parent,before,this.moveRevision);this.drafts.delete(item.key);$<HTMLDialogElement>('post-move-dialog').close();}
    catch(e){$('post-move-error').textContent=String(e);this.moveRevision=this.state?.organization?.revision||'0';}
    finally{$<HTMLButtonElement>('post-move-submit').disabled=false;}
  }
  private async send(key:string,action:'move'|'archive'|'restore',parent:string|null,before:string|null,revision=this.state?.organization?.revision||'0'){
    if(this.busy)throw Error('Another post operation is in progress');
    this.busy=true;$('organization-error').textContent='';
    for(const b of document.querySelectorAll<HTMLButtonElement>('#post-tree button,#archived-posts button'))b.disabled=true;
    try{await this.call({type:'organize_post',key,action,parent,before,revision});$('organization-status').textContent=action==='move'?'Post moved':action==='archive'?'Post archived':'Post restored';}
    finally{this.busy=false;this.signature='';this.render(this.state,this.connected);}
  }
  private async change(key:string,action:'archive'|'restore'){
    const item=this.items.find(n=>n.key===key);
    try{await this.send(key,action,null,null);const target=document.querySelector<HTMLElement>(`[data-focus="menu:${key}"]`);if(target?.getClientRects().length)target.focus();else $('post-add').focus();}
    catch(e){$('organization-error').textContent=String(e);}
  }
  private interactive(target:EventTarget|null){return target instanceof Element&&!!target.closest('button,.dropdown-menu,input,select,textarea');}
  private begin(key:string,capture:HTMLElement,x:number,y:number,pointer:number,touch:boolean){
    this.suppressClick=false;
    this.drag={key,pointer,x,y,active:false,revision:this.state?.organization?.revision||'0',parent:null,before:null,valid:false,target:null,capture,frame:0,touch,timer:null};
  }
  private startDrag(e:PointerEvent,key:string,capture:HTMLElement){
    if(e.pointerType==='touch'||e.button!==0||!e.isPrimary||!this.connected||!this.state?.ready||this.busy||this.interactive(e.target))return;
    // Keep native focus and click navigation until movement becomes a drag.
    this.begin(key,capture,e.clientX,e.clientY,e.pointerId,false);
  }
  private startTouch(e:TouchEvent,key:string,capture:HTMLElement){
    if(e.touches.length!==1){if(this.drag?.touch)this.endDrag(true);return;}
    if(!this.connected||!this.state?.ready||this.busy||this.interactive(e.target))return;
    const t=e.touches[0];this.begin(key,capture,t.clientX,t.clientY,t.identifier,true);
    const d=this.drag!;d.timer=setTimeout(()=>{if(this.drag===d)this.activate(d);},350);
  }
  private activate(d:Drag){
    d.active=true;d.capture.classList.add('drag-source');$('post-root-drop').hidden=false;document.body.classList.add('post-dragging');
    if(!d.touch)d.capture.setPointerCapture(d.pointer);
    this.scrollDrag();
  }
  private pointerMove(e:PointerEvent){
    const d=this.drag;if(!d||d.touch||d.pointer!==e.pointerId)return;
    if(!d.active&&Math.hypot(e.clientX-d.x,e.clientY-d.y)<5)return;
    e.preventDefault();if(!d.active)this.activate(d);
    d.x=e.clientX;d.y=e.clientY;this.destination();
  }
  private touchMove(e:TouchEvent){
    const d=this.drag;if(!d?.touch)return;
    const t=[...e.touches].find(t=>t.identifier===d.pointer);if(!t)return;
    if(!d.active){if(Math.hypot(t.clientX-d.x,t.clientY-d.y)>8)this.endDrag(true);return;}
    if(e.cancelable)e.preventDefault();d.x=t.clientX;d.y=t.clientY;this.destination();
  }
  private destination(){
    const d=this.drag;if(!d)return;
    d.target?.removeAttribute('data-drop');d.valid=false;d.target=null;
    const hit=document.elementFromPoint(d.x,d.y),root=hit?.closest('#post-root-drop'),row=hit?.closest<HTMLElement>('.post-row');
    const source=this.items.find(n=>n.key===d.key)!;
    if(root){d.parent=null;d.before=this.items.find(n=>n.key!==d.key&&!n.parent&&n.archived===source.archived)?.key||null;d.valid=true;d.target=root as HTMLElement;d.target.dataset.drop='inside';return;}
    if(!row)return;
    const target=this.items.find(n=>n.key===row.dataset.key);if(!target||target.archived!==source.archived||this.branch(d.key).has(target.key))return;
    const rect=row.getBoundingClientRect(),fraction=(d.y-rect.top)/rect.height;
    if(fraction<.25){d.parent=target.parent;d.before=target.key;row.dataset.drop='before';}
    else if(fraction>.75){d.parent=target.parent;const siblings=this.items.filter(n=>n.parent===target.parent&&n.archived===target.archived&&n.key!==d.key);d.before=siblings[siblings.indexOf(target)+1]?.key||null;row.dataset.drop='after';}
    else{d.parent=target.key;d.before=this.items.find(n=>n.parent===target.key&&n.key!==d.key)?.key||null;row.dataset.drop='inside';}
    d.target=row;d.valid=true;
  }
  private scrollDrag(){
    const d=this.drag;if(!d?.active)return;
    const section=$('post-tree').closest('section')!,r=section.getBoundingClientRect();
    if(d.y<r.top+40)section.scrollTop-=10;else if(d.y>r.bottom-40)section.scrollTop+=10;
    this.destination();d.frame=requestAnimationFrame(()=>this.scrollDrag());
  }
  private endDrag(cancel:boolean){
    const d=this.drag;if(!d)return;this.drag=null;cancelAnimationFrame(d.frame);if(d.timer!==null)clearTimeout(d.timer);
    if(!d.touch&&d.capture.hasPointerCapture(d.pointer))d.capture.releasePointerCapture(d.pointer);
    d.target?.removeAttribute('data-drop');d.capture.closest('.post-row')?.classList.remove('drag-source');$('post-root-drop').hidden=true;document.body.classList.remove('post-dragging');
    // WebKit emits the release click in a later task after Escape. Retain the
    // guard until that click or the next pointerdown; a zero-delay timer races it.
    this.suppressClick=d.active||cancel;
    if(d.active||cancel)this.render(this.state,this.connected);else requestAnimationFrame(()=>this.render(this.state,this.connected));
    if(!cancel&&d.active&&d.valid)void this.send(d.key,'move',d.parent,d.before,d.revision).catch(e=>{$('organization-error').textContent=String(e);});
    else if(cancel&&d.active)$('organization-status').textContent='Move cancelled';
  }
}
