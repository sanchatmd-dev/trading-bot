import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// F11-01 RS-3 (root decision I2): the static half of the run-store isolation proof. No PostgreSQL, no network. Two claims:
//  1. No tracked src or scripts file names a run-store table (or the run-store modules) except an EXACT allowlist: the run-store module and its
//     migration (and SQL), the CLI, the two grant scripts, and src/multi-pine/. A new naming file fails here until the allowlist is changed on purpose.
//  2. The import closure of every runtime root (HTTP servers, workers, background entry points, package scripts, container commands) never reaches
//     src/postgres/mp-run-store.js or mp-run-store-migration.js, and no file in that closure names a run-store table. A reader or worker that could see a
//     run through code is therefore not reachable from any process the product starts (the behaviour half is test/postgres/mp-run-store-isolation.test.mjs).
const root=fileURLToPath(new URL('../',import.meta.url));
const NAMES='mp_research_run|mp_run_store|mp-run-store';
// Names are matched case-insensitively everywhere (regex, git grep -i, closure check): an upper-case table name still reaches the same table.
const NAMES_RE=new RegExp(NAMES,'i');
const FORBIDDEN_MODULES=['src/postgres/mp-run-store.js','src/postgres/mp-run-store-migration.js'];

// The exact files that may name a run-store table. required=false: the file does not exist yet (the RS-2 writer module lands in a parallel slice).
const ALLOWED_FILES=[
  {file:'src/postgres/mp-run-store.sql',required:true},
  {file:'src/postgres/mp-run-store-rollback.sql',required:true},
  {file:'src/postgres/mp-run-store-migration.js',required:true},
  {file:'src/postgres/mp-run-store.js',required:false},
  {file:'scripts/migrate-mp-run-store.mjs',required:true},
  {file:'scripts/grant-postgres-mp-fixture.sql',required:true},
  {file:'scripts/grant-postgres-runtime.sql',required:true},
  // RD-MP-36 (slice R6-3): the multi-Pine package store reads the run store by SELECT in its export guard (no foreign key, judgement J1), so its SQL, its migration
  // and its fixture grant script name run-store tables. Its rollback SQL and CLI name none and are not listed.
  {file:'src/postgres/mp-package-store.sql',required:true},
  {file:'src/postgres/mp-package-store-migration.js',required:true},
  {file:'scripts/grant-postgres-mp-package-fixture.sql',required:true},
  // RD-MP-36 (slice R6-4): the package store writer and readers (build service, holdout reader) import the run-store reader and read the run store through it, so the module names the run store.
  {file:'src/postgres/mp-package-store.js',required:true}];
const ALLOWED_PREFIX='src/multi-pine/';
// Code roots outside src and scripts that no run-store name may enter either (the web client, the Python engine, container and service definitions).
const OTHER_ROOTS=['public','quant_lab','Dockerfile','Caddyfile','compose.yaml','compose.postgres.yaml','.deploy/astra-trade-phase2.service','.deploy/astra-trade-quant.service',
  '.deploy/astra-trade-worker.service','.deploy/robot-postgres.service','.github'];

function git(...args){
  try{return execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});}
  catch(error){if(error.status===1)return '';throw error;}
}
const gitFiles=(...paths)=>git('grep','-l','-I','-i','-E',NAMES,'--',...paths).split('\n').filter(Boolean).sort();

/* ---- the import-closure scanner (pure; exercised below against synthetic sources, then against the repository) ---- */

const EDGE=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g;
const URL_EDGE=/new\s+URL\(\s*['"](\.[^'"]*\.(?:m?js|cjs))['"]\s*,\s*import\.meta\.url\s*\)/g;
// A dynamic import whose specifier is not a plain string literal hides an edge from the scan; the closure may contain none.
const COMPUTED_IMPORT=/\bimport\s*\(\s*(?!['"])/g;

/** Resolves a relative specifier the way the product's files write them (explicit extension); returns the first existing candidate or null. */
function resolveSpecifier(from,specifier,exists){
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),specifier));
  for(const candidate of [base,base+'.js',base+'.mjs',base+'/index.js'])if(exists(candidate))return candidate;
  return null;
}
/** Breadth-first closure of relative imports from the roots. read(file) returns the text, exists(file) says whether it is a file. */
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
    for(const pattern of [EDGE,URL_EDGE]){
      for(const match of source.matchAll(pattern)){
        const target=resolveSpecifier(file,match[1],exists);
        if(target===null)unresolved.push(file+' -> '+match[1]);else queue.push(target);
      }
    }
  }
  return {visited,unresolved,computed};
}
/** Pure allowlist checks, exercised by the self-test below against synthetic input. found = files that name the run store. */
const strayFiles=(found,allowlist,prefix)=>{const allowed=new Set(allowlist.map(item=>item.file));return found.filter(file=>!allowed.has(file)&&!file.startsWith(prefix));};
const staleEntries=(found,allowlist)=>allowlist.filter(item=>item.required&&!found.includes(item.file)).map(item=>item.file);
/** The src/ and scripts/ entry points named anywhere in the given texts (package scripts, Dockerfile, compose files); the pattern is loose on purpose. */
const ENTRY=/(?:src|scripts)\/[A-Za-z0-9_\-./]+\.(?:m?js|cjs)/g;
const entriesIn=texts=>{const out=new Set();for(const text of texts)for(const match of text.matchAll(ENTRY))out.add(match[0]);return out;};
const cache=new Map();
const diskRead=file=>{if(!cache.has(file))cache.set(file,readFileSync(path.join(root,file),'utf8'));return cache.get(file);};

test('the scanner follows static imports, re-exports, dynamic literal imports, require and new URL edges, and flags a computed dynamic import',()=>{
  const files={
    'src/root.js':"import a from './a.js';export * from './re.js';const x=await import('./dyn.js');const w=new URL('./worker.js',import.meta.url);",
    'src/a.js':"import b from './deep/b';",'src/deep/b.js':"import store from '../postgres/mp-run-store.js';",'src/re.js':'export const x=1;','src/dyn.js':"const y=require('./cjs.js');",
    'src/cjs.js':'','src/worker.js':"import(name);",'src/postgres/mp-run-store.js':'export const z=1;'};
  const exists=file=>Object.hasOwn(files,file);
  const result=closureOf(['src/root.js'],file=>files[file],exists);
  assert.deepEqual([...result.visited].sort(),Object.keys(files).sort());
  assert.ok(result.visited.has('src/postgres/mp-run-store.js'),'a transitive extensionless import reaches the run-store module');
  assert.deepEqual(result.computed,['src/worker.js']);
  assert.deepEqual(result.unresolved,[]);
  const missing=closureOf(['src/m.js'],()=> "import './gone.js';",()=>false);
  assert.deepEqual(missing.unresolved,['src/m.js -> ./gone.js'],'an import that resolves to no file is reported, never skipped');
  // The same scan on a clean graph finds nothing.
  const clean=closureOf(['src/root.js'],file=>files[file],file=>exists(file)&&file!=='src/postgres/mp-run-store.js');
  assert.ok(!clean.visited.has('src/postgres/mp-run-store.js'));
});

test('self-test: a stale allowlist entry and a stray naming file fail, the entry scan is loose, and the name match is case-insensitive',()=>{
  const list=[{file:'src/a.js',required:true},{file:'src/b.js',required:true},{file:'src/c.js',required:false}];
  assert.deepEqual(staleEntries(['src/a.js'],list),['src/b.js'],'a required entry that no longer names the run store is stale');
  assert.deepEqual(staleEntries(['src/a.js','src/b.js'],list),[]);
  assert.deepEqual(strayFiles(['src/a.js','src/x.js','src/multi-pine/y.js'],list,'src/multi-pine/'),['src/x.js']);
  const entries=entriesIn(['node --env-file-if-exists=.env scripts/m.mjs','CMD ["node", "src/x/y.js"]',"command: [ 'node' , 'src/z.cjs' ]",'node src/no-ext','srcs/q.js']);
  assert.deepEqual([...entries].sort(),['scripts/m.mjs','src/x/y.js','src/z.cjs']);
  assert.ok(NAMES_RE.test('SELECT 1 FROM MP_Research_Runs')&&NAMES_RE.test('Mp-Run-Store.js'));
  const result=closureOf(['src/r.js'],()=>"import x from './MP-RUN-STORE.js';",()=>true);
  assert.ok([...result.visited].some(file=>NAMES_RE.test(file)),'a case-variant module name is still recognised by the closure naming check');
});

/* ---- 1. the naming allowlist ---- */

test('no tracked src or scripts file names a run-store table or module except the exact allowlist (and src/multi-pine/)',()=>{
  const found=gitFiles('src','scripts');
  assert.ok(found.length>=5,'the scan sees the run-store files: '+found.join());
  assert.deepEqual(strayFiles(found,ALLOWED_FILES,ALLOWED_PREFIX),[],'files naming the run store outside the allowlist');
  // The allowlist is exact, not slack: every required file exists, is tracked and names the store.
  assert.deepEqual(staleEntries(found,ALLOWED_FILES),[],'allowlisted but does not name the run store (stale allowlist)');
  assert.deepEqual(ALLOWED_FILES.filter(item=>!item.required).map(item=>item.file),['src/postgres/mp-run-store.js']);
});

test('no web, Python, container or service file names a run-store table or module',()=>{
  assert.deepEqual(gitFiles(...OTHER_ROOTS.filter(item=>git('ls-files','--',item).trim()!=='')),[]);
});

test('no existing one-Pine reader, worker, mode guard or QR-3/QR-4 file names a run-store table (the files the design lists by name)',async()=>{
  const listed=['src/postgres/quant-research.js','src/postgres/quant-library.js','src/postgres/quant-research-history.js','src/postgres/quant-research-worker.js',
    'src/postgres/quant-research-foundation.js','src/postgres/quant-research-main.js','src/postgres/quant-preflight.js','src/postgres/quant-storage-retention.js',
    'src/postgres/quant-foundation-recovery.js','src/postgres/quant-foundation-scheduler.js','src/postgres/selection-store.js','src/postgres/comparison-store.js',
    'src/postgres/exposure-register.js','src/postgres/quant-research-guard-hardening.sql','src/postgres/quant-research-foundation-schema.sql','src/postgres/quant-research-schema.sql',
    'src/postgres/quant-comparison.sql','src/postgres/quant-selection.sql','src/postgres/best-inputs-package-schema.sql','src/postgres/quant-research-freeze.sql'];
  for(const file of listed){
    const text=await fs.readFile(path.join(root,file),'utf8');
    assert.ok(!NAMES_RE.test(text),file+' names the run store');
  }
});

/* ---- 2. the runtime roots and their import closure ---- */

/** The processes the product starts: package scripts, the Dockerfile and compose commands, and the background entry points found in src. */
async function runtimeRoots(){
  const roots=new Set(['src/server.js','src/worker.js','src/postgres/server.js','src/postgres/worker-main.js','src/postgres/quant-research-main.js',
    'src/postgres/qr2-compute-worker.js','src/postgres/pine-market-wait-worker.js','src/postgres/quant-foundation-recovery-cli.js','src/quant-research/io-profile-worker.js',
    'src/postgres/quant-preflight-wiring.js','src/postgres/quant-preflight-routes.js','src/postgres/quant-library.js','src/postgres/comparison-store.js','src/postgres/selection-store.js']);
  const manifestText=await fs.readFile(path.join(root,'package.json'),'utf8');
  const manifest=JSON.parse(manifestText);
  const texts=[manifestText,...Object.values(manifest.scripts??{})];
  for(const file of ['Dockerfile','compose.yaml','compose.postgres.yaml'])texts.push(await fs.readFile(path.join(root,file),'utf8'));
  for(const entry of entriesIn(texts))roots.add(entry);
  return [...roots].sort();
}
const existsCached=(()=>{const memo=new Map();return file=>{if(!memo.has(file)){let found=false;try{found=statSync(path.join(root,file)).isFile();}catch{found=false;}memo.set(file,found);}return memo.get(file);};})();

test('the runtime roots exist, include the package script and container entry points, and their closure traverses the product',async()=>{
  const roots=await runtimeRoots();
  for(const file of ['src/server.js','src/postgres/server.js','src/postgres/worker-main.js','src/postgres/quant-research-main.js','scripts/migrate-quant-research.mjs','scripts/import-postgres.mjs',
    'scripts/backup-postgres.mjs'])assert.ok(roots.includes(file),'known runtime root missing from the derived set: '+file);
  for(const file of roots)assert.ok(existsCached(file),'runtime root missing: '+file);
  const {visited,unresolved}=closureOf(roots,diskRead,existsCached);
  assert.deepEqual(unresolved,[],'every relative import of the closure resolves to a file');
  assert.ok(visited.size>100,'the traversal reaches the application: '+visited.size);
  for(const file of ['src/postgres/quant-research.js','src/postgres/quant-research-worker.js','src/postgres/quant-library.js','src/postgres/quant-foundation-scheduler.js','src/postgres/store.js'])
    assert.ok(visited.has(file),'the traversal reaches '+file);
});

test('no runtime root reaches the run-store module or migration, and no file of the closure names a run-store table',async()=>{
  const roots=await runtimeRoots();
  const {visited,computed}=closureOf(roots,diskRead,existsCached);
  for(const file of FORBIDDEN_MODULES)assert.ok(!visited.has(file),file+' is reachable from a runtime root');
  const naming=[...visited].filter(file=>NAMES_RE.test(diskRead(file)));
  assert.deepEqual(naming,[],'closure files naming the run store');
  assert.deepEqual([...visited].filter(file=>file.startsWith('src/multi-pine/')&&/fixture-service/.test(file)),[],'the fixture service is not part of any runtime closure');
  // A computed dynamic import would hide an edge from this scan; the closure holds none.
  assert.deepEqual(computed,[],'computed dynamic imports in the runtime closure');
});

test('the run-store modules are not imported by any other tracked src file outside the allowlist, by any import form',async()=>{
  const importers=[];
  const files=git('ls-files','--','src','scripts').split('\n').filter(file=>/\.(?:js|mjs|cjs)$/.test(file));
  assert.ok(files.length>200);
  for(const file of files){
    if(ALLOWED_FILES.some(item=>item.file===file)||file.startsWith(ALLOWED_PREFIX))continue;
    const text=diskRead(file);
    for(const match of text.matchAll(EDGE))if(/mp-run-store/.test(match[1]))importers.push(file);
  }
  assert.deepEqual(importers,[]);
  // The migration and the CLI never import the writer module; only the fixture side (the writer module and src/multi-pine) may.
  for(const file of ['src/postgres/mp-run-store-migration.js','scripts/migrate-mp-run-store.mjs'])
    for(const match of diskRead(file).matchAll(EDGE))assert.ok(!/mp-run-store.js$/.test(match[1]),file+' imports the writer module');
});
