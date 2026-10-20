import {canonical,hash,executable} from '../pine-bridge/source.js';
import {assemble} from '../pine-bridge/template.js';
import {PACKAGE_FILES,MANIFEST_PATH,ENGINEERING_SCOPE,SUPPORTED_EXIT_VERSIONS,CODE_PATTERN,METRIC_KEYS,
  buildManifest,packageHash,bindingHash,bindingComplete,effectiveInputHash,scanContent,explainBoundDefault} from './package-gates.js';
import {selectedOf} from './derive.js';

/**
 * Pure deterministic renderer of the one-Pine Best Inputs package (F09-01 slice S1, docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md
 * sections 3, 4.1 and 4.2). It reads no database, no file, no network, no clock and no random source, and it is wired into no
 * route, worker, table or UI. Every value in the output comes from an argument; the same argument gives the same bytes, whatever
 * the key order of the argument. It never mutates its argument.
 *
 * It renders bytes and nothing else. It judges nothing: B0 (build eligibility) and C1 to C4 run after
 * it, in package-gates.js. B0 needs the rendered binding and the limitation codes it emits are written into the manifest, so the order is:
 * render, then B0 on the rendered binding, then render again with the limitation codes if they changed. The renderer refuses (throws a coded error) only for input it cannot render without inventing a
 * value. A refusal creates no package.
 *
 * renderPackage(input). input:
 *   export_id         server UUID of the export (3.1)
 *   created_at        ISO-8601 UTC creation time, given by the caller (this module has no clock)
 *   run               durable run view {owner_id, bot_id, run_id, contract, contract_hash, submission_hash, result}
 *   fixture           boolean, required. An engineering-scope contract must be a fixture.
 *   library_versions  the value frozen in the export row at build (not a current constant)
 *   risk_limits       {limit_name: decimal} for risk-profile.json; the caller took them from the current server hard limits
 *   trace             {equity, trades, decisions}, each {columns:[name], rows:[[cell]]}; cells are string, finite number, boolean or null
 *   units             optional {pine_variable: unit text} for the selected source inputs
 *   limitations       optional {codes:[CODE]}; the limitation codes of the build (for example RULES_VERSION_DIFFERS)
 *   exit_version      required, from the evaluated deployment, never defaulted (missing gives BI_BINDING_INCOMPLETE)
 *   holdout_boundary_ref  optional object, the registered boundary reference (3.2)
 * Returns a frozen {files, manifest, package_hash, binding_hash, binding}. files maps each of PACKAGE_FILES to UTF-8 text.
 * Multi-Pine membership is refused: the member layout of docs/MULTI_PINE_CONTRACT.md 6.2 is not part of this renderer.
 */
export const RENDER_REFUSAL_CODES=Object.freeze(['RENDER_INPUT_INVALID','RENDER_MULTI_PINE_UNSUPPORTED','RENDER_SOURCE_UNRESOLVED','RENDER_ASSEMBLE_FAILED',
  'RENDER_CONTENT_REFUSED','BI_FIXTURE_LABEL_MISSING','BI_MARKET_SCOPE_INVALID','BI_BINDING_INCOMPLETE']);
export const PACKAGE_MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
export const MAX_SOURCE_INPUTS=8;
const DEFAULT_SOURCE_UNIT='source input units';
const BRIDGE_UNITS=Object.freeze({atr_multiplier:'ATR multiple',rr:'reward to risk ratio'});
const BRIDGE_NAMES=Object.freeze(['atr_multiplier','rr']);
const DECIMAL=/^-?\d+(?:\.\d+)?$/;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMERIC_LITERAL=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** Contract 4.2: the artifact schemas and how the trace files tell native signals, intents, fills and position episodes apart. */
const ARTIFACT_SCHEMAS=Object.freeze({'inputs.json':'best-inputs-inputs-v1','indicator.json':'best-inputs-indicator-v1','risk-profile.json':'best-inputs-risk-profile-v1',
  'quant-data/metrics.json':'best-inputs-metrics-v1','quant-data/validation.json':'best-inputs-validation-v1','quant-data/equity.csv':'csv-rfc4180-lf-v1',
  'quant-data/trades.csv':'csv-rfc4180-lf-v1','quant-data/decisions.csv':'csv-rfc4180-lf-v1'});
const TRACE_SEMANTICS='Native signals are the alert() calls of indicator.pine and are listed in decisions.csv as decisions. Intents are the accepted, capped or rejected outcomes in decisions.csv. Fills are server-owned Paper fills and appear only as closed rows of trades.csv. A position episode is one row of trades.csv, from entry_time to exit_time. equity.csv is the equity curve of the evaluated run.';
const PARTITIONS=Object.freeze(['train','validation','test']);

const refuse=(code,detail='')=>Object.assign(new Error(code+(detail?': '+detail:'')),{code,detail});
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const text=value=>typeof value==='string'&&value.length>0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const invalid=detail=>refuse('RENDER_INPUT_INVALID',detail);
const deepFreeze=value=>{if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
const byKey=key=>(a,b)=>a[key]<b[key]?-1:a[key]>b[key]?1:0;

/** A value that survives JSON unchanged: plain objects, arrays, strings, booleans, null and finite numbers. */
function plain(value,path,depth=0){
  if(depth>40)throw invalid(path+' is nested too deeply');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))throw invalid(path+' is not a finite number');return;}
  if(Array.isArray(value)){value.forEach((item,index)=>plain(item,path+'['+index+']',depth+1));return;}
  if(isObject(value)){for(const key of Object.keys(value))plain(value[key],path+'.'+key,depth+1);return;}
  throw invalid(path+' is not plain data');
}
/** A detached deep copy of plain data. */
function copy(value,path){plain(value,path);return JSON.parse(JSON.stringify(value));}
const sortKeys=value=>Array.isArray(value)?value.map(sortKeys):isObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortKeys(value[key])])):value;
/** Canonical file text: keys sorted at every depth, two-space indent, one trailing line feed. */
const jsonText=value=>JSON.stringify(sortKeys(value),null,2)+'\n';

/** Writes a String(number) exponent form such as 1.5e-7 or 1e+21 as plain digits, by moving the decimal point, not by rounding. */
function expandExponent(form){
  const match=form.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if(!match)return form;
  const digits=match[2]+(match[3]??''),point=match[2].length+Number(match[4]);
  let whole,fraction;
  if(point<=0){whole='0';fraction='0'.repeat(-point)+digits;}
  else if(point>=digits.length){whole=digits+'0'.repeat(point-digits.length);fraction='';}
  else{whole=digits.slice(0,point);fraction=digits.slice(point);}
  whole=whole.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');
  return match[1]+whole+(fraction.length?'.'+fraction:'');
}
/** A decimal string that reads back to exactly the same number, or null. */
function decimalString(value){
  if(typeof value==='string')return DECIMAL.test(value)?value:null;
  if(!finite(value))return null;
  let out=String(value);
  if(/e/i.test(out))out=expandExponent(out);
  if(out==='-0')out='0';
  return DECIMAL.test(out)&&Number(out)===value?out:null;
}
const decimalOrRefuse=(value,path)=>{const out=decimalString(value);if(out===null)throw invalid(path+' has no exact decimal form');return out;};

/** Text for a Markdown line: whitespace runs become one space, HTML characters are escaped and Markdown punctuation is backslash-escaped. */
const escapeMarkdown=value=>escapeHtml(String(value).replace(/\s+/g,' ').trim()).replace(/[\\`*_[\]()#|!~]/g,'\\$&');
const escapeHtml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* ---- CSV ---- */

function csvCell(value,path){
  if(value===null)return '';
  if(typeof value==='boolean')return value?'true':'false';
  if(finite(value))return decimalOrRefuse(value,path);
  if(typeof value!=='string')throw invalid(path+' is not a CSV cell');
  return /[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;
}
function csvText(spec,name){
  if(!isObject(spec)||!Array.isArray(spec.columns)||!Array.isArray(spec.rows))throw invalid('trace.'+name+' must be {columns, rows}');
  const columns=spec.columns;
  if(columns.length===0||columns.some(column=>!text(column))||new Set(columns).size!==columns.length)throw invalid('trace.'+name+'.columns');
  const lines=[columns.map((column,index)=>csvCell(column,'trace.'+name+'.columns['+index+']')).join(',')];
  spec.rows.forEach((row,index)=>{
    if(!Array.isArray(row)||row.length!==columns.length)throw invalid('trace.'+name+'.rows['+index+'] must have '+columns.length+' cells');
    lines.push(row.map((cell,cellIndex)=>csvCell(cell,'trace.'+name+'.rows['+index+']['+cellIndex+']')).join(','));
  });
  return lines.join('\n')+'\n';
}

/* ---- source edits (4.2 indicator.pine: only selected numeric default literals change) ---- */

function sourceEdits(source,bindings,afterOf){
  const masked=executable(source),edits=[];
  for(const binding of bindings){
    // The anchored locator is shared with gate C2, which requires every disclosed edit to sit exactly where it finds the default.
    const found=explainBoundDefault(source,binding,masked);
    if(found.reason!==undefined)throw refuse('RENDER_SOURCE_UNRESOLVED',binding.pine_variable+': '+found.reason);
    if(!NUMERIC_LITERAL.test(found.before)||Number(found.before)!==binding.effective_value)throw refuse('RENDER_SOURCE_UNRESOLVED',binding.pine_variable+': default literal');
    const after=afterOf.get(binding.input_id);
    // An unchanged value keeps its original bytes: no edit.
    if(Number(after)!==Number(found.before))edits.push({input_id:binding.input_id,start:found.start,end:found.end,before:found.before,after});
  }
  edits.sort(byKey('start'));
  for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw refuse('RENDER_SOURCE_UNRESOLVED','overlapping edits');
  return edits;
}
function applyEdits(source,edits){
  let out='',cursor=0;
  for(const edit of edits){out+=source.slice(cursor,edit.start)+edit.after;cursor=edit.end;}
  return out+source.slice(cursor);
}

/* ---- file builders ---- */

function inputsOf(contract,selected,runId,unitOf){
  const lock=contract.input_lock,selection=lock.selection,parameters=selected.parameters,domains=lock.domains;
  const domainOf=(name,grid)=>{
    if(!Array.isArray(grid)||grid.length===0||!grid.every(finite))throw invalid('input_lock.domains.'+name);
    const step=grid.length>1?Number((grid[1]-grid[0]).toFixed(12)):0;
    return {min:decimalOrRefuse(grid[0],'domain '+name),max:decimalOrRefuse(grid[grid.length-1],'domain '+name),step:decimalOrRefuse(step,'domain step '+name)};
  };
  const expectedKeys=[...new Set([...selection.bindings.map(binding=>binding.pine_variable),...BRIDGE_NAMES])].sort(),givenKeys=Object.keys(parameters).sort();
  if(expectedKeys.length!==givenKeys.length||expectedKeys.some((key,index)=>key!==givenKeys[index]))
    throw invalid('selected parameters must be exactly the binding variables plus atr_multiplier and rr');
  const slots=[...selection.bindings].sort(byKey('slot')),sourceInputs=slots.map(binding=>{
    if(!['int','float'].includes(binding.type))throw invalid('binding '+binding.pine_variable+' is not numeric');
    const value=parameters[binding.pine_variable];
    if(!finite(value)||(binding.type==='int'&&!Number.isInteger(value)))throw invalid('selected parameter '+binding.pine_variable);
    return {slot:binding.slot,input_id:binding.input_id,pine_variable:binding.pine_variable,kind:binding.type,unit:unitOf(binding.pine_variable),
      before:decimalOrRefuse(binding.effective_value,'binding '+binding.pine_variable),after:decimalOrRefuse(value,'parameter '+binding.pine_variable),
      domain:domainOf(binding.pine_variable,domains[binding.pine_variable])};
  });
  if(sourceInputs.length>MAX_SOURCE_INPUTS)throw invalid('more than '+MAX_SOURCE_INPUTS+' selected source inputs');
  const bridge={};
  for(const name of BRIDGE_NAMES){
    const value=parameters[name];
    if(!finite(value))throw invalid('selected parameter '+name);
    bridge[name]={unit:BRIDGE_UNITS[name],before:decimalOrRefuse(selection.bridge[name],'bridge '+name),after:decimalOrRefuse(value,'parameter '+name),domain:domainOf(name,domains[name])};
  }
  const fixed=[...selection.fixed_inputs].sort(byKey('input_id')).map(item=>({input_id:item.input_id,pine_variable:item.pine_variable,value:item.effective_value}));
  const effective=effectiveInputHash(contract);
  if(effective===null)throw invalid('contract.input_lock.selection has no effective-input snapshot');
  return {run_id:runId,source_hash:contract.source_hash,effective_input_hash:effective,source_inputs:sourceInputs,bridge,fixed_inputs:fixed};
}

function indicatorMeta(source){
  const masked=executable(source),at=masked.search(/\bindicator\s*\(/),title=at<0?null:source.slice(at).match(/^indicator\s*\(\s*(?:title\s*=\s*)?"([^"\\\n]*)"/),
    version=source.match(/^\s*\/\/@version=(\d+)\s*$/m);
  return {name:title?title[1]:null,pine_version:version?Number(version[1]):null};
}

function setupGuide({exportId,runId,fixture,meta,inputs,market,exitVersion}){
  const rows=[...inputs.source_inputs.map(item=>'- '+item.pine_variable+' (slot '+item.slot+'): '+item.before+' to '+item.after+' '+escapeMarkdown(item.unit)),
    ...BRIDGE_NAMES.map(name=>'- Bridge '+name+': '+inputs.bridge[name].before+' to '+inputs.bridge[name].after+' '+inputs.bridge[name].unit)];
  return [`# Setup guide`,'',
    ...(fixture?['LABELLED ENGINEERING FIXTURE: synthetic data, not a research result and not a recommendation.','']:[]),
    `Status: DRAFT until a validation attempt passes. Export ${exportId}, run ${escapeMarkdown(runId)}.`,'',
    `Indicator: ${meta.name===null?'(unnamed)':escapeMarkdown(meta.name)}. Exit contract: ${exitVersion}.`,
    `Market: ${market.broker} BINANCE:${market.symbol} Spot, standard candles, chart timeframe ${market.timeframe} (one minute).`,'',
    '## Selected inputs','',...rows,'',
    '## Steps','',
    `1. Open a standard BINANCE:${market.symbol} Spot chart at timeframe ${market.timeframe}. The indicator stops with an error on any other chart type, symbol or timeframe.`,
    '2. Create a new Pine indicator in TradingView and paste indicator.pine completely and unchanged. Compile it and review every warning.',
    '3. Match every input in TradingView to the Selected inputs list above and to inputs.json. Source inputs not listed stay at their stored values.',
    '4. Disable native alert() calls of the source indicator through its existing inputs. If that is impossible, execution stays blocked.',
    '5. Create the alert with the condition set to this indicator and Any alert() function call. Enter the private webhook address shown by the application in TradingView only. Webhook addresses, keys and credentials are never part of this package.',
    '6. Leave the alert message field as the alert() calls of the indicator set it. Do not edit or replace the message.',
    '7. Missing verified bars wait up to five seconds without creating a Paper order. A timeout rejects the intent.',
    '8. Protection is observed at bar close and starts on the next bar. SL wins over TP and over native exits.',
    '9. Pine intents do not confirm inventory. The Paper worker controls accepted, capped and rejected fills and targeted exits.',
    '10. Replacing alerts requires a new deployment and preserved old exits.','',
    'No Quant support is implied by this package.',''].join('\n');
}

function metricsTable(metrics){
  const head='<tr><th>Metric</th>'+PARTITIONS.map(name=>'<th>'+name+'</th>').join('')+'</tr>';
  const body=[...METRIC_KEYS,'win_rate'].filter(key=>PARTITIONS.some(name=>Object.hasOwn(metrics[name],key))).map(key=>
    '<tr><td>'+escapeHtml(key)+'</td>'+PARTITIONS.map(name=>'<td>'+(Object.hasOwn(metrics[name],key)&&metrics[name][key]!==null?escapeHtml(metrics[name][key]):'')+'</td>').join('')+'</tr>');
  return '<table>'+head+body.join('')+'</table>';
}
const returnOf=part=>part&&part.net_return_percent!==undefined&&part.net_return_percent!==null?escapeHtml(part.net_return_percent):'not recorded';
function validationHtml({exportId,runId,createdAt,fixture,selected,metrics,inputs,exitVersion,engineHash,sourceHash}){
  const params=Object.keys(selected.parameters).sort().map(key=>'<tr><td>'+escapeHtml(key)+'</td><td>'+escapeHtml(selected.parameters[key])+'</td></tr>').join('');
  const neighbours=selected.sensitivity.map(item=>'<tr><td>'+escapeHtml(isObject(item)&&item.dimension!==undefined?item.dimension:'')+'</td><td>'+
    returnOf(isObject(item)&&isObject(item.result)?item.result.validation:undefined)+'</td></tr>').join('');
  return ['<!doctype html>','<html lang="en">','<head>','<meta charset="utf-8">','<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Best Inputs validation</title>',
    '<style>body{font-family:sans-serif;margin:16px;max-width:60rem}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #888;padding:4px 8px;text-align:left}.banner{border:2px solid #b00;padding:8px;font-weight:bold}</style>',
    '</head>','<body>','<h1>Best Inputs validation</h1>',
    ...(fixture?['<p class="banner">LABELLED ENGINEERING FIXTURE: synthetic data, not a research result and not a recommendation.</p>']:[]),
    `<p>Export ${escapeHtml(exportId)}. Run ${escapeHtml(runId)}. Created ${escapeHtml(createdAt)}. Source ${escapeHtml(sourceHash)}. Engine ${escapeHtml(engineHash)}.</p>`,
    '<h2>Selected parameters</h2>',`<table><tr><th>Parameter</th><th>Value</th></tr>${params}</table>`,
    `<p>${inputs.source_inputs.length} selected source input(s) and the Bridge pair. All other source inputs are fixed at their stored values.</p>`,
    '<h2>Metrics of the selected candidate</h2>',metricsTable(metrics),
    '<h2>Robustness</h2>',`<table><tr><th>Neighbour dimension</th><th>Validation return percent</th></tr>${neighbours}</table>`,
    `<p>Cost stress validation return percent: ${returnOf(selected.cost_stress&&selected.cost_stress.validation)}.</p>`,
    '<h2>Parity</h2>','<p>Not recorded at build. Parity, repaint and compile evidence is appended after the build and is shown from its records at read time.</p>',
    '<h2>Execution differences</h2>',
    `<p>Exit contract ${escapeHtml(exitVersion)}. Pine tracks hypothetical entries only. Broker fills, allocation quantities and rejection are server-owned. Protection is observed at bar close and starts on the next bar; SL wins over TP and over native exits.</p>`,
    '</body>','</html>',''].join('\n');
}

/* ---- the renderer ---- */

/** A calendar check the lenient Date.parse does not make: real month, day (leap years included) and time of day (no 24:00). */
function calendarValid(stamp){
  const [year,month,day,hour,minute,second]=stamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/).slice(1).map(Number);
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59;
}
function requireInput(input){
  if(!isObject(input))throw invalid('input');
  if(!text(input.export_id)||!UUID.test(input.export_id))throw invalid('export_id must be a UUID');
  if(typeof input.created_at!=='string'||!UTC.test(input.created_at)||Number.isNaN(Date.parse(input.created_at))||!calendarValid(input.created_at))throw invalid('created_at must be ISO-8601 UTC');
  if(typeof input.fixture!=='boolean')throw invalid('fixture must be a boolean');
  if(!isObject(input.library_versions))throw invalid('library_versions');
  if(!isObject(input.risk_limits)||Object.keys(input.risk_limits).length===0)throw invalid('risk_limits');
  if(!isObject(input.run))throw invalid('run');
  if(!isObject(input.trace))throw invalid('trace');
  // Contract 3.2: every binding field is required and nothing is defaulted; the exit version comes from the evaluated deployment.
  if(input.exit_version===undefined||input.exit_version===null)throw refuse('BI_BINDING_INCOMPLETE','exit_version');
  const exitVersion=input.exit_version;
  if(typeof exitVersion!=='string'||!SUPPORTED_EXIT_VERSIONS.includes(exitVersion))throw invalid('exit_version');
  if(input.units!==undefined&&(!isObject(input.units)||Object.values(input.units).some(unit=>!text(unit))))throw invalid('units');
  if(input.holdout_boundary_ref!==undefined&&!isObject(input.holdout_boundary_ref))throw invalid('holdout_boundary_ref');
  const codes=input.limitations===undefined?[]:isObject(input.limitations)&&(input.limitations.codes===undefined||Array.isArray(input.limitations.codes))?input.limitations.codes??[]:null;
  if(codes===null||codes.some(code=>typeof code!=='string'||!CODE_PATTERN.test(code)))throw invalid('limitations.codes');
  return {exitVersion,codes:[...new Set(codes)].sort()};
}
function requireRun(run){
  const {contract}=run;
  if(!text(run.owner_id)||!text(run.bot_id)||!text(run.run_id)||!isObject(contract)||!isObject(run.result))throw invalid('run owner_id, bot_id, run_id, contract and result');
  if(!/^[a-f0-9]{64}$/.test(run.contract_hash??'')||run.contract_hash!==hash(canonical(contract)))throw invalid('run.contract_hash does not match the contract');
  if(!/^[a-f0-9]{64}$/.test(run.submission_hash??''))throw invalid('run.submission_hash');
  const members=contract.snapshot?.membership;
  if(!Array.isArray(members)||members.length===0||!members.every(isObject))throw invalid('contract.snapshot.membership');
  if(members.length!==1)throw refuse('RENDER_MULTI_PINE_UNSUPPORTED','membership of '+members.length);
  if(members[0].pine_import_id!==contract.pine_import_id||members[0].source_version!==contract.source_version||members[0].source_hash!==contract.source_hash)
    throw invalid('contract.snapshot.membership[0] differs from the contract pine_import_id, source_version or source_hash');
  const selection=contract.input_lock?.selection;
  if(!isObject(contract.input_lock)||!isObject(selection)||!Array.isArray(selection.bindings)||!selection.bindings.every(isObject)||!Array.isArray(selection.fixed_inputs)||
    !selection.fixed_inputs.every(isObject)||!isObject(selection.bridge)||!isObject(selection.signals)||!isObject(contract.input_lock.domains))throw invalid('contract.input_lock.selection');
  if(!text(contract.source)||contract.source_hash!==hash(contract.source))throw invalid('contract.source does not match contract.source_hash');
  for(const name of ['buy','exit'])if(typeof selection.signals[name]!=='string'||!/^[A-Za-z_]\w*$/.test(selection.signals[name]))throw invalid('selection.signals.'+name);
  const market=contract.snapshot.market;
  if(!isObject(market)||market.broker!==PACKAGE_MARKET.broker||market.symbol!==PACKAGE_MARKET.symbol||market.timeframe!==PACKAGE_MARKET.timeframe)throw refuse('BI_MARKET_SCOPE_INVALID');
  if(!isObject(contract.dataset))throw invalid('contract.dataset');
  const selected=selectedOf(run.result);
  if(selected===null||!isObject(selected.parameters)||!isObject(selected.result)||!isObject(selected.result.train)||!isObject(selected.result.validation)||
    !isObject(selected.test)||!Array.isArray(selected.sensitivity)||!isObject(selected.cost_stress))throw invalid('run.result.selected is incomplete');
  return selected;
}

export function renderPackage(input){
  const {exitVersion,codes}=requireInput(input),run=input.run,selected=requireRun(run),contract=run.contract,fixture=input.fixture;
  if(contract.scope===ENGINEERING_SCOPE&&fixture!==true)throw refuse('BI_FIXTURE_LABEL_MISSING');
  const unitOf=variable=>input.units?.[variable]??DEFAULT_SOURCE_UNIT;
  const market={broker:contract.snapshot.market.broker,symbol:contract.snapshot.market.symbol,timeframe:contract.snapshot.market.timeframe};
  const members=contract.snapshot.membership.map(member=>({pine_import_id:member.pine_import_id,source_version:member.source_version,source_hash:member.source_hash}));
  const {bars:_bars,...datasetRef}=contract.dataset;

  // inputs.json and the approved source edits
  const inputs=copy(inputsOf(contract,copy(selected,'run.result.selected'),run.run_id,unitOf),'inputs');
  const bindings=contract.input_lock.selection.bindings,afterOf=new Map(inputs.source_inputs.map(item=>[item.input_id,item.after]));
  const edits=sourceEdits(contract.source,bindings,afterOf);
  const deployment={deployment_id:contract.deployment_id,pine_import_id:contract.pine_import_id,source_version:contract.source_version,broker:market.broker,symbol:market.symbol,timeframe:market.timeframe};
  let indicator;
  try{
    indicator=assemble(applyEdits(contract.source,edits),{bridge:{atr_multiplier:Number(inputs.bridge.atr_multiplier.after),rr:Number(inputs.bridge.rr.after)},
      signals:{buy:contract.input_lock.selection.signals.buy,exit:contract.input_lock.selection.signals.exit},bindings:[],fixed_inputs:[]},deployment).integrated_pine;
  }catch(error){throw refuse('RENDER_ASSEMBLE_FAILED',typeof error?.code==='string'?error.code:'assemble');}
  if(typeof indicator!=='string'||indicator.length===0)throw refuse('RENDER_ASSEMBLE_FAILED','empty output');
  // The package is indicator-only (INDICATOR_REQUIRED): one indicator() declaration and no strategy() in the executable code.
  let code;
  try{code=executable(indicator);}catch{throw refuse('RENDER_CONTENT_REFUSED','indicator.pine is not scannable');}
  if([...code.matchAll(/\bindicator\s*\(/g)].length!==1||/\bstrategy\s*(?:\(|\.)/.test(code))throw refuse('RENDER_CONTENT_REFUSED','INDICATOR_REQUIRED');

  // binding tuple (3.2): every field from the run, nothing defaulted
  const slotBindings=[...bindings].sort(byKey('slot')).map(item=>({slot:item.slot,input_id:item.input_id,pine_variable:item.pine_variable}));
  const binding=copy({owner_id:run.owner_id,bot_id:run.bot_id,run_id:run.run_id,contract_hash:run.contract_hash,submission_hash:run.submission_hash,
    deployment_id:contract.deployment_id,pine_import_id:contract.pine_import_id,source_version:contract.source_version,source_hash:contract.source_hash,
    baseline_snapshot_hash:contract.baseline_snapshot_hash,input_lock_hash:contract.input_lock.lock_hash,slot_bindings:slotBindings,
    bridge_domains:{atr_multiplier:contract.input_lock.domains.atr_multiplier,rr:contract.input_lock.domains.rr},effective_input_hash:effectiveInputHash(contract),
    policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,capital:contract.capital,ledger_initialization:contract.ledger_initialization,
    model:contract.model,cost_model_version:contract.model?.version,dataset_ref:datasetRef,split:contract.split,engine_hash:contract.engine_hash,rules:contract.rules,
    acceptance_blockers:contract.acceptance_blockers,library_versions:input.library_versions,
    library_record_ref:{run_id:run.run_id,result_sha256:hash(canonical(run.result))},alert_source:'alert_calls',exit_version:exitVersion,market,mode:'ONE_PINE',
    pine_count:1,membership:[...members].sort(byKey('pine_import_id')),fixture,created_at:input.created_at,
    ...(input.holdout_boundary_ref===undefined?{}:{holdout_boundary_ref:input.holdout_boundary_ref})},'binding');
  if(!bindingComplete(binding))throw refuse('BI_BINDING_INCOMPLETE');

  // risk-profile.json
  const limits=Object.fromEntries(Object.keys(input.risk_limits).sort().map(name=>[name,decimalOrRefuse(input.risk_limits[name],'risk_limits.'+name)]));
  const riskProfile=copy({policy_version:contract.policy_version,policy_hash:contract.snapshot.policy_hash,policy:contract.snapshot.policy,limits},'risk-profile');

  // quant-data
  const result=copy(selected,'run.result.selected');
  const metrics={train:result.result.train,validation:result.result.validation,test:result.test};
  const validation={candidate:{parameters:result.parameters,result:result.result},sensitivity:result.sensitivity,cost_stress:result.cost_stress,holdout:{test:result.test},
    parity:{state:'NOT_RECORDED_AT_BUILD'}};
  const meta=indicatorMeta(contract.source);
  const indicatorJson=copy({indicator:{name:meta.name,version:contract.source_version},pine_version:meta.pine_version,selected_slots:slotBindings,
    fixed_inputs:inputs.fixed_inputs,alert_source:'alert_calls',exit_version:exitVersion,symbol:'BINANCE:'+market.symbol,timeframe:market.timeframe,edits,
    assumptions:{cost_model_version:contract.model?.version,model:contract.model,capital:contract.capital,ledger_initialization:contract.ledger_initialization}},'indicator.json');

  const files={
    'inputs.json':jsonText(inputs),
    'indicator.pine':indicator,
    'indicator.json':jsonText(indicatorJson),
    'risk-profile.json':jsonText(riskProfile),
    'setup-guide.md':setupGuide({exportId:input.export_id,runId:run.run_id,fixture,meta,inputs,market,exitVersion}),
    'validation.html':validationHtml({exportId:input.export_id,runId:run.run_id,createdAt:input.created_at,fixture,selected:result,metrics,inputs,exitVersion,
      engineHash:contract.engine_hash,sourceHash:contract.source_hash}),
    'quant-data/metrics.json':jsonText(metrics),
    'quant-data/equity.csv':csvText(input.trace.equity,'equity'),
    'quant-data/trades.csv':csvText(input.trace.trades,'trades'),
    'quant-data/decisions.csv':csvText(input.trace.decisions,'decisions'),
    'quant-data/validation.json':jsonText(validation)};
  const limitationText=(fixture?'Labelled engineering fixture. Not a research result and not a recommendation.':
    'Validation evidence (compile record, native and Bridge parity, repaint, dataset alignment) is attached after the build. This package is not validated until a validation attempt passes.')+
    (codes.length?' Limitation codes: '+codes.join(', ')+'.':'');
  const manifest=buildManifest({identity:{export_id:input.export_id,bot_id:run.bot_id,run_id:run.run_id,created_at:input.created_at},binding,
    inputs:{inputs_sha256:hash(files['inputs.json'])},evidence:{engine_hash:contract.engine_hash,run_id:run.run_id,result_sha256:hash(canonical(run.result)),
      artifact_schemas:ARTIFACT_SCHEMAS,trace_semantics:TRACE_SEMANTICS},
    limitations:{text:limitationText,codes},fixture,files});
  files[MANIFEST_PATH]=jsonText(manifest);

  // The renderer is the last line before storage: refuse content the C1 scan would refuse, and a file set that is not the canonical set.
  const ordered=Object.fromEntries(PACKAGE_FILES.map(path=>[path,files[path]]));
  if(Object.keys(files).length!==PACKAGE_FILES.length||PACKAGE_FILES.some(path=>typeof ordered[path]!=='string'))throw refuse('RENDER_CONTENT_REFUSED','file set');
  const found=[...new Set(PACKAGE_FILES.flatMap(path=>scanContent(ordered[path])))];
  if(found.length)throw refuse('RENDER_CONTENT_REFUSED',found.join(','));

  const parsed=JSON.parse(ordered[MANIFEST_PATH]);
  return deepFreeze({files:ordered,manifest:parsed,package_hash:packageHash(parsed),binding_hash:bindingHash(binding),binding});
}
