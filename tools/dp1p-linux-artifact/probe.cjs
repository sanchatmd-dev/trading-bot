'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),dns=require('node:dns');
net.Socket.prototype.connect=function(){throw Error('Network forbidden in inert probe');};
dns.lookup=function(){throw Error('DNS forbidden in inert probe');};
const root=fs.realpathSync(__dirname),modules=root+path.sep+'node_modules'+path.sep;
const resolved={};
for(const name of ['pg','decimal.js']){
  const file=fs.realpathSync(require.resolve(name));if(!file.startsWith(modules))throw Error('Resolution outside artifact');
  resolved[name]=path.relative(root,file).replaceAll(path.sep,'/');
}
const pg=require('pg'),Decimal=require('decimal.js');
const client=new pg.Client({connectionString:'postgres://synthetic'});
if(typeof client.connect!=='function'||typeof pg.Pool!=='function')throw Error('pg exports');
if(new Decimal('0.1').plus('0.2').toString()!=='0.3')throw Error('Decimal arithmetic');
for(const file of Object.keys(require.cache))if(file!==__filename&&!fs.realpathSync(file).startsWith(modules))throw Error('CJS cache outside artifact');
console.log(JSON.stringify({mode:'CJS',resolved,clientConstructed:true,connectCalled:false,pool:true,decimal:'0.3'}));
