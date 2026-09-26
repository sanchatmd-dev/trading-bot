import {canonical,hash} from '../../src/pine-bridge/source.js';
export const source='//@version=6\nindicator("Synthetic queue fixture")\nbuySignal=false\nsellSignal=false';
export const bounds={emaFastInput:[50,30,70,10],emaSlowInput:[200,150,250,25],atrLenInput:[14,10,20,2],stFactorInput:[3.2,2.4,4,.4],zoneAtrMultInput:[1.15,.75,1.55,.2],setupExpiryInput:[48,24,72,12],cooldownInput:[8,4,12,2],confirmLookback:[5,3,7,1]};
export function fixture(){
 const settings={preset:'Custom',tradeDirectionectionection:'Long + Exit',useSlowFilter:true,useMTF:false,useRSIFilter:false,requireBOS:false,requireSweep:false,slMode:'Zone + ATR',useSession:false,confirmMode:'Any',notifyEnabled:false};
 const values={...Object.fromEntries(Object.entries(bounds).map(([k,v])=>[k,v[0]])),slAtrBufferInput:.6,minRiskATRInput:.5,...settings};
 while(Object.keys(values).length<58)values['fixed_'+Object.keys(values).length]=false;
 const inputs=Object.entries(values).map(([pine_variable,effective_value],i)=>({input_id:'input_'+i,pine_variable,effective_value,type:typeof effective_value==='number'?(Number.isInteger(effective_value)?'int':'float'):typeof effective_value==='boolean'?'bool':'string',eligible:pine_variable in bounds,origin:'source',declared_domain:{min:null,max:null}}));
 const analysis={inputs,declarations:['buySignal','sellSignal'],effective_inputs_hash:hash(canonical(values))};
 analysis.effective_input_review={source_hash:hash(source),effective_inputs_hash:analysis.effective_inputs_hash,input_count:58,reviewed_by:'synthetic-test',reviewed_at:1};
 const selection={signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bridge:{atr_multiplier:60,rr:1.5}};
 const slots=Object.entries(bounds).map(([name,v],i)=>({slot:i+3,input_id:inputs.find(r=>r.pine_variable===name).input_id,min:v[1],max:v[2],step:v[3]}));
 return {analysis,selection,slots,bridge_domains:{atr_multiplier:{min:40,max:80,step:10},rr:{min:1,max:2,step:.25}}};
}
