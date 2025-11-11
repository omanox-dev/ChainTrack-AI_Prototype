# ML Service (Prototype)

This is a small FastAPI prototype for ML endpoints used by the ChainTrack AI prototype.

Endpoints:
- POST /ml/anomaly — accept transaction features and return anomaly score/label (mock)
- POST /ml/predict_fee — accept recent gas array and return predicted gas price (mock)

Run locally:

1. python -m venv venv
2. venv\Scripts\activate
3. pip install -r requirements.txt
4. uvicorn main:app --reload --port 8001

Training the anomaly model (prototype):

```powershell
cd "c:/Users/Om/Documents/GIG Workshop/Crypto Tracker App/ml_service"
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python train.py
```

This will create `models/anomaly_iforest.pkl`. After that, the FastAPI server will load the model on startup and `/ml/anomaly` will return normalized scores (0-1).

Troubleshooting: scikit-learn build errors on Windows
--------------------------------------------------
On Windows you may see errors when installing `scikit-learn` (pip build requiring MSVC). Options:

1) Install Microsoft C++ Build Tools (recommended for pip):

	- Install "Build Tools for Visual Studio" (choose C++ build tools).
	- Then run: `pip install -r requirements.txt` and `python train.py`.

2) Use conda (simpler):

	- Install Miniconda/Anaconda, create an env:

```powershell
conda create -n ctai python=3.11 -y
conda activate ctai
conda install scikit-learn joblib numpy pandas -y
pip install fastapi uvicorn pydantic
python train.py
```

3) Skip training locally: the API provides a deterministic fallback anomaly scorer if the trained model is not present (this allows demos without scikit-learn). When `models/anomaly_iforest.pkl` exists the FastAPI server will use it instead.

