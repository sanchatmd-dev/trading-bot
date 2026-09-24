import {hash,canonical,keys,number,fail} from '../pine-bridge/source.js';

export async function membershipSnapshot(service,owner,bot) {
  return service.db.prepare(`SELECT m.pine_import_id,m.source_version,r.source_hash,r.analysis FROM pine_memberships m
    JOIN pine_source_revisions r USING(pine_import_id,source_version)
    WHERE m.owner_id=? AND m.bot_id=? AND m.connected=TRUE ORDER BY m.pine_import_id`).all(owner,bot);
}
export function effectiveInputs(analysis,values) {
  if(values===undefined)return analysis;
  keys(values,analysis.inputs.map(i=>i.input_id));
  const result=structuredClone(analysis);
  for(const input of result.inputs) {
    const v=values[input.input_id];
    if(['int','float'].includes(input.type)) {
      number(v,{integer:input.type==='int',min:input.declared_domain.min??-1e12,max:input.declared_domain.max??1e12});
    } else if(input.type==='bool') {if(typeof v!=='boolean')throw fail('INVALID_FIXED_INPUT');}
    else if(typeof v!=='string'||v.length>2000)throw fail('INVALID_FIXED_INPUT');
    input.effective_value=v;
  }
  result.effective_inputs_hash=hash(canonical(values));
  return result;
}
export async function invalidateEntries(service,bot) {
  // Old routes keep only scoped exits for already accepted allocations.
  await service.db.prepare("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE bot_id=? AND state='READY'").run(bot);
}
export async function setMembership(service,owner,id,body) {
  keys(body,['bot_id','connected']);if(typeof body.connected!=='boolean')throw fail('INVALID_MEMBERSHIP');
  await service.authorize(owner,body.bot_id);
  await service.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
  if(body.bot_id!==owner)await service.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(body.bot_id);
  const row=await service.db.prepare('SELECT * FROM pine_memberships WHERE pine_import_id=? AND owner_id=? AND bot_id=? FOR UPDATE').get(id,owner,body.bot_id);
  if(!row)throw fail('NOT_FOUND',404);
  if(row.connected!==body.connected){
    await service.db.prepare('UPDATE pine_memberships SET connected=? WHERE pine_import_id=?').run(body.connected,id);
    await invalidateEntries(service,body.bot_id);
    await service.store.audit(owner,'pine_bridge.membership',id,{connected:body.connected});
  }
  return {pine_import_id:id,connected:body.connected};
}
