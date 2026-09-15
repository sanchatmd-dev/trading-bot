import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// A separate SQLite lock is held for the process lifetime, not the trading DB.
// The OS releases the lock on a crash; never delete a lock file to bypass it.
export function acquireProcessLock(databasePath) {
  const filename=path.resolve(databasePath)+'.instance-lock';
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const lock=new DatabaseSync(filename);
  try {lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
  catch {lock.close();throw new Error('Another process owns this database; run only one bot instance');}
  return ()=>{lock.exec('ROLLBACK');lock.close();};
}
