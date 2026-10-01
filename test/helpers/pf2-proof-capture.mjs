/**
 * Test-only reach into the one closure the PF-2 worker keeps private.
 *
 * QuantResearchFoundationWorker.runPreflight wraps runner.runChunk in a function that refuses a second concurrent
 * launch, and hands that wrapper to runHistoricalPreflight inside an options literal. The literal has no readFile
 * key and the driver destructures readFile from it, so an accessor on Object.prototype sees the literal as its
 * receiver. The accessor returns undefined (exactly what the missing key returns), keeps a pointer to the wrapper
 * and removes itself at once. Nothing in src changes. If the driver stops reading readFile from its options, the
 * wrapper is never captured and the test that needs it fails loudly instead of passing quietly.
 *
 * Install it before the worker tick starts. Call release() in a finally block.
 */
const KEY='readFile';

export function captureReplayOptions(){
  if(Object.getOwnPropertyDescriptor(Object.prototype,KEY))throw Error('Object.prototype already has a '+KEY+' property');
  let captured=null,installed=false;
  const get=function(){
    try{
      if(captured===null&&Object.hasOwn(this,'runChunk')&&Object.hasOwn(this,'resolved')&&typeof this.runChunk==='function'){
        captured=this.runChunk;release();
      }
    }catch{/* A foreign receiver is never an error for the code under test. */}
    return undefined;
  };
  // Assignment on any object keeps its normal meaning while the accessor is installed.
  const set=function(value){Object.defineProperty(this,KEY,{value,writable:true,enumerable:true,configurable:true});};
  function release(){
    if(installed&&Object.getOwnPropertyDescriptor(Object.prototype,KEY)?.get===get)delete Object.prototype[KEY];
    installed=false;
  }
  Object.defineProperty(Object.prototype,KEY,{configurable:true,enumerable:false,get,set});
  installed=true;
  return {get runChunk(){return captured;},release};
}
