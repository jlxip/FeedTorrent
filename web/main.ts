import {initReaderSettings,readerSettingsState,readerSettingsRemoved} from './reader.js';
import {imageState} from './images.js';
import {CreationUI} from './creation.js';
import {size} from './reader.js';
import {OrganizationUI} from "./organization.js";
import {LibraryUI} from "./library.js";
import {NewsUI} from "./news.js";
import {PublishingUI} from "./publishing.js";
import {PostsUI} from "./posts.js";
import type { Snapshot, Command, InspectedSource, Settings, RemovalTarget, RemovalPreview } from "./types.js";
const $ = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
let state: Snapshot | null = null,
  connected = false,
  removing: string | null = null;
// Legacy bookmarks share the Library entry rather than adding a redirect to Back.
function normalizeRoute() {
  if(history.state?.feedReader&&!history.state?.postReader)history.replaceState({...history.state,postReader:history.state.feedReader},'');
  if (!location.hash || location.hash === "#" || location.hash === "#/")
    history.replaceState(history.state, "", "#/new");
  else if (location.hash === "#/transfers")
    history.replaceState(history.state, "", "#/library");
  if (location.hash.startsWith("#/feeds/"))
    history.replaceState(history.state, "", location.hash.replace(/^#\/feeds\//, "#/posts/"));
  history.scrollRestoration = ["new", "library", "posts", "own"].includes(location.hash.split("/")[1]) ? "manual" : "auto";
}
normalizeRoute();
window.addEventListener("hashchange", normalizeRoute);
let opening = false;
function updateOpenButtons() {
  const ready = connected && !!state?.ready && !opening;
  $<HTMLButtonElement>("#magnet-form button[type=submit]").disabled =
    !ready || !$<HTMLInputElement>("#magnet").value.trim();
  const file = $<HTMLInputElement>("#torrent-file").files?.[0];
  $<HTMLButtonElement>("#torrent-form button[type=submit]").disabled =
    !ready || !file || file.size > 8 * 1024 * 1024;
}
type TabsElement = HTMLElement & {
  select: (tab: HTMLButtonElement, focus?: boolean) => void;
};
declare global {
  interface Window {
    basecoat: {init: (name: string) => void};
  }
}
window.basecoat.init("tabs");
window.basecoat.init("sidebar");
type SidebarElement = HTMLElement & {open: () => void; close: () => void; toggle: () => void};
const sidebar = $<SidebarElement>("#sidebar");
const sectionsButton = $<HTMLButtonElement>("#sections-button");
const mobileSections = matchMedia("(max-width: 767px)");
const appHeader = $("body > header");
let sectionsDialog: HTMLDialogElement | null = null;
let sectionsWereOpen = sidebar.getAttribute("aria-hidden") === "false";
function syncSections() {
  const open = sidebar.getAttribute("aria-hidden") === "false";
  const overlay = mobileSections.matches && open;
  sectionsButton.setAttribute("aria-expanded", String(open));
  $(".workspace > main").inert = overlay;
  $("body > footer").inert = overlay;
  for (const button of appHeader.querySelectorAll<HTMLElement>("button:not(#sections-button)"))
    button.inert = overlay;
  if (mobileSections.matches && sectionsWereOpen && !open)
    requestAnimationFrame(() => {
      if (sidebar.getAttribute("aria-hidden") === "true" && !document.querySelector("dialog[open]"))
        sectionsButton.focus();
    });
  sectionsWereOpen = open;
}
new MutationObserver(syncSections).observe(sidebar, {attributes:true, attributeFilter:["aria-hidden"]});
function updateSidebarTop() {
  document.documentElement.style.setProperty("--app-header-height", `${Math.max(0, appHeader.getBoundingClientRect().bottom)}px`);
}
new ResizeObserver(updateSidebarTop).observe(appHeader);
window.addEventListener("scroll", updateSidebarTop, {passive:true});
sectionsButton.onclick = () => {
  sidebar.toggle();
  syncSections();
  if (sidebar.getAttribute("aria-hidden") === "false")
    sidebar.querySelector<HTMLElement>("a")?.focus();
};
mobileSections.addEventListener("change", () => {
  const focused = sidebar.contains(document.activeElement);
  const toggleFocused = document.activeElement === sectionsButton;
  if (mobileSections.matches) {
    // A breakpoint change must not queue a focus return over ongoing editing.
    sectionsWereOpen = false;
    sidebar.close();
  } else sidebar.open();
  syncSections();
  if (mobileSections.matches && focused) sectionsButton.focus();
  else if (!mobileSections.matches && toggleFocused) sidebar.querySelector<HTMLElement>("a")?.focus();
});
window.addEventListener("hashchange", () => {
  if (mobileSections.matches) sidebar.close();
});
// Sidebar 1.0.2 blurs the active element when a button closes it. Dialog
// launchers opt out of that path so their newly focused field stays focused.
sidebar.addEventListener("click", event => {
  if (!mobileSections.matches || !(event.target as Element).closest("[data-keep-mobile-sidebar-open]")) return;
  sectionsDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (sectionsDialog) sidebar.close();
});
document.addEventListener("keydown", event => {
  if (!mobileSections.matches || sidebar.getAttribute("aria-hidden") !== "false" || document.querySelector("dialog[open]")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    sidebar.close();
    syncSections();
  } else if (event.key === "Tab") {
    const controls = [sectionsButton, ...sidebar.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")].filter(e => e.getClientRects().length);
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    event.preventDefault();
    controls[next].focus();
  }
});
document.addEventListener("close", event => {
  if (event.target !== sectionsDialog) return;
  sectionsDialog = null;
  if (mobileSections.matches && sidebar.getAttribute("aria-hidden") === "true" && !document.querySelector("dialog[open]"))
    sectionsButton.focus();
}, true);
syncSections();
const openTabs = $<TabsElement>("#open-tabs");
function opened() {
  $<HTMLInputElement>("#magnet").value = "";
  $<HTMLInputElement>("#torrent-file").value = "";
  $("#magnet-error").textContent = "";
  $("#open-torrent-error").textContent = "";
  $("#torrent-name").textContent = "No file selected";
  $<HTMLDialogElement>("#open-dialog").close();
  notice("");
}
function notice(value: string) {
  const content = $("#notice > section");
  if (content.textContent !== value) content.textContent = value;
  $("#notice").hidden = !value;
}
async function send(c: Command) {
  if (!connected)
    throw Error("Server disconnected. Restart FeedTorrent to reconnect.");
  const r = await fetch("./api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c),
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || `Request failed (${r.status})`);
  return j;
}
async function command(c:Command){const result=await send(c);await sync();return result;}
let removalTarget:RemovalTarget|null=null,removalPreview:RemovalPreview|null=null,removalRequest=0,removalBusy=false;
function rootName(root:string){const [kind,id]=root.split(':');return kind==='own'?state?.publishing.posts.find(p=>p.id===id)?.title||'Post':state?.posts.find(p=>p.id===id)?.name||'Post';}
async function refreshRemoval(){
  if(!removalTarget)return;const request=++removalRequest;removalPreview=null;
  const submit=$<HTMLButtonElement>('#remove-form button[type=submit]');submit.disabled=true;
  try{
    const preview=await send({type:'preview_removal',target:removalTarget}) as RemovalPreview;
    if(request!==removalRequest)return;removalPreview=preview;
    const used=(preview.used_by||[]).map(rootName);
    $('#remove-preview').textContent=removalTarget.kind==='unpin'
      ? `Unpin and delete ${preview.deleting.length} unreferenced torrents (${size(preview.bytes)}).`
      : `${used.length?'Used by '+used.join(', ')+'. This removes the downloaded copy for all of them. ':''}${removalTarget.kind==='torrent'&&removalTarget.delete_files?'Downloaded files will be deleted.':'Downloaded files will be kept.'}`;
  }catch(e){if(request===removalRequest)$('#remove-error').textContent=String(e);}
  finally{if(request===removalRequest)submit.disabled=removalBusy||!removalPreview||!connected;}
}
function showRemoval(id:string,target:RemovalTarget){
  removing=id;removalTarget=target;$('#remove-error').textContent='';$('#remove-preview').textContent='Checking references…';
  $('#remove-name').textContent=state?.transfers.find(t=>t.id===id)?.name||id;
  $('#remove-title').textContent=target.kind==='unpin'?'Unpin and delete?':'Remove torrent';
  $('#remove-form button[type=submit]').textContent=target.kind==='unpin'?'Unpin and delete':'Remove';
  $<HTMLInputElement>('#delete-files').checked=target.kind==='torrent'&&target.delete_files;
  $('#delete-files').closest<HTMLElement>('.field')!.hidden=target.kind!=='torrent';
  $<HTMLDialogElement>('#remove-dialog').showModal();$('#remove-dialog [data-close]').focus();void refreshRemoval();
}
function removeTorrent(id:string){showRemoval(id,{kind:'torrent',id,delete_files:false});}
async function pinTorrent(id:string,pinned:boolean){
  if(!connected)return;
  try{
    if(pinned){await command({type:'set_pin',id,pinned:true});return;}
    const preview=await send({type:'preview_removal',target:{kind:'unpin',id}}) as RemovalPreview;
    if(preview.deleting.length){showRemoval(id,{kind:'unpin',id});}
    else await command({type:'set_pin',id,pinned:false,revision:preview.revision});
  }catch(e){notice(String(e));}
}
$('#delete-files').addEventListener('change',()=>{if(removalTarget?.kind==='torrent'){removalTarget={...removalTarget,delete_files:$<HTMLInputElement>('#delete-files').checked};void refreshRemoval();}});
async function downloadContent(id:string,c:Command){
  try{return await command(c);}catch(e){await sync();if(!state?.transfers.some(t=>t.id===id))throw e;}
}
const contentHost={openMagnet:openMagnetLink,download:downloadContent,call:(c:Command,refresh=true)=>refresh?command(c):send(c),remove:removeTorrent,pin:(id:string,pinned:boolean)=>pinTorrent(id,pinned),follow:(magnet:string)=>postUI.follow(magnet)};
const libraryUI = new LibraryUI({...contentHost,action:c=>void action(c)});
function showLibrary(id?: string) { libraryUI.open(id); }
const newsUI = new NewsUI((c,refresh=true)=>refresh?command(c):send(c));
const postUI=new PostsUI({...contentHost,transfer:(id)=>showLibrary(id),followed:()=>opened()});
const publishingUI=new PublishingUI(uri=>void openMagnetLink(uri),async (data,id,post)=>{
  try{await command({type:'add_torrent',data,origin:{kind:'own',id:post}});}
  catch(e){await sync();if(!state?.transfers.some(t=>t.id===id))throw e;}
},id=>showLibrary(id),contentHost);
const organizationUI = new OrganizationUI(async c => {
  try { return await command(c); }
  catch (error) { await sync().catch(() => {}); throw error; }
},async (id,revision)=>{await publishingUI.removePost(id,()=>command({type:'delete_post',post_kind:'own',id,revision}));await sync();},id=>readerSettingsRemoved(id));
initReaderSettings({call:c=>command(c),remove:(id,trigger)=>organizationUI.openRemove('followed:'+id,trigger)});
const creationUI=new CreationUI();
async function action(c: Command) {
  try {
    notice("");
    await command(c);
  } catch (e) {
    notice(String(e));
  }
}
const cleanupRows=new Map<number,HTMLElement>(),retrying=new Set<number>();
function renderCleanup(){
  const jobs=state?.cleanup||[],container=$('#cleanup-jobs');$('#cleanup-status').hidden=!jobs.length;
  for(const [id,row] of cleanupRows)if(!jobs.some(j=>j.id===id)){row.remove();cleanupRows.delete(id);}
  for(const job of jobs){
    let row=cleanupRows.get(job.id);
    if(!row){row=document.createElement('div');const text=document.createElement('span'),retry=document.createElement('button');retry.type='button';retry.className='btn';retry.dataset.variant='outline';retry.textContent='Retry cleanup';
      retry.onclick=async()=>{if(retrying.has(job.id))return;retrying.add(job.id);renderCleanup();try{await command({type:'retry_cleanup',id:job.id});}catch(e){notice(String(e));}finally{retrying.delete(job.id);renderCleanup();}};
      row.append(text,retry);container.append(row);cleanupRows.set(job.id,row);
    }
    const text=job.error||`Deleting downloaded content… ${job.remaining.length} remaining`;
    if(row.firstElementChild!.textContent!==text)row.firstElementChild!.textContent=text;
    const retry=row.lastElementChild as HTMLButtonElement;retry.hidden=!job.error;retry.disabled=!connected||retrying.has(job.id);
  }
}
function render() {
  imageState(state);
  if($<HTMLDialogElement>('#settings-dialog').open&&imageSettingsVersion===savedImageSettingsVersion)$<HTMLInputElement>('#external-images-automatic').checked=!!state?.image_preferences?.automatic;
  const transfers = state?.transfers || [];
  libraryUI.render(state, connected);
  for (const b of document.querySelectorAll<HTMLButtonElement>("body > header button:not(#sections-button)"))
    b.disabled = !connected || !state?.ready;
  $("#status").textContent = connected
    ? `${transfers.filter((t) => t.active).length} active`
    : "Server disconnected";
  $("#network").textContent = state
    ? `DHT · ${state.dht_nodes} nodes · Port ${state.listen_port || "…"}`
    : "Connecting…";
  const warning = state?.warning || "";
  if ($("#network-warning > section").textContent !== warning) $("#network-warning > section").textContent = warning;
  $("#network-warning").hidden = !state?.warning;
  updateOpenButtons();
  postUI.render(state,connected);
  publishingUI.render(state,connected);
  newsUI.render(state,connected);
  organizationUI.render(state,connected);
  renderCleanup();
  creationUI.render(state,connected);
  readerSettingsState(state,connected);
}
async function sync() {
  const r = await fetch("./api/snapshot");
  if (!r.ok) throw Error(`Server error (${r.status})`);
  state = await r.json();
  connected = true;
  render();
}
let magnetRequest=0;
let linkedOpen:number|null=null;
function existingMagnetRoute(source:InspectedSource):string|null {
  const same=(id:string)=>id.toLowerCase()===source.id.toLowerCase();
  if(source.kind==='post'){
    const own=state?.publishing.posts.find(p=>same(p.id));
    if(own)return `#/own/${own.id}/read`;
    const followed=state?.posts.find(p=>same(p.id));
    if(followed)return `#/posts/${followed.id}`;
  }else{
    const torrent=state?.transfers.find(t=>same(t.id));
    if(torrent)return `#/library/${torrent.id}`;
  }
  return null;
}
async function refreshMagnetRoute(source:InspectedSource){
  await sync();
  return existingMagnetRoute(source);
}
async function openMagnetLink(uri:string){
  const request=++magnetRequest,origin=location.hash;
  const current=()=>request===magnetRequest&&origin===location.hash;
  try{
    const source=await send({type:'inspect_source',uri}) as InspectedSource;
    if(!current())return;
    const route=await refreshMagnetRoute(source);
    if(!current()||document.querySelector('dialog[open]'))return;
    notice('');
    if(route){location.hash=route;return;}
    if(source.kind==='post')postUI.follow(source.magnet,refreshMagnetRoute);
    else{
      $<HTMLInputElement>('#magnet').value=source.uri;
      $('#magnet-error').textContent='';
      $('#magnet').removeAttribute('aria-invalid');
      linkedOpen=request;
      showOpenDialog();
    }
  }catch(error){if(current())notice(String(error));}
}
window.addEventListener('hashchange',()=>{
  ++magnetRequest;
  if(linkedOpen!==null)$<HTMLDialogElement>('#open-dialog').close();
});
$('#open-dialog').addEventListener('close',()=>{linkedOpen=null;});
function showOpenDialog() {
  openTabs.select($<HTMLButtonElement>("#magnet-tab"));
  updateOpenButtons();
  $<HTMLDialogElement>("#open-dialog").showModal();
  $<HTMLInputElement>("#magnet").focus();
}
$("#open-button").onclick = () => {++magnetRequest;linkedOpen=null;showOpenDialog();};
$("#magnet").oninput = () => {
  linkedOpen=null;
  $("#magnet-error").textContent = "";
  updateOpenButtons();
};
$("#choose-torrent").onclick = () =>
  $<HTMLInputElement>("#torrent-file").click();
$("#torrent-file").onchange = () => {
  const file = $<HTMLInputElement>("#torrent-file").files?.[0];
  $("#torrent-name").textContent = file?.name || "No file selected";
  $("#open-torrent-error").textContent =
    file && file.size > 8 * 1024 * 1024 ? "Torrent metadata exceeds 8 MiB" : "";
  $("#torrent-file").setAttribute("aria-invalid", String(!!file && file.size > 8 * 1024 * 1024));
  updateOpenButtons();
};
$("#magnet-form").onsubmit = async (event) => {
  event.preventDefault();
  if (
    opening ||
    $<HTMLButtonElement>("#magnet-form button[type=submit]").disabled
  )
    return;
  opening = true;
  updateOpenButtons();
  try {
    const uri=$<HTMLInputElement>("#magnet").value.trim();
    const link=linkedOpen;
    const source=await send({type:"inspect_source",uri}) as InspectedSource;
    if(link!==null){
      const route=await refreshMagnetRoute(source);
      if(link!==linkedOpen||!$<HTMLDialogElement>('#open-dialog').open)return;
      if(route){opened();location.hash=route;return;}
    }
    if(source.kind==="post"){
      $<HTMLDialogElement>("#open-dialog").close();
      if(state?.posts.some(f=>f.id===source.id)){opened();location.hash=`#/posts/${source.id}`;}else{postUI.follow(source.magnet);}
    }else{await command({type:"add_magnet",uri});opened();showLibrary();}
  } catch (error) {
    $("#magnet-error").textContent = String(error);
    if (/magnet|infohash/i.test(String(error))) $("#magnet").setAttribute("aria-invalid", "true");
  } finally {
    opening = false;
    updateOpenButtons();
  }
};
$("#torrent-form").onsubmit = async (event) => {
  event.preventDefault();
  const file = $<HTMLInputElement>("#torrent-file").files?.[0];
  if (
    opening ||
    !file ||
    $<HTMLButtonElement>("#torrent-form button[type=submit]").disabled
  )
    return;
  opening = true;
  updateOpenButtons();
  try {
    await command({
      type: "add_torrent",
      data: Array.from(new Uint8Array(await file.arrayBuffer())),
    });
    opened();
    showLibrary();
  } catch (error) {
    $("#open-torrent-error").textContent = String(error);
    if (/torrent|metadata|bencode|decode/i.test(String(error))) $("#torrent-file").setAttribute("aria-invalid", "true");
  } finally {
    opening = false;
    updateOpenButtons();
  }
};
let settingsSave: Promise<boolean> = Promise.resolve(true);
let settingsEditVersion = 0;
let imageSettingsVersion=0,savedImageSettingsVersion=0;
function settingsStatus(value: string) {
  $("#settings-save-status").textContent = value;
  $("#settings-save-status").hidden = !value;
}
function saveSettings(): Promise<boolean> {
  const folder = $<HTMLInputElement>("#download-dir");
  const port = $<HTMLInputElement>("#peer-port");
  const folderInvalid = !folder.value.trim();
  const portInvalid = !port.value || !port.validity.valid;
  folder.setAttribute("aria-invalid", String(folderInvalid));
  port.setAttribute("aria-invalid", String(portInvalid));
  if (folderInvalid || portInvalid) {
    $("#settings-error").textContent = !folder.value.trim()
      ? "Download folder cannot be empty."
      : "Enter a listening port between 0 and 65535.";
    settingsStatus("");
    return Promise.resolve(false);
  }
  const version = settingsEditVersion;
  const automatic=$<HTMLInputElement>('#external-images-automatic').checked,imageVersion=imageSettingsVersion;
  const settings: Settings = {
    download_dir: folder.value,
    peer_port: Number(port.value),
    seed_by_default: $<HTMLInputElement>("#seed-by-default").checked,
  };
  // Serialize writes so a slower response cannot overwrite a newer edit.
  settingsSave = settingsSave.then(async () => {
    if (JSON.stringify(settings) === JSON.stringify(state?.settings)&&imageVersion<=savedImageSettingsVersion) return true;
    if (version === settingsEditVersion) {
      settingsStatus("Saving…");
      $("#settings-error").textContent = "";
    }
    try {
      const changedPort = settings.peer_port !== state?.settings.peer_port;
      if(JSON.stringify(settings)!==JSON.stringify(state?.settings))await command({ type: "configure", settings });
      if(imageVersion>savedImageSettingsVersion){
        if(automatic!==!!state?.image_preferences?.automatic)await command({type:'set_image_preferences',update:{scope:'global',automatic}});
        savedImageSettingsVersion=imageVersion;
      }
      if (version === settingsEditVersion) settingsStatus("Saved");
      if (changedPort) notice("Restart FeedTorrent to apply the listening port.");
      return true;
    } catch (error) {
      if (version === settingsEditVersion) {
        settingsStatus("");
        $("#settings-error").textContent = String(error);
      }
      return false;
    }
  });
  return settingsSave;
}
async function closeSettings() {
  if (await saveSettings()) $<HTMLDialogElement>("#settings-dialog").close();
}
$("#settings-open").onclick = () => {
  if (!state) return;
  savedImageSettingsVersion=imageSettingsVersion;
  $<HTMLInputElement>("#download-dir").value = state.settings.download_dir;
  $<HTMLInputElement>("#peer-port").value = String(state.settings.peer_port);
  $<HTMLInputElement>("#seed-by-default").checked = state.settings.seed_by_default;
  $<HTMLInputElement>("#external-images-automatic").checked = !!state.image_preferences?.automatic;
  $("#settings-error").textContent = "";
  for (const input of document.querySelectorAll<HTMLInputElement>("#settings-form input"))
    input.removeAttribute("aria-invalid");
  settingsStatus("");
  $<HTMLDialogElement>("#settings-dialog").showModal();
};
for (const input of document.querySelectorAll<HTMLInputElement>("#settings-form input")) {
  input.addEventListener("input", () => {
    settingsEditVersion++;
    if(input.id==='external-images-automatic')++imageSettingsVersion;
    input.removeAttribute("aria-invalid");
    settingsStatus("");
    $("#settings-error").textContent = "";
  });
  input.addEventListener("change", () => { void saveSettings(); });
}
$("#settings-form").onsubmit = (event) => {
  event.preventDefault();
  void saveSettings();
};
$("#settings-form").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
    event.preventDefault();
    void saveSettings();
  }
});
$("#remove-form").onsubmit=async e=>{
  e.preventDefault();if(!removing||!removalTarget||!removalPreview||removalBusy||!connected)return;
  const target=removalTarget,id=removing;removalBusy=true;$<HTMLButtonElement>('#remove-form button[type=submit]').disabled=true;
  try{
    if(target.kind==='unpin')await command({type:'set_pin',id,pinned:false,revision:removalPreview.revision});
    else if(target.kind==='torrent')await command({type:'remove',id,delete_files:target.delete_files,revision:removalPreview.revision});
    $<HTMLDialogElement>('#remove-dialog').close();if(!state?.transfers.some(t=>t.id===id))libraryUI.removed(id);
    removing=null;removalTarget=null;removalPreview=null;notice('');
  }catch(error){$('#remove-error').textContent=String(error);if(/References changed/.test(String(error)))await refreshRemoval();}
  finally{removalBusy=false;$<HTMLButtonElement>('#remove-form button[type=submit]').disabled=!removalPreview||!connected;}
};
document.addEventListener("invalid", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)
    event.target.setAttribute("aria-invalid", "true");
}, true);
document.addEventListener("input", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)
    event.target.removeAttribute("aria-invalid");
});
document.addEventListener("submit", event => {
  if (!(event.target instanceof HTMLFormElement)) return;
  for (const input of event.target.querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
  for (const error of event.target.querySelectorAll("p[role=alert]")) error.textContent = "";
}, true);
function dismissDialog(dialog: HTMLDialogElement) {
  if (dialog.id === "settings-dialog") void closeSettings();
  else dialog.close();
}
for (const b of document.querySelectorAll<HTMLElement>("[data-close]"))
  b.onclick = () => {
    const dialog = b.closest("dialog");
    if (dialog) dismissDialog(dialog);
  };
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
  const outside = (event: MouseEvent) => {
    const surface = dialog.querySelector<HTMLElement>(":scope > .dialog-surface") || dialog;
    const bounds = surface.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", event => {
    pressedOutside = event.button === 0 && event.isPrimary && outside(event);
  });
  dialog.addEventListener("pointercancel", () => { pressedOutside = false; });
  dialog.addEventListener("click", event => {
    const dismiss = pressedOutside && event.target === dialog && outside(event);
    pressedOutside = false;
    if (dismiss) dismissDialog(dialog);
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    dismissDialog(dialog);
  });
}
async function boot() {
  try {
    await sync();
  } catch (e) {
    notice(String(e));
  }
  const events = new EventSource("./api/events");
  events.addEventListener("snapshot", (event) => {
    state = JSON.parse((event as MessageEvent).data);
    connected = true;
    render();
  });
  events.onerror = () => {
    connected = false;
    render();
  };
}
render();
void boot();

// Field help is visible on hover, keyboard focus and touch/click.
for (const trigger of document.querySelectorAll<HTMLButtonElement>("[data-help]")) {
  const tooltip = document.getElementById(trigger.dataset.help!)!;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const show = () => { clearTimeout(pending); tooltip.hidden = false; };
  const hide = () => { clearTimeout(pending); tooltip.hidden = true; };
  const leave = () => {
    pending = setTimeout(() => {
      if (document.activeElement !== trigger && !tooltip.matches(":hover")) hide();
    }, 100);
  };
  trigger.addEventListener("mouseenter", show);
  trigger.addEventListener("mouseleave", leave);
  trigger.addEventListener("focus", show);
  trigger.addEventListener("blur", hide);
  trigger.addEventListener("click", show);
  document.addEventListener("pointerdown", (event) => {
    if (!trigger.contains(event.target as Node) && !tooltip.contains(event.target as Node)) hide();
  });
  tooltip.addEventListener("mouseenter", show);
  tooltip.addEventListener("mouseleave", leave);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !tooltip.hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); hide();
    }
  }, true);
}

window.addEventListener("hashchange", render);
