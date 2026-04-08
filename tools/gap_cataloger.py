#!/usr/bin/env python3
"""
Gap Cataloger — Build nanosecond-precise gap metadata for ALL app datasets.

Two-step approach:
  1. Hit CDAWeb inventory endpoint → get coarse (second-precision) map of
     where data exists vs. gaps
  2. Download CDFs ONLY at gap boundaries → read epoch arrays for nanosecond-
     precise start/end times at each edge

Dataset list mirrors the app's SPACECRAFT_DATASETS (ui-controls.js) and
DATASET_VARIABLES (data-fetcher.js) exactly.

Usage:
    python gap_cataloger.py                              # All datasets
    python gap_cataloger.py --dataset PSP_FLD_L2_MAG_RTN # Single dataset
    python gap_cataloger.py --dry-run                    # Show inventory only

Progress: tail -f tools/gap_catalog_progress.log
Results:  tools/gap_catalog/*.json
"""

import json
import os
import sys
import time
import requests
import tempfile
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import threading
import traceback

# Only needed for boundary CDF reads
try:
    import cdflib
    import numpy as np
    HAS_CDFLIB = True
except ImportError:
    HAS_CDFLIB = False

# ============================================================================
# Configuration
# ============================================================================

SCRIPT_DIR = Path(__file__).parent
CATALOG_DIR = SCRIPT_DIR / 'gap_catalog'
PROGRESS_LOG = SCRIPT_DIR / 'gap_catalog_progress.log'
CDAWEB_BASE = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets'

# Courtesy level (1-10): how deferential we are when CDAWeb says slow down.
# Backoff = +5ms per 429 (fixed). Cooldown = -1ms per (level × 10min) of silence.
# Recovery time per 429 = level × 50 minutes.
#   Level 1:   50 min    Level 6:  300 min
#   Level 2:  100 min    Level 7:  350 min
#   Level 3:  150 min    Level 8:  400 min
#   Level 4:  200 min    Level 9:  450 min
#   Level 5:  250 min    Level 10: 500 min
COURTESY_LEVEL = 3
_BACKOFF_MS = 0.005                        # +5ms per 429 (fixed)
_COOLDOWN_INTERVAL = COURTESY_LEVEL * 600  # 30min at level 3; cooldown -1ms per interval

_request_lock = threading.Lock()
_last_request_time = time.time()  # prevents burst at startup
REQUEST_INTERVAL = 2.0  # seconds between requests
_rate_total_429s = 0
_rate_total_requests = 0
_last_429_time = time.time()
_MIN_INTERVAL = 1.5  # don't cool down below this

# Dynamic worker pool — start at 12, shrink on 429 clusters, grow on calm
_WORKER_MIN = 8
_WORKER_MAX = 12
_active_workers = _WORKER_MAX
_worker_gate = threading.Semaphore(_WORKER_MAX)  # controls concurrency
_worker_lock = threading.Lock()
_recent_429_times = []  # timestamps of recent 429s

def _adjust_workers_on_429():
    """If 2+ 429s within 2 minutes, drop a worker (floor at 8)."""
    global _active_workers
    now = time.time()
    with _worker_lock:
        _recent_429_times.append(now)
        # Prune older than 2 minutes
        cutoff = now - 120
        _recent_429_times[:] = [t for t in _recent_429_times if t > cutoff]
        if len(_recent_429_times) >= 2 and _active_workers > _WORKER_MIN:
            _active_workers -= 1
            # Acquire one permit = one fewer worker can run
            _worker_gate.acquire(blocking=False)
            log(f'    [workers] 429 cluster! Workers {_active_workers + 1} → {_active_workers}')

def _adjust_workers_on_calm():
    """If 30 minutes without a 429, add a worker (ceiling at max)."""
    global _active_workers
    with _worker_lock:
        if _active_workers < _WORKER_MAX:
            since_last = time.time() - _last_429_time
            if since_last >= 1800:
                _active_workers += 1
                _worker_gate.release()
                log(f'    [workers] Calm for {since_last:.0f}s, workers {_active_workers - 1} → {_active_workers}')

def _rate_limit_on_success():
    """Called after a successful request — track count, cool down if calm."""
    global _rate_total_requests, REQUEST_INTERVAL
    with _request_lock:
        _rate_total_requests += 1
        since_last_429 = time.time() - _last_429_time
        cooldown_steps = int(since_last_429 / _COOLDOWN_INTERVAL)
        if cooldown_steps > 0 and REQUEST_INTERVAL > _MIN_INTERVAL:
            new_interval = max(round(REQUEST_INTERVAL - 0.001, 3), _MIN_INTERVAL)
            if new_interval < REQUEST_INTERVAL:
                log(f'    [rate] Cooldown: {since_last_429:.0f}s since last 429, interval {REQUEST_INTERVAL:.3f}s → {new_interval:.3f}s')
                REQUEST_INTERVAL = new_interval
        if _rate_total_requests % 100 == 0:
            log(f'    [rate] Status: {REQUEST_INTERVAL:.3f}s interval ({1/REQUEST_INTERVAL:.2f} req/s), 429s={_rate_total_429s}, requests={_rate_total_requests}, courtesy={COURTESY_LEVEL}, workers={_active_workers}')
    _adjust_workers_on_calm()

def _rate_limit_on_429():
    """Called on 429 — back off +5ms, cap at 5s, maybe shrink worker pool."""
    global REQUEST_INTERVAL, _rate_total_429s, _last_429_time
    with _request_lock:
        _rate_total_429s += 1
        _last_429_time = time.time()
        REQUEST_INTERVAL = min(round(REQUEST_INTERVAL + _BACKOFF_MS, 3), 5.0)
        log(f'    [rate] 429 #{_rate_total_429s}! Interval now {REQUEST_INTERVAL:.3f}s ({1/REQUEST_INTERVAL:.2f} req/s)')
    _adjust_workers_on_429()

def _rate_limited_get(url, **kwargs):
    """requests.get() with global rate limiting across all threads."""
    global _last_request_time
    with _request_lock:
        now = time.time()
        wait = REQUEST_INTERVAL - (now - _last_request_time)
        if wait > 0:
            time.sleep(wait)
        _last_request_time = time.time()
    return requests.get(url, **kwargs)

# Every dataset the app serves — mirrors SPACECRAFT_DATASETS + DATASET_VARIABLES
# data_var is what the app requests from CDAWeb (used for CDF sharpening downloads)
# epoch_var is auto-detected from CDFs if set to None
ALL_DATASETS = [
    # === PSP ===
    {'id': 'PSP_FLD_L2_MAG_RTN',              'label': 'PSP MAG RTN (Full Cadence)',   'data_var': 'psp_fld_l2_mag_RTN',                  'start': '2018-10-01', 'end': '2025-12-31'},
    {'id': 'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC', 'label': 'PSP MAG RTN (4 Sa/Cyc)',      'data_var': 'psp_fld_l2_mag_RTN_4_Sa_per_Cyc',     'start': '2018-10-01', 'end': '2025-12-31'},
    {'id': 'PSP_FLD_L2_DFB_WF_DVDC',          'label': 'PSP DFB DC Voltage',           'data_var': 'psp_fld_l2_dfb_wf_dVdc_sensor',       'start': '2018-10-01', 'end': '2025-12-31'},
    # === Wind ===
    {'id': 'WI_H2_MFI',                       'label': 'Wind MFI Hi-Res',              'data_var': 'BGSE',                                'start': '1994-11-01', 'end': '2025-12-31'},
    # === MMS ===
    {'id': 'MMS1_FGM_SRVY_L2',                'label': 'MMS1 FGM Survey',              'data_var': 'mms1_fgm_b_gse_srvy_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_FGM_BRST_L2',                'label': 'MMS1 FGM Burst',               'data_var': 'mms1_fgm_b_gse_brst_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_SCM_SRVY_L2_SCSRVY',         'label': 'MMS1 SCM Survey',              'data_var': 'mms1_scm_acb_gse_scsrvy_srvy_l2',     'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_SCM_BRST_L2_SCB',            'label': 'MMS1 SCM Burst',               'data_var': 'mms1_scm_acb_gse_scb_brst_l2',        'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_EDP_SLOW_L2_DCE',            'label': 'MMS1 EDP Slow',                'data_var': 'mms1_edp_dce_gse_slow_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_EDP_FAST_L2_DCE',            'label': 'MMS1 EDP Fast',                'data_var': 'mms1_edp_dce_gse_fast_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS1_EDP_BRST_L2_DCE',            'label': 'MMS1 EDP Burst',               'data_var': 'mms1_edp_dce_gse_brst_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    # === MMS2 ===
    {'id': 'MMS2_FGM_SRVY_L2',                'label': 'MMS2 FGM Survey',              'data_var': 'mms2_fgm_b_gse_srvy_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_FGM_BRST_L2',                'label': 'MMS2 FGM Burst',               'data_var': 'mms2_fgm_b_gse_brst_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_SCM_SRVY_L2_SCSRVY',         'label': 'MMS2 SCM Survey',              'data_var': 'mms2_scm_acb_gse_scsrvy_srvy_l2',     'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_SCM_BRST_L2_SCB',            'label': 'MMS2 SCM Burst',               'data_var': 'mms2_scm_acb_gse_scb_brst_l2',        'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_EDP_SLOW_L2_DCE',            'label': 'MMS2 EDP Slow',                'data_var': 'mms2_edp_dce_gse_slow_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_EDP_FAST_L2_DCE',            'label': 'MMS2 EDP Fast',                'data_var': 'mms2_edp_dce_gse_fast_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS2_EDP_BRST_L2_DCE',            'label': 'MMS2 EDP Burst',               'data_var': 'mms2_edp_dce_gse_brst_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    # === MMS3 ===
    {'id': 'MMS3_FGM_SRVY_L2',                'label': 'MMS3 FGM Survey',              'data_var': 'mms3_fgm_b_gse_srvy_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_FGM_BRST_L2',                'label': 'MMS3 FGM Burst',               'data_var': 'mms3_fgm_b_gse_brst_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_SCM_SRVY_L2_SCSRVY',         'label': 'MMS3 SCM Survey',              'data_var': 'mms3_scm_acb_gse_scsrvy_srvy_l2',     'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_SCM_BRST_L2_SCB',            'label': 'MMS3 SCM Burst',               'data_var': 'mms3_scm_acb_gse_scb_brst_l2',        'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_EDP_SLOW_L2_DCE',            'label': 'MMS3 EDP Slow',                'data_var': 'mms3_edp_dce_gse_slow_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_EDP_FAST_L2_DCE',            'label': 'MMS3 EDP Fast',                'data_var': 'mms3_edp_dce_gse_fast_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS3_EDP_BRST_L2_DCE',            'label': 'MMS3 EDP Burst',               'data_var': 'mms3_edp_dce_gse_brst_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    # === MMS4 ===
    {'id': 'MMS4_FGM_SRVY_L2',                'label': 'MMS4 FGM Survey',              'data_var': 'mms4_fgm_b_gse_srvy_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_FGM_BRST_L2',                'label': 'MMS4 FGM Burst',               'data_var': 'mms4_fgm_b_gse_brst_l2',              'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_SCM_SRVY_L2_SCSRVY',         'label': 'MMS4 SCM Survey',              'data_var': 'mms4_scm_acb_gse_scsrvy_srvy_l2',     'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_SCM_BRST_L2_SCB',            'label': 'MMS4 SCM Burst',               'data_var': 'mms4_scm_acb_gse_scb_brst_l2',        'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_EDP_SLOW_L2_DCE',            'label': 'MMS4 EDP Slow',                'data_var': 'mms4_edp_dce_gse_slow_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_EDP_FAST_L2_DCE',            'label': 'MMS4 EDP Fast',                'data_var': 'mms4_edp_dce_gse_fast_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    {'id': 'MMS4_EDP_BRST_L2_DCE',            'label': 'MMS4 EDP Burst',               'data_var': 'mms4_edp_dce_gse_brst_l2',             'start': '2015-09-01', 'end': '2025-12-31'},
    # === THEMIS FGM ===
    {'id': 'THA_L2_FGM',                      'label': 'THEMIS-A FGM',                 'data_var': 'tha_fgl_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THB_L2_FGM',                      'label': 'THEMIS-B FGM',                 'data_var': 'thb_fgl_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THC_L2_FGM',                      'label': 'THEMIS-C FGM',                 'data_var': 'thc_fgl_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THD_L2_FGM',                      'label': 'THEMIS-D FGM',                 'data_var': 'thd_fgl_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THE_L2_FGM',                      'label': 'THEMIS-E FGM',                 'data_var': 'the_fgl_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    # === THEMIS SCM ===
    {'id': 'THA_L2_SCM',                      'label': 'THEMIS-A SCM',                 'data_var': 'tha_scf_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THB_L2_SCM',                      'label': 'THEMIS-B SCM',                 'data_var': 'thb_scf_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THC_L2_SCM',                      'label': 'THEMIS-C SCM',                 'data_var': 'thc_scf_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THD_L2_SCM',                      'label': 'THEMIS-D SCM',                 'data_var': 'thd_scf_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THE_L2_SCM',                      'label': 'THEMIS-E SCM',                 'data_var': 'the_scf_gse',                          'start': '2007-02-01', 'end': '2025-12-31'},
    # === THEMIS EFI ===
    {'id': 'THA_L2_EFI',                      'label': 'THEMIS-A EFI',                 'data_var': 'tha_efs_dot0_gse',                     'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THB_L2_EFI',                      'label': 'THEMIS-B EFI',                 'data_var': 'thb_efs_dot0_gse',                     'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THC_L2_EFI',                      'label': 'THEMIS-C EFI',                 'data_var': 'thc_efs_dot0_gse',                     'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THD_L2_EFI',                      'label': 'THEMIS-D EFI',                 'data_var': 'thd_efs_dot0_gse',                     'start': '2007-02-01', 'end': '2025-12-31'},
    {'id': 'THE_L2_EFI',                      'label': 'THEMIS-E EFI',                 'data_var': 'the_efs_dot0_gse',                     'start': '2007-02-01', 'end': '2025-12-31'},
    # === Solar Orbiter ===
    {'id': 'SOLO_L2_MAG-RTN-NORMAL',          'label': 'SolO MAG Normal',              'data_var': 'B_RTN',                                'start': '2020-02-01', 'end': '2025-12-31'},
    {'id': 'SOLO_L2_MAG-RTN-BURST',           'label': 'SolO MAG Burst',               'data_var': 'B_RTN',                                'start': '2020-02-01', 'end': '2025-12-31'},
    {'id': 'SOLO_L2_RPW-LFR-SURV-CWF-E',     'label': 'SolO RPW LFR E-field',         'data_var': 'EDC',                                  'start': '2020-02-01', 'end': '2025-12-31'},
    # === GOES ===
    {'id': 'DN_MAGN-L2-HIRES_G16',            'label': 'GOES-16 MAG 10 Hz',            'data_var': 'b_gse',                                'start': '2018-08-01', 'end': '2025-12-31'},
    {'id': 'DN_MAGN-L2-HIRES_G19',            'label': 'GOES-19 MAG 10 Hz',            'data_var': 'b_gse',                                'start': '2025-06-01', 'end': '2025-12-31'},
    # === ACE ===
    {'id': 'AC_H3_MFI',                       'label': 'ACE MFI 1-sec',                'data_var': 'BGSEc',                                'start': '1997-09-01', 'end': '2025-12-31'},
    # === DSCOVR ===
    {'id': 'DSCOVR_H0_MAG',                   'label': 'DSCOVR Fluxgate MAG',          'data_var': 'B1GSE',                                'start': '2016-03-01', 'end': '2025-12-31'},
    # === Cluster ===
    {'id': 'C1_CP_FGM_5VPS',                  'label': 'Cluster-1 FGM 5 Vec/s',        'data_var': 'B_vec_xyz_gse__C1_CP_FGM_5VPS',        'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C2_CP_FGM_5VPS',                  'label': 'Cluster-2 FGM 5 Vec/s',        'data_var': 'B_vec_xyz_gse__C2_CP_FGM_5VPS',        'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C3_CP_FGM_5VPS',                  'label': 'Cluster-3 FGM 5 Vec/s',        'data_var': 'B_vec_xyz_gse__C3_CP_FGM_5VPS',        'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C4_CP_FGM_5VPS',                  'label': 'Cluster-4 FGM 5 Vec/s',        'data_var': 'B_vec_xyz_gse__C4_CP_FGM_5VPS',        'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C1_CP_STA_CWF_GSE',               'label': 'Cluster-1 STAFF CWF',          'data_var': 'B_vec_xyz_Instrument__C1_CP_STA_CWF_GSE', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C2_CP_STA_CWF_GSE',               'label': 'Cluster-2 STAFF CWF',          'data_var': 'B_vec_xyz_Instrument__C2_CP_STA_CWF_GSE', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C3_CP_STA_CWF_GSE',               'label': 'Cluster-3 STAFF CWF',          'data_var': 'B_vec_xyz_Instrument__C3_CP_STA_CWF_GSE', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C4_CP_STA_CWF_GSE',               'label': 'Cluster-4 STAFF CWF',          'data_var': 'B_vec_xyz_Instrument__C4_CP_STA_CWF_GSE', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C1_CP_EFW_L3_E3D_INERT',          'label': 'Cluster-1 EFW E3D',            'data_var': 'E_Vec_xyz_ISR2__C1_CP_EFW_L3_E3D_INERT', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C2_CP_EFW_L3_E3D_INERT',          'label': 'Cluster-2 EFW E3D',            'data_var': 'E_Vec_xyz_ISR2__C2_CP_EFW_L3_E3D_INERT', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C3_CP_EFW_L3_E3D_INERT',          'label': 'Cluster-3 EFW E3D',            'data_var': 'E_Vec_xyz_ISR2__C3_CP_EFW_L3_E3D_INERT', 'start': '2001-01-01', 'end': '2023-12-31'},
    {'id': 'C4_CP_EFW_L3_E3D_INERT',          'label': 'Cluster-4 EFW E3D',            'data_var': 'E_Vec_xyz_ISR2__C4_CP_EFW_L3_E3D_INERT', 'start': '2001-01-01', 'end': '2023-12-31'},
    # === Geotail ===
    {'id': 'GE_EDB3SEC_MGF',                  'label': 'Geotail MGF 3-sec',            'data_var': 'BGSE',                                 'start': '1992-09-01', 'end': '2022-11-28'},
    {'id': 'GE_K0_EFD',                       'label': 'Geotail EFD',                  'data_var': 'Es',                                   'start': '1992-09-01', 'end': '2022-11-28'},
    # === Voyager ===
    {'id': 'VOYAGER1_2S_MAG',                 'label': 'Voyager-1 MAG 1.92s',          'data_var': 'B1',                                   'start': '1977-09-01', 'end': '2025-12-31'},
    {'id': 'VOYAGER2_2S_MAG',                 'label': 'Voyager-2 MAG 1.92s',          'data_var': 'B1',                                   'start': '1977-08-01', 'end': '2025-12-31'},
]

# Thread-safe progress logging
_log_lock = threading.Lock()

# Auto-cap: datasets with more gaps than this skip CDF sharpening
# Set to 0 to disable cap (sharpen everything, even burst-mode datasets)
MAX_SHARPEN_GAPS = 100000


def log(msg, dataset_id=None):
    """Thread-safe logging to both console and file."""
    ts = datetime.now().strftime('%H:%M:%S')
    prefix = f'[{ts}]'
    if dataset_id:
        prefix += f' [{dataset_id}]'
    line = f'{prefix} {msg}'
    with _log_lock:
        print(line, flush=True)
        with open(PROGRESS_LOG, 'a') as f:
            f.write(line + '\n')


# ============================================================================
# Step 1: Inventory — coarse gap map (second precision)
# ============================================================================

def fetch_inventory(dataset_id, start_str, end_str):
    """
    Hit CDAWeb inventory endpoint. Returns list of time intervals
    where data exists. Gaps are the spaces between intervals.
    """
    start = datetime.strptime(start_str, '%Y-%m-%d')
    end = datetime.strptime(end_str, '%Y-%m-%d')

    # Clamp end to today
    today = datetime.now()
    if end > today:
        end = today

    start_iso = start.strftime('%Y%m%dT000000Z')
    end_iso = end.strftime('%Y%m%dT235959Z')

    url = f'{CDAWEB_BASE}/{dataset_id}/inventory/{start_iso},{end_iso}'
    headers = {'Accept': 'application/json'}

    resp = _rate_limited_get(url, headers=headers, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    intervals = []
    if 'InventoryDescription' in data and len(data['InventoryDescription']) > 0:
        for item in data['InventoryDescription']:
            if 'TimeInterval' in item:
                for ti in item['TimeInterval']:
                    intervals.append({
                        'start': ti['Start'],
                        'end': ti['End'],
                    })

    return intervals


def find_gap_boundaries(intervals):
    """
    Given inventory intervals, identify the gap boundaries.
    Returns list of gaps (the spaces between intervals).
    """
    gaps = []
    for i in range(len(intervals) - 1):
        gaps.append({
            'gap_start': intervals[i]['end'],
            'gap_end': intervals[i + 1]['start'],
            'before_interval_idx': i,
            'after_interval_idx': i + 1,
        })
    return gaps


# ============================================================================
# Step 2: Boundary CDF reads — nanosecond precision at gap edges
# ============================================================================

def detect_epoch_var(cdf):
    """
    Auto-detect the epoch/time variable from a CDF.
    Tries common names, then searches all zVariables.
    Returns the variable name or None.
    """
    zvars = cdf.cdf_info().zVariables

    # Try common epoch variable names first (exact match, case-sensitive)
    for candidate in ['Epoch', 'epoch', 'EPOCH']:
        if candidate in zvars:
            return candidate

    # Search for variables with epoch/time in the name
    for v in zvars:
        vl = v.lower()
        if 'epoch' in vl or 'time' in vl:
            # Verify it's a 1D array (not a scalar or metadata)
            try:
                val = cdf.varget(v)
                if val is not None and hasattr(val, '__len__') and len(val) > 0:
                    return v
            except Exception:
                continue

    return None


def sharpen_boundary(dataset_id, data_var, iso_time, edge='end'):
    """
    Download a small CDF at a gap boundary and read the epoch array
    to get nanosecond-precise timestamp + native cadence.

    edge='end': we want the last timestamp of the interval ending here
    edge='start': we want the first timestamp of the interval starting here

    Returns (raw_epoch, cadence_ns) tuple, or (None, None) on failure.
    cadence_ns is the median sample spacing in nanoseconds (converted from
    whatever epoch type the CDF uses).

    Epoch variable is auto-detected from the CDF.
    """
    if not HAS_CDFLIB:
        return None, None

    t = datetime.strptime(iso_time.replace('Z', ''), '%Y-%m-%dT%H:%M:%S.%f')

    if edge == 'end':
        win_start = t - timedelta(minutes=2)
        win_end = t + timedelta(seconds=5)
    else:
        win_start = t - timedelta(seconds=5)
        win_end = t + timedelta(minutes=2)

    start_iso = win_start.strftime('%Y%m%dT%H%M%SZ')
    end_iso = win_end.strftime('%Y%m%dT%H%M%SZ')

    url = (
        f'{CDAWEB_BASE}/{dataset_id}/data/'
        f'{start_iso},{end_iso}/{data_var}?format=cdf'
    )
    headers = {'Accept': 'application/json'}

    max_retries = 6
    for attempt in range(max_retries + 1):
        try:
            resp = _rate_limited_get(url, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()

            if 'FileDescription' not in data or len(data['FileDescription']) == 0:
                return None, None

            cdf_url = data['FileDescription'][0]['Name']

            with tempfile.NamedTemporaryFile(suffix='.cdf', delete=False) as tmp:
                tmp_path = tmp.name

            try:
                resp = _rate_limited_get(cdf_url, timeout=120, stream=True)
                resp.raise_for_status()
                with open(tmp_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=65536):
                        f.write(chunk)

                cdf = cdflib.CDF(tmp_path)
                epoch_var = detect_epoch_var(cdf)
                if not epoch_var:
                    log(f'    Could not detect epoch variable! zVars={cdf.cdf_info().zVariables}', dataset_id)
                    return None, None

                epoch = cdf.varget(epoch_var)

                if epoch is None or not hasattr(epoch, '__len__') or len(epoch) == 0:
                    return None, None

                # Return raw numpy value — could be int64 (TT2000 ns) or float64 (CDF_EPOCH ms)
                # Preserve the numpy dtype so cdflib.cdfepoch.encode knows which type it is
                raw = epoch[-1] if edge == 'end' else epoch[0]

                # Compute native cadence from sample spacing
                cadence_ns = None
                if len(epoch) >= 2:
                    diffs = np.diff(epoch[:min(100, len(epoch))].astype(np.float64))
                    # Filter out any non-positive diffs (duplicates/reversals)
                    diffs = diffs[diffs > 0]
                    if len(diffs) > 0:
                        median_diff = float(np.median(diffs))
                        # TT2000 is already in nanoseconds; CDF_EPOCH is in milliseconds
                        if epoch.dtype == np.int64:
                            cadence_ns = median_diff  # already ns
                        else:
                            cadence_ns = median_diff * 1e6  # ms → ns

                _rate_limit_on_success()
                return raw, cadence_ns

            finally:
                os.unlink(tmp_path)

        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429 and attempt < max_retries:
                _rate_limit_on_429()
                wait = 2 ** (attempt + 2)  # 4s, 8s, 16s, 32s, 64s, 128s
                log(f'    Rate limited (429), retry {attempt+1}/{max_retries} in {wait}s...', dataset_id)
                time.sleep(wait)
                continue
            log(f'    Sharpen error ({edge}): {e}', dataset_id)
            return None, None
        except Exception as e:
            log(f'    Sharpen error ({edge}): {e}', dataset_id)
            return None, None


def epoch_to_iso(raw_epoch):
    """Convert raw epoch value to ISO string. Handles both TT2000 (int64/ns) and CDF_EPOCH (float64/ms)."""
    if not HAS_CDFLIB:
        return f'epoch={raw_epoch}'
    try:
        # cdflib.cdfepoch.encode handles both CDF_EPOCH and TT2000 automatically
        encoded = cdflib.cdfepoch.encode(raw_epoch)
        if isinstance(encoded, list):
            encoded = encoded[0]
        # Trim to millisecond precision for readability
        # TT2000 encodes as "2018-10-02T16:58:01.233000000" — trim trailing ns zeros
        s = str(encoded)
        if '.' in s and len(s) > 23:
            s = s[:23]  # keep up to ms: YYYY-MM-DDTHH:MM:SS.mmm
        return s
    except Exception:
        return f'epoch={raw_epoch}'


# ============================================================================
# Per-Dataset Cataloger
# ============================================================================

def catalog_dataset(ds, dry_run=False, sharpen=True, skip_existing=True, throttle_sec=0):
    """Catalog all gaps for one dataset."""
    dataset_id = ds['id']
    label = ds['label']

    # Check if catalog already exists
    out_path = CATALOG_DIR / f'{dataset_id}.json'
    existing_intervals = None  # Will hold intervals from partial catalog for resume
    if skip_existing and out_path.exists() and not dry_run:
        try:
            with open(out_path) as f:
                existing = json.load(f)
            ex_range = existing.get('time_range', {})
            sharpened = existing['summary'].get('boundaries_sharpened', False)

            if ex_range.get('start') == ds['start'] and ex_range.get('end') == ds['end']:
                if sharpened is True:
                    # Fully complete — skip entirely
                    n = existing['summary']['total_intervals']
                    g = existing['summary']['total_gaps']
                    log(f'SKIP -- {label} (complete: {n} intervals, {g} gaps)', dataset_id)
                    return existing
                elif sharpened == 'in_progress':
                    # Partial sharpening — resume from where we left off
                    existing_intervals = existing.get('intervals', [])
                    log(f'RESUMING -- {label} (partial catalog found)', dataset_id)
                else:
                    # Inventory-only catalog (sharpened=False), skip if we don't want sharpening
                    if not sharpen:
                        n = existing['summary']['total_intervals']
                        g = existing['summary']['total_gaps']
                        log(f'SKIP -- {label} (inventory-only: {n} intervals, {g} gaps)', dataset_id)
                        return existing
                    # else: we want sharpening but existing is unsharpened — resume and sharpen
                    existing_intervals = existing.get('intervals', [])
                    log(f'UPGRADING -- {label} (adding boundary sharpening to existing catalog)', dataset_id)
            else:
                log(f'RE-RUNNING -- {label} (range mismatch: have {ex_range.get("start")}..{ex_range.get("end")}, want {ds["start"]}..{ds["end"]})', dataset_id)
        except (json.JSONDecodeError, KeyError):
            log(f'RE-RUNNING -- {label} (existing catalog corrupt)', dataset_id)

    log(f'START -- {label}', dataset_id)

    # Step 1: Inventory
    log(f'Fetching inventory ({ds["start"]} to {ds["end"]})...', dataset_id)
    try:
        intervals = fetch_inventory(dataset_id, ds['start'], ds['end'])
    except Exception as e:
        log(f'INVENTORY ERROR: {e}', dataset_id)
        return None

    n_intervals = len(intervals)
    n_gaps = max(0, n_intervals - 1)
    log(f'{n_intervals} data intervals, {n_gaps} gaps', dataset_id)

    if n_intervals == 0:
        log(f'DONE -- no data found in range', dataset_id)
        catalog = {
            'dataset_id': dataset_id,
            'label': label,
            'cataloged_at': datetime.now().isoformat(),
            'time_range': {'start': ds['start'], 'end': ds['end']},
            'summary': {'total_intervals': 0, 'total_gaps': 0, 'boundaries_sharpened': False},
            'intervals': [],
        }
        CATALOG_DIR.mkdir(exist_ok=True)
        with open(out_path, 'w') as f:
            json.dump(catalog, f, indent=2)
        return catalog

    # Auto-skip sharpening for burst-mode datasets with insane gap counts
    if sharpen and n_gaps > MAX_SHARPEN_GAPS:
        log(f'WARNING: {n_gaps} gaps exceeds {MAX_SHARPEN_GAPS} limit, using inventory precision only', dataset_id)
        sharpen = False

    if dry_run:
        for i, iv in enumerate(intervals):
            log(f'  Interval {i+1}: {iv["start"]} to {iv["end"]}', dataset_id)
        if n_gaps > 0:
            gaps = find_gap_boundaries(intervals)
            for i, g in enumerate(gaps):
                log(f'  Gap {i+1}: {g["gap_start"]} to {g["gap_end"]}', dataset_id)
        return None

    # Build initial catalog — reuse existing intervals if resuming (preserves sharpened data)
    if existing_intervals and len(existing_intervals) == n_intervals:
        catalog_intervals = existing_intervals
    else:
        catalog_intervals = []
        for iv in intervals:
            catalog_intervals.append({
                'start_iso': iv['start'],
                'end_iso': iv['end'],
            })

    # Helper to save catalog to disk (used for both progress saves and final write)
    def save_catalog(sharpened_flag):
        catalog = {
            'dataset_id': dataset_id,
            'label': label,
            'cataloged_at': datetime.now().isoformat(),
            'time_range': {'start': ds['start'], 'end': ds['end']},
            'summary': {
                'total_intervals': n_intervals,
                'total_gaps': n_gaps,
                'boundaries_sharpened': sharpened_flag,
            },
            'intervals': catalog_intervals,
        }
        CATALOG_DIR.mkdir(exist_ok=True)
        with open(out_path, 'w') as f:
            json.dump(catalog, f, indent=2)
        return catalog

    # Step 2: Sharpen boundaries with CDF reads
    if sharpen and HAS_CDFLIB and n_gaps > 0:
        gaps = find_gap_boundaries(intervals)

        # Check how many boundaries are already sharpened (resume from partial catalog)
        already_done = sum(1 for iv in catalog_intervals if 'start_precise' in iv or 'end_precise' in iv)
        if already_done > 0:
            log(f'Resuming: {already_done} intervals already have sharpened boundaries', dataset_id)

        remaining = sum(1 for gap in gaps
                        if 'end_precise' not in catalog_intervals[gap['before_interval_idx']]
                        or 'start_precise' not in catalog_intervals[gap['after_interval_idx']])
        log(f'Sharpening {n_gaps} gap boundaries ({remaining} gaps remaining)...', dataset_id)

        for i, gap in enumerate(gaps):
            before_idx = gap['before_interval_idx']
            after_idx = gap['after_interval_idx']

            need_end = 'end_precise' not in catalog_intervals[before_idx]
            need_start = 'start_precise' not in catalog_intervals[after_idx]

            if not need_end and not need_start:
                continue

            log(f'  Gap {i+1}/{n_gaps}: {gap["gap_start"]} to {gap["gap_end"]}', dataset_id)

            if need_end:
                ns, cadence = sharpen_boundary(
                    dataset_id, ds['data_var'],
                    intervals[before_idx]['end'], edge='end'
                )
                if ns is not None:
                    catalog_intervals[before_idx]['end_epoch_raw'] = float(ns)
                    catalog_intervals[before_idx]['end_precise'] = epoch_to_iso(ns)
                    if cadence is not None:
                        catalog_intervals[before_idx]['cadence_ns'] = cadence
                    log(f'    End sharpened: {intervals[before_idx]["end"]} -> {epoch_to_iso(ns)}', dataset_id)
                else:
                    log(f'    End: using inventory precision', dataset_id)

            if need_start:
                ns, cadence = sharpen_boundary(
                    dataset_id, ds['data_var'],
                    intervals[after_idx]['start'], edge='start'
                )
                if ns is not None:
                    catalog_intervals[after_idx]['start_epoch_raw'] = float(ns)
                    catalog_intervals[after_idx]['start_precise'] = epoch_to_iso(ns)
                    if cadence is not None and 'cadence_ns' not in catalog_intervals[after_idx]:
                        catalog_intervals[after_idx]['cadence_ns'] = cadence
                    log(f'    Start sharpened: {intervals[after_idx]["start"]} -> {epoch_to_iso(ns)}', dataset_id)
                else:
                    log(f'    Start: using inventory precision', dataset_id)

            # Save progress every 5 gaps
            if (i + 1) % 5 == 0:
                save_catalog(sharpened_flag='in_progress')

            # Throttle to avoid rate-limiting CDAWeb
            if throttle_sec > 0:
                time.sleep(throttle_sec)

    # Final save
    catalog = save_catalog(sharpened_flag=(sharpen and HAS_CDFLIB))
    log(f'DONE -- {n_intervals} intervals, {n_gaps} gaps -> {out_path.name}', dataset_id)
    return catalog


# ============================================================================
# Burst-mode parallel sharpening — split by year across workers
# ============================================================================

# Lock for thread-safe catalog writes during burst parallel sharpening
_catalog_lock = threading.Lock()


def _sharpen_gap_chunk(dataset_id, data_var, intervals, catalog_intervals, gaps, gap_indices, chunk_label, out_path, ds, throttle_sec=1.0):
    """Sharpen a chunk of gaps (subset of indices) for a burst dataset. Thread-safe catalog saves."""
    for count, gap_idx in enumerate(gap_indices):
        # Dynamic worker gate — blocks if pool has been shrunk
        _worker_gate.acquire()
        _worker_gate.release()

        gap = gaps[gap_idx]
        before_idx = gap['before_interval_idx']
        after_idx = gap['after_interval_idx']

        need_end = 'end_precise' not in catalog_intervals[before_idx]
        need_start = 'start_precise' not in catalog_intervals[after_idx]

        if not need_end and not need_start:
            continue

        log(f'  [{chunk_label}] Gap {gap_idx+1}/{len(gaps)}: {gap["gap_start"]} to {gap["gap_end"]}', dataset_id)

        if need_end:
            ns, cadence = sharpen_boundary(dataset_id, data_var, intervals[before_idx]['end'], edge='end')
            if ns is not None:
                catalog_intervals[before_idx]['end_epoch_raw'] = float(ns)
                catalog_intervals[before_idx]['end_precise'] = epoch_to_iso(ns)
                if cadence is not None:
                    catalog_intervals[before_idx]['cadence_ns'] = cadence
                log(f'    End sharpened: {intervals[before_idx]["end"]} -> {epoch_to_iso(ns)}', dataset_id)
            else:
                log(f'    End: using inventory precision', dataset_id)

        if need_start:
            ns, cadence = sharpen_boundary(dataset_id, data_var, intervals[after_idx]['start'], edge='start')
            if ns is not None:
                catalog_intervals[after_idx]['start_epoch_raw'] = float(ns)
                catalog_intervals[after_idx]['start_precise'] = epoch_to_iso(ns)
                if cadence is not None and 'cadence_ns' not in catalog_intervals[after_idx]:
                    catalog_intervals[after_idx]['cadence_ns'] = cadence
                log(f'    Start sharpened: {intervals[after_idx]["start"]} -> {epoch_to_iso(ns)}', dataset_id)
            else:
                log(f'    Start: using inventory precision', dataset_id)

        # Save progress every 10 gaps (thread-safe)
        if (count + 1) % 10 == 0:
            with _catalog_lock:
                _save_burst_catalog(dataset_id, ds, catalog_intervals, intervals, gaps, 'in_progress', out_path)

        if throttle_sec > 0:
            time.sleep(throttle_sec)

    log(f'  [{chunk_label}] Chunk complete ({len(gap_indices)} gaps)', dataset_id)


def _save_burst_catalog(dataset_id, ds, catalog_intervals, intervals, gaps, sharpened_flag, out_path):
    """Write burst catalog to disk."""
    catalog = {
        'dataset_id': dataset_id,
        'label': ds['label'],
        'cataloged_at': datetime.now().isoformat(),
        'time_range': {'start': ds['start'], 'end': ds['end']},
        'summary': {
            'total_intervals': len(intervals),
            'total_gaps': len(gaps),
            'boundaries_sharpened': sharpened_flag,
        },
        'intervals': catalog_intervals,
    }
    CATALOG_DIR.mkdir(exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(catalog, f, indent=2)


def catalog_dataset_burst_parallel(ds, n_workers, dry_run=False, skip_existing=True):
    """
    Catalog a burst dataset by splitting gaps into year-based chunks
    and sharpening across multiple workers in parallel.
    """
    dataset_id = ds['id']
    label = ds['label']
    out_path = CATALOG_DIR / f'{dataset_id}.json'

    # Check for existing catalog (resume support)
    existing_intervals = None
    if skip_existing and out_path.exists() and not dry_run:
        try:
            with open(out_path) as f:
                existing = json.load(f)
            ex_range = existing.get('time_range', {})
            sharpened = existing['summary'].get('boundaries_sharpened', False)
            if ex_range.get('start') == ds['start'] and ex_range.get('end') == ds['end']:
                if sharpened is True:
                    n = existing['summary']['total_intervals']
                    g = existing['summary']['total_gaps']
                    log(f'SKIP -- {label} (complete: {n} intervals, {g} gaps)', dataset_id)
                    return
                elif sharpened == 'in_progress' or sharpened is False:
                    existing_intervals = existing.get('intervals', [])
                    log(f'RESUMING -- {label} (partial catalog found)', dataset_id)
        except (json.JSONDecodeError, KeyError):
            log(f'RE-RUNNING -- {label} (existing catalog corrupt)', dataset_id)

    log(f'START (burst parallel) -- {label}', dataset_id)

    # Fetch inventory
    log(f'Fetching inventory ({ds["start"]} to {ds["end"]})...', dataset_id)
    try:
        intervals = fetch_inventory(dataset_id, ds['start'], ds['end'])
    except Exception as e:
        log(f'INVENTORY ERROR: {e}', dataset_id)
        return

    n_intervals = len(intervals)
    n_gaps = max(0, n_intervals - 1)
    log(f'{n_intervals} data intervals, {n_gaps} gaps', dataset_id)

    if n_gaps == 0:
        return

    # Build catalog intervals (reuse existing for resume)
    if existing_intervals and len(existing_intervals) == n_intervals:
        catalog_intervals = existing_intervals
    else:
        catalog_intervals = [{'start_iso': iv['start'], 'end_iso': iv['end']} for iv in intervals]

    gaps = find_gap_boundaries(intervals)

    # Split gaps by year based on gap_start timestamp
    from collections import defaultdict
    year_chunks = defaultdict(list)
    for i, gap in enumerate(gaps):
        year = gap['gap_start'][:4]  # e.g. "2015"
        year_chunks[year].append(i)

    years_sorted = sorted(year_chunks.keys())
    log(f'Split into {len(years_sorted)} year chunks across {n_workers} workers: {years_sorted[0]}-{years_sorted[-1]}', dataset_id)

    # Check how many are already done
    already_done = sum(1 for iv in catalog_intervals if 'start_precise' in iv or 'end_precise' in iv)
    if already_done > 0:
        log(f'Resuming: {already_done} intervals already have sharpened boundaries', dataset_id)

    # Farm year chunks to workers
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {}
        for year in years_sorted:
            gap_indices = year_chunks[year]
            futures[pool.submit(
                _sharpen_gap_chunk,
                dataset_id, ds['data_var'], intervals, catalog_intervals,
                gaps, gap_indices, year, out_path, ds, 0
            )] = year

        for future in as_completed(futures):
            year = futures[future]
            try:
                future.result()
            except Exception as e:
                log(f'FATAL ERROR in year {year}: {e}', dataset_id)
                traceback.print_exc()

    # Final save
    with _catalog_lock:
        _save_burst_catalog(dataset_id, ds, catalog_intervals, intervals, gaps, True, out_path)
    log(f'DONE -- {n_intervals} intervals, {n_gaps} gaps -> {out_path.name}', dataset_id)


# ============================================================================
# Main
# ============================================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Catalog CDAWeb data gaps for all app datasets')
    parser.add_argument('--dataset', type=str, help='Single dataset ID to process')
    parser.add_argument('--dry-run', action='store_true', help='Show inventory only, no CDF downloads')
    parser.add_argument('--workers', type=int, default=4, help='Parallel workers (default: 4)')
    parser.add_argument('--start', type=str, help='Override start date (YYYY-MM-DD)')
    parser.add_argument('--end', type=str, help='Override end date (YYYY-MM-DD)')
    parser.add_argument('--no-sharpen', action='store_true', help='Skip CDF boundary sharpening')
    parser.add_argument('--force', action='store_true', help='Re-catalog even if JSON already exists')
    args = parser.parse_args()

    # Clear progress log
    with open(PROGRESS_LOG, 'w') as f:
        f.write(f'Gap Cataloger started at {datetime.now().isoformat()}\n')
        f.write(f'{"="*60}\n\n')

    if not HAS_CDFLIB and not args.no_sharpen:
        log('WARNING: cdflib not installed -- boundaries will use inventory precision only')

    # Select datasets
    if args.dataset:
        datasets = [ds for ds in ALL_DATASETS if ds['id'] == args.dataset]
        if not datasets:
            print(f'Unknown dataset: {args.dataset}')
            print(f'Available ({len(ALL_DATASETS)}):')
            for ds in ALL_DATASETS:
                print(f'  {ds["id"]:<40} {ds["label"]}')
            sys.exit(1)
    else:
        datasets = list(ALL_DATASETS)

    # Override dates if specified
    if args.start or args.end:
        datasets = [ds.copy() for ds in datasets]
        for ds in datasets:
            if args.start:
                ds['start'] = args.start
            if args.end:
                ds['end'] = args.end

    sharpen = not args.no_sharpen
    skip_existing = not args.force

    log(f'Cataloging {len(datasets)} dataset(s) with {args.workers} worker(s)')
    log(f'Boundary sharpening: {"ON (CDF reads at gap edges)" if sharpen else "OFF (inventory precision only)"}')
    log(f'Skip existing: {"YES" if skip_existing else "NO (--force)"}')
    log(f'Progress: tail -f {PROGRESS_LOG}')
    log(f'Results:  {CATALOG_DIR}/')
    log('')

    CATALOG_DIR.mkdir(exist_ok=True)
    start_time = time.time()

    # Sort: non-burst datasets first, burst datasets last (they have 90K+ gaps)
    BURST_IDS = {f'MMS{n}_{inst}' for n in range(1, 5) for inst in ('FGM_BRST_L2', 'SCM_BRST_L2_SCB', 'EDP_BRST_L2_DCE')}
    non_burst = [ds for ds in datasets if ds['id'] not in BURST_IDS]
    burst = [ds for ds in datasets if ds['id'] in BURST_IDS]

    if len(datasets) == 1:
        catalog_dataset(datasets[0], dry_run=args.dry_run, sharpen=sharpen, skip_existing=skip_existing)
    else:
        # --- Non-burst batch: full parallelism, no throttle ---
        if non_burst:
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures = {
                    pool.submit(catalog_dataset, ds, args.dry_run, sharpen, skip_existing, 0): ds
                    for ds in non_burst
                }
                for future in as_completed(futures):
                    ds = futures[future]
                    try:
                        future.result()
                    except Exception as e:
                        log(f'FATAL ERROR: {e}', ds['id'])
                        traceback.print_exc()

        # --- Burst batch: split by year, 1s throttle, all workers ---
        # Order: FGM burst (all MMS), then SCM burst (all MMS), then EDP burst (all MMS)
        burst_order = {'FGM': 0, 'SCM': 1, 'EDP': 2}
        burst.sort(key=lambda ds: (burst_order.get(ds['id'].split('_')[1], 99), ds['id']))
        if burst and sharpen:
            log(f'\n--- Now processing {len(burst)} burst dataset(s) split by year, 1s throttle ---\n')
            for ds in burst:
                catalog_dataset_burst_parallel(ds, args.workers, dry_run=args.dry_run, skip_existing=skip_existing)
        elif burst:
            # No sharpening requested — just do inventory
            for ds in burst:
                catalog_dataset(ds, dry_run=args.dry_run, sharpen=False, skip_existing=skip_existing)

    elapsed = time.time() - start_time
    log(f'\n{"="*60}')
    log(f'All done in {elapsed:.1f}s ({elapsed/60:.1f} min)')

    # Print summary
    if not args.dry_run:
        log(f'\nCatalog files:')
        for p in sorted(CATALOG_DIR.glob('*.json')):
            size = p.stat().st_size
            try:
                with open(p) as f:
                    cat = json.load(f)
                n_int = cat['summary']['total_intervals']
                n_gap = cat['summary']['total_gaps']
                sharp = 'Y' if cat['summary'].get('boundaries_sharpened') else 'N'
                log(f'  {p.name:50s} {size:>10,} bytes  {n_int:>6} intervals  {n_gap:>6} gaps  sharp={sharp}')
            except Exception:
                log(f'  {p.name:50s} {size:>10,} bytes  (read error)')


if __name__ == '__main__':
    main()
