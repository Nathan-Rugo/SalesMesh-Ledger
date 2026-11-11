"""
train.py
--------
Top-level entry point to train and evaluate the SalesMesh Two-Layer ML Risk Engine.

Usage:
    python train.py --dataset test_dataset_100.csv
    python train.py --dataset salesmesh_fraud_dataset.csv --model-version v1.1.0
"""

import os
import sys

# Ensure backend/ml-engine is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine.train import main

if __name__ == "__main__":
    main()
