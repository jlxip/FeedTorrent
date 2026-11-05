import type {PublishingState} from "./publishing.js";
export interface Settings {
  download_dir: string;
  peer_port: number;
  seed_by_default: boolean;
}
export interface TorrentFile {
  name: string;
  length: number;
  verified: number;
  ready: boolean;
}
export interface Transfer {
  id: string;
  name: string;
  state: string;
  error: string;
  warning: string;
  active: boolean;
  verified: number;
  total: number;
  progress: number;
  down: number;
  up: number;
  peers: number;
  files: TorrentFile[];
  save_path: string;
  held: boolean;
  approval_size: number|null;
  kind: string;
  feed: string|null;
}
export interface Snapshot {
  publishing:PublishingState;
  engine: string;
  transfers: Transfer[];
  settings: Settings;
  dht_nodes: number;
  listen_port: number;
  warning: string;
  ready: boolean;
  feeds: Feed[];
  feed_error: string;
  feed_time_ms: number;
  news_unread: number;
  news_revision: string;
}
export type Command = FeedCommand|{
  type: 'add_magnet';
  uri: string
}
|{
  type: 'add_torrent';
  data: number[]
}
|{
  type: 'pause'|'resume';
  id: string
}
|{
  type: 'remove';
  id: string;
  delete_files: boolean
}
|{
  type: 'reveal';
  id: string;
  file: number|null
}
|{
  type: 'configure';
  settings: Settings
};

export type FeedMode = 'current_catalog'|'mirror_catalogs'|'mirror_all';
export interface FeedConfig {
  name: string;
  mode: FeedMode;
  automatic_limit: number|null
}
export interface Catalog {
  id: string;
  name: string;
  total: number;
  state: string;
  error: string;
  ready: boolean;
  previous: string|null;
  archive: string|null;
  foreign_feed: string|null;
  count: number;
  indexed: number
}
export interface Feed {
  local_name: string;
  id: string;
  name: string;
  magnet: string;
  mode: FeedMode;
  automatic_limit: number|null;
  sequence: string|null;
  head: string|null;
  available: string|null;
  state: string;
  error: string;
  update_peers: number;
  last_checked_ms: number|null;
  catalogs: Catalog[];
  mirror_status: string
}
export interface FeedEntry {
  index: number;
  name: string;
  length: number;
  kind: string;
  infohash: string|null;
  total: number|null;
  state: string;
  error: string;
  feed_magnet: string|null;
  files: {name: string; length: number}[]
}
export interface CatalogPage {
  catalog: Catalog;
  entries: FeedEntry[];
  offset: number;
  total: number
}
export type FeedCommand =
|{type:"news_page";offset:number;anchor:string|null}
|{type:"set_update_read";feed:string;sequence:string;read:boolean}
|{type:"mark_catalog_read";feed:string;catalog:string;sequence:string|null}
|{type:"read_catalog_body";feed:string;catalog:string}|{
  type: 'inspect_source';
  uri: string
}
|{
  type: 'follow_feed';
  uri: string;
  config: FeedConfig
}
|{
  type: 'configure_feed';
  id: string;
  config: FeedConfig
}
|{
  type: 'unfollow_feed'|'refresh_feed';
  id: string
}
|{
  type: 'open_catalog';
  feed: string;
  id: string
}
|{
  type: 'download_entry';
  feed: string;
  catalog: string;
  index: number
}
|{
  type: 'approve_transfer';
  id: string
}
|{
  type: 'reveal_entry';
  catalog: string;
  index: number
}
|{
  type: 'catalog_page';
  feed: string;
  catalog: string;
  offset: number
};

export interface NewsEntry {
  feed: string;
  sequence: string;
  catalog: string;
  feed_name: string;
  name: string;
  detected_ms: number|null;
  read: boolean;
  ready: boolean;
  state: string;
  error: string;
}
export interface NewsPage {
  entries: NewsEntry[];
  offset: number;
  total: number;
  anchor: string;
}
