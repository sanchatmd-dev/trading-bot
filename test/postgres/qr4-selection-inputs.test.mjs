import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr4World,newOwner,seedSet,seedBars,seedRunWithPackage,seedExport,registerViaStore,requestOf,testContext,readBotState,counts,tableDigest,sha,
  SCOPE,POLICY_HASH,POLICY_VERSION,ENGINE,BASE,DAY,MS,MARKET,OBJECTIVE_ID,TEST_REGISTRY,UTC,SELECTION_TABLES} from '../helpers/qr4-selection-fixture.mjs';
import {readSelectionInputs,readPackageState,labelOfGates,UNIVERSE_CAP,TERMINAL_RUN_STATUSES} from '../../src/postgres/selection-inputs.js';
import {registerSelection,readSelection} from '../../src/postgres/selection-store.js';
import {productionDependencies} from '../../src/postgres/qr4-routes.js';
import {QuantLibraryService} from '../../src/postgres/quant-library.js';
import {readState} from '../../src/quant-library/package-gates.js';
import {evaluateEligibility} from '../../src/selection/eligibility.js';
import {digest} from '../../src/selection/codes.js';
import {RULES,T0,MINUTE,hex} from '../helpers/quant-library-fixture.mjs';

// QR-4 slice Q4-B: the selection inputs reader on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repository grants. Every row is a LABELLED FIXTURE.
// The reader runs in a READ ONLY snapshot (it writes nothing); a registration over it uses the store writer with an injected TEST registry and injected dependencies, which is a
// store-level path only (a route never passes either). One file per process.
let world;
before(async()=>{world=await createQr4World();});
after(async()=>{await world?.close();});

/** The reader in a READ ONLY REPEATABLE READ transaction on the runtime role: a write would fail loudly. */
const read=(owner,{fixture=true,policy=POLICY_HASH,ports={},at=BASE}={})=>world.rt.transaction(async()=>{
  await world.rt.query('SET TRANSACTION READ ONLY');
  return readSelectionInputs(world.rt,{owner_id:owner.id,registered_at_ms:at,fixture,policy_hash:policy},{readBotState,...ports});
},{isolation:'REPEATABLE READ'});
const DECLARED_SCOPE={...SCOPE,valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const eligibility=(owner,member,fixture=true)=>evaluateEligibility(member,{owner_id:owner.id,requester_owner_id:owner.id,scope:DECLARED_SCOPE,fixture});
const stateOf=(owner,member)=>readState({status:member.package.status,binding:member.package.binding,current:member.package.current,replay_mismatch:false,requester_owner_id:owner.id});

test('the universe of a fixture selection: one member per terminal run in creation order, with every field the eligibility checks read',async()=>{
  const owner=await newOwner(world,'q4-uni'),set=await seedSet(world,owner,{n:3,fixture:true});
  const {universe,context}=await read(owner);
  assert.equal(universe.length,3);
  const order=[...universe].sort((a,b)=>a.created_at_ms-b.created_at_ms||(a.run_id<b.run_id?-1:1)).map(item=>item.run_id);
  assert.deepEqual(universe.map(item=>item.run_id),order,'creation order, then run id');
  assert.deepEqual(universe.map(item=>item.run_id).sort(),set.map(item=>item.runId).sort());
  for(const member of universe){
    const seeded=set.find(item=>item.runId===member.run_id);
    assert.deepEqual([member.kind,member.owner_id,member.run_status,member.source_hash,member.export_id],['RESEARCH_RUN',owner.id,'SUCCEEDED',seeded.sourceHash,seeded.export.exportId]);
    assert.deepEqual(member.market,MARKET);
    // E1: the gates come from the library detail read; G8 never passes (QL4C_VALIDATION_NOT_AVAILABLE), so the label is DEVELOPMENT_ONLY and the integrity gate G1 passes
    assert.deepEqual([member.qualification.version,member.qualification.label,member.qualification.qualified,member.integrity_checked],['library-qualification-v2','DEVELOPMENT_ONLY',false,true]);
    assert.deepEqual(member.qualification.gates.map(item=>item.gate),['G1','G2','G3','G4','G5','G6','G7','G8']);
    assert.deepEqual(member.qualification.gates[7],{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'});
    // E2: the stored export, its last status event and the live state
    assert.deepEqual([member.package.export_id,member.package.status,member.package.package_hash,member.package.replay_mismatch],[seeded.export.exportId,'EXPORT_VALIDATED',seeded.export.packageHash,false]);
    assert.deepEqual(member.package.binding,seeded.export.binding);
    assert.deepEqual([member.package.current.dataset_available,member.package.current.bot_owner_id,member.package.current.deployment_id,member.package.current.membership.length],[true,owner.id,seeded.deployment,1]);
    const state=stateOf(owner,member);
    assert.deepEqual([state.fresh,state.state,state.ready],[true,'FRESH',false],'a fixture package is fresh and never READY');
    // E3: the validation record verbatim
    assert.equal(member.validation_records.length,1);
    assert.deepEqual([member.validation_records[0].mode,member.validation_records[0].record.fixture,member.validation_records[0].record.export_id,member.validation_records[0].record.package_hash,
      member.validation_records[0].record.binding_hash,member.validation_records[0].record.validated_at_utc],['ONE_PINE',true,seeded.export.exportId,seeded.export.packageHash,seeded.export.bindingHash,UTC]);
    // E5: the scope the fixed evaluation admission compares
    assert.deepEqual(member.scope,{data_model:SCOPE.data_model,cost_model:SCOPE.cost_model,capital:SCOPE.capital,policy:SCOPE.policy});
    assert.deepEqual(member.rules,RULES);assert.equal(member.rules_hash,digest(RULES));
    assert.deepEqual(member.data_windows,{dataset:{start_ms:T0,end_ms:T0+20*MINUTE},train:{start_ms:T0,end_ms:T0+13*MINUTE},validation:{start_ms:T0+13*MINUTE,end_ms:T0+16*MINUTE},holdout:{start_ms:T0+16*MINUTE,end_ms:T0+20*MINUTE}});
    assert.equal(member.registered_boundary_ms,null,'the boundary table exists and holds no row for the Bot');
    // the pure eligibility accepts every member of a fixture selection, and refuses it in a customer selection (E6 flipped)
    const fixtureResult=eligibility(owner,member,true);
    assert.deepEqual([fixtureResult.eligible,fixtureResult.status,fixtureResult.code],[true,'PARTICIPANT',null],JSON.stringify(fixtureResult.failures));
    assert.deepEqual(fixtureResult.validation_binding,{export_id:seeded.export.exportId,package_hash:seeded.export.packageHash,validated_at_utc:UTC});
    const customerResult=eligibility(owner,member,false);
    assert.equal(customerResult.eligible,false);assert.equal(customerResult.failures.some(item=>item.check==='E6'&&item.code==='QR4_FIXTURE_PARTICIPANT'),true);
  }
  assert.deepEqual(context,{policy_snapshot:{policy_hash:POLICY_HASH,max_drawdown_percent:null},universe_cap:UNIVERSE_CAP});
  assert.equal(Object.hasOwn(context,'objective_registry')||Object.hasOwn(context,'dependencies')||Object.hasOwn(context,'requester_owner_id'),false,'the reader returns no registry, no dependency fact and no requester');
});

test('which runs are in the universe: terminal research runs of the owner on the required market; no evaluation run, no other owner, no running run; fixture runs only in a fixture selection',async()=>{
  const owner=await newOwner(world,'q4-which'),stranger=await newOwner(world,'q4-which-x');
  const digestOfBars=await seedBars(world);
  const labelled=await seedRunWithPackage(world,owner,{tag:'lab',labelled:true,digest:digestOfBars,package:false});
  const plain=await seedRunWithPackage(world,owner,{tag:'plain',package:false});
  await seedRunWithPackage(world,stranger,{tag:'other',package:false});
  const failed=await seedRunWithPackage(world,owner,{tag:'failed',scenario:'NO_VALID',package:false});
  // rows written outside the documented path: an evaluation run (FIXED_INPUT_EVAL), a non-terminal run and a run on another market
  const insert=async(id,status,contract)=>world.db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,[id,owner.id,plain.deployment,'idem-'+id,hex('s'),hex('c'),JSON.stringify(contract),status,T0+9_000_000,T0+9_900_000]);
  const market=MARKET;
  await insert('run-eval-'+sha('e'),'SUCCEEDED',{mode:'FIXED_INPUT_EVAL',snapshot:{market},source_hash:plain.sourceHash,dataset:{start_time:T0},split:{train_end:5,validation_end:8,test_end:10}});
  await insert('run-queued-'+sha('q'),'QUEUED',{snapshot:{market},source_hash:plain.sourceHash,dataset:{start_time:T0},split:{train_end:5,validation_end:8,test_end:10}});
  await insert('run-other-market-'+sha('m'),'SUCCEEDED',{snapshot:{market:{...market,symbol:'ETHUSDT'}},source_hash:plain.sourceHash,dataset:{start_time:T0},split:{train_end:5,validation_end:8,test_end:10}});
  const customer=await read(owner,{fixture:false}),fixture=await read(owner,{fixture:true});
  assert.deepEqual(customer.universe.map(item=>item.run_id).sort(),[plain.runId,failed.runId].sort(),'a customer selection leaves out the labelled fixture run');
  assert.deepEqual(fixture.universe.map(item=>item.run_id).sort(),[labelled.runId,plain.runId,failed.runId].sort());
  assert.deepEqual([...TERMINAL_RUN_STATUSES],['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
  // a member without a package has no package object and no export id (the eligibility reports PACKAGE_MISSING); its qualification is still the detail-level read
  const member=customer.universe.find(item=>item.run_id===plain.runId);
  assert.deepEqual([member.package,member.export_id,member.validation_records],[null,null,[]]);
  assert.equal(member.qualification.label,'DEVELOPMENT_ONLY');
  const noValid=customer.universe.find(item=>item.run_id===failed.runId);
  assert.deepEqual([noValid.run_status,noValid.qualification.label,noValid.library_class],['NO_VALID_CANDIDATE','NO_SCREENED_CANDIDATE','NO_VALID_CANDIDATE']);
  const result=eligibility(owner,member,false);
  assert.deepEqual([result.eligible,result.status],[false,'EXCLUDED']);
  assert.equal(result.failures.find(item=>item.check==='E2').detail,'PACKAGE_MISSING');
});

test('a run whose snapshot.market has the production shape (deployment keys beside the three market fields) is a universe member with E4 PASS; the member keeps the raw market object',async()=>{
  const owner=await newOwner(world,'q4-prodmarket'),digestOfBars=await seedBars(world);
  const seeded=await seedRunWithPackage(world,owner,{tag:'prod',labelled:true,digest:digestOfBars,package:{fixture:true},
    mutateContract:contract=>{contract.snapshot.market={deployment_id:contract.deployment_id??'d-1',pine_import_id:'i-1',source_version:1,...contract.snapshot.market};}});
  const {universe}=await read(owner);
  assert.deepEqual(universe.map(item=>item.run_id),[seeded.runId],'the run is a member');
  const member=universe[0];
  assert.deepEqual(Object.keys(member.market).sort(),['broker','deployment_id','pine_import_id','source_version','symbol','timeframe']);
  const result=eligibility(owner,member,true);
  assert.equal(result.failures.some(item=>item.check==='E4'),false,'E4 passes: '+JSON.stringify(result.failures));
  assert.deepEqual([result.eligible,result.status],[true,'PARTICIPANT']);
});

test('the library label rule is pinned against the library detail view for every scenario (and against an integrity failure)',async()=>{
  const owner=await newOwner(world,'q4-label');
  const cases=[['PENDING',{}],['NO_VALID',{}],['ROBUSTNESS',{}],['HOLDOUT_FEW',{}],['HOLDOUT_NEGATIVE',{}],['PENDING',{badContractHash:true}]];
  const labels=new Set();
  for(const [scenario,options] of cases){
    const seeded=await seedRunWithPackage(world,owner,{tag:'l-'+scenario+'-'+(options.badContractHash?'bad':'ok'),scenario,package:false,...options});
    const detail=await new QuantLibraryService(world.db).detail(owner.id,seeded.runId);
    const {universe}=await read(owner,{fixture:false});
    const member=universe.find(item=>item.run_id===seeded.runId);
    assert.equal(member.qualification.label,detail.qualification.label,scenario);
    assert.equal(member.qualification.qualified,detail.qualification.qualified,scenario);
    assert.equal(labelOfGates(detail.qualification.gates),detail.qualification.label,scenario);
    assert.deepEqual(member.qualification.gates.map(item=>[item.gate,item.state,item.code]),detail.qualification.gates.map(item=>[item.gate,item.state,item.code??null]),scenario);
    assert.equal(member.integrity_checked,detail.qualification.gates[0].state==='PASS');
    labels.add(detail.qualification.label);
    if(options.badContractHash){
      assert.equal(detail.qualification.gates[0].state,'FAIL');assert.equal(member.integrity_checked,false,'a failed integrity check is never an integrity_checked member');
    }
  }
  assert.ok(labels.size>=3,'the cases cover several labels: '+[...labels].join(','));
});

test('eligibility on real rows (16.1 items 12 to 14): development-only run, no package, fixture in a customer selection, candidate and refused packages, a record without the C gates, a multi-Pine package',async()=>{
  const owner=await newOwner(world,'q4-elig'),digest_=await seedBars(world);
  const run=(tag,pack,options={})=>seedRunWithPackage(world,owner,{tag,digest:digest_,package:pack,...options});
  const runs={
    dev:await run('dev',false),
    ready:await run('ready',{fixture:false}),
    fixtureInCustomer:await run('fix',{fixture:true}),
    candidate:await run('cand',{fixture:false,finish:'EXPORT_CANDIDATE'}),
    refused:await run('ref',{fixture:false,finish:'EXPORT_REFUSED'}),
    noGates:await run('nogate',{fixture:false,validationGates:[]}),
    multi:await run('multi',{fixture:false,mode:'MULTI_PINE',finish:'EXPORT_INTERNAL'})};
  const {universe}=await read(owner,{fixture:false});
  const by=name=>universe.find(item=>item.run_id===runs[name].runId);
  const check=name=>eligibility(owner,by(name),false);
  // an injected READY package of a customer run: READY holds, and the library says DEVELOPMENT_ONLY (the blockers and G8)
  const ready=by('ready');
  assert.deepEqual([stateOf(owner,ready).ready,stateOf(owner,ready).fresh],[true,true]);
  const readyResult=check('ready');
  assert.deepEqual([readyResult.eligible,readyResult.code,readyResult.checks.E2,readyResult.checks.E3,readyResult.checks.E6],[false,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE','PASS','PASS','PASS']);
  assert.equal(readyResult.failures[0].detail,'ACCEPTANCE_BLOCKERS_PRESENT','the first failing gate code is copied exactly (G6 fails before G8 for these runs)');
  assert.deepEqual(ready.qualification.gates[7],{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'});
  assert.equal(check('dev').failures.find(item=>item.check==='E2').detail,'PACKAGE_MISSING');
  assert.equal(check('fixtureInCustomer').failures.find(item=>item.check==='E6').code,'QR4_FIXTURE_PARTICIPANT');
  assert.deepEqual([by('candidate').package.status,by('candidate').package.current,check('candidate').failures.find(item=>item.check==='E2').detail],['EXPORT_CANDIDATE',null,'EXPORT_CANDIDATE']);
  assert.deepEqual([by('refused').package.status,check('refused').failures.find(item=>item.check==='E2').detail],['EXPORT_REFUSED','EXPORT_REFUSED']);
  // E3: a validation record whose gate results do not pass C1 to C4 does not make G8 PASS, so the binding is not found
  assert.deepEqual([check('noGates').checks.E3,check('noGates').failures.find(item=>item.check==='E3').code,check('noGates').failures.find(item=>item.check==='E3').detail],['FAIL','QR4_VALIDATION_BINDING_MISMATCH','G8_RECORD_MISSING']);
  // a multi-Pine package is never a participant and its package state is not validated
  assert.deepEqual([by('multi').package.binding.mode,check('multi').code],['MULTI_PINE','QR4_MULTI_PINE_PARTICIPANT']);
  // every member of a customer universe is excluded today: no READY package qualifies while G8 has no source (16.1 item 14)
  assert.equal(universe.every(item=>eligibility(owner,item,false).eligible===false),true);
});

test('registration over real rows: no eligible participant is refused first; production dependencies refuse QR4_QR3_CONTEXT_UNAVAILABLE; the product registry refuses TIE_TOLERANCES_NOT_SET; nothing is written',async()=>{
  const customer=await newOwner(world,'q4-reg-c'),fixtureOwner=await newOwner(world,'q4-reg-f');
  await seedRunWithPackage(world,customer,{tag:'c1',package:{fixture:false}});await seedRunWithPackage(world,customer,{tag:'c2',package:{fixture:false}});
  await seedSet(world,fixtureOwner,{n:3,fixture:true});
  const before=await counts(world.db);
  // customer selection: RC-S15 first row; every member excluded with its first failing code
  const none=await registerViaStore(world,customer,{fixture:false,startDays:11});
  assert.deepEqual([none.ok,none.code],[false,'QR4_NO_ELIGIBLE_PARTICIPANT']);
  assert.equal(none.universe.length,2);assert.ok(none.universe.every(item=>item.eligible===false&&item.code==='QR4_DEVELOPMENT_SCORE_NOT_RANKABLE'));
  assert.equal(none.universe.every(item=>item.checks.E2==='PASS'&&item.checks.E3==='PASS'),true,'READY packages with a bound validation record: G8 is the only blocker');
  // production context (V8 hold, evaluation mode off, no episode gate) with an eligible fixture set
  const v8=await registerSelection(world.rt,{request:requestOf(fixtureOwner,{startDays:12}),context:testContext(fixtureOwner,{dependencies:productionDependencies(undefined)}),
    readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture:true,policy_hash:POLICY_HASH},{readBotState})});
  assert.deepEqual([v8.ok,v8.code,v8.detail],[false,'QR4_QR3_CONTEXT_UNAVAILABLE','QR3_VALUATION_AND_BENCHMARK']);
  // with the dependency facts true but the PRODUCT registry (no injected registry): the tolerances are null
  const registry=await registerSelection(world.rt,{request:requestOf(fixtureOwner,{startDays:13}),
    context:{...testContext(fixtureOwner),objective_registry:undefined},readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture:true,policy_hash:POLICY_HASH},{readBotState})});
  assert.deepEqual([registry.ok,registry.code,registry.detail],[false,'QR4_OBJECTIVE_UNKNOWN','TIE_TOLERANCES_NOT_SET']);
  // a fixture request without the server flag
  const flagOff=await registerSelection(world.rt,{request:requestOf(fixtureOwner,{startDays:14}),context:testContext(fixtureOwner,{fixture_selections_allowed:false}),
    readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture:true,policy_hash:POLICY_HASH},{readBotState})});
  assert.deepEqual([flagOff.code,flagOff.detail],['QR4_FIXTURE_PARTICIPANT','FIXTURE_SELECTION_NOT_ALLOWED']);
  assert.deepEqual(await counts(world.db),before,'every refusal wrote nothing');
  // the injected TEST registry with every fact true is the store-level path that registers
  const ok=await registerViaStore(world,fixtureOwner,{startDays:15});
  assert.equal(ok.ok,true,JSON.stringify(ok));
  assert.equal(ok.registration.participant_count,3);
  assert.deepEqual(ok.registration.scope.policy,SCOPE.policy);
  assert.equal(ok.registration.scope.policy_max_drawdown_percent,null);
  const stored=await readSelection(world.rt,{owner_id:fixtureOwner.id,selection_id:ok.selection_id});
  assert.equal(stored.ok,true);
  // the stored universe holds one row per run, with the first failing code of each; the participants copy validated_at_utc verbatim (RC-S28)
  assert.equal(stored.selection.universe.length,3);
  assert.ok(stored.selection.participants.every(item=>item.validated_at_utc===UTC));
});

test('registered thresholds win (16.1 item 15), adversarial request keys are refused (item 18), and the policy snapshot is accepted only for a verified policy hash (RR-Q4-20)',async()=>{
  const owner=await newOwner(world,'q4-rules');await seedSet(world,owner,{n:2,fixture:true});
  const before=await counts(world.db);
  const weaker=await registerViaStore(world,owner,{startDays:20,over:{filters:{drawdown_limit_percent:'25',episode_floor:5,beats_buy_and_hold:false}}});
  assert.deepEqual([weaker.code,weaker.detail],['QR4_FILTER_INVALID','FILTER_DRAWDOWN_LIMIT_WEAKER_THAN_RULES']);
  const weights=await registerViaStore(world,owner,{startDays:21,over:{weights:{a:1}}});
  assert.equal(weights.code,'QR4_CUSTOM_WEIGHTS_REFUSED');
  // a declared policy hash that no parent run carries
  const other=hex('some other policy');
  const unknown=await registerSelection(world.rt,{request:requestOf(owner,{startDays:22,over:{scope:{...requestOf(owner).scope,policy:{policy_version:POLICY_VERSION,policy_hash:other}}}}),context:testContext(owner),
    readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture:true,policy_hash:other},{readBotState})});
  assert.deepEqual([unknown.code,unknown.detail],['QR4_FILTER_INVALID','POLICY_SNAPSHOT_UNREADABLE']);
  // the reader reports the same fact directly
  assert.equal((await read(owner,{policy:other})).context.policy_snapshot,null);
  assert.equal((await read(owner,{policy:null})).context.policy_snapshot,null);
  assert.deepEqual((await read(owner)).context.policy_snapshot,{policy_hash:POLICY_HASH,max_drawdown_percent:null});
  // a stored policy object that no longer hashes to the snapshot hash is unreadable, even though the hash text is the declared one
  const tampered=await newOwner(world,'q4-tamper');
  await seedRunWithPackage(world,tampered,{tag:'t1',labelled:true,package:false,mutateContract:contract=>{contract.snapshot.policy.extra='changed';}});
  assert.equal((await read(tampered)).context.policy_snapshot,null);
  assert.deepEqual(await counts(world.db),before);
});

test('the universe cap (RR-Q4-12) refuses a larger universe and never truncates it',async()=>{
  const owner=await newOwner(world,'q4-cap');await seedSet(world,owner,{n:4,fixture:true});
  const small=await read(owner,{ports:{universeCap:3}});
  assert.equal(small.universe.length,4,'cap plus one bare members: the registration refuses on the count');
  assert.ok(small.universe.every(item=>Object.keys(item).sort().join()==='kind,owner_id,run_id'),'bare members carry no package or library fact');
  assert.deepEqual(small.context,{policy_snapshot:{policy_hash:POLICY_HASH,max_drawdown_percent:null},universe_cap:3},'the scope check comes before the cap, so the snapshot is still read');
  const refused=await registerSelection(world.rt,{request:requestOf(owner,{startDays:30}),context:testContext(owner),
    readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture:true,policy_hash:POLICY_HASH},{readBotState,universeCap:3})});
  assert.deepEqual([refused.ok,refused.code,refused.detail],[false,'QR4_UNIVERSE_TOO_LARGE','4']);
  const exact=await read(owner,{ports:{universeCap:4}});
  assert.equal(exact.universe.length,4);assert.ok(exact.universe.every(item=>typeof item.qualification==='object'));
  assert.equal(exact.context.universe_cap,4);
  assert.equal((await read(owner)).context.universe_cap,50);
});

test('freshness is read from the live state: a missing Bot policy port, a changed policy, a disconnected source and a changed deployment each make the package stale',async()=>{
  const owner=await newOwner(world,'q4-fresh'),set=await seedSet(world,owner,{n:4,fixture:true});
  const fresh=async(ports,index)=>{
    const {universe}=await read(owner,{ports});
    const member=universe.find(item=>item.run_id===set[index].runId);
    return {member,state:stateOf(owner,member)};
  };
  assert.equal((await fresh({},0)).state.fresh,true);
  // without the Bot policy port the live policy hash is unknown: not fresh
  const noPort=await fresh({readBotState:null},0);
  assert.deepEqual([noPort.state.fresh,noPort.state.code],[false,'BI_POLICY_SNAPSHOT_MISMATCH']);
  const changed=await fresh({readBotState:async()=>({policy_hash:hex('another policy')})},0);
  assert.deepEqual([changed.state.fresh,changed.state.code],[false,'BI_POLICY_SNAPSHOT_MISMATCH']);
  await world.db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[set[1].importId]);
  const disconnected=await fresh({},1);
  assert.deepEqual([disconnected.state.fresh,disconnected.state.code,disconnected.state.codes.includes('BI_MEMBERSHIP_CHANGED')],[false,'BI_SOURCE_VERSION_STALE',true]);
  await world.db.query("UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1",[set[2].deployment,hex('re-deployed')]);
  const deployed=await fresh({},2);
  assert.deepEqual([deployed.state.fresh,deployed.state.codes.includes('BI_DEPLOYMENT_CHANGED'),deployed.member.package.current.deployment_id],[false,true,null]);
  // a stale validated package of a QUALIFIED-looking run is listed (QUALIFIED_STALE needs E1; here the fixture check reports E2 with the freshness code)
  const result=eligibility(owner,disconnected.member,true);
  assert.deepEqual([result.eligible,result.checks.E2,result.failures[0].detail],[false,'FAIL','BI_SOURCE_VERSION_STALE']);
  // the untouched package stays fresh
  assert.equal((await fresh({},3)).state.fresh,true);
});

test('readPackageState: an own validated package is READY only when it is not a fixture; a foreign, absent or malformed id is not found',async()=>{
  const owner=await newOwner(world,'q4-pkg'),stranger=await newOwner(world,'q4-pkg-x');
  const digest_=await seedBars(world);
  const real=await seedRunWithPackage(world,owner,{tag:'real',digest:digest_,package:{fixture:false}});
  const fixture=await seedRunWithPackage(world,owner,{tag:'fix',digest:digest_,labelled:true,package:{fixture:true}});
  const inTx=(who,id,ports={readBotState})=>world.rt.transaction(async()=>{await world.rt.query('SET TRANSACTION READ ONLY');return readPackageState(world.rt,{owner_id:who.id,export_id:id},ports);},{isolation:'REPEATABLE READ'});
  const ready=await inTx(owner,real.export.exportId);
  assert.deepEqual([ready.ok,ready.state.ready,ready.state.fresh,ready.package.status],[true,true,true,'EXPORT_VALIDATED']);
  const notReady=await inTx(owner,fixture.export.exportId);
  assert.deepEqual([notReady.ok,notReady.state.ready,notReady.state.fresh],[true,false,true]);
  const noPort=await inTx(owner,real.export.exportId,{});
  assert.deepEqual([noPort.state.ready,noPort.state.code],[false,'BI_POLICY_SNAPSHOT_MISMATCH']);
  assert.deepEqual(await inTx(stranger,real.export.exportId),{ok:false});
  assert.deepEqual(await inTx(owner,'ffffffff-ffff-4fff-8fff-ffffffffffff'),{ok:false});
  assert.deepEqual(await inTx(owner,'not-an-id'),{ok:false});
});

test('the reader writes nothing: every statement is a read, it runs inside SET TRANSACTION READ ONLY and no table changes',async()=>{
  const owner=await newOwner(world,'q4-ro');await seedSet(world,owner,{n:3,fixture:true});
  const tables=['quant_jobs','quant_job_steps','bi_exports','bi_status_events','ql4c_validation','pine_deployments','pine_memberships','quant_exposure_register','audit',...SELECTION_TABLES];
  const before=await Promise.all(tables.map(table=>tableDigest(world.db,table)));
  const statements=[];
  const spy=new Proxy(world.rt,{get(object,property){
    if(property==='query')return async(sql,params)=>{statements.push(String(sql).replace(/\s+/g,' ').trim());return object.query(sql,params);};
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  const out=await world.rt.transaction(async()=>{
    await world.rt.query('SET TRANSACTION READ ONLY');
    return readSelectionInputs(spy,{owner_id:owner.id,registered_at_ms:BASE,fixture:true,policy_hash:POLICY_HASH},{readBotState});
  },{isolation:'REPEATABLE READ'});
  assert.equal(out.universe.length,3);
  assert.ok(statements.length>10);
  assert.ok(statements.every(text=>/^(SELECT|WITH)\b/i.test(text)),statements.filter(text=>!/^(SELECT|WITH)\b/i.test(text)).join(' | '));
  assert.deepEqual(await Promise.all(tables.map(table=>tableDigest(world.db,table))),before);
});

test('two concurrent registrations with the same key give one row and one idempotent reply; two different ones give prior counts 0 and 1 (16.2 item 3)',async()=>{
  const owner=await newOwner(world,'q4-conc'),other=await newOwner(world,'q4-conc-2');
  await seedSet(world,owner,{n:3,fixture:true});await seedSet(world,other,{n:3,fixture:true});
  const same=await Promise.all([registerViaStore(world,owner,{startDays:40}),registerViaStore(world,owner,{startDays:40})]);
  assert.deepEqual(same.filter(item=>item.ok).length,1,JSON.stringify(same.map(item=>[item.ok,item.code])));
  const repeat=same.find(item=>!item.ok),first=same.find(item=>item.ok);
  assert.deepEqual([repeat.code,repeat.selection_id],['QR4_SELECTION_EXISTS',first.selection_id]);
  assert.equal((await world.db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE owner_id=$1',[owner.id])).rows[0].n,1);
  const different=await Promise.all([registerViaStore(world,other,{startDays:41}),registerViaStore(world,other,{startDays:42})]);
  assert.deepEqual(different.map(item=>item.ok),[true,true],JSON.stringify(different.map(item=>[item.ok,item.code])));
  assert.deepEqual(different.map(item=>item.registration.prior_selection_count).sort(),[0,1]);
});

test('read cost on a cap-sized universe is recorded for RO-6 (RR-Q4-12); a registration over it finishes inside the 50 s bound',async()=>{
  const owner=await newOwner(world,'q4-cost'),digest_=await seedBars(world);
  const started=Date.now();
  await seedSet(world,owner,{n:4,fixture:true});
  for(let index=0;index<UNIVERSE_CAP-4;index++)await seedRunWithPackage(world,owner,{tag:'p'+index+'-'+hex(String(index)).slice(0,5),labelled:true,digest:digest_,package:false});
  const seedMs=Date.now()-started;
  const samples=[];
  for(let index=0;index<12;index++){
    const t=process.hrtime.bigint();
    const {universe}=await read(owner);
    samples.push(Number(process.hrtime.bigint()-t)/1e6);
    assert.equal(universe.length,UNIVERSE_CAP);
  }
  samples.sort((a,b)=>a-b);
  const p=quantile=>samples[Math.min(samples.length-1,Math.ceil(quantile*samples.length)-1)];
  const record={runs:UNIVERSE_CAP,packages:4,samples:samples.length,read_ms:{min:Math.round(samples[0]),p50:Math.round(p(.5)),p95:Math.round(p(.95)),max:Math.round(samples[samples.length-1])},seed_ms:seedMs};
  console.log('RO6_UNIVERSE_READ '+JSON.stringify(record));
  assert.ok(record.read_ms.p95<25000,'the read stays well inside the 50 s registration bound: '+JSON.stringify(record));
  const t=process.hrtime.bigint();
  const registered=await registerViaStore(world,owner,{startDays:50});
  const registerMs=Number(process.hrtime.bigint()-t)/1e6;
  console.log('RO6_REGISTRATION '+JSON.stringify({universe:UNIVERSE_CAP,participants:4,ms:Math.round(registerMs)}));
  assert.equal(registered.ok,true,JSON.stringify(registered));
  assert.equal(registered.registration.universe.length,UNIVERSE_CAP);
  assert.ok(registerMs<50000);
  // one run more is over the cap: refused, nothing truncated
  await seedRunWithPackage(world,owner,{tag:'over',labelled:true,digest:digest_,package:false});
  const over=await registerViaStore(world,owner,{startDays:51});
  assert.deepEqual([over.ok,over.code,over.detail],[false,'QR4_UNIVERSE_TOO_LARGE',String(UNIVERSE_CAP+1)]);
});

test('static: the reader module keeps to reads, its SQL names only public tables, and the eligibility member shape is the one the S1 module documents',async()=>{
  const source=await fs.readFile(new URL('../../src/postgres/selection-inputs.js',import.meta.url),'utf8');
  const sql=[...source.matchAll(/(?:FROM|JOIN)\s+([a-z_.]+)/g)].map(match=>match[1]).filter(name=>name.includes('.')||name.startsWith('quant_')||name.startsWith('bi_'));
  assert.ok(sql.length>8);
  assert.ok(sql.every(name=>name.startsWith('public.')),sql.filter(name=>!name.startsWith('public.')).join());
  assert.doesNotMatch(source,/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|TRUNCATE\s|CREATE\s+(TABLE|FUNCTION|INDEX)|ALTER\s+TABLE|DROP\s+(TABLE|FUNCTION))/);
});
