import fs from 'node:fs';
import crypto from 'node:crypto';
export const CORE='/private/tmp/light-clean-responses-eof-RKsVUm/source/runtime';
export const NODE='/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node';
export const PREVIOUS='/private/tmp/light-takeover/fair-confirmation/current-initial-preflight-v2';
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const fixed=Object.freeze({
 [CORE+'/src/tools/system/file-read.ts']:'508c3db91dc396e202dba3f9fbc5b5a33a23df8772fec2af8790a88039de9ef2',
 [CORE+'/src/tools/system/_deps/line-numbers.ts']:'18b3045211362873d247fae7cc48c19dc960d8d5e0cd39575294bddaa99c9373',
 [CORE+'/src/tools/untrusted-tool-result-framing.ts']:'6edcbacf4301db9e0f2258b8ad7ef7f3fe696cdde95b2d9dd3bf229865ce3a35',
 [CORE+'/src/phases/execute-tools.ts']:'a1004ea4e16e52d7203496c4bfad42e1a1401ac36347424d0f1166502e09ea67',
 [CORE+'/src/permissions/path-validation.ts']:'3f03d6b0df2eedc7278f7b1410dc63266891ddf0a1495db585144a45078c482d',
 [CORE+'/src/tools/system/filesystem.ts']:'81200b9eb45530688f3cbc718212da1630824be6932781bc1e67b43946208ac5',
 [CORE+'/src/utils/model/providers.ts']:'382116760e9aa482c1f81105a9833707b97750b03511a2fc237c566a192a7459',
 [CORE+'/src/utils/model/provider-selection-context.ts']:'6fffd9eace2e11b167d9b6ea58d6d215142a24ca2c607bae16ea554e657bf428',
 [CORE+'/src/utils/settings/canonicalAuthority.ts']:'0137c797ca0bdfda76f48028c73273e42b31de5b978f0a6d72598f4916e4bc94',
 [CORE+'/src/llm/client-session.ts']:'61ce6cdc0cdb6498d71c1f5b5919c069511935846c6dc26ba507ed195f5dba6b',
 [CORE+'/../node_modules/jsonc-parser/package.json']:'a7a9192caaac00d9330592f4fd572908bee037518128a0fc3db96d2cd652e2b5',
 [CORE+'/src/utils/permissions/yoloClassifier.ts']:'65ba726d45bce2cb25f1575a9afbd7f2b3e625789b41d4629a0ca8aed4d7f1eb',
 [CORE+'/src/utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt']:'d64e592c108021545b57c58a1142e420268dee7b8c2a67a9c02c6fe84bbb8f75',
 [CORE+'/src/utils/permissions/yolo-classifier-prompts/permissions_external.txt']:'7400210358e165cb2d1ba4d18e08fdbbde303a3223040f6d8e9de9c674c1300b',
 [CORE+'/src/tui/ink/global.d.ts']:'8c1ed672930cb49c2f604067d4986ae87d42ef28114e2d1c6b30739d50294c4a',
 [PREVIOUS+'/source-pins.json']:'8d90e6c628255fe5e4930359e3ba73d252fb6c4512cfeb834d235cc1fc638218',
 [PREVIOUS+'/probe.test.ts']:'c7ca2913f0515cdeac1302f9267d295bb996901e0492d77baa2390a4dc79d4a6',
 [CORE+'/vitest.config.ts']:'eb3c581fa42bc8334532e779af1b768bcd32a155126de1c3212e13b3f030f232',
 [CORE+'/tests/helpers/network-tripwire.cjs']:'e7fc31100e5db23b2c27e9f8c038c87a9b88c1d2da40da53696d32a2ba00d283',
 [CORE+'/tests/fixtures.ts']:'221f5ec1d3181fe3858909b6794b46de9649367975aeb2b6320cc91e4d6b3ee1',
 [CORE+'/src/build/feature.ts']:'ac2e0d25f8f5af58f32ec2ea339aabc720b07f5ff9754691573a46ec40438ed9',
 [CORE+'/../node_modules/typescript/lib/typescript.js']:'569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39',
 [NODE]:'ebd2d552c7bebde593dd0390530963ad28de56bccde6ce387cdbe55fb0b6fb8e',
});
export function verifySelection(){
 for(const [path,hash]of Object.entries(fixed))if(sha(fs.readFileSync(path))!==hash)throw new Error('Source selection refused');
 const selected=JSON.parse(fs.readFileSync(new URL('./source-pins.json',import.meta.url),'utf8'));
 for(const [path,hash]of Object.entries(selected))if(sha(fs.readFileSync(CORE+'/'+path))!==hash)throw new Error('Source selection refused');
 return selected;
}
