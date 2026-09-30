const ts=require('/private/tmp/light-runtime/core/node_modules/typescript');
const fs=require('fs');
const root='/private/tmp/light-runtime/core/runtime/src/';
const specs={
 'session/run-turn.ts':{'prepareSamplingRequestBoundary':'prompt.assembly','preparedRequestFitsContext':'prompt.context_accounting','syncSessionState':'persistence.history'},
 'session/session-store.ts':{'writeBytesWithFsync':'persistence.rollout','rewriteAtomically':'persistence.atomic','flushBatch':'persistence.flush','writeIndexSnapshot':'persistence.index'},
 'budget/admitted-tool-call.ts':{'appendEffectEvent':'receipts.commit','projectCommittedEffectEvent':'receipts.projection','runAdmittedToolCall':'tool.admitted'},
 'budget/admitted-model-call.ts':{'runAdmittedModelCall':'model.admitted'},
 'phases/commit.ts':{'commit':'persistence.iteration'},
 'utils/durable-atomic-file.ts':{'writeDurableAtomicFileSync':'persistence.atomic_sync','writeDurableAtomicFile':'persistence.atomic_async'},
};
for(const [file,names] of Object.entries(specs)){
 let src=fs.readFileSync(root+file,'utf8'); const ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true); const edits=[];
 function visit(n){
  const name=n.name?.getText(ast); const varname=ts.isArrowFunction(n)&&ts.isVariableDeclaration(n.parent)?n.parent.name.getText(ast):null;
  const match=names[name]||names[varname];
  if(match&&n.body&&ts.isBlock(n.body)){
   const extra=match==='tool.admitted'? ', { tool: params.tool.name, call_id: params.callId }':'';
   edits.push([n.body.getStart(ast)+1,`\n  const finishRuntimeSpan = runtimeSpan("${match}"${extra});\n  try {`]);
   edits.push([n.body.end-1,`\n  } finally { finishRuntimeSpan(); }\n`]);
   console.log(file,name||varname,match);
  }
  ts.forEachChild(n,visit);
 } visit(ast);
 for(const [pos,txt] of edits.sort((a,b)=>b[0]-a[0])) src=src.slice(0,pos)+txt+src.slice(pos);
 if(edits.length) src='import { runtimeSpan } from "../diagnostics/runtime-timing.js";\n'+src;
 fs.writeFileSync(root+file,src);
}
