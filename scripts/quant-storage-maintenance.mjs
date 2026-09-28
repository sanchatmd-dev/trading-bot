import {readFile} from 'node:fs/promises';
import {PostgresDatabase} from '../src/postgres/db.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
import {maintainQuantStorage} from '../src/postgres/quant-storage-retention.js';

const args=new Set(process.argv.slice(2));
if([...args].some(arg=>!['--apply','--offline','--recover-stale-lock'].includes(arg))||!args.has('--offline'))throw Error('Offline maintenance requires --offline; optional --apply deletes eligible orphan artifacts');
if(args.has('--recover-stale-lock')&&!args.has('--apply'))throw Error('Stale lock recovery requires --apply and verified offline exclusion');
if(!process.env.QUANT_STORAGE_LIMITS_FILE||!process.env.QUANT_RESEARCH_DATASET_ROOT)throw Error('QUANT_STORAGE_LIMITS_FILE and QUANT_RESEARCH_DATASET_ROOT required');
const limits=JSON.parse(await readFile(process.env.QUANT_STORAGE_LIMITS_FILE,'utf8'));
const budget=new StorageBudget({...limits,root:process.env.QUANT_RESEARCH_DATASET_ROOT});
const db=new PostgresDatabase();
try {
  const result=await maintainQuantStorage({db,budget,apply:args.has('--apply'),recoverStaleLock:args.has('--recover-stale-lock')});
  console.log(JSON.stringify(result));
} finally {await db.close();}
