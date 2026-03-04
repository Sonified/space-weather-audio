#!/usr/bin/env python3
"""
Test CDAWeb audio API for electric field and SCM datasets.
First queries variables, then tests audio fetch.
"""

import requests
import json
import sys

CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1'
DATAVIEW = 'sp_phys'

def get_variables(dataset):
    """Get variable names for a dataset"""
    url = f"{CDASWS_BASE_URL}/dataviews/{DATAVIEW}/datasets/{dataset}/variables"
    try:
        r = requests.get(url, headers={'Accept': 'application/json'}, timeout=30)
        if r.status_code != 200:
            return None
        data = r.json()
        vars_list = data.get('VariableDescription', [])
        return vars_list
    except Exception as e:
        print(f"  Error getting vars for {dataset}: {e}")
        return None

def test_audio(dataset, variable, start, end):
    """Test audio API for a dataset/variable combo"""
    start_basic = start.replace('-', '').replace(':', '')
    end_basic = end.replace('-', '').replace(':', '')
    url = f"{CDASWS_BASE_URL}/dataviews/{DATAVIEW}/datasets/{dataset}/data/{start_basic},{end_basic}/{variable}?format=audio"
    
    try:
        r = requests.get(url, headers={'Accept': 'application/json'}, timeout=120)
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}"
        data = r.json()
        files = data.get('FileDescription', [])
        if files:
            print(f"  OK: {len(files)} files, first={files[0].get('Length',0)/1024:.1f}KB")
            return True, files
        else:
            status = data.get('Status', [])
            if isinstance(status, list):
                msgs = [s.get('Message','') for s in status]
            else:
                msgs = [status.get('Message','')]
            return False, '; '.join(msgs)
    except Exception as e:
        return False, str(e)

# Datasets to test: (dataset, candidate_variables, time_range)
# candidate_variables: list of variable names to try (first match wins)
TESTS = [
    # === WIND ===
    # Wind WAVES electric field
    ('WI_H1_WAV', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('WI_H2_WAV', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('WI_ELFI_WAVES', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    # Wind SCM
    ('WI_H3-RTN_MFI', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    
    # === MMS Electric Field ===
    ('MMS1_EDP_SLOW_L2_DCE', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('MMS1_EDP_FAST_L2_DCE', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('MMS1_EDP_SRVY_L2_DCE', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('MMS1_EDP_BRST_L2_DCE', None, '2023-11-15T04:00:00Z', '2023-11-15T04:30:00Z'),
    ('MMS1_EDP_BRST_L2_HMFE', None, '2023-11-15T04:00:00Z', '2023-11-15T04:30:00Z'),
    # MMS SCM
    ('MMS1_SCM_SRVY_L2_SCSRVY', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('MMS1_SCM_BRST_L2_SCB', None, '2023-11-15T04:00:00Z', '2023-11-15T04:30:00Z'),
    
    # === THEMIS Electric Field ===
    ('THA_L2_EFI', None, '2020-06-15T00:00:00Z', '2020-06-15T06:00:00Z'),
    ('THD_L2_EFI', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    
    # === PSP Electric Field ===
    ('PSP_FLD_L2_DFB_DC_SPEC_DVDC', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('PSP_FLD_L2_DFB_DC_BPF_DVDC', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('PSP_FLD_L3_SQTN_RFS_V1V2', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    
    # === Solar Orbiter RPW ===
    ('SOLO_L2_RPW-LFR-SURV-CWF-E', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('SOLO_L2_RPW-LFR-SURV-SWF-E', None, '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
]

def main():
    results = {}
    
    for entry in TESTS:
        dataset, vars_to_try, start, end = entry
        print(f"\n{'='*60}")
        print(f"Dataset: {dataset}")
        
        # First get variables
        all_vars = get_variables(dataset)
        if all_vars is None:
            print(f"  SKIP: Dataset not found or error")
            results[dataset] = (False, "Dataset not found")
            continue
        
        # Print variable names
        var_names = [v.get('Name', '') for v in all_vars]
        print(f"  Variables ({len(var_names)}): {var_names[:15]}")
        
        # Find vector/data variables (skip Epoch, metadata, etc.)
        # Look for likely E-field or B-field vector variables
        candidates = []
        for v in all_vars:
            name = v.get('Name', '')
            # Skip obviously non-data vars
            if any(x in name.lower() for x in ['epoch', 'label', 'flag', 'quality', 'labl', 'delta', 'represent']):
                continue
            candidates.append(name)
        
        print(f"  Data candidates: {candidates[:10]}")
        
        if not candidates:
            print(f"  SKIP: No data variables found")
            results[dataset] = (False, "No data variables")
            continue
        
        # Try first few candidates
        found = False
        for var in candidates[:5]:
            print(f"  Testing variable: {var}")
            ok, info = test_audio(dataset, var, start, end)
            if ok:
                results[dataset] = (True, var)
                found = True
                break
            else:
                print(f"    Failed: {info}")
        
        if not found:
            results[dataset] = (False, "No working variable")
    
    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for dataset, (ok, info) in results.items():
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] {dataset}: {info}")

if __name__ == '__main__':
    main()
