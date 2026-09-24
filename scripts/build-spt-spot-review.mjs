import fs from 'node:fs/promises';
import path from 'node:path';
import {hash} from '../src/pine-bridge/source.js';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: build-spt-spot-review.mjs INPUT_PINE .qa-local/OUTPUT.pine');
const target=path.resolve(output),privateRoot=path.resolve('.qa-local');
if(!target.startsWith(privateRoot+path.sep)||!target.endsWith('.pine'))throw new Error('Output must be a private .pine file under .qa-local');
const original=await fs.readFile(input,'utf8');
const sourceHash=hash(original);
if(sourceHash!=='2f353c49721c8daf24e366409eaf6eac49f945da955a0df8bd52862f2e7e3277')throw new Error('SPT baseline hash mismatch');
let text=original.replaceAll('\r\n','\n');
function once(before,after){
  const first=text.indexOf(before);
  if(first<0||text.indexOf(before,first+before.length)>=0)throw new Error('Expected unique source anchor missing: '+before.slice(0,70));
  text=text.slice(0,first)+after+text.slice(first+before.length);
}
function section(start,end,replacement){
  const a=text.indexOf(start),b=text.indexOf(end,a+start.length);
  if(a<0||b<0||text.indexOf(start,a+start.length)>=0||text.indexOf(end,b+end.length)>=0)throw new Error('Expected unique section missing');
  text=text.slice(0,a)+replacement+'\n\n'+text.slice(b);
}
once('"SPT PRO Indicator",','"SPT PRO Indicator — Spot review",');
once('// - Simulated backtest dashboard inside indicator','// - Indicative long-only Spot backtest dashboard; not Bot/Quant results');
once('// - Buy/Sell signal-based entries','// - BUY candidates and bearish EXIT candidates for Spot long positions');
once('"Both Long & Short",\n     "Trade Direction",\n     options = ["Both Long & Short", "Long only", "Short only"]','"Long + Exit",\n     "Spot Signal Mode",\n     options = ["Long + Exit", "Long only", "Exit only"]');
text=text.replaceAll('tradeDirectionectionection == "Both Long & Short"','tradeDirectionectionection == "Long + Exit"').replaceAll('tradeDirectionectionection == "Short only"','tradeDirectionectionection == "Exit only"');
text=text.replaceAll('allowShort','allowExitSignal');
once('"Close and reverse on opposite signal"','"Close long on opposite signal"');
once('"Enable simulated backtest"','"Enable indicative long-only backtest (no fees)"');
section('// BACKTEST ENGINE INSIDE INDICATOR','// TRADE STATE FOR VISUAL TP/SL',`// BACKTEST ENGINE INSIDE INDICATOR — INDICATIVE SPOT LONG ONLY
// No shorts, fees or slippage. Bot/Quant own actual position accounting.
btInDate = not btUseDateFilter or time >= btStartTime
btRR = f_targetRR()

var int btPos = 0
var int btStartBar = na
var float btEntry = na
var float btSL = na
var float btTarget = na
var float btRisk = na
var int btTrades = 0
var int btWins = 0
var int btLosses = 0
var int btLongTrades = 0
var int btLongWins = 0
var int btExitSignals = 0
var float btNetR = 0.0
var float btGrossWinR = 0.0
var float btGrossLossR = 0.0
var float btPeakR = 0.0
var float btMaxDDR = 0.0
var float btLastR = na
var int btWinStreak = 0
var int btLossStreak = 0
var int btMaxWinStreak = 0
var int btMaxLossStreak = 0

btHasOpen = btPos == 1
btCanCheck = btEnable and btInDate and btHasOpen and not na(btStartBar) and bar_index > btStartBar and barstate.isconfirmed
btLongSLHit = btCanCheck and low <= btSL
btLongTPHit = btCanCheck and high >= btTarget
btBothHit = btLongSLHit and btLongTPHit
btExitBySL = btBothHit ? btSameBarMode == "Conservative" : btLongSLHit
btExitByTP = btBothHit ? btSameBarMode == "Optimistic" : btLongTPHit
btOppositeSignal = btEnable and btInDate and btAllowReverse and btHasOpen and barstate.isconfirmed and sellSignal
btExitNow = btExitBySL or btExitByTP or btOppositeSignal

if btExitNow
    exitR = btExitByTP ? btRR : btExitBySL ? -1.0 : (close - btEntry) / btRisk
    btTrades += 1
    btLastR := exitR
    btNetR += exitR
    if btOppositeSignal and not btExitBySL and not btExitByTP
        btExitSignals += 1
    if exitR > 0
        btWins += 1
        btGrossWinR += exitR
        btLongWins += 1
        btWinStreak += 1
        btLossStreak := 0
        btMaxWinStreak := math.max(btMaxWinStreak, btWinStreak)
    else
        btLosses += 1
        btGrossLossR += math.abs(exitR)
        btLossStreak += 1
        btWinStreak := 0
        btMaxLossStreak := math.max(btMaxLossStreak, btLossStreak)
    btPeakR := math.max(btPeakR, btNetR)
    btMaxDDR := math.max(btMaxDDR, btPeakR - btNetR)
    btPos := 0
    btStartBar := na
    btEntry := na
    btSL := na
    btTarget := na
    btRisk := na

btOpenLong = btEnable and btInDate and buySignal and btPos == 0
if btOpenLong
    _entry = close
    _sl = longSLPreview
    _risk = _entry - _sl
    if _risk > 0
        btPos := 1
        btStartBar := bar_index
        btEntry := _entry
        btSL := _sl
        btRisk := _risk
        btTarget := _entry + _risk * btRR
        btLongTrades += 1

btWinRate = btTrades > 0 ? 100.0 * btWins / btTrades : na
btProfitFactor = btGrossLossR > 0 ? btGrossWinR / btGrossLossR : na
btExpectancy = btTrades > 0 ? btNetR / btTrades : na
btLongWinRate = btLongTrades > 0 ? 100.0 * btLongWins / btLongTrades : na
btOpenR = btHasOpen and not na(btRisk) and btRisk > 0 ? (close - btEntry) / btRisk : na`);
section('// REGISTER NEW SHORT VISUAL TRADE','// VISUAL TP / SL HIT DETECTION',`// LONG EXIT CANDIDATE — no synthetic short position or short TP/SL.
if sellSignal
    bool hadLong = tradeActive and tradeDirectionection == 1
    tradeDirectionection := 0
    tradeActive := false
    // Preserve the original opposite-signal cooldown effect.
    tradeStartBar := bar_index
    tradeStatus := hadLong ? "Long exit signal" : "Exit signal while flat"
    longSetupActive := false
    shortSetupActive := false
    tradeEntry := na
    tradeEntryLow := na
    tradeEntryHigh := na
    tradeSL := na
    tradeTP1 := na
    tradeTP2 := na
    tradeTP3 := na
    tradeTP4 := na
    tradeTP5 := na
    tp1WasHit := false
    tp2WasHit := false
    tp3WasHit := false
    tp4WasHit := false
    tp5WasHit := false
    slWasHit := false`);
for(let n=1;n<=5;n++)once(`(tradeDirectionection == 1 ? high >= tradeTP${n} : low <= tradeTP${n})`,`high >= tradeTP${n}`);
once('(tradeDirectionection == 1 ? low <= tradeSL : high >= tradeSL)','low <= tradeSL');
once('if eventName == "BUY"\n        _side := "LONG"\n    else if eventName == "SELL"\n        _side := "SHORT"\n    else if dir == 1\n        _side := "LONG"\n    else if dir == -1\n        _side := "SHORT"','if eventName == "BUY"\n        _side := "LONG"\n    else if eventName == "SELL"\n        _side := "EXIT_LONG"\n    else if dir == 1\n        _side := "LONG"\n    else if dir == -1\n        _side := "EXIT_LONG"');
once('"Short setup zone touched"','"Bearish exit setup zone touched"');
once('"New SELL signal confirmed on candle close"','"Long exit candidate confirmed on candle close"');
once('title = "Short Setup"','title = "Bearish Exit Setup"');
once('title = "SELL Signal"','title = "Long EXIT Candidate"');
once('text = "SELL",','text = "EXIT",');
text=text.replaceAll('"SELL / SHORT"','"EXIT LONG"').replaceAll('"New SELL signal"','"New long EXIT candidate"').replaceAll('"Short setup"','"Bearish exit setup"');
once('btPos == 1 ? "Open Long" :\n         btPos == -1 ? "Open Short" :\n         "Flat"','btPos == 1 ? "Open Long" : "Flat"');
once('    shortWRText =\n         na(btShortWinRate) ? "—" : str.tostring(btShortWinRate, "#.##") + "%"\n\n','');
once('"Short Trades",\n         str.tostring(btShortTrades) + " | WR " + shortWRText','"Opposite Exits",\n         str.tostring(btExitSignals)');
once('btPos == 0 ? "No position" :\n         btPos == 1 ? "Long" :\n         "Short",\n         btPos == 1 ? color.new(color.green, 0) :\n         btPos == -1 ? color.new(color.red, 0) :\n         color.new(color.gray, 0)','btPos == 1 ? "Long" : "No position",\n         btPos == 1 ? color.new(color.green, 0) : color.new(color.gray, 0)');
text=text.replaceAll('btPos == 1 ? color.new(color.green, 0) :\n         btPos == -1 ? color.new(color.red, 0) :\n         color.new(color.gray, 0)','btPos == 1 ? color.new(color.green, 0) : color.new(color.gray, 0)');
once('title = "SPT PRO SELL",\n     message = "SPT PRO SELL on {{ticker}} {{interval}}"','title = "SPT PRO LONG EXIT",\n     message = "SPT PRO LONG EXIT on {{ticker}} {{interval}}"');
if(/btShort|btOpenShort|btPos\s*:=\s*-1|"SHORT"|"Short active"/.test(text))throw new Error('Short simulation remains in adapted source');
await fs.mkdir(path.dirname(target),{recursive:true});
await fs.writeFile(target,text,{mode:0o600,flag:'wx'});
console.log(JSON.stringify({original_hash:sourceHash,adapted_hash:hash(text),output:target,original_lines:original.split('\n').length,adapted_lines:text.split('\n').length}));
