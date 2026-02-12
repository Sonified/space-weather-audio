#!/usr/bin/env python3
"""Test remaining datasets: THEMIS EFI, PSP E-field, Solar Orbiter RPW"""
import requests, json, sys

BASE = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1'

def get_vars(ds):
    r = requests.get(f"{BASE}/dataviews/sp_phys/datasets/{ds}/variables", headers={'Accept':'application/json'}, timeout=30)
    if r.status_code != 200: return []
    return [v['Name'] for v in r.json().get('VariableDescription',[])]

def test(ds, var, start, end):
    s = start.replace('-','').replace(':','')
    e = end.replace('-','').replace(':','')
    url = f"{BASE}/dataviews/sp_phys/datasets/{ds}/data/{s},{e}/{var}?format=audio"
    try:
        r = requests.get(url, headers={'Accept':'application/json'}, timeout=90)
        if r.status_code != 200: return False, f"HTTP {r.status_code}"
        data = r.json()
        files = data.get('FileDescription',[])
        if files:
            print(f"  OK: {len(files)} files, {files[0].get('Length',0)/1024:.1f}KB")
            return True, files
        return False, "No files"
    except Exception as e:
        return False, str(e)

tests = [
    # THEMIS EFI
    ('THA_L2_EFI', '2020-06-15T00:00:00Z', '2020-06-15T06:00:00Z'),
    ('THD_L2_EFI', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    # PSP fields - try various
    ('PSP_FLD_L2_DFB_WF_DVDC', '2022-02-25T00:00:00Z', '2022-02-25T06:00:00Z'),
    ('PSP_FLD_L3_RFS_LFR_QTN', '2022-02-25T00:00:00Z', '2022-02-25T06:00:00Z'),
    # Solar Orbiter RPW
    ('SOLO_L2_RPW-LFR-SURV-CWF-E', '2023-06-15T00:00:00Z', '2023-06-15T06:00:00Z'),
    ('SOLO_L2_RPW-LFR-SURV-SWF-E', '2023-06-15T00:00:00Z', '2023-06-15T06:00:00Z'),
    # MMS burst EDP with a known burst time
    ('MMS1_EDP_BRST_L2_DCE', '2023-11-15T07:30:00Z', '2023-11-15T07:45:00Z'),
    # Wind E-field - try WAVES TDS
    ('WI_L2_TDS', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
    ('WI_WA_RAD1_L2_60S', '2023-11-15T00:00:00Z', '2023-11-15T06:00:00Z'),
]

for ds, start, end in tests:
    print(f"\n{ds}:")
    vars = get_vars(ds)
    if not vars:
        print(f"  Dataset not found")
        continue
    # Filter to data vars
    candidates = [v for v in vars if not any(x in v.lower() for x in ['epoch','label','flag','quality','labl','delta','represent','unit'])]
    print(f"  Vars: {candidates[:8]}")
    for v in candidates[:3]:
        print(f"  Testing {v}...")
        ok, info = test(ds, v, start, end)
        if ok:
            print(f"  ** WORKING: {ds} / {v}")
            break
        else:
            print(f"    Failed: {info}")
