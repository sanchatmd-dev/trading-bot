import fs from 'node:fs/promises';
import {PostgresDatabase} from '../src/postgres/db.js';
import {validateEvidence} from '../src/postgres/pine-bridge-readiness.js';
import {hash,canonical} from '../src/pine-bridge/source.js';

const [id,file]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(id||'')||!file)throw new Error('Usage: record-pine-bridge-evidence.mjs DEPLOYMENT_ID REVIEWED_EVIDENCE_JSON');
const evidence=JSON.parse(await fs.readFile(file,'utf8')),db=new PostgresDatabase();
try{
  await db.transaction(async()=>{
    await db.maintenanceLock();
    const row=await db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? FOR UPDATE').get(id);
    if(!row||row.state!=='DRAFT')throw new Error('Evidence requires an existing DRAFT deployment');
    validateEvidence(evidence,row.snapshot_hash);
    if(evidence.artifact_hash!==row.snapshot.artifact_hash||evidence.source_hash!==row.snapshot.source_hash)throw new Error('Evidence source/artifact mismatch');
    await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(id,row.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),Date.now());
  });
  console.log('Evidence recorded; owner activation remains a separate action');
}finally{await db.close();}
