import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import {fileURLToPath} from 'node:url';
net.Socket.prototype.connect=function(){throw Error('Network forbidden in inert probe');};
dns.lookup=function(){throw Error('DNS forbidden in inert probe');};
const root=fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))),modules=root+path.sep+'node_modules'+path.sep;
const resolved={};
for(const name of ['pg','decimal.js']){
  const file=fs.realpathSync(fileURLToPath(import.meta.resolve(name)));
  if(!file.startsWith(modules))throw Error('Resolution outside artifact');resolved[name]=path.relative(root,file).replaceAll(path.sep,'/');
}
const {default:pg}=await import('pg'),{default:Decimal}=await import('decimal.js');
const client=new pg.Client({connectionString:'postgres://synthetic'});
if(typeof client.connect!=='function'||typeof pg.Pool!=='function')throw Error('pg exports');
if(new Decimal('0.1').plus('0.2').toString()!=='0.3')throw Error('Decimal arithmetic');
console.log(JSON.stringify({mode:'ESM',resolved,clientConstructed:true,connectCalled:false,pool:true,decimal:'0.3'}));
