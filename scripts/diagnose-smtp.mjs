#!/usr/bin/env node
/**
 * SMTP Diagnostic Script for Robot Trade
 * 
 * Tests direct SMTP connection with verbose protocol logging
 * to identify exact causes of SMTP 550 or other failure codes.
 * 
 * Usage:
 *   node scripts/diagnose-smtp.mjs [recipient@example.com]
 */

import net from 'node:net';
import tls from 'node:tls';
import { config } from '../src/config.js';

const targetTo = process.argv[2] || config.adminEmail || 'test@example.com';

console.log('=== SMTP Configuration Diagnostic ===');
console.log('Host:       ', config.smtp.host || '(not set)');
console.log('Port:       ', config.smtp.port);
console.log('Secure:     ', config.smtp.secure);
console.log('User:       ', config.smtp.user ? `${config.smtp.user.slice(0, 3)}***` : '(not set)');
console.log('Password:   ', config.smtp.password ? '****** (configured)' : '(not set)');
console.log('From:       ', config.smtp.from);
console.log('Target To:  ', targetTo);
console.log('=====================================\n');

if (!config.smtp.host) {
  console.error('ERROR: SMTP_HOST is not configured in environment.');
  process.exit(1);
}

// Check for common Gmail misconfiguration:
if (config.smtp.host.includes('gmail.com')) {
  const fromEmail = config.smtp.from.match(/<([^>]+)>/)?.[1] || config.smtp.from;
  if (config.smtp.user && fromEmail && config.smtp.user.toLowerCase() !== fromEmail.toLowerCase()) {
    console.warn('⚠️ WARNING (Gmail Check):');
    console.warn(`SMTP_USER (${config.smtp.user}) does not match SMTP_FROM email (${fromEmail}).`);
    console.warn('Gmail often rejects this with "550 5.7.1 Sender address rejected".');
    console.warn('Recommendation: Set SMTP_FROM to match your Gmail user, e.g.:');
    console.warn(`  SMTP_FROM="Robot Trade <${config.smtp.user}>"\n`);
  }
}

async function runVerboseSmtpTest() {
  console.log(`Connecting to ${config.smtp.host}:${config.smtp.port}...`);
  
  let socket = config.smtp.secure
    ? tls.connect({ host: config.smtp.host, port: config.smtp.port, servername: config.smtp.host })
    : net.connect({ host: config.smtp.host, port: config.smtp.port });

  const deadline = setTimeout(() => {
    socket.destroy(new Error('SMTP connection timed out after 20s'));
  }, 20000);

  let buffer = '';

  const send = (cmd) => {
    console.log(`>>> ${cmd.startsWith('AUTH') || cmd.length > 30 && !cmd.includes('@') ? '[CREDENTIALS_HIDDEN]' : cmd}`);
    socket.write(`${cmd}\r\n`);
  };

  const readResponse = () => new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      buffer += text;
      process.stdout.write(`<<< ${text}`);
      
      const lines = buffer.trimEnd().split('\r\n');
      const lastLine = lines.at(-1);
      // SMTP final line format: "XYZ text" (hyphen "XYZ-text" indicates multi-line continuation)
      if (/^\d{3} /.test(lastLine)) {
        socket.off('data', onData);
        socket.off('error', onError);
        buffer = '';
        const code = Number(lastLine.slice(0, 3));
        resolve({ code, line: lastLine, allLines: lines });
      }
    };
    const onError = (err) => {
      socket.off('data', onData);
      reject(err);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });

  try {
    let res = await readResponse();
    if (res.code !== 220) throw new Error(`Unexpected greeting: ${res.line}`);

    send('EHLO astra-trade.io');
    res = await readResponse();

    if (!config.smtp.secure) {
      send('STARTTLS');
      res = await readResponse();
      if (res.code !== 220) throw new Error(`STARTTLS rejected: ${res.line}`);

      console.log('Upgrading socket to TLS...');
      socket = tls.connect({ socket, servername: config.smtp.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      console.log('TLS handshake established successfully.');

      send('EHLO astra-trade.io');
      res = await readResponse();
    }

    if (config.smtp.user) {
      send('AUTH LOGIN');
      res = await readResponse();
      if (res.code !== 334) throw new Error(`AUTH LOGIN rejected: ${res.line}`);

      send(Buffer.from(config.smtp.user).toString('base64'));
      res = await readResponse();
      if (res.code !== 334) throw new Error(`Username rejected: ${res.line}`);

      send(Buffer.from(config.smtp.password).toString('base64'));
      res = await readResponse();
      if (res.code !== 235) throw new Error(`Authentication failed: ${res.line}`);
      console.log('Authentication successful!');
    }

    const fromEmail = config.smtp.from.match(/<([^>]+)>/)?.[1] || config.smtp.from;
    send(`MAIL FROM:<${fromEmail.trim()}>`);
    res = await readResponse();
    if (res.code !== 250) throw new Error(`MAIL FROM rejected: ${res.line}`);

    send(`RCPT TO:<${targetTo.trim()}>`);
    res = await readResponse();
    if (![250, 251].includes(res.code)) throw new Error(`RCPT TO rejected: ${res.line}`);

    send('DATA');
    res = await readResponse();
    if (res.code !== 354) throw new Error(`DATA initiation rejected: ${res.line}`);

    const dateHeader = new Date().toUTCString();
    const msgId = `<diag-${Date.now()}@${config.smtp.host}>`;
    const emailBody = [
      `From: ${config.smtp.from}`,
      `To: ${targetTo}`,
      `Subject: Robot Trade SMTP Diagnostic Test`,
      `Date: ${dateHeader}`,
      `Message-ID: ${msgId}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `This is a diagnostic test message from Robot Trade at ${new Date().toISOString()}.`,
      `If you received this, your SMTP configuration is completely healthy!`,
      `.`
    ].join('\r\n');

    console.log('Sending message body with Date & Message-ID headers...');
    socket.write(`${emailBody}\r\n`);
    res = await readResponse();
    if (res.code !== 250) throw new Error(`Message data rejected: ${res.line}`);

    send('QUIT');
    await readResponse();
    console.log('\n✅ SUCCESS: Diagnostic test email accepted by SMTP server without errors!');
  } catch (err) {
    console.error(`\n❌ SMTP DIAGNOSTIC FAILED:`, err.message);
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

runVerboseSmtpTest();
