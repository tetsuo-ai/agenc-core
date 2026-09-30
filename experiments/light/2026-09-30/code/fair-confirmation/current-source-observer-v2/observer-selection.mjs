import fs from 'node:fs';
import {sha,verifySelection} from './selection.mjs';
export const FAIR='/private/tmp/light-takeover/fair-confirmation';
// Exact root-supplied ready pins, accepted before the first fixture launch.
// Never discover/adopt a moving source at runtime.
export const OBSERVER_PIN='61e6d38bccdac0f03ce6999c794297a5fee284ee8baa4c8f024941f21947a6f9';
export const SOURCE_GATE_ACCEPTED=true;
// Root must provide these new authorities; no historical profile adoption.
export const METADATA_SCHEMA=10;
export const OBSERVER_CONTRACT='prospective-current-source-finance-v5';
export const BINDING_PROFILE='light-luna-44aed-source-base-v2';
export const PUBLICATION_KIND='luna.capture.published.current.v5';
export const TRANSPORT_PIN='0ead80c608376b2e70d1b2b8dfd9cba51314a7529f11b4f572683a8a7fa4dd04';
export const PYTHON='/usr/bin/python3';
export const PYTHON_PIN='b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9';
export const pins=Object.freeze({
 'luna-policy-v2/policy_guard.mjs':'56d6ae59ffdbe405d2a3bd0d1aab2b0798876bb016211fe284cae9f785375b9a',
 'luna-policy-v2/policy_bridge.py':'ac8620d8fd34b2d1e22761c7034a5a1d4ca972df9ca6536395ca47ba1695b590',
 'current-base-binding-v2/binding.py':'3815c1fbbbbc9b2aaf23a9adcd469d5f5b0a2c4bb38ca42dfed9e826a491f87c',
 'current-base-binding-v2/bridge.py':'c3c2afb87cc28c471cdd1a56f600d2f6beda4479cef27c42ccdcd8bac37ee0b4',
 'prompt-binding-v2/prompt_binding.py':'513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
 'current-base-binding-v2/source-pins.json':'3aae0ba39d020c40a2ade6980f1d2dc5426e50a081b552a9b048be2bfa735457',
 'all-call-policy-v1/policy.py':'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf',
 'stream_adapters.py':'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
 'luna-finance-mode-v2/owner.mjs':'e137831bca7811cad554d2245466208ce85962108dd4a824aa4bce1744a2a9c9',
 'luna-finance-mode-v2/journal.mjs':'7031279770cebb0d2223a61c7a7bc4146fa97dc6ac52b7da5c3f78b4dc313215',
 'luna-finance-v1/accounting.mjs':'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
 'luna-finance-v1/ledger-json.mjs':'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
 'luna-terminal-v1/terminal.mjs':'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70',
});
export function verifyObserverSelection(){
 if(!SOURCE_GATE_ACCEPTED||[OBSERVER_PIN,METADATA_SCHEMA,OBSERVER_CONTRACT,BINDING_PROFILE,PUBLICATION_KIND].some(v=>v===null)||Object.values(pins).some(v=>v===null))throw new Error('Observer dependency approval pending');
 verifySelection();
 if(sha(fs.readFileSync(PYTHON))!==PYTHON_PIN||fs.realpathSync(PYTHON)!==PYTHON)throw new Error('Interpreter selection refused');
 if(!/^[a-f0-9]{64}$/.test(OBSERVER_PIN??'')||!/^[a-f0-9]{64}$/.test(TRANSPORT_PIN??''))throw new Error('Observer selection pending');
 for(const [file,hash]of Object.entries({...pins,'luna-observer-v5/direct.mjs':OBSERVER_PIN,'luna-financial-transport-v1/transport.mjs':TRANSPORT_PIN})){
  if(sha(fs.readFileSync(FAIR+'/'+file))!==hash)throw new Error('Observer selection refused');
 }
}
