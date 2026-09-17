export function readJson(req) {
  return new Promise((resolve,reject)=>{
    let size=0,done=false;
    const chunks=[];
    const fail=message=>{if(done)return;done=true;chunks.length=0;reject(new Error(message));};
    req.on('data',chunk=>{
      if(done)return; // Drain oversized bodies without retaining additional bytes.
      size+=chunk.length;
      if(size>65536){fail('Payload too large');return;}
      chunks.push(chunk);
    });
    req.on('end',()=>{
      if(done)return;
      done=true;
      try {
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
        if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('JSON object required');
        req.validateAuth?.();
        resolve(value);
      }catch(error){reject(error);}
    });
    req.on('error',()=>fail('Request stream error'));
    req.on('aborted',()=>fail('Request aborted'));
  });
}

export class RateLimiter {
  constructor({limit=120,windowMs=60000,maxKeys=10000}={}) {
    Object.assign(this,{limit,windowMs,maxKeys});this.entries=new Map();
  }
  accept(key,now=Date.now()) {
    for(const [k,v] of this.entries)if(v.until<=now)this.entries.delete(k);
    let item=this.entries.get(key);
    if(!item){
      if(this.entries.size>=this.maxKeys)return false;
      item={count:0,until:now+this.windowMs};this.entries.set(key,item);
    }
    return ++item.count<=this.limit;
  }
}

export function booleanValue(value,name) {
  if(typeof value!=='boolean')throw new Error(`${name} must be true or false`);
  return value;
}

export function clientIp(req,trustLoopback=false) {
  const remote=String(req.socket?.remoteAddress||'');
  const loopback=remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1';
  if(!trustLoopback||!loopback)return remote;
  // Nginx appends the actual peer as the right-most address. Ignore earlier client-supplied values.
  const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
  return forwarded.at(-1)||remote;
}
