import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptsDirectory=fileURLToPath(new URL('../scripts/',import.meta.url));
const scriptName='check-quant-foundation-idle.mjs';
const scriptUrl=new URL('../scripts/'+scriptName,import.meta.url);
const refusal={ok:false,codes:['QUANT_IDLE_CONFIGURATION_REQUIRED'],queuedPolicies:[]};
// No staging settings: the check stops at its configuration test and never opens a database.
const bareEnvironment=()=>{
  const env={...process.env};
  for(const name of ['PAPER_TRADING','PINE_BRIDGE_ENV','QUANT_RESEARCH_FOUNDATION_ENABLED','DATABASE_URL','TEST_DATABASE_URL'])
    delete env[name];
  return env;
};
const start=file=>spawnSync(process.execPath,[file],{env:bareEnvironment(),encoding:'utf8',timeout:60000});

test('the idle check still runs when it is started through a symbolic link or a junction',async t=>{
  const real=path.join(scriptsDirectory,scriptName);
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'idle-link-'));
  const created=[];
  // Remove the links themselves and then the empty directory. Neither call can remove the real scripts through a link.
  t.after(async()=>{for(const item of created)await fs.unlink(item);await fs.rmdir(directory);});
  const folder=path.join(directory,'current');
  // A junction needs no privilege on Windows. Elsewhere the type is ignored and this is a symbolic link.
  await fs.symlink(scriptsDirectory,folder,'junction');created.push(folder);
  const direct=start(real),linked=start(path.join(folder,scriptName));
  // A run that prints nothing and exits 0 would read as an idle system, so the line and the code both matter.
  for(const result of [direct,linked]){
    assert.equal(result.status,2);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),refusal);assert.equal(result.stdout.trim().split('\n').length,1);
  }
  assert.equal(linked.stdout,direct.stdout);
  // A link to the file itself runs as well. Windows may refuse to create one without privilege.
  const fileLink=path.join(directory,'idle.mjs');
  try{await fs.symlink(real,fileLink,'file');created.push(fileLink);}
  catch(error){if(!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error;}
  if(created.includes(fileLink)){
    const viaFile=start(fileLink);
    assert.deepEqual([viaFile.status,viaFile.stderr,viaFile.stdout],[2,'',direct.stdout]);
  }
  // Imported by a process whose argv[1] is no real file, the module only defines its function and prints nothing.
  const probe=path.join(directory,'probe.mjs');created.push(probe);
  await fs.writeFile(probe,["process.argv[1]='/no/such/place/idle.mjs';",
    `await import(${JSON.stringify(scriptUrl.href)});`,"console.log('imported');"].join('\n'));
  const imported=start(probe);
  assert.deepEqual([imported.status,imported.stdout.trim(),imported.stderr],[0,'imported','']);
});

test('the idle check start guard compares the real path of the script',()=>{
  const source=readFileSync(scriptUrl,'utf8');
  assert.match(source,/import\.meta\.url===pathToFileURL\(realpathSync\(process\.argv\[1\]\)\)\.href/);
  assert.doesNotMatch(source,/pathToFileURL\(process\.argv\[1\]\)/);
});
