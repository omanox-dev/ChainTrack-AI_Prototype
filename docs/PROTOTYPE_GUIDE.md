# ChainTrack AI — Prototype Guide

Purpose
-------
This document is a short, presentation-ready guide for walking a client through the ChainTrack AI prototype. It explains what the prototype does, how to run it locally, how to demo the flows, the limitations, and suggested talking points.

Audience
--------
Non-technical stakeholders and technical reviewers who will see the working prototype during a demo.

Quick elevator pitch
-------------------
ChainTrack AI is a local prototype that helps investigators quickly inspect Ethereum transactions and addresses, run lightweight rule-based analysis and optionally call an LLM ("Gemini") for a richer, natural-language summary. The prototype is intentionally conservative: LLM calls are only invoked when explicitly requested.

What the prototype includes
--------------------------
- Frontend: Vite + React UI (transaction lookup, address tx table, CSV export, skeleton loaders, Gemini Analyze button).
- Backend: Node.js + Express API (transaction and address fetch via JSON-RPC or explorer fallback, quick rule-based analyze endpoint, optional LLM integration).
- ML service (optional): FastAPI microservice used for precomputed ML heuristics in dev (optional; ML_ENABLED default=false).

Demo flows (script)
--------------------
1. Start servers locally (see "How to run").
2. Open the UI in the browser.
3. Transaction lookup demo
   - Paste a transaction hash into the search input and click "Fetch TX".
   - Show the left panel populated with labeled fields (Tx, From, To, Value, Block, Timestamp, Gas used, Gas price).
   - Click "Analyze" to run the local rule-based analysis; point out the fast response and skeleton loading.
   - Show the AI Analysis panel with summary, anomaly bar, and fee prediction.
4. Address lookup demo
   - Paste an address, click "Get Transactions".
   - Show skeleton rows while the backend fetches data.
   - Click a row to load the transaction into the left panel. Note: clicking a row runs local analysis automatically but does NOT call Gemini.
   - Export CSV for the page/all transactions to show data portability.
5. Gemini/LLM example (explicit)
   - With a tx loaded, click "Gemini Analyze" (only triggers LLM when clicked).
   - If GEMINI is not configured, the backend returns a simulated LLM summary for demonstration.
   - If configured, the backend calls the configured LLM endpoint and merges structured results into the analysis view.

   Precision AI (token-efficient LLM usage)
   ---------------------------------------
   We implemented a small pattern called "Precision AI" to keep LLM usage efficient and predictable during demos and in production:

   - Concise labeled input: the backend sends the same human-readable labels shown in the UI (Tx, From, To, Value, Block, Timestamp, Gas used, Gas price) — not the raw ethers JSON.
   - Structured response only: the prompt instructs the model to respond ONLY with a JSON object containing keys: `summary`, `anomaly`, `feePrediction`, `recommendations`.
   - Token budget: calls use a configurable `GEMINI_MAX_TOKENS` (default 256) to limit completion size.
   - Caching: LLM responses are cached per-transaction for a configurable TTL (`GEMINI_CACHE_TTL`) so repeat requests don't burn tokens unnecessarily.
   - Usage tracking: the backend collects simple usage counters (calls/tokens when provided by the provider) and returns `_llm_usage` metadata in the analysis response for monitoring.

   This approach gives clear, compact answers while controlling cost and keeping results easy to parse in the UI. The backend implements fallbacks when LLM is not configured (simulated summary), and the frontend only triggers LLM when the user clicks "Gemini Analyze".

How to run (local developer/demo)
---------------------------------
Prerequisites: Node.js (16+), npm/yarn, optionally Python for the ML microservice.

1. Backend
   - Open a terminal in `backend/`.
   - Install dependencies (if not done): `npm install`.
   - (Optional) copy `.env.example` to `.env` and set values:
     - `PORT=5000`
     - `ETHERSCAN_API_KEY` (optional)
     - `RPC_URL` (defaults to Cloudflare if empty)
     - `ML_ENABLED=false`
     - `ML_SERVICE_URL=http://localhost:8001`
   - Start the backend:
     ```powershell
     $env:PORT = '5000'
     node index.js
     ```

2. Frontend
   - Open a terminal in `frontend/`.
   - Install deps: `npm install`.
   - Start dev server: `npm run dev`.
   - The UI will be available at the Vite dev URL (printed in terminal). Ensure `VITE_API_BASE` points to `http://localhost:5000`.

3. ML microservice (optional)
   - Enter `ml_service/` and follow `README` (FastAPI + uvicorn). ML is optional and disabled by default.

Environment and LLM configuration
---------------------------------
- To enable real LLM (Gemini) calls, set these env vars in `backend/.env` or the shell before starting the backend:
  - `GEMINI_API_KEY` - your API key (do not commit to git)
  - `GEMINI_API_URL` - the full REST endpoint URL for your LLM provider
  - `GEMINI_MODEL` - model name (optional, defaults to `gemini-1.0`)

UX notes and design decisions to highlight
-----------------------------------------
- Skeleton loaders improve perceived performance and prevent layout jumps.
- Auto-analyze on row tap runs only the local heuristics (fast) to avoid LLM costs and latency.
- The Gemini Analyze button triggers the LLM only when explicitly requested — it prevents accidental usage and cost overruns.
- The backend accepts a `useLLM: true` flag, and will either call the configured LLM or return a safe simulated result for demos.

Limitations (what to call out)
-------------------------------
- This is a prototype: not hardened for production. Input validation, rate limiting, auth, and secrets handling are minimal.
- LLM output parsing is best-effort — if the LLM returns extra text the backend tries to extract JSON. For production, adapt the payload/response per provider.
- The ML microservice is optional and uses precomputed heuristics in this demo (no on-host training required).

Talking points and recommendations
----------------------------------
- Recommend a gated integration with Gemini: per-user toggle, usage quotas, and server-side queuing to smooth spikes.
- For production: add authentication, audit logging, rate limits and streaming-friendly LLM handlers.
- For analytics: track LLM calls and costs, and instrument metrics for success/failures.

Attachments / visuals
---------------------
- Use the included UI screenshot of the transaction detail panel during the demo. It shows the labeled fields and the "Retry Analysis" button.

Appendix: Quick test request
---------------------------
A PowerShell snippet to test the LLM-enabled analyze endpoint (sends `useLLM: true`):

```powershell
$body = @{
  txHash = '0x4c1071b3a4d10a729281228cdb2d353bfc0d1098e74aa1011ce96a16b5bda58f'
  from = '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97'
  to = '0x388c818ca8b9251b393131c08a736a67ccb19297'
  value = '0.077541'
  tokenSymbol = 'ETH'
  blockNumber = 23776722
  timestamp = '2025-11-11T14:55:35.000Z'
  gasUsed = 22111
  gasPriceGwei = 0.633
  useLLM = $true
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:5000/api/analyze/tx -Method POST -Body $body -ContentType 'application/json'
```


---
Document created for demo use. If you'd like, I can also render this as a printable deck (slide-friendly bullets) or shorten it into a 1-page client brief.
