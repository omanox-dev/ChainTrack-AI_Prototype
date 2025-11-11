# Backend (Prototype)

This is a minimal Express backend for the ChainTrack AI prototype.

Features:
- GET /api/price/:symbol — proxy to CoinGecko
- GET /api/tx/ethereum/:txHash — returns a mock tx if no ETHERSCAN_API_KEY, otherwise queries Etherscan
- POST /api/analyze/tx — forwards to ML service (/ml/anomaly) and returns anomaly + simple NLP summary
- GET /api/address/ethereum/:address/transactions — sample transactions for a wallet

Run locally:

1. cd backend
2. npm install
3. copy .env.example to .env and update keys
4. npm run dev

