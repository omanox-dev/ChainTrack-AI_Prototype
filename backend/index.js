require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8001';
const ML_ENABLED = (process.env.ML_ENABLED || 'false').toLowerCase() === 'true';
const RPC_URL = process.env.RPC_URL || 'https://cloudflare-eth.com';

// Gemini / LLM config (optional)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = process.env.GEMINI_API_URL || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.0';
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT || '12000', 10);
const GEMINI_MAX_TOKENS = parseInt(process.env.GEMINI_MAX_TOKENS || '256', 10);
const GEMINI_CACHE_TTL = parseInt(process.env.GEMINI_CACHE_TTL || String(60 * 60), 10); // seconds

// In-memory tracking for LLM usage (prototype only). Reports included in responses.
let llmUsage = { calls: 0, tokens: 0 };

const axiosInstance = axios.create();

// Helper to call a generic Gemini/LLM endpoint. The implementation is intentionally
// flexible: it sends both `messages` and `input`/`prompt` fields so it works with
// a variety of LLM REST endpoints (Vertex / OpenAI-like / vendor-provided).
async function callGeminiWithTx(tx) {
  if (!GEMINI_API_KEY || !GEMINI_API_URL) {
    throw new Error('Gemini API not configured');
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

  // Precision AI: concise prompt & structured response only. Keep token budget low.
  // If the endpoint is Google's Generative Language API, use the Google payload shape
  // (prompt.text + maxOutputTokens) and don't send a Bearer header when using API key in URL.
  const isGoogleGen = GEMINI_API_URL.includes('generativelanguage.googleapis.com');
  let resp;
  if (isGoogleGen) {
    const gPayload = {
      prompt: { text: instruction },
      maxOutputTokens: GEMINI_MAX_TOKENS,
      temperature: 0
    };
    const gHeaders = { 'Content-Type': 'application/json' };
    resp = await axiosInstance.post(GEMINI_API_URL, gPayload, { headers: gHeaders, timeout: GEMINI_TIMEOUT });
  } else {
    const payload = {
      model: GEMINI_MODEL,
      messages: [{ role: 'user', content: instruction }],
      input: instruction,
      prompt: instruction,
      max_tokens: GEMINI_MAX_TOKENS,
      temperature: 0,
      top_p: 1
    };
    const headers = {
      Authorization: `Bearer ${GEMINI_API_KEY}`,
      'Content-Type': 'application/json'
    };
    resp = await axiosInstance.post(GEMINI_API_URL, payload, { headers, timeout: GEMINI_TIMEOUT });
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
    if (resp.data?.choices && resp.data.choices[0]) {
      if (resp.data.choices[0].message && resp.data.choices[0].message.content) textOut = resp.data.choices[0].message.content;
      else if (resp.data.choices[0].text) textOut = resp.data.choices[0].text;
    }
    if (!textOut && resp.data?.output && Array.isArray(resp.data.output) && resp.data.output[0]) {
      // Vertex-style
      const c = resp.data.output[0].content;
      if (Array.isArray(c) && c[0] && c[0].text) textOut = c[0].text;
      else if (typeof resp.data.output[0].content === 'string') textOut = resp.data.output[0].content;
    }
    if (!textOut && resp.data?.candidates && resp.data.candidates[0] && resp.data.candidates[0].content) textOut = resp.data.candidates[0].content;
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

app.get('/api/price/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    // Using CoinGecko public API
    const key = `price:${symbol}`;
    if (cache.has(key)) return res.json(cache.get(key));
    const resp = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
      params: { ids: symbol, vs_currencies: 'usd' }
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
        if (GEMINI_API_KEY && GEMINI_API_URL) {
          // call configured Gemini/LLM endpoint and merge structured response when possible
          try {
            const llmResp = await callGeminiWithTx(tx);
            result._llm_raw = llmResp.raw;
            result._llm_text = llmResp.text;
            // attach usage summary from provider or our counter
            result._llm_usage = llmResp.usage || { calls: llmUsage.calls, tokens: llmUsage.tokens };
            if (llmResp.json) {
              const j = llmResp.json;
              if (j.summary) result.nlpSummary = j.summary;
              if (j.anomaly) result.anomaly = j.anomaly;
              if (j.feePrediction) result.feePrediction = j.feePrediction;
              if (j.recommendations) result.recommendations = j.recommendations;
              result.llm = j;
            } else {
              // no structured json, attach raw text
              result.llm = { text: llmResp.text };
            }
          } catch (e) {
            // LLM call failed — attach error and continue
            result._llm_error = e.toString();
          }
        } else {
          // GEMINI not configured: return a simulated enriched summary for demo/dev
          const llm = {
            model: 'gemini-simulated',
            summary: `LLM-enriched summary: TX ${tx.txHash || tx.hash || 'unknown'} appears to transfer ${tx.value || 'N/A'} ${tx.tokenSymbol || ''} from ${tx.from} to ${tx.to}. No obvious scam indicators detected in heuristics.`,
            recommendations: ['Check recipient interaction history', 'Verify token contract if non-ETH transfer']
          };
          result.llm = llm;
          result.nlpSummary = llm.summary;
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
    const configured = !!(GEMINI_API_KEY && GEMINI_API_URL);
    let host = null;
    try {
      if (GEMINI_API_URL) host = new URL(GEMINI_API_URL).host;
    } catch (e) { host = GEMINI_API_URL || null }
    return res.json({ geminiConfigured: configured, geminiHost: host, llmUsage });
  } catch (e) {
    return res.status(500).json({ error: 'diag failed', details: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend prototype listening on port ${PORT}`);
});
