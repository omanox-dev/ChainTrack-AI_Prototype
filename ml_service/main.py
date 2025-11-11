from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import os
import joblib
import numpy as np
import random

app = FastAPI(title='ChainTrack AI - ML Prototype')

# Try to load trained model (a dict containing pipeline and score normalization info)
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'anomaly_iforest.pkl')
MODEL = None
if os.path.exists(MODEL_PATH):
    try:
        MODEL = joblib.load(MODEL_PATH)
        print('Loaded anomaly model from', MODEL_PATH)
    except Exception as e:
        print('Failed loading model:', e)

# Try loading a lightweight precomputed JSON linear model if present
if MODEL is None:
    try:
        import json
        pre_path = os.path.join(os.path.dirname(__file__), 'models', 'precomputed_model.json')
        if os.path.exists(pre_path):
            with open(pre_path, 'r', encoding='utf-8') as f:
                MODEL = json.load(f)
            print('Loaded precomputed linear model from', pre_path)
    except Exception as e:
        print('No precomputed model loaded:', e)


class TxFeatures(BaseModel):
    txHash: Optional[str] = None
    from_addr: Optional[str] = None
    to: Optional[str] = None
    valueUSD: Optional[float] = None
    relativeValue: Optional[float] = None
    timeDelta: Optional[float] = None
    txCount24h: Optional[int] = None
    gasUsed: Optional[float] = None
    gasPriceGwei: Optional[float] = None
    isNewCounterparty: Optional[int] = None


@app.post('/ml/anomaly')
async def anomaly(features: TxFeatures):
    """
    Returns: { score: float (0-1), label: 'normal'|'suspicious' }
    If a trained model is available it will be used; otherwise returns a prototype random score.
    """
    f = features.dict()
    feature_order = ['valueUSD', 'relativeValue', 'timeDelta', 'txCount24h', 'gasUsed', 'gasPriceGwei', 'isNewCounterparty']
    x = []
    for k in feature_order:
        v = f.get(k)
        # fill missing with 0
        x.append(0.0 if v is None else float(v))
    X = np.array(x).reshape(1, -1)

    if MODEL is not None and 'pipeline' in MODEL and 'score_min' in MODEL and 'score_max' in MODEL:
        pipeline = MODEL['pipeline']
        clf = pipeline.named_steps['iforest'] if 'iforest' in pipeline.named_steps else pipeline
        # transform/scale if pipeline includes scaler
        try:
            X_proc = pipeline.transform(X)
        except Exception:
            # pipeline may be just the model
            X_proc = X

        # decision_function: higher means more normal => we invert to get anomaly magnitude
        try:
            raw = -clf.decision_function(X_proc)[0]
        except Exception:
            # fallback if model interface differs
            raw = random.random()

        # normalize using saved min/max
        smin = MODEL.get('score_min', 0.0)
        smax = MODEL.get('score_max', 1.0)
        if smax - smin > 0:
            score = (raw - smin) / (smax - smin)
        else:
            score = float(np.clip(raw, 0.0, 1.0))
        score = float(np.clip(score, 0.0, 1.0))
        label = 'suspicious' if score > 0.85 else 'normal'
        return { 'score': round(score, 4), 'label': label }

    # If a lightweight linear model exists, use it (no scikit dependency)
    if MODEL is not None and isinstance(MODEL, dict) and MODEL.get('type') == 'linear':
        coefs = MODEL.get('coefs', [])
        intercept = float(MODEL.get('intercept', 0.0))
        arr = np.array(X.flatten(), dtype=float)
        coef_arr = np.array(coefs, dtype=float)
        # pad or trim to match
        if coef_arr.shape[0] < arr.shape[0]:
            coef_arr = np.pad(coef_arr, (0, arr.shape[0] - coef_arr.shape[0]), 'constant')
        elif coef_arr.shape[0] > arr.shape[0]:
            coef_arr = coef_arr[:arr.shape[0]]
        raw = float(np.dot(arr, coef_arr) + intercept)
        smin = float(MODEL.get('score_min', 0.0))
        smax = float(MODEL.get('score_max', max(1.0, raw)))
        if smax - smin > 0:
            score = (raw - smin) / (smax - smin)
        else:
            score = float(np.clip(raw, 0.0, 1.0))
        score = float(np.clip(score, 0.0, 1.0))
        label = 'suspicious' if score > 0.85 else 'normal'
        return { 'score': round(score, 4), 'label': label, 'model': 'precomputed_linear' }

    # fallback prototype behaviour
    # deterministic fallback: z-score style heuristic so API is useful without scikit-learn
    # feature order: ['valueUSD','relativeValue','timeDelta','txCount24h','gasUsed','gasPriceGwei','isNewCounterparty']
    Xv = X.flatten().tolist()
    # rough expected medians/stds from synthetic training distribution
    medians = [200.0, 1.0, 3600.0, 2.0, 50000.0, 30.0, 0.1]
    stds = [500.0, 2.0, 3600.0, 2.0, 20000.0, 10.0, 0.3]
    weights = [1.0, 1.0, 0.5, 0.3, 0.5, 0.5, 0.8]
    zsum = 0.0
    norm = 0.0
    for xi, m, s, w in zip(Xv, medians, stds, weights):
        if s <= 0:
            z = 0.0
        else:
            z = abs((xi - m) / s)
        zsum += z * w
        norm += 3.0 * w  # cap assumption: 3 std devs
    if norm <= 0:
        score = 0.0
    else:
        score = float(np.clip(zsum / norm, 0.0, 1.0))
    label = 'suspicious' if score > 0.85 else 'normal'
    return { 'score': round(score, 4), 'label': label, 'fallback': True }


class FeeRequest(BaseModel):
    recent_gas: Optional[list[float]] = None


@app.post('/ml/predict_fee')
async def predict_fee(req: FeeRequest):
    # Prototype: simple average + small random
    if not req.recent_gas:
        predicted = 30.0
    else:
        predicted = sum(req.recent_gas) / len(req.recent_gas) + random.uniform(-2, 2)
    return { 'predicted_gwei': round(predicted, 2) }


@app.get('/')
async def root():
    return { 'status': 'ml_service prototype running', 'model_loaded': MODEL is not None }
