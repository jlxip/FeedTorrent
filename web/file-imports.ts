export interface ImportOwner {kind:'creation'|'own';id:string;}
export interface ImportTask {cancel:()=>void;done:number;total:number;}
const tasks=new Map<string,ImportTask>();
export const importing=(owner:ImportOwner)=>tasks.get(`${owner.kind}/${owner.id}`);
async function request(path:string,method:string,body?:unknown) {
  const r=await fetch('./api/file-imports'+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const value=await r.json();if(!r.ok)throw Error(value.error||`Import failed (${r.status})`);return value;
}
/** File objects remain owned by the operation across internal route changes. */
export async function importFiles(owner:ImportOwner,page:number,revision:number,files:File[],update:()=>void) {
  const key=`${owner.kind}/${owner.id}`;if(tasks.has(key))throw Error('An import is already running');
  let cancelled=false,committed=false,id='',upload:XMLHttpRequest|null=null;
  const task:ImportTask={done:0,total:files.reduce((n,f)=>n+f.size,0),cancel:()=>{cancelled=true;upload?.abort();if(id)void request('/'+id,'DELETE').catch(()=>{});update();}};
  tasks.set(key,task);update();
  try {
    const manifest=files.map(f=>({path:(f.webkitRelativePath||f.name).split('/'),size:f.size}));
    const started=await request('','POST',{owner,page,revision,files:manifest});id=started.id;
    for(let index=0;index<files.length;index++) {
      if(cancelled)throw Error('Import cancelled');
      const base=task.done;
      await new Promise<void>((resolve,reject)=>{
        const xhr=upload=new XMLHttpRequest();xhr.open('PUT',`./api/file-imports/${id}/${index}`);
        xhr.upload.onprogress=e=>{task.done=base+e.loaded;update();};
        xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve();else {let message='Upload failed';try{message=JSON.parse(xhr.responseText).error||message;}catch{}reject(Error(message));}};
        xhr.onerror=()=>reject(Error('Upload disconnected'));xhr.onabort=()=>reject(Error('Import cancelled'));xhr.send(files[index]);
      });
      task.done=base+files[index].size;update();
    }
    if(cancelled)throw Error('Import cancelled');
    const value=await request('/'+id+'/commit','POST');committed=true;return value;
  } finally {
    tasks.delete(key);if(id&&!committed)void request('/'+id,'DELETE').catch(()=>{});update();
  }
}
/** Basecoat owns menu opening, dismissal and menu semantics. */
export function fileMenu(trigger:HTMLElement,choose:(files:File[])=>void) {
  const root=document.createElement('div');root.className='dropdown-menu file-menu';trigger.replaceWith(root);root.append(trigger);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  const pop=document.createElement('div');pop.setAttribute('data-popover','');pop.setAttribute('aria-hidden','true');
  const menu=document.createElement('div');menu.role='menu';menu.id=trigger.id+'-menu';trigger.setAttribute('aria-controls',menu.id);
  for(const [label,folder] of [['Files…',false],['Folder…',true]] as const) {
    const input=document.createElement('input');input.type='file';input.multiple=true;input.hidden=true;input.id=trigger.id+(folder?'-folder':'-files');if(folder)input.setAttribute('webkitdirectory','');
    input.onchange=()=>{const files=Array.from(input.files||[]);input.value='';if(files.length)choose(files);};
    const button=document.createElement('button');button.type='button';button.role='menuitem';button.textContent=label;button.onclick=()=>input.click();menu.append(button);root.append(input);
  }
  pop.append(menu);root.append(pop);
}
