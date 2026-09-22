import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function classify(paths){
  let node=false,quant=false;
  for(const path of paths){
    if(path.startsWith('quant_lab/')){quant=true;continue;}
    if(path.startsWith('docs/')||['Context.md','README.md'].includes(path))continue;
    node=true;
    if(path.startsWith('src/')||path.startsWith('test/')||path.startsWith('.github/')||
      path.startsWith('scripts/')||['package.json','package-lock.json','.dockerignore','.gitattributes'].includes(path))quant=true;
  }
  return {node,quant};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let result={node:true,quant:true};
  try{
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    const base=event.pull_request?.base.sha||event.before;
    const head=event.pull_request?.head.sha||event.after;
    if(base&&head&&!/^0+$/.test(base)){
      const paths=execFileSync('git',['diff','--name-only','-z',base,head],{encoding:'utf8'}).split('\0').filter(Boolean);
      result=classify(paths);
    }
  }catch{/* Missing history or an unknown event runs both suites. */}
  for(const [key,value]of Object.entries(result))appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
}
