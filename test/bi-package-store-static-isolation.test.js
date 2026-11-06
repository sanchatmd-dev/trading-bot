import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PREFLIGHT_HOLDOUT_SCOPE} from '../src/postgres/quant-preflight.js';
import {PACKAGE_TABLES} from '../src/postgres/best-inputs-package-migration.js';
import {WRITTEN_TABLES,BOUNDARY_SCOPE,EARLIER_ONE_PINE_SQL,EFFECTIVE_BOUNDARY_SQL,EARLIER_SEARCHED_ONE_PINE_SQL,PACKAGE_STORE_CODES,MAX_PACKAGE_BYTES,PACKAGE_STORE_MAX_RETRIES,PACKAGE_STORE_MAX_WAITERS} from '../src/postgres/bi-package-store.js';

// F09-01 stage I (L7, root rulings SB176): the static half of the isolation proof of the one-Pine fixture build and attempt service (src/postgres/bi-package-store.js). No PostgreSQL, no network.
// It mirrors test/mp-package-store-static-isolation.test.js. Claims:
//  1. No file of src, scripts, the web client, the Python engine or the container and service definitions imports or names the module; the test files are not product code.
//  2. The import closure of every runtime root (HTTP servers, workers, background entry points, package scripts, container commands) never reaches the module.
//  3. The module imports only an exact allowlist and no engine module: none of the research execution, foundation, preflight, profile, selection, comparison or multi-Pine modules, and
//     not the multi-Pine package store (whose own isolation test pins its importers).
//  4. The module writes only the ten package tables with INSERT, never edits or removes a row, never labels a row non-fixture and never reports READY true.
//  5. The copied SQL is the SQL of its sources, the module codes are never gate codes, and the limits are the ruled ones.
const root=fileURLToPath(new URL('../',import.meta.url));
const MODULE='src/postgres/bi-package-store.js';
const NAME_RE=/bi-package-store|BiFixturePackageService/i;

// The exact relative modules the service may import (and node:crypto). Every other import fails this test until the allowlist changes on purpose.
const ALLOWED_IMPORTS=['../pine-bridge/source.js','../pine-bridge/exit-version.js','../quant-research/contract.js','../quant-library/derive.js','../quant-library/package-gates.js',
  '../quant-library/package-render.js','../quant-library/trace-reproduction.js','./best-inputs-package-migration.js','./exposure-register.js','./pf4-risk-proposals.js'];
// Roots and families that must stay unreachable from the module by a direct import (the allowlist is exact; this list documents why it is).
const FORBIDDEN_DIRECT=[/quant-research\.js$/,/quant-research-worker\.js$/,/quant-research-main\.js$/,/quant-research-foundation\.js$/,/quant-foundation-/,/quant-fixed-eval/,/quant-preflight/,/quant-profile/,
  /selection-store\.js$/,/comparison-store\.js$/,/server\.js$/,/worker-main\.js$/,/mp-package-store/,/mp-run-store/,/mp-member-set/,/multi-pine\//];
const OTHER_ROOTS=['public','quant_lab','Dockerfile','Caddyfile','compose.yaml','compose.postgres.yaml','.deploy/astra-trade-phase2.service','.deploy/astra-trade-quant.service',
  '.deploy/astra-trade-worker.service','.deploy/robot-postgres.service','.github'];

function git(...args){
  try{return execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});}
  catch(error){if(error.status===1)return '';throw error;}
}
// Tracked and untracked (not ignored) files: the module is judged before it is committed too.
const listed=(...paths)=>git('ls-files','--cached','--others','--exclude-standard','--',...paths).split('\n').filter(Boolean);
const moduleText=readFileSync(path.join(root,MODULE),'utf8');

/* ---- the import-closure scanner (pure; exercised below against synthetic sources, then against the repository) ---- */

const EDGE=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g;
const URL_EDGE=/new\s+URL\(\s*['"](\.[^'"]*\.(?:m?js|cjs))['"]\s*,\s*import\.meta\.url\s*\)/g;
const COMPUTED_IMPORT=/\bimport\s*\(\s*(?!['"])/g;
function resolveSpecifier(from,specifier,exists){
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),specifier));
  for(const candidate of [base,base+'.js',base+'.mjs',base+'/index.js'])if(exists(candidate))return candidate;
  return null;
}
function edgesOf(file,source,exists){
  const targets=[],unresolved=[];
  for(const pattern of [EDGE,URL_EDGE]){
    for(const match of source.matchAll(pattern)){
      const target=resolveSpecifier(file,match[1],exists);
      if(target===null)unresolved.push(file+' -> '+match[1]);else targets.push(target);
    }
  }
  return {targets,unresolved};
}
function closureOf(roots,read,exists){
  const visited=new Set(),unresolved=[],computed=[],queue=[...roots];
  while(queue.length){
    const file=queue.shift();
    if(visited.has(file))continue;
    visited.add(file);
    const source=read(file);
    if(!/\.(?:js|mjs|cjs)$/.test(file))continue;
    if(COMPUTED_IMPORT.test(source))computed.push(file);
    COMPUTED_IMPORT.lastIndex=0;
    const edges=edgesOf(file,source,exists);
    unresolved.push(...edges.unresolved);
    queue.push(...edges.targets);
  }
  return {visited,unresolved,computed};
}
const ENTRY=/(?:src|scripts)\/[A-Za-z0-9_\-./]+\.(?:m?js|cjs)/g;
const entriesIn=texts=>{const out=new Set();for(const text of texts)for(const match of text.matchAll(ENTRY))out.add(match[0]);return out;};
const cache=new Map();
const diskRead=file=>{if(!cache.has(file))cache.set(file,readFileSync(path.join(root,file),'utf8'));return cache.get(file);};
const existsCached=(()=>{const memo=new Map();return file=>{if(!memo.has(file)){let found=false;try{found=statSync(path.join(root,file)).isFile();}catch{found=false;}memo.set(file,found);}return memo.get(file);};})();
/** The module without its comment lines, so a rule about code cannot be satisfied or broken by a comment. */
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');

test('self-test: the scanner follows static, dynamic literal, require and new URL edges and flags a computed dynamic import; the name match is case-insensitive',()=>{
  const files={'src/root.js':"import a from './a.js';const x=await import('./dyn.js');const w=new URL('./worker.js',import.meta.url);",'src/a.js':"import b from './deep/b';",
    'src/deep/b.js':"import store from '../postgres/bi-package-store.js';",'src/dyn.js':"const y=require('./cjs.js');",'src/cjs.js':'','src/worker.js':'import(name);','src/postgres/bi-package-store.js':'export const z=1;'};
  const exists=file=>Object.hasOwn(files,file);
  const result=closureOf(['src/root.js'],file=>files[file],exists);
  assert.ok(result.visited.has('src/postgres/bi-package-store.js'),'a transitive extensionless import reaches the module');
  assert.deepEqual(result.computed,['src/worker.js']);
  assert.deepEqual(closureOf(['src/m.js'],()=> "import './gone.js';",()=>false).unresolved,['src/m.js -> ./gone.js']);
  assert.ok(!closureOf(['src/root.js'],file=>files[file],file=>exists(file)&&file!=='src/postgres/bi-package-store.js').visited.has('src/postgres/bi-package-store.js'));
  assert.ok(NAME_RE.test('Import X from ./BI-Package-Store.js')&&NAME_RE.test('new BiFixturePackageService({})'));
  assert.deepEqual(edgesOf('src/postgres/x.js',"import {a} from './bi-package-store';",file=>file===MODULE).targets,[MODULE],'a renamed spelling of the same file is still caught');
  assert.equal(stripComments("// ready: true\nconst a=1;/* fixture:false */").includes('true'),false);
});

/* ---- 1. nothing imports or names the module ---- */

test('no file of src, scripts, the web client, the Python engine or the container and service definitions imports or names the service (tests are not product code)',()=>{
  const files=listed('src','scripts').filter(file=>/\.(?:js|mjs|cjs)$/.test(file));
  assert.ok(files.length>200&&files.includes(MODULE),'the scan sees the source tree and the module');
  const importers=files.filter(file=>edgesOf(file,diskRead(file),existsCached).targets.includes(MODULE));
  assert.deepEqual(importers,[],'importers of the module');
  const naming=listed('src','scripts').filter(file=>file!==MODULE&&NAME_RE.test(diskRead(file)));
  assert.deepEqual(naming,[],'files that name the service');
  const outside=listed(...OTHER_ROOTS.filter(item=>git('ls-files','--cached','--others','--exclude-standard','--',item).trim()!=='')).filter(file=>NAME_RE.test(diskRead(file)));
  assert.deepEqual(outside,[]);
});

/* ---- 2. the runtime roots and their import closure ---- */

async function runtimeRoots(){
  const roots=new Set(['src/server.js','src/worker.js','src/postgres/server.js','src/postgres/worker-main.js','src/postgres/quant-research-main.js','src/postgres/qr2-compute-worker.js',
    'src/postgres/pine-market-wait-worker.js','src/postgres/quant-foundation-recovery-cli.js','src/quant-research/io-profile-worker.js','src/postgres/quant-preflight-wiring.js',
    'src/postgres/quant-preflight-routes.js','src/postgres/quant-library.js','src/postgres/comparison-store.js','src/postgres/selection-store.js']);
  const manifestText=await fs.readFile(path.join(root,'package.json'),'utf8');
  const manifest=JSON.parse(manifestText);
  const texts=[manifestText,...Object.values(manifest.scripts??{})];
  for(const file of ['Dockerfile','compose.yaml','compose.postgres.yaml'])texts.push(await fs.readFile(path.join(root,file),'utf8'));
  for(const entry of entriesIn(texts))roots.add(entry);
  return [...roots].sort();
}
test('no runtime root (server, worker, package script, container command) reaches the module in its import closure, and no closure file names it',async()=>{
  const roots=await runtimeRoots();
  for(const file of ['src/server.js','src/postgres/server.js','src/postgres/worker-main.js','src/postgres/quant-research-main.js','scripts/migrate-quant-research.mjs'])assert.ok(roots.includes(file),'known runtime root missing: '+file);
  for(const file of roots)assert.ok(existsCached(file),'runtime root missing: '+file);
  const {visited,unresolved,computed}=closureOf(roots,diskRead,existsCached);
  assert.deepEqual(unresolved,[],'every relative import of the closure resolves to a file');
  assert.ok(visited.size>100,'the traversal reaches the application: '+visited.size);
  assert.ok(existsCached(MODULE)&&!visited.has(MODULE),MODULE+' is reachable from a runtime root');
  assert.deepEqual([...visited].filter(file=>NAME_RE.test(diskRead(file))),[],'closure files naming the service');
  assert.deepEqual(computed,[],'a computed dynamic import would hide an edge from this scan');
  // The migration CLI and the service are different things: no runtime root names the service module.
  assert.deepEqual(roots.filter(file=>NAME_RE.test(file)),[]);
});

/* ---- 3. the imports of the module ---- */

test('the module imports exactly the allowlisted modules and no engine, research execution, foundation, preflight, profile, selection, comparison, multi-Pine or server module',()=>{
  const code=stripComments(moduleText);
  const specifiers=[...code.matchAll(/^import\s[^;]*?from\s*'([^']+)'/gm)].map(match=>match[1]);
  assert.ok(specifiers.length>=10);
  assert.deepEqual(specifiers.filter(item=>item.startsWith('.')).sort(),[...ALLOWED_IMPORTS].sort(),'the relative imports are exactly the allowlist');
  assert.deepEqual(specifiers.filter(item=>!item.startsWith('.')),['node:crypto'],'the only package import is node:crypto');
  for(const item of ALLOWED_IMPORTS)for(const pattern of FORBIDDEN_DIRECT)assert.ok(!pattern.test(item),item+' is a forbidden direct import');
  assert.ok(!/\bimport\s*\(/.test(code)&&!/\brequire\s*\(/.test(code),'no dynamic import or require');
  for(const item of ALLOWED_IMPORTS)assert.ok(existsCached(path.posix.normalize(path.posix.join('src/postgres',item))),item+' exists');
  assert.ok(!/process\.env|child_process|node:fs|node:net|node:http|\bfetch\s*\(/.test(code),'no environment, file, process or network access in the module');
  assert.ok(!/mp_package|mp-package|mp_research|mp_member/i.test(moduleText),'the module names no multi-Pine table or module');
});

/* ---- 4. what the module writes ---- */

test('the module inserts into exactly the ten package tables and never edits, removes, creates or drops anything; every row is a fixture and READY is never true',()=>{
  const code=stripComments(moduleText);
  const targets=[...new Set([...code.matchAll(/INSERT\s+INTO\s+(?:public\.)?([a-z0-9_]+)/gi)].map(match=>match[1]))].sort();
  assert.deepEqual(targets,[...PACKAGE_TABLES].sort(),'INSERT targets');
  assert.deepEqual([...WRITTEN_TABLES].sort(),[...PACKAGE_TABLES].sort(),'WRITTEN_TABLES is the installer table list');
  assert.ok(!/\b(?:UPDATE\s+(?:public\.)?[a-z_]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+(?:TABLE|FUNCTION|TRIGGER|INDEX)|DROP\s+(?:TABLE|FUNCTION|TRIGGER)|GRANT\s|REVOKE\s|LOCK\s+TABLE)\b/i.test(code),
    'no statement that edits, removes or creates an object');
  assert.ok(!/\bready\s*:\s*true\b/.test(code),'READY is never true');
  assert.ok(!/\bfixture\s*:\s*false\b/.test(code),'no row is labelled non-fixture');
  assert.ok(/'ONE_PINE',false,true,PACKAGE_GATE_VERSION/.test(code),'the export row is born ONE_PINE, internal false, fixture true');
  assert.ok(!/SELECT[^`']*\bFOR\s+(?:UPDATE|SHARE)\b/i.test(code),'no row lock');
  // every statement names its relations with the public schema, so a session TEMP table cannot take their place
  const unqualified=[...code.matchAll(/\b(?:FROM|JOIN|INTO)\s+(?!public\.)(bi_[a-z_]+|quant_[a-z_]+|pine_[a-z_]+|ql4c_validation)\b/gi)].map(match=>match[0]);
  assert.deepEqual(unqualified,[]);
});

/* ---- 5. the copied SQL, the codes and the limits ---- */

const collapse=value=>value.replace(/\s+/g,' ').trim();
test('the lookup SQL is the SQL of its sources with only the schema name added, and the boundary scope is the preflight scope',()=>{
  const library=diskRead('src/postgres/quant-library.js'),earlier=library.match(/const EARLIER=`([\s\S]*?)`;/);
  assert.ok(earlier,'EARLIER found in quant-library.js');
  assert.equal(collapse(EARLIER_ONE_PINE_SQL.replaceAll('public.','')),collapse(earlier[1]));
  assert.equal(EARLIER_ONE_PINE_SQL.match(/public\./g).length,1);
  const preflight=diskRead('src/postgres/quant-preflight.js'),boundary=preflight.match(/const EFFECTIVE_BOUNDARY_SQL=`([\s\S]*?)`;/);
  assert.ok(boundary,'EFFECTIVE_BOUNDARY_SQL found in quant-preflight.js');
  assert.equal(collapse(EFFECTIVE_BOUNDARY_SQL.replaceAll('public.','')),collapse(boundary[1]));
  assert.equal(EFFECTIVE_BOUNDARY_SQL.match(/public\./g).length,2);
  assert.deepEqual({...BOUNDARY_SCOPE},{...PREFLIGHT_HOLDOUT_SCOPE});
  assert.match(EARLIER_SEARCHED_ONE_PINE_SQL,/FROM public\.quant_jobs j WHERE j\.owner_id=\$1 AND .*j\.contract->>'source_hash'=ANY\(\$4::text\[\]\)/s);
  // the same search window the multi-Pine reader uses: OD-10 reads any status, strictly earlier by (created_at, run_id)
  assert.match(EARLIER_SEARCHED_ONE_PINE_SQL,/\(j\.created_at,j\.run_id\)<\(\$3::bigint,\$2::text\)/);
});

test('module codes are never gate codes and are never stored; the ruled limits are the constants',()=>{
  const modules=['PACKAGE_STORE_BUSY','PACKAGE_STORE_CANCELLED','PACKAGE_STORE_IN_TRANSACTION','PACKAGE_STORE_NOT_INSTALLED','PACKAGE_STORED_INTEGRITY'];
  for(const file of ['src/quant-library/package-gates.js','src/quant-library/package-render.js','src/quant-library/trace-reproduction.js','src/quant-library/owner-recommendation.js','src/postgres/best-inputs-package-schema.sql'])
    for(const code of modules)assert.ok(!diskRead(file).includes(code),file+' names the module code '+code);
  assert.deepEqual([PACKAGE_STORE_CODES.BUSY,PACKAGE_STORE_CODES.CANCELLED],['PACKAGE_STORE_BUSY','PACKAGE_STORE_CANCELLED']);
  // the codes the module reports for the contract are existing contract codes
  for(const code of [PACKAGE_STORE_CODES.ENGINE_MISMATCH,PACKAGE_STORE_CODES.TRANSITION_INVALID])assert.match(diskRead('src/quant-library/package-gates.js')+diskRead('src/quant-library/trace-reproduction.js'),new RegExp(code));
  assert.equal(PACKAGE_STORE_MAX_RETRIES,3,'ruling 5: one first try plus three restarts');
  assert.equal(PACKAGE_STORE_MAX_WAITERS,8,'ruling 2: at most eight joined waiters');
  assert.equal(MAX_PACKAGE_BYTES,16*1024*1024,'RC-14: the 16 MiB package cap');
  assert.ok(Object.isFrozen(PACKAGE_STORE_CODES));
});
