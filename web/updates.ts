type Offer={id:string;version:string;target:string;size:number};
type Completed={operation:string;version:string;status:string;recovery:string};
type View={current:string;instance:string;supported:boolean;phase:string;offer:Offer|null;last_check:number|null;next_check:number;error:string;check_error:string;operation:string|null;done:number;total:number;recovery:string;completed:Completed|null};
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const active=(v:View)=>!['idle','checking'].includes(v.phase);
async function call(body:object){
  const r=await fetch('./api/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await r.json();if(!r.ok)throw Error(value.error||`Update request failed (${r.status})`);return value;
}
export class UpdatesUI{
  private view:View|null=null;
  private error='';
  private starting=false;
  private poll:Promise<void>|null=null;
  private frozen=new Map<HTMLElement,boolean>();
  constructor(private flush:()=>Promise<void>){
    $('application-update-check').onclick=()=>void call({action:'check'}).catch(e=>{this.error=String(e);this.draw();});
    $('application-update-install').onclick=()=>void this.install();
    $('application-update-cancel').onclick=()=>void call({action:'cancel',operation:this.view?.operation}).catch(e=>{this.error=String(e);this.draw();});
    void fetch('./api/updates').then(async r=>{if(r.ok)this.receive(await r.json());}).catch(()=>{});
  }
  receive(value:View){
    this.view=value;
    if(active(value)&&value.operation&&!this.poll){
      // Reconnect to this operation and program version, never merely a
      // listener that happened to claim the old HTTP port.
      if(value.phase==='restarting'||value.phase==='preparing')this.freeze();this.poll=this.reconnect(value);
    }
    if(value.phase==='idle'&&!this.starting&&!this.poll)this.thaw();
    this.draw();
  }
  private freeze(){
    for(const e of document.querySelectorAll<HTMLElement>('body > header, .workspace > aside, .workspace > main > :not(#application-update), body > footer, dialog')){
      if(!this.frozen.has(e))this.frozen.set(e,e.inert);e.inert=true;
    }
  }
  private thaw(){for(const [e,value] of this.frozen)e.inert=value;this.frozen.clear();}
  private async install(){
    const offer=this.view?.offer;if(!offer||this.starting)return;
    this.starting=true;this.error='';this.freeze();this.draw();
    try{
      await this.flush();
      // Keep in-memory drafts until every save and the install request succeed.
      const accepted=await call({action:'install',offer:offer.id});
      if(this.view&&!this.poll)this.poll=this.reconnect({...this.view,operation:accepted.operation,offer});
      for(const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]'))dialog.close();
    }catch(e){this.error=String(e);this.thaw();}
    finally{this.starting=false;this.draw();}
  }
  private async reconnect(previous:View){
    let deadline=Infinity,detail='';
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,500));
      try{
        const root=await fetch('./',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!root.ok)throw Error('FeedTorrent unavailable');
        const r=await fetch('./api/updates',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!r.ok)continue;
        const next:View=await r.json();
        if(next.instance===previous.instance){
          this.receive(next);
          if(!active(next)&&next.operation===previous.operation){this.poll=null;this.thaw();this.draw();return;}
          if(next.phase==='restarting'&&deadline===Infinity)deadline=Date.now()+90000;
          continue;
        }
        if(next.completed?.operation!==previous.operation){detail='A different FeedTorrent instance answered on this port.';continue;}
        if(next.current.replace(/^v/,'')===previous.offer?.version.replace(/^v/,'')&&next.completed.status==='installed'){location.reload();return;}
        if(next.completed.status==='recovered'){
          this.view=next;this.error='The update failed. FeedTorrent restored the previous executable.';this.poll=null;this.thaw();this.draw();return;
        }
      }catch{if(deadline===Infinity)deadline=Date.now()+90000;}
    }
    this.error=detail||'FeedTorrent did not reconnect. Restart it manually.';
    if(previous.recovery)this.error+=` Previous executable: ${previous.recovery}`;
    this.draw();
  }
  private draw(){
    const v=this.view;if(!v)return;
    const busy=active(v)||this.starting;
    $('application-version-current').textContent=`FeedTorrent ${v.current}`;
    const checked=v.last_check?`Last checked ${new Date(v.last_check*1000).toLocaleString()}.`:'No successful update check yet.';
    let status=!v.supported?'Automatic installation is unavailable on this platform.':v.phase==='checking'?'Checking for updates…':v.check_error||v.error||this.error?this.error||v.error||v.check_error:v.offer?`${v.offer.version} is available. ${checked}`:v.last_check?`Up to date. ${checked}`:checked;
    if(v.next_check>Date.now()/1000)status+=` Retry after ${new Date(v.next_check*1000).toLocaleString()}.`;
    $('application-version-status').textContent=status;
    $<HTMLButtonElement>('application-update-check').disabled=busy||v.phase==='checking'||!v.supported||v.next_check>Date.now()/1000;
    $('application-update').hidden=!v.offer&&!busy&&!this.error&&!v.error;
    $('application-update-title').textContent=this.starting?'Saving drafts…':busy?'Updating FeedTorrent':v.offer?`FeedTorrent ${v.offer.version} is available`:'Application update';
    const labels:Record<string,string>={downloading:'Downloading the release package…',verifying:'Verifying the package and its checksum…',probing:'Testing the new program with temporary data…',waiting:'Waiting for publications, imports and backup downloads to finish. Transfers continue until restart.',preparing:'Preparing the previous executable for recovery…',restarting:'Restarting FeedTorrent…'};
    $('application-update-status').textContent=labels[v.phase]||'';
    $('application-update-status').hidden=!labels[v.phase];
    $('application-update-error').textContent=this.error||v.error;
    $('application-update-error').hidden=!(this.error||v.error);
    const progress=$<HTMLProgressElement>('application-update-progress');progress.hidden=v.phase!=='downloading';if(v.total)progress.value=100*v.done/v.total;else progress.removeAttribute('value');
    const install=$<HTMLButtonElement>('application-update-install');install.hidden=busy||!v.offer;install.disabled=this.starting||v.phase==='checking';
    $('application-update-cancel').hidden=!busy||this.starting||['preparing','restarting'].includes(v.phase);
  }
}
