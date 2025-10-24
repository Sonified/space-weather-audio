"""
Convert Anderson's ZPG (zeros, poles, gain) to SOS format using scipy
"""
import os
import json
import numpy as np
import pandas as pd
from scipy import signal
from pathlib import Path

print("="*80)
print("CONVERTING ANDERSON'S ZPG TO SOS FORMAT")
print("="*80)

# Load all ZPG files
zpg_dir = Path("data/anderson_zpg")
anderson_coefficients = {}

# Get unique coefficient sets
meta_files = sorted(zpg_dir.glob("*_meta.csv"))

print(f"\nFound {len(meta_files)} coefficient sets")
print("\nConverting to SOS format...")

for meta_file in meta_files:
    # Extract the key (e.g., "CMG-3T_100Hz" from "CMG-3T_100Hz_meta.csv")
    key = meta_file.stem.replace("_meta", "")
    
    print(f"  {key}...", end=" ")
    
    # Load metadata
    meta = pd.read_csv(meta_file)
    gain = float(meta['gain'].values[0])
    fs = float(meta['sample_rate'].values[0])
    
    # Load poles
    poles_file = meta_file.parent / f"{key}_poles.csv"
    poles_df = pd.read_csv(poles_file)
    poles = poles_df['real'].values + 1j * poles_df['imag'].values
    
    # Load zeros
    zeros_file = meta_file.parent / f"{key}_zeros.csv"
    zeros_df = pd.read_csv(zeros_file)
    zeros = zeros_df['real'].values + 1j * zeros_df['imag'].values
    
    # Convert to SOS using scipy
    try:
        sos = signal.zpk2sos(zeros, poles, gain)
        
        anderson_coefficients[key] = {
            'seismometer': key.rsplit('_', 1)[0],
            'sample_rate': fs,
            'sos': sos.tolist(),
            'method': 'anderson_mcmc',
            'num_sections': len(sos),
            'num_poles': len(poles),
            'num_zeros': len(zeros)
        }
        
        print(f"✓ ({len(sos)} sections)")
        
    except Exception as e:
        print(f"FAILED: {e}")

print("\n" + "="*80)
print(f"Converted {len(anderson_coefficients)} coefficient sets")
print("="*80)

# Save to JSON
output_file = "data/anderson_coefficients.json"
print(f"\nSaving to {output_file}...")
with open(output_file, 'w') as f:
    json.dump(anderson_coefficients, f, indent=2)
print("✓ Saved!")

print("\nSummary by seismometer:")
seismometers = {}
for key, coef in anderson_coefficients.items():
    seis = coef['seismometer']
    if seis not in seismometers:
        seismometers[seis] = []
    seismometers[seis].append(coef['sample_rate'])

for seis, rates in sorted(seismometers.items()):
    print(f"  {seis}: {len(rates)} sample rates ({min(rates)}-{max(rates)} Hz)")

print("\n✓ Anderson coefficients ready for comparison!")


