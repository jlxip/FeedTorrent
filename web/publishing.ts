import {ContentReader,ContentPage,torrentRoute,type ContentHost} from './content.js';
import type {MarkdownNode} from "./markdown.js";
import {ReaderHistory,type ReaderEntry} from "./reader.js";
import type { Snapshot } from "./types.js";
export interface OwnPost {
  id: string;
  title: string;
  magnet: string;
  revision: number;
  published_revision: number;
  sequence: string | null;
  published_sequence: string | null;
  pending_sequence: string | null;
  state: string;
  error: string;
  active: boolean;
  operation: number | null;
  pending_revision: number | null;
  phase: string;
  next_retry_at: number | null;
}
export interface PublishingState {
  has_key: boolean;
  public_key: string;
  posts: OwnPost[];
  error: string;
}
type Entry =
  | { kind: "page"; page: number }
  | { kind: "torrent"; name: string; data: number[] };
interface Page {
  id: number;
  title: string;
  body: string;
  entries: Entry[];
}
interface Draft {
  root: number;
  pages: Page[];
}
interface Session {
  draft: Draft;
  revision: number;
  edits: number;
  saved: number;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  error: string;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
function element(tag: string, text: string, cls = "") {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cls;
  return n;
}
function button(label: string, fn: () => void, variant = "default") {
  const n = element("button", label, "btn") as HTMLButtonElement;
  n.dataset.variant = variant;
  n.type = "button";
  n.onclick = fn;
  return n;
}
async function api(command: unknown) {
  const r = await fetch("./api/publishing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const value = await r.json();
  if (!r.ok)
    throw Error(value.error || `Publishing request failed (${r.status})`);
  return value;
}
export class PublishingUI {
  private state: Snapshot | null = null;
  private connected = false;
  private sessions = new Map<string, Session>();
  private removing=new Set<string>();
  private epochs=new Map<string,number>();
  private id = "";
  private current = 0;
  private trail: number[] = [];
  private reading = false;
  private loading = "";
  private ownIdentity=$("own-heading").parentElement!;
  private ownHeadingRow=this.ownIdentity.parentElement!;
  private reader=new ContentReader($("own-preview"),'own-reader');
  private content:ContentPage;
  private position=new ReaderHistory($("own-preview"),'ownReader',$("own-heading"));
  private readRoute='';
  private torrentIds=new WeakMap<number[],string>();
  private metadataKey='';
  private publishOrigin:{id:string;page:number;route:string}|null=null;
  private publishedDates=new Map<string,{dates:Record<string,{created_at:number|null;updated_at:number}|null>;differs:boolean}>();
  private bodyCache=new Map<string,MarkdownNode>();
  private bodyRequest='';
  private adding=new Set<number[]>();
  constructor(
    private link: (uri: string) => void,
    private addTorrent: (data: number[],id:string,post:string) => Promise<void>,
    private transfer:(id:string)=>void,
    private host:ContentHost,
  ) {
    this.content=new ContentPage(this.reader,host);
    $("own-create").onclick = () => {
      $("own-key-fields").hidden = !!this.state?.publishing.has_key;
      $("own-create-error").textContent = "";
      for (const input of $("own-create-form").querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
      $<HTMLDialogElement>("own-create-dialog").showModal();
      $("own-create-title").focus();
    };
    $("own-create-form").onsubmit = async (e) => {
      e.preventDefault();
      const submit = $<HTMLButtonElement>("own-create-submit");
      submit.disabled = true;
      try {
        if (!this.state?.publishing.has_key)
          await api({
            action: "create_key",
            password: $<HTMLInputElement>("own-key-password").value,
            confirmation: $<HTMLInputElement>("own-key-confirm").value,
          });
        const result = await api({
          action: "create_post",
          title: $<HTMLInputElement>("own-create-title").value,
        });
        $<HTMLFormElement>("own-create-form").reset();
        $<HTMLDialogElement>("own-create-dialog").close();
        location.hash = `#/own/${result.id}`;
      } catch (e) {
        $("own-create-error").textContent = String(e);
        if (/confirm|match/i.test(String(e)) && $<HTMLInputElement>("own-key-password").value !== $<HTMLInputElement>("own-key-confirm").value) $("own-key-confirm").setAttribute("aria-invalid", "true");
        else if (/title/i.test(String(e))) $("own-create-title").setAttribute("aria-invalid", "true");
      } finally {
        submit.disabled = false;
        this.clearSecrets("own-create-dialog");
      }
    };
    $("own-title").oninput = () => {
      const p = this.page();
      if (p) {
        p.title = $<HTMLInputElement>("own-title").value;
        if(p.id===this.session()?.draft.root)$("own-heading").textContent=p.title||"Own post";
        const current = $("own-breadcrumb").querySelector('[aria-current="page"]');
        if (current) current.textContent = p.title;
        this.changed();
      }
    };
    $("own-body").oninput = () => {
      const p = this.page();
      if (p) {
        p.body = $<HTMLTextAreaElement>("own-body").value;
        this.changed();
      }
    };
    $("own-new-page").onclick = () => {
      const s = this.session(),
        p = this.page();
      if (!s || !p) return;
      const id = Math.max(...s.draft.pages.map((p) => p.id)) + 1;
      s.draft.pages.push({ id, title: "Untitled page", body: "", entries: [] });
      p.entries.push({ kind: "page", page: id });
      this.changed();
      this.openPage(id);
      $("own-title").focus();
      $<HTMLInputElement>("own-title").select();
    };
    $("own-add-torrent").onclick = () =>
      $<HTMLInputElement>("own-torrent").click();
    $("own-torrent").onchange = async () => {
      const input = $<HTMLInputElement>("own-torrent"),
        file = input.files?.[0],
        id = this.id,
        page = this.current;
      try {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024)
          throw Error("Torrent metadata exceeds 8 MiB");
        const data = Array.from(new Uint8Array(await file.arrayBuffer()));
        if (id !== this.id || page !== this.current)
          throw Error("Page changed; select the file again");
        this.page()?.entries.push({ kind: "torrent", name: file.name, data });
        this.changed();
        this.drawEntries();
      } catch (e) {
        this.error(e);
      } finally {
        input.value = "";
      }
    };
    $("own-toggle").onclick = () => {
      location.hash=this.reading?`#/own/${this.id}`:this.readHref(this.current);
    };
    $("own-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.post()?.magnet || "");
        $("own-status").textContent = "Post magnet copied";
      } catch (e) {
        this.error(e);
      }
    };
    $("own-retry").onclick = () => void this.publicationAction("retry_publication");
    $("own-cancel").onclick = () => void this.publicationAction("cancel_publication");
    $("own-publish").onclick = async () => {
      const origin={id:this.id,page:this.current,route:location.hash};
      this.publishOrigin=origin;
      try {
        await this.flush(origin.id);
        if(this.publishOrigin!==origin||location.hash!==origin.route||this.id!==origin.id||this.current!==origin.page||!this.post())return;
        $("own-publish-error").textContent = "";
        $("own-publish-password").removeAttribute("aria-invalid");
        $<HTMLDialogElement>("own-publish-dialog").showModal();
        $("own-publish-password").focus();
      } catch (e) {
        this.error(e);
      }
    };
    $("own-publish-form").onsubmit = async (e) => {
      e.preventDefault();
      const submit = $<HTMLButtonElement>("own-publish-submit");
      submit.disabled = true;
      const origin=this.publishOrigin;
      try {
        if(!origin)return;
        await this.flush(origin.id);
        if(this.publishOrigin!==origin||!$<HTMLDialogElement>("own-publish-dialog").open||location.hash!==origin.route)return;
        const s = this.sessions.get(origin.id),previous=this.post();
        if (!s) return;
        const revision=s.revision;
        const result = await api({
          action: "publish",
          id: origin.id,
          revision,
          password: $<HTMLInputElement>("own-publish-password").value,
        });
        const post = this.state?.publishing.posts.find(p=>p.id===origin.id);
        // Do not overwrite a newer SSE snapshot received before this response.
        if (post && post===previous) {
          post.operation = result.operation;
          post.pending_sequence = null;
          post.pending_revision = revision;
          post.phase = "Queued";
          post.state = "Queued";
          post.error = "";
          this.render(this.state, this.connected);
        }
        const show=this.publishOrigin===origin&&this.id===origin.id&&this.current===origin.page&&location.hash===origin.route&&post;
        if(this.publishOrigin===origin)$<HTMLDialogElement>("own-publish-dialog").close();
        if(show)location.hash=`#/own/${origin.id}/read/${origin.page}`;
      } catch (e) {
        if(this.publishOrigin===origin)$("own-publish-error").textContent = String(e);
      } finally {
        submit.disabled = false;
        if(this.publishOrigin===origin)this.clearSecrets("own-publish-dialog");
      }
    };
    $("publishing-keys-open").onclick = () => {
      for (const input of $("publishing-keys-dialog").querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
      $<HTMLDialogElement>("publishing-keys-dialog").showModal();
    };
    $("own-export-keys").onclick = () => this.export(false);
    $("own-export-full").onclick = () => this.export(true);
    $("own-import-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const file = $<HTMLInputElement>("own-import-file").files?.[0];
        if (!file) throw Error("Select a backup");
        if (file.size > 256 * 1024 * 1024)
          throw Error("Backup exceeds 256 MiB");
        const password = $<HTMLInputElement>("own-import-password").value;
        const encoded = Array.from(new TextEncoder().encode(password))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const r = await fetch("./api/publishing/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-tar",
            "X-FeedTorrent-Password": encoded,
          },
          body: file,
        });
        const value = await r.json();
        if (!r.ok) throw Error(value.error);
        this.sessions.clear();
        $("own-keys-status").textContent =
          "Backup restored; publishing disabled until you publish explicitly";
        $<HTMLFormElement>("own-import-form").reset();
      } catch (e) {
        $("own-import-error").textContent = String(e);
      } finally {
        this.clearSecrets("publishing-keys-dialog");
      }
    };
    let changingPassword=false;
    $("own-password-form").onsubmit = async (e) => {
      e.preventDefault();
      if(changingPassword)return;changingPassword=true;
      const submit=$("own-password-form").querySelector<HTMLButtonElement>("button")!;submit.disabled=true;
      $("own-password-error").textContent="";$("own-keys-status").textContent="";
      for(const input of $("own-password-form").querySelectorAll("[aria-invalid]"))input.removeAttribute("aria-invalid");
      try {
        await api({
          action: "change_password",
          old: $<HTMLInputElement>("own-old-password").value,
          password: $<HTMLInputElement>("own-new-password").value,
          confirmation: $<HTMLInputElement>("own-confirm-password").value,
        });
        $("own-keys-status").textContent = "Password changed";
        $<HTMLFormElement>("own-password-form").reset();
      } catch (e) {
        $("own-password-error").textContent = String(e);
        if (/confirm|match/i.test(String(e)) && $<HTMLInputElement>("own-new-password").value !== $<HTMLInputElement>("own-confirm-password").value) $("own-confirm-password").setAttribute("aria-invalid", "true");
      } finally {
        this.clearSecrets("publishing-keys-dialog");
        changingPassword=false;submit.disabled=false;
      }
    };
    for (const id of [
      "own-create-dialog",
      "own-publish-dialog",
      "publishing-keys-dialog",
    ])
      $(id).addEventListener("close", () => {
        this.clearSecrets(id);
        if(id==='own-publish-dialog')this.publishOrigin=null;
      });
    window.addEventListener("hashchange", () => {
      if(this.publishOrigin&&location.hash!==this.publishOrigin.route){
        this.publishOrigin=null;$<HTMLDialogElement>('own-publish-dialog').close();
      }
      const old = this.id;
      if (this.sessions.get(old)?.edits !== this.sessions.get(old)?.saved)
        void this.flush(old).catch(() => {});
      this.render(this.state, this.connected);
    });
  }
  private forget(id:string){
    const session=this.sessions.get(id);if(session?.timer)clearTimeout(session.timer);
    this.sessions.delete(id);this.publishedDates.delete(id);this.epochs.set(id,(this.epochs.get(id)||0)+1);
    if(this.loading===id)this.loading='';
  }
  async removePost(id:string,remove:()=>Promise<unknown>){
    if(!this.connected||!this.state?.ready)throw Error('Server disconnected');
    if(this.removing.has(id))throw Error('Post removal already running');
    this.removing.add(id);
    const session=this.sessions.get(id);if(session?.timer){clearTimeout(session.timer);session.timer=null;}
    if(this.id===id)$('own-view').inert=true;
    let removed=false;
    try{
      // Finish a request already sent; queued saves observe the removal guard.
      await session?.queue.catch(()=>{});
      if(!this.connected)throw Error('Server disconnected');
      await remove();removed=true;this.forget(id);
    }finally{
      this.removing.delete(id);
      if(!removed){
        if(this.id===id)$('own-view').inert=false;
        if(this.connected&&session&&this.sessions.get(id)===session&&session.edits!==session.saved)
          void this.flush(id).catch(()=>{});
      }
    }
  }
  private clearSecrets(id: string) {
    for (const input of $(id).querySelectorAll<HTMLInputElement>(
      "input[type=password]",
    ))
      input.value = "";
  }
  private post() {
    return this.state?.publishing.posts.find((f) => f.id === this.id);
  }
  private session() {
    return this.sessions.get(this.id);
  }
  private page() {
    return this.session()?.draft.pages.find((p) => p.id === this.current);
  }
  private error(e: unknown) {
    $("own-error").firstElementChild!.textContent = String(e);
    $("own-error").hidden = false;
  }
  private changed() {
    const s = this.session();
    if (!s||this.removing.has(this.id)) return;
    s.edits++;
    s.error = "";
    this.indicator();
    $("own-draft-status").textContent = "Saving…";
    if (s.timer) clearTimeout(s.timer);
    const id = this.id;
    s.timer = setTimeout(() => void this.flush(id).catch(() => {}), 400);
  }
  private async flush(id = this.id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    s.queue = s.queue
      .catch(() => {})
      .then(async () => {
        if (s.saved === s.edits||this.removing.has(id)||this.sessions.get(id)!==s) return;
        const edits = s.edits,
          draft = structuredClone(s.draft);
        try {
          const value = await api({
            action: "save_draft",
            id,
            revision: s.revision,
            draft,
          });
          if(this.sessions.get(id)!==s)return;
          s.revision = value.revision;
          s.saved = edits;
          s.error = "";
          if(this.id===id&&this.reading)this.drawReading();
          if (this.id === id&&!this.removing.has(id))
            $("own-draft-status").textContent =
              s.saved === s.edits ? "Draft saved" : "Saving…";
        } catch (e) {
          if(this.sessions.get(id)!==s)return;
          s.error = String(e);
          if (this.id === id&&!this.removing.has(id)) {
            this.error(e);
            $("own-draft-status").textContent = "Not saved";
          }
          throw e;
        }
      });
    await s.queue;
  }
  private openPage(page: number) {
    if(this.reading){location.hash=this.readHref(page);return;}
    this.current = page;
    this.trail.push(page);
    this.draw();
  }
  private drawEntries() {
    const s = this.session(),
      p = this.page();
    if (!s || !p) return;
    const container = $("own-entries");
    container.replaceChildren();
    p.entries.forEach((e, i) => {
      const row = element("div", "", "own-entry"),
        name =
          e.kind === "page"
            ? s.draft.pages.find((p) => p.id === e.page)?.title ||
              "Unavailable page"
            : e.name;
      const label =
        e.kind === "page"
          ? button(name, () => this.openPage(e.page), "link")
          : this.reading
            ? button(
                name,
                () => void this.downloadOwn(e),
                "link",
              )
            : element("span", name);
      label.classList.add("own-entry-name");
      row.append(
        label,
        element("span", e.kind === "page" ? "Page" : "Torrent", "muted"),
      );
      const up = button(
        "↑",
        () => {
          [p.entries[i - 1], p.entries[i]] = [p.entries[i], p.entries[i - 1]];
          this.changed();
          this.drawEntries();
        },
        "link",
      );
      up.dataset.variant = "ghost";
      up.dataset.size = "icon-sm";
      up.disabled = i === 0;
      up.setAttribute("aria-label", `Move ${name} up`);
      const remove = button(
        "×",
        () => {
          p.entries.splice(i, 1);
          const reachable = new Set<number>();
          const walk = (id: number) => {
            reachable.add(id);
            for (const e of s.draft.pages.find((p) => p.id === id)?.entries ||
              [])
              if (e.kind === "page") walk(e.page);
          };
          walk(s.draft.root);
          s.draft.pages = s.draft.pages.filter((p) => reachable.has(p.id));
          this.changed();
          this.drawEntries();
        },
        "link",
      );
      remove.dataset.variant = "destructive";
      remove.dataset.size = "icon-sm";
      remove.setAttribute("aria-label", `Remove ${name}`);
      if (!this.reading) row.append(up, remove);
      container.append(row);
    });
    if (!p.entries.length) {
      const empty = element("div", "", "empty"), header = element("header", "");
      header.append(element("h3", "No items"));
      empty.append(header);
      container.append(empty);
    }
  }
  private draw() {
    const s=this.session(),p=this.page();
    $("own-editor").hidden=this.reading;$("own-preview").hidden=!this.reading;
    $("own-contents-heading").hidden=this.reading;$("own-entries").hidden=this.reading;$("own-editor-actions").hidden=this.reading;
    $("own-toggle").textContent=this.reading?'Edit':'Public view';
    const actions=this.reading?$('own-top-actions'):$('own-publish').parentElement!;
    const before=this.reading?$('own-toggle'):$('own-publish');
    for(const id of ['own-retry','own-cancel']){const control=$(id);if(control.parentElement!==actions)actions.insertBefore(control,before);}
    $("own-new-page").hidden=this.reading;$("own-add-torrent").hidden=this.reading;
    const header=this.reader.header,topActions=$('own-top-actions');
    const target=this.reading?header.identity:this.ownHeadingRow;
    if(this.ownIdentity.parentElement!==target){
      const focused=document.activeElement instanceof HTMLElement&&
        (this.ownIdentity.contains(document.activeElement)||topActions.contains(document.activeElement))?document.activeElement:null;
      if(this.reading){header.adopt(this.ownIdentity);header.identity.append(topActions);}
      else{header.restoreIdentity();this.ownHeadingRow.prepend(this.ownIdentity);this.ownHeadingRow.append(topActions);}
      this.ownHeadingRow.hidden=this.reading;
      focused?.focus({preventScroll:true});
    }
    if(this.reading){$("own-breadcrumb").hidden=true;this.drawReading();return;}
    this.content.leave();
    if(!s||!p)return;
    $<HTMLInputElement>("own-title").value=p.title;$<HTMLTextAreaElement>("own-body").value=p.body;
    const crumbs = $("own-breadcrumb");
    crumbs.hidden = this.trail.length < 2;
    crumbs.replaceChildren();
    const list = element("ol", "");
    crumbs.append(list);
    this.trail.forEach((id, i) => {
      if (i) {
        const separator = element("li", "/");
        separator.setAttribute("aria-hidden", "true");
        list.append(separator);
      }
      const item = element("li", ""), title = s.draft.pages.find(p => p.id === id)?.title || "Page";
      if (i === this.trail.length - 1) {
        const current = element("span", title);
        current.setAttribute("aria-current", "page");
        item.append(current);
      } else {
        const link = button(title, () => {
          this.trail = this.trail.slice(0, i + 1);
          this.current = id;
          this.draw();
        }, "link");
        link.dataset.size = "sm";
        item.append(link);
      }
      list.append(item);
    });
    this.drawEntries();
  }
  private readHref(page:number){return `#/own/${this.id}/read/${page}`;}
  private readPage(){
    const value=location.hash.split('/')[4],id=value===undefined?this.session()?.draft.root:value&&/^\d+$/.test(value)?Number(value):NaN;
    this.current=Number.isSafeInteger(id)&&this.session()?.draft.pages.some(p=>p.id===id)?id!:0;
    if(value===undefined&&this.current){history.replaceState(history.state,'',this.readHref(this.current));this.readRoute=location.hash;this.position.enter();}
  }
  private rememberIds(value:any){
    const s=this.session();if(!s)return;
    this.publishedDates.set(this.id,{dates:value.published_dates||{},differs:!!value.draft_differs});
    for(const meta of value.torrent_ids||[]){
      const local=s.draft.pages.find(p=>p.id===meta.page)?.entries[meta.index];
      const remote=value.draft.pages.find((p:Page)=>p.id===meta.page)?.entries[meta.index];
      if(local?.kind==='torrent'&&remote?.kind==='torrent'&&local.data.length===remote.data.length&&local.data.every((v,i)=>v===remote.data[i]))this.torrentIds.set(local.data,meta.infohash);
    }
  }
  private drawReading(){
    const s=this.session(),p=this.page();if(!s)return;
    if(!p){this.content.leave();this.reader.header.update({title:'Page unavailable',connected:this.connected,noTorrent:true});this.reader.dates(null);this.reader.content('missing',null);this.reader.entries([],false);this.reader.breadcrumbs([{name:this.post()?.title||'Post',href:this.readHref(s.draft.root)},{name:'Page unavailable',href:location.hash}]);return;}
    const find=(id:number,path:number[]):number[]|null=>{if(id===p.id)return [...path,id];for(const e of s.draft.pages.find(p=>p.id===id)?.entries||[])if(e.kind==='page'){const found=find(e.page,[...path,id]);if(found)return found;}return null;};
    this.trail=find(s.draft.root,[])||[p.id];
    const trail=this.trail.map(id=>({name:s.draft.pages.find(p=>p.id===id)?.title||'Page',href:this.readHref(id)}));
    const key=`${this.id}/${s.revision}/${s.edits}/${this.post()?.published_revision}`;
    if(this.connected&&s.edits===s.saved&&this.metadataKey!==key){
      this.metadataKey=key;const id=this.id;
      void api({action:'get_post',id}).then(value=>{if(id===this.id){this.rememberIds(value);if(this.reading)this.drawReading();}}).catch(e=>{if(id===this.id)this.error(e);this.metadataKey='';});
    }
    const nested=torrentRoute();
    if(nested){
      const parts=location.hash.split('/'),rootId=parts[6];
      const entry=p.entries.find((e):e is Extract<Entry,{kind:'torrent'}>=>e.kind==='torrent'&&this.torrentIds.get(e.data)===rootId);
      if(!entry){this.content.leave();this.reader.header.update({title:'Torrent unavailable',connected:this.connected,noTorrent:true});this.reader.dates(null);this.reader.content('unavailable',null);this.reader.entries([],false);this.reader.breadcrumbs([...trail,{name:'Torrent unavailable',href:location.hash}]);return;}
      const crumbs=[...trail];for(let i=6;i<parts.length-1;i++)if(/^[0-9a-f]{40}$/.test(parts[i]))crumbs.push({name:this.state?.transfers.find(t=>t.id===parts[i])?.name||'Catalog',href:parts.slice(0,i+1).join('/')});
      this.content.render({id:nested.id,parent:nested.id===rootId?undefined:nested.parent,state:this.state,connected:this.connected,crumbs,position:this.position,source:this.post()?.title,signature:`${s.revision}/${s.edits}/${s.saved}`,
        load:(offset)=>nested.id!==rootId?this.host.call({type:'read_content',id:nested.id,parent:nested.parent,offset},false):this.state?.transfers.some(t=>t.id===nested.id)?this.host.call({type:'read_content',id:nested.id,offset},false):api({action:'inspect_entry',id:this.id,page:p.id,infohash:nested.id}),
        download:nested.id===rootId?()=>this.downloadOwn(entry):undefined});return;
    }
    this.content.leave();this.reader.breadcrumbs(trail);this.reader.header.update({title:p.title||'Page',id:this.id,connected:this.connected,noTorrent:true,source:'Current draft'});
    const published=this.publishedDates.get(this.id),hasPublished=!!published&&Object.hasOwn(published.dates,String(p.id));
    this.reader.dates(hasPublished?{...published!.dates[p.id],last_published:published!.differs||s.edits!==s.saved}:null);
    const tree=this.bodyCache.get(p.body)||null;
    this.reader.content(`${this.id}/${p.id}`,tree,target=>{
      if(target.startsWith('magnet:'))return ()=>this.link(target);
      let name:string;try{name=decodeURIComponent(target).replace(/^\.\//,'');}catch{return null;}
      const entry=p.entries.find(e=>(e.kind==='torrent'?e.name:s.draft.pages.find(p=>p.id===e.page)?.title+'.torrent')===name);
      if(entry?.kind==='page')return ()=>this.openPage(entry.page);
      if(entry?.kind==='torrent')return ()=>{const id=this.torrentIds.get(entry.data);if(id&&this.state?.transfers.some(t=>t.id===id))location.hash=this.readHref(p.id)+'/torrent/'+id;else void this.downloadOwn(entry);};
      return null;
    });
    const entries:ReaderEntry[]=p.entries.map((e,index)=>{
      if(e.kind==='page'){const page=s.draft.pages.find(p=>p.id===e.page);return {key:String(index),name:page?.title||'Page unavailable',kind:'page',href:page?this.readHref(e.page):undefined};}
      const id=this.torrentIds.get(e.data),t=this.state?.transfers.find(t=>t.id===id);
      return {key:String(index),name:e.name,kind:'torrent',size:t?.total,href:id?this.readHref(p.id)+'/torrent/'+id:undefined,label:t?undefined:'Download',disabled:!id,actionDisabled:!this.connected||!id||this.adding.has(e.data),action:()=>void this.downloadOwn(e)};
    });
    this.reader.entries(entries,!!tree||!p.body);
    this.position.patch({trail});
    if(tree||!p.body)this.position.restore();
    if(p.body&&!tree&&this.connected&&this.bodyRequest!==p.body){
      const body=p.body,route=location.hash;this.bodyRequest=body;
      void api({action:'preview',body}).then((value:{body:MarkdownNode})=>{this.bodyCache.set(body,value.body);if(location.hash===route&&this.reading&&this.page()?.body===body)this.drawReading();}).catch(e=>{if(location.hash===route)this.error(e);}).finally(()=>{if(this.bodyRequest===body)this.bodyRequest='';});
    }

  }
  private async downloadOwn(entry:Extract<Entry,{kind:'torrent'}>){
    const id=this.torrentIds.get(entry.data),route=location.hash;if(!id||!this.connected||this.adding.has(entry.data))return;
    if(this.state?.transfers.some(t=>t.id===id))return;
    this.adding.add(entry.data);this.drawReading();
    try{await this.addTorrent(entry.data,id,this.id);}catch(e){if(location.hash===route)this.error(e);}
    finally{this.adding.delete(entry.data);if(location.hash===route)this.drawReading();}
  }

  render(state: Snapshot | null, connected: boolean) {
    this.state = state;
    this.connected = connected;
    if(state){
      for(const id of this.sessions.keys())if(!state.publishing.posts.some(f=>f.id===id))this.forget(id);
      if(this.loading&&!state.publishing.posts.some(f=>f.id===this.loading))this.forget(this.loading);
    }
    const route = location.hash.split("/"),
      active = route[1] === "own";
    $("own-view").hidden = !active;
    if (active) {
      $("transfer-view").hidden = true;
      $("post-view").hidden = true;
    }
    for (const id of ["own-create", "publishing-keys-open"])
      $<HTMLButtonElement>(id).disabled = !connected || !state?.ready;
    if (!active) {
      this.content.leave();this.position.leave();this.readRoute="";
      $("own-publication-help").hidden = true;
      this.id = "";
      return;
    }
    const id = route[2] || "";
    if (this.id !== id) {
      $("own-publication-help").hidden = true;
      this.id = id;
      this.trail = [];
      this.current = 0;
      this.reading = false;
    }
    this.reading=route[3]==='read';if(!this.reading)this.position.leave();
    const routeChanged=this.readRoute!==location.hash;this.readRoute=location.hash;
    if(this.reading){this.position.enter();if(this.session())this.readPage();}
    const f = this.post();
    $('own-view').inert=this.removing.has(id);
    $('own-view').toggleAttribute('data-unavailable',!f);
    $('own-unavailable').hidden=!!f;
    if(!f){
      this.content.leave();this.position.leave();
      $('own-unavailable').querySelector('h3')!.textContent=state?'Post unavailable':'Loading…';
      return;
    }
    const session = this.sessions.get(id);
    // The input and its heading must share a draft: delayed snapshots must not
    // reflow the actions after autosave has already reported success.
    const title=session&&(session.edits!==session.saved||session.revision>=f.revision)
      ?session.draft.pages.find(p=>p.id===session.draft.root)?.title:f.title;
    $("own-heading").textContent = title || "Own post";
    this.indicator();
    $("own-publish").toggleAttribute(
      "disabled",
      !connected || !f || f.operation !== null,
    );
    $("own-retry").hidden = !f?.operation || f.next_retry_at === null;
    $("own-cancel").hidden = !f?.operation;
    for (const id of ["own-retry", "own-cancel"])
      $<HTMLButtonElement>(id).disabled = !connected;
    const problem = this.session()?.error || state?.publishing.error || "";
    if ($("own-error").firstElementChild!.textContent !== problem) $("own-error").firstElementChild!.textContent = problem;
    $("own-error").hidden = !problem;
    if (session && f && session.edits === session.saved)
      $("own-draft-status").textContent =
        "Draft saved" +
        (f.published_revision > 0 && session.revision > f.published_revision
          ? " · Unpublished changes"
          : "");
    if (!session && id && this.loading !== id) {
      this.loading = id;
      const epoch=this.epochs.get(id)||0;
      void api({ action: "get_post", id })
        .then((value) => {
          if((this.epochs.get(id)||0)!==epoch||!this.state?.publishing.posts.some(f=>f.id===id))return;
          this.sessions.set(id, {
            draft: value.draft,
            revision: value.revision,
            edits: 0,
            saved: 0,
            queue: Promise.resolve(),
            timer: null,
            error: "",
          });
          if (this.id === id) {
            this.current = value.draft.root;
            this.trail = [this.current];
            this.rememberIds(value);if(this.reading)this.readPage();
            this.draw();
          }
        })
        .catch((e) => {if(this.id===id&&(this.epochs.get(id)||0)===epoch&&this.post())this.error(e);})
        .finally(() => {
          if(this.loading===id&&(this.epochs.get(id)||0)===epoch)this.loading = "";
        });
    } else if (session && !this.current && !this.reading) {
      this.current = session.draft.root;
      this.trail = [this.current];
      this.draw();
    }
    if(session&&(this.reading||routeChanged))this.draw();
    if (
      session &&
      f &&
      f.revision > session.revision &&
      session.edits === session.saved
    ) {
      this.sessions.delete(id);
      this.current = 0;
    }
  }
  private indicator() {
    const f = this.post(), session = this.session();
    const indicator = $("own-indicator");
    const problem = session?.error || this.state?.publishing.error || "";
    const dirty = !!session && (session.edits !== session.saved || session.revision > (f?.published_revision || 0));
    let color = "draft", label = "Draft";
    const details: string[] = [];
    if (!this.connected) {
      label = "Server disconnected";
    } else if (problem || f?.state === "Error") {
      color = "error";
      label = "Publication error";
    } else if (f?.operation != null) {
      color = "pending";
      label = f.phase || f.state;
    } else if (f?.state === "Canceled") {
      label = "Publication canceled";
    } else if (f && f.published_revision > 0 && f.published_revision === f.revision && !dirty) {
      color = "published";
      label = "Published";
    } else if (f && (f.published_revision > 0 || dirty)) {
      label = "Unpublished changes";
    }
    if(f?.pending_sequence!=null)details.push(`Publishing Version ${f.pending_sequence}`);
    else if(f?.operation==null&&f?.sequence!=null&&f.sequence!==f.published_sequence)
      details.push(`Signed Version ${f.sequence}`);
    if(f?.published_sequence!=null)details.push(`Published Version ${f.published_sequence}`);
    else if(f?.published_revision)details.push('Published Version unknown');
    if (f?.next_retry_at != null) details.push(`Next retry: ${new Date(f.next_retry_at).toLocaleTimeString()}`);
    if (problem || f?.error) details.push(problem || f!.error);
    indicator.dataset.state = color;
    indicator.setAttribute("aria-label", label);
    $("own-publication-help").textContent = [label, ...details].join("\n");
    if ($("own-status").textContent !== label) $("own-status").textContent = label;
  }
  private async publicationAction(action: "retry_publication" | "cancel_publication") {
    const f = this.post();
    if (!this.connected || f?.operation == null) return;
    const id = f.id, operation = f.operation;
    try {
      for (const name of ["own-retry", "own-cancel"]) $<HTMLButtonElement>(name).disabled = true;
      await api({action, id, operation});
    } catch (e) {
      this.error(e);
    }
  }
  private async export(full: boolean) {
    try {
      const r = await fetch(`./api/publishing/backup?full=${full}`);
      if (!r.ok) throw Error((await r.json()).error);
      const blob = await r.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = full ? "feedtorrent-publishing.tar" : "feedtorrent-keys.tar";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      $("own-keys-status").textContent = String(e);
    }
  }
}
