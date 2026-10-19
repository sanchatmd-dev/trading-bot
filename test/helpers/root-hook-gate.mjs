import {before as nodeBefore,after as nodeAfter} from 'node:test';

/**
 * PGX1 (history): `npm run test:postgres` used to run every PostgreSQL suite in one process (node --test --test-isolation=none).
 * Since 4d86822 it runs one process per file, and only test/postgres-isolation-none/ still shares one process. There a
 * top-level before() or after() of each file is a hook of the shared root test: every file's hook starts at the same moment,
 * and one failing root hook fails every test of the run, not only the tests of its own file. With about 40 suites each
 * creating, migrating and guarding its own database at once, the server reached max_connections and a CREATE DATABASE
 * passed the 15 s statement_timeout of PostgresDatabase, which failed the whole run.
 *
 * These drop-in replacements for before and after let at most ROOT_HOOK_LIMIT top-level hooks run at the same time in
 * one process. Each suite keeps its own hook, order and failure; only the start is queued. With per-file isolation every
 * file has its own process, so nothing waits. Four at once still overloaded a 100-connection server from a clean
 * checkout, so the hooks run one at a time; the whole run was faster that way, not slower.
 */
export const ROOT_HOOK_LIMIT=1;
let active=0;
const waiting=[];

async function acquire(){
  if(active<ROOT_HOOK_LIMIT){active++;return;}
  await new Promise(resolve=>waiting.push(resolve));
}
// A released slot passes straight to the next waiting hook, so the count only drops when no hook waits.
function release(){
  const next=waiting.shift();
  if(next)next();else active--;
}

export function gated(hook){
  return async function gatedHook(...args){
    await acquire();
    try{return await hook.apply(this,args);}finally{release();}
  };
}

export const before=(hook,options)=>nodeBefore(gated(hook),options);
export const after=(hook,options)=>nodeAfter(gated(hook),options);
