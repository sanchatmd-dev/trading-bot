import {readJson as readStream} from '../http-safety.js';
const bodies=new WeakMap();
export async function preloadJson(req){bodies.set(req,await readStream(req));}
export async function readJson(req){
  if(!bodies.has(req))return readStream(req);
  await req.validateAuth?.();return bodies.get(req);
}
