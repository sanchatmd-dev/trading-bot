import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createQuantPreflightApi} from '../src/postgres/quant-preflight-wiring.js';
import {pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';

// PF-2 proof gaps that need no database. R6-14: production code never gives QuantPreflightService a clock seam.
// The seam would let a caller move "now" and with it the current-minute bound on holdout boundaries and the
// freshness checks of the plan builder.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const liveEvaluator=(await pf2ExecutableHashes()).evaluator_hash;

function wiringOptions(){
  const {policy}=profileV2Fixture(600);
  policy.environment='staging';policy.scope.evaluator_hash=liveEvaluator;
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
  const raw={root:'fixture-root',inspect(){},read(){}};
  const researchStore={root:raw.root,storageBudget:{},raw,inspectSidecarV2(){},readV2(){}};
  const db={query:async sql=>{
    if(sql.includes('to_regclass'))return {rows:[{version_table:true,jobs_table:true,boundary_table:true}]};
    if(sql.includes('SELECT version'))return {rows:[{version:1}]};
    throw Error('Unexpected query');
  }};
  return {pineService:{db,authorize(){}},dataService:{datasetStore:raw,ready:async()=>{},scope(){}},researchStore,
    dataEnabled:true,paperTrading:true,environment:{PINE_BRIDGE_ENV:'staging',QUANT_RESEARCH_FOUNDATION_ENABLED:'1'},
    loadPolicy:async()=>policy,assertEnrollmentSchema:async()=>{}};
}

// A hostile clock offered through every option name a wiring change could plausibly add.
const HOSTILE_CLOCK=()=>0;
const offered=()=>({clock:HOSTILE_CLOCK,now:HOSTILE_CLOCK,clockOverride:HOSTILE_CLOCK});

for(const [label,environment] of [['PF-2 disabled',{}],['PF-2 enabled',{QUANT_PREFLIGHT_ENABLED:'1'}]])
  test('R6-14 API wiring ('+label+') builds QuantPreflightService on the wall clock and no test seam',async()=>{
    const options=wiringOptions();
    const value=await createQuantPreflightApi({...options,...offered(),environment:{...options.environment,...environment}});
    assert.equal(value.preflightEnabled,label==='PF-2 enabled');
    const service=value.preflightService;
    assert.equal(service.clock,Date.now,'the service clock is the platform wall clock');
    assert.notEqual(service.clock,HOSTILE_CLOCK);
    assert.ok(Math.abs(service.now()-Date.now())<5000,'now() follows the real clock');
    assert.equal(service.supportedSourceHash,undefined,'production keeps the compiled-in supported source hash');
    assert.equal(service.executableHashes,pf2ExecutableHashes,'production hashes the real PF-2 files');
  });

// --- static check of the worker entry point -----------------------------------------------------
// src/postgres/quant-research-main.js runs top-level side effects (production config, database, systemd), so it
// cannot be imported by a test. Its construction site is checked from source instead.

const BACKSLASH='\\';

/** Replaces the content of comments, strings and template text by spaces, keeping offsets and line breaks. */
function blankStringsAndComments(source){
  const chars=[...source],out=[...chars];
  const blankAt=index=>{if(out[index]!=='\n')out[index]=' ';};
  const modes=[{type:'code',depth:0}];
  let i=0;
  while(i<chars.length){
    const mode=modes.at(-1),c=chars[i],d=chars[i+1];
    if(mode.type==='code'){
      if(c==='/'&&d==='/'){while(i<chars.length&&chars[i]!=='\n'){blankAt(i);i++;}continue;}
      if(c==='/'&&d==='*'){
        blankAt(i);blankAt(i+1);i+=2;
        while(i<chars.length&&!(chars[i]==='*'&&chars[i+1]==='/')){blankAt(i);i++;}
        blankAt(i);blankAt(i+1);i+=2;continue;
      }
      if(c==="'"||c==='"'){
        i++;
        while(i<chars.length&&chars[i]!==c){if(chars[i]===BACKSLASH){blankAt(i);i++;}blankAt(i);i++;}
        i++;continue;
      }
      if(c==='`'){modes.push({type:'template',depth:0});i++;continue;}
      if(modes.length>1&&c==='{')mode.depth++;
      if(modes.length>1&&c==='}'){if(mode.depth===0){modes.pop();i++;continue;}mode.depth--;}
      i++;continue;
    }
    if(c===BACKSLASH){blankAt(i);blankAt(i+1);i+=2;continue;}
    if(c==='`'){modes.pop();i++;continue;}
    if(c==='$'&&d==='{'){blankAt(i);blankAt(i+1);i+=2;modes.push({type:'code',depth:0});continue;}
    blankAt(i);i++;
  }
  return out.join('');
}
function matching(code,open){
  let depth=0;
  for(let i=open;i<code.length;i++){
    if('([{'.includes(code[i]))depth++;
    else if(')]}'.includes(code[i])&&--depth===0)return i;
  }
  throw Error('unbalanced brackets in source');
}
/** Top-level keys of the one object literal passed to every `new className(...)` in the source. */
function constructorKeys(source,className){
  const code=blankStringsAndComments(source),sites=[];
  for(const match of code.matchAll(new RegExp('\\bnew\\s+'+className+'\\s*\\(','g'))){
    const open=match.index+match[0].length-1,argument=code.slice(open+1,matching(code,open)).trim();
    assert.equal(argument[0],'{','the constructor receives one object literal');
    const body=argument.slice(1,matching(argument,0)),parts=[];
    let depth=0,start=0;
    for(let i=0;i<body.length;i++){
      if('([{'.includes(body[i]))depth++;
      else if(')]}'.includes(body[i]))depth--;
      else if(body[i]===','&&depth===0){parts.push(body.slice(start,i));start=i+1;}
    }
    parts.push(body.slice(start));
    sites.push(parts.map(part=>part.trim()).filter(Boolean).map(part=>{
      if(part.startsWith('...'))return '[spread]';
      if(part[0]==='['||part[0]==="'"||part[0]==='"')return '[computed or quoted key]';
      return /^[A-Za-z_$][\w$]*/.exec(part)?.[0]??'[unreadable key]';
    }));
  }
  return sites;
}

const SEAMS=['clock','supportedSourceHash','executableHashes'];
const readSource=file=>readFileSync(path.join(root,file),'utf8');

test('R6-14 static scanner finds clock seams, spreads and computed keys (self check of the source reader)',()=>{
  const sample=readSource('src/postgres/quant-preflight-wiring.js').replace('enabled:preflightEnabled}','enabled:preflightEnabled,clock:()=>1}');
  assert.ok(constructorKeys(sample,'QuantPreflightService')[0].includes('clock'));
  const spread="const a=new QuantPreflightService({pineService,...extra,['clo'+'ck']:1,'x':2,enabled:true}); // new QuantPreflightService({clock:1})";
  assert.deepEqual(constructorKeys(spread,'QuantPreflightService'),
    [['pineService','[spread]','[computed or quoted key]','[computed or quoted key]','enabled']]);
  const text="const note='new QuantPreflightService({clock:1})'; /* new QuantPreflightService({clock:1}) */";
  assert.deepEqual(constructorKeys(text,'QuantPreflightService'),[]);
});

test('R6-14 production construction sites pass no clock, source-hash or executable-hash seam',()=>{
  const sites=new Map();
  for(const entry of readdirSync(path.join(root,'src'),{recursive:true})){
    if(!/\.(?:js|mjs)$/.test(entry))continue;
    const file='src/'+entry.split(path.sep).join('/'),keys=constructorKeys(readSource(file),'QuantPreflightService');
    if(keys.length)sites.set(file,keys);
  }
  // A new construction site must be reviewed for the same rule, so the list is pinned.
  assert.deepEqual([...sites.keys()].sort(),['src/postgres/quant-preflight-wiring.js','src/postgres/quant-research-main.js']);
  for(const [file,literals] of sites){
    assert.equal(literals.length,1,file+' constructs the service once');
    const [keys]=literals;
    for(const required of ['pineService','dataService','capacityPolicy','enabled'])
      assert.ok(keys.includes(required),file+' passes '+required);
    for(const seam of SEAMS)assert.equal(keys.includes(seam),false,file+' must not pass '+seam);
    assert.deepEqual(keys.filter(key=>key.startsWith('[')),[],file+' passes only plain named options');
  }
});
