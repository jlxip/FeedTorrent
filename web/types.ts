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
}
export interface Snapshot {
  engine: string;
  transfers: Transfer[];
  settings: Settings;
  dht_nodes: number;
  listen_port: number;
  warning: string;
  ready: boolean;
}
export type Command =
  | { type: "add_magnet"; uri: string }
  | { type: "add_torrent"; data: number[] }
  | { type: "pause" | "resume"; id: string }
  | { type: "remove"; id: string; delete_files: boolean }
  | { type: "reveal"; id: string; file: number | null }
  | { type: "configure"; settings: Settings };
