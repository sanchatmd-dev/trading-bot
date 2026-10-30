import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as records from '../src/portfolio/qr2-boundary-records.js';
import {buildBoundaryRegistry,boundaryRecordDefault,QR2_BOUNDARY_RECORDS,QR2_BOUNDARY_RECORD_DEFAULT} from '../src/portfolio/qr2-boundary-records.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED,validateBoundaryRecord} from '../src/portfolio/qr2-boundaries.js';
import {epochOfFill} from '../src/portfolio/qr2-replay.js';

// QR-2 boundary record registry (contract 6.2; RC-Q46). Pure: no database. The shipped registry holds one staging record (the values slice); the seam
// registries below are hand-built test data (never evidence, never under src). The route wiring against the real worker is in
// test/postgres/qr2-boundary-wiring.test.mjs and test/postgres/qr2-boundary-server.test.mjs.
const SHIPPED_ID='STAGING_QL_P2_PROTOTYPE_20261030';
const sourceOf=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const sha=text=>createHash('sha256').update(text).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const record=(over={})=>({record_id:'TEST_STAGING_E2',epochs:[{epoch:'E1',from:100,to:200},{epoch:'E2',from:200,to:null}],lot_fee_boundary:200,lot_table_boundary:300,evidence:'docs/evidence/test-record.json',...over});
const entry=(over={},environment='staging')=>({environment,record:record(over)});
const refused=(entries,pattern)=>assert.throws(()=>buildBoundaryRegistry(entries),e=>e.code==='QR2_BOUNDARY_REGISTRY_INVALID'&&pattern.test(e.message),pattern.source);

test('U1 the shipped registry holds one staging record and the default is that identical record, not UNRECORDED',()=>{
  assert.equal(QR2_BOUNDARY_RECORDS.size,1);assert.equal(QR2_BOUNDARY_RECORDS.has(SHIPPED_ID),true);
  const [row]=QR2_BOUNDARY_RECORDS.list();
  assert.equal(row.environment,'staging');assert.equal(row.record.record_id,SHIPPED_ID);
  assert.equal(QR2_BOUNDARY_RECORD_DEFAULT,row.record,'same object: the default is the registry record');
  assert.notEqual(QR2_BOUNDARY_RECORD_DEFAULT,QR2_BOUNDARY_RECORD_UNRECORDED);
  assert.equal(boundaryRecordDefault(QR2_BOUNDARY_RECORDS),row.record);
  assert.equal(boundaryRecordDefault(buildBoundaryRegistry([])),QR2_BOUNDARY_RECORD_UNRECORDED,'an empty registry still gives the identical UNRECORDED object');
  assert.equal(Object.isFrozen(QR2_BOUNDARY_RECORD_DEFAULT),true);
  assert.deepEqual(Object.keys(records).sort(),['QR2_BOUNDARY_RECORDS','QR2_BOUNDARY_RECORD_DEFAULT','boundaryRecordDefault','buildBoundaryRegistry'],'no selector and no switch constant');
});

test('U1b the shipped record: epoch order, open E2, null lot boundaries, evidence form, and the epoch of fills at the edges',()=>{
  const shipped=QR2_BOUNDARY_RECORD_DEFAULT;
  assert.deepEqual(shipped.epochs.map(row=>row.epoch),['E0','E1','E2']);
  assert.equal(shipped.epochs[0].from,Date.parse('2026-10-01T16:16:00.000Z'));
  assert.equal(shipped.epochs[2].to,null,'the last row is open, so a fresh fill is E2');
  assert.equal(shipped.epochs[1].to,shipped.epochs[2].from,'E1 and E2 share one edge');
  assert.ok(shipped.epochs[0].to<shipped.epochs[1].from,'the worker switch window is a gap, not an epoch');
  assert.equal(shipped.lot_fee_boundary,null);assert.equal(shipped.lot_table_boundary,null);
  assert.match(shipped.evidence,/^docs\/evidence\/S6_QR2_BOUNDARY_READ_1_A01_RESULT_2026-10-30\.json$/);
  const at=text=>epochOfFill(Date.parse(text),shipped.epochs);
  assert.equal(at('2026-10-01T16:15:59.999Z'),null,'before the E0 start');
  assert.equal(at('2026-10-01T16:16:00.000Z'),'E0');
  assert.equal(at('2026-10-03T12:02:02.172Z'),'E0','the first fill of the P2 Bot');
  assert.equal(at('2026-10-14T22:17:41.151Z'),'E0');
  assert.equal(at('2026-10-14T22:17:41.152Z'),null,'inside the switch window');
  assert.equal(at('2026-10-14T22:17:53.399Z'),null);
  assert.equal(at('2026-10-14T22:17:53.400Z'),'E1');
  assert.equal(at('2026-10-20T00:00:00.000Z'),'E1');
  assert.equal(at('2026-10-26T04:49:37.824Z'),'E1');
  assert.equal(at('2026-10-26T04:49:37.825Z'),'E2');
  assert.equal(at('2026-12-31T00:00:00.000Z'),'E2');
  // The registry-level check of the same record in a hand-built registry: the shipped values pass the validator unchanged.
  assert.deepEqual(validateBoundaryRecord(shipped),shipped);
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

test('U4 golden digest: every shipped record equals its reviewed sha256',()=>{
  // Regenerate with the canonical function above on the validated record; the value changes when the evidence path or any boundary changes.
  const GOLDEN={STAGING_QL_P2_PROTOTYPE_20261030:'254a730f361c5d5ba0dfc1cebbc4aad37802643ababd474c1e2eb586512b987f'};
  assert.deepEqual(QR2_BOUNDARY_RECORDS.list().map(row=>row.record.record_id).sort(),Object.keys(GOLDEN).sort(),'a record in the registry needs its golden digest in the same reviewed diff');
  for(const {record:shipped} of QR2_BOUNDARY_RECORDS.list()){
    assert.equal(sha(canonical(shipped)),GOLDEN[shipped.record_id],shipped.record_id);
    assert.equal(Object.isFrozen(shipped),true);assert.equal(Object.isFrozen(shipped.epochs),true);assert.ok(shipped.epochs.every(Object.isFrozen));
  }
  // The digest function itself, on a literal: a changed boundary changes the digest.
  const a=buildBoundaryRegistry([entry()]).list()[0].record,b=buildBoundaryRegistry([entry({lot_fee_boundary:201})]).list()[0].record;
  assert.equal(sha(canonical(a)),sha(canonical(validateBoundaryRecord(record()))));assert.notEqual(sha(canonical(a)),sha(canonical(b)));
});

test('U4b the evidence file the shipped record cites is tracked in the repository, parses, and is a passed boundary read',()=>{
  const evidence=JSON.parse(fs.readFileSync(new URL('../'+QR2_BOUNDARY_RECORD_DEFAULT.evidence,import.meta.url),'utf8'));
  assert.equal(evidence.packetId,'S6-QR2-BOUNDARY-READ-1');assert.equal(evidence.attemptId,'a01');assert.equal(evidence.verdict,'BR_PASS');assert.equal(evidence.code,null);
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
