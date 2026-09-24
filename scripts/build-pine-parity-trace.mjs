import fs from 'node:fs/promises';
import path from 'node:path';
import {PostgresDatabase} from '../src/postgres/db.js';
import {inspectSource} from '../src/pine-bridge/source.js';
import {assembleNativeTrace} from '../src/pine-bridge/template.js';

const [deploymentId,output]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(deploymentId||'')||!output)throw new Error('Usage: build-pine-parity-trace.mjs DEPLOYMENT_ID OUTPUT_FILE');
const privateRoot=path.resolve('.qa-local');
const target=path.resolve(output);
if(!target.startsWith(privateRoot+path.sep)||!target.endsWith('.pine'))throw new Error('Output must be a .pine file under .qa-local');
const db=new PostgresDatabase();
try {
  const deployment=await db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(deploymentId);
  if(!deployment||deployment.state!=='DRAFT')throw new Error('DRAFT deployment required');
  const source=await db.prepare('SELECT * FROM pine_source_revisions WHERE pine_import_id=? AND source_version=?').get(deployment.pine_import_id,deployment.source_version);
  if(!source||source.source_hash!==deployment.snapshot.source_hash)throw new Error('Source revision mismatch');
  const artifact=assembleNativeTrace(source.source,inspectSource(source.source),deployment.snapshot.selection.signals,deployment.snapshot.market);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,artifact.integrated_pine,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({deployment_id:deploymentId,source_hash:artifact.source_hash,trace_schema:artifact.trace_schema,changed_original_bytes:0,output:target}));
} finally {await db.close();}
