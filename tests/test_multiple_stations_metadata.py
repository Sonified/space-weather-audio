"""
Test script to examine raw metadata and forward responses 
from multiple seismic stations across different volcanoes
"""

from obspy.clients.fdsn import Client
from scipy import signal
import numpy as np
from datetime import datetime, timedelta

# Stations to test
stations = [
    # Kilauea (3 stations)
    {"net": "HV", "sta": "OBL", "loc": "", "cha": "HHZ", "volcano": "Kilauea"},
    {"net": "HV", "sta": "NPT", "loc": "01", "cha": "HHZ", "volcano": "Kilauea"},
    {"net": "HV", "sta": "UWE", "loc": "01", "cha": "HHZ", "volcano": "Kilauea"},
    
    # Shishaldin
    {"net": "AV", "sta": "SSLN", "loc": "", "cha": "BHZ", "volcano": "Shishaldin"},
    
    # Spurr
    {"net": "AV", "sta": "SPCN", "loc": "", "cha": "BHZ", "volcano": "Spurr"},
    
    # Mauna Loa
    {"net": "HV", "sta": "MLOD", "loc": "10", "cha": "HHZ", "volcano": "Mauna Loa"},
    
    # Great Sitkin
    {"net": "AV", "sta": "GSTD", "loc": "", "cha": "BHZ", "volcano": "Great Sitkin"},
    
    # Add a few more for good measure
    {"net": "AV", "sta": "PS1A", "loc": "", "cha": "BHZ", "volcano": "Makushin"},
    {"net": "AV", "sta": "OKRE", "loc": "", "cha": "BHZ", "volcano": "Okmok"},
    {"net": "HV", "sta": "DEVL", "loc": "01", "cha": "HHZ", "volcano": "Kilauea"},
]

def analyze_station(net, sta, loc, cha, volcano):
    """Analyze one station's metadata and forward response"""
    
    print("\n" + "="*80)
    print(f"VOLCANO: {volcano}")
    print(f"STATION: {net}.{sta}.{loc}.{cha}")
    print("="*80)
    
    try:
        client = Client("IRIS")
        
        # Get response metadata (use recent time to ensure data exists)
        end_time = datetime.utcnow() - timedelta(days=1)
        start_time = end_time - timedelta(hours=1)
        
        inventory = client.get_stations(
            network=net, station=sta, location=loc, channel=cha,
            starttime=start_time, level="response"
        )
        
        response = inventory[0][0][0].response
        
        # Print stage information
        print(f"\n=== Response has {len(response.response_stages)} stages ===")
        for i, s in enumerate(response.response_stages):
            stage_type = type(s).__name__
            gain = s.stage_gain if hasattr(s, 'stage_gain') else 'N/A'
            print(f"  Stage {i+1}: {stage_type} - Gain: {gain}")
        
        # Overall sensitivity
        print(f"\nOverall instrument sensitivity: {response.instrument_sensitivity.value:.6e}")
        print(f"Input units: {response.instrument_sensitivity.input_units}")
        print(f"Output units: {response.instrument_sensitivity.output_units}")
        
        # Stage 1 (usually the seismometer)
        stage = response.response_stages[0]
        
        # Check if it has poles/zeros
        if not hasattr(stage, 'poles') or not hasattr(stage, 'zeros'):
            print("\n⚠️  Stage 1 does not have poles/zeros (not an analog response stage)")
            return
        
        poles = np.array([complex(p.real, p.imag) for p in stage.poles])
        zeros = np.array([complex(z.real, z.imag) for z in stage.zeros])
        stage_gain = stage.stage_gain
        A0 = stage.normalization_factor
        
        print(f"\n=== RAW METADATA VALUES (Stage 1) ===")
        print(f"Gain (stage_gain): {stage_gain:.6e}")
        print(f"Normalization factor (A0): {A0:.6e}")
        print(f"Poles: {len(poles)}, Zeros: {len(zeros)}")
        
        # Print poles (abbreviated if many)
        print(f"\nPOLES ({len(poles)}):")
        for i, p in enumerate(poles[:5]):  # Show first 5
            print(f"  {i+1}. {p.real:+.6e} {p.imag:+.6e}j")
        if len(poles) > 5:
            print(f"  ... ({len(poles)-5} more)")
        
        # Print zeros (abbreviated if many)
        print(f"\nZEROS ({len(zeros)}):")
        for i, z in enumerate(zeros[:5]):  # Show first 5
            print(f"  {i+1}. {z.real:+.6e} {z.imag:+.6e}j")
        if len(zeros) > 5:
            print(f"  ... ({len(zeros)-5} more)")
        
        # Check for zeros at origin
        zeros_at_origin = sum(1 for z in zeros if abs(z) < 1e-6)
        if zeros_at_origin > 0:
            print(f"\n⚠️  Has {zeros_at_origin} zero(s) at origin (0+0j) - blocks DC")
        
        # Compute forward frequency response
        print(f"\n=== FORWARD Instrument Response (Stage 1 only) ===")
        w_forward, h_forward = signal.freqs_zpk(zeros, poles, A0, worN=2048)
        freq_forward = w_forward / (2 * np.pi)
        
        test_freqs = [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 20.0]
        for f in test_freqs:
            idx = np.argmin(np.abs(freq_forward - f))
            gain_db = 20 * np.log10(np.abs(h_forward[idx]))
            print(f"  {f:6.2f} Hz: {gain_db:8.1f} dB")
        
        # Find where response is "flat" (within 1 dB of maximum)
        gain_db_all = 20 * np.log10(np.abs(h_forward))
        max_gain_db = np.max(gain_db_all[freq_forward < 30])  # Below 30 Hz
        flat_mask = np.abs(gain_db_all - max_gain_db) < 1.0
        flat_freqs = freq_forward[flat_mask]
        if len(flat_freqs) > 0:
            flat_start = flat_freqs[0]
            flat_end = flat_freqs[-1]
            print(f"\nFlat passband (±1 dB): ~{flat_start:.3f} Hz to ~{flat_end:.1f} Hz")
        
    except Exception as e:
        print(f"\n❌ ERROR: {e}")

if __name__ == "__main__":
    print("="*80)
    print("MULTI-STATION METADATA ANALYSIS")
    print("Examining raw metadata and forward responses across volcanoes")
    print("="*80)
    
    for station in stations:
        try:
            analyze_station(
                station["net"],
                station["sta"],
                station["loc"],
                station["cha"],
                station["volcano"]
            )
        except KeyboardInterrupt:
            print("\n\nInterrupted by user")
            break
        except Exception as e:
            print(f"\n❌ Failed to analyze {station}: {e}")
    
    print("\n" + "="*80)
    print("ANALYSIS COMPLETE")
    print("="*80)



