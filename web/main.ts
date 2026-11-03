import {FeedsUI} from "./feeds.js";
import type { Snapshot, Transfer, Command, Settings } from "./types.js";
const $ = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
let state: Snapshot | null = null,
  connected = false,
  selected: string | null = null,
  removing: string | null = null,
  fileSignature = "";
const rows = new Map<string, HTMLElement>();
let opening = false;
function updateOpenButtons() {
  const ready = connected && !!state?.ready && !opening;
  $<HTMLButtonElement>("#magnet-form button[type=submit]").disabled =
    !ready || !$<HTMLInputElement>("#magnet").value.trim();
  const file = $<HTMLInputElement>("#torrent-file").files?.[0];
  $<HTMLButtonElement>("#torrent-form button[type=submit]").disabled =
    !ready || !file || file.size > 8 * 1024 * 1024;
}
function selectOpenTab(tab: "magnet" | "torrent", focusTab = false) {
  for (const name of ["magnet", "torrent"] as const) {
    const active = name === tab;
    const button = $<HTMLButtonElement>(`#${name}-tab`);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#${name}-panel`).hidden = !active;
    if (active && focusTab) button.focus();
  }
}
function opened() {
  $<HTMLInputElement>("#magnet").value = "";
  $<HTMLInputElement>("#torrent-file").value = "";
  $("#magnet-error").textContent = "";
  $("#torrent-error").textContent = "";
  $("#torrent-name").textContent = "No file selected";
  $<HTMLDialogElement>("#open-dialog").close();
  notice("");
}
function text(tag: string, value: string, cls = "") {
  const e = document.createElement(tag);
  e.textContent = value;
  e.className = cls;
  return e;
}
function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < 3);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function notice(value: string) {
  $("#notice").textContent = value;
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
const feedUI=new FeedsUI({call:async(c,refresh=true)=>refresh?command(c):send(c),transfer:(id)=>{selected=id;location.hash="#/transfers";render();},followed:()=>opened()});
async function action(c: Command) {
  try {
    notice("");
    await command(c);
  } catch (e) {
    notice(String(e));
  }
}
function button(label: string, fn: () => void, cls = "btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.onclick = fn;
  return b;
}
function select(t: Transfer) {
  selected = t.id;
  fileSignature = "";
  render();
}
function render() {
  const transfers = state?.transfers || [];
  if (!transfers.some((t) => t.id === selected))
    selected = transfers[0]?.id || null;
  $("#empty").hidden = !!transfers.length;
  $("#count").textContent =
    `${transfers.length} transfer${transfers.length === 1 ? "" : "s"}`;
  for (const [id, row] of rows)
    if (!transfers.some((t) => t.id === id)) {
      row.remove();
      rows.delete(id);
    }
  for (const t of transfers) {
    let row = rows.get(t.id);
    if (!row) {
      row = document.createElement("article");
      row.className = "transfer";
      row.dataset.id = t.id;
      const name = button(
        t.name,
        () => {
          const current = state?.transfers.find((x) => x.id === t.id);
          if (current) select(current);
        },
        "transfer-name",
      );
      const progress = document.createElement("progress");
      progress.max = 1;
      const actions = text("div", "", "actions");
      actions.append(
        button("Pause", () => {
          const current = state?.transfers.find((x) => x.id === t.id);
          if (current)
            void action({
              type: current.active ? "pause" : "resume",
              id: t.id,
            });
        }),
        button(
          "Remove",
          () => {
            removing = t.id;
            $("#remove-name").textContent =
              state?.transfers.find((x) => x.id === t.id)?.name || t.id;
            $<HTMLInputElement>("#delete-files").checked = false;
            $<HTMLDialogElement>("#remove-dialog").showModal();
          },
          "btn danger",
        ),
      );
      const approve=button("Download once",()=>void action({type:"approve_transfer",id:t.id}));approve.classList.add("approve-transfer");actions.append(approve);
      row.append(
        name,
        text("span","","transfer-source"),
        progress,
        text("span", "", "state"),
        text("span", "", "amount"),
        text("span", "", "rates"),
        actions,
        text("p", "", "transfer-error"),
      );
      rows.set(t.id, row);
      $("#transfers").append(row);
    }
    row.setAttribute("aria-current", String(selected === t.id));
    row.querySelector(".transfer-name")!.textContent = t.name;
    const progress = row.querySelector("progress")!;
    progress.value = t.progress;
    progress.setAttribute("aria-label", `${t.name} download progress`);
    row.querySelector(".state")!.textContent =
      `${t.state} · ${Math.floor(t.progress * 100)}%`;
    row.querySelector(".amount")!.textContent =
      `${bytes(t.verified)} / ${t.files.length ? bytes(t.approval_size??t.total) : "—"}${t.approval_size!==null&&t.approval_size!==t.total?" incl. padding":""}`;
    row.querySelector(".rates")!.textContent =
      `↓ ${bytes(t.down)}/s  ↑ ${bytes(t.up)}/s · ${t.peers} peers`;
    const toggle = row.querySelector<HTMLButtonElement>(".actions button")!;
    toggle.textContent = t.active ? "Pause" : "Resume";
    const approve=row.querySelector<HTMLButtonElement>(".approve-transfer")!;approve.hidden=!t.held;approve.disabled=!connected||!t.files.length;
    const source=row.querySelector<HTMLElement>(".transfer-source")!;source.textContent=t.kind?`${t.kind==="catalog"?"Catalog":"Content"} · ${state?.feeds.find(f=>f.id===t.feed)?.name||"Feed"}`:"";source.hidden=!t.kind;
    for (const b of row.querySelectorAll<HTMLButtonElement>(".actions button"))
      b.disabled = !connected;
    approve.disabled=!connected||!t.files.length;
    const error = row.querySelector<HTMLElement>(".transfer-error")!;
    error.textContent = t.error || t.warning;
    error.hidden = !error.textContent;
  }
  const t = transfers.find((t) => t.id === selected);
  const signature = JSON.stringify([selected, t?.files, connected]);
  $("#file-section").hidden = !t;
  if (signature !== fileSignature) {
    fileSignature = signature;
    $("#files").replaceChildren();
    if (t) {
      $("#save-path").textContent = t.save_path;
      if (!t.files.length)
        $("#files").append(text("p", "Waiting for metadata.", "muted"));
      for (const [index, f] of t.files.entries()) {
        const row = text("div", "", "file");
        const reveal = button(
          "Show in Finder",
          () => void action({ type: "reveal", id: t.id, file: index }),
        );
        reveal.disabled = !f.ready || !connected;
        row.append(
          text("span", f.name),
          text("span", `${bytes(f.verified)} / ${bytes(f.length)}`, "muted"),
          reveal,
        );
        $("#files").append(row);
      }
    }
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("header button"))
    b.disabled = !connected || !state?.ready;
  $("#status").textContent = connected
    ? `${transfers.filter((t) => t.active).length} active`
    : "Server disconnected";
  $("#network").textContent = state
    ? `DHT · ${state.dht_nodes} nodes · Port ${state.listen_port || "…"}`
    : "Connecting…";
  $("#network-warning").textContent = state?.warning || "";
  $("#network-warning").hidden = !state?.warning;
  updateOpenButtons();
  feedUI.render(state,connected);
}
async function sync() {
  const r = await fetch("./api/snapshot");
  if (!r.ok) throw Error(`Server error (${r.status})`);
  state = await r.json();
  connected = true;
  render();
}
$("#open-button").onclick = () => {
  selectOpenTab("magnet");
  updateOpenButtons();
  $<HTMLDialogElement>("#open-dialog").showModal();
  $<HTMLInputElement>("#magnet").focus();
};
for (const name of ["magnet", "torrent"] as const) {
  const tab = $<HTMLButtonElement>(`#${name}-tab`);
  tab.onclick = () => selectOpenTab(name);
  tab.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectOpenTab(
      event.key === "Home"
        ? "magnet"
        : event.key === "End"
          ? "torrent"
          : name === "magnet"
            ? "torrent"
            : "magnet",
      true,
    );
  };
}
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
    }else{await command({type:"add_magnet",uri});opened();}
  } catch (error) {
    $("#magnet-error").textContent = String(error);
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
  } catch (error) {
    $("#torrent-error").textContent = String(error);
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
  if (!folder.value.trim() || !port.value || !port.validity.valid) {
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
  settingsStatus("");
  $<HTMLDialogElement>("#settings-dialog").showModal();
};
for (const input of document.querySelectorAll<HTMLInputElement>("#settings-form input")) {
  input.addEventListener("input", () => {
    settingsEditVersion++;
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
    removing = null;
    notice("");
  } catch (error) {
    notice(String(error));
    $<HTMLDialogElement>("#remove-dialog").close();
  }
};
$("#show-folder").onclick = () => {
  if (selected) void action({ type: "reveal", id: selected, file: null });
};
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
    const bounds = dialog.getBoundingClientRect();
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
