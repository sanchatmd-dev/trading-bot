const routes=new Set(['/api/quant/backtest','/api/quant/optimize',
  '/api/analytics/summary','/api/analytics/equity-curve','/api/analytics/breakdown']);
const unavailable=()=>Object.assign(new Error('QUANT_EXECUTOR_MODE_UNAVAILABLE'),{code:'QUANT_EXECUTOR_MODE_UNAVAILABLE',status:503});

/** Legacy HTTP calculations cannot run beside the managed global scheduler.
 * Database mode is authoritative even if this API process has a stale flag.
 * Deployments must also enable the matching guard on the loopback Python bridge.
 * Full-history analytics remains unavailable in managed mode until its work has
 * a bounded aggregate reader or an admitted scheduler adapter.
 */
export async function legacyQuantDenied(pathname,{db,foundationEnabled=false}={}) {
  if(!routes.has(pathname))return false;
  if(foundationEnabled)return true;
  try {
  const schema=(await db.query("SELECT to_regclass('quant_research_executor_mode') present")).rows;
  if(schema.length!==1||!Object.hasOwn(schema[0],'present')||
    !(schema[0].present===null||typeof schema[0].present==='string'))
    throw unavailable();
  if(schema[0].present===null)return false;
  const rows=(await db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows;
  if(rows.length!==1||!['FOUNDATION','LEGACY'].includes(rows[0].mode))
    throw unavailable();
  return rows[0].mode==='FOUNDATION';
  }catch{throw unavailable();}
}
