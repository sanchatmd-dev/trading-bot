import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as records from '../src/portfolio/qr2-boundary-records.js';
import {buildBoundaryRegistry,boundaryRecordDefault,QR2_BOUNDARY_RECORDS,QR2_BOUNDARY_RECORD_DEFAULT} from '../src/portfolio/qr2-boundary-records.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED,validateBoundaryRecord} from '../src/portfolio/qr2-boundaries.js';

// QR-2 boundary record registry (contract 6.2; RC-Q46). Pure: no database. The shipped registry is empty in this slice, so the seam registries below
// are hand-built test data (never evidence, never under src). The route wiring against the real worker is in test/postgres/qr2-boundary-wiring.test.mjs.
const sourceOf=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const sha=text=>createHash('sha256').update(text).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const record=(over={})=>({record_id:'TEST_STAGING_E2',epochs:[{epoch:'E1',from:100,to:200},{epoch:'E2',from:200,to:null}],lot_fee_boundary:200,lot_table_boundary:300,evidence:'docs/evidence/test-record.json',...over});
const entry=(over={},environment='staging')=>({environment,record:record(over)});
const refused=(entries,pattern)=>assert.throws(()=>buildBoundaryRegistry(entries),e=>e.code==='QR2_BOUNDARY_REGISTRY_INVALID'&&pattern.test(e.message),pattern.source);

test('U1 the shipped registry is empty and the default is the identical UNRECORDED object',()=>{
  assert.equal(QR2_BOUNDARY_RECORDS.size,0);assert.deepEqual(QR2_BOUNDARY_RECORDS.list(),[]);
  assert.equal(QR2_BOUNDARY_RECORD_DEFAULT,QR2_BOUNDARY_RECORD_UNRECORDED,'same object, so every answer stays as before');
  assert.equal(boundaryRecordDefault(QR2_BOUNDARY_RECORDS),QR2_BOUNDARY_RECORD_UNRECORDED);
  assert.equal(boundaryRecordDefault(buildBoundaryRegistry([])),QR2_BOUNDARY_RECORD_UNRECORDED);
  assert.equal(Object.isFrozen(QR2_BOUNDARY_RECORD_DEFAULT),true);
  assert.deepEqual(Object.keys(records).sort(),['QR2_BOUNDARY_RECORDS','QR2_BOUNDARY_RECORD_DEFAULT','boundaryRecordDefault','buildBoundaryRegistry'],'no selector and no switch constant');
});

test('U2 registry refusals: bad record, id UNRECORDED, bad id shape, duplicate, environment other than staging, second record, bad entries',()=>{
  refused('x',/must be an array/);refused([null],/must be an object/);refused([[]],/must be an object/);assert.throws(()=>buildBoundaryRegistry([{environment:'staging'}]),e=>e.code==='QR2_BOUNDARY_RECORD_INVALID');
  // The record goes through validateBoundaryRecord: a bad evidence path, an overlap, and a missing evidence all stop the load.
  assert.throws(()=>buildBoundaryRegistry([entry({evidence:'/etc/passwd'})]),e=>e.code==='QR2_BOUNDARY_RECORD_INVALID');
  assert.throws(()=>buildBoundaryRegistry([entry({epochs:[{epoch:'E1',from:100,to:300},{epoch:'E2',from:200,to:null}]})]),e=>e.code==='QR2_BOUNDARY_RECORD_INVALID');
  assert.throws(()=>buildBoundaryRegistry([entry({evidence:null})]),e=>e.code==='QR2_BOUNDARY_RECORD_INVALID');
  refused([{environment:'staging',record:QR2_BOUNDARY_RECORD_UNRECORDED}],/UNRECORDED is the product default/);
  refused([entry({record_id:'UNRECORDED',epochs:[],lot_fee_boundary:null,lot_table_boundary:null,evidence:null})],/UNRECORDED is the product default/);
  for(const id of ['lower','Mixed','1START','HAS SPACE','HAS-DASH','HAS.DOT',' PADDED','TRAILING ','A'.repeat(65),'{}','docs/evidence/a.json'])refused([entry({record_id:id})],/outside the allowed shape/);
  refused([entry(),entry()],/duplicate record_id/);
  refused([entry({record_id:'SECOND_RECORD'}),entry()],/at most one record/);
  for(const environment of ['production','Staging','','dev',undefined,null,7])refused([{environment,record:record()}],/unknown environment/);
  assert.doesNotThrow(()=>buildBoundaryRegistry([entry({record_id:'A'.repeat(64)})]),'the longest id shape passes');
});

test('U2b the default helper ignores a registry entry for any environment but staging',()=>{
  const stub={list:()=>[{environment:'production',record:validateBoundaryRecord(record())}]};
  assert.equal(boundaryRecordDefault(stub),QR2_BOUNDARY_RECORD_UNRECORDED);
});

test('U3 a seam registry with one staging record: the default helper returns that frozen record, validated, not the product default',()=>{
  const input=record(),registry=buildBoundaryRegistry([{environment:'staging',record:input}]);
  assert.equal(registry.size,1);assert.equal(registry.has('TEST_STAGING_E2'),true);assert.equal(registry.has('UNRECORDED'),false);
  const chosen=boundaryRecordDefault(registry);
  assert.notEqual(chosen,QR2_BOUNDARY_RECORD_UNRECORDED);
  assert.equal(chosen,registry.get('TEST_STAGING_E2').record);
  assert.deepEqual(chosen,validateBoundaryRecord(input));
  assert.equal(Object.isFrozen(chosen),true);assert.equal(Object.isFrozen(chosen.epochs),true);assert.ok(chosen.epochs.every(Object.isFrozen));
  assert.equal(registry.get('TEST_STAGING_E2').environment,'staging');assert.equal(Object.hasOwn(chosen,'environment'),false,'the environment never enters the record');
  assert.equal(Object.isFrozen(registry),true);assert.equal(Object.isFrozen(registry.get('TEST_STAGING_E2')),true);
  // The registry holds a validated copy: editing the caller's input afterwards changes nothing.
  input.epochs[0].from=1;input.record_id='CHANGED';
  assert.equal(chosen.epochs[0].from,100);assert.equal(chosen.record_id,'TEST_STAGING_E2');
  assert.throws(()=>Object.assign(chosen,{record_id:'x'}),TypeError);
  // A digest as evidence is the other allowed form.
  assert.equal(boundaryRecordDefault(buildBoundaryRegistry([entry({evidence:'a'.repeat(64)})])).evidence,'a'.repeat(64));
});

test('U4 golden digest: every shipped record equals its reviewed sha256 (the table is empty today)',()=>{
  const GOLDEN={};
  assert.deepEqual(QR2_BOUNDARY_RECORDS.list().map(row=>row.record.record_id).sort(),Object.keys(GOLDEN).sort(),'a record in the registry needs its golden digest in the same reviewed diff');
  for(const {record:shipped} of QR2_BOUNDARY_RECORDS.list()){
    assert.equal(sha(canonical(shipped)),GOLDEN[shipped.record_id],shipped.record_id);
    assert.equal(Object.isFrozen(shipped),true);assert.equal(Object.isFrozen(shipped.epochs),true);assert.ok(shipped.epochs.every(Object.isFrozen));
  }
  // The digest function itself, on a literal: a changed boundary changes the digest.
  const a=buildBoundaryRegistry([entry()]).list()[0].record,b=buildBoundaryRegistry([entry({lot_fee_boundary:201})]).list()[0].record;
  assert.equal(sha(canonical(a)),sha(canonical(validateBoundaryRecord(record()))));assert.notEqual(sha(canonical(a)),sha(canonical(b)));
});

test('U5 purity: the module reads no process state, file, clock or network and imports only its two siblings',()=>{
  const source=sourceOf('../src/portfolio/qr2-boundary-records.js');
  const code=source.split(/\r?\n/).filter(line=>!/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
  for(const forbidden of [/\bprocess\b/,/node:/,/\bfs\b/,/\brequire\b/,/\bDate\b/,/\bperformance\b/,/\bfetch\b/,/\bMath\.random\b/,/\bimport\(/])assert.doesNotMatch(code,forbidden,String(forbidden));
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';/gm)].map(m=>m[1]).sort(),['./qr2-boundaries.js','./qr2-constants.js']);
  assert.doesNotMatch(source,/QR2_BOUNDARY_RECORD_SWITCH|selectBoundaryRecord|environment variable|\benv\b/i,'no switch, no selector, no environment wording');
});

test('S1 both QR-2 route modules default to QR2_BOUNDARY_RECORD_DEFAULT; server.js reads no selection and passes no boundaries',()=>{
  const routes=sourceOf('../src/postgres/qr2-routes.js'),owner=sourceOf('../src/postgres/qr2-owner-route.js'),server=sourceOf('../src/postgres/server.js');
  for(const source of [routes,owner]){
    assert.match(source,/^import \{QR2_BOUNDARY_RECORD_DEFAULT\} from '\.\.\/portfolio\/qr2-boundary-records\.js';\r?$/m);
    assert.match(source,/boundaries=QR2_BOUNDARY_RECORD_DEFAULT[,}]/);
    assert.doesNotMatch(source,/QR2_BOUNDARY_RECORD_UNRECORDED/,'a route default reverted to UNRECORDED would hide the registry');
  }
  assert.doesNotMatch(server,/QR2_BOUNDARY_RECORD/,'no environment key and no startup selection');
  assert.doesNotMatch(server,/boundar/i,'server.js passes no boundaries to either QR-2 route');
});
