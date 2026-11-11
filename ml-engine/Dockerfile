# SalesMesh ML Risk Engine (Module 2) - FastAPI service image.
# Build from ml-engine/:  docker build -t salesmesh-ml-engine .

# ---- builder: install the exact compiled pins into /opt/venv ----------------
FROM python:3.11.9-slim-bookworm AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# scikit-learn/xgboost equal the artifact's library_versions (load refuses otherwise).
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ---- runtime ------------------------------------------------------------------
FROM python:3.11.9-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    HOST=0.0.0.0 \
    PORT=8000 \
    MODEL_PATH=/app/models/risk_cascade_v1.1.0.joblib

# libgomp1: OpenMP runtime needed by the xgboost and scikit-learn wheels. No compilers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system app && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
# Code and model stay root-owned (read-only for the service user).
COPY engine/ ./engine/
COPY service/ ./service/
COPY models/ ./models/
COPY run_server.py .

USER app
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/health', timeout=4)"]

CMD ["python", "run_server.py"]
