import {markdown} from "./markdown.js";
import type {CatalogPage, Command, Feed, FeedConfig, FeedEntry, FeedMode, Snapshot} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
const node = (tag: string, value: string, cls = '') => {
  const n = document.createElement(tag);
  n.textContent = value;
  n.className = cls;
  return n;
};
const size = (n: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
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
const alertMessage = (message: string) => {
  const alert = node('div', '', 'alert');
  alert.dataset.variant = 'destructive';
  alert.setAttribute('role', 'alert');
  alert.append(node('section', message));
  return alert;
};
const emptyMessage = (message: string) => {
  const empty = node('div', '', 'empty');
  const header = node('header', '');
  header.append(node('h3', message));
  empty.append(header);
  return empty;
};
interface Host {
  call: (command: Command, refresh?: boolean) => Promise<any>;
  transfer: (id: string) => void;
  followed: () => void
}
interface FeedDraft {
  uri: string;
  name: string;
  mode: FeedMode;
  limit: string;
  unlimited: boolean;
}
const emptyFeedDraft = (): FeedDraft => ({
  uri: '', name: '', mode: 'current_catalog', limit: '8', unlimited: false
});
export class FeedsUI {
  private state: Snapshot|null = null;
  private connected = false;
  private feedId = '';
  private catalogId = '';
  private offset = 0;
  private selected: number|null = null;
  private page: CatalogPage|null = null;
  private request = 0;
  private signature = '';
  private navSignature = '';
  private viewRoute = '';
  private readKey = '';
  private readError = '';
  private editing: string|null = null;
  private loading = false;
  private draft = emptyFeedDraft();
  private editDrafts = new Map<string, FeedDraft>();
  constructor(private host: Host) {
    $('follow-open').onclick = () => this.follow();
    $('feed-refresh').onclick = () => {this.readKey='';this.readError='';void this.run({type: 'refresh_feed', id: this.feedId});};
    $('feed-settings').onclick = () => {
      const f = this.feed();
      if (f) this.settings(f);
    };
    $<HTMLInputElement>('feed-unlimited').onchange = () => {
      const limit = $<HTMLInputElement>('feed-limit');
      limit.disabled = $<HTMLInputElement>('feed-unlimited').checked;
      if (limit.disabled && limit.getAttribute('aria-invalid') === 'true') {
        limit.removeAttribute('aria-invalid');
        $('follow-error').textContent = '';
      }
    };
    $('feed-form').onsubmit = async event => {
      event.preventDefault();
      await this.submit();
    };
    $('feed-unfollow').onclick = async () => {
      if (!this.editing) return;
      try {
        await this.host.call({type: 'unfollow_feed', id: this.editing});
        this.editDrafts.delete(this.editing);
        $<HTMLDialogElement>('feed-dialog').close();
        location.hash = '#/library';
      } catch (e) {
        $('follow-error').textContent = String(e)
      }
    };
    // Keep unsent edits independently of which dismissal method is used.
    $('feed-form').addEventListener('input', () => this.saveDraft());
    $('feed-form').addEventListener('change', () => this.saveDraft());
    window.addEventListener('hashchange', () => {
      this.offset = 0;
      this.selected = null;
      this.signature = '';
      this.render(this.state, this.connected);
    });
  }
  private saveDraft() {
    const draft: FeedDraft = {
      uri: $<HTMLInputElement>('feed-magnet').value,
      name: $<HTMLInputElement>('feed-name').value,
      mode: $<HTMLSelectElement>('feed-mode').value as FeedMode,
      limit: $<HTMLInputElement>('feed-limit').value,
      unlimited: $<HTMLInputElement>('feed-unlimited').checked
    };
    if (this.editing) this.editDrafts.set(this.editing, draft);
    else this.draft = draft;
  }
  private fillDraft(draft: FeedDraft) {
    this.fill(draft.uri, {
      name: draft.name, mode: draft.mode,
      automatic_limit: draft.unlimited ? null : Number(draft.limit) * 1048576
    });
    $<HTMLInputElement>('feed-limit').value = draft.limit;
  }
  follow(uri?: string) {
    this.editing = null;
    if (uri && uri !== this.draft.uri.trim()) this.draft = {...emptyFeedDraft(), uri};
    this.fillDraft(this.draft);
    $('feed-dialog-title').textContent = 'Follow feed';
    $('feed-submit').textContent = 'Follow feed';
    $('feed-unfollow').hidden = true;
    $<HTMLInputElement>('feed-magnet').readOnly = false;
    $<HTMLDialogElement>('feed-dialog').showModal();
    $<HTMLInputElement>('feed-magnet').focus();
  }
  private fill(uri: string, c: FeedConfig) {
    $<HTMLInputElement>('feed-magnet').value = uri;
    $<HTMLInputElement>('feed-name').value = c.name;
    $<HTMLSelectElement>('feed-mode').value = c.mode;
    $<HTMLInputElement>('feed-limit').value =
        String(c.automatic_limit === null ? 8 : c.automatic_limit / 1048576);
    $<HTMLInputElement>('feed-unlimited').checked = c.automatic_limit === null;
    $<HTMLInputElement>('feed-limit').disabled = c.automatic_limit === null;
    $('follow-error').textContent = '';
    for (const field of $('feed-form').querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
  }
  private settings(f: Feed) {
    this.editing = f.id;
    const draft = this.editDrafts.get(f.id);
    if (draft) this.fillDraft(draft);
    else this.fill(
        f.magnet, {name: f.local_name, mode: f.mode, automatic_limit: f.automatic_limit});
    $('feed-dialog-title').textContent = 'Feed settings';
    $('feed-submit').textContent = 'Save';
    $('feed-unfollow').hidden = false;
    $<HTMLInputElement>('feed-magnet').readOnly = true;
    $<HTMLDialogElement>('feed-dialog').showModal();
  }
  private async submit() {
    $('follow-error').textContent = '';
    const submit = $<HTMLButtonElement>('feed-submit');
    submit.disabled = true;
    try {
      const unlimited = $<HTMLInputElement>('feed-unlimited').checked;
      const mib = Number($<HTMLInputElement>('feed-limit').value);
      if (!unlimited &&
          (!Number.isSafeInteger(mib) || mib < 1 || !Number.isSafeInteger(mib * 1048576)))
        { $<HTMLInputElement>('feed-limit').setAttribute('aria-invalid', 'true');
          throw Error('Enter a positive whole MiB limit'); }
      const config: FeedConfig = {
        name: $<HTMLInputElement>('feed-name').value.trim(),
        mode: $<HTMLSelectElement>('feed-mode').value as FeedMode,
        automatic_limit: unlimited ? null : mib * 1048576
      };
      let id = this.editing;
      if (id) {
        await this.host.call({type: 'configure_feed', id, config});
        this.editDrafts.delete(id);
      } else {
        const uri = $<HTMLInputElement>('feed-magnet').value.trim();
        const inspected = await this.host.call({type: 'inspect_source', uri}, false);
        if (inspected.kind !== 'feed') {
          $<HTMLInputElement>('feed-magnet').setAttribute('aria-invalid', 'true');
          throw Error('Enter a BEP 46 feed magnet');
        }
        id = inspected.id as string;
        if (!this.state?.feeds.some(f => f.id === id)) {
          await this.host.call({type: 'follow_feed', uri, config});
        }
        this.host.followed();
        this.draft = emptyFeedDraft();
        this.fillDraft(this.draft);
      }
      $<HTMLDialogElement>('feed-dialog').close();
      this.signature = '';
      location.hash = `#/feeds/${id}`;
    } catch (e) {
      $('follow-error').textContent = String(e);
      if (/BEP 46|InvalidMagnet|InvalidKey|magnet link|infohash/i.test(String(e))) $('feed-magnet').setAttribute('aria-invalid', 'true');
    } finally {
      submit.disabled = !this.connected;
    }
  }
  private showError(message: string) {
    const error = $('feed-error');
    if (error.firstElementChild!.textContent !== message) error.firstElementChild!.textContent = message;
    error.hidden = !message;
  }
  private feed() {
    return this.state?.feeds.find(f => f.id === this.feedId);
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
    this.state = state;
    this.connected = connected;
    const route = location.hash.split('/');
    const isFeed = route[1] === 'feeds';
    this.feedId = isFeed ? route[2] || '' : '';
    const isLibrary = !isFeed && route[1] !== 'own' && route[1] !== 'new';
    const viewRoute = isFeed ? location.hash : '';
    if (viewRoute !== this.viewRoute) {
      this.viewRoute = viewRoute;
      this.readKey = '';
      this.readError = '';
      this.request++;
      this.loading = false;
      this.signature = '';
    }
    $('transfer-view').hidden = !isLibrary;
    $('feed-view').hidden = !isFeed;
    $('transfers-nav').setAttribute('aria-current', isLibrary ? 'page' : 'false');
    const feeds = state?.feeds || [];
    const nav = JSON.stringify(feeds.map(f => [f.id, f.name]));
    if (nav !== this.navSignature) {
      this.navSignature = nav;
      $('feed-nav').replaceChildren();
      for (const f of feeds) {
        const a = document.createElement('a');
        a.href = `#/feeds/${f.id}`;
        const label = document.createElement('span');
        label.textContent = f.name;
        a.append(label);
        a.dataset.feed = f.id;
        const item = document.createElement('li');
        item.append(a);
        $('feed-nav').append(item);
      }
    }
    for (const a of $('feed-nav').querySelectorAll('a'))
      a.setAttribute('aria-current', a.dataset.feed === this.feedId ? 'page' : 'false');
    $('no-feeds').hidden = feeds.length > 0;
    for (const id
             of ['follow-open', 'feed-submit', 'feed-unfollow', 'feed-refresh',
                 'feed-settings'])
      $<HTMLButtonElement>(id).disabled = !connected || !state?.ready;
    if (!isFeed) return;
    const f = this.feed();
    if (!f) {
      $('feed-title').textContent = 'Feed unavailable';
      $('feed-status').textContent = state?.feed_error || 'This feed is not followed.';
      $('catalog-links').replaceChildren();
      $('catalog-entries').replaceChildren();
      $('catalog-status').textContent = '';
      $('entry-detail').hidden = true;
      return;
    }
    $('feed-title').textContent = f.name;
    const age = f.last_checked_ms === null ?
        'Not checked yet' :
        `${
            Math.floor(
                Math.max(0, (state?.feed_time_ms || 0) - f.last_checked_ms) /
                60000)} min since check`;
    const mode = {
      current_catalog: 'Current catalog',
      mirror_catalogs: 'Mirror catalogs',
      mirror_all: 'Mirror all'
    }[f.mode];
    $('feed-status').textContent =
        `${connected ? f.state : 'Server disconnected'} · ${mode}${
            f.mode !== 'current_catalog' ? ' · ' + f.mirror_status :
                                           ''} · ${f.update_peers} update peers · ${age}`;
    this.showError(f.error || state?.feed_error || this.readError);
    const target = route[3] || f.available || f.head || '';
    if (target !== this.catalogId) {
      this.catalogId = target;
      this.readKey = '';
      this.readError = '';
      if (route[3] && target !== f.head) void this.host.call({type:'open_catalog',feed:this.feedId,id:target}).catch(e=>this.showError(String(e)));
      this.selected = null;
      this.offset = 0;
      this.page = null;
      this.signature = '';
    }
    const c = f.catalogs.find(c => c.id === target);
    const links = $('catalog-links');
    links.replaceChildren();
    if (target && target !== f.head && f.head)
      links.append(button('Current catalog', () => this.go(f.head!), 'ghost'));
    if (c?.previous)
      links.append(
          button('Previous catalog', () => void this.open(c.previous!), 'ghost'));
    if (c?.archive)
      links.append(button('Archive', () => void this.open(c.archive!), 'ghost'));
    if (f.head && target !== f.head && !f.catalogs.find(c => c.id === f.head)?.ready)
      links.append(node('span', 'Latest catalog is not yet available', 'muted'));
    const status = $('catalog-status');
    status.replaceChildren();
    if (c) {
      status.append(
          document.createTextNode(`${c.state}${c.total ? ' · ' + size(c.total) : ''}${
              c.count ? ' · ' + c.indexed + ' / ' + c.count + ' items indexed' : ''}`));
      if (c.error) status.append(alertMessage(c.error));
      if (c.state === 'Awaiting approval') {
        const b = button(
            'Download once', () => void this.run({type: 'approve_transfer', id: c.id}));
        b.disabled = !connected;
        status.append(document.createTextNode(' '), b);
      }
    } else
      status.textContent = target ? 'Waiting for metadata' : 'Resolving feed…';
    if (!target) {
      $('catalog-entries').replaceChildren();
      $('entry-detail').hidden = true;
      return;
    }
    const signature = JSON.stringify([
      this.feedId, target, this.offset, c, connected,
      state?.transfers.map(t => [t.id, t.state, t.files.every(f => f.ready)])
    ]);
    if (signature !== this.signature && !this.loading) {
      this.signature = signature;
      void this.load();
    }
  }
  private go(id: string) {
    this.signature = '';
    location.hash = `#/feeds/${this.feedId}/${id}`;
  }
  private async open(id: string) {
    try {
      await this.host.call({type: 'open_catalog', feed: this.feedId, id});
      this.go(id);
    } catch (e) {
      this.showError(String(e));
    }
  }
  private async load() {
    const request = ++this.request;
    const feed = this.feedId, catalog = this.catalogId;
    this.loading = true;
    try {
      const page = await this.host.call(
                       {type: 'catalog_page', feed, catalog, offset: this.offset},
                       false) as CatalogPage;
      if (request !== this.request || feed !== this.feedId || catalog !== this.catalogId)
        return;
      this.page = page;
      this.drawPage();
      $("catalog-body").replaceChildren();
      if (page.catalog.ready) {
        const value = await this.host.call({type:"read_catalog_body",feed,catalog}, false);
        if (request !== this.request || feed !== this.feedId || catalog !== this.catalogId) return;
        if (value.body) $("catalog-body").replaceChildren(markdown(value.body, target => {
          if (target.startsWith("magnet:")) return () => {
            if (target.includes("urn:btpk:")) this.follow(target);
            else void this.run({type:"add_magnet",uri:target});
          };
          let name: string;
          try { name = decodeURIComponent(target); } catch { return null; }
          const item = page.entries.find(e => e.name === name);
          return item ? () => void this.download(item) : null;
        }));
        const sequence = location.hash.split('/')[4] || null;
        const readKey = `${feed}/${catalog}/${sequence || ''}`;
        if (this.readKey !== readKey) {
          // Set before awaiting: snapshots triggered by the write cannot repeat it.
          this.readKey = readKey;
          try {
            await this.host.call({type:"mark_catalog_read",feed,catalog,sequence});
          } catch (error) {
            if (request === this.request) {this.readError=`Could not save reading state: ${error}`;this.showError(this.readError);}
          }
        }
      }
    } catch (e) {
      if (request === this.request && feed === this.feedId) {
        $('catalog-status').textContent = String(e);
      }
    } finally {
      if (request === this.request) this.loading = false;
    }
  }
  private controls(e: FeedEntry) {
    const group = node('div', '', 'entry-actions');
    const add = (label: string, fn: () => void) => {
      const b = button(label, fn);
      b.disabled = !this.connected;
      group.append(b);
      return b
    };
    if (e.infohash && ['torrent', 'catalog'].includes(e.kind)) {
      const existing = this.state?.transfers.find(t => t.id === e.infohash);
      if (existing)
        add('Show in Library', () => this.host.transfer(e.infohash!));
      else {
        const b =
            add(e.kind === 'catalog' ? 'Open catalog' : 'Download',
                () => void this.download(e));
        b.disabled ||= !this.page?.catalog.ready;
      }
    }
    if (e.feed_magnet) add('Follow feed', () => this.follow(e.feed_magnet!));
    const reveal =
        add('Show in Finder',
            () => void this.run(
                {type: 'reveal_entry', catalog: this.catalogId, index: e.index}));
    reveal.disabled ||= !this.page?.catalog.ready;
    return group;
  }
  private async download(e: FeedEntry) {
    try {
      await this.host.call({
        type: 'download_entry',
        feed: this.feedId,
        catalog: this.catalogId,
        index: e.index
      });
      this.signature = '';
      if (e.kind === 'catalog' && e.infohash)
        this.go(e.infohash);
      else if (e.infohash)
        this.host.transfer(e.infohash);
    } catch (error) {
      this.showError(String(error));
    }
  }
  private drawPage() {
    const page = this.page;
    if (!page) return;
    const list = $('catalog-entries');
    list.replaceChildren();
    if (!page.entries.length)
      list.append(emptyMessage(page.catalog.ready ? 'No items' : 'Catalog files are not available yet.'));
    for (const entry of page.entries) {
      const row = node('article', '', 'catalog-row');
      row.dataset.index = String(entry.index);
      row.setAttribute('aria-selected', String(this.selected === entry.index));
      const name = button(entry.name, () => {
        this.selected = entry.index;
        this.drawPage();
      }, 'link', 'entry-name');
      row.append(
          name, node('span', size(entry.total ?? entry.length), 'entry-size'),
          node(
              'span',
              `${
                  {
                    external_feed: 'External feed',
                    catalog: 'Catalog',
                    torrent: 'Torrent',
                    file: 'File',
                    unsupported: 'Unsupported',
                    pending: 'Item'
                  }[entry.kind] ||
                  entry.kind} · ${entry.state}`,
              'entry-state'));
      if (entry.error) row.append(alertMessage(entry.error));
      row.append(this.controls(entry));
      list.append(row);
    }
    const pager = $('catalog-pages');
    pager.replaceChildren();
    const prev = button('Previous', () => {
      this.offset = Math.max(0, this.offset - 100);
      this.signature = '';
      void this.load();
    });
    prev.disabled = this.offset === 0;
    const next = button('Next', () => {
      this.offset += 100;
      this.signature = '';
      void this.load();
    });
    next.disabled = this.offset + page.entries.length >= page.total;
    pager.append(
        prev,
        node(
            'span',
            page.total ? `${this.offset + 1}–${this.offset + page.entries.length} / ${
                             page.total}` :
                         '0 items'),
        next);
    const detail = $('entry-detail');
    const e = page.entries.find(e => e.index === this.selected);
    detail.hidden = !e;
    detail.replaceChildren();
    if (e) {
      detail.append(
          node('h3', e.name),
          node('p', `${e.state} · ${size(e.total ?? e.length)}`, 'muted'),
          this.controls(e));
      if (e.error) detail.append(alertMessage(e.error));
      for (const f of e.files) {
        const row = node('div', '', 'file');
        row.append(node('span', f.name), node('span', size(f.length), 'muted'));
        detail.append(row);
      }
    }
  }
}
