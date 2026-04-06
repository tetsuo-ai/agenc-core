/**
 * Tiled JSON schema types for map loading.
 */

export interface TiledTileset {
  firstgid: number;
  name: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  margin?: number;
  spacing?: number;
}

export interface TiledTileLayer {
  id: number;
  name: string;
  type: 'tilelayer';
  width: number;
  height: number;
  data: number[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export interface TiledObject {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  properties?: Array<{
    name: string;
    type: string;
    value: unknown;
  }>;
}

export interface TiledObjectGroup {
  id: number;
  name: string;
  type: 'objectgroup';
  objects: TiledObject[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export type TiledLayer = TiledTileLayer | TiledObjectGroup;

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
  orientation: string;
  renderorder: string;
}

export interface ParsedMap {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  tileLayers: TiledTileLayer[];
  objectGroups: TiledObjectGroup[];
  tilesets: TiledTileset[];
  collisionGrid: number[][] | null;
  locationObjects: TiledObject[];
}
