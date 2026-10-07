import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// The API serves index.html with no-cache and every other static file with public,max-age=3600, so a browser can
// combine a new index.html with an hour-old copy of an asset whose ?v= token did not change. Each entry pins the
// token index.html loads an asset with and the first 16 hex digits of the SHA-256 of the asset's bytes (line
// endings normalized to LF, so a CRLF checkout matches the Git blob). An asset whose bytes change fails here until
// index.html gives it a new token and this entry records that token and the new digest.
const PINNED={
  '/styles.css':['robot21','501cab31ce9c8259'],
  '/styles-v2.css':['pa1','3c176609e0f7ac70'],
  '/research-job.css':['rj1','debdaa1caa20c7e0'],
  '/market-chart.css':['mc3','40b284a5bccd776f'],
  '/theme-hud.css':['hud1','0b7476dcce91be79'],
  '/i18n.js':['rel20261007','7e2483aaae8ead51'],
  '/app.js':['rel20261007','e5c805b49a8669be'],
  '/analytics.js':['rel20261007','6ae87c8d66996569'],
  '/bots.js':['rel20261007','f5f66ce505852150'],
  '/account.js':['robot21','fec1e058941955eb'],
  '/login.js':['robot21','56cb3e0126f6a122'],
  '/security-ui.js':['robot21','03054577f116d8dd'],
  '/install-shortcut.css':['robot21','2d94092e96e18381'],
  '/install-shortcut.js':['robot21','7e26ce2ba57a138b'],
  '/chart-indicators.js':['mc3','950f4cec25935f21'],
  '/interactive-chart.js':['mc3','5c3502ab4053f58c'],
  '/quant-lab.js':['rel20261007','e4519c2794793c24'],
  '/bridge-wizard.js':['ux1a','793e4724786f57b8'],
  '/pine-bridge.js':['s4b1','f1b33ebc7c5cc5a5'],
  '/readiness.js':['md1','4d2273a9ffd44747'],
  '/research-library.js':['rel20261007','7c30eeab079486fd'],
  '/research-job.js':['rj1','ffd1319d6cb583f4'],
  '/journey.js':['pa1','8afa02a6c985b4d3'],
  '/overview.js':['ov1','4a6b152db44a2a2d'],
  '/setup-guide.js':['sg1','0dd4be17dc729d4f'],
  '/research-nav.js':['rn1','4de9b9e136d0c461']
};

const publicFile=name=>new URL('../public'+name,import.meta.url);
const digest=bytes=>createHash('sha256').update(bytes.toString('latin1').replaceAll('\r\n','\n'),'latin1').digest('hex').slice(0,16);

test('an asset whose bytes change gets a new ?v= token in index.html',()=>{
  const html=fs.readFileSync(publicFile('/index.html'),'utf8');
  const references=[...html.matchAll(/(?:src|href)="(\/[^"?]+)\?v=([^"]*)"/g)].map(([,asset,token])=>({asset,token}));
  assert.deepEqual(references.map(reference=>reference.asset).sort(),Object.keys(PINNED).sort(),
    'each cache-busted asset is loaded once and has one pinned entry');
  for(const {asset,token} of references){
    const [pinnedToken,pinnedDigest]=PINNED[asset],current=digest(fs.readFileSync(publicFile(asset)));
    if(current!==pinnedDigest)
      assert.notEqual(token,pinnedToken,asset+' changed but index.html still loads it with ?v='+token+'; give it a new token');
    assert.deepEqual({token,digest:current},{token:pinnedToken,digest:pinnedDigest},
      asset+': record its current token and digest in PINNED');
  }
});