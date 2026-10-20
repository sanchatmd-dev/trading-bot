import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectSource,validateSelection,hash,versions} from '../src/pine-bridge/source.js';
import {assemble,assembleNativeTrace} from '../src/pine-bridge/template.js';
import {SCHEMA_VERSION,LEGACY_SCHEMA_VERSION} from '../src/pine-bridge/contract.js';
import {deploymentExitVersion,KNOWN_EXIT_VERSIONS} from '../src/pine-bridge/exit-version.js';

const source='//@version=6\r\nindicator("exit version fixture")\r\nfast = input.int(10, "Fast", minval=1, maxval=100)\r\nslow = input.int(30, "Slow", minval=1)\r\nbuy = ta.crossover(ta.ema(close, fast), ta.ema(close, slow))\r\nsell = ta.crossunder(ta.ema(close, fast), ta.ema(close, slow))\r\nplot(close)\r\n';
const analysis=inspectSource(source),signals={buy:'buy',exit:'sell',timing:'bar_close'};
const deployment={deployment_id:'12345678-1234-1234-1234-123456789abc',pine_import_id:'12345678-1234-1234-1234-123456789def',source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'};
const otherId='87654321-4321-4321-4321-cba987654321';
const artifact=assemble(source,validateSelection(analysis,signals,[]),deployment).integrated_pine;
const snapshot={artifact_hash:hash(artifact),source_hash:hash(source),instruction_versions:versions};
const derive=(a=artifact,s=snapshot,id=deployment.deployment_id)=>deploymentExitVersion(a,s,id);
const rehash=a=>({...snapshot,artifact_hash:hash(a)});
const refused=(result,reason)=>{
  assert.equal(result.ok,false);assert.equal(result.code,'MP_INPUT_INVALID');
  assert.equal(result.field,'deployment.exit_version');assert.equal(result.reason,reason);
  assert.ok(Object.isFrozen(result));assert.equal('exit_version' in result,false);
};
const headerLine='// Robot Trade bridge-exit-v2. DRAFT: compilation and Paper evidence required.';
const prefixOf=(version,id)=>'{\\"schema_version\\":\\"'+version+'\\",\\"deployment_id\\":\\"'+id+'\\"';
const prefixText=prefixOf('bridge-exit-v2',deployment.deployment_id);

test('artifact from the current template derives bridge-exit-v2',()=>{
  assert.ok(artifact.includes(headerLine));assert.ok(artifact.includes(prefixText));
  const result=derive();
  assert.deepEqual(result,{ok:true,exit_version:'bridge-exit-v2'});
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(KNOWN_EXIT_VERSIONS));assert.deepEqual([...KNOWN_EXIT_VERSIONS],['bridge-exit-v1','bridge-exit-v2']);
});

test('CRLF artifact is handled as the template emits it',()=>{
  assert.ok(artifact.includes('\r\n'),'user source keeps CRLF');
  assert.ok(artifact.slice(artifact.indexOf(headerLine)-2,artifact.indexOf(headerLine)).includes('\n'));
  assert.equal(derive().exit_version,'bridge-exit-v2');
  const at=artifact.indexOf('\n\n// Robot Trade bridge-exit-v');
  const crlf=artifact.slice(0,at)+'\n\n'+artifact.slice(at+2).replace(/\r?\n/g,'\r\n');
  assert.equal(crlf.includes(headerLine+'\r\n'),true);
  assert.equal(derive(crlf,rehash(crlf)).exit_version,'bridge-exit-v2');
});

test('instruction_versions.template label is ignored',()=>{
  assert.equal(versions.template,'bridge-exit-v3');
  const base={artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash};
  assert.deepEqual(derive(artifact,{...base,instruction_versions:{template:'bridge-exit-v9'}}),{ok:true,exit_version:'bridge-exit-v2'});
  assert.deepEqual(derive(artifact,base),{ok:true,exit_version:'bridge-exit-v2'});
});

test('a tampered byte or a wrong pinned hash is refused',()=>{
  refused(derive(artifact+' '),'ARTIFACT_HASH_MISMATCH');
  refused(derive(artifact.replace('plot(close)','plot(open)')),'ARTIFACT_HASH_MISMATCH');
  refused(derive(artifact,{...snapshot,artifact_hash:hash('other')}),'ARTIFACT_HASH_MISMATCH');
  refused(derive(artifact,{...snapshot,artifact_hash:snapshot.artifact_hash.toUpperCase()}),'ARTIFACT_HASH_MISMATCH');
});

test('header must appear exactly once',()=>{
  const missing=artifact.replace('// Robot Trade bridge-exit-v2.','// Robot Trade note.');
  refused(derive(missing,rehash(missing)),'SOURCE_HASH_MISMATCH');
  const doubled=artifact+'\n'+headerLine+'\n';
  refused(derive(doubled,rehash(doubled)),'EXIT_HEADER_DUPLICATE');
  const noDot=artifact.replace('// Robot Trade bridge-exit-v2.','// Robot Trade bridge-exit-v2 ');
  assert.notEqual(noDot,artifact);
  refused(derive(noDot,rehash(noDot)),'EXIT_HEADER_MISSING');
  const indented=artifact.replace(headerLine,'  '+headerLine);
  refused(derive(indented,rehash(indented)),'SOURCE_HASH_MISMATCH');
});

test('alert prefix must appear exactly once and name this deployment',()=>{
  const missing=artifact.replace(prefixText,'{\\"schema_version\\":\\"x\\"');
  refused(derive(missing,rehash(missing)),'ALERT_PREFIX_MISSING');
  const doubled=artifact+'\n// '+prefixText+'\n';
  refused(derive(doubled,rehash(doubled)),'ALERT_PREFIX_DUPLICATE');
  const foreignExtra=artifact+'\n// '+prefixText.replace(deployment.deployment_id,otherId)+'\n';
  refused(derive(foreignExtra,rehash(foreignExtra)),'ALERT_PREFIX_DUPLICATE');
  refused(derive(artifact,snapshot,otherId),'ALERT_PREFIX_DEPLOYMENT_MISMATCH');
  const renamed=artifact.replace(prefixText,prefixText.replace(deployment.deployment_id,otherId));
  refused(derive(renamed,rehash(renamed)),'ALERT_PREFIX_DEPLOYMENT_MISMATCH');
});

test('header and prefix versions must agree',()=>{
  const split=artifact.replace('\\"bridge-exit-v2\\"','\\"bridge-exit-v3\\"');
  assert.notEqual(split,artifact);
  refused(derive(split,rehash(split)),'EXIT_VERSION_DISAGREE');
});

test('an unknown version is refused even when header and prefix agree',()=>{
  for(const version of ['bridge-exit-v3','bridge-exit-v99','bridge-exit-vX']){
    const forged=artifact.replace('// Robot Trade bridge-exit-v2.','// Robot Trade '+version+'.').replace('\\"bridge-exit-v2\\"','\\"'+version+'\\"');
    assert.notEqual(forged,artifact);
    refused(derive(forged,rehash(forged)),'EXIT_VERSION_UNKNOWN');
  }
});

test('bad input is refused with a reason and never throws',()=>{
  for(const bad of [undefined,null,42,{},[],Buffer.from(artifact),'']){
    refused(deploymentExitVersion(bad,snapshot,deployment.deployment_id),'ARTIFACT_NOT_STRING');
  }
  for(const bad of [undefined,null,'',42,{}])refused(deploymentExitVersion(artifact,snapshot,bad),'DEPLOYMENT_ID_INVALID');
  for(const bad of [undefined,null,'text',[],42])refused(deploymentExitVersion(artifact,bad,deployment.deployment_id),'SNAPSHOT_MISSING');
  for(const bad of [undefined,null,'',42,{},hash]){
    refused(derive(artifact,{...snapshot,artifact_hash:bad}),'ARTIFACT_HASH_MISSING');
  }
  refused(derive(artifact,{}),'ARTIFACT_HASH_MISSING');
  const trap={get artifact_hash(){throw new Error('boom');}};
  refused(derive(artifact,trap),'EXIT_VERSION_UNDERIVABLE');
  assert.doesNotThrow(()=>deploymentExitVersion());
  refused(deploymentExitVersion(),'ARTIFACT_NOT_STRING');
});

test('derivation is deterministic and does not mutate its inputs',()=>{
  const frozenSnapshot=Object.freeze({...snapshot});
  assert.deepEqual(derive(artifact,frozenSnapshot),derive(artifact,frozenSnapshot));
  assert.equal(artifact,assemble(source,validateSelection(analysis,signals,[]),deployment).integrated_pine);
});

test('known exit versions are a subset of the contract schema versions',()=>{
  const contract=[SCHEMA_VERSION,LEGACY_SCHEMA_VERSION];
  for(const version of KNOWN_EXIT_VERSIONS)assert.ok(contract.includes(version),version);
  assert.equal(new Set(KNOWN_EXIT_VERSIONS).size,KNOWN_EXIT_VERSIONS.length);
});

test('a frozen real bridge-exit-v1 artifact derives bridge-exit-v1',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/pine-bridge-exit-v1/artifact.json',import.meta.url),'utf8'));
  const pinned={artifact_hash:fixture.artifact_hash,source_hash:fixture.source_hash};
  assert.equal(hash(fixture.artifact),fixture.artifact_hash);assert.equal(hash(fixture.source),fixture.source_hash);
  assert.ok(fixture.artifact.startsWith(fixture.source));
  assert.ok(fixture.artifact.includes('// Robot Trade bridge-exit-v1. DRAFT'));
  assert.deepEqual(derive(fixture.artifact,pinned,fixture.deployment_id),{ok:true,exit_version:'bridge-exit-v1'});
  refused(derive(fixture.artifact,pinned,otherId),'ALERT_PREFIX_DEPLOYMENT_MISMATCH');
});

test('source_hash is required and must match the text before the Bridge block',()=>{
  refused(derive(artifact,{artifact_hash:snapshot.artifact_hash}),'SOURCE_HASH_MISSING');
  for(const bad of [null,'',42,{}])refused(derive(artifact,{...snapshot,source_hash:bad}),'SOURCE_HASH_MISSING');
  refused(derive(artifact,{...snapshot,source_hash:hash('other')}),'SOURCE_HASH_MISMATCH');
  refused(derive(artifact,{...snapshot,source_hash:snapshot.source_hash.toUpperCase()}),'SOURCE_HASH_MISMATCH');
  refused(derive(artifact,{...snapshot,source_hash:hash(artifact)}),'SOURCE_HASH_MISMATCH');
});

test('a string that is not well formed is refused',()=>{
  for(const bad of ['\ud800','abc\udc00def',artifact+'\ud83d'])refused(deploymentExitVersion(bad,snapshot,deployment.deployment_id),'ARTIFACT_NOT_STRING');
});

test('header and prefix injected into user source do not change the derived version',()=>{
  const injections=[
    '// Robot Trade bridge-exit-v1. fake header\r\n',
    '// '+prefixOf('bridge-exit-v1',deployment.deployment_id)+'\r\n',
    '\n\n// Robot Trade bridge-exit-v1. fake block\r\n// '+prefixOf('bridge-exit-v1',otherId)+'\r\n',
    '// Robot Trade bridge-exit-v1. fake header\r\n// '+prefixOf('bridge-exit-v1',deployment.deployment_id)+'\r\n',
    '// Robot Trade bridge-exit-v2. fake header\r\n// '+prefixOf('bridge-exit-v2',deployment.deployment_id)+'\r\n'
  ];
  for(const injection of injections){
    const hostile=source+injection;
    const built=assemble(hostile,validateSelection(inspectSource(hostile),signals,[]),deployment);
    assert.ok(built.integrated_pine.includes(injection.trim().split('\r\n')[0]));
    const hostileSnapshot={artifact_hash:hash(built.integrated_pine),source_hash:built.source_hash};
    assert.deepEqual(derive(built.integrated_pine,hostileSnapshot),{ok:true,exit_version:'bridge-exit-v2'});
    refused(derive(built.integrated_pine,hostileSnapshot,otherId),'ALERT_PREFIX_DEPLOYMENT_MISMATCH');
  }
});

test('native trace artifacts are not Bridge artifacts and are refused',()=>{
  const fake='// Robot Trade bridge-exit-v2. fake header\r\n';
  const sources=[
    source,
    source+fake,
    source+'\n\n'+fake+'// '+prefixText+'\r\n',
    source+fake+'// '+prefixText+'\r\n'
  ];
  for(const text of sources){
    const built=assembleNativeTrace(text,inspectSource(text),{buy:'buy',exit:'sell'},deployment);
    const traceSnapshot={artifact_hash:hash(built.integrated_pine),source_hash:built.source_hash};
    refused(derive(built.integrated_pine,traceSnapshot),'SOURCE_HASH_MISMATCH');
  }
});
