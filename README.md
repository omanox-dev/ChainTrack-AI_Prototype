# ChainTrack AI - Crypto Transaction Tracker (Prototype)

## Overview
ChainTrack AI is a web dashboard prototype to track and analyze cryptocurrency transactions (Ethereum-compatible chains). This repository contains a minimal prototype with three components:

- frontend/ — React + Vite prototype UI
- backend/ — Express API with basic endpoints (mocked where keys are missing)
- ml_service/ — FastAPI mock ML service (anomaly and fee prediction endpoints)

This prototype is intended to be extended. It uses mock data when API keys are not provided to make local demos easy.

## Run Locally (quick)

Start ML service (optional but recommended):

```powershell
cd "c:/Users/Om/Documents/GIG Workshop/Crypto Tracker App/ml_service"
python -m venv venv
venv\Scripts\Activate.ps1   # or use venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Start backend:

```powershell
cd "c:/Users/Om/Documents/GIG Workshop/Crypto Tracker App/backend"
npm install
cp .env.example .env         # Windows: copy .env.example .env
# Edit .env to add ETHERSCAN_API_KEY if you have one
npm run dev
```

Start frontend:

```powershell
cd "c:/Users/Om/Documents/GIG Workshop/Crypto Tracker App/frontend"
npm install
npm run dev
# Open the printed vite URL (usually http://localhost:5173)
```

## Environment variables
See `backend/.env.example` and `ml_service/README.md` for details.

## Next steps
- Wire real Etherscan/Alchemy APIs and add MongoDB persistence.
- Implement IsolationForest in ml_service and persist models.
- Add LLM-based NLP summarization (OpenAI/Gemini) behind a secure API.
- Add tests and CI (GitHub Actions).

## License
MIT
