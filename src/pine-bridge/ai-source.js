// Versioned AI-only view. Pine output is always assembled from original bytes.
// Preserve literals, indentation, line continuations and the version directive.
export const aiSourceViewVersion='pine-ai-view-v1';
export function aiSourceView(source) {
  let quote=null;const lines=[];
  for(const line of source.split('\n')){
    const insideAtStart=quote!==null;let out='';
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(quote){out+=c;if(c==='\\'&&i+1<line.length)out+=line[++i];else if(c===quote)quote=null;continue;}
      if(c==='"'||c==="'"){quote=c;out+=c;continue;}
      if(c==='/'&&line[i+1]==='/'){
        if(!out.trim()&&/^\/\/@version=\d+\s*$/.test(line.slice(i)))out+=line.slice(i);
        break;
      }
      out+=c;
    }
    if(insideAtStart||quote||out.trim())lines.push(insideAtStart||quote?out:out.trimEnd());
  }
  return lines.join('\n');
}
