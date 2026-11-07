import type {PublishingState} from "./publishing.js";
export interface OrganizationNode {key:string;parent:string|null;archived:boolean;}
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
  post: string|null;
  pinned:boolean;
  protected_by:string[];
  used_by:string[];
}
export type SourceOrigin={kind:'own';id:string}|{kind:'catalog';parent:string};
export type RemovalTarget={kind:'post';post_kind:'own'|'followed';id:string}|{kind:'unpin';id:string}|{kind:'torrent';id:string;delete_files:boolean};
export interface RemovalPreview {revision:string;target:RemovalTarget;deleting:string[];shared:string[];protected:string[];bytes:number;names:string[];shared_names:string[];protected_names:string[];used_by?:string[];}
export interface Cleanup {id:number;target:RemovalTarget;detached:boolean;remaining:string[];error:string;}
export interface Snapshot {
  cleanup:Cleanup[];
  publishing:PublishingState;
  organization: {revision:string; nodes:OrganizationNode[]; error:string};
  engine: string;
  transfers: Transfer[];
  settings: Settings;
  dht_nodes: number;
  listen_port: number;
  warning: string;
  ready: boolean;
  posts: Post[];
  post_error: string;
  post_time_ms: number;
  news_unread: number;
  news_revision: string;
}
export interface ContentFile extends TorrentFile {index:number;}
export interface ContentData {
  created_at?:number|null;updated_at?:number|null;
  id:string;name?:string;total:number|null;kind:string;files:ContentFile[];entries:PostEntry[];
  count:number;offset:number;body:import('./markdown.js').MarkdownNode|null;
  body_state:'metadata'|'absent'|'pending'|'ready'|'error';body_error:string;error:string;
  source?:number[];source_uri?:string;source_index?:number;previous?:string|null;archive?:string|null;
}
export type Command = {type:'preview_removal';target:RemovalTarget}|{type:'delete_post';post_kind:'own'|'followed';id:string;revision:string}|{type:'set_pin';id:string;pinned:boolean;revision?:string}|{type:'retry_cleanup';id:number}|PostCommand|{type:'read_content';id:string;parent?:string;offset:number}|{
  type: 'add_magnet';
  uri: string;
  origin?:SourceOrigin
}
|{
  type: 'add_torrent';
  data: number[];
  origin?:SourceOrigin
}
|{
  type:'organize_post'; revision:string; key:string; action:'move'|'archive'|'restore'; parent:string|null; before:string|null;
}
|{
  type: 'pause'|'resume';
  id: string
}
|{
  type: 'remove';
  id: string;
  delete_files: boolean;
  revision?:string
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

export type PostMode = 'current_catalog'|'mirror_catalogs'|'mirror_all';
export interface PostConfig {
  name: string;
  mode: PostMode;
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
  foreign_post: string|null;
  count: number;
  indexed: number
}
export interface Post {
  local_name: string;
  id: string;
  name: string;
  magnet: string;
  mode: PostMode;
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
export interface PostEntry {
  index: number;
  source_name: string;
  name: string;
  length: number;
  kind: string;
  infohash: string|null;
  total: number|null;
  state: string;
  error: string;
  post_magnet: string|null;
  files: {name: string; length: number}[]
}
export interface CatalogPage {
  created_at?:number|null;updated_at?:number|null;
  catalog: Catalog;
  entries: PostEntry[];
  offset: number;
  total: number
}
export type PostCommand =
|{type:"news_page";offset:number;anchor:string|null}
|{type:"set_update_read";post:string;sequence:string;read:boolean}
|{type:"mark_catalog_read";post:string;catalog:string;sequence:string|null}
|{type:"read_catalog_body";post:string;catalog:string}|{
  type: 'inspect_source';
  uri: string
}
|{
  type: 'follow_post';
  uri: string;
  config: PostConfig
}
|{
  type: 'configure_post';
  id: string;
  config: PostConfig
}
|{
  type: 'unfollow_post'|'refresh_post';
  id: string
}
|{
  type: 'open_catalog';
  post: string;
  id: string
}
|{
  type: 'download_entry';
  post: string;
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
  post: string;
  catalog: string;
  offset: number
};

export interface NewsEntry {
  post: string;
  sequence: string;
  catalog: string;
  post_name: string;
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
