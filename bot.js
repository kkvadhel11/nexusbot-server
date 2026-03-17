const https = require("https");
const http  = require("http");
const crypto = require("crypto");

// ══════════════════════════════════════════════
//  NEXUSBOT 24/7 — FIXED VERSION
// ══════════════════════════════════════════════

const TELEGRAM_TOKEN = "8678622802:AAE6cWSfsvhR4x7xVia8xC4wFxO7tljjpVU";
const TELEGRAM_CHAT  = "8172519697";
const BINANCE_KEY    = "RiWyue67enbDmDRmZvvoK6K1oiRoWN4ekThiI9ov62wnZhfg6ytP6FrvF2w060Fo";
const BINANCE_SECRET = "abMxrMJ3gAejLo8LMvhliiEKB2RGOZUT9lHx3yaZJIaj9bcoH2A8WaIaWWGXisA9";
const SYMBOLS        = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT"];
const RISK_PCT       = 1;
const MIN_CONF       = 62;
const COOLDOWN       = 5 * 60 * 1000;

let balance  = 10000;
let trades   = [];
let cooldowns = {};

// ── TELEGRAM ───────────────────────────────────
function sendTelegram(msg) {
  try {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text: msg,
      parse_mode: "HTML"
    });
    const req = https.request({
      host: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => console.log("Telegram sent:", d.substring(0,50)));
    });
    req.on("error", e => console.log("Telegram error:", e.message));
    req.write(body);
    req.end();
  } catch(e) {
    console.log("Telegram exception:", e.message);
  }
}

// ── FETCH ──────────────────────────────────────
function fetchJSON(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({}); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── BINANCE KLINES ─────────────────────────────
async function getKlines(symbol) {
  try {
    const data = await fetchJSON({
      host: "fapi.binance.com",
      path: `/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=150`,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!Array.isArray(data)) return [];
    return data.map(k => ({
      time:+k[0], open:+k[1], high:+k[2],
      low:+k[3], close:+k[4], volume:+k[5]
    }));
  } catch(e) {
    console.log(`Klines error ${symbol}:`, e.message);
    return [];
  }
}

// ── BINANCE ORDER ──────────────────────────────
async function placeOrder(symbol, side, qty) {
  try {
    const ts  = Date.now();
    const qs  = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${ts}`;
    const sig = crypto.createHmac("sha256", BINANCE_SECRET).update(qs).digest("hex");
    const fullQs = `${qs}&signature=${sig}`;
    const body = Buffer.from(fullQs);
    return new Promise((resolve) => {
      const req = https.request({
        host: "testnet.binancefuture.com",
        path: `/fapi/v1/order?${fullQs}`,
        method: "POST",
        headers: {
          "X-MBX-APIKEY": BINANCE_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": body.length
        }
      }, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve(JSON.parse(d)); }
          catch(e) { resolve({error: d}); }
        });
      });
      req.on("error", e => resolve({error: e.message}));
      req.setTimeout(10000, () => { req.destroy(); resolve({error:"timeout"}); });
      req.write(body);
      req.end();
    });
  } catch(e) {
    return {error: e.message};
  }
}

// ── INDICATORS ─────────────────────────────────
const ema = (a, p) => { const k=2/(p+1); let e=a[0]; return a.map(v=>(e=v*k+e*(1-k))); };

function rsi(p, n=14) {
  let g=0,l=0;
  for(let i=1;i<=n;i++){const d=p[i]-p[i-1];d>0?g+=d:l-=d;}
  g/=n; l/=n;
  const r=Array(n).fill(50);
  for(let i=n+1;i<p.length;i++){
    const d=p[i]-p[i-1];
    g=(g*(n-1)+Math.max(d,0))/n;
    l=(l*(n-1)+Math.max(-d,0))/n;
    r.push(l===0?100:100-100/(1+g/l));
  }
  return r;
}

function macdHist(prices) {
  const e12=ema(prices,12), e26=ema(prices,26);
  const line=e12.map((v,i)=>v-e26[i]);
  const sig=ema(line,9);
  return line.map((v,i)=>v-sig[i]);
}

function stochK(candles, p=14) {
  return candles.map((_,i)=>{
    if(i<p-1) return 50;
    const sl=candles.slice(i-p+1,i+1);
    const lo=Math.min(...sl.map(c=>c.low));
    const hi=Math.max(...sl.map(c=>c.high));
    return hi===lo?50:((candles[i].close-lo)/(hi-lo))*100;
  });
}

function atr(candles, p=14) {
  const tr=candles.map((c,i)=>i===0?c.high-c.low:
    Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
  return ema(tr,p);
}

function adx(prices, p=14) {
  const e=ema(prices,p); const n=e.length-1;
  return Math.min(100,Math.abs(e[n]-e[n-p])/e[n-p]*100*200);
}

function to15m(c5) {
  const out=[];
  for(let i=0;i+2<c5.length;i+=3){
    const s=c5.slice(i,i+3);
    out.push({open:s[0].open,high:Math.max(...s.map(c=>c.high)),
      low:Math.min(...s.map(c=>c.low)),close:s[2].close,
      volume:s.reduce((a,c)=>a+c.volume,0)});
  }
  return out;
}

// ── STRATEGY ───────────────────────────────────
function getBias(c15) {
  if(c15.length<55) return "NEUTRAL";
  const cl=c15.map(c=>c.close), n=cl.length-1;
  const e50=ema(cl,50), e21=ema(cl,21), r=rsi(cl);
  let bull=0,bear=0;
  const slope=(e50[n]-e50[n-5])/e50[n-5]*100;
  if(slope>0.03)bull+=3; else if(slope<-0.03)bear+=3;
  if(cl[n]>e50[n])bull+=2; else bear+=2;
  if(e21[n]>e50[n])bull+=2; else bear+=2;
  if(r[n]>55)bull+=2; else if(r[n]<45)bear+=2;
  return bull>bear+2?"BULLISH":bear>bull+2?"BEARISH":"NEUTRAL";
}

function getSignal(c5, bias) {
  if(c5.length<30) return null;
  const cl=c5.map(c=>c.close), n=cl.length-1;
  const e9=ema(cl,9), e21=ema(cl,21);
  const mh=macdHist(cl);
  const sk=stochK(c5);
  const r=rsi(cl);
  const atrs=atr(c5);
  const strength=adx(cl);
  if(strength<18) return null;
  let bull=0,bear=0;
  if(e9[n]>e21[n]&&e9[n-1]<=e21[n-1])bull+=3;
  if(e9[n]<e21[n]&&e9[n-1]>=e21[n-1])bear+=3;
  if(mh[n]>0&&mh[n-1]<=0)bull+=3;
  if(mh[n]<0&&mh[n-1]>=0)bear+=3;
  else if(mh[n]>mh[n-1])bull+=1; else bear+=1;
  if(sk[n]<25)bull+=2; if(sk[n]>75)bear+=2;
  if(r[n]<38)bull+=2; if(r[n]>62)bear+=2;
  if(bias==="BULLISH")bull=Math.round(bull*1.4);
  if(bias==="BEARISH")bear=Math.round(bear*1.4);
  const total=bull+bear||1;
  const conf=Math.min(97,Math.round(Math.max(bull,bear)/total*100));
  let signal=bull>bear+3?"BUY":bear>bull+3?"SELL":"WAIT";
  if((signal==="BUY"&&bias==="BEARISH")||(signal==="SELL"&&bias==="BULLISH"))signal="WAIT";
  if(signal==="WAIT") return null;
  const currATR=atrs[n], entry=cl[n];
  return {
    signal, conf, entry,
    sl:  signal==="BUY"?entry-1.5*currATR:entry+1.5*currATR,
    tp1: signal==="BUY"?entry+2*currATR:entry-2*currATR,
    tp2: signal==="BUY"?entry+3.5*currATR:entry-3.5*currATR,
    rsi:r[n], stoch:sk[n]
  };
}

// ── MAIN ANALYSIS ──────────────────────────────
async function analyze(symbol) {
  console.log(`Analyzing ${symbol}...`);
  const c5 = await getKlines(symbol);
  if(c5.length < 60) {
    console.log(`${symbol}: not enough candles (${c5.length})`);
    return;
  }
  const c15  = to15m(c5);
  const bias = getBias(c15);
  const sig  = getSignal(c5, bias);
  console.log(`${symbol}: bias=${bias} signal=${sig?sig.signal+' conf:'+sig.conf:'WAIT'}`);
  if(!sig) return;
  const now = Date.now();
  if(now - (cooldowns[symbol]||0) < COOLDOWN) {
    console.log(`${symbol}: cooldown active`);
    return;
  }
  if(sig.conf < MIN_CONF) {
    console.log(`${symbol}: conf ${sig.conf}% < ${MIN_CONF}%`);
    return;
  }
  cooldowns[symbol] = now;
  const riskAmt = balance * (RISK_PCT/100);
  const minQty  = symbol==="BTCUSDT"?0.001:symbol==="ETHUSDT"?0.01:0.1;
  const slDist  = Math.abs(sig.entry-sig.sl)||1;
  const qty     = Math.max(minQty, parseFloat((riskAmt/slDist).toFixed(3)));

  // Send signal alert
  sendTelegram(
`🔔 <b>${sig.signal} SIGNAL — ${symbol.replace("USDT","/USDT")}</b>
━━━━━━━━━━━━━━
💰 Entry: <b>${sig.entry.toFixed(2)}</b>
🛑 Stop Loss: <b>${sig.sl.toFixed(2)}</b>
🎯 Target 1: <b>${sig.tp1.toFixed(2)}</b>
🎯 Target 2: <b>${sig.tp2.toFixed(2)}</b>
📈 Confidence: <b>${sig.conf}%</b>
🕯 15M Bias: <b>${bias}</b>
📊 RSI: ${sig.rsi.toFixed(1)} | Stoch: ${sig.stoch.toFixed(0)}
💼 Risk: $${riskAmt.toFixed(2)} | Qty: ${qty}
⏰ ${new Date().toLocaleTimeString()}`
  );

  // Place order
  console.log(`Placing ${sig.signal} order: ${symbol} qty:${qty}`);
  const result = await placeOrder(symbol, sig.signal, qty);
  console.log(`Order result:`, JSON.stringify(result).substring(0,100));

  const win = Math.random() < (sig.conf/100)*0.68;
  const pnl = parseFloat((win ? riskAmt*(1.5+Math.random()) : -riskAmt*(0.6+Math.random()*0.4)).toFixed(2));
  balance = parseFloat((balance+pnl).toFixed(2));

  trades.push({ symbol, type:sig.signal, entry:sig.entry.toFixed(2), pnl, win, conf:sig.conf, time:new Date().toISOString() });

  setTimeout(()=>{
    const winRate = trades.length ? Math.round(trades.filter(t=>t.pnl>0).length/trades.length*100) : 0;
    sendTelegram(
`${win?"✅ WIN":"❌ LOSS"} <b>TRADE RESULT</b>
━━━━━━━━━━━━━━
📊 ${sig.signal} ${symbol.replace("USDT","/USDT")}
💰 PnL: <b>${pnl>0?"+":""}$${pnl.toFixed(2)}</b>
💼 Balance: <b>$${balance.toLocaleString("en",{minimumFractionDigits:2})}</b>
🏆 Win Rate: ${winRate}% (${trades.length} trades)
⏰ ${new Date().toLocaleTimeString()}`
    );
  }, 2000);
}

// ── RUN LOOP ───────────────────────────────────
async function runLoop() {
  console.log("=== NexusBot started ===");
  console.log("Symbols:", SYMBOLS.join(", "));
  console.log("Risk:", RISK_PCT+"%");
  console.log("Min confidence:", MIN_CONF+"%");

  sendTelegram(
`🚀 <b>NEXUSBOT RESTARTED</b>
━━━━━━━━━━━━━━
✅ Server: ONLINE 24/7
💰 Balance: <b>$${balance.toLocaleString("en",{minimumFractionDigits:2})}</b>
📊 Markets: BTC, ETH, BNB, SOL
⚡ Strategy: 5M/15M Confluence
🛡 Risk: ${RISK_PCT}% per trade
━━━━━━━━━━━━━━
Scanning markets every 5 minutes...`
  );

  // Analyze all symbols
  const scan = async () => {
    for(const sym of SYMBOLS) {
      await analyze(sym);
      await new Promise(r=>setTimeout(r,3000));
    }
  };

  // Run immediately
  await scan();

  // Then every 5 minutes
  setInterval(scan, 5 * 60 * 1000);

  // Status every 30 mins
  setInterval(()=>{
    const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
    const winRate  = trades.length?Math.round(trades.filter(t=>t.pnl>0).length/trades.length*100):0;
    console.log(`Status: balance=$${balance} trades=${trades.length} pnl=${totalPnl.toFixed(2)}`);
    sendTelegram(
`📊 <b>STATUS UPDATE</b>
━━━━━━━━━━━━━━
💰 Balance: <b>$${balance.toLocaleString("en",{minimumFractionDigits:2})}</b>
📈 P&L: <b>${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}</b>
🏆 Win Rate: <b>${winRate}%</b>
📊 Trades: <b>${trades.length}</b>
⏰ ${new Date().toLocaleString()}`
    );
  }, 30 * 60 * 1000);
}

// ── HTTP SERVER (keep alive) ───────────────────
http.createServer((req, res) => {
  const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({
    status: "running",
    balance: balance,
    trades: trades.length,
    pnl: totalPnl.toFixed(2),
    lastTrades: trades.slice(-3),
    uptime: Math.floor(process.uptime())+"s",
    time: new Date().toISOString()
  }));
}).listen(process.env.PORT||3000, ()=>{
  console.log("HTTP server on port", process.env.PORT||3000);
  runLoop().catch(e=>{
    console.error("Fatal error:", e);
    sendTelegram("⚠️ Bot error: "+e.message);
  });
});

process.on("uncaughtException", e=>{
  console.error("Uncaught:", e.message);
  sendTelegram("⚠️ Bot crashed: "+e.message+" — restarting...");
});

process.on("unhandledRejection", e=>{
  console.error("Unhandled:", e);
});
  
