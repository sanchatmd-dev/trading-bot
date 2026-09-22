import {PostgresDatabase} from '../src/postgres/db.js';
const db=new PostgresDatabase();
try{await db.transaction(async()=>{await db.maintenanceLock();await db.migrate();});console.log('PostgreSQL schema 14 ready');}
finally{await db.close();}
