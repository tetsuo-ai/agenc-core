import {isAbsolute,normalize,join} from 'node:path';
import {SOURCE_REVISION} from '../real-parent-adapters-v1/pins.mjs';
export const MAX_INVENTORY_ENTRIES=100_000;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const path=value=>typeof value==='string'&&isAbsolute(value)&&normalize(value)===value&&value.trim()===value;
// Selection is separately hash-pinned on the command line by root. Complete
// immutable dependency inventory is root's prerequisite, not inferred by this schema.
export function validateSelection(value){
  if(!value||value.version!==2||value.source_revision!==SOURCE_REVISION||
    !path(value.core_root)||!path(value.node_path)||!path(value.bridge?.path)||!hex(value.bridge?.sha256)||
    !value.files||typeof value.files!=='object'||Array.isArray(value.files)||
    Object.keys(value.files).length>MAX_INVENTORY_ENTRIES||
    !Object.entries(value.files).every(([name,hash])=>path(name)&&hex(hash))||
    !value.expected_build||!['runtimeVersion','commit','buildTime'].every(key=>typeof value.expected_build[key]==='string'&&value.expected_build[key].length>0)||
    value.expected_build.commit!==SOURCE_REVISION||value.reviewed_full_closure!==true)
    throw new Error('selection_invalid');
  const required=[value.node_path,value.bridge.path,join(value.core_root,'runtime/bin/agenc'),join(value.core_root,'runtime/dist/VERSION')];
  if(!required.every(name=>hex(value.files[name]))||value.files[value.bridge.path]!==value.bridge.sha256)
    throw new Error('required_artifact_pin_missing');
  return Object.freeze({core_root:value.core_root,node_path:value.node_path,
    bridge:Object.freeze({...value.bridge}),expected_build:Object.freeze({...value.expected_build}),
    files:Object.freeze({...value.files}),source_revision:SOURCE_REVISION});
}
