/* ═══════════════════════════════════════════════════════════
   ATL · Market Analyser — main.js
   AlphaTradersLabs Proprietary System
   ═══════════════════════════════════════════════════════════ */

const ATL = (() => {

  /* ─────────────────────────────────────────────────────────
     CONFIG & STATE
  ───────────────────────────────────────────────────────── */
  const CFG = {
    bf: 'https://fapi.binance.com/fapi/v1',
    bd: 'https://fapi.binance.com/futures/data',
    by: 'https://api.bybit.com/v5/market',
    cg: 'https://api.coingecko.com/api/v3',
    CREDS: { user: 'test', pass: 'test' },
    TF_MAP: {
      '1':'1m','3':'3m','5':'5m','15':'15m','30':'30m',
      '60':'1h','120':'2h','240':'4h','360':'6h','720':'12h',
      'D':'1d','3D':'3d','W':'1w'
    },
    // Bybit V5 uses numeric minutes or special strings
    BY_TF_MAP: {
      '1':'1','3':'3','5':'5','15':'15','30':'30',
      '60':'60','120':'120','240':'240','360':'360','720':'720',
      'D':'D','3D':'3D','W':'W'
    },
    HTF_STACK: {
      '1':  ['15','60','240','D','W'],
      '5':  ['15','60','240','D','W'],
      '15': ['60','240','D','W'],
      '30': ['60','240','D','W'],
      '60': ['240','D','W'],
      '120':['240','D','W'],
      '240':['D','W'],
      '360':['D','W'],
      '720':['D','W'],
      'D':  ['W'],
      '3D': ['W'],
      'W':  ['W']
    },
    SCAN_BATCH: 3,
    MIN_CANDLES: 100,
    DATA_STALE_MS: 60000
  };

  const STATE = {
    loggedIn: false,
    currentView: 'single',
    selectedTF: '15',
    marketScanTF: '15',
    scanResults: { longs: [], shorts: [], watch: [] },
    scanAborted: false,
    scanRunning: false,
    lastScanTS: null,
    symbolList: [],
    stripInterval: null,
    clockInterval: null
  };

  /* ─────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────── */
  function init() {
    _bindTFSelectors();
    _startClock();
    _detectTZ();
    document.getElementById('login-user').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
    document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
  }

  /* ─────────────────────────────────────────────────────────
     AUTH
  ───────────────────────────────────────────────────────── */
  function login() {
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value.trim();
    const err = document.getElementById('login-error');
    if(u === CFG.CREDS.user && p === CFG.CREDS.pass) {
      err.classList.add('hidden');
      document.getElementById('login-screen').style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app-shell').classList.remove('hidden');
        document.getElementById('app-shell').style.animation = 'fadeInUp 0.4s ease';
        _bootApp();
      }, 300);
    } else {
      err.classList.remove('hidden');
      document.getElementById('login-pass').value = '';
      document.getElementById('login-pass').focus();
    }
  }

  function logout() {
    STATE.loggedIn = false;
    clearInterval(STATE.stripInterval);
    clearInterval(STATE.clockInterval);
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('login-screen').style.animation = 'fadeInUp 0.3s ease';
    document.getElementById('login-user').value = '';
    document.getElementById('login-pass').value = '';
  }

  function _bootApp() {
    STATE.loggedIn = true;
    _startStrip();
    _checkAPIStatus();
  }

  /* ─────────────────────────────────────────────────────────
     CLOCK + TZ
  ───────────────────────────────────────────────────────── */
  function _detectTZ() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? '+' : '-';
      const hrs = String(Math.floor(Math.abs(offset)/60)).padStart(2,'0');
      const mins = String(Math.abs(offset)%60).padStart(2,'0');
      document.getElementById('tz-label').textContent = `UTC${sign}${hrs}:${mins}`;
    } catch(e) {}
  }

  function _startClock() {
    STATE.clockInterval = setInterval(() => {
      const now = new Date();
      const t = now.toLocaleTimeString('en-GB',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const el = document.getElementById('tz-time');
      if(el) el.textContent = t;
    }, 1000);
  }

  /* ─────────────────────────────────────────────────────────
     TOP STRIP — live BTC/ETH prices
  ───────────────────────────────────────────────────────── */
  async function _startStrip() {
    await _updateStrip();
    STATE.stripInterval = setInterval(_updateStrip, 15000);
  }

  async function _updateStrip() {
    try {
      const [btc, eth] = await Promise.allSettled([
        _fetch(`${CFG.bf}/ticker/price?symbol=BTCUSDT`),
        _fetch(`${CFG.bf}/ticker/price?symbol=ETHUSDT`)
      ]);
      if(btc.status==='fulfilled') _setEl('strip-btc', '$'+_fmt(parseFloat(btc.value.price),0));
      if(eth.status==='fulfilled') _setEl('strip-eth', '$'+_fmt(parseFloat(eth.value.price),0));

      const cgGlobal = await _fetch(`${CFG.cg}/global`).catch(()=>null);
      if(cgGlobal?.data) {
        const dom = cgGlobal.data.market_cap_percentage?.btc;
        const total = cgGlobal.data.total_market_cap?.usd;
        if(dom) _setEl('strip-dom', dom.toFixed(1)+'%');
        if(total) _setEl('strip-total', '$'+_fmtBig(total));
      }
    } catch(e) {}
  }

  /* ─────────────────────────────────────────────────────────
     API STATUS CHECK
  ───────────────────────────────────────────────────────── */
  async function _checkAPIStatus() {
    const checks = [
      { url: `${CFG.bf}/ping`, dot: null },
      { url: `${CFG.by}/time`, dot: 'dot-bybit' },
      { url: `${CFG.cg}/ping`, dot: 'dot-cg' }
    ];
    for(const c of checks) {
      try {
        await _fetch(c.url);
        if(c.dot) _setDot(c.dot, 'green');
      } catch(e) {
        if(c.dot) _setDot(c.dot, 'red');
      }
    }
  }

  function _setDot(id, color) {
    const el = document.getElementById(id);
    if(!el) return;
    el.className = `status-dot ${color}`;
  }

  /* ─────────────────────────────────────────────────────────
     VIEW SWITCHING
  ───────────────────────────────────────────────────────── */
  function switchView(v) {
    STATE.currentView = v;
    document.querySelectorAll('.view').forEach(el => {
      el.classList.remove('active');
      el.classList.add('hidden');
    });
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const vEl = document.getElementById(`view-${v}`);
    if(vEl) { vEl.classList.remove('hidden'); vEl.classList.add('active'); }
    const nEl = document.getElementById(`nav-${v}`);
    if(nEl) nEl.classList.add('active');
  }

  /* ─────────────────────────────────────────────────────────
     TF SELECTOR BINDING
  ───────────────────────────────────────────────────────── */
  function _bindTFSelectors() {
    document.querySelectorAll('#single-tf-selector .tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#single-tf-selector .tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.selectedTF = btn.dataset.tf;
      });
    });
    document.querySelectorAll('#market-setup-panel .tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#market-setup-panel .tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.marketScanTF = btn.dataset.tf;
      });
    });
  }

  /* ═══════════════════════════════════════════════════════
     SINGLE ASSET ANALYSIS
  ═══════════════════════════════════════════════════════ */
  async function runSingleAnalysis() {
    const rawTicker = document.getElementById('single-ticker').value.trim().toUpperCase();
    if(!rawTicker) { _pulse('single-ticker'); return; }
    const symbol = rawTicker.replace(/USDT$/,'') + 'USDT';
    const tf = STATE.selectedTF;

    _showSingleLoading(symbol);

    try {
      // ── STEP 1: OHLCV ──────────────────────────────────
      _setStep('ohlcv','active','Fetching OHLCV data across all timeframes...');
      const ohlcvData = await _fetchAllOHLCV(symbol, tf);
      _setStep('ohlcv','done');

      // ── STEP 2: DERIVATIVES ────────────────────────────
      _setStep('deriv','active','Fetching funding rate, OI history, taker ratio...');
      const derivData = await _fetchDerivatives(symbol);
      _setStep('deriv','done');

      // ── STEP 3: META ───────────────────────────────────
      _setStep('meta','active','Fetching asset meta from CoinGecko...');
      const metaData = await _fetchMeta(rawTicker.replace(/USDT$/,''));
      _setStep('meta','done');

      // ── STEP 4: TOP-DOWN STRUCTURE ─────────────────────
      _setStep('structure','active','Computing market structure across all timeframes...');
      const structureData = _computeTopDownStructure(ohlcvData, tf);
      _setStep('structure','done');

      // ── STEP 5: ZONES ──────────────────────────────────
      _setStep('zones','active','Mapping Order Blocks, FVGs, and liquidity clusters...');
      const zoneData = _computeZones(ohlcvData, tf);
      _setStep('zones','done');

      // ── STEP 6: SESSION / AMD ──────────────────────────
      _setStep('session','active','Detecting AMD phase and session timing...');
      const sessionData = _computeSession();
      _setStep('session','done');

      // ── STEP 7: TRADE PLAN ─────────────────────────────
      _setStep('trade','active','Generating trade plan with entry, SL, and TP levels...');
      const tradePlan = _generateTradePlan(ohlcvData, structureData, zoneData, derivData, tf);
      _setStep('trade','done');

      // ── STEP 8: SCORING ────────────────────────────────
      _setStep('score','active','Running 16-point confluence scoring...');
      const score = _computeScore(structureData, zoneData, sessionData, derivData, tradePlan);
      _setStep('score','done');

      await _sleep(400);

      // ── RENDER ─────────────────────────────────────────
      const report = { symbol, tf, ohlcvData, derivData, metaData, structureData, zoneData, sessionData, tradePlan, score };
      _renderSingleReport(report);

    } catch(err) {
      _showSingleError(err.message || 'Failed to fetch data. Check ticker and try again.');
    }
  }

  /* ─────────────────────────────────────────────────────────
     DATA FETCHERS
  ───────────────────────────────────────────────────────── */
  async function _fetchAllOHLCV(symbol, execTF) {
    const stack = _buildTFStack(execTF);
    const results = {};
    await Promise.allSettled(stack.map(async tf => {
      try {
        const url = `${CFG.bf}/klines?symbol=${symbol}&interval=${CFG.TF_MAP[tf]||'15m'}&limit=300`;
        const raw = await _fetchRaw(url);
        results[tf] = _parseKlines(raw);
      } catch(e) {
        try {
          const byInterval = CFG.BY_TF_MAP[tf] || '15';
          const url = `${CFG.by}/kline?category=linear&symbol=${symbol}&interval=${byInterval}&limit=300`;
          const raw = await _fetchRaw(url);
          results[tf] = _parseKlinesBybit(raw?.result?.list || []);
        } catch(e2) {
          results[tf] = [];
        }
      }
    }));
    return results;
  }

  // Lean 3-TF version for market scan — Binance primary, Bybit fallback
  async function _fetchAllOHLCV_scan(symbol, execTF) {
    const scanStack = {
      '5':  ['W','240','5'],  '15': ['W','240','15'],
      '30': ['W','240','30'], '60': ['W','240','60'],
      '120':['W','240','120'],'240':['W','240'],
      '360':['W','360'],      '720':['W','720'],
      'D':  ['W','D'],        '3D': ['W','3D'],  'W': ['W']
    };
    const stack = scanStack[execTF] || ['W','240','15'];
    const results = {};
    await Promise.allSettled(stack.map(async tf => {
      try {
        // Try Binance first
        const url = `${CFG.bf}/klines?symbol=${symbol}&interval=${CFG.TF_MAP[tf]||'15m'}&limit=200`;
        const raw = await _fetchRaw(url);
        results[tf] = _parseKlines(raw);
      } catch(e) {
        try {
          // Fallback: Bybit V5
          const byInterval = CFG.BY_TF_MAP[tf] || '15';
          const url = `${CFG.by}/kline?category=linear&symbol=${symbol}&interval=${byInterval}&limit=200`;
          const raw = await _fetchRaw(url);
          results[tf] = _parseKlinesBybit(raw?.result?.list || []);
        } catch(e2) {
          results[tf] = [];
        }
      }
    }));
    return results;
  }

  async function _fetchDerivatives(symbol) {
    const [premium, funding, oiHist, takerRatio, lsRatio] = await Promise.allSettled([
      _fetchRaw(`${CFG.bf}/premiumIndex?symbol=${symbol}`),
      _fetchRaw(`${CFG.bf}/fundingRate?symbol=${symbol}&limit=24`),
      _fetchRaw(`${CFG.bd}/openInterestHist?symbol=${symbol}&period=1h&limit=48`),
      _fetchRaw(`${CFG.bd}/takerlongshortRatio?symbol=${symbol}&period=1h&limit=24`),
      _fetchRaw(`${CFG.bd}/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=24`)
    ]);

    // Check if Binance derivatives data is largely empty (rate limited)
    const binanceFailed = funding.status !== 'fulfilled' && oiHist.status !== 'fulfilled';
    if(binanceFailed) {
      // Bybit fallback for derivatives
      return _fetchDerivativesBybit(symbol);
    }

    return {
      premiumIndex: premium.status==='fulfilled' ? premium.value : null,
      fundingHistory: funding.status==='fulfilled' ? funding.value : [],
      oiHistory: oiHist.status==='fulfilled' ? oiHist.value : [],
      takerRatio: takerRatio.status==='fulfilled' ? takerRatio.value : [],
      lsRatio: lsRatio.status==='fulfilled' ? lsRatio.value : []
    };
  }

  async function _fetchMeta(coin) {
    try {
      const search = await _fetch(`${CFG.cg}/search?query=${coin.toLowerCase()}`);
      if(!search?.coins?.length) return null;
      const id = search.coins[0].id;
      const data = await _fetch(`${CFG.cg}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`);
      return {
        id,
        name: data.name,
        symbol: data.symbol?.toUpperCase(),
        rank: data.market_cap_rank,
        volume24h: data.market_data?.total_volume?.usd,
        marketCap: data.market_data?.market_cap?.usd,
        ath: data.market_data?.ath?.usd,
        atl: data.market_data?.atl?.usd,
        priceChange24h: data.market_data?.price_change_percentage_24h
      };
    } catch(e) {
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────
     KLINE PARSER
  ───────────────────────────────────────────────────────── */
  function _parseKlines(raw) {
    if(!Array.isArray(raw)) return [];
    return raw.map(k => ({
      ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      vol: +k[5], closeTs: k[6], quoteVol: +k[7], trades: +k[8],
      takerBase: +k[9], takerQuote: +k[10]
    }));
  }

  // Bybit V5 kline format: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
  // Note: Bybit returns newest-first, so we reverse to match Binance chronological order
  function _parseKlinesBybit(raw) {
    if(!Array.isArray(raw)) return [];
    return raw.slice().reverse().map(k => ({
      ts: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      vol: +k[5], closeTs: +k[0] + 60000, quoteVol: +k[6], trades: 0,
      takerBase: 0, takerQuote: 0
    }));
  }

  /* ─────────────────────────────────────────────────────────
     TF STACK BUILDER
  ───────────────────────────────────────────────────────── */
  function _buildTFStack(execTF) {
    const stacks = {
      '1':  ['W','D','240','60','15','5','1'],
      '5':  ['W','D','240','60','15','5'],
      '15': ['W','D','240','60','15'],
      '30': ['W','D','240','60','30'],
      '60': ['W','D','240','60'],
      '120':['W','D','240','120'],
      '240':['W','D','240'],
      '360':['W','D','360'],
      '720':['W','D','720'],
      'D':  ['W','D'],
      '3D': ['W','3D'],
      'W':  ['W']
    };
    return stacks[execTF] || ['W','D','240','60','15'];
  }

  /* ─────────────────────────────────────────────────────────
     STRUCTURE ENGINE — Top-Down Analysis
  ───────────────────────────────────────────────────────── */
  function _computeTopDownStructure(ohlcvData, execTF) {
    const result = {};
    const tfs = Object.keys(ohlcvData);
    for(const tf of tfs) {
      const candles = ohlcvData[tf];
      if(!candles || candles.length < 20) {
        result[tf] = { bias:'UNKNOWN', trend:'UNKNOWN', lastBOS:null, lastCHoCH:null, swings:[] };
        continue;
      }
      result[tf] = _analyzeStructure(candles, tf);
    }
    result._execTF = execTF;
    result._conflict = _resolveConflict(result, execTF);
    result._pullback = _detectPullback(ohlcvData[execTF] || []);
    return result;
  }

  function _analyzeStructure(candles, tf) {
    const swings = _detectSwings(candles, 5);
    const highs = swings.filter(s => s.type==='high');
    const lows  = swings.filter(s => s.type==='low');
    let bias = 'RANGING';
    let trend = 'RANGING';
    let lastBOS = null;
    let lastCHoCH = null;

    if(highs.length >= 2 && lows.length >= 2) {
      const hh = highs[highs.length-1].price > highs[highs.length-2].price;
      const hl = lows[lows.length-1].price > lows[lows.length-2].price;
      const lh = highs[highs.length-1].price < highs[highs.length-2].price;
      const ll = lows[lows.length-1].price < lows[lows.length-2].price;

      if(hh && hl) { bias = 'BULLISH'; trend = 'BULLISH'; }
      else if(lh && ll) { bias = 'BEARISH'; trend = 'BEARISH'; }
      else if(hh && ll) { bias = 'EXPANDING'; trend = 'RANGING'; }
      else { bias = 'RANGING'; trend = 'RANGING'; }
    }

    // Detect last BOS
    const last = candles[candles.length-1];
    if(highs.length >= 2) {
      const prevH = highs[highs.length-2];
      if(last.close > prevH.price) {
        lastBOS = { direction:'BULLISH', level: prevH.price, idx: prevH.idx };
      }
    }
    if(lows.length >= 2) {
      const prevL = lows[lows.length-2];
      if(last.close < prevL.price) {
        lastBOS = { direction:'BEARISH', level: prevL.price, idx: prevL.idx };
      }
    }

    // CHoCH — structure reversal
    if(bias === 'BULLISH' && lows.length >= 2) {
      const prevL = lows[lows.length-2];
      if(last.close < prevL.price) {
        lastCHoCH = { direction:'BEARISH', level: prevL.price };
        bias = 'BEARISH_CHOCH';
      }
    } else if(bias === 'BEARISH' && highs.length >= 2) {
      const prevH = highs[highs.length-2];
      if(last.close > prevH.price) {
        lastCHoCH = { direction:'BULLISH', level: prevH.price };
        bias = 'BULLISH_CHOCH';
      }
    }

    // Key price levels
    const pdh = _pdhl(candles, 'high', 1);
    const pdl = _pdhl(candles, 'low',  1);
    const pwh = _pdhl(candles, 'high', 7);
    const pwl = _pdhl(candles, 'low',  7);
    const pmh = _pdhl(candles, 'high', 30);
    const pml = _pdhl(candles, 'low',  30);

    return { bias, trend, lastBOS, lastCHoCH, swings, highs, lows, pdh, pdl, pwh, pwl, pmh, pml, lastClose: last.close, lastHigh: last.high, lastLow: last.low };
  }

  function _detectSwings(candles, lookback=5) {
    const swings = [];
    for(let i = lookback; i < candles.length - lookback; i++) {
      const slice = candles.slice(i - lookback, i + lookback + 1);
      const cur = candles[i];
      const isHigh = slice.every(c => c.high <= cur.high);
      const isLow  = slice.every(c => c.low  >= cur.low);
      if(isHigh) swings.push({ type:'high', price: cur.high, idx: i, ts: cur.ts });
      if(isLow)  swings.push({ type:'low',  price: cur.low,  idx: i, ts: cur.ts });
    }
    return swings;
  }

  function _pdhl(candles, type, lookback) {
    const slice = candles.slice(-lookback-1, -1);
    if(!slice.length) return null;
    return type === 'high'
      ? Math.max(...slice.map(c => c.high))
      : Math.min(...slice.map(c => c.low));
  }

  function _resolveConflict(structure, execTF) {
    const biasMap = {
      'BULLISH': 1, 'BULLISH_CHOCH': 0.5,
      'BEARISH': -1, 'BEARISH_CHOCH': -0.5,
      'RANGING': 0, 'EXPANDING': 0, 'UNKNOWN': 0
    };
    const tfs = ['W','D','240','120','60','30','15','5','1'].filter(tf => structure[tf]);
    let total = 0, count = 0;
    const table = [];
    for(const tf of tfs) {
      const s = structure[tf];
      if(!s) continue;
      const b = biasMap[s.bias] ?? 0;
      total += b; count++;
      const label = s.bias.replace('_CHOCH','(CHoCH)');
      const status = b > 0 ? 'ok' : b < 0 ? 'err' : 'warn';
      table.push({ tf: _tfLabel(tf), bias: label, status });
    }
    const avg = count ? total/count : 0;
    const verdict = avg > 0.3 ? 'BULLISH_ALIGNED' : avg < -0.3 ? 'BEARISH_ALIGNED' : 'MIXED';
    return { verdict, avg, table };
  }

  function _detectPullback(candles) {
    if(candles.length < 20) return { depth: 0, fib: 'N/A', type: 'UNKNOWN' };
    const last20 = candles.slice(-20);
    const high = Math.max(...last20.map(c=>c.high));
    const low  = Math.min(...last20.map(c=>c.low));
    const range = high - low;
    if(range === 0) return { depth: 0, fib: '0%', type: 'FLAT' };
    const cur = candles[candles.length-1].close;
    const retrace = (high - cur) / range;
    const fib = (retrace*100).toFixed(0) + '%';
    let type = 'SHALLOW';
    if(retrace > 0.79) type = 'DEEP_DANGER';
    else if(retrace > 0.62) type = 'OTE';
    else if(retrace > 0.50) type = 'DEEP';
    else if(retrace > 0.38) type = 'STANDARD';
    else type = 'SHALLOW';
    return { depth: retrace, fib, type, high, low, cur, range };
  }

  /* ─────────────────────────────────────────────────────────
     ZONE ENGINE — OB, FVG, BSL/SSL
  ───────────────────────────────────────────────────────── */
  function _computeZones(ohlcvData, execTF) {
    const zones = { ob: [], fvg: [], bsl: [], ssl: [], eqh: [], eql: [] };
    const tfs = Object.keys(ohlcvData);

    for(const tf of tfs) {
      const candles = ohlcvData[tf];
      if(!candles || candles.length < 10) continue;

      const obs = _detectOBs(candles, tf);
      const fvgs = _detectFVGs(candles, tf);
      const liq = _detectLiquidity(candles, tf);

      zones.ob.push(...obs);
      zones.fvg.push(...fvgs);
      zones.bsl.push(...liq.bsl);
      zones.ssl.push(...liq.ssl);
      zones.eqh.push(...liq.eqh);
      zones.eql.push(...liq.eql);
    }

    // Sort by price desc
    zones.ob.sort((a,b) => b.high - a.high);
    zones.fvg.sort((a,b) => b.high - a.high);
    zones.bsl.sort((a,b) => b.price - a.price);
    zones.ssl.sort((a,b) => a.price - b.price);

    // Current price
    const execCandles = ohlcvData[execTF] || [];
    const curPrice = execCandles.length ? execCandles[execCandles.length-1].close : 0;
    zones._curPrice = curPrice;

    // Nearest demand / supply
    const demandZones = zones.ob.filter(z => z.type==='demand' && z.high <= curPrice);
    const supplyZones = zones.ob.filter(z => z.type==='supply' && z.low  >= curPrice);
    zones._nearestDemand = demandZones.length ? demandZones[0] : null;
    zones._nearestSupply = supplyZones.length ? supplyZones[supplyZones.length-1] : null;

    // Check OB+FVG overlap
    zones._confluence = _findZoneConfluence(zones.ob, zones.fvg, curPrice);

    return zones;
  }

  function _detectOBs(candles, tf) {
    const obs = [];
    const swings = _detectSwings(candles, 3);
    const impulseThreshold = _avgBody(candles) * 1.5;

    for(let i = 5; i < candles.length - 3; i++) {
      const c = candles[i];
      const next = candles[i+1];
      const bodySize = Math.abs(c.close - c.open);
      if(bodySize < impulseThreshold * 0.5) continue;

      // Bullish OB: last bearish candle before bullish impulse
      if(c.close < c.open && next.close > next.open) {
        const impulse = Math.abs(next.close - next.open);
        if(impulse > impulseThreshold) {
          // Check for BOS after this
          const futureHigh = Math.max(...candles.slice(i+1, Math.min(i+10, candles.length)).map(x=>x.high));
          const swingHighBefore = swings.filter(s=>s.type==='high' && s.idx < i).slice(-1)[0];
          if(swingHighBefore && futureHigh > swingHighBefore.price) {
            const state = _getOBState(candles, i, 'demand');
            obs.push({ tf, type:'demand', high: c.high, low: c.low, open: c.open, close: c.close, ts: c.ts, state, idx: i, label: `${_tfLabel(tf)} Demand OB` });
          }
        }
      }

      // Bearish OB: last bullish candle before bearish impulse
      if(c.close > c.open && next.close < next.open) {
        const impulse = Math.abs(next.close - next.open);
        if(impulse > impulseThreshold) {
          const futureLow = Math.min(...candles.slice(i+1, Math.min(i+10, candles.length)).map(x=>x.low));
          const swingLowBefore = swings.filter(s=>s.type==='low' && s.idx < i).slice(-1)[0];
          if(swingLowBefore && futureLow < swingLowBefore.price) {
            const state = _getOBState(candles, i, 'supply');
            obs.push({ tf, type:'supply', high: c.high, low: c.low, open: c.open, close: c.close, ts: c.ts, state, idx: i, label: `${_tfLabel(tf)} Supply OB` });
          }
        }
      }
    }
    return obs.slice(-6); // keep most recent 6 per TF
  }

  function _getOBState(candles, idx, type) {
    let touches = 0;
    const ob = candles[idx];
    for(let i = idx+1; i < candles.length; i++) {
      const c = candles[i];
      if(type === 'demand') {
        if(c.low <= ob.high && c.low >= ob.low) touches++;
        if(c.close < ob.low) return touches > 0 ? 'BROKEN' : 'BROKEN';
      } else {
        if(c.high >= ob.low && c.high <= ob.high) touches++;
        if(c.close > ob.high) return 'BROKEN';
      }
    }
    if(touches === 0) return 'FRESH';
    if(touches === 1) return 'TAPPED';
    return 'WORN';
  }

  function _detectFVGs(candles, tf) {
    const fvgs = [];
    for(let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i-1];
      const cur  = candles[i];
      const next = candles[i+1];
      // Bullish FVG
      if(next.low > prev.high) {
        const midpoint = (next.low + prev.high) / 2;
        const state = _getFVGState(candles, i, 'bull', prev.high, next.low);
        fvgs.push({ tf, type:'bull', high: next.low, low: prev.high, mid: midpoint, ts: cur.ts, state, idx: i, label: `${_tfLabel(tf)} Bull FVG` });
      }
      // Bearish FVG
      if(next.high < prev.low) {
        const midpoint = (next.high + prev.low) / 2;
        const state = _getFVGState(candles, i, 'bear', prev.low, next.high);
        fvgs.push({ tf, type:'bear', high: prev.low, low: next.high, mid: midpoint, ts: cur.ts, state, idx: i, label: `${_tfLabel(tf)} Bear FVG` });
      }
    }
    return fvgs.filter(f => f.state !== 'FILLED').slice(-4);
  }

  function _getFVGState(candles, idx, type, high, low) {
    for(let i = idx+2; i < candles.length; i++) {
      const c = candles[i];
      if(type === 'bull' && c.low <= low) return 'FILLED';
      if(type === 'bear' && c.high >= high) return 'FILLED';
    }
    return 'OPEN';
  }

  function _detectLiquidity(candles, tf) {
    const bsl = [], ssl = [], eqh = [], eql = [];
    const swings = _detectSwings(candles, 3);
    const priceTol = _avgBody(candles) * 0.5;

    swings.filter(s=>s.type==='high').slice(-8).forEach(s => {
      const swept = candles.slice(s.idx+1).some(c => c.high > s.price);
      bsl.push({ tf, price: s.price, swept, label: `BSL ${_tfLabel(tf)}`, ts: s.ts });
    });

    swings.filter(s=>s.type==='low').slice(-8).forEach(s => {
      const swept = candles.slice(s.idx+1).some(c => c.low < s.price);
      ssl.push({ tf, price: s.price, swept, label: `SSL ${_tfLabel(tf)}`, ts: s.ts });
    });

    // EQH / EQL detection
    const highs = swings.filter(s=>s.type==='high').slice(-10);
    for(let i = 0; i < highs.length; i++) {
      for(let j = i+1; j < highs.length; j++) {
        if(Math.abs(highs[i].price - highs[j].price) < priceTol) {
          eqh.push({ tf, price: (highs[i].price + highs[j].price)/2, label: `EQH ${_tfLabel(tf)}` });
          break;
        }
      }
    }

    const lows = swings.filter(s=>s.type==='low').slice(-10);
    for(let i = 0; i < lows.length; i++) {
      for(let j = i+1; j < lows.length; j++) {
        if(Math.abs(lows[i].price - lows[j].price) < priceTol) {
          eql.push({ tf, price: (lows[i].price + lows[j].price)/2, label: `EQL ${_tfLabel(tf)}` });
          break;
        }
      }
    }

    return { bsl, ssl, eqh, eql };
  }

  function _findZoneConfluence(obs, fvgs, curPrice) {
    const confluent = [];
    obs.forEach(ob => {
      fvgs.forEach(fvg => {
        const overlap = ob.low <= fvg.high && ob.high >= fvg.low;
        if(overlap) confluent.push({ ob, fvg, type: ob.type === 'demand' ? 'DEMAND_CONFLUENCE' : 'SUPPLY_CONFLUENCE' });
      });
    });
    return confluent;
  }

  function _avgBody(candles) {
    const slice = candles.slice(-20);
    return slice.reduce((s,c) => s + Math.abs(c.close-c.open), 0) / slice.length;
  }

  /* ─────────────────────────────────────────────────────────
     SESSION / AMD DETECTION
  ───────────────────────────────────────────────────────── */
  function _computeSession() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const utcTime = utcH * 60 + utcM;

    // Sessions in UTC minutes
    const sessions = {
      asian:   { start: 0*60,   end: 8*60,   label: 'ASIAN' },
      london:  { start: 7*60,   end: 16*60,  label: 'LONDON' },
      ny:      { start: 13*60,  end: 21*60,  label: 'NEW YORK' },
      overlap: { start: 13*60,  end: 16*60,  label: 'LONDON/NY OVERLAP' }
    };

    // Kill zones UTC
    const killZones = {
      asian_kz:  { start: 20*60+0,  end: 23*60+59, label: 'Asian Kill Zone (8PM-12AM ET)' },
      london_kz: { start: 2*60,    end: 5*60,      label: 'London Kill Zone (2-5AM ET)' },
      ny_kz:     { start: 7*60,    end: 10*60,     label: 'NY Kill Zone (7-10AM ET)' }
    };

    let currentSession = 'OFF SESSION';
    if(utcTime >= sessions.overlap.start && utcTime < sessions.overlap.end) currentSession = sessions.overlap.label;
    else if(utcTime >= sessions.london.start && utcTime < sessions.london.end) currentSession = sessions.london.label;
    else if(utcTime >= sessions.ny.start && utcTime < sessions.ny.end) currentSession = sessions.ny.label;
    else if(utcTime >= sessions.asian.start && utcTime < sessions.asian.end) currentSession = sessions.asian.label;

    let killZoneActive = 'NONE';
    let killZoneLabel = 'No Kill Zone Active';
    for(const [k, kz] of Object.entries(killZones)) {
      if(utcTime >= kz.start && utcTime <= kz.end) {
        killZoneActive = k.toUpperCase();
        killZoneLabel = kz.label;
        break;
      }
    }

    // AMD Phase — based on current time relative to sessions
    let amdPhase = 'ACCUMULATION';
    let amdDesc = 'Asian session — price consolidating, building liquidity';
    if(utcTime >= 7*60 && utcTime < 9*60) {
      amdPhase = 'MANIPULATION';
      amdDesc = 'London open — Judas Swing zone, watch for SSL/BSL sweep';
    } else if(utcTime >= 9*60 && utcTime < 13*60) {
      amdPhase = 'DISTRIBUTION (London)';
      amdDesc = 'London expansion — real directional move in progress';
    } else if(utcTime >= 13*60 && utcTime < 15*60) {
      amdPhase = 'MANIPULATION (NY)';
      amdDesc = 'NY open — potential secondary manipulation / continuation';
    } else if(utcTime >= 15*60 && utcTime < 20*60) {
      amdPhase = 'DISTRIBUTION (NY)';
      amdDesc = 'NY expansion — follow-through or reversal from London';
    }

    // Day of week AMD template (ICT Weekly model)
    const dayOfWeek = now.getUTCDay();
    const weeklyTemplate = ['ACCUMULATION (Sunday)', 'ACCUMULATION (Monday)', 'MANIPULATION (Tuesday)', 'REVERSAL (Wednesday)', 'DISTRIBUTION (Thursday)', 'DISTRIBUTION (Friday)', 'CONSOLIDATION (Saturday)'];
    const weeklyPhase = weeklyTemplate[dayOfWeek] || 'UNKNOWN';

    const nextLondon = _msUntilUTC(2, 0);
    const nextNY     = _msUntilUTC(7, 0);

    return {
      currentSession,
      killZoneActive,
      killZoneLabel,
      killZoneActiveNow: killZoneActive !== 'NONE',
      amdPhase,
      amdDesc,
      weeklyPhase,
      utcTimeStr: `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')} UTC`,
      nextLondon: _fmtDuration(nextLondon),
      nextNY: _fmtDuration(nextNY)
    };
  }

  function _msUntilUTC(targetH, targetM) {
    const now = new Date();
    const target = new Date();
    target.setUTCHours(targetH, targetM, 0, 0);
    if(target <= now) target.setUTCDate(target.getUTCDate()+1);
    return target - now;
  }

  function _fmtDuration(ms) {
    const totalMin = Math.floor(ms/60000);
    const h = Math.floor(totalMin/60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  }

  /* ─────────────────────────────────────────────────────────
     DERIVATIVES INTERPRETER
  ───────────────────────────────────────────────────────── */
  function _interpretDerivatives(derivData) {
    if(!derivData) return { verdict:'UNAVAILABLE', fundingState:'N/A', oiTrend:'N/A', takerBias:'N/A' };

    const pm = derivData.premiumIndex;
    const funding = pm?.lastFundingRate ? parseFloat(pm.lastFundingRate)*100 : null;
    const nextFunding = pm?.nextFundingTime ? new Date(parseInt(pm.nextFundingTime)).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC' : 'N/A';

    let fundingState = 'NEUTRAL';
    let fundingColor = 'var(--text)';
    if(funding !== null) {
      if(funding > 0.05)       { fundingState = 'EXTREME_LONG — squeeze risk';  fundingColor = 'var(--red)'; }
      else if(funding > 0.02)  { fundingState = 'HIGH_LONG — longs overextended'; fundingColor = 'var(--gold)'; }
      else if(funding < -0.05) { fundingState = 'EXTREME_SHORT — squeeze risk';  fundingColor = 'var(--red)'; }
      else if(funding < -0.02) { fundingState = 'HIGH_SHORT — shorts dominant';   fundingColor = 'var(--gold)'; }
      else                      { fundingState = 'NEUTRAL'; fundingColor = 'var(--green)'; }
    }

    // OI Trend
    const oi = derivData.oiHistory;
    let oiTrend = 'N/A'; let oiChange = null;
    if(oi && oi.length >= 2) {
      const first = parseFloat(oi[0]?.sumOpenInterestValue || oi[0]?.sumOpenInterest || 0);
      const last  = parseFloat(oi[oi.length-1]?.sumOpenInterestValue || oi[oi.length-1]?.sumOpenInterest || 0);
      if(first > 0) {
        oiChange = ((last - first) / first * 100).toFixed(2);
        oiTrend = parseFloat(oiChange) > 0 ? `▲ +${oiChange}% (24h)` : `▼ ${oiChange}% (24h)`;
      }
    }

    // Taker Ratio / CVD proxy
    const taker = derivData.takerRatio;
    let takerBias = 'N/A'; let takerColor = 'var(--text)';
    if(taker && taker.length >= 2) {
      const recent = taker.slice(-3);
      const avgBuy = recent.reduce((s,t)=>s+parseFloat(t.buySell||t.buyVol||0.5),0)/recent.length;
      if(avgBuy > 0.55)       { takerBias = `BUY DOMINANT (${(avgBuy*100).toFixed(0)}%)`;  takerColor = 'var(--green)'; }
      else if(avgBuy < 0.45)  { takerBias = `SELL DOMINANT (${((1-avgBuy)*100).toFixed(0)}%)`; takerColor = 'var(--red)'; }
      else                     { takerBias = `BALANCED (${(avgBuy*100).toFixed(0)}%)`; }
    }

    // L/S Ratio
    const ls = derivData.lsRatio;
    let lsState = 'N/A';
    if(ls && ls.length) {
      const recent = ls[ls.length-1];
      const ratio = parseFloat(recent.longShortRatio || recent.longAccount || 1);
      lsState = ratio > 1.1 ? `LONG BIASED (${ratio.toFixed(2)})` : ratio < 0.9 ? `SHORT BIASED (${(1/ratio).toFixed(2)})` : `BALANCED (${ratio.toFixed(2)})`;
    }

    // Overall verdict
    let verdict = 'NEUTRAL';
    if(fundingState.includes('EXTREME') && oiChange && parseFloat(oiChange) < -5) verdict = 'DISTRIBUTION — HIGH REVERSAL RISK';
    else if(fundingState === 'NEUTRAL' && takerBias.includes('BUY')) verdict = 'GENUINE BULLISH PARTICIPATION';
    else if(fundingState === 'NEUTRAL' && takerBias.includes('SELL')) verdict = 'GENUINE BEARISH PARTICIPATION';
    else if(fundingState.includes('EXTREME_LONG')) verdict = 'OVER-LEVERAGED LONGS — SQUEEZE RISK';
    else if(fundingState.includes('EXTREME_SHORT')) verdict = 'OVER-LEVERAGED SHORTS — SQUEEZE RISK';

    const curPrice = pm?.markPrice ? parseFloat(pm.markPrice) : 0;
    const indexPrice = pm?.indexPrice ? parseFloat(pm.indexPrice) : 0;
    const basis = curPrice && indexPrice ? ((curPrice - indexPrice)/indexPrice*100).toFixed(4)+'%' : 'N/A';

    return { fundingState, fundingColor, fundingRate: funding?.toFixed(4)+'%' || 'N/A', nextFunding, oiTrend, oiChange, takerBias, takerColor, lsState, verdict, curPrice, indexPrice, basis };
  }

  /* ─────────────────────────────────────────────────────────
     TRADE PLAN GENERATOR
  ───────────────────────────────────────────────────────── */
  function _generateTradePlan(ohlcvData, structure, zones, derivData, execTF) {
    const candles = ohlcvData[execTF] || [];
    if(!candles.length) return _noTrade('Insufficient candle data');

    const cur = candles[candles.length-1].close;
    const structInfo = structure[execTF] || {};
    const conflict = structure._conflict;
    const pullback = structure._pullback;
    const derivInterp = _interpretDerivatives(derivData);

    // Determine direction
    let direction = 'NONE';
    if(conflict.verdict === 'BULLISH_ALIGNED') direction = 'LONG';
    else if(conflict.verdict === 'BEARISH_ALIGNED') direction = 'SHORT';
    else {
      // Mixed — use exec TF bias
      const execBias = structInfo.bias || 'RANGING';
      if(execBias === 'BULLISH' || execBias === 'BULLISH_CHOCH') direction = 'LONG';
      else if(execBias === 'BEARISH' || execBias === 'BEARISH_CHOCH') direction = 'SHORT';
    }

    if(direction === 'NONE') return _noTrade('No clear directional bias — market ranging');

    // Derivative conflict check
    if(derivInterp.verdict.includes('OVER-LEVERAGED') && conflict.verdict.includes(direction === 'LONG' ? 'BULLISH' : 'BEARISH')) {
      // Allow but flag
    }

    const atr = _calcATR(candles, 14);
    let entry, sl, invalidation, tp1, tp2, tp3, runner;
    let entryModel = 'Model 2 — Confirmation (CHoCH + FVG)';
    let setupType = 'WITH-TREND';

    if(direction === 'LONG') {
      const demand = zones._nearestDemand;
      if(demand && demand.state !== 'BROKEN') {
        const fvgInZone = zones.fvg.find(f => f.type==='bull' && f.low >= demand.low && f.high <= demand.high*1.01);
        entry = fvgInZone ? fvgInZone.mid : (demand.high + demand.low) / 2;
        sl    = demand.low - atr * 0.3;
        invalidation = demand.low;
      } else {
        entry = cur;
        sl    = cur - atr * 1.5;
        invalidation = sl;
      }

      const riskPips = entry - sl;
      tp1    = entry + riskPips * 2;
      tp2    = entry + riskPips * 4;
      tp3    = entry + riskPips * 6;

      // Cap TP at nearest supply
      const supply = zones._nearestSupply;
      if(supply) {
        if(tp1 >= supply.low) tp1 = supply.low * 0.999;
        if(tp2 >= supply.low) tp2 = supply.low * 0.999;
        runner = supply.high > tp3 ? supply.high * 0.998 : tp3 + riskPips;
      } else {
        runner = tp3 + riskPips * 2;
      }

    } else { // SHORT
      const supply = zones._nearestSupply;
      if(supply && supply.state !== 'BROKEN') {
        const fvgInZone = zones.fvg.find(f => f.type==='bear' && f.high <= supply.high && f.low >= supply.low*0.99);
        entry = fvgInZone ? fvgInZone.mid : (supply.high + supply.low) / 2;
        sl    = supply.high + atr * 0.3;
        invalidation = supply.high;
      } else {
        entry = cur;
        sl    = cur + atr * 1.5;
        invalidation = sl;
      }

      const riskPips = sl - entry;
      tp1    = entry - riskPips * 2;
      tp2    = entry - riskPips * 4;
      tp3    = entry - riskPips * 6;

      const demand = zones._nearestDemand;
      if(demand) {
        if(tp1 <= demand.high) tp1 = demand.high * 1.001;
        if(tp2 <= demand.high) tp2 = demand.high * 1.001;
        runner = demand.low < tp3 ? demand.low * 1.002 : tp3 - riskPips;
      } else {
        runner = tp3 - riskPips * 2;
      }
    }

    const riskPips = Math.abs(entry - sl);
    const rr1 = riskPips > 0 ? (Math.abs(tp1-entry)/riskPips).toFixed(1) : '—';
    const rr2 = riskPips > 0 ? (Math.abs(tp2-entry)/riskPips).toFixed(1) : '—';
    const rr3 = riskPips > 0 ? (Math.abs(tp3-entry)/riskPips).toFixed(1) : '—';
    const rrR = riskPips > 0 ? (Math.abs(runner-entry)/riskPips).toFixed(1) : '—';

    // Obstacles between entry and TP3
    const obstacles = _mapObstacles(zones, entry, tp3, direction);

    // Overhead/underfloor radar
    const htfResistance = _checkHTFResistance(structure, entry, tp1, direction);

    const isViable = parseFloat(rr2) >= 1.5;
    if(!isViable) return _noTrade(`RR insufficient — ${rr2}R to TP2 (minimum 1.5R required)`);

    return {
      valid: true, direction, setupType, entryModel,
      entry: _p(entry), sl: _p(sl), invalidation: _p(invalidation),
      tp1: _p(tp1), tp2: _p(tp2), tp3: _p(tp3), runner: _p(runner),
      rr1, rr2, rr3, rrR, riskPips: _p(riskPips),
      obstacles, htfResistance, atr: _p(atr),
      actions: {
        at1R: 'Move SL to breakeven',
        atTP1: 'Close 50% — move SL to BE — trail',
        atTP2: 'Close 25% — trail SL behind new BOS',
        atTP3: 'Close 15% — let runner breathe',
        runner: 'Trail SL behind each new structural BOS'
      },
      invalidationRules: [
        direction === 'LONG' ? `Body close below ${_p(invalidation)}` : `Body close above ${_p(invalidation)}`,
        'CHoCH forms against trade on exec TF',
        'Price enters opposing OB without pullback first',
        derivInterp.fundingRate !== 'N/A' ? 'Funding rate spikes above +0.05%' : null
      ].filter(Boolean)
    };
  }

  function _noTrade(reason) {
    return { valid: false, direction: 'NONE', reason };
  }

  function _mapObstacles(zones, entry, target, direction) {
    const obstacles = [];
    const allLevels = [
      ...zones.ob.map(z => ({ price: (z.high+z.low)/2, label: z.label, type: 'OB' })),
      ...zones.fvg.map(z => ({ price: z.mid, label: z.label, type: 'FVG' })),
      ...zones.bsl.filter(z=>!z.swept).map(z => ({ price: z.price, label: z.label, type: 'BSL' })),
      ...zones.eqh.map(z => ({ price: z.price, label: z.label, type: 'EQH' }))
    ];

    const between = direction === 'LONG'
      ? allLevels.filter(l => l.price > entry && l.price < target)
      : allLevels.filter(l => l.price < entry && l.price > target);

    between.sort((a,b) => direction === 'LONG' ? a.price - b.price : b.price - a.price);
    return between.slice(0,5);
  }

  function _checkHTFResistance(structure, entry, tp1, direction) {
    const issues = [];
    const htfTFs = ['W','D','240'];
    for(const tf of htfTFs) {
      const s = structure[tf];
      if(!s) continue;
      if(direction === 'LONG' && s.pdh) {
        if(s.pdh > entry && s.pdh < tp1) {
          issues.push(`${_tfLabel(tf)} HTF level at ${_p(s.pdh)} between entry and TP1`);
        }
      }
      if(direction === 'SHORT' && s.pdl) {
        if(s.pdl < entry && s.pdl > tp1) {
          issues.push(`${_tfLabel(tf)} HTF level at ${_p(s.pdl)} between entry and TP1`);
        }
      }
    }
    return issues;
  }

  function _calcATR(candles, period=14) {
    if(candles.length < period+1) return 0;
    const trs = [];
    for(let i = 1; i < candles.length; i++) {
      const cur = candles[i];
      const prev = candles[i-1];
      trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    }
    return trs.slice(-period).reduce((s,v)=>s+v,0)/period;
  }

  /* ─────────────────────────────────────────────────────────
     16-POINT CONFLUENCE SCORING
  ───────────────────────────────────────────────────────── */
  function _computeScore(structure, zones, session, derivData, tradePlan) {
    if(!tradePlan.valid) return { total:0, grade:'SKIP', breakdown:{}, scoreColor:'var(--muted)' };

    const breakdown = {};
    let total = 0;

    // 1. Structure (4pts)
    const conflict = structure._conflict;
    let structScore = 0;
    const tfsAligned = conflict.table.filter(t=>t.status==='ok').length;
    if(tfsAligned >= 4) structScore = 4;
    else if(tfsAligned >= 3) structScore = 3;
    else if(tfsAligned >= 2) structScore = 2;
    else structScore = 1;
    breakdown['Structure'] = { score: structScore, max: 4 };
    total += structScore;

    // 2. Liquidity (3pts)
    let liqScore = 0;
    const nearSweep = zones.ssl.some(s=>!s.swept && zones._curPrice - s.price < zones._curPrice * 0.005);
    if(nearSweep || zones.eqh.length > 0 || zones.eql.length > 0) liqScore++;
    const htfLiqTarget = zones.bsl.filter(s=>!s.swept && (s.tf==='D'||s.tf==='W')).length;
    if(htfLiqTarget > 0) liqScore++;
    if(tradePlan.direction === 'LONG' && zones._nearestDemand?.state === 'FRESH') liqScore++;
    if(tradePlan.direction === 'SHORT' && zones._nearestSupply?.state === 'FRESH') liqScore++;
    liqScore = Math.min(liqScore, 3);
    breakdown['Liquidity'] = { score: liqScore, max: 3 };
    total += liqScore;

    // 3. Zone quality (3pts)
    let zoneScore = 0;
    const relevantOB = tradePlan.direction === 'LONG' ? zones._nearestDemand : zones._nearestSupply;
    if(relevantOB) {
      if(relevantOB.state === 'FRESH') zoneScore++;
      const fvgOverlap = zones._confluence.some(c => c.ob === relevantOB);
      if(fvgOverlap) zoneScore++;
      if(relevantOB.tf === 'D' || relevantOB.tf === 'W') zoneScore++;
    }
    breakdown['Zone Quality'] = { score: zoneScore, max: 3 };
    total += zoneScore;

    // 4. Timing (3pts)
    let timeScore = 0;
    if(session.killZoneActiveNow) timeScore++;
    if(session.currentSession.includes('OVERLAP') || session.currentSession.includes('LONDON')) timeScore++;
    if(session.amdPhase.includes('DISTRIBUTION')) timeScore++;
    breakdown['Timing'] = { score: timeScore, max: 3 };
    total += timeScore;

    // 5. Execution (2pts)
    let execScore = 0;
    const pullback = structure._pullback;
    if(pullback.depth >= 0.62 && pullback.depth <= 0.79) execScore++;  // OTE zone
    if(parseFloat(tradePlan.rr2) >= 2) execScore++;
    breakdown['Execution'] = { score: execScore, max: 2 };
    total += execScore;

    // 6. Volatility (1pt)
    let volScore = 0;
    const derivInterp = _interpretDerivatives(derivData);
    if(!derivInterp.verdict.includes('OVER-LEVERAGED') && !derivInterp.verdict.includes('SQUEEZE')) volScore++;
    breakdown['Internals'] = { score: volScore, max: 1 };
    total += volScore;

    let grade = 'SKIP';
    let scoreColor = 'var(--muted)';
    if(total >= 15)      { grade = 'A+'; scoreColor = 'var(--green)'; }
    else if(total >= 12) { grade = 'A';  scoreColor = 'var(--green)'; }
    else if(total >= 10) { grade = 'B+'; scoreColor = 'var(--gold)'; }
    else if(total >= 8)  { grade = 'B';  scoreColor = 'var(--gold)'; }
    else if(total >= 6)  { grade = 'C';  scoreColor = 'var(--sub)'; }
    else                  { grade = 'SKIP'; scoreColor = 'var(--muted)'; }

    return { total, grade, breakdown, scoreColor, maxScore: 16 };
  }

  /* ─────────────────────────────────────────────────────────
     LIQUIDITY TIER
  ───────────────────────────────────────────────────────── */
  function _getLiqTier(vol24h, rank) {
    if(!vol24h) return { tier: 4, label: 'Tier 4 — Unknown', color: 'tier-4', desc: 'SMC patterns unreliable' };
    const v = vol24h / 1e6;
    if(v > 5000 || rank <= 5)    return { tier: 1, label: 'Tier 1 — Institutional', color: 'tier-1', desc: 'Full SMC reliability' };
    if(v > 500  || rank <= 20)   return { tier: 2, label: 'Tier 2 — High Liquid',   color: 'tier-2', desc: 'Good SMC reliability' };
    if(v > 50   || rank <= 100)  return { tier: 3, label: 'Tier 3 — Mid Liquid',    color: 'tier-3', desc: 'Reduced reliability — wider SL' };
    return { tier: 4, label: 'Tier 4 — Low Liquid', color: 'tier-4', desc: 'SMC patterns unreliable' };
  }

  /* ─────────────────────────────────────────────────────────
     RENDER — SINGLE REPORT
  ───────────────────────────────────────────────────────── */
  function _renderSingleReport(r) {
    const { symbol, tf, ohlcvData, derivData, metaData, structureData, zoneData, sessionData, tradePlan, score } = r;
    const execCandles = ohlcvData[tf] || [];
    const cur = execCandles.length ? execCandles[execCandles.length-1] : null;
    const curPrice = cur ? cur.close : 0;
    const priceChange = metaData?.priceChange24h || 0;
    const derivInterp = _interpretDerivatives(derivData);
    const tier = _getLiqTier(metaData?.volume24h, metaData?.rank);

    let html = `<div class="analysis-output" id="analysis-output-block">`;

    /* ── A. Asset Header ─────────────────────────────────── */
    html += `
    <div class="asset-header">
      <div>
        <div class="asset-ticker">${symbol}</div>
        <div class="asset-price">$${_fmt(curPrice, curPrice > 1 ? 2 : 6)}</div>
      </div>
      <div class="asset-change ${priceChange >= 0 ? 'pos' : 'neg'}">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%</div>
      <div style="display:flex;align-items:center;gap:10px;margin-left:12px;">
        <span class="tier-badge ${tier.color}">${tier.label}</span>
      </div>
      <div class="asset-meta-row">
        <div class="asset-meta-item">
          <span class="meta-label">24H VOLUME</span>
          <span class="meta-value">${metaData?.volume24h ? '$'+_fmtBig(metaData.volume24h) : '—'}</span>
        </div>
        <div class="asset-meta-item">
          <span class="meta-label">MARKET CAP</span>
          <span class="meta-value">${metaData?.marketCap ? '$'+_fmtBig(metaData.marketCap) : '—'}</span>
        </div>
        <div class="asset-meta-item">
          <span class="meta-label">EXEC TF</span>
          <span class="meta-value">${_tfLabel(tf)}</span>
        </div>
        <div class="asset-meta-item">
          <span class="meta-label">ATH</span>
          <span class="meta-value">${metaData?.ath ? '$'+_fmt(metaData.ath, metaData.ath > 1 ? 2 : 6) : '—'}</span>
        </div>
      </div>
    </div>`;

    /* ── No-Trade Banner ─────────────────────────────────── */
    if(!tradePlan.valid) {
      html += `
      <div class="no-trade-banner">
        <div class="nt-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
        <div>
          <div class="nt-title">🚫 NO TRADE ENVIRONMENT</div>
          <div class="nt-reason">${tradePlan.reason}</div>
        </div>
      </div>`;
    }

    /* ── B. Verdict Bar ──────────────────────────────────── */
    const vtClass = tradePlan.direction==='LONG' ? 'vtag-long' : tradePlan.direction==='SHORT' ? 'vtag-short' : 'vtag-no-trade';
    const conflictVerdict = structureData._conflict.verdict.replace('_ALIGNED','').replace('_',' ');
    html += `
    <div class="verdict-bar">
      <span class="verdict-label">OVERALL BIAS</span>
      <span class="verdict-text">${conflictVerdict} — ${sessionData.amdPhase}</span>
      <span class="verdict-tag ${vtClass}">${tradePlan.direction === 'LONG' ? '🟢 LONG' : tradePlan.direction === 'SHORT' ? '🔴 SHORT' : '⬜ NO TRADE'}</span>
    </div>`;

    /* ── C. TF Conflict + Session (2-col) ────────────────── */
    html += `<div class="cards-grid">`;

    // TF Conflict table
    html += `<div class="card">
      <div class="card-title">TIMEFRAME ALIGNMENT</div>
      <table class="conflict-table">
        <tbody>`;
    for(const row of structureData._conflict.table) {
      const icon = row.status==='ok' ? '✅' : row.status==='warn' ? '⚠️' : '🔻';
      html += `<tr>
        <td>${row.tf}</td>
        <td class="status-${row.status}">${row.bias}</td>
        <td>${icon}</td>
      </tr>`;
    }
    html += `</tbody></table>
      <div style="margin-top:10px;padding:8px;background:var(--bg3);font-size:10px;font-family:var(--font-mono);color:var(--sub);">
        VERDICT: <span style="color:${structureData._conflict.avg>0?'var(--green)':'var(--red)'}">${conflictVerdict}</span>
        &nbsp;|&nbsp; Pullback: ${structureData._pullback.fib} (${structureData._pullback.type})
      </div>
    </div>`;

    // Session / AMD
    html += `<div class="card">
      <div class="card-title">SESSION & AMD PHASE</div>
      <div class="session-block">
        <div class="session-cell ${sessionData.currentSession!=='OFF SESSION'?'active-cell':''}">
          <div class="sc-label">CURRENT SESSION</div>
          <div class="sc-value">${sessionData.currentSession}</div>
        </div>
        <div class="session-cell ${sessionData.killZoneActiveNow?'active-cell':''}">
          <div class="sc-label">KILL ZONE</div>
          <div class="sc-value" style="color:${sessionData.killZoneActiveNow?'var(--green)':'var(--muted)'}">
            ${sessionData.killZoneActiveNow ? '✅ ACTIVE' : '⭕ INACTIVE'}
          </div>
        </div>
        <div class="session-cell">
          <div class="sc-label">AMD PHASE</div>
          <div class="sc-value" style="font-size:11px">${sessionData.amdPhase}</div>
        </div>
        <div class="session-cell">
          <div class="sc-label">WEEKLY TEMPLATE</div>
          <div class="sc-value" style="font-size:11px;color:var(--sub)">${sessionData.weeklyPhase}</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:10px;color:var(--sub);font-family:var(--font-mono);padding:6px 8px;background:var(--bg3);">
        ${sessionData.amdDesc}
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:10px;font-family:var(--font-mono);color:var(--muted);">
        <span>Next London: <span style="color:var(--text)">${sessionData.nextLondon}</span></span>
        <span>Next NY: <span style="color:var(--text)">${sessionData.nextNY}</span></span>
      </div>
    </div>`;

    html += `</div>`; // end cards-grid

    /* ── D. Key Levels + Liquidity Map (2-col) ───────────── */
    html += `<div class="cards-grid">`;

    // Key Levels
    const dStruct = structureData['D'] || {};
    const wStruct = structureData['W'] || {};
    html += `<div class="card">
      <div class="card-title">KEY LEVELS (PDH/PDL/PWH/PWL)</div>
      <div class="levels-list">
        ${_levelRow('PWH', wStruct.pwh || wStruct.pdh, 'var(--red)', 'tag-tapped')}
        ${_levelRow('PDH', dStruct.pdh, 'var(--red)', 'tag-tapped')}
        ${_levelRow('CURRENT', curPrice, 'var(--blue)', 'tag-active')}
        ${_levelRow('PDL', dStruct.pdl, 'var(--green)', 'tag-tapped')}
        ${_levelRow('PWL', wStruct.pwl || wStruct.pdl, 'var(--green)', 'tag-tapped')}
        ${_levelRow('ATH', metaData?.ath, 'var(--gold)', 'tag-tapped')}
        ${_levelRow('ATL', metaData?.atl, 'var(--sub)', 'tag-tapped')}
      </div>
    </div>`;

    // Liquidity Map
    const bslAbove = zoneData.bsl.filter(l => l.price > curPrice && !l.swept).slice(0,4);
    const sslBelow = zoneData.ssl.filter(l => l.price < curPrice && !l.swept).slice(0,4);
    const sslSwept = zoneData.ssl.filter(l => l.price < curPrice && l.swept).slice(0,2);
    html += `<div class="card">
      <div class="card-title">LIQUIDITY MAP</div>
      <div class="liq-section">
        <div class="liq-section-title">BSL ABOVE (Long targets)</div>
        ${bslAbove.length ? bslAbove.map(l=>`<div class="liq-row"><span class="liq-arrow" style="color:var(--red)">▲</span><span style="flex:1;color:var(--sub);font-size:10px">${l.label}</span><span style="color:var(--text)">${_p(l.price)}</span></div>`).join('') : '<div style="font-size:10px;color:var(--muted);padding:4px 8px">No BSL detected above</div>'}
      </div>
      <div class="liq-section">
        <div class="liq-section-title">SSL BELOW (Stop hunt zones)</div>
        ${sslBelow.length ? sslBelow.map(l=>`<div class="liq-row"><span class="liq-arrow" style="color:var(--green)">▼</span><span style="flex:1;color:var(--sub);font-size:10px">${l.label}</span><span style="color:var(--text)">${_p(l.price)}</span></div>`).join('') : '<div style="font-size:10px;color:var(--muted);padding:4px 8px">No SSL detected below</div>'}
        ${sslSwept.map(l=>`<div class="liq-row"><span class="liq-arrow" style="color:var(--muted)">✅</span><span style="flex:1;color:var(--muted);font-size:10px">${l.label} — SWEPT</span><span style="color:var(--muted)">${_p(l.price)}</span></div>`).join('')}
      </div>
      ${zoneData.eqh.length ? `<div class="liq-section"><div class="liq-section-title">EQH (Double liquidity)</div>${zoneData.eqh.slice(0,2).map(l=>`<div class="liq-row"><span class="liq-arrow" style="color:var(--gold)">⚡</span><span style="flex:1;color:var(--sub);font-size:10px">${l.label}</span><span style="color:var(--text)">${_p(l.price)}</span></div>`).join('')}</div>` : ''}
    </div>`;

    html += `</div>`;

    /* ── E. OB Zones + FVG Zones (2-col) ─────────────────── */
    html += `<div class="cards-grid">`;

    // OB Zones
    const relevantOBs = [...zoneData.ob].filter(z=>z.state!=='BROKEN').slice(0,6);
    html += `<div class="card">
      <div class="card-title">ORDER BLOCKS (All TFs)</div>
      <div class="levels-list">`;
    if(relevantOBs.length) {
      relevantOBs.forEach(ob => {
        const isActive = curPrice >= ob.low && curPrice <= ob.high;
        const tagClass = ob.state==='FRESH' ? 'tag-fresh' : ob.state==='TAPPED' ? 'tag-tapped' : 'tag-swept';
        const typeColor = ob.type==='demand' ? 'var(--green)' : 'var(--red)';
        html += `<div class="level-row" style="border-left:2px solid ${typeColor}${isActive?';background:rgba(64,169,255,0.06)':''}">
          <span class="level-label" style="color:${typeColor}">${ob.label}</span>
          <span class="level-value" style="font-size:10px;color:var(--sub)">${_p(ob.low)} – ${_p(ob.high)}</span>
          <span class="level-tag ${tagClass}">${ob.state}</span>
          ${isActive ? '<span style="font-size:9px;color:var(--blue);font-family:var(--font-head);font-weight:700;letter-spacing:0.06em">▶ ACTIVE</span>' : ''}
        </div>`;
      });
    } else {
      html += `<div style="font-size:11px;color:var(--muted);padding:8px">No valid OBs detected</div>`;
    }
    html += `</div></div>`;

    // FVG Zones
    const openFVGs = zoneData.fvg.filter(f=>f.state==='OPEN').slice(0,6);
    html += `<div class="card">
      <div class="card-title">FAIR VALUE GAPS (All TFs)</div>
      <div class="levels-list">`;
    if(openFVGs.length) {
      openFVGs.forEach(fvg => {
        const isActive = curPrice >= fvg.low && curPrice <= fvg.high;
        const typeColor = fvg.type==='bull' ? 'var(--green)' : 'var(--red)';
        html += `<div class="level-row" style="border-left:2px solid ${typeColor}${isActive?';background:rgba(64,169,255,0.06)':''}">
          <span class="level-label" style="color:${typeColor}">${fvg.label}</span>
          <span class="level-value" style="font-size:10px;color:var(--sub)">${_p(fvg.low)} – ${_p(fvg.high)}</span>
          <span style="font-size:10px;color:var(--sub);font-family:var(--font-mono)">CE: ${_p(fvg.mid)}</span>
          <span class="level-tag tag-fresh">OPEN</span>
        </div>`;
      });
    } else {
      html += `<div style="font-size:11px;color:var(--muted);padding:8px">No open FVGs detected</div>`;
    }
    html += `</div></div></div>`;

    /* ── F. Derivatives Panel ─────────────────────────────── */
    html += `<div class="card" style="background:var(--bg2);border:1px solid var(--border);">
      <div class="card-title">DERIVATIVES INTELLIGENCE</div>
      <div class="derivs-grid">
        <div class="deriv-cell">
          <div class="deriv-label">FUNDING RATE</div>
          <div class="deriv-value" style="color:${derivInterp.fundingColor}">${derivInterp.fundingRate}</div>
          <div class="deriv-sub">${derivInterp.fundingState}</div>
        </div>
        <div class="deriv-cell">
          <div class="deriv-label">NEXT FUNDING</div>
          <div class="deriv-value">${derivInterp.nextFunding}</div>
          <div class="deriv-sub">Settlement time UTC</div>
        </div>
        <div class="deriv-cell">
          <div class="deriv-label">OI TREND (24H)</div>
          <div class="deriv-value" style="color:${derivInterp.oiChange && parseFloat(derivInterp.oiChange)>0 ? 'var(--green)' : 'var(--red)'}">${derivInterp.oiTrend}</div>
          <div class="deriv-sub">Open interest change</div>
        </div>
        <div class="deriv-cell">
          <div class="deriv-label">TAKER VOL RATIO</div>
          <div class="deriv-value" style="color:${derivInterp.takerColor}">${derivInterp.takerBias}</div>
          <div class="deriv-sub">Buy vs sell pressure</div>
        </div>
        <div class="deriv-cell">
          <div class="deriv-label">L/S RATIO</div>
          <div class="deriv-value">${derivInterp.lsState}</div>
          <div class="deriv-sub">Account positioning</div>
        </div>
        <div class="deriv-cell">
          <div class="deriv-label">MARK/INDEX BASIS</div>
          <div class="deriv-value">${derivInterp.basis}</div>
          <div class="deriv-sub">Perp vs spot premium</div>
        </div>
      </div>
      <div style="margin-top:8px;padding:10px 14px;background:var(--bg3);font-size:11px;font-family:var(--font-mono);">
        <span style="color:var(--muted);font-family:var(--font-head);font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">VERDICT&nbsp;&nbsp;</span>
        <span style="color:${derivInterp.verdict.includes('GENUINE')?'var(--green)':derivInterp.verdict.includes('RISK')?'var(--red)':'var(--gold)'}">${derivInterp.verdict}</span>
      </div>
    </div>`;

    /* ── G. Trade Plan ───────────────────────────────────── */
    if(tradePlan.valid) {
      const isLong = tradePlan.direction === 'LONG';
      html += `
      <div class="trade-plan">
        <div class="trade-plan-header">
          <span class="trade-direction-badge ${isLong?'badge-long':'badge-short'}">${isLong?'🟢 LONG':'🔴 SHORT'} SETUP</span>
          <span style="font-size:9px;font-family:var(--font-head);font-weight:700;letter-spacing:0.07em;color:var(--muted);">${tradePlan.setupType}</span>
          <span class="trade-model">${tradePlan.entryModel}</span>
          <span style="margin-left:auto;font-size:10px;font-family:var(--font-mono);color:var(--sub)">ATR: $${tradePlan.atr}</span>
        </div>
        <div class="trade-plan-body">
          <div class="trade-col">
            <div class="card-title">ENTRY LEVELS</div>
            <div class="trade-levels">
              <div class="trade-level-row entry">
                <span class="tl-label">ENTRY</span>
                <span class="tl-price" style="color:var(--blue)">$${tradePlan.entry}</span>
                <span class="tl-action">CE of exec TF FVG</span>
              </div>
              <div class="trade-level-row sl">
                <span class="tl-label">STOP LOSS</span>
                <span class="tl-price" style="color:var(--red)">$${tradePlan.sl}</span>
                <span class="tl-action">Risk: $${tradePlan.riskPips}</span>
              </div>
              <div class="trade-level-row" style="background:var(--red-dim);border-left:2px solid var(--red);">
                <span class="tl-label">INVALIDATION</span>
                <span class="tl-price" style="color:var(--red);font-size:11px">$${tradePlan.invalidation}</span>
                <span class="tl-action">Body close</span>
              </div>
            </div>
            <div style="margin-top:12px;" class="card-title">EXIT SIGNALS</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              ${tradePlan.invalidationRules.map(r=>`<div style="font-size:10px;color:var(--sub);font-family:var(--font-mono);padding:3px 6px;background:var(--bg3);">⚠ ${r}</div>`).join('')}
            </div>
          </div>
          <div class="trade-col">
            <div class="card-title">TARGETS & MANAGEMENT</div>
            <div class="trade-levels">
              <div class="trade-level-row tp1">
                <span class="tl-label">TP1</span>
                <span class="tl-price" style="color:var(--green)">$${tradePlan.tp1}</span>
                <span class="tl-rr">${tradePlan.rr1}R</span>
                <span class="tl-action" style="font-size:9px">${tradePlan.actions.atTP1}</span>
              </div>
              <div class="trade-level-row tp2">
                <span class="tl-label">TP2</span>
                <span class="tl-price" style="color:var(--green)">$${tradePlan.tp2}</span>
                <span class="tl-rr">${tradePlan.rr2}R</span>
                <span class="tl-action" style="font-size:9px">${tradePlan.actions.atTP2}</span>
              </div>
              <div class="trade-level-row tp3">
                <span class="tl-label">TP3</span>
                <span class="tl-price" style="color:var(--green)">$${tradePlan.tp3}</span>
                <span class="tl-rr">${tradePlan.rr3}R</span>
                <span class="tl-action" style="font-size:9px">${tradePlan.actions.atTP3}</span>
              </div>
              <div class="trade-level-row runner">
                <span class="tl-label">RUNNER</span>
                <span class="tl-price" style="color:var(--gold)">$${tradePlan.runner}</span>
                <span class="tl-rr" style="color:var(--gold)">${tradePlan.rrR}R</span>
                <span class="tl-action" style="font-size:9px">${tradePlan.actions.runner}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Obstacle Map -->
        ${tradePlan.obstacles.length ? `
        <div style="padding:14px 20px;border-top:1px solid var(--border);">
          <div class="card-title">OBSTACLE MAP — Between Entry & TP3</div>
          <div class="obstacle-list">
            ${tradePlan.obstacles.map((o,i)=>`
            <div class="obstacle-row">
              <span class="ob-num">#${i+1}</span>
              <span class="ob-zone">${o.label} — $${_p(o.price)}</span>
              <span class="ob-tag ${i===0?'major':'minor'}">${i===0?'FIRST BARRIER':'BARRIER'}</span>
            </div>`).join('')}
          </div>
          ${tradePlan.htfResistance.length ? `<div style="margin-top:8px;padding:8px;background:rgba(255,68,68,0.05);border:1px solid rgba(255,68,68,0.15);font-size:10px;color:var(--red);font-family:var(--font-mono);">
            ⚠ HTF RESISTANCE: ${tradePlan.htfResistance.join(' | ')}
          </div>` : '<div style="margin-top:6px;font-size:10px;color:var(--green);font-family:var(--font-mono);">✅ No major HTF resistance blocking path to TP1</div>'}
        </div>` : ''}
      </div>`;

      /* ── H. Confluence Score ───────────────────────────── */
      html += `
      <div class="score-panel">
        <div class="score-circle-wrap">
          <div class="score-number" style="color:${score.scoreColor}">${score.total}</div>
          <div class="score-denom">/ ${score.maxScore}</div>
          <div class="score-grade" style="color:${score.scoreColor}">${score.grade} SETUP</div>
        </div>
        <div class="score-bars">
          ${Object.entries(score.breakdown).map(([k,v])=>`
          <div class="score-bar-row">
            <span class="score-bar-label">${k}</span>
            <div class="score-bar-track">
              <div class="score-bar-fill" style="width:${(v.score/v.max)*100}%;background:${v.score===v.max?'var(--green)':v.score>0?'var(--gold)':'var(--red)'}"></div>
            </div>
            <span class="score-bar-val">${v.score}/${v.max}</span>
          </div>`).join('')}
        </div>
        <div style="align-self:flex-start;padding:12px 18px;background:var(--bg3);border:1px solid var(--border);min-width:140px;">
          <div style="font-family:var(--font-head);font-size:9px;font-weight:700;letter-spacing:0.1em;color:var(--muted);text-transform:uppercase;margin-bottom:6px;">RISK ALLOCATION</div>
          <div style="font-family:var(--font-mono);font-size:12px;color:${score.total>=12?'var(--green)':score.total>=8?'var(--gold)':'var(--sub)'}">
            ${score.total>=12 ? '1% — Full Risk' : score.total>=8 ? '0.5% — Half Risk' : '0.25% — Reduced'}
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;">
            ${score.total>=12 ? 'All models permitted' : score.total>=8 ? 'Model 2 only' : 'Model 2 confirmation only'}
          </div>
        </div>
      </div>`;
    }

    html += `</div>`; // end analysis-output

    /* ── I. Signal Panel + Copy Button ──────────────────────
       Only rendered for valid trade setups                  */
    if(tradePlan.valid) {
      // Store report on window so copySignal() can access it
      window._ATL_lastReport = r;
      html += `
      <div class="signal-panel" id="signal-panel">
        <div class="signal-panel-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-family:var(--font-head);font-size:9px;font-weight:700;letter-spacing:0.12em;color:var(--green)">📡 ATL SIGNAL</span>
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--muted)">${symbol} · ${_tfLabel(tf)} · ${score.grade} Grade · ${score.total}/${score.maxScore}</span>
          </div>
          <button class="btn-copy-signal" id="copy-signal-btn" onclick="ATL.copySignal()">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h8a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.4"/></svg>
            COPY SIGNAL
          </button>
        </div>
        <pre class="signal-preview" id="signal-preview">${_escHtml(_buildSignalText(r))}</pre>
      </div>`;
    }

    document.getElementById('single-loading').classList.add('hidden');
    const out = document.getElementById('single-output');
    out.innerHTML = html;
    out.classList.remove('hidden');
  }

  function _levelRow(label, price, color, tagClass) {
    if(!price) return '';
    return `<div class="level-row">
      <span class="level-label" style="color:${color}">${label}</span>
      <span class="level-value" style="color:${color}">$${_p(price)}</span>
      <span class="level-tag ${tagClass}">${label.includes('CURRENT') ? 'LIVE' : 'KEY'}</span>
    </div>`;
  }

  /* ─────────────────────────────────────────────────────────
     SIGNAL TEXT BUILDER + COPY
  ───────────────────────────────────────────────────────── */
  function _buildSignalText(r) {
    const { symbol, tf, ohlcvData, derivData, structureData, zoneData, sessionData, tradePlan, score } = r;
    const execCandles  = ohlcvData[tf] || [];
    const curPrice     = execCandles.length ? execCandles[execCandles.length-1].close : 0;
    const derivInterp  = _interpretDerivatives(derivData);
    const conflict     = structureData._conflict;
    const conflictLabel = conflict.verdict.replace('_ALIGNED','').replace('_',' ');
    const isLong       = tradePlan.direction === 'LONG';
    const dirEmoji     = isLong ? '📈' : '📉';
    const sep          = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const sep2         = '━━━';

    // HTF alignment summary (top 3 TFs only)
    const htfRows = conflict.table.filter(r => ['W','1D','4H','1H'].includes(r.tf)).slice(0,4);
    const htfLine = htfRows.map(r => `${r.tf} ${r.bias.replace('(CHoCH)','±')}`).join(' · ') || '—';

    // Near FVG for entry zone
    const nearFVG = isLong
      ? zoneData.fvg.find(f => f.type==='bull' && f.high >= curPrice * 0.97 && f.high <= curPrice * 1.03)
      : zoneData.fvg.find(f => f.type==='bear' && f.low  <= curPrice * 1.03 && f.low  >= curPrice * 0.97);

    // Swept liquidity context
    const sweptSSL = zoneData.ssl.filter(s => s.swept).slice(-1)[0];
    const sweptBSL = zoneData.bsl.filter(s => s.swept).slice(-1)[0];
    const sweptLine = isLong
      ? (sweptSSL ? `✅ SSL swept — stop hunt complete, longs cleared` : '⚠️ No SSL swept — wait for sweep confirmation')
      : (sweptBSL ? `✅ BSL swept — stop hunt complete, shorts cleared` : '⚠️ No BSL swept — wait for sweep confirmation');

    // Deriv summary
    const fundingVal = derivInterp.fundingRate || '—';
    const oiVal      = derivInterp.oiTrend     || '—';
    const lsVal      = derivInterp.lsState     || '—';
    const derivVerdict = derivInterp.verdict   || '—';

    // Score breakdown one-liner
    const breakdownLine = Object.entries(score.breakdown)
      .map(([k,v]) => `${k} ${v.score}/${v.max}`)
      .join(' · ');

    // Risk allocation
    const risk = score.total >= 12 ? '1% — Full Risk' : score.total >= 8 ? '0.5% — Half Risk' : '0.25% — Reduced';

    // HTF resistance
    const htfResText = tradePlan.htfResistance?.length
      ? `⚠️ HTF resistance: ${tradePlan.htfResistance.join(' | ')}`
      : `✅ No major HTF resistance blocking path to TP1`;

    // Obstacle map (top 3)
    const obstacleLines = (tradePlan.obstacles || []).slice(0,3)
      .map((o,i) => `  ${i===0?'🔶':'🔸'} ${o.label} — $${_p(o.price)}`)
      .join('\n');

    // Invalidation rules
    const invLines = (tradePlan.invalidationRules || [])
      .filter(Boolean)
      .map(r => `  ❌ ${r}`)
      .join('\n');

    const now = new Date();
    const ts  = now.toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) + ' UTC';

    let txt = '';
    txt += `${sep}\n`;
    txt += `📡 ATL SIGNAL — AlphaTradersLabs\n`;
    txt += `${sep}\n`;
    txt += `🪙 ${symbol}  |  ${_tfLabel(tf)}  |  Score: ${score.total}/${score.maxScore} (${score.grade})\n`;
    txt += `${dirEmoji} SIGNAL: ${tradePlan.direction}\n`;
    txt += `📊 Bias: ${conflictLabel}  |  AMD: ${sessionData.amdPhase}\n`;
    txt += `${sessionData.killZoneActiveNow ? '🔥 Kill Zone ACTIVE\n' : ''}`;
    txt += `\n${sep2} EXECUTION PLAN ${sep2}\n`;
    txt += `📍 Entry:      $${tradePlan.entry}  (${tradePlan.entryModel})\n`;
    txt += `🛑 Stop Loss:  $${tradePlan.sl}  (Risk: $${tradePlan.riskPips})\n`;
    txt += `❌ Invalidate: $${tradePlan.invalidation}  (body close beyond)\n`;
    txt += `🎯 TP1:        $${tradePlan.tp1}  (${tradePlan.rr1}R)\n`;
    txt += `🎯 TP2:        $${tradePlan.tp2}  (${tradePlan.rr2}R)\n`;
    txt += `🎯 TP3:        $${tradePlan.tp3}  (${tradePlan.rr3}R)\n`;
    txt += `🏃 Runner:     $${tradePlan.runner}  (${tradePlan.rrR}R)\n`;
    txt += `⚖️ Setup Type: ${tradePlan.setupType}  |  ATR: $${tradePlan.atr}\n`;
    txt += `\n${sep2} HTF ALIGNMENT ${sep2}\n`;
    txt += `${htfLine}\n`;
    if(nearFVG) {
      txt += `\n${sep2} ENTRY ZONE ${sep2}\n`;
      txt += `${isLong?'🟢':'🔴'} FVG: $${_p(nearFVG.low)} – $${_p(nearFVG.high)}  (CE: $${_p(nearFVG.mid)})\n`;
    }
    if(obstacleLines) {
      txt += `\n${sep2} OBSTACLES TO TP3 ${sep2}\n`;
      txt += obstacleLines + '\n';
    }
    txt += `\n${sep2} LIQUIDITY ${sep2}\n`;
    txt += `${sweptLine}\n`;
    txt += `\n${sep2} DERIVATIVES ${sep2}\n`;
    txt += `📈 Funding:   ${fundingVal}\n`;
    txt += `📊 OI Trend:  ${oiVal}\n`;
    txt += `👥 L/S Ratio: ${lsVal}\n`;
    txt += `⚡ Verdict:   ${derivVerdict}\n`;
    txt += `\n${sep2} CONFLUENCE ${sep2}\n`;
    txt += `${breakdownLine}\n`;
    if(invLines) {
      txt += `\n${sep2} INVALIDATION RULES ${sep2}\n`;
      txt += invLines + '\n';
    }
    txt += `${htfResText}\n`;
    txt += `\n${sep2} RISK ${sep2}\n`;
    txt += `💰 ${risk}\n`;
    txt += `\n${sep}\n`;
    txt += `⚠️  Not financial advice. Validate before trading.\n`;
    txt += `Powered by ATL · AlphaTradersLabs  |  ${ts}\n`;
    txt += sep;

    return txt;
  }

  function _escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function copySignal() {
    const r = window._ATL_lastReport;
    if(!r) return;
    const text = _buildSignalText(r);
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-signal-btn');
      if(!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> COPIED!`;
      btn.style.color = 'var(--green)';
      btn.style.borderColor = 'rgba(0,230,118,0.4)';
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.color = '';
        btn.style.borderColor = '';
      }, 2000);
    }).catch(() => {
      // Fallback for browsers without clipboard API
      const pre = document.getElementById('signal-preview');
      if(pre) { const range = document.createRange(); range.selectNode(pre); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); }
    });
  }

  /* ─────────────────────────────────────────────────────────
     LOADING STATE HELPERS
  ───────────────────────────────────────────────────────── */
  function _showSingleLoading(symbol) {
    _setEl('single-idle', null, true);
    _setEl('single-output', null, true);
    _setEl('single-loading', null, false);
    _setEl('loading-ticker-name', symbol);
    ['ohlcv','deriv','meta','structure','zones','session','trade','score'].forEach(id => {
      const icon = document.getElementById(`ls-${id}-icon`);
      if(icon) { icon.className = 'ls-icon pending'; }
      const step = document.getElementById(`ls-${id}`);
      if(step) step.className = 'loading-step';
    });
  }

  function _setStep(id, state, msg) {
    const icon = document.getElementById(`ls-${id}-icon`);
    const step = document.getElementById(`ls-${id}`);
    if(!icon || !step) return;
    const icons = {
      pending: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/></svg>`,
      active:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v4M8 10v4M2 8h4M10 8h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      done:    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      error:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    };
    icon.className = `ls-icon ${state}`;
    icon.innerHTML = icons[state] || icons.pending;
    step.className = `loading-step ${state === 'active' ? 'active' : state === 'done' ? 'done' : ''}`;
    if(msg) {
      const txt = step.querySelector('.ls-text');
      if(txt) txt.textContent = msg;
    }
  }

  function _showSingleError(msg) {
    document.getElementById('single-loading').classList.add('hidden');
    const out = document.getElementById('single-output');
    out.innerHTML = `<div class="no-trade-banner">
      <div class="nt-icon" style="color:var(--red)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v5M12 16v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div><div class="nt-title">ERROR</div><div class="nt-reason">${msg}</div></div>
    </div>`;
    out.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════
     MARKET SCAN ENGINE
  ═══════════════════════════════════════════════════════ */
  async function startMarketScan() {
    try {
      const symbols = await _fetchSymbolList();
      STATE.symbolList = symbols;
      _setEl('scan-symbol-count', symbols.length.toLocaleString());
    } catch(e) {
      _setEl('scan-symbol-count', '~300');
    }
    document.getElementById('scan-confirm-modal').classList.remove('hidden');
  }

  function cancelScan() {
    document.getElementById('scan-confirm-modal').classList.add('hidden');
  }

  /* ── Exchange fallback helpers ─────────────────────────────── */

  // Symbol list: Binance primary → Bybit fallback
  async function _fetchSymbolList() {
    try {
      const info = await _fetchRaw(`${CFG.bf}/exchangeInfo`);
      const syms = info.symbols
        .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
        .map(s => s.symbol);
      if(syms.length > 10) {
        _log('Symbol list: Binance (' + syms.length + ' perpetuals)', 'ok');
        return syms;
      }
      throw new Error('Empty list');
    } catch(e) {
      _log('Binance exchangeInfo failed — trying Bybit...', 'warn');
      try {
        // Bybit returns max 1000 per page, use cursor paging
        let syms = [], cursor = '';
        do {
          const url = `${CFG.by}/instruments-info?category=linear&limit=1000` + (cursor ? `&cursor=${cursor}` : '');
          const data = await _fetchRaw(url);
          const list = (data?.result?.list || [])
            .filter(s => s.contractType === 'LinearPerpetual' && s.status === 'Trading' && s.quoteCoin === 'USDT')
            .map(s => s.symbol);
          syms = syms.concat(list);
          cursor = data?.result?.nextPageCursor || '';
        } while(cursor);
        _log('Symbol list: Bybit fallback (' + syms.length + ' perpetuals)', 'ok');
        return syms;
      } catch(e2) {
        _log('Both exchanges failed for symbol list — using cached list', 'warn');
        return STATE.symbolList.length ? STATE.symbolList : [];
      }
    }
  }

  // 24hr volume map: Binance primary → Bybit fallback
  async function _fetchVolMap() {
    try {
      const ticker24h = await _fetchRaw(`${CFG.bf}/ticker/24hr`);
      if(Array.isArray(ticker24h) && ticker24h.length > 10) {
        const map = {};
        ticker24h.forEach(t => { map[t.symbol] = parseFloat(t.quoteVolume || 0); });
        _log('Volume data: Binance (' + ticker24h.length + ' tickers)', 'ok');
        return map;
      }
      throw new Error('Empty ticker');
    } catch(e) {
      _log('Binance ticker/24hr failed — trying Bybit...', 'warn');
      try {
        const data = await _fetchRaw(`${CFG.by}/tickers?category=linear`);
        const list = data?.result?.list || [];
        const map = {};
        list.forEach(t => { map[t.symbol] = parseFloat(t.turnover24h || 0); });
        _log('Volume data: Bybit fallback (' + list.length + ' tickers)', 'ok');
        return map;
      } catch(e2) {
        _log('Both exchanges failed for volume data — scanning without volume filter', 'warn');
        return {};
      }
    }
  }

  // Derivatives: Bybit fallback when Binance fails
  async function _fetchDerivativesBybit(symbol) {
    const [funding, oi] = await Promise.allSettled([
      _fetchRaw(`${CFG.by}/funding/history?category=linear&symbol=${symbol}&limit=24`),
      _fetchRaw(`${CFG.by}/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=48`)
    ]);
    const fundingList = funding.status === 'fulfilled' ? (funding.value?.result?.list || []) : [];
    const oiList = oi.status === 'fulfilled' ? (oi.value?.result?.list || []) : [];
    return {
      premiumIndex: null,
      fundingHistory: fundingList.map(f => ({ fundingRate: f.fundingRate, fundingTime: +f.fundingRateTimestamp })),
      oiHistory: oiList.map(o => ({ sumOpenInterest: o.openInterest, timestamp: +o.timestamp })),
      takerRatio: [],
      lsRatio: []
    };
  }

  async function confirmScan() {
    document.getElementById('scan-confirm-modal').classList.add('hidden');
    STATE.scanAborted = false;
    STATE.scanRunning = true;
    STATE.scanResults = { longs: [], shorts: [], watch: [] };

    // Update nav counts
    _updateScanCounts();

    const minScore = parseInt(document.getElementById('scan-min-score').value);
    const direction = document.getElementById('scan-direction').value;
    const tf = STATE.marketScanTF;

    // Show progress panel
    document.getElementById('market-setup-panel').classList.add('hidden');
    const prog = document.getElementById('market-progress-panel');
    prog.classList.remove('hidden');
    _resetProgress();

    try {
      // ── PHASE 1: SYMBOL LIST ────────────────────────────
      _setPhase('PHASE 1 — FETCHING SYMBOL LIST');
      _log('Connecting to exchange...');

      let symbols = STATE.symbolList;
      if(!symbols.length) {
        symbols = await _fetchSymbolList();
        STATE.symbolList = symbols;
      }

      _log(`Found ${symbols.length} perpetual contracts`, 'ok');
      _log('Sorting by volume and applying depth limit...', '');

      // ── PHASE 2: SORT BY VOLUME + DEPTH LIMIT (no hard $ filter) ─────────
      _setPhase('PHASE 2 — VOLUME SORT & DEPTH LIMIT');
      _setProgress(5, `0 / ${symbols.length}`);

      const volMap = await _fetchVolMap();

      // Sort all symbols by 24h volume descending, include ALL with any volume
      let filtered = symbols
        .map(sym => ({ symbol: sym, vol24h: volMap[sym] || 0 }))
        .filter(s => s.vol24h > 0)
        .sort((a, b) => b.vol24h - a.vol24h);

      // Apply depth limit from UI dropdown
      const scanDepth = document.getElementById('scan-depth').value;
      if(scanDepth !== 'ALL') {
        filtered = filtered.slice(0, parseInt(scanDepth));
      }

      _log(`Scanning ${filtered.length} symbols (sorted by volume, depth: ${scanDepth})`, 'ok');
      _setProgress(10, `Scanning ${filtered.length} symbols`);

      if(STATE.scanAborted) return _abortScanCleanup();

      // ── PHASE 3: STRUCTURE + DERIVATIVES SCAN ───────────
      _setPhase('PHASE 3 — FULL SMC ANALYSIS');

      const total = filtered.length;
      let done = 0;
      const BATCH = CFG.SCAN_BATCH;

      for(let i = 0; i < filtered.length; i += BATCH) {
        if(STATE.scanAborted) break;
        const batch = filtered.slice(i, i + BATCH);
        const pct = Math.round((i/total)*80) + 10;
        _setProgress(pct, `${done} / ${total}`);
        _setPhase(`PHASE 3 — SCANNING (${done} / ${total})`);

        await Promise.allSettled(batch.map(async item => {
          if(STATE.scanAborted) return;
          try {
            const ohlcvData = await _fetchAllOHLCV_scan(item.symbol, tf);
            const derivData = await _fetchDerivatives(item.symbol);
            const structureData = _computeTopDownStructure(ohlcvData, tf);
            const zoneData = _computeZones(ohlcvData, tf);
            const sessionData = _computeSession();
            const tradePlan = _generateTradePlan(ohlcvData, structureData, zoneData, derivData, tf);
            const score = _computeScore(structureData, zoneData, sessionData, derivData, tradePlan);

            if(!tradePlan.valid || score.total < minScore) return;
            if(direction === 'long' && tradePlan.direction !== 'LONG') return;
            if(direction === 'short' && tradePlan.direction !== 'SHORT') return;

            const execCandles = ohlcvData[tf] || [];
            const curPrice = execCandles.length ? execCandles[execCandles.length-1].close : 0;
            const derivInterp = _interpretDerivatives(derivData);

            const result = {
              symbol: item.symbol, vol24h: item.vol24h, tf, curPrice,
              tradePlan, score, structureData, zoneData, sessionData, derivInterp,
              conflict: structureData._conflict
            };

            if(tradePlan.direction === 'LONG') {
              STATE.scanResults.longs.push(result);
              _addLiveChip(item.symbol, score.total, 'long');
              _log(`✅ LONG: ${item.symbol} — Score ${score.total}/16 (${score.grade})`, 'ok');
            } else if(tradePlan.direction === 'SHORT') {
              STATE.scanResults.shorts.push(result);
              _addLiveChip(item.symbol, score.total, 'short');
              _log(`📉 SHORT: ${item.symbol} — Score ${score.total}/16 (${score.grade})`, 'err');
            }
          } catch(e) {
            // Skip failed symbols silently
          }
        }));

        done = Math.min(i + BATCH, total);
        await _sleep(600); // Rate limit breathing room — 3 calls/symbol * 3 batch = 9 req per 600ms
      }

      // ── PHASE 4: WATCH ONLY ──────────────────────────────
      _setPhase('PHASE 4 — DETECTING WATCH SETUPS');
      _setProgress(92, 'Finding watch setups...');
      await _sleep(200);

      // Coins with score >= 5 but below minScore go to watch
      const watchMinScore = Math.max(4, minScore - 3);
      for(let i = 0; i < filtered.length; i += BATCH) {
        if(STATE.scanAborted) break;
        const batch = filtered.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async item => {
          const alreadyFound = STATE.scanResults.longs.some(r=>r.symbol===item.symbol) ||
                                STATE.scanResults.shorts.some(r=>r.symbol===item.symbol);
          if(alreadyFound) return;
          try {
            const ohlcvData = await _fetchAllOHLCV_scan(item.symbol, tf);
            const derivData = await _fetchDerivatives(item.symbol);
            const structureData = _computeTopDownStructure(ohlcvData, tf);
            const zoneData = _computeZones(ohlcvData, tf);
            const sessionData = _computeSession();
            const tradePlan = _generateTradePlan(ohlcvData, structureData, zoneData, derivData, tf);
            const score = _computeScore(structureData, zoneData, sessionData, derivData, tradePlan);

            if(tradePlan.valid && score.total >= watchMinScore && score.total < minScore) {
              const execCandles = ohlcvData[tf]||[];
              const curPrice = execCandles.length ? execCandles[execCandles.length-1].close : 0;
              STATE.scanResults.watch.push({ symbol:item.symbol, vol24h:item.vol24h, tf, curPrice, tradePlan, score, structureData, zoneData, sessionData, derivInterp:_interpretDerivatives(derivData) });
              _addLiveChip(item.symbol, score.total, 'watch');
            }
          } catch(e) {}
        }));
        await _sleep(500);
      }

      // ── PHASE 5: SORT + RENDER ───────────────────────────
      _setPhase('PHASE 5 — COMPILING RESULTS');
      _setProgress(97, 'Sorting and rendering...');
      await _sleep(300);

      STATE.scanResults.longs.sort((a,b)=>b.score.total - a.score.total);
      STATE.scanResults.shorts.sort((a,b)=>b.score.total - a.score.total);
      STATE.scanResults.watch.sort((a,b)=>b.score.total - a.score.total);

      STATE.lastScanTS = Date.now();
      STATE.scanRunning = false;
      _updateScanCounts();

      _setProgress(100, 'Complete');
      _setPhase('✅ SCAN COMPLETE');
      _log(`Scan complete — ${STATE.scanResults.longs.length} longs | ${STATE.scanResults.shorts.length} shorts | ${STATE.scanResults.watch.length} watch`, 'ok');

      await _sleep(600);

      _renderScanResults();
      _populateSetupViews();

    } catch(err) {
      _log('Fatal scan error: ' + (err.message||'unknown'), 'err');
      STATE.scanRunning = false;
    }
  }

  function abortScan() {
    STATE.scanAborted = true;
    STATE.scanRunning = false;
    _setPhase('ABORTED');
    _log('Scan aborted by user', 'warn');
    document.getElementById('market-setup-panel').classList.remove('hidden');
    document.getElementById('market-progress-panel').classList.add('hidden');
  }

  function _abortScanCleanup() {
    STATE.scanRunning = false;
    _log('Scan aborted', 'warn');
  }

  /* ── Progress Helpers ───────────────────────────────── */
  function _resetProgress() {
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('scan-progress-text').textContent = '0 / 0';
    document.getElementById('scan-log').innerHTML = '';
    document.getElementById('scan-live-grid').innerHTML = '';
  }

  function _setProgress(pct, label) {
    document.getElementById('progress-bar').style.width = Math.min(pct,100) + '%';
    if(label) document.getElementById('scan-progress-text').textContent = label;
  }

  function _setPhase(label) {
    document.getElementById('scan-phase-label').textContent = label;
  }

  function _log(msg, type='') {
    const log = document.getElementById('scan-log');
    if(!log) return;
    const el = document.createElement('div');
    el.className = `scan-log-entry ${type}`;
    const ts = new Date().toLocaleTimeString('en-GB',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    el.textContent = `[${ts}] ${msg}`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function _addLiveChip(symbol, score, type) {
    const grid = document.getElementById('scan-live-grid');
    if(!grid) return;
    const chip = document.createElement('div');
    chip.className = `scan-live-chip ${type}-chip`;
    chip.innerHTML = `<span class="chip-ticker" style="color:${type==='long'?'var(--green)':type==='short'?'var(--red)':'var(--gold)'}">${symbol.replace('USDT','')}</span><span class="chip-score">${score}/16</span>`;
    grid.appendChild(chip);
  }

  function _updateScanCounts() {
    const { longs, shorts, watch } = STATE.scanResults;
    _setEl('count-longs', longs.length);
    _setEl('count-shorts', shorts.length);
    _setEl('count-watch', watch.length);
    _setEl('longs-count-title', longs.length);
    _setEl('shorts-count-title', shorts.length);
    _setEl('watch-count-title', watch.length);
    _setEl('badge-market', longs.length + shorts.length > 0 ? (longs.length+shorts.length)+'' : '');

    // Enable nav items
    ['longs','shorts','watchlist'].forEach(v => {
      const btn = document.getElementById(`nav-${v}`);
      if(btn) btn.disabled = false;
    });
  }

  /* ── Render Scan Results Summary ───────────────────── */
  function _renderScanResults() {
    const { longs, shorts, watch } = STATE.scanResults;
    const res = document.getElementById('market-results');
    res.innerHTML = `
    <div class="scan-summary-bar">
      <div class="scan-summary-item">
        <span class="scan-sum-label">LONG SETUPS</span>
        <span class="scan-sum-val" style="color:var(--green)">${longs.length}</span>
      </div>
      <div class="scan-summary-item">
        <span class="scan-sum-label">SHORT SETUPS</span>
        <span class="scan-sum-val" style="color:var(--red)">${shorts.length}</span>
      </div>
      <div class="scan-summary-item">
        <span class="scan-sum-label">WATCH ONLY</span>
        <span class="scan-sum-val" style="color:var(--gold)">${watch.length}</span>
      </div>
      <div class="scan-summary-item">
        <span class="scan-sum-label">SCAN TF</span>
        <span class="scan-sum-val" style="color:var(--sub)">${_tfLabel(STATE.marketScanTF)}</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:10px;align-items:center;">
        <span style="font-size:10px;color:var(--muted);font-family:var(--font-mono)">Scanned at ${new Date().toLocaleTimeString()}</span>
        <button class="btn-ghost btn-sm" onclick="ATL.switchView('longs')">VIEW LONGS</button>
        <button class="btn-ghost btn-sm" onclick="ATL.switchView('shorts')">VIEW SHORTS</button>
      </div>
    </div>`;
    res.classList.remove('hidden');
    document.getElementById('market-setup-panel').classList.remove('hidden');
  }

  /* ── Populate Long/Short/Watch views ───────────────── */
  function _populateSetupViews() {
    _renderSetupGrid('longs-content', STATE.scanResults.longs, 'long');
    _renderSetupGrid('shorts-content', STATE.scanResults.shorts, 'short');
    _renderSetupGrid('watch-content', STATE.scanResults.watch, 'watch');
  }

  function _renderSetupGrid(containerId, items, cardType) {
    const el = document.getElementById(containerId);
    if(!el) return;
    if(!items.length) {
      el.innerHTML = `<div class="no-scan-msg">No ${cardType} setups found in this scan.</div>`;
      return;
    }
    el.innerHTML = items.map(r => _setupCard(r, cardType)).join('');
  }

  function _setupCard(r, cardType) {
    const { symbol, curPrice, score, tradePlan, conflict, derivInterp, sessionData } = r;
    const ticker = symbol.replace('USDT','');
    const isLong = cardType === 'long';
    const sc = score.scoreColor;
    const conflictLabel = (conflict?.verdict||'MIXED').replace('_ALIGNED','').replace('_',' ');

    return `<div class="setup-card ${cardType}-card" onclick="ATL.openSetupDetail('${symbol}','${r.tf}')">
      <div class="sc-header">
        <div class="sc-ticker-price">
          <span class="sc-ticker-sym">${ticker}</span>
          <span class="sc-ticker-prc">$${_fmt(curPrice, curPrice > 1 ? 2 : 6)}</span>
        </div>
        <div class="sc-score-badge">
          <span class="sc-score-num" style="color:${sc}">${score.total}</span>
          <span class="sc-score-grade" style="color:${sc}">${score.grade}</span>
        </div>
      </div>
      <div class="sc-body">
        <div class="sc-mini-row">
          <span class="sc-mini-label">DIRECTION</span>
          <span style="color:${isLong?'var(--green)':'var(--red)'}">${tradePlan.direction}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">ENTRY</span>
          <span>$${tradePlan.entry}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">SL</span>
          <span style="color:var(--red)">$${tradePlan.sl}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">TP1 / TP2</span>
          <span style="color:var(--green)">$${tradePlan.tp1} / $${tradePlan.tp2}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">RR</span>
          <span style="color:var(--green)">${tradePlan.rr1}R / ${tradePlan.rr2}R / ${tradePlan.rr3}R</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">BIAS</span>
          <span style="color:var(--sub)">${conflictLabel}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">FUNDING</span>
          <span style="color:${derivInterp?.fundingColor||'var(--text)'}">${derivInterp?.fundingRate||'—'}</span>
        </div>
        <div class="sc-mini-row">
          <span class="sc-mini-label">SESSION</span>
          <span style="color:var(--sub);font-size:10px">${sessionData?.currentSession||'—'}</span>
        </div>
      </div>
      <div class="sc-footer">
        <span class="sc-tag">${_tfLabel(r.tf)}</span>
        ${sessionData?.killZoneActiveNow ? '<span class="sc-tag" style="color:var(--green);border-color:rgba(0,230,118,0.3)">KILL ZONE ✅</span>' : ''}
        ${tradePlan.setupType ? `<span class="sc-tag">${tradePlan.setupType}</span>` : ''}
        ${score.total >= 14 ? '<span class="sc-tag" style="color:var(--green);border-color:rgba(0,230,118,0.3)">A+ SETUP</span>' : ''}
        ${(derivInterp?.verdict||'').includes('GENUINE') ? '<span class="sc-tag" style="color:var(--green);border-color:rgba(0,230,118,0.2)">CONFIRMED OI</span>' : ''}
      </div>
    </div>`;
  }

  /* ── Setup Detail — opens single analysis for that coin ── */
  function openSetupDetail(symbol, tf) {
    switchView('single');
    const ticker = symbol.replace('USDT','');
    document.getElementById('single-ticker').value = ticker;
    // Match TF button
    document.querySelectorAll('#single-tf-selector .tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });
    STATE.selectedTF = tf;
    runSingleAnalysis();
  }

  /* ═══════════════════════════════════════════════════════
     UTILITY FUNCTIONS
  ═══════════════════════════════════════════════════════ */
  // Raw fetch — throws on non-2xx, NO retry (used where fallback handles retry)
  async function _fetchRaw(url) {
    const res = await fetch(url);
    if(res.ok) return res.json();
    throw new Error('HTTP ' + res.status);
  }

  // Fetch with retry + 429 backoff — used for critical non-fallback calls
  async function _fetch(url, retries = 3) {
    for(let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url);
      if(res.ok) return res.json();
      if(res.status === 429 || res.status === 418) {
        const wait = 1000 * Math.pow(2, attempt);
        _log('⚠️ Rate limit — backing off ' + (wait/1000) + 's (Binance → Bybit fallback active)', 'warn');
        await _sleep(wait);
        continue;
      }
      throw new Error('HTTP ' + res.status + ' — ' + url);
    }
    throw new Error('Max retries exceeded — ' + url);
  }

  function _setEl(id, value, hide) {
    const el = document.getElementById(id);
    if(!el) return;
    if(hide !== undefined) {
      if(hide) el.classList.add('hidden');
      else el.classList.remove('hidden');
    }
    if(value !== null && value !== undefined) el.textContent = value;
  }

  function _p(n) {
    if(n === null || n === undefined || isNaN(n)) return '—';
    const abs = Math.abs(n);
    if(abs >= 10000) return _fmt(n, 0);
    if(abs >= 100)   return _fmt(n, 2);
    if(abs >= 1)     return _fmt(n, 4);
    return _fmt(n, 6);
  }

  function _fmt(n, decimals=2) {
    if(n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function _fmtBig(n) {
    if(!n) return '—';
    if(n >= 1e12) return (n/1e12).toFixed(2)+'T';
    if(n >= 1e9)  return (n/1e9).toFixed(2)+'B';
    if(n >= 1e6)  return (n/1e6).toFixed(2)+'M';
    if(n >= 1e3)  return (n/1e3).toFixed(1)+'K';
    return n.toFixed(0);
  }

  function _tfLabel(tf) {
    const map = { '1':'1M','3':'3M','5':'5M','15':'15M','30':'30M','60':'1H','120':'2H','240':'4H','360':'6H','720':'12H','D':'1D','3D':'3D','W':'1W' };
    return map[tf] || tf;
  }

  function _pulse(id) {
    const el = document.getElementById(id);
    if(!el) return;
    el.style.borderColor = 'var(--red)';
    setTimeout(() => { el.style.borderColor = ''; }, 800);
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Expose public API ──────────────────────────────── */
  return {
    init,
    login, logout, switchView,
    runSingleAnalysis,
    startMarketScan, cancelScan, confirmScan, abortScan,
    openSetupDetail
  };

})();

/* ── Boot on DOM ready ─────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Add fadeOut keyframe
  const style = document.createElement('style');
  style.textContent = `@keyframes fadeOut { from{opacity:1;transform:translateY(0)} to{opacity:0;transform:translateY(-10px)} }`;
  document.head.appendChild(style);
  // Init the app (binds TF selectors, clock, Enter-key login handlers)
  ATL.init();
});

// Bind TF selectors on load
(function bindTFOnLoad() {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.tf-buttons');
        if(!group) return;
        group.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
})();
