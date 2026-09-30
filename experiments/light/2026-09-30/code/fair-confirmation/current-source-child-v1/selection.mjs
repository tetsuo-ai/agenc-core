import fs from 'node:fs';
import crypto from 'node:crypto';
export const CORE='/private/tmp/light-clean-prepared-mHtxlR/source/runtime';
export const PREVIOUS='/private/tmp/light-takeover/fair-confirmation/current-initial-preflight-v2';
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const fixed=Object.freeze({
 [CORE+'/src/utils/model/providers.ts']:'382116760e9aa482c1f81105a9833707b97750b03511a2fc237c566a192a7459',
 [CORE+'/src/utils/model/provider-selection-context.ts']:'6fffd9eace2e11b167d9b6ea58d6d215142a24ca2c607bae16ea554e657bf428',
 [CORE+'/src/utils/settings/canonicalAuthority.ts']:'0137c797ca0bdfda76f48028c73273e42b31de5b978f0a6d72598f4916e4bc94',
 [CORE+'/src/llm/client-session.ts']:'392cec6eb8f0905e18f641557b29ea06e7253b33d2fe4a46b0411ff15a8a01c4',
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
 '/opt/homebrew/bin/node':'902b6a6984d5d825829ea9064ab73b734548df37bc0683990dca31c8dc2a9253',
});
export function verifySelection(){
 for(const [path,hash]of Object.entries(fixed))if(sha(fs.readFileSync(path))!==hash)throw new Error('Source selection refused');
 const selected=JSON.parse(fs.readFileSync(PREVIOUS+'/source-pins.json','utf8'));
 for(const [path,hash]of Object.entries(selected))if(sha(fs.readFileSync(CORE+'/'+path))!==hash)throw new Error('Source selection refused');
 return selected;
}
