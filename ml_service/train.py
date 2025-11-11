"""
Train a simple IsolationForest anomaly detector on synthetic or fetched data.

Usage:
  python train.py

If an ETHERSCAN_API_KEY environment variable is present, this script could be extended to fetch
real transactions; for the prototype we generate synthetic data so the model can be trained locally
without external dependencies.
"""
import os
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import joblib

MODEL_DIR = Path(__file__).parent / 'models'
MODEL_DIR.mkdir(exist_ok=True)

def generate_synthetic(n=2000, seed=42):
    rng = np.random.RandomState(seed)
    # features: valueUSD, relativeValue, timeDelta, txCount24h, gasUsed, gasPriceGwei, isNewCounterparty
    valueUSD = np.abs(rng.normal(loc=200, scale=500, size=n))
    relativeValue = np.clip(rng.normal(loc=1.0, scale=2.0, size=n), 0.0, None)
    timeDelta = np.abs(rng.exponential(scale=3600, size=n))  # seconds
    txCount24h = rng.poisson(lam=2.0, size=n)
    gasUsed = np.clip(rng.normal(loc=50000, scale=20000, size=n), 21000, None)
    gasPriceGwei = np.clip(rng.normal(loc=30, scale=10, size=n), 1, None)
    isNew = rng.binomial(1, 0.1, size=n)

    df = pd.DataFrame({
        'valueUSD': valueUSD,
        'relativeValue': relativeValue,
        'timeDelta': timeDelta,
        'txCount24h': txCount24h,
        'gasUsed': gasUsed,
        'gasPriceGwei': gasPriceGwei,
        'isNewCounterparty': isNew,
    })

    # Inject some anomalies
    m = int(n * 0.02)
    if m > 0:
        idx = rng.choice(n, m, replace=False)
        df.loc[idx, 'valueUSD'] *= rng.uniform(10, 100, size=m)
        df.loc[idx, 'relativeValue'] *= rng.uniform(5, 50, size=m)

    return df

def train_and_save(df, out_path):
    feature_cols = ['valueUSD', 'relativeValue', 'timeDelta', 'txCount24h', 'gasUsed', 'gasPriceGwei', 'isNewCounterparty']
    X = df[feature_cols].values

    scaler = StandardScaler()
    iforest = IsolationForest(n_estimators=200, contamination=0.02, random_state=42)
    pipeline = Pipeline([('scaler', scaler), ('iforest', iforest)])
    pipeline.fit(X)

    # compute raw anomaly magnitudes on training set (invert decision_function)
    scores = -pipeline.named_steps['iforest'].decision_function(pipeline.named_steps['scaler'].transform(X))
    smin, smax = float(scores.min()), float(scores.max())

    model_obj = {
        'pipeline': pipeline,
        'score_min': smin,
        'score_max': smax,
    }
    joblib.dump(model_obj, out_path)
    print('Saved model to', out_path)
    print('score_min, score_max =', smin, smax)

def main():
    print('Generating synthetic data...')
    df = generate_synthetic(2000)
    out = MODEL_DIR / 'anomaly_iforest.pkl'
    train_and_save(df, out)

if __name__ == '__main__':
    main()
