import {registerHooks} from 'node:module';

// Test-only bootstrap substitution for actual-app HTTP on native Windows.
// It intercepts exactly one module URL. The real validators and health helper
// remain unchanged. This does not prove native Linux policy-file trust.
const target=new URL('../../src/postgres/quant-capacity-policy.js',import.meta.url).href;
const real=target+'?r6-test-real-capacity-policy';
const contract=new URL('../../src/quant-research/contract.js',import.meta.url).href;
registerHooks({load(url,context,nextLoad){
  if(url===contract&&process.env.PF2_HTTP_SYNTHETIC_SOURCE_HASH){
    const identity=process.env.PF2_HTTP_SYNTHETIC_SOURCE_HASH;
    if(!/^[a-f0-9]{64}$/.test(identity))throw Error('Invalid synthetic source identity');
    const loaded=nextLoad(url,context);
    const original=Buffer.from(loaded.source).toString('utf8');
    const source=original.replace(/export const SOURCE_HASH='[a-f0-9]{64}';/,
      "export const SOURCE_HASH='"+identity+"';");
    if(source===original)throw Error('Synthetic source substitution target missing');
    return {...loaded,source};
  }
  if(url!==target)return nextLoad(url,context);
  return {format:'module',shortCircuit:true,source:[
    "import {readFileSync} from 'node:fs';",
    'import {validateQuantCapacityPolicy} from '+JSON.stringify(real)+';',
    'export {assertCapacityPolicyEvaluator,validateQuantCapacityPolicy,createProfileRuntimeHealth} from '+JSON.stringify(real)+';',
    'export async function loadQuantCapacityPolicy(filename=process.env.QUANT_CAPACITY_POLICY_FILE){',
    "  return validateQuantCapacityPolicy(JSON.parse(readFileSync(filename,'utf8')));",
    '}',
  ].join('\n')};
}});
