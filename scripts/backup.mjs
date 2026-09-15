import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function backupDatabase(sourceFile,targetFile) {
const source=path.resolve(sourceFile),target=path.resolve(targetFile);
if(source===target||fs.existsSync(target))throw new Error('Backup destination must be a new file');
fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
fs.chmodSync(target,0o600);
const check=new DatabaseSync(target,{readOnly:true});
try {
  if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed');
} finally {check.close();}
return target;
}
if(process.argv[1]&&path.basename(process.argv[1])==='backup.mjs'){
  if(!process.argv[2])throw new Error('Usage: node scripts/backup.mjs /absolute/new-backup.db');
  console.log(`Verified backup: ${backupDatabase(process.env.DB_PATH||'data/astra-v2.db',process.argv[2])}`);
}
