import {registerHooks} from 'node:module';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {CORE,verifySelection} from './selection.mjs';

export async function installSourceLoader(){
 verifySelection();
 const ts=(await import(CORE+'/../node_modules/typescript/lib/typescript.js')).default;
 let configuration;
 const loaded=new Map();
 const own=dirname(fileURLToPath(import.meta.url));
 const scoped=p=>p.startsWith(CORE+'/')||p.startsWith(own+'/');
 function candidate(base){
  for(const name of [base,base.replace(/\.js$/,'.ts'),base.replace(/\.js$/,'.tsx'),base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'])
   if(existsSync(name)&&statSync(name).isFile())return name;
 }
 registerHooks({
  resolve(specifier,context,next){
   if(specifier==='vitest'||specifier==='bun:test'||specifier.endsWith('/tests/fixtures.js'))throw new Error('Test lifecycle import refused');
   let selected;
   if(configuration){
    for(const alias of configuration.resolve.alias){
     if(typeof alias.find==='string'&&specifier===alias.find){selected=alias.replacement;break;}
     // Canonical src resolver has relocated-source semantics; call its plugin
     // first instead of reducing all bare src paths to one directory.
    }
    if(!selected)for(const plugin of configuration.plugins){
     if(typeof plugin.resolveId==='function'){
      const found=plugin.resolveId(specifier,context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):undefined);
      if(found){if(typeof found!=='string')throw new Error('Source resolver refused');selected=found;break;}
     }
    }
    if(!selected)for(const alias of configuration.resolve.alias){
     if(alias.find instanceof RegExp&&alias.find.test(specifier)){
      selected=candidate(specifier.replace(alias.find,alias.replacement));break;
     }
    }
   }
   if(!selected&&(specifier.startsWith('/')||specifier.startsWith('.')||specifier.startsWith('file:'))){
    const base=specifier.startsWith('file:')?fileURLToPath(specifier):specifier.startsWith('/')?specifier:
     resolve(dirname(fileURLToPath(context.parentURL)),specifier);
    if(scoped(base)||base.startsWith(CORE+'/../node_modules/jsonc-parser/lib/esm/')||base.startsWith(resolve(CORE,'../node_modules/jsonc-parser/lib/esm')+'/'))selected=candidate(base);
   }
   // CJS createRequire also traverses hooks; an absolute filesystem path
   // preserves its registered .txt loader, unlike passing it a file: URL.
   return next(selected??specifier,context);
  },
  load(url,context,next){
   if(url.startsWith('file:')){
    const path=fileURLToPath(url);
    if(scoped(path)&&(/\.(ts|tsx|mts)$/.test(path)||path.endsWith('.md'))){
     const source=readFileSync(path,'utf8');loaded.set(path,source.length);
     // This exact pinned file contains declarations plus export{} only.
     if(path===CORE+'/src/tui/ink/global.d.ts')return {format:'module',shortCircuit:true,source:'export {}'};
     if(path.endsWith('.md'))return {format:'module',shortCircuit:true,source:'export default '+JSON.stringify(source)};
     const prefix=path===CORE+'/vitest.config.ts'?'const __dirname='+JSON.stringify(CORE)+';\n':'';
     try{return {format:'module',shortCircuit:true,source:ts.transpileModule(prefix+source,{fileName:path,
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText};}
     catch{const error=new Error('Source transpilation refused');error.url=url;throw error;}
    }
   }
   return next(url,context);
  },
 });
 // Config-only import; no Vitest runner/setup/test lifecycle is invoked.
 configuration=(await import(CORE+'/vitest.config.ts')).default;
 return ()=>Object.freeze({sourceModules:loaded.size,markdownModules:[...loaded.keys()].filter(p=>p.endsWith('.md')).length});
}


