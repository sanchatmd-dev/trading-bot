import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// F11-01 R6-5 (RD-MP-36, RD-MP-42 b): the static half of the multi-Pine package-store isolation proof. No PostgreSQL, no network. It mirrors
// test/mp-run-store-static-isolation.test.js. Claims:
//  1. No tracked src or scripts file names a package-store table or module (mp_package..., mp-package...) except an EXACT allowlist: the store module, its SQL, rollback,
//     migration, the CLI, the two grant scripts and the producer closure id in src/multi-pine/package-closure.js. A new naming file fails until the allowlist changes on purpose.
//  2. The import closure of every runtime root (HTTP servers, workers, background entry points, package scripts, container commands) never reaches the package-store module or
//     migration, nor src/multi-pine/package-render.js, package-trace.js, package-closure.js or package-gates.js, and no closure file names a package-store table. A reader or
//     worker that could see an export through code is therefore not reachable from any process the product starts (the behaviour half is test/postgres/mp-package-isolation.test.mjs).
//  3. Exact importer maps: only the listed files import the package modules, by any static, dynamic-literal, require or new URL edge.
const root=fileURLToPath(new URL('../',import.meta.url));
const NAMES='mp_package|mp-package';
// Names are matched case-insensitively everywhere (regex, git grep -i, closure check): an upper-case table name still reaches the same table.
const NAMES_RE=new RegExp(NAMES,'i');
const STORE_MODULES=['src/postgres/mp-package-store.js','src/postgres/mp-package-store-migration.js'];
const PURE_MODULES=['src/multi-pine/package-render.js','src/multi-pine/package-trace.js','src/multi-pine/package-closure.js','src/multi-pine/package-gates.js'];
const FORBIDDEN_MODULES=[...STORE_MODULES,...PURE_MODULES];

// The exact files that may name a package-store table or module.
const ALLOWED_FILES=[
  'src/postgres/mp-package-store.sql','src/postgres/mp-package-store-rollback.sql','src/postgres/mp-package-store-migration.js','src/postgres/mp-package-store.js',
  'scripts/migrate-mp-package-store.mjs','scripts/grant-postgres-mp-package-fixture.sql','scripts/grant-postgres-runtime.sql',
  // The producer closure id 'mp-package-trace-closure-v1' (RD-MP-39) is the only name in src/multi-pine/.
  'src/multi-pine/package-closure.js'];
// Exact importer maps (target -> files that import it). Every other tracked src or scripts file must import none of the forbidden modules.
const IMPORTERS={
  'src/postgres/mp-package-store.js':[],
  'src/postgres/mp-package-store-migration.js':['scripts/migrate-mp-package-store.mjs'],
  'src/multi-pine/package-render.js':['src/multi-pine/package-gates.js','src/postgres/mp-package-store.js'],
  'src/multi-pine/package-trace.js':['src/multi-pine/package-gates.js','src/multi-pine/package-render.js','src/postgres/mp-package-store.js'],
  'src/multi-pine/package-closure.js':['src/postgres/mp-package-store.js'],
  'src/multi-pine/package-gates.js':['src/postgres/mp-package-store.js']};
// Code roots outside src and scripts that no package-store name may enter either (the web client, the Python engine, container and service definitions).
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
/** The resolved direct targets of one file's relative imports. */
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
    const edges=edgesOf(file,source,exists);
    unresolved.push(...edges.unresolved);
    queue.push(...edges.targets);
  }
  return {visited,unresolved,computed};
}
/** Pure allowlist checks, exercised by the self-test below against synthetic input. found = files that name the package store. */
const strayFiles=(found,allowlist)=>found.filter(file=>!allowlist.includes(file));
const staleEntries=(found,allowlist)=>allowlist.filter(file=>!found.includes(file));
/** The src/ and scripts/ entry points named anywhere in the given texts (package scripts, Dockerfile, compose files); the pattern is loose on purpose. */
const ENTRY=/(?:src|scripts)\/[A-Za-z0-9_\-./]+\.(?:m?js|cjs)/g;
const entriesIn=texts=>{const out=new Set();for(const text of texts)for(const match of text.matchAll(ENTRY))out.add(match[0]);return out;};
const cache=new Map();
const diskRead=file=>{if(!cache.has(file))cache.set(file,readFileSync(path.join(root,file),'utf8'));return cache.get(file);};
const existsCached=(()=>{const memo=new Map();return file=>{if(!memo.has(file)){let found=false;try{found=statSync(path.join(root,file)).isFile();}catch{found=false;}memo.set(file,found);}return memo.get(file);};})();

test('the scanner follows static imports, re-exports, dynamic literal imports, require and new URL edges, and flags a computed dynamic import',()=>{
  const files={
    'src/root.js':"import a from './a.js';export * from './re.js';const x=await import('./dyn.js');const w=new URL('./worker.js',import.meta.url);",
    'src/a.js':"import b from './deep/b';",'src/deep/b.js':"import store from '../postgres/mp-package-store.js';",'src/re.js':'export const x=1;','src/dyn.js':"const y=require('./cjs.js');",
    'src/cjs.js':'','src/worker.js':"import(name);",'src/postgres/mp-package-store.js':'export const z=1;'};
  const exists=file=>Object.hasOwn(files,file);
  const result=closureOf(['src/root.js'],file=>files[file],exists);
  assert.deepEqual([...result.visited].sort(),Object.keys(files).sort());
  assert.ok(result.visited.has('src/postgres/mp-package-store.js'),'a transitive extensionless import reaches the package-store module');
  assert.deepEqual(result.computed,['src/worker.js']);
  assert.deepEqual(result.unresolved,[]);
  const missing=closureOf(['src/m.js'],()=> "import './gone.js';",()=>false);
  assert.deepEqual(missing.unresolved,['src/m.js -> ./gone.js'],'an import that resolves to no file is reported, never skipped');
  // The same scan on a clean graph finds nothing.
  const clean=closureOf(['src/root.js'],file=>files[file],file=>exists(file)&&file!=='src/postgres/mp-package-store.js');
  assert.ok(!clean.visited.has('src/postgres/mp-package-store.js'));
  // The pure modules are reached by the same walk: a root importing the gates module reaches the renderer and the trace producer through it.
  const pure={'src/r.js':"import g from './multi-pine/package-gates.js';",'src/multi-pine/package-gates.js':"import r from './package-render.js';import t from './package-trace.js';",
    'src/multi-pine/package-render.js':"import t from './package-trace.js';",'src/multi-pine/package-trace.js':''};
  const reach=closureOf(['src/r.js'],file=>pure[file],file=>Object.hasOwn(pure,file));
  assert.ok(PURE_MODULES.filter(file=>file!=='src/multi-pine/package-closure.js').every(file=>reach.visited.has(file)),'the walk reaches the pure package modules');
});

test('self-test: a stale allowlist entry and a stray naming file fail, the entry scan is loose, and the name match is case-insensitive',()=>{
  const list=['src/a.js','src/b.js'];
  assert.deepEqual(staleEntries(['src/a.js'],list),['src/b.js'],'an entry that no longer names the package store is stale');
  assert.deepEqual(staleEntries(['src/a.js','src/b.js'],list),[]);
  assert.deepEqual(strayFiles(['src/a.js','src/x.js','src/multi-pine/y.js'],list),['src/x.js','src/multi-pine/y.js'],'no directory prefix is exempt');
  const entries=entriesIn(['node --env-file-if-exists=.env scripts/m.mjs','CMD ["node", "src/x/y.js"]',"command: [ 'node' , 'src/z.cjs' ]",'node src/no-ext','srcs/q.js']);
  assert.deepEqual([...entries].sort(),['scripts/m.mjs','src/x/y.js','src/z.cjs']);
  assert.ok(NAMES_RE.test('SELECT 1 FROM MP_Package_Exports')&&NAMES_RE.test('Mp-Package-Store.js'));
  const result=closureOf(['src/r.js'],()=>"import x from './MP-PACKAGE-STORE.js';",()=>true);
  assert.ok([...result.visited].some(file=>NAMES_RE.test(file)),'a case-variant module name is still recognised by the closure naming check');
  // The importer scan resolves a specifier to its target, so a renamed spelling of the same file is still caught.
  const found=edgesOf('src/postgres/x.js',"import {a} from './mp-package-store';",file=>file==='src/postgres/mp-package-store.js');
  assert.deepEqual(found.targets,['src/postgres/mp-package-store.js']);
});

/* ---- 1. the naming allowlist ---- */

test('no tracked src or scripts file names a package-store table or module except the exact allowlist (no directory is exempt)',()=>{
  const found=gitFiles('src','scripts');
  assert.ok(found.length>=5,'the scan sees the package-store files: '+found.join());
  assert.deepEqual(strayFiles(found,ALLOWED_FILES),[],'files naming the package store outside the allowlist');
  // The allowlist is exact, not slack: every entry exists, is tracked and names the store.
  assert.deepEqual(staleEntries(found,ALLOWED_FILES),[],'allowlisted but does not name the package store (stale allowlist)');
});

test('no web, Python, container or service file names a package-store table or module',()=>{
  assert.deepEqual(gitFiles(...OTHER_ROOTS.filter(item=>git('ls-files','--',item).trim()!=='')),[]);
});

test('no existing one-Pine reader, worker, mode guard, G8 or QR-3/QR-4 file names a package-store table (the files the design lists by name)',async()=>{
  const listed=['src/postgres/quant-research.js','src/postgres/quant-library.js','src/postgres/quant-research-history.js','src/postgres/quant-research-worker.js',
    'src/postgres/quant-research-foundation.js','src/postgres/quant-research-main.js','src/postgres/quant-preflight.js','src/postgres/quant-storage-retention.js',
    'src/postgres/quant-foundation-recovery.js','src/postgres/quant-foundation-scheduler.js','src/postgres/selection-store.js','src/postgres/comparison-store.js',
    'src/postgres/exposure-register.js','src/postgres/quant-research-guard-hardening.sql','src/postgres/quant-research-foundation-schema.sql','src/postgres/quant-research-schema.sql',
    'src/postgres/quant-comparison.sql','src/postgres/quant-selection.sql','src/postgres/best-inputs-package-schema.sql','src/postgres/quant-research-freeze.sql',
    'src/comparison/context.js','src/comparison/common.js','src/quant-library/package-gates.js','src/quant-library/package-render.js','src/quant-library/derive.js',
    'src/quant-library/trace-reproduction.js','src/quant-library/owner-recommendation.js','src/selection/eligibility.js'];
  for(const file of listed){
    assert.ok(existsCached(file),file+' exists');
    const text=await fs.readFile(path.join(root,file),'utf8');
    assert.ok(!NAMES_RE.test(text),file+' names the package store');
  }
  // The files that already name the run store (RS-3 allowlist) include the one-Pine G8 reader sources by path; none of them is a package-store importer.
  const g8=git('grep','-l','-I','-i','-E','ql4c_validation','--','src').split('\n').filter(Boolean);
  assert.ok(g8.length>0,'the scan sees the files that name the G8 validation table');
  // Only the package-store SQL may mention ql4c_validation (in a comment, to say it is never written); it is on the exact allowlist above.
  assert.deepEqual(g8.filter(file=>NAMES_RE.test(diskRead(file))&&!ALLOWED_FILES.includes(file)),[],'a file that names ql4c_validation also names the package store');
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

test('the runtime roots exist, include the package script and container entry points, and their closure traverses the product',async()=>{
  const roots=await runtimeRoots();
  for(const file of ['src/server.js','src/postgres/server.js','src/postgres/worker-main.js','src/postgres/quant-research-main.js','scripts/migrate-quant-research.mjs','scripts/import-postgres.mjs',
    'scripts/backup-postgres.mjs'])assert.ok(roots.includes(file),'known runtime root missing from the derived set: '+file);
  for(const file of roots)assert.ok(existsCached(file),'runtime root missing: '+file);
  const {visited,unresolved}=closureOf(roots,diskRead,existsCached);
  assert.deepEqual(unresolved,[],'every relative import of the closure resolves to a file');
  assert.ok(visited.size>100,'the traversal reaches the application: '+visited.size);
  for(const file of ['src/postgres/quant-research.js','src/postgres/quant-research-worker.js','src/postgres/quant-library.js','src/postgres/quant-foundation-scheduler.js','src/postgres/store.js',
    'src/postgres/comparison-store.js'])assert.ok(visited.has(file),'the traversal reaches '+file);
});

test('no runtime root reaches the package-store module, its migration or the four package modules, and no file of the closure names a package-store table',async()=>{
  const roots=await runtimeRoots();
  const {visited,computed}=closureOf(roots,diskRead,existsCached);
  for(const file of FORBIDDEN_MODULES){
    assert.ok(existsCached(file),file+' exists (a missing module would make this proof vacuous)');
    assert.ok(!visited.has(file),file+' is reachable from a runtime root');
  }
  const naming=[...visited].filter(file=>NAMES_RE.test(diskRead(file)));
  assert.deepEqual(naming,[],'closure files naming the package store');
  assert.deepEqual([...visited].filter(file=>/^src\/multi-pine\/package-/.test(file)),[],'no src/multi-pine/package-* module is part of any runtime closure');
  assert.deepEqual([...visited].filter(file=>/fixture-service|executor/.test(file)&&file.startsWith('src/multi-pine/')),[],'the fixture service and executor are not part of any runtime closure');
  // A computed dynamic import would hide an edge from this scan; the closure holds none.
  assert.deepEqual(computed,[],'computed dynamic imports in the runtime closure');
});

test('the migration CLI and the store module are not runtime roots: no package script, Dockerfile or compose command names them',async()=>{
  const roots=await runtimeRoots();
  assert.deepEqual(roots.filter(file=>NAMES_RE.test(file)),[],'a runtime root names the package store');
});

/* ---- 3. exact importer maps ---- */

test('the package modules are imported by exactly the files of the importer map, by any import form (tests excluded; they are not product code)',()=>{
  const files=git('ls-files','--','src','scripts').split('\n').filter(file=>/\.(?:js|mjs|cjs)$/.test(file));
  assert.ok(files.length>200);
  const found=Object.fromEntries(Object.keys(IMPORTERS).map(target=>[target,[]]));
  for(const file of files){
    for(const target of edgesOf(file,diskRead(file),existsCached).targets)if(Object.hasOwn(found,target))found[target].push(file);
  }
  for(const target of Object.keys(found))found[target]=[...new Set(found[target])].sort();
  assert.deepEqual(found,Object.fromEntries(Object.entries(IMPORTERS).map(([target,list])=>[target,[...list].sort()])),'importers of the package modules');
  // The migration and the CLI never import the writer module; the store module is not imported by anything in src or scripts.
  for(const file of ['src/postgres/mp-package-store-migration.js','scripts/migrate-mp-package-store.mjs'])
    for(const target of edgesOf(file,diskRead(file),existsCached).targets)assert.notEqual(target,'src/postgres/mp-package-store.js',file+' imports the writer module');
});
