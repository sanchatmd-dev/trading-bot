import {QR2_BOUNDARY_RECORD_UNRECORDED,validateBoundaryRecord} from './qr2-boundaries.js';
import {Qr2Error} from './qr2-constants.js';

// QR-2 boundary record registry (contract 6.2; OD-Q6, RC-Q25, RC-Q46). Pure: the tracked list of reviewed boundary records and the default the
// QR-2 routes take from it. A record enters this list only as a reviewed change that copies its values from deployment evidence, with a new pin.
// Nothing here reads a database, the clock, the network, a file or the process state: the default is fixed when the module loads.
// Load-time validation covers only this tracked list and reads no environment, database or host state, so it is not a startup check; exact-revision CI loads this module.

// Same shape for every id: upper-case letters, digits and underscore. Whitespace, lower case, JSON, a path or a URL never match.
const RECORD_ID=/^[A-Z][A-Z0-9_]{0,63}$/;
const ENVIRONMENTS=Object.freeze(['staging']);

const refuse=message=>{throw new Qr2Error('QR2_BOUNDARY_REGISTRY_INVALID',message);};

/**
 * Validates every entry and returns a frozen registry {get(id), has(id), size, list()}. An entry is {environment, record}: the record goes
 * through validateBoundaryRecord, the environment is registry metadata only and never enters the record or a response. Refused: an entry or
 * a record that fails validation, the id UNRECORDED (that is the product default, not a registry record), an id outside the id shape, a
 * duplicate id, an environment other than staging, and a second record (the registry holds at most one).
 */
export function buildBoundaryRegistry(entries){
  if(!Array.isArray(entries))refuse('registry entries must be an array');
  const byId=new Map();
  for(const [index,entry] of entries.entries()){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))refuse('registry entry '+index+' must be an object');
    if(!ENVIRONMENTS.includes(entry.environment))refuse('registry entry '+index+' has an unknown environment');
    const record=validateBoundaryRecord(entry.record);
    if(record.record_id==='UNRECORDED')refuse('UNRECORDED is the product default and not a registry record');
    if(!RECORD_ID.test(record.record_id))refuse('registry entry '+index+' has a record_id outside the allowed shape');
    if(byId.has(record.record_id))refuse('duplicate record_id in the registry');
    if(byId.size)refuse('at most one record in the registry');
    byId.set(record.record_id,Object.freeze({environment:entry.environment,record}));
  }
  return Object.freeze({get:id=>byId.get(id),has:id=>byId.has(id),size:byId.size,list:()=>[...byId.values()]});
}

/**
 * The shipped registry: one staging record, with values copied from deployment evidence (OD-Q6). The epoch edges come from the deployment
 * records and the read-only staging boundary read that the evidence path cites. The lot boundaries stay null: an absent boundary only bites a
 * lot that fails the current formula, and then the replay says so (LOT_EPOCH_UNKNOWN). A change to any value needs a new golden digest in
 * test/qr2-boundary-records.test.js in the same reviewed diff, and a new pin.
 */
export const QR2_BOUNDARY_RECORDS=buildBoundaryRegistry([
  {environment:'staging',record:{
    record_id:'STAGING_QL_P2_PROTOTYPE_20261030',
    epochs:[
      {epoch:'E0',from:1790871360000,to:1792016261152},
      {epoch:'E1',from:1792016273400,to:1792990177825},
      {epoch:'E2',from:1792990177825,to:null}
    ],
    lot_fee_boundary:null,
    lot_table_boundary:null,
    evidence:'docs/evidence/S6_QR2_BOUNDARY_READ_1_A01_RESULT_2026-10-30.json'
  }}
]);

/**
 * The default record of a registry: the staging record when there is one, else the product default object QR2_BOUNDARY_RECORD_UNRECORDED
 * itself (the same object, so every answer stays as before). The routes use the constant below; this helper is the seam for tests.
 */
export function boundaryRecordDefault(registry){
  const entry=registry.list().find(row=>row.environment==='staging');
  return entry?entry.record:QR2_BOUNDARY_RECORD_UNRECORDED;
}

export const QR2_BOUNDARY_RECORD_DEFAULT=boundaryRecordDefault(QR2_BOUNDARY_RECORDS);
