import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const stages=['D','I','V','T'],credits=[1,4,3,2];
const gcd=(a,b)=>b?gcd(b,a%b):a;
const fraction=(n,d=1)=>{assert.ok(Number.isSafeInteger(n)&&Number.isSafeInteger(d)&&d>0);const g=gcd(Math.abs(n),d);return [n/g,d/g];};
const add=([a,b],[c,d])=>fraction(a*d+c*b,b*d);
const multiply=([a,b],[c,d])=>fraction(a*c,b*d);
const present=([n,d])=>({exact:`${n}/${d}`,value:n/d,roundedPercent:Math.round(n/d)});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fixed={project:[10,12,12,10,12,10,10,6,6,4,4,4],prototype:[15,15,20,20,20,10]};

export function calculate(inventory,scorecard){
  assert.equal(inventory.method,'PM-1');assert.equal(scorecard.method,'PM-1');
  assert.equal(scorecard.inventoryVersion,inventory.version);
  const rows=new Map();for(const row of scorecard.rows){assert.ok(!rows.has(row.id),`Duplicate ${row.id}`);rows.set(row.id,row);}
  const used=new Set(),result={};
  for(const [view,weights]of Object.entries(fixed)){
    const categories=inventory.views[view].categories;
    assert.deepEqual(categories.map(c=>c.weight),weights,`${view}: fixed weights changed`);
    let lower=fraction(0),upper=fraction(0),unknownWeight=fraction(0);const out=[];
    for(const [index,c]of categories.entries()){
      assert.equal(c.id,`${view==='project'?'F':'P'}${String(index+1).padStart(2,'0')}`);
      let shares=fraction(0),cl=fraction(0),cu=fraction(0);const details=[];
      for(const d of c.deliverables){
        assert.ok(!used.has(d.id),`Duplicate inventory ID ${d.id}`);used.add(d.id);
        const q=fraction(d.share.numerator,d.share.denominator);assert.ok(q[0]>0);shares=add(shares,q);
        const row=rows.get(d.id);assert.ok(row,`Missing ${d.id}`);assert.equal(row.view,view);assert.equal(row.category,c.id);
        assert.ok(row.evidenceRefs.length>0&&row.nextAction&&row.decision);
        for(const stage of stages){assert.ok([0,1,'UNKNOWN'].includes(row.credits[stage]),`${d.id} ${stage}`);assert.ok(row.rationale[stage]);}
        const possible=[];
        for(let mask=0;mask<16;mask++){
          const values=stages.map((_,i)=>(mask>>i)&1);
          if(values.some((v,i)=>row.credits[stages[i]]!=='UNKNOWN'&&row.credits[stages[i]]!==v))continue;
          if(values[1]>values[0]||values[2]>values[1]||values[3]>values[2])continue;
          possible.push(values.reduce((s,v,i)=>s+v*credits[i],0));
        }
        assert.ok(possible.length,`${d.id}: contradictory cumulative credits`);
        const weight=multiply(fraction(c.weight),q),lo=multiply(weight,fraction(Math.min(...possible),10)),hi=multiply(weight,fraction(Math.max(...possible),10));
        cl=add(cl,lo);cu=add(cu,hi);
        if(stages.some(s=>row.credits[s]==='UNKNOWN'))unknownWeight=add(unknownWeight,weight);
        details.push({id:d.id,weight:present(weight),lower:present(lo),upper:present(hi)});
      }
      assert.deepEqual(shares,[1,1],`${c.id}: shares must sum to one`);lower=add(lower,cl);upper=add(upper,cu);
      out.push({id:c.id,weight:c.weight,lower:present(cl),upper:present(cu),deliverables:details});
    }
    result[view]={lower:present(lower),upper:present(upper),unknownWeight:present(unknownWeight),singleScore:unknownWeight[0]===0,categories:out};
  }
  assert.equal(used.size,rows.size,'Extra scored rows');return result;
}

export function verifyEvidence(scorecard){
  const refs=new Set();for(const e of scorecard.evidence){
    assert.ok(!refs.has(e.id));refs.add(e.id);
    const bytes=e.commit?execFileSync('git',['show',`${e.commit}:${e.path}`],{maxBuffer:20*1024*1024}):fs.readFileSync(e.path);
    assert.equal(hash(bytes),e.sha256,`Evidence hash mismatch: ${e.id}`);
  }
  for(const row of scorecard.rows)for(const id of row.evidenceRefs)assert.ok(refs.has(id),`Missing evidence ${id}`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2];assert.ok(file,'Usage: node scripts/calculate-pm1-progress.mjs <scorecard.json>');
  const scorecard=JSON.parse(fs.readFileSync(file,'utf8')),bytes=fs.readFileSync(scorecard.inventoryPath);
  assert.equal(hash(bytes),scorecard.inventorySha256,'Frozen inventory hash mismatch');
  verifyEvidence(scorecard);const results=calculate(JSON.parse(bytes),scorecard);
  if(scorecard.results)assert.deepEqual(results,scorecard.results,'Stored totals differ from calculated totals');
  console.log(JSON.stringify({evidenceVerified:scorecard.evidence.length,rows:scorecard.rows.length,results},null,2));
}
