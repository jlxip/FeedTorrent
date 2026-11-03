import { markdown, type MarkdownNode } from "./markdown.js";
import type { Snapshot } from "./types.js";
export interface OwnFeed {
  id: string;
  title: string;
  magnet: string;
  revision: number;
  published_revision: number;
  sequence: string | null;
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
  feeds: OwnFeed[];
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
  private id = "";
  private current = 0;
  private trail: number[] = [];
  private reading = false;
  private loading = "";
  private nav = "";
  constructor(
    private link: (uri: string) => void,
    private addTorrent: (data: number[]) => Promise<void>,
  ) {
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
          action: "create_feed",
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
      this.reading = !this.reading;
      this.draw();
    };
    $("own-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.feed()?.magnet || "");
        $("own-status").textContent = "Feed magnet copied";
      } catch (e) {
        this.error(e);
      }
    };
    $("own-retry").onclick = () => void this.publicationAction("retry_publication");
    $("own-cancel").onclick = () => void this.publicationAction("cancel_publication");
    $("own-publish").onclick = async () => {
      try {
        await this.flush();
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
      try {
        await this.flush();
        const s = this.session();
        if (!s) return;
        const result = await api({
          action: "publish",
          id: this.id,
          revision: s.revision,
          password: $<HTMLInputElement>("own-publish-password").value,
        });
        const feed = this.feed();
        if (feed) {
          feed.operation = result.operation;
          feed.pending_revision = s.revision;
          feed.phase = "Queued";
          feed.state = "Queued";
          feed.error = "";
          this.render(this.state, this.connected);
        }
        $<HTMLDialogElement>("own-publish-dialog").close();
      } catch (e) {
        $("own-publish-error").textContent = String(e);
      } finally {
        submit.disabled = false;
        this.clearSecrets("own-publish-dialog");
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
    $("own-password-form").onsubmit = async (e) => {
      e.preventDefault();
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
      }
    };
    for (const id of [
      "own-create-dialog",
      "own-publish-dialog",
      "publishing-keys-dialog",
    ])
      $(id).addEventListener("close", () => this.clearSecrets(id));
    window.addEventListener("hashchange", () => {
      const old = this.id;
      if (this.sessions.get(old)?.edits !== this.sessions.get(old)?.saved)
        void this.flush(old).catch(() => {});
      this.render(this.state, this.connected);
    });
  }
  private clearSecrets(id: string) {
    for (const input of $(id).querySelectorAll<HTMLInputElement>(
      "input[type=password]",
    ))
      input.value = "";
  }
  private feed() {
    return this.state?.publishing.feeds.find((f) => f.id === this.id);
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
    if (!s) return;
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
        if (s.saved === s.edits) return;
        const edits = s.edits,
          draft = structuredClone(s.draft);
        try {
          const value = await api({
            action: "save_draft",
            id,
            revision: s.revision,
            draft,
          });
          s.revision = value.revision;
          s.saved = edits;
          s.error = "";
          if (this.id === id)
            $("own-draft-status").textContent =
              s.saved === s.edits ? "Draft saved" : "Saving…";
        } catch (e) {
          s.error = String(e);
          if (this.id === id) {
            this.error(e);
            $("own-draft-status").textContent = "Not saved";
          }
          throw e;
        }
      });
    await s.queue;
  }
  private openPage(page: number) {
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
                () => void this.addTorrent(e.data).catch((e) => this.error(e)),
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
    const s = this.session(),
      p = this.page();
    if (!s || !p) return;
    $("own-editor").hidden = this.reading;
    $("own-preview").hidden = !this.reading;
    $("own-toggle").textContent = this.reading ? "Edit" : "Read";
    $("own-new-page").hidden = this.reading;
    $("own-add-torrent").hidden = this.reading;
    $<HTMLInputElement>("own-title").value = p.title;
    $<HTMLTextAreaElement>("own-body").value = p.body;
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
    if (this.reading) {
      const id = this.id,
        page = this.current,
        body = p.body;
      $("own-preview").replaceChildren();
      void api({ action: "preview", body })
        .then((value: { body: MarkdownNode }) => {
          if (this.id !== id || this.current !== page || !this.reading) return;
          $("own-preview").replaceChildren(
            markdown(value.body, (target) => {
              if (target.startsWith("magnet:")) return () => this.link(target);
              let name: string;
              try {
                name = decodeURIComponent(target);
              } catch {
                return null;
              }
              const entry = p.entries.find(
                (e) =>
                  (e.kind === "torrent"
                    ? e.name
                    : s.draft.pages.find((p) => p.id === e.page)?.title +
                      ".torrent") === name,
              );
              if (entry?.kind === "page")
                return () => this.openPage(entry.page);
              if (entry?.kind === "torrent")
                return () =>
                  void this.addTorrent(entry.data).catch((e) => this.error(e));
              return null;
            }),
          );
        })
        .catch((e) => this.error(e));
    }
  }
  render(state: Snapshot | null, connected: boolean) {
    this.state = state;
    this.connected = connected;
    const route = location.hash.split("/"),
      active = route[1] === "own";
    $("own-view").hidden = !active;
    if (active) {
      $("transfer-view").hidden = true;
      $("feed-view").hidden = true;
    }
    for (const id of ["own-create", "publishing-keys-open"])
      $<HTMLButtonElement>(id).disabled = !connected || !state?.ready;
    const feeds = state?.publishing?.feeds || [],
      nav = JSON.stringify(feeds.map((f) => [f.id, f.title]));
    if (nav !== this.nav) {
      this.nav = nav;
      $("own-nav").replaceChildren();
      for (const feed of feeds) {
        const a = element("a", "") as HTMLAnchorElement;
        a.append(element("span", feed.title));
        a.href = `#/own/${feed.id}`;
        const item = element("li", "");
        item.append(a);
        $("own-nav").append(item);
      }
    }
    for (const a of $("own-nav").querySelectorAll("a"))
      a.setAttribute(
        "aria-current",
        active && a.getAttribute("href") === location.hash ? "page" : "false",
      );
    if (!active) {
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
    const f = this.feed();
    $("own-heading").textContent = f?.title || "Own feed";
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
    const session = this.sessions.get(id);
    if (session && f && session.edits === session.saved)
      $("own-draft-status").textContent =
        "Draft saved" +
        (f.published_revision > 0 && session.revision > f.published_revision
          ? " · Unpublished changes"
          : "");
    if (!session && id && this.loading !== id) {
      this.loading = id;
      void api({ action: "get_feed", id })
        .then((value) => {
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
            this.draw();
          }
        })
        .catch((e) => this.error(e))
        .finally(() => {
          this.loading = "";
        });
    } else if (session && !this.current) {
      this.current = session.draft.root;
      this.trail = [this.current];
      this.draw();
    }
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
    const f = this.feed(), session = this.session();
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
    } else if (f && f.published_revision > 0 && f.published_revision === f.revision && !dirty) {
      color = "published";
      label = "Published";
    } else if (f?.state === "Canceled") {
      label = "Publication canceled";
    } else if (f && (f.published_revision > 0 || dirty)) {
      label = "Unpublished changes";
    }
    if (f?.pending_revision != null) details.push(`Publishing draft revision ${f.pending_revision}`);
    if (f?.published_revision) details.push(`Published draft revision ${f.published_revision}`);
    if (f?.next_retry_at != null) details.push(`Next retry: ${new Date(f.next_retry_at).toLocaleTimeString()}`);
    if (problem || f?.error) details.push(problem || f!.error);
    indicator.dataset.state = color;
    indicator.setAttribute("aria-label", label);
    $("own-publication-help").textContent = [label, ...details].join("\n");
    if ($("own-status").textContent !== label) $("own-status").textContent = label;
  }
  private async publicationAction(action: "retry_publication" | "cancel_publication") {
    const f = this.feed();
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
