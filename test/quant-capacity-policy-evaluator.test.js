import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCapacityPolicyEvaluator,validateQuantCapacityPolicy} from '../src/postgres/quant-capacity-policy.js';
import {pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';

// Binding A: PROFILE V2 enrollment and PREFLIGHT start only with a capacity policy written for the PF-2 evaluator
// of the running tree. The API side is covered in quant-preflight-wiring.test.js; this file covers the shared
// check and the worker entry point.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=letter=>letter.repeat(64);
const liveEvaluator=(await pf2ExecutableHashes()).evaluator_hash;

function stagingPolicy(evaluator){
  const {policy}=profileV2Fixture(600);
  policy.environment='staging';policy.scope.evaluator_hash=evaluator;
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
  return validateQuantCapacityPolicy(policy);
}

test('the shared check accepts only the exact evaluator identity of the running tree',()=>{
  const policy=stagingPolicy(liveEvaluator);
  assert.equal(assertCapacityPolicyEvaluator(policy,liveEvaluator),policy);
  for(const [scope,running] of [[sha('c'),liveEvaluator],[liveEvaluator,sha('c')],[liveEvaluator,liveEvaluator.toUpperCase()],
    [liveEvaluator,liveEvaluator+'0'],[liveEvaluator,''],[liveEvaluator,undefined],[liveEvaluator,null]])
    assert.throws(()=>assertCapacityPolicyEvaluator(stagingPolicy(scope),running),
      {code:'CAPACITY_POLICY_EVALUATOR_MISMATCH',status:503,message:'CAPACITY_POLICY_EVALUATOR_MISMATCH'});
  for(const broken of [undefined,null,{},{scope:null},{scope:{}}])
    assert.throws(()=>assertCapacityPolicyEvaluator(broken,liveEvaluator),{code:'CAPACITY_POLICY_EVALUATOR_MISMATCH'});
  // Two wrong values that agree with each other still refuse: the running value must be a real identity.
  assert.throws(()=>assertCapacityPolicyEvaluator({scope:{evaluator_hash:'x'}},'x'),{code:'CAPACITY_POLICY_EVALUATOR_MISMATCH'});
});

test('the worker entry point binds the policy to the live evaluator when enrollment or PREFLIGHT is on, before the database',()=>{
  // quant-research-main.js runs top-level side effects, so its wiring is also checked from source. Comments are
  // removed first, so a commented-out check cannot satisfy it.
  const code=readFileSync(path.join(root,'src/postgres/quant-research-main.js'),'utf8')
    .replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  assert.match(code,/import \{assertCapacityPolicyEvaluator,loadQuantCapacityPolicy\} from '\.\/quant-capacity-policy\.js';/);
  assert.match(code,/import \{pf2ExecutableHashes\} from '\.\.\/quant-research\/preflight-resolver\.js';/);
  const check=new RegExp(String.raw`const capacityPolicy=profileV2Enabled\|\|preflightEnabled\?await loadQuantCapacityPolicy\(\):undefined;\s*`+
    String.raw`if\(enrollmentEnabled\|\|preflightEnabled\)assertCapacityPolicyEvaluator\(capacityPolicy,\(await pf2ExecutableHashes\(\)\)\.evaluator_hash\);`).exec(code);
  assert.ok(check,'the check follows the policy load directly');
  assert.ok(check.index<code.indexOf('new PostgresDatabase('),'the check runs before any database work');
  // Enrollment implies PROFILE V2, so the policy is always loaded when the check runs.
  assert.match(code,/if\(enrollmentEnabled&&!profileV2Enabled\)throw /);
  assert.equal(code.match(/assertCapacityPolicyEvaluator\(/g).length,1);
});

/**
 * Runs the real worker entry point up to its first refusal. The labeled test loader replaces only the Linux file
 * trust rules of the policy loader. Every case stops before the database: a stale policy at the evaluator check,
 * any other case at the systemd worker-unit check that follows it.
 */
async function startWorker(t,{evaluator,environment={}}){
  const directory=mkdtempSync(path.join(os.tmpdir(),'eval-binding-worker-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const policyFile=path.join(directory,'policy.json');
  writeFileSync(policyFile,JSON.stringify(stagingPolicy(evaluator)));
  const loader=new URL('./helpers/quant-preflight-policy-loader.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--import',loader,path.join(root,'src/postgres/quant-research-main.js')],{
    stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_ENV:'test',PAPER_TRADING:'true',
      PUBLIC_ORIGIN:'http://127.0.0.1:9',DATABASE_URL:'postgres://fixture@127.0.0.1:9/unreachable',
      PINE_BRIDGE_ENV:'staging',QUANT_RESEARCH_ENABLED:'1',QUANT_RESEARCH_FOUNDATION_ENABLED:'1',
      QUANT_PROFILE_V2_ENABLED:'0',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',QUANT_PREFLIGHT_ENABLED:'1',
      QUANT_CAPACITY_POLICY_FILE:policyFile,QUANT_RECOVERY_POLICY_FILE:'',QUANT_WORKER_UNIT:'',
      PF2_HTTP_SYNTHETIC_SOURCE_HASH:'',...environment}});
  let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let timer;
  const code=await Promise.race([new Promise(done=>child.once('exit',done)),
    new Promise(done=>{timer=setTimeout(()=>{child.kill('SIGKILL');done('TIMEOUT');},60000);})]).finally(()=>clearTimeout(timer));
  return {code,output};
}
const LATER_REFUSAL=/RECOVERY_(?:LINUX|POLICY)_REQUIRED/;

test('the actual worker entry point refuses to start PREFLIGHT with a policy for another evaluator',async t=>{
  const stale=await startWorker(t,{evaluator:sha('c')});
  assert.notEqual(stale.code,0);assert.notEqual(stale.code,'TIMEOUT');
  assert.match(stale.output,/CAPACITY_POLICY_EVALUATOR_MISMATCH/);
  assert.doesNotMatch(stale.output,LATER_REFUSAL);
  const live=await startWorker(t,{evaluator:liveEvaluator});
  assert.notEqual(live.code,'TIMEOUT');
  assert.doesNotMatch(live.output,/CAPACITY_POLICY_EVALUATOR_MISMATCH/);
  assert.match(live.output,LATER_REFUSAL,'a matching policy passes the check and reaches the worker-unit check');
});

test('the actual worker entry point with enrollment and PREFLIGHT off never checks the evaluator',async t=>{
  const off=await startWorker(t,{evaluator:sha('c'),environment:{QUANT_PREFLIGHT_ENABLED:'0'}});
  assert.notEqual(off.code,'TIMEOUT');
  assert.doesNotMatch(off.output,/CAPACITY_POLICY_EVALUATOR_MISMATCH/);
  assert.match(off.output,LATER_REFUSAL);
});