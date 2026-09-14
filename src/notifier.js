import net from 'node:net';
import tls from 'node:tls';

const clean=value=>String(value||'').replace(/[\r\n]/g,' ');
export class EmailNotifier{
  constructor(config){this.config=config;}
  async send(to,subject,text){if(!this.config.host||!to)return false;try{await smtpSend(this.config,{to,subject:clean(subject),text});return true;}catch(error){console.error('Email notification failed:',error.message);return false;}}
}
async function smtpSend(config,message){
  let socket=config.secure?tls.connect({host:config.host,port:config.port,servername:config.host}):net.connect({host:config.host,port:config.port});
  socket.setEncoding('utf8');let buffer='';const wait=expected=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SMTP timeout')),10000);const onData=chunk=>{buffer+=chunk;const lines=buffer.split('\r\n');const last=lines.filter(Boolean).at(-1)||'';if(/^\d{3} /.test(last)){socket.off('data',onData);clearTimeout(timer);const code=Number(last.slice(0,3));buffer='';if(!expected.includes(code))reject(new Error(`SMTP ${last}`));else resolve(last);}};socket.on('data',onData);socket.once('error',reject);});
  const command=async(line,codes)=>{socket.write(`${line}\r\n`);return wait(codes);};
  await wait([220]);await command('EHLO astra-trade',[250]);
  if(!config.secure){await command('STARTTLS',[220]);socket=tls.connect({socket,servername:config.host});socket.setEncoding('utf8');buffer='';await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject);});await command('EHLO astra-trade',[250]);}
  if(config.user){await command('AUTH LOGIN',[334]);await command(Buffer.from(config.user).toString('base64'),[334]);await command(Buffer.from(config.password).toString('base64'),[235]);}
  const fromMatch=config.from.match(/<([^>]+)>/);const from=fromMatch?fromMatch[1]:config.from;
  await command(`MAIL FROM:<${clean(from)}>` ,[250]);await command(`RCPT TO:<${clean(message.to)}>` ,[250,251]);await command('DATA',[354]);
  const body=String(message.text).replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');socket.write(`From: ${clean(config.from)}\r\nTo: ${clean(message.to)}\r\nSubject: ${message.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);await wait([250]);await command('QUIT',[221]);socket.end();
}
