import {PostgresDatabase} from '../src/postgres/db.js';
import {exportPaperCapitalModel,inspectPaperCapitalModel,migratePaperCapitalModel,rollbackPaperCapitalModel} from '../src/postgres/paper-capital-model-migration.js';

// Offline only: stop the API, the trading worker and every research worker first. Never run on service start.
// --inspect is the exception: one READ ONLY transaction, no maintenance lock and no write, so it is safe beside running services.
// It may be combined with --runtime-role=NAME to check the runtime role's privilege boundary too (run it after the grant script).
// After an install, reapply scripts/grant-postgres-runtime.sql: this tool changes no grant.
// --rollback drops the extension only while the declaration table holds no row. The O12 rollback of a table that holds rows takes two steps:
//   1. --export=<new protected path>  one READ ONLY transaction (no maintenance lock, no write); writes the canonical JSON lines of every row to a NEW
//      file (exclusive create, mode 0600; an existing path is refused; a path inside the repository is refused except under .qa-local) and prints
//      only rows=<n> sha256=<h>. The file holds owner and Bot ids: keep it outside the repository; record the count and the digest only.
//   2. --rollback --confirm-rows=<n> --confirm-export-sha256=<h>  own transaction, maintenance lock, ACCESS EXCLUSIVE lock; recounts and recomputes
//      the digest from the live rows and drops only when both equal; any difference refuses with no change. Afterwards reapply the grant script.
const args=process.argv.slice(2);
const USAGE='Usage: node scripts/migrate-paper-capital-model.mjs [--runtime-role=NAME | --rollback [--confirm-rows=N --confirm-export-sha256=SHA256] | --inspect [--runtime-role=NAME] | --export=NEWFILE]';
const FORMS=[/^--rollback$/,/^--inspect$/,/^--runtime-role=[a-z_][a-z0-9_]{0,62}$/,/^--export=.+$/,/^--confirm-rows=(0|[1-9][0-9]{0,8})$/,/^--confirm-export-sha256=[0-9a-f]{64}$/];
const nameOf=arg=>arg.split('=')[0];
const valueOf=name=>args.find(arg=>nameOf(arg)===name)?.slice(name.length+1);
const rollback=args.includes('--rollback'),inspect=args.includes('--inspect');
const roleArg=valueOf('--runtime-role'),exportPath=valueOf('--export'),confirmRows=valueOf('--confirm-rows'),confirmSha=valueOf('--confirm-export-sha256');
const confirmed=confirmRows!==undefined||confirmSha!==undefined;
if(args.some(arg=>!FORMS.some(form=>form.test(arg)))||new Set(args.map(nameOf)).size!==args.length
  ||(rollback&&(roleArg||inspect||exportPath!==undefined))||(exportPath!==undefined&&(args.length!==1))
  ||(confirmed&&(!rollback||confirmRows===undefined||confirmSha===undefined)))throw Error(USAGE);
const runtimeRole=roleArg;
async function inspectReadOnly(db){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectPaperCapitalModel({query:(sql,params)=>client.query(sql,params)},{runtimeRole});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const db=new PostgresDatabase();
try{
  if(exportPath!==undefined){
    const report=await exportPaperCapitalModel(db,exportPath);
    console.log('rows='+report.rows+' sha256='+report.sha256);
  }else if(inspect){
    // Known states: ABSENT (nothing installed; only the "not installed" failures are allowed, so a bad runtime role still fails) and an
    // exact, complete INSTALLED. OTHER exits nonzero.
    const report=await inspectReadOnly(db);
    console.log(JSON.stringify(report,null,2));
    const {state}=report.facts;
    const known=state==='ABSENT'?report.failures.every(failure=>/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/.test(failure)):state==='INSTALLED'&&report.ok;
    process.exitCode=known?0:1;
  }else if(rollback){
    const report=await rollbackPaperCapitalModel(db,confirmed?{confirm:{rows:Number(confirmRows),sha256:confirmSha}}:{});
    console.log(report.previous_state==='ABSENT'?'Paper capital model not installed; no change'
      :'Paper capital model removed; previous state='+report.previous_state+(confirmed&&report.confirmed_rows!==undefined?'; confirmed rows='+report.confirmed_rows:'; no declaration row existed'));
  }
  else{
    const report=await migratePaperCapitalModel(db,{runtimeRole});
    console.log('Paper capital model ready: '+report.facts.marker+'; state='+report.facts.state+'; previous state='+report.previous_state+'; guards='+report.facts.guards.length+(roleArg?'; runtime role checked':'; runtime role not checked')+'; grants unchanged');
  }
}finally{await db.close();}
