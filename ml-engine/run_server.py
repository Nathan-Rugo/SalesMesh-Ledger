"""
run_server.py
-------------
Entrypoint to run the SalesMesh ML Risk Engine FastAPI microservice.

Usage:
    python run_server.py
    python run_server.py --port 8000 --host 0.0.0.0
"""

import argparse
import os
import sys
import uvicorn

# Ensure ml-engine root is in path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from service.config import settings


def main():
    parser = argparse.ArgumentParser(description="Run SalesMesh ML Risk Assessment Microservice")
    parser.add_argument("--host", default=settings.HOST, help="Host to bind server")
    parser.add_argument("--port", type=int, default=settings.PORT, help="Port to listen on")
    parser.add_argument("--reload", action="store_true", help="Enable hot reload for development")
    args = parser.parse_args()

    print(f"Starting SalesMesh ML Risk Microservice on http://{args.host}:{args.port}")
    uvicorn.run("service.app:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
