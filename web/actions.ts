type Lucide = {icons:Record<string,unknown>;createElement:(node:unknown,attrs:Record<string,string>)=>SVGElement};
export function icon(name:string) {
  const lucide=(window as unknown as {lucide:Lucide}).lucide;
  const key=name.replace(/(^|-)([a-z0-9])/g,(_,__,letter:string)=>letter.toUpperCase());
  const svg=lucide.createElement(lucide.icons[key],{});
  for(const [key,value] of Object.entries({'aria-hidden':'true',focusable:'false',width:'16',height:'16'}))svg.setAttribute(key,value);
  return svg;
}
/** Avoid replacing descendants during polling, including an active pointer press. */
export function action(control:HTMLElement,name:string|null,label:string,text=false,tooltip=true) {
  const signature=JSON.stringify([name,label,text,tooltip]);
  if(control.dataset.action===signature)return;
  control.dataset.action=signature;control.setAttribute('aria-label',label);
  control.classList.toggle('icon-action',!text);
  if(tooltip&&!text)control.dataset.actionTooltip=label;else delete control.dataset.actionTooltip;
  control.replaceChildren(...(name?[icon(name)]:[]),...(text?[document.createTextNode(label)]:[]));
}
/** A release after a state transition cannot turn a Cancel press into Publish. */
export function bindAction(control:HTMLElement,intent:()=>string,run:()=>void) {
  let pressed:string|null=null;
  control.addEventListener('pointerdown',()=>{pressed=intent();});
  control.addEventListener('pointercancel',()=>{pressed=null;});
  control.addEventListener('click',()=>{const before=pressed;pressed=null;if(before!==null&&before!==intent())return;run();});
}
export function setupActions() {
  const tip=document.createElement('span');tip.className='action-tooltip';tip.id='action-tooltip';tip.role='tooltip';tip.hidden=true;document.body.append(tip);
  let current:HTMLElement|null=null;
  const hide=()=>{current?.removeAttribute('aria-describedby');current=null;tip.hidden=true;};
  const show=(target:EventTarget|null)=>{
    const control=target instanceof Element?target.closest<HTMLElement>('[data-action-tooltip]'):null;
    if(!control||control.hasAttribute('disabled')){hide();return;}
    hide();current=control;tip.textContent=control.dataset.actionTooltip||'';tip.hidden=false;control.setAttribute('aria-describedby',tip.id);
    const r=control.getBoundingClientRect(),t=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-t.width-8,r.left+(r.width-t.width)/2))+'px';tip.style.top=(r.bottom+t.height+12<innerHeight?r.bottom+6:Math.max(8,r.top-t.height-6))+'px';
  };
  document.addEventListener('pointerover',e=>{if((e as PointerEvent).pointerType!=='touch')show(e.target);});
  document.addEventListener('pointerout',hide);document.addEventListener('focusin',e=>show(e.target));document.addEventListener('focusout',hide);document.addEventListener('pointerdown',hide);document.addEventListener('click',hide);document.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);
  const actions:Record<string,[string,string,boolean?]>={
    'settings-open':['settings','Settings'],'open-button':['plus','Open'],'sections-button':['menu','Sections'],
    'news-refresh':['refresh-cw','Refresh'],'news-previous':['chevron-left','Previous'],'news-next':['chevron-right','Next'],
    'catalog-previous':['chevron-left','Previous'],'catalog-next':['chevron-right','Next'],
    'creation-copy-magnet':['magnet','Copy magnet'],'creation-download':['file-down','Download .torrent'],
    'post-refresh':['refresh-cw','Refresh'],'post-open-latest':['chevrons-right','Open latest version'],
    'own-copy':['magnet','Copy post magnet'],'own-new-page':['file-plus-2','New page'],'creation-new-page':['file-plus-2','New page'],
    'own-add-files':['plus','Add files'],'creation-add-files':['plus','Add files'],'creation-delete':['trash-2','Delete draft'],
    'own-retry':['rotate-cw','Retry'],'publishing-keys-open':['key-round','Manage keys',true],
    'reader-load-images':['image','Load external images now',true],'reader-post-remove':['trash-2','Delete post…',true],
  };
  for(const [id,[glyph,label,text]] of Object.entries(actions)){const el=document.getElementById(id);if(el)action(el,glyph,label,text,id!=='sections-button');}
}
