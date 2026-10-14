import {readJson as readStream} from '../http-safety.js';
const bodies=new WeakMap();
export async function preloadJson(req){
  const pathname=new URL(req.url,'http://localhost').pathname;
  const maxBytes=['/api/quant/pine-bridge/analyze','/api/quant/pine-bridge/inspect'].includes(pathname)?2*1024*1024:65536;
  // http-safety stays the only judge of size, JSON and errors; this listener keeps the same bytes as received, so a later
  // read can parse them again. It stops keeping bytes past the limit, where readStream refuses the body anyway.
  const chunks=[];let size=0;
  const keep=chunk=>{size+=chunk.length;if(size<=maxBytes)chunks.push(chunk);};
  req.on('data',keep);
  try{
    const value=await readStream(req,{maxBytes});
    bodies.set(req,{value,raw:Buffer.concat(chunks).toString('utf8')||'{}',read:false});
  }finally{req.off('data',keep);}
}
export async function readJson(req){
  if(!bodies.has(req))return readStream(req);
  // The first read gets the parsed body; every later read parses the received text again, so a retried request attempt sees
  // the body as received, whatever an earlier attempt changed in it. JSON.parse also accepts any depth readStream accepted.
  await req.validateAuth?.();
  const body=bodies.get(req);
  if(!body.read){body.read=true;return body.value;}
  return JSON.parse(body.raw);
}
