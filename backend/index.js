require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5010;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8001';
const ML_ENABLED = (process.env.ML_ENABLED || 'false').toLowerCase() === 'true';
const RPC_URL = process.env.RPC_URL || 'https://cloudflare-eth.com';

// Gemini / LLM config (optional)
// Note: by default real LLM calls are disabled. Enable with USE_REAL_LLM=true.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = process.env.GEMINI_API_URL || '';
// Optionally preselect a model name (recommended to leave empty and let discovery run)
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT || '12000', 10);
const GEMINI_MAX_TOKENS = parseInt(process.env.GEMINI_MAX_TOKENS || '256', 10);
const GEMINI_CACHE_TTL = parseInt(process.env.GEMINI_CACHE_TTL || String(60 * 60), 10); // seconds
const USE_REAL_LLM = (process.env.USE_REAL_LLM || 'false').toLowerCase() === 'true';

// Discovery-cached model/method selected at startup (when USE_REAL_LLM=true)
let selectedGeminiModel = null; // e.g. 'models/gemini-2.5-flash'
let selectedGeminiMethod = null; // e.g. 'generateContent' or 'generateText'
let selectedGeminiPayload = null; // 'content' | 'prompt' | 'instances' | 'input' | 'messages'

// LLM rate limit (in-memory, per-IP) - safe defaults for prototype
const LLM_RATE_LIMIT_WINDOW_MS = parseInt(process.env.LLM_RATE_LIMIT_WINDOW_MS || '60000', 10); // 60s
const LLM_RATE_LIMIT_MAX = parseInt(process.env.LLM_RATE_LIMIT_MAX || '6', 10); // max calls per window

// per-IP rate state: Map<ip, { count:number, resetAt:number }>
const llmRateMap = new Map();

function getClientIp(req) {
  // express's req.ip respects X-Forwarded-For when trust proxy is set; this is fine for prototype
  return (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown');
}

function consumeLlmQuotaForIp(ip) {
  const now = Date.now();
  let entry = llmRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + LLM_RATE_LIMIT_WINDOW_MS };
  }
  if (entry.count >= LLM_RATE_LIMIT_MAX) {
    // update map with current entry (so resetAt is preserved)
    llmRateMap.set(ip, entry);
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count += 1;
  llmRateMap.set(ip, entry);
  return { allowed: true, remaining: Math.max(0, LLM_RATE_LIMIT_MAX - entry.count), resetAt: entry.resetAt };
}

// In-memory tracking for LLM usage (prototype only). Reports included in responses.
let llmUsage = { calls: 0, tokens: 0 };

const axiosInstance = axios.create();

// Discover an available Gemini model and preferred method at startup.
// This runs only when `USE_REAL_LLM` is true and a GEMINI_API_KEY is present.
async function discoverGeminiModel() {
  if (!USE_REAL_LLM || !GEMINI_API_KEY) return;
  try {
    const listBase = GEMINI_API_URL && GEMINI_API_URL.startsWith('http') ? (new URL(GEMINI_API_URL)).origin : 'https://generativelanguage.googleapis.com';
    const listUrl = `${listBase}/v1/models`;
    const urlWithKey = (() => { try { const u = new URL(listUrl); u.searchParams.set('key', GEMINI_API_KEY); return u.toString(); } catch (e) { return listUrl; } })();
    const resp = await axiosInstance.get(urlWithKey, { timeout: GEMINI_TIMEOUT });
    const models = resp.data && resp.data.models ? resp.data.models : [];
    // prefer models that list generateContent, otherwise generateText or generateMessage
    for (const m of models) {
      if (!m.supportedGenerationMethods) continue;
      if (m.supportedGenerationMethods.includes('generateContent')) {
        selectedGeminiModel = m.name;
        selectedGeminiMethod = 'generateContent';
        break;
      }
      if (m.supportedGenerationMethods.includes('generateText')) {
        selectedGeminiModel = m.name;
        selectedGeminiMethod = 'generateText';
        break;
      }
      if (m.supportedGenerationMethods.includes('generateMessage')) {
        selectedGeminiModel = m.name;
        selectedGeminiMethod = 'generateMessage';
        break;
      }
    }

    if (!selectedGeminiModel && GEMINI_MODEL) {
      // fall back to configured model name if provided
      selectedGeminiModel = GEMINI_MODEL;
      selectedGeminiMethod = 'generateContent';
    }

    if (selectedGeminiModel) {
      console.log(`Discovered Gemini model=${selectedGeminiModel} method=${selectedGeminiMethod}`);
      // Probe for accepted payload shape for the selected method (so we don't probe at runtime)
      try {
        // Strip 'models/' prefix if present (API returns 'models/gemini-...' but endpoint expects 'gemini-...')
        const modelName = selectedGeminiModel.replace(/^models\//, '');
        const tryUrl = `${listBase}/v1/models/${encodeURIComponent(modelName)}:${selectedGeminiMethod}`;
        const urlWithKeyTry = (() => { try { const u = new URL(tryUrl); u.searchParams.set('key', GEMINI_API_KEY); return u.toString(); } catch (e) { return tryUrl; } })();
        const probeText = 'probe';
        const probeVariants = {
          contents: { contents: [{ parts: [{ text: probeText }] }] },
          content: { content: [ { type: 'text', text: probeText } ] },
          prompt: { prompt: { text: probeText }, maxOutputTokens: 8 },
          input: { input: probeText },
          instances: { instances: [ { content: probeText } ] }
        };
        for (const [k, payload] of Object.entries(probeVariants)) {
          try {
            const r = await axiosInstance.post(urlWithKeyTry, payload, { timeout: 8000 });
            if (r && (r.status === 200 || r.status === 201)) {
              selectedGeminiPayload = k;
              console.log(`Detected payload shape for ${selectedGeminiMethod}: ${selectedGeminiPayload}`);
              break;
            }
          } catch (e) {
            // Log probe failures for debugging
            const errMsg = e?.response?.data?.error?.message || e?.message || String(e);
            console.log(`Probe '${k}' failed: ${errMsg.substring(0, 100)}`);
            continue;
          }
        }
        if (!selectedGeminiPayload) console.warn('Could not detect payload shape for selected Gemini model; runtime may probe on first call');
      } catch (e) {
        console.warn('Payload probe failed:', String(e));
      }
    } else {
      console.warn('No usable Gemini model discovered for the provided key');
    }
  } catch (e) {
    console.warn('Gemini model discovery failed:', String(e));
  }
}

// Helper to call a generic Gemini/LLM endpoint. The implementation is intentionally
// flexible: it sends both `messages` and `input`/`prompt` fields so it works with
// a variety of LLM REST endpoints (Vertex / OpenAI-like / vendor-provided).
async function callGeminiWithTx(tx) {
  // Only allow real calls when explicitly enabled and a model was discovered at startup
  if (!USE_REAL_LLM) {
    throw new Error('Real LLM usage is disabled (USE_REAL_LLM not enabled)');
  }
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }

  // check cache first (precision: avoid repeated calls for same tx)
  try {
    const cacheKey = `llm:${tx.txHash || tx.hash || JSON.stringify(tx).slice(0,24)}`;
    const cached = cache.get(cacheKey);
    if (cached && cached._expires && Date.now() < cached._expires) {
      return { raw: cached._raw, text: cached._text, json: cached._json, cached: true };
    }
  } catch (e) {}

  // Build the simple labeled input (not raw ethers JSON) matching the UI labels
  const labeled = [];
  labeled.push(`Tx: ${tx.txHash || tx.hash || 'unknown'}`);
  labeled.push(`From: ${tx.from || 'unknown'}`);
  labeled.push(`To: ${tx.to || 'unknown'}`);
  labeled.push(`Value: ${tx.value ?? tx.valueUSD ?? 'N/A'} ${tx.tokenSymbol || ''}`);
  labeled.push(`Block: ${tx.blockNumber ?? 'N/A'}`);
  labeled.push(`Timestamp: ${tx.timestamp ?? tx.fetchedAt ?? 'N/A'}`);
  labeled.push(`Gas used: ${tx.gasUsed ?? 'N/A'}`);
  labeled.push(`Gas price (Gwei): ${tx.gasPriceGwei ?? tx.gasPrice ?? 'N/A'}`);
  const promptBody = labeled.join('\n');

  // Instruction to the model to respond with JSON only and short analysis
  const instruction = `You are an assistant that analyzes blockchain transactions.\n` +
    `Given the labeled transaction below, return a JSON object (no extra text) with the following keys:\n` +
    `- summary: short human-readable summary string\n` +
    `- anomaly: { label: string, score: number } where score is 0..1\n` +
    `- feePrediction: string (ETH) or null\n` +
    `- recommendations: array of short action strings\n` +
    `Respond ONLY with valid JSON.\n\n` +
    `Transaction:\n${promptBody}`;

  // Ensure we have a discovered model and method
  if (!selectedGeminiModel || !selectedGeminiMethod) {
    throw new Error('No discovered Gemini model/method available (startup discovery may have failed)');
  }

  const listBase = GEMINI_API_URL && GEMINI_API_URL.startsWith('http') ? (new URL(GEMINI_API_URL)).origin : 'https://generativelanguage.googleapis.com';
  // Strip 'models/' prefix if present (API returns 'models/gemini-...' but endpoint expects 'gemini-...')
  const modelName = selectedGeminiModel.replace(/^models\//, '');
  const tryUrl = `${listBase}/v1/models/${encodeURIComponent(modelName)}:${selectedGeminiMethod}`;

  // Build payload according to the selected method
  let resp;
  const gHeaders = { 'Content-Type': 'application/json' };
  function withKeyInUrl(url) {
    try {
      const u = new URL(url);
      if (u.searchParams.has('key')) return u.toString();
      if (GEMINI_API_KEY) u.searchParams.set('key', GEMINI_API_KEY);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

    try {
      if (selectedGeminiMethod === 'generateContent') {
        // Use the payload shape detected at startup if available; otherwise try a small set of shapes.
        const buildPayloadFor = (shape) => {
          switch (shape) {
            case 'contents':
              // Official Google Gemini API format (contents with parts array)
              return { contents: [{ parts: [{ text: instruction }] }] };
            case 'content':
              return { content: [{ type: 'text', text: instruction }], temperature: 0 };
            case 'prompt':
              return { prompt: { text: instruction }, maxOutputTokens: GEMINI_MAX_TOKENS, temperature: 0 };
            case 'input':
              return { input: instruction, maxOutputTokens: GEMINI_MAX_TOKENS };
            case 'instances':
              return { instances: [{ content: instruction }], maxOutputTokens: GEMINI_MAX_TOKENS };
            case 'messages':
              return { messages: [{ role: 'user', content: instruction }] };
            default:
              // Default to official Gemini format
              return { contents: [{ parts: [{ text: instruction }] }] };
          }
        };

        const shapesToTry = selectedGeminiPayload ? [selectedGeminiPayload] : ['contents', 'content', 'prompt', 'instances', 'input'];
        let lastErr = null;
        for (const shape of shapesToTry) {
          const payload = buildPayloadFor(shape);
          try {
            resp = await axiosInstance.post(withKeyInUrl(tryUrl), payload, { headers: gHeaders, timeout: GEMINI_TIMEOUT });
            if (resp && (resp.status === 200 || resp.status === 201 || resp.status === 204)) {
              // cache runtime-detected payload shape if not set at startup
              if (!selectedGeminiPayload) {
                selectedGeminiPayload = shape;
                console.log(`Runtime-detected Gemini payload shape: ${selectedGeminiPayload}`);
              }
              break;
            }
          } catch (errTry) {
            lastErr = errTry;
            continue;
          }
        }
        if (!resp && lastErr) throw lastErr;
      } else {
        const payload = { prompt: { text: instruction }, maxOutputTokens: GEMINI_MAX_TOKENS, temperature: 0 };
        resp = await axiosInstance.post(withKeyInUrl(tryUrl), payload, { headers: gHeaders, timeout: GEMINI_TIMEOUT });
      }
    } catch (err) {
    const body = err?.response?.data || err?.toString();
    const status = err?.response?.status || 'no-status';
    const e = new Error(`LLM provider error ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    e.provider = { status, body };
    throw e;
  }

  // record usage if provider returns usage info
  try {
    const usage = resp.data?.usage || resp.data?.meta?.usage || null;
    if (usage) {
      // standard shapes: { prompt_tokens, completion_tokens, total_tokens } or { total_tokens }
      const total = usage.total_tokens || (usage.prompt_tokens && usage.completion_tokens ? (usage.prompt_tokens + usage.completion_tokens) : null);
      if (total) {
        llmUsage.calls += 1;
        llmUsage.tokens += total;
      } else {
        llmUsage.calls += 1;
      }
    } else {
      llmUsage.calls += 1;
    }
  } catch (e) {
    llmUsage.calls += 1;
  }

  // Best-effort extraction of text output from different provider shapes
  let textOut = null;
  try {
    // Google Gemini format: candidates[0].content.parts[0].text
    if (resp.data?.candidates && resp.data.candidates[0]) {
      const candidate = resp.data.candidates[0];
      if (candidate.content?.parts && Array.isArray(candidate.content.parts) && candidate.content.parts[0]) {
        textOut = candidate.content.parts[0].text;
      } else if (typeof candidate.content === 'string') {
        textOut = candidate.content;
      }
    }
    // OpenAI format
    if (!textOut && resp.data?.choices && resp.data.choices[0]) {
      if (resp.data.choices[0].message && resp.data.choices[0].message.content) textOut = resp.data.choices[0].message.content;
      else if (resp.data.choices[0].text) textOut = resp.data.choices[0].text;
    }
    // Vertex-style
    if (!textOut && resp.data?.output && Array.isArray(resp.data.output) && resp.data.output[0]) {
      const c = resp.data.output[0].content;
      if (Array.isArray(c) && c[0] && c[0].text) textOut = c[0].text;
      else if (typeof resp.data.output[0].content === 'string') textOut = resp.data.output[0].content;
    }
    if (!textOut) textOut = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  } catch (e) {
    textOut = JSON.stringify(resp.data || {});
  }

  // Try to parse JSON from the model's response
  let parsed = null;
  try {
    const first = textOut.indexOf('{');
    const last = textOut.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      const jsonText = textOut.slice(first, last + 1);
      parsed = JSON.parse(jsonText);
    }
  } catch (e) {
    parsed = null;
  }

  // cache successful parsed or text responses to reduce duplicate tokens
  try {
    const cacheKey = `llm:${tx.txHash || tx.hash || JSON.stringify(tx).slice(0,24)}`;
    const now = Date.now();
    cache.set(cacheKey, { _raw: resp.data, _text: textOut, _json: parsed, _expires: now + GEMINI_CACHE_TTL * 1000 });
  } catch (e) {}

  return { raw: resp.data, text: textOut, json: parsed, usage: resp.data?.usage || null };
}

const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Helper: wrap a promise with a timeout so RPC calls don't hang forever
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), ms))
  ]);
}

// Simple in-memory cache
const cache = new Map();
const mongoClient = require('./lib/mongoClient');

app.get('/api/price/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    // Using CoinGecko public API
    const key = `price:${symbol}`;
    if (cache.has(key)) return res.json(cache.get(key));
    const resp = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
      params: { 
        ids: symbol, 
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_market_cap: 'true'
      }
    });
    cache.set(key, resp.data);
    return res.json(resp.data);
  } catch (err) {
    return res.status(500).json({ error: 'price fetch failed', details: err.toString() });
  }
});

app.get('/api/tx/ethereum/:txHash', async (req, res) => {
  const { txHash } = req.params;
  const key = `tx:${txHash}`;
  if (cache.has(key)) return res.json(cache.get(key));

  // Try using JSON-RPC provider first (more reliable and not affected by Etherscan V1 deprecation)
  try {
  // Use a timeout for RPC requests to avoid long hangs when the RPC provider is slow
  const tx = await withTimeout(provider.getTransaction(txHash), 6000);
    if (!tx) {
      // provider didn't know the tx. If no Etherscan key, return a prototype/sample response.
      if (!ETHERSCAN_API_KEY) {
        const sample = {
          txHash,
          chain: 'ethereum',
          from: '0xSampleFrom',
          to: '0xSampleTo',
          value: 0.123,
          tokenSymbol: 'ETH',
          blockNumber: 17000000,
          timestamp: new Date().toISOString(),
          gasUsed: 21000,
          gasPriceGwei: 25,
          status: 'confirmed',
          fetchedAt: new Date().toISOString()
        };
        cache.set(key, sample);
        return res.json(sample);
      }

      // If we have an Etherscan API key, attempt the Etherscan proxy API as a fallback.
      try {
        const base = 'https://api.etherscan.io/v2/api';
        const resp = await axios.get(base, {
          params: {
            chainid: 1,
            module: 'proxy',
            action: 'eth_getTransactionByHash',
            txhash: txHash,
            apikey: ETHERSCAN_API_KEY
          },
          timeout: 6000
        });
        const tx2 = resp.data.result;
        const receiptResp = await axios.get(base, {
          params: {
            chainid: 1,
            module: 'proxy',
            action: 'eth_getTransactionReceipt',
            txhash: txHash,
            apikey: ETHERSCAN_API_KEY
          },
          timeout: 6000
        });
        const receipt2 = receiptResp.data.result;
        let timestamp = null;
        if (tx2 && tx2.blockNumber) {
          try {
            const blockResp = await axios.get(base, {
              params: {
                chainid: 1,
                module: 'proxy',
                action: 'eth_getBlockByNumber',
                tag: tx2.blockNumber,
                boolean: 'false',
                apikey: ETHERSCAN_API_KEY
              },
              timeout: 6000
            });
            const block = blockResp.data.result;
            if (block && block.timestamp) timestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
          } catch (e) {}
        }
        const parsed = {
          txHash,
          chain: 'ethereum',
          from: tx2 ? tx2.from : null,
          to: tx2 ? tx2.to : null,
          value: tx2 ? parseInt(tx2.value, 16) / 1e18 : 0,
          tokenSymbol: 'ETH',
          blockNumber: tx2 && tx2.blockNumber ? parseInt(tx2.blockNumber, 16) : null,
          timestamp: timestamp || new Date().toISOString(),
          gasUsed: receipt2 && receipt2.gasUsed ? parseInt(receipt2.gasUsed, 16) : (tx2 && tx2.gas ? parseInt(tx2.gas, 16) : null),
          gasPriceGwei: tx2 && tx2.gasPrice ? parseInt(tx2.gasPrice, 16) / 1e9 : null,
          status: receipt2 && receipt2.status ? (parseInt(receipt2.status, 16) === 1 ? 'confirmed' : 'failed') : (tx2 && tx2.blockNumber ? 'confirmed' : 'pending'),
          fetchedAt: new Date().toISOString(),
          raw: { tx: tx2, receipt: receipt2 }
        };
        cache.set(key, parsed);
        return res.json(parsed);
      } catch (e) {
        // if Etherscan fallback fails, continue to let outer catch handle it
        throw e;
      }
    } else {
      const receipt = await withTimeout(provider.getTransactionReceipt(txHash).catch(() => null), 6000).catch(() => null);
      let timestamp = null;
      if (tx.blockNumber != null) {
        const block = await withTimeout(provider.getBlock(tx.blockNumber).catch(() => null), 6000).catch(() => null);
        if (block && block.timestamp) timestamp = new Date(block.timestamp * 1000).toISOString();
      }

      const parsed = {
        txHash,
        chain: 'ethereum',
        from: tx.from,
        to: tx.to,
        value: tx.value ? Number(ethers.formatEther(tx.value)) : 0,
        tokenSymbol: 'ETH',
        blockNumber: tx.blockNumber != null ? Number(tx.blockNumber) : null,
        timestamp: timestamp || new Date().toISOString(),
        gasUsed: receipt && receipt.gasUsed ? receipt.gasUsed.toString() : (tx.gas ? tx.gas.toString() : null),
        gasPriceGwei: tx.gasPrice ? Number(ethers.formatUnits(tx.gasPrice, 'gwei')) : null,
        status: receipt ? (receipt.status === 1 ? 'confirmed' : 'failed') : (tx.blockNumber ? 'confirmed' : 'pending'),
        fetchedAt: new Date().toISOString(),
        raw: { tx: tx, receipt: receipt }
      };
      cache.set(key, parsed);
      return res.json(parsed);
    }
  } catch (err) {
    // if RPC fails and Etherscan key exists, fall back to Etherscan API
    if (ETHERSCAN_API_KEY) {
      try {
        // Etherscan API V2 base path and include chainid=1 for Ethereum mainnet
        const base = 'https://api.etherscan.io/v2/api';
        const resp = await axios.get(base, {
          params: {
            chainid: 1,
            module: 'proxy',
            action: 'eth_getTransactionByHash',
            txhash: txHash,
            apikey: ETHERSCAN_API_KEY
          }
        , timeout: 6000 });
        const tx = resp.data.result;
        const receiptResp = await axios.get(base, {
          params: {
            chainid: 1,
            module: 'proxy',
            action: 'eth_getTransactionReceipt',
            txhash: txHash,
            apikey: ETHERSCAN_API_KEY
          }
        , timeout: 6000 });
        const receipt = receiptResp.data.result;
        let timestamp = null;
        if (tx && tx.blockNumber) {
          try {
            const blockResp = await axios.get(base, {
              params: {
                chainid: 1,
                module: 'proxy',
                action: 'eth_getBlockByNumber',
                tag: tx.blockNumber,
                boolean: 'false',
                apikey: ETHERSCAN_API_KEY
              }
            , timeout: 6000 });
            const block = blockResp.data.result;
            if (block && block.timestamp) timestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
          } catch (e) {}
        }
        const parsed = {
          txHash,
          chain: 'ethereum',
          from: tx ? tx.from : null,
          to: tx ? tx.to : null,
          value: tx ? parseInt(tx.value, 16) / 1e18 : 0,
          tokenSymbol: 'ETH',
          blockNumber: tx && tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
          timestamp: timestamp || new Date().toISOString(),
          gasUsed: receipt && receipt.gasUsed ? parseInt(receipt.gasUsed, 16) : (tx && tx.gas ? parseInt(tx.gas, 16) : null),
          gasPriceGwei: tx && tx.gasPrice ? parseInt(tx.gasPrice, 16) / 1e9 : null,
          status: receipt && receipt.status ? (parseInt(receipt.status, 16) === 1 ? 'confirmed' : 'failed') : (tx && tx.blockNumber ? 'confirmed' : 'pending'),
          fetchedAt: new Date().toISOString(),
          raw: { tx, receipt }
        };
        cache.set(key, parsed);
        return res.json(parsed);
      } catch (e) {
        return res.status(500).json({ error: 'etherscan/rpc query failed', details: e.toString() });
      }
    }
    return res.status(500).json({ error: 'rpc query failed', details: err.toString() });
  }
});

app.post('/api/analyze/tx', async (req, res) => {
  const tx = req.body;
  // allow clients to request LLM-backed analysis by sending { useLLM: true }
  const useLLM = req.body && req.body.useLLM === true;
  try {
    // Compute a quick local fee estimate (feeWei = gasUsed * gasPrice)
    let feeWei = null;
    let feeEth = null;
    try {
      // gasUsed may be string/number/BigInt
      let gasUsed = tx.gasUsed ?? (tx.raw && tx.raw.receipt && tx.raw.receipt.gasUsed) ?? tx.gas;
      if (gasUsed != null) {
        if (typeof gasUsed === 'string' && gasUsed.startsWith('0x')) gasUsed = BigInt(gasUsed);
        else gasUsed = BigInt(gasUsed);
      }

      // gasPrice may be provided in gwei field or as wei
      let gasPriceWei = null;
      if (tx.gasPriceGwei != null) {
        // gasPriceGwei likely a number
        gasPriceWei = BigInt(Math.round(Number(tx.gasPriceGwei) * 1e9));
      } else if (tx.gasPrice != null) {
        if (typeof tx.gasPrice === 'string' && tx.gasPrice.startsWith('0x')) gasPriceWei = BigInt(tx.gasPrice);
        else gasPriceWei = BigInt(tx.gasPrice);
      }

      if (gasUsed != null && gasPriceWei != null) {
        feeWei = gasUsed * gasPriceWei;
        feeEth = Number(ethers.formatEther(feeWei));
      }
    } catch (e) {
      // ignore local fee calc errors
      feeWei = null; feeEth = null;
    }

  // Optionally call ML service endpoints (anomaly and fee prediction) in parallel when ML is enabled
    let mlAnom = null;
    let mlFee = null;
    if (ML_ENABLED) {
      try {
        const feePayload = {};
        if (tx.gasPriceGwei != null) feePayload.recent_gas = [Number(tx.gasPriceGwei)];
        else if (tx.raw && tx.raw.tx && tx.raw.tx.gasPrice) {
          try {
            const gp = tx.raw.tx.gasPrice;
            feePayload.recent_gas = [Number(ethers.formatUnits(gp, 'gwei'))];
          } catch (e) {
            // ignore
          }
        }

        const [anomResp, feeResp] = await Promise.allSettled([
          axios.post(`${ML_SERVICE_URL}/ml/anomaly`, tx, { timeout: 5000 }),
          axios.post(`${ML_SERVICE_URL}/ml/predict_fee`, feePayload, { timeout: 5000 })
        ]);

        if (anomResp.status === 'fulfilled') mlAnom = anomResp.value.data;
        if (feeResp.status === 'fulfilled') mlFee = feeResp.value.data;
      } catch (e) {
        // ignore ML errors
      }
    }

    // LLM summary: for prototype just create a simple summary
    const summary = `Transaction ${tx.txHash || tx.hash || 'unknown'} from ${tx.from} to ${tx.to} for ${tx.value || tx.valueUSD || 'N/A'} ${tx.tokenSymbol || ''}`;

    // Base result (local heuristics / ML results merged)
    const result = { anomaly: mlAnom || { score: 0.01, label: 'normal' }, nlpSummary: summary };

    // If client specifically requested LLM analysis, attempt to call an LLM provider.
    if (useLLM) {
      try {
        const ip = getClientIp(req);
        // Prefer cached LLM responses to save tokens/calls (callGeminiWithTx itself also caches)
        const llmCacheKey = `llm:${tx.txHash || tx.hash || JSON.stringify(tx).slice(0, 24)}`;
        const cachedLLM = (() => {
          try { const c = cache.get(llmCacheKey); if (c && c._expires && Date.now() < c._expires) return c; } catch (e) {};
          return null;
        })();

        if (cachedLLM) {
          // Use cached LLM result (no quota consumed)
          result._llm_raw = cachedLLM._raw;
          result._llm_text = cachedLLM._text;
          result._llm_usage = cachedLLM._usage || { calls: llmUsage.calls, tokens: llmUsage.tokens };
          if (cachedLLM._json) {
            const j = cachedLLM._json;
            if (j.summary) result.nlpSummary = j.summary;
            if (j.anomaly) result.anomaly = j.anomaly;
            if (j.feePrediction) result.feePrediction = j.feePrediction;
            if (j.recommendations) result.recommendations = j.recommendations;
            result.llm = j;
          } else {
            result.llm = { text: cachedLLM._text };
          }
          // attach rate-limit headers showing remaining quota
          const entry = llmRateMap.get(ip) || { count: 0, resetAt: Date.now() + LLM_RATE_LIMIT_WINDOW_MS };
          res.setHeader('X-RateLimit-Limit', String(LLM_RATE_LIMIT_MAX));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, LLM_RATE_LIMIT_MAX - entry.count)));
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
        } else {
          // Not cached: consume quota (per-IP). If over limit, return 429.
          const q = consumeLlmQuotaForIp(ip);
          if (!q.allowed) {
            res.setHeader('Retry-After', String(Math.ceil((q.resetAt - Date.now()) / 1000)));
            res.setHeader('X-RateLimit-Limit', String(LLM_RATE_LIMIT_MAX));
            res.setHeader('X-RateLimit-Remaining', '0');
            res.setHeader('X-RateLimit-Reset', String(Math.ceil(q.resetAt / 1000)));
            return res.status(429).json({ error: 'LLM rate limit exceeded', details: `limit ${LLM_RATE_LIMIT_MAX} per ${LLM_RATE_LIMIT_WINDOW_MS}ms` });
          }

          if (USE_REAL_LLM && GEMINI_API_KEY) {
            try {
              const llmResp = await callGeminiWithTx(tx);
              result._llm_raw = llmResp.raw;
              result._llm_text = llmResp.text;
              result._llm_usage = llmResp.usage || { calls: llmUsage.calls, tokens: llmUsage.tokens };
              if (llmResp.json) {
                const j = llmResp.json;
                if (j.summary) result.nlpSummary = j.summary;
                if (j.anomaly) result.anomaly = j.anomaly;
                if (j.feePrediction) result.feePrediction = j.feePrediction;
                if (j.recommendations) result.recommendations = j.recommendations;
                result.llm = j;
              } else {
                result.llm = { text: llmResp.text };
              }
            } catch (e) {
              result._llm_error = e.toString();
            }
          } else {
            // GEMINI not configured: simulated enriched summary for demo/dev
            const llm = {
              model: 'gemini-simulated',
              summary: `LLM-enriched summary: TX ${tx.txHash || tx.hash || 'unknown'} appears to transfer ${tx.value || 'N/A'} ${tx.tokenSymbol || ''} from ${tx.from} to ${tx.to}. No obvious scam indicators detected in heuristics.`,
              recommendations: ['Check recipient interaction history', 'Verify token contract if non-ETH transfer']
            };
            result.llm = llm;
            result.nlpSummary = llm.summary;
          }

          // After successful (or attempted) call, surface remaining quota headers
          const entry = llmRateMap.get(ip) || { count: 0, resetAt: Date.now() + LLM_RATE_LIMIT_WINDOW_MS };
          res.setHeader('X-RateLimit-Limit', String(LLM_RATE_LIMIT_MAX));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, LLM_RATE_LIMIT_MAX - entry.count)));
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
        }
      } catch (e) {
        // ignore LLM errors and fall back to summary
        result._llm_error = e.toString();
      }
    }
    // prefer ML fee prediction if available, otherwise use local calc
    if (mlFee && (mlFee.predictedFeeWei || mlFee.predictedFeeEth)) {
      result.feePrediction = mlFee.predictedFeeEth || (mlFee.predictedFeeWei ? Number(ethers.formatEther(BigInt(mlFee.predictedFeeWei))) : null);
      result.feeWei = mlFee.predictedFeeWei || null;
    } else if (feeEth != null) {
      result.feePrediction = `${feeEth} ETH`;
      result.feeWei = feeWei ? feeWei.toString() : null;
    }

    // include raw ML responses for debugging
    if (mlAnom) result._ml = { anomaly: mlAnom };
    if (mlFee) result._ml = { ...(result._ml || {}), fee: mlFee };

    // Attempt to persist the analysis to Mongo (optional)
    try {
      try {
        const db = mongoClient.getDb();
        if (db) {
          const keyHash = tx.txHash || tx.hash || result.txHash || '<unknown>';
          await db.collection('analyses').updateOne(
            { txHash: keyHash },
            { $set: { ...result, txHash: keyHash, updatedAt: new Date() } },
            { upsert: true }
          );
        }
      } catch (e) {
        // ignore DB errors in prototype
      }
    } catch (e) {}

    return res.json(result);
  } catch (err) {
    // Fallback - return mock
    return res.json({ anomaly: { score: 0.01, label: 'normal' }, nlpSummary: `Prototype summary: TX ${tx.txHash || tx.hash || 'n/a'}` });
  }
});

app.get('/api/address/ethereum/:address/transactions', async (req, res) => {
  const { address } = req.params;
  const key = `addr:${address}`;
  if (cache.has(key)) return res.json(cache.get(key));

  if (!ETHERSCAN_API_KEY) {
    // prototype sample
    const sample = [
      {
        txHash: '0xabc123',
        from: address,
        to: '0xRecipient1',
        value: 0.5,
        tokenSymbol: 'ETH',
        timestamp: new Date().toISOString()
      },
      {
        txHash: '0xdef456',
        from: '0xOther',
        to: address,
        value: 1.2,
        tokenSymbol: 'ETH',
        timestamp: new Date().toISOString()
      }
    ];
    const result = { address, transactions: sample };
    cache.set(key, result);
    return res.json(result);
  }

    try {
    // Use Etherscan V2 account txlist endpoint (include chainid)
    const resp = await axios.get('https://api.etherscan.io/v2/api', {
      params: {
        chainid: 1,
        module: 'account',
        action: 'txlist',
        address,
        startblock: 0,
        endblock: 99999999,
        page: 1,
        offset: 50,
        sort: 'desc',
        apikey: ETHERSCAN_API_KEY
      }
    });
    if (resp.data.status === '0' && resp.data.message === 'No transactions found') {
      const result = { address, transactions: [] };
      cache.set(key, result);
      return res.json(result);
    }
    const txs = (resp.data.result || []).map(t => ({
      txHash: t.hash,
      from: t.from,
      to: t.to,
      value: parseFloat(t.value) / 1e18,
      tokenSymbol: 'ETH',
      blockNumber: parseInt(t.blockNumber, 10),
      timestamp: new Date(parseInt(t.timeStamp, 10) * 1000).toISOString(),
      gasUsed: parseInt(t.gasUsed, 10),
      gasPriceGwei: t.gasPrice ? parseInt(t.gasPrice, 10) / 1e9 : null,
      isError: t.isError === '1'
    }));
    const result = { address, transactions: txs };
    cache.set(key, result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'etherscan address query failed', details: err.toString() });
  }
});

// Diagnostic endpoint: returns whether Gemini/LLM appears configured (no secrets returned)
app.get('/api/_diag/llm', (req, res) => {
  try {
    const configured = !!GEMINI_API_KEY;
    let host = null;
    try {
      if (GEMINI_API_URL) host = new URL(GEMINI_API_URL).host;
    } catch (e) { host = GEMINI_API_URL || null }
    return res.json({ useRealLLM: USE_REAL_LLM, geminiConfigured: configured, geminiHost: host, selectedModel: selectedGeminiModel, selectedMethod: selectedGeminiMethod, selectedPayload: selectedGeminiPayload, llmUsage });
  } catch (e) {
    return res.status(500).json({ error: 'diag failed', details: String(e) });
  }
});

// Diagnostic endpoint for DB connection
app.get('/api/_diag/db', async (req, res) => {
  try {
    let usingMock = (process.env.USE_MOCK_DB || 'true').toLowerCase() === 'true';
    let uri = process.env.MONGO_URI || null;
    let connected = false;
    try {
      // try to get db without throwing if not connected
      const db = mongoClient.getDb();
      connected = !!db;
    } catch (e) {
      connected = false;
    }
    const uriPreview = uri ? uri.replace(/(\/\/)(.*?@)/, '$1<redacted>@') : null;
    return res.json({ connected, usingMock, uriPreview });
  } catch (e) {
    return res.status(500).json({ error: 'db diag failed', details: String(e) });
  }
});

// Start server after attempting DB connect (best-effort)
(async () => {
  try {
    await mongoClient.connect();
  } catch (e) {
    console.warn('Mongo connect failed (continuing without DB):', String(e));
  }

  // If requested, attempt Gemini model discovery so runtime calls are deterministic
  if (USE_REAL_LLM) {
    try {
      await discoverGeminiModel();
    } catch (e) {
      console.warn('Gemini discovery error (continuing):', String(e));
    }
  }

  app.listen(PORT, () => {
    console.log(`Backend prototype listening on port ${PORT}`);
  });
})();
