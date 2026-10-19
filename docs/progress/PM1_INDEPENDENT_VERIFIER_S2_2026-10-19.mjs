// PM-1 independent verifier for scorecard S2, 2026-10-19 (UTC).
// Copy of PM1_INDEPENDENT_VERIFIER_2026-10-15.mjs. Only the evidence pin rule changed: each evidence
// pin commit must be an ancestor of the declared sourceCommit (git merge-base --is-ancestor) instead of
// equal to it, and the matching PASS message says so. Why: S2 keeps the S1 pins at 7e6ccd1 by design
// (root ruling P1), so the S1 equality rule fails on S2. Arithmetic, hash, reference and gate checks
// are unchanged. Like the S1 verifier, it writes final-results.json beside itself.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {calculate,verifyEvidence} from '../../scripts/calculate-pm1-progress.mjs';

// Independent reference: BigInt rational arithmetic and the five legal cumulative states.
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const gcd=(a,b)=>b===0n?a:gcd(b,a%b);
const rat=(n,d=1n)=>{n=BigInt(n);d=BigInt(d);assert(d>0n);const g=gcd(n<0n?-n:n,d);return[n/g,d/g];};
const plus=(x,y)=>rat(x[0]*y[1]+y[0]*x[1],x[1]*y[1]);
const times=(x,y)=>rat(x[0]*y[0],x[1]*y[1]);
const exact=x=>`${x[0]}/${x[1]}`;
const zero=()=>rat(0);
const legal=[{D:0,I:0,V:0,T:0,s:0},{D:1,I:0,V:0,T:0,s:1},{D:1,I:1,V:0,T:0,s:5},{D:1,I:1,V:1,T:0,s:8},{D:1,I:1,V:1,T:1,s:10}];
const keys=['D','I','V','T'];
const weights={project:[10,12,12,10,12,10,10,6,6,4,4,4],prototype:[15,15,20,20,20,10]};
const inventoryPath='docs/progress/PM1_INVENTORY_V1_2026-10-15.json';
const inventoryBytes=fs.readFileSync(inventoryPath),inventory=JSON.parse(inventoryBytes);
const sourceHash=sha(fs.readFileSync('scripts/calculate-pm1-progress.mjs'));
const report={inventorySha256:sha(inventoryBytes),calculatorSha256:sourceHash,checks:[],limitations:['No product tests, PostgreSQL, browser, host or runtime-health checks.','Evidence hashes establish byte identity, not semantic applicability or root acceptance.']};
function expected(card){
  const allIds=new Set(), scored=new Map();
  assert.equal(card.method,'PM-1');assert.equal(card.inventoryVersion,inventory.version);
  for(const row of card.rows){assert(!scored.has(row.id));scored.set(row.id,row);}
  const out={};
  for(const [view,ws]of Object.entries(weights)){
    const categories=inventory.views[view].categories;
    assert.deepEqual(categories.map(c=>c.weight),ws);assert.equal(ws.reduce((a,b)=>a+b),100);
    let lower=zero(),upper=zero(),unknownWeight=zero();const catOut=[];
    for(const [ci,c]of categories.entries()){
      assert.equal(c.id,`${view==='project'?'F':'P'}${String(ci+1).padStart(2,'0')}`);
      let shares=zero(),lo=zero(),hi=zero();const rows=[];
      for(const d of c.deliverables){
        assert(!allIds.has(d.id));allIds.add(d.id);
        const row=scored.get(d.id);assert(row);assert.equal(row.view,view);assert.equal(row.category,c.id);
        const q=rat(d.share.numerator,d.share.denominator);assert(q[0]>0n);shares=plus(shares,q);
        const weight=times(rat(c.weight),q);
        keys.forEach(k=>assert([0,1,'UNKNOWN'].includes(row.credits[k])));
        const possible=legal.filter(s=>keys.every(k=>row.credits[k]==='UNKNOWN'||row.credits[k]===s[k]));assert(possible.length);
        const low=times(weight,rat(possible[0].s,10)),high=times(weight,rat(possible.at(-1).s,10));
        lo=plus(lo,low);hi=plus(hi,high);
        if(keys.some(k=>row.credits[k]==='UNKNOWN'))unknownWeight=plus(unknownWeight,weight);
        rows.push({id:d.id,weight:exact(weight),lower:exact(low),upper:exact(high)});
      }
      assert.equal(exact(shares),'1/1');lower=plus(lower,lo);upper=plus(upper,hi);
      catOut.push({id:c.id,lower:exact(lo),upper:exact(hi),rows});
    }
    out[view]={lower:exact(lower),upper:exact(upper),unknownWeight:exact(unknownWeight),singleScore:unknownWeight[0]===0n,categories:catOut};
  }
  assert.equal(allIds.size,scored.size);assert.equal(allIds.size,54);return out;
}
function compare(card,actual){
  const independent=expected(card);
  for(const [view,e]of Object.entries(independent)){
    const a=actual[view];
    for(const k of ['lower','upper','unknownWeight'])checkNumber(a[k],e[k]);
    assert.equal(a.singleScore,e.singleScore);
    for(const [i,c]of e.categories.entries()){
      const ac=a.categories[i];assert.equal(ac.id,c.id);checkNumber(ac.lower,c.lower);checkNumber(ac.upper,c.upper);
      for(const [j,r]of c.rows.entries()){
        const ar=ac.deliverables[j];assert.equal(ar.id,r.id);
        for(const k of ['weight','lower','upper'])checkNumber(ar[k],r[k]);
      }
    }
  }
  return independent;
}
function checkNumber(actual,wanted){
  assert.equal(actual.exact,wanted);const [n,d]=wanted.split('/').map(Number);
  assert.equal(actual.value,n/d);assert.equal(actual.roundedPercent,Math.floor(n/d+0.5));
}
const rows=Object.entries(inventory.views).flatMap(([view,v])=>v.categories.flatMap(c=>c.deliverables.map(d=>({id:d.id,view,category:c.id,credits:{D:1,I:1,V:1,T:1},rationale:{D:'isolated fixture',I:'isolated fixture',V:'isolated fixture',T:'isolated fixture'},evidenceRefs:['fixture'],nextAction:'none',decision:'fixture only'}))));
const base={method:'PM-1',inventoryVersion:inventory.version,rows};
compare(base,calculate(inventory,base));
let valid=0,rejected=0;
for(const D of [0,1,'UNKNOWN'])for(const I of [0,1,'UNKNOWN'])for(const V of [0,1,'UNKNOWN'])for(const T of [0,1,'UNKNOWN']){
  const card=structuredClone(base);card.rows[0].credits={D,I,V,T};
  const can=legal.some(s=>keys.every(k=>card.rows[0].credits[k]==='UNKNOWN'||card.rows[0].credits[k]===s[k]));
  if(can){compare(card,calculate(inventory,card));valid++;}else{assert.throws(()=>calculate(inventory,card),/contradictory/);rejected++;}
}
report.checks.push(`PASS: all 81 D/I/V/T combinations; ${valid} legal, ${rejected} rejected`);
const fractions=structuredClone(base);
fractions.rows.forEach((r,i)=>{const s=legal[i%legal.length];r.credits=Object.fromEntries(keys.map(k=>[k,s[k]]));});
compare(fractions,calculate(inventory,fractions));report.checks.push('PASS: mixed 54-row exact fractions and all categories');
for(const v of [0,'UNKNOWN']){
  const card=structuredClone(base);card.rows.forEach(r=>keys.forEach(k=>r.credits[k]=v));compare(card,calculate(inventory,card));
}
report.checks.push('PASS: all-zero and all-UNKNOWN totals, denominator and unknown weight');
for(const mutation of ['duplicate','missing','extra']){
  const card=structuredClone(base);
  if(mutation==='duplicate')card.rows.push(card.rows[0]);
  if(mutation==='missing')card.rows.pop();
  if(mutation==='extra')card.rows.push({...card.rows[0],id:'EXTRA'});
  assert.throws(()=>calculate(inventory,card));
}
report.checks.push('PASS: duplicate/missing/extra scored rows rejected');
const ev={id:'test-inventory',path:inventoryPath,sha256:sha(inventoryBytes)};
verifyEvidence({evidence:[ev],rows:[{evidenceRefs:[ev.id]}]});
assert.throws(()=>verifyEvidence({evidence:[{...ev,sha256:'0'.repeat(64)}],rows:[]}));
assert.throws(()=>verifyEvidence({evidence:[ev,ev],rows:[]}));
assert.throws(()=>verifyEvidence({evidence:[ev],rows:[{evidenceRefs:['missing']}]}));
report.checks.push('PASS: local evidence hash, bad hash, duplicate ID, dangling ref controls');
if(process.argv[2]){
  const cardPath=process.argv[2],bytes=fs.readFileSync(cardPath),card=JSON.parse(bytes);
  assert.equal(card.inventoryPath,inventoryPath);assert.equal(card.inventorySha256,sha(inventoryBytes));
  assert(card.results);report.scorecardPath=cardPath;report.scorecardSha256=sha(bytes);
  report.independentResults=compare(card,card.results);
  const seen=new Set();
  for(const ev of card.evidence){
    assert(!seen.has(ev.id));seen.add(ev.id);assert(/^[a-f0-9]{64}$/i.test(ev.sha256));
    assert(!ev.path.startsWith('/')&&!ev.path.includes('..')&&!ev.path.includes(':'));
    const content=ev.commit?execFileSync('git',['show',`${ev.commit}:${ev.path}`],{maxBuffer:25*1024*1024}):fs.readFileSync(ev.path);
    assert.equal(sha(content),ev.sha256,ev.id);
    if(ev.commit)assert.doesNotThrow(()=>execFileSync('git',['merge-base','--is-ancestor',ev.commit,card.sourceCommit],{stdio:'ignore'}),`Evidence pin ${ev.id} is not an ancestor of the declared snapshot`);
    else assert(ev.binding,'Local evidence lacks explicit binding');
  }
  card.rows.forEach(row=>{assert(row.evidenceRefs.length>0);row.evidenceRefs.forEach(id=>assert(seen.has(id)));});
  const manifest=new Map(card.evidence.map(e=>[e.id,e]));
  for(const gate of card.gates){
    assert.equal(gate.evidencePaths.length,gate.evidenceRefs.length);
    gate.evidenceRefs.forEach((id,i)=>assert.equal(manifest.get(id)?.path,gate.evidencePaths[i]));
  }
  report.checks.push(`PASS: final 54 rows, 18 category totals, both views, inventory pin, ${seen.size} evidence SHA256 pins and all evidence references`);
  report.checks.push(`PASS: ${card.gates.length} gate evidence path/reference bindings; every committed evidence pin is an ancestor of the declared source snapshot; local evidence explicitly bound`);
  report.limitations.push('E027 is ignored local evidence; hashes verify locally, but another checkout needs this retained artifact to reproduce verification.');
}
fs.writeFileSync(new URL(process.argv[2]?'final-results.json':'initial-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
