// Fixture-only bounded ownership. Failure is not completion until close.
export function awaitOwnedChild(child,{timeoutMs=15000,closeMs=1000,onMessage=()=>{}}={}){
  return new Promise((resolve,reject)=>{
    let ended=false,stopping=false,primary=null,closeTimer;
    let stderr='';
    const end=(error)=>{
      if(ended)return;ended=true;clearTimeout(timer);clearTimeout(closeTimer);
      child.removeListener('error',onError);child.removeListener('close',onClose);
      child.removeListener('message',onMessage);child.stderr?.removeListener('data',onData);
      if(error?.cleanupConfirmed===false){
        // Late errors from a still-unconfirmed owned child must not become an
        // unhandled EventEmitter error. Keep containment status unknown.
        const ignore=()=>{};child.on('error',ignore);
        child.once('close',()=>child.removeListener('error',ignore));
      }
      error?reject(error):resolve();
    };
    const stop=reason=>{
      primary??=reason;if(stopping||ended)return;stopping=true;
      closeTimer=setTimeout(()=>{
        const error=new Error('Fixture child close unconfirmed');
        error.cleanupConfirmed=false;error.pid=child.pid??null;end(error);
      },closeMs);
      // A throw/false return is not proof that the process has stopped. Keep
      // the close listener and bound confirmation separately from signal send.
      try{child.kill('SIGKILL');}catch{}
    };
    const onError=()=>stop('Fixture child error');
    const onData=data=>{if(stderr.length<4096)stderr+=String(data).slice(0,4096-stderr.length);};
    const onClose=(code,signal)=>{
      if(primary!==null||code!==0||signal!==null){
        const error=new Error(primary??'Fixture child failed');error.cleanupConfirmed=true;
        error.code=code;error.signal=signal;error.stderr=stderr;end(error);
      }else end();
    };
    const timer=setTimeout(()=>stop('Fixture child timeout'),timeoutMs);
    child.on('error',onError);child.on('close',onClose);child.on('message',onMessage);
    child.stderr?.on('data',onData);child.stdout?.resume();
  });
}
