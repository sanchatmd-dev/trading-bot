import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(){
  const bytes=randomBytes(20);let bits=0,value=0,result='';
  for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}
  return result;
}
function decode(secret){
  let bits=0,value=0;const bytes=[];
  for(const char of secret){const n=alphabet.indexOf(char);if(n<0)throw new Error('Invalid TOTP secret');value=(value<<5)|n;bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  return Buffer.from(bytes);
}
export function totp(secret,step=Math.floor(Date.now()/30000),digits=6){
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));
  const hash=createHmac('sha1',decode(secret)).update(counter).digest(),offset=hash.at(-1)&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
export function verifyTotp(secret,code,lastStep=-1,now=Date.now()){
  if(typeof code!=='string'||!/^\d{6}$/.test(code))return null;
  const current=Math.floor(now/30000);
  for(const step of [current,current-1,current+1])if(step>lastStep&&timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(code)))return step;
  return null;
}
