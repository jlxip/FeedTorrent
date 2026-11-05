import {LibraryUI} from "./library.js";
import {NewsUI} from "./news.js";
import {PublishingUI} from "./publishing.js";
import {FeedsUI} from "./feeds.js";
import type { Snapshot, Command, Settings } from "./types.js";
const $ = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
let state: Snapshot | null = null,
  connected = false,
  removing: string | null = null;
// Legacy bookmarks share the Library entry rather than adding a redirect to Back.
function normalizeRoute() {
  if (!location.hash || location.hash === "#" || location.hash === "#/")
    history.replaceState(history.state, "", "#/new");
  else if (location.hash === "#/transfers")
    history.replaceState(history.state, "", "#/library");
  history.scrollRestoration = ["new", "library"].includes(location.hash.split("/")[1]) ? "manual" : "auto";
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
  $("#torrent-error").textContent = "";
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
const libraryUI = new LibraryUI({
  action: c => void action(c),
  remove: id => {
    removing = id;
    $("#remove-error").textContent = "";
    $("#remove-name").textContent = state?.transfers.find(t => t.id === id)?.name || id;
    $<HTMLInputElement>("#delete-files").checked = false;
    $<HTMLDialogElement>("#remove-dialog").showModal();
  },
});
function showLibrary(id?: string) { libraryUI.open(id); }
const newsUI = new NewsUI((c,refresh=true)=>refresh?command(c):send(c));
const feedUI=new FeedsUI({call:async(c,refresh=true)=>refresh?command(c):send(c),transfer:(id)=>showLibrary(id),followed:()=>opened()});
const publishingUI=new PublishingUI(uri=>{if(uri.includes('urn:btpk:'))feedUI.follow(uri);else{$<HTMLInputElement>('#magnet').value=uri;$<HTMLButtonElement>('#open-button').click();updateOpenButtons();}},async data=>{
  const before=new Set(state?.transfers.map(t=>t.id));
  await command({type:'add_torrent',data});
  const added=state?.transfers.filter(t=>!before.has(t.id))||[];
  // If background feeds also registered torrents, keep the catalogue rather than guess an ID.
  showLibrary(added.length===1?added[0].id:undefined);
});
async function action(c: Command) {
  try {
    notice("");
    await command(c);
  } catch (e) {
    notice(String(e));
  }
}
function render() {
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
  feedUI.render(state,connected);
  publishingUI.render(state,connected);
  newsUI.render(state,connected);
}
async function sync() {
  const r = await fetch("./api/snapshot");
  if (!r.ok) throw Error(`Server error (${r.status})`);
  state = await r.json();
  connected = true;
  render();
}
$("#open-button").onclick = () => {
  openTabs.select($<HTMLButtonElement>("#magnet-tab"));
  updateOpenButtons();
  $<HTMLDialogElement>("#open-dialog").showModal();
  $<HTMLInputElement>("#magnet").focus();
};
$("#magnet").oninput = () => {
  $("#magnet-error").textContent = "";
  updateOpenButtons();
};
$("#choose-torrent").onclick = () =>
  $<HTMLInputElement>("#torrent-file").click();
$("#torrent-file").onchange = () => {
  const file = $<HTMLInputElement>("#torrent-file").files?.[0];
  $("#torrent-name").textContent = file?.name || "No file selected";
  $("#torrent-error").textContent =
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
    const source=await send({type:"inspect_source",uri});
    if(source.kind==="feed"){
      $<HTMLDialogElement>("#open-dialog").close();
      if(state?.feeds.some(f=>f.id===source.id)){opened();location.hash=`#/feeds/${source.id}`;}else{feedUI.follow(source.magnet);}
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
    $("#torrent-error").textContent = String(error);
    if (/torrent|metadata|bencode|decode/i.test(String(error))) $("#torrent-file").setAttribute("aria-invalid", "true");
  } finally {
    opening = false;
    updateOpenButtons();
  }
};
let settingsSave: Promise<boolean> = Promise.resolve(true);
let settingsEditVersion = 0;
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
  const settings: Settings = {
    download_dir: folder.value,
    peer_port: Number(port.value),
    seed_by_default: $<HTMLInputElement>("#seed-by-default").checked,
  };
  // Serialize writes so a slower response cannot overwrite a newer edit.
  settingsSave = settingsSave.then(async () => {
    if (JSON.stringify(settings) === JSON.stringify(state?.settings)) return true;
    if (version === settingsEditVersion) {
      settingsStatus("Saving…");
      $("#settings-error").textContent = "";
    }
    try {
      const changedPort = settings.peer_port !== state?.settings.peer_port;
      await command({ type: "configure", settings });
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
  $<HTMLInputElement>("#download-dir").value = state.settings.download_dir;
  $<HTMLInputElement>("#peer-port").value = String(state.settings.peer_port);
  $<HTMLInputElement>("#seed-by-default").checked = state.settings.seed_by_default;
  $("#settings-error").textContent = "";
  for (const input of document.querySelectorAll<HTMLInputElement>("#settings-form input"))
    input.removeAttribute("aria-invalid");
  settingsStatus("");
  $<HTMLDialogElement>("#settings-dialog").showModal();
};
for (const input of document.querySelectorAll<HTMLInputElement>("#settings-form input")) {
  input.addEventListener("input", () => {
    settingsEditVersion++;
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
$("#remove-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!removing) return;
  try {
    await command({
      type: "remove",
      id: removing,
      delete_files: $<HTMLInputElement>("#delete-files").checked,
    });
    $<HTMLDialogElement>("#remove-dialog").close();
    libraryUI.removed(removing);
    removing = null;
    notice("");
  } catch (error) {
    $("#remove-error").textContent = String(error);
  }
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
