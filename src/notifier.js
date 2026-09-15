import net from 'node:net';
import tls from 'node:tls';

const clean=value=>String(value||'').replace(/[\r\n]/g,' ');
export class EmailNotifier {
  constructor(config){this.config=config;}
  async send(to,subject,text){
    if(!this.config.host||!to)return false;
    try{await smtpSend(this.config,{to,subject:clean(subject),text});return true;}
    catch(error){console.error('Email notification failed:',error.message);return false;}
  }
}

async function smtpSend(config,message) {
  let socket=config.secure
    ?tls.connect({host:config.host,port:config.port,servername:config.host})
    :net.connect({host:config.host,port:config.port});
  // Keep the entire attempt bounded, including connect/TLS and a slow SMTP peer.
  const deadline=setTimeout(()=>socket.destroy(new Error('SMTP attempt timeout')),20000);
  const ignoreError=()=>{};
  socket.on('error',ignoreError);
  const wait=expected=>new Promise((resolve,reject)=>{
    let buffer='';
    const cleanup=()=>{socket.off('data',onData);socket.off('error',onError);socket.off('close',onClose);};
    const onError=error=>{cleanup();reject(error);};
    const onClose=()=>onError(new Error('SMTP connection closed'));
    const onData=chunk=>{
      buffer+=chunk.toString('utf8');
      if(buffer.length>65536)return onError(new Error('SMTP response too large'));
      if(!buffer.endsWith('\r\n'))return;
      const last=buffer.trimEnd().split('\r\n').at(-1);
      if(!/^\d{3} /.test(last))return;
      cleanup();
      const code=Number(last.slice(0,3));
      if(expected.includes(code))resolve();else reject(new Error(`SMTP rejected request (${code})`));
    };
    socket.on('data',onData);socket.once('error',onError);socket.once('close',onClose);
  });
  const command=(line,codes)=>{const response=wait(codes);socket.write(`${line}\r\n`);return response;};
  try {
    await wait([220]);await command('EHLO astra-trade',[250]);
    if(!config.secure){
      await command('STARTTLS',[220]);
      socket=tls.connect({socket,servername:config.host});socket.on('error',ignoreError);
      await new Promise((resolve,reject)=>{
        const fail=error=>{socket.off('secureConnect',ready);reject(error);};
        const ready=()=>{socket.off('error',fail);resolve();};
        socket.once('secureConnect',ready);socket.once('error',fail);
      });
      await command('EHLO astra-trade',[250]);
    }
    if(config.user){
      await command('AUTH LOGIN',[334]);
      await command(Buffer.from(config.user).toString('base64'),[334]);
      await command(Buffer.from(config.password).toString('base64'),[235]);
    }
    const from=config.from.match(/<([^>]+)>/)?.[1]||config.from;
    await command(`MAIL FROM:<${clean(from)}>`,[250]);
    await command(`RCPT TO:<${clean(message.to)}>`,[250,251]);
    await command('DATA',[354]);
    const body=String(message.text).replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');
    const accepted=wait([250]);
    socket.write(`From: ${clean(config.from)}\r\nTo: ${clean(message.to)}\r\nSubject: ${message.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);
    await accepted;await command('QUIT',[221]);
  } finally {clearTimeout(deadline);socket.destroy();}
}
