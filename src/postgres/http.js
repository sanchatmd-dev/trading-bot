import {readJson as readStream} from '../http-safety.js';
const bodies=new WeakMap();
export async function preloadJson(req){
  const pathname=new URL(req.url,'http://localhost').pathname;
  bodies.set(req,await readStream(req,{maxBytes:['/api/quant/pine-bridge/analyze','/api/quant/pine-bridge/inspect'].includes(pathname)?2*1024*1024:65536}));
}
export async function readJson(req){
  if(!bodies.has(req))return readStream(req);
  await req.validateAuth?.();return bodies.get(req);
}
