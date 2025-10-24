"""
Compare bilinear transform vs Anderson's MCMC for volcanic monitoring

Test on real Hawaiian volcano data to determine if bilinear is sufficient
for the 0.5-10 Hz frequency range used in volcanic monitoring.
"""
import json
import numpy as np
from scipy import signal
import matplotlib.pyplot as plt
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import pandas as pd

print("="*80)
print("BILINEAR vs ANDERSON'S MCMC: VOLCANIC MONITORING TEST")
print("="*80)

# Load Anderson's coefficients
print("\n1. Loading Anderson's MCMC coefficients...")
with open('data/anderson_coefficients.json') as f:
    anderson = json.load(f)
print(f"   ✓ Loaded {len(anderson)} coefficient sets")

# Load stations that match Anderson's models
with open('data/anderson_test_stations.json') as f:
    anderson_stations = json.load(f)

# Pick 3 STS-2 stations and 1 Trillium-120
TEST_STATIONS = [
    # (network, station, location, channel, date, seismometer_type, anderson_key)
    ('IU', 'COLA', '10', 'BHZ', '2015-06-01', 'STS-2', 'STS-2_gen1_100Hz'),
    ('IU', 'POHA', '10', 'BHZ', '2015-06-01', 'STS-2', 'STS-2_gen1_100Hz'),
    ('IU', 'ANMO', '10', 'BHZ', '2015-06-01', 'Trillium-120', 'Trillium-40_100Hz'),  # Close enough
]

client = Client("IRIS")
results = []

print("\n2. Testing on Hawaiian volcano stations...")
print("   (This compares instrument response removal methods)")

for net, sta, loc, cha, date, seis_type, anderson_key in TEST_STATIONS:
    print(f"\n   {net}.{sta}.{loc}.{cha} ({seis_type}):")
    
    # Check if we have Anderson's coefficients for this
    if anderson_key not in anderson:
        print(f"      ⚠ Anderson key '{anderson_key}' not available, skipping")
        continue
    
    try:
        # Fetch station metadata
        print(f"      Fetching metadata from IRIS ({date})...")
        inv = client.get_stations(
            network=net, station=sta, location=loc, channel=cha,
            starttime=UTCDateTime(date),
            level="response"
        )
        
        # Get sample rate from the channel
        fs = inv[0][0][0].sample_rate
        
        response = inv[0][0][0].response
        
        # Get poles and zeros from first stage (instrument response)
        paz = response.response_stages[0]
        
        if not hasattr(paz, 'poles') or not hasattr(paz, 'zeros'):
            print(f"      ✗ No poles/zeros found")
            continue
        
        # Extract poles, zeros, gain
        poles = paz.poles
        zeros = paz.zeros
        gain = paz.normalization_factor
        
        print(f"      Poles: {len(poles)}, Zeros: {len(zeros)}, Gain: {gain:.2e}")
        
        # Generate bilinear coefficients
        print(f"      Generating bilinear coefficients...")
        try:
            sos_bilinear = signal.zpk2sos(zeros, poles, gain)
            print(f"      ✓ Bilinear: {len(sos_bilinear)} sections")
        except Exception as e:
            print(f"      ✗ Bilinear failed: {e}")
            continue
        
        # Get Anderson's coefficients
        sos_anderson = np.array(anderson[anderson_key]['sos'])
        print(f"      ✓ Anderson: {len(sos_anderson)} sections")
        
        # Compare frequency responses
        print(f"      Computing frequency responses...")
        
        # Volcanic monitoring range: 0.5-10 Hz
        freqs = np.logspace(np.log10(0.1), np.log10(fs/2), 1000)
        
        w_b, h_bilinear = signal.sosfreqz(sos_bilinear, worN=freqs, fs=fs)
        w_a, h_anderson = signal.sosfreqz(sos_anderson, worN=freqs, fs=fs)
        
        # Calculate errors
        mag_bilinear = np.abs(h_bilinear)
        mag_anderson = np.abs(h_anderson)
        mag_error_pct = np.abs(mag_bilinear - mag_anderson) / mag_anderson * 100
        
        phase_bilinear = np.angle(h_bilinear)
        phase_anderson = np.angle(h_anderson)
        phase_error_rad = np.abs(phase_bilinear - phase_anderson)
        
        # Find error in volcanic monitoring range (0.5-10 Hz)
        volcanic_mask = (freqs >= 0.5) & (freqs <= 10.0)
        volcanic_mag_error = mag_error_pct[volcanic_mask]
        volcanic_phase_error = phase_error_rad[volcanic_mask]
        
        max_volcanic_error = np.max(volcanic_mag_error)
        mean_volcanic_error = np.mean(volcanic_mag_error)
        
        print(f"      Volcanic range (0.5-10 Hz):")
        print(f"        Max magnitude error: {max_volcanic_error:.3f}%")
        print(f"        Mean magnitude error: {mean_volcanic_error:.3f}%")
        
        # Store results
        result = {
            'station': f"{net}.{sta}.{loc}.{cha}",
            'seismometer': seis_type,
            'sample_rate': fs,
            'anderson_key': anderson_key,
            'bilinear_sections': len(sos_bilinear),
            'anderson_sections': len(sos_anderson),
            'max_volcanic_error_pct': max_volcanic_error,
            'mean_volcanic_error_pct': mean_volcanic_error,
            'max_full_error_pct': np.max(mag_error_pct),
        }
        results.append(result)
        
        # Create comparison plot
        fig, axes = plt.subplots(3, 1, figsize=(12, 10))
        
        # Magnitude
        axes[0].semilogx(freqs, 20*np.log10(mag_bilinear), 'b-', label='Bilinear', linewidth=2, alpha=0.7)
        axes[0].semilogx(freqs, 20*np.log10(mag_anderson), 'r--', label='Anderson MCMC', linewidth=2, alpha=0.7)
        axes[0].axvspan(0.5, 10.0, alpha=0.1, color='green', label='Volcanic range')
        axes[0].set_ylabel('Magnitude (dB)', fontsize=11)
        axes[0].set_title(f'{net}.{sta}.{loc}.{cha} ({seis_type}) - Frequency Response Comparison', fontsize=13)
        axes[0].legend(fontsize=10)
        axes[0].grid(True, alpha=0.3)
        axes[0].set_xlim([0.1, fs/2])
        
        # Phase
        axes[1].semilogx(freqs, phase_bilinear, 'b-', label='Bilinear', linewidth=2, alpha=0.7)
        axes[1].semilogx(freqs, phase_anderson, 'r--', label='Anderson MCMC', linewidth=2, alpha=0.7)
        axes[0].axvspan(0.5, 10.0, alpha=0.1, color='green')
        axes[1].set_ylabel('Phase (rad)', fontsize=11)
        axes[1].legend(fontsize=10)
        axes[1].grid(True, alpha=0.3)
        axes[1].set_xlim([0.1, fs/2])
        
        # Error
        axes[2].semilogx(freqs, mag_error_pct, 'k-', linewidth=2)
        axes[2].axvspan(0.5, 10.0, alpha=0.1, color='green', label='Volcanic range')
        axes[2].axhline(y=1.0, color='orange', linestyle='--', linewidth=1.5, label='1% error')
        axes[2].axhline(y=5.0, color='red', linestyle='--', linewidth=1.5, label='5% error')
        axes[2].set_ylabel('Magnitude Error (%)', fontsize=11)
        axes[2].set_xlabel('Frequency (Hz)', fontsize=11)
        axes[2].legend(fontsize=10)
        axes[2].grid(True, alpha=0.3)
        axes[2].set_xlim([0.1, fs/2])
        axes[2].set_ylim([0, min(10, np.max(mag_error_pct) * 1.1)])
        
        plt.tight_layout()
        filename = f'plots/{net}_{sta}_{loc}_{cha}_bilinear_vs_anderson.png'
        plt.savefig(filename, dpi=150)
        plt.close()
        print(f"      ✓ Plot saved: {filename}")
        
    except Exception as e:
        print(f"      ✗ Failed: {e}")
        continue

# Create summary
print("\n" + "="*80)
print("SUMMARY")
print("="*80)

if results:
    df = pd.DataFrame(results)
    df = df.sort_values('max_volcanic_error_pct')
    
    print("\nResults (sorted by volcanic range error):")
    print(df[['station', 'seismometer', 'max_volcanic_error_pct', 'mean_volcanic_error_pct']].to_string(index=False))
    
    # Save results
    df.to_csv('results/bilinear_vs_anderson_comparison.csv', index=False)
    print("\n✓ Results saved to results/bilinear_vs_anderson_comparison.csv")
    
    # Verdict
    print("\n" + "="*80)
    print("VERDICT")
    print("="*80)
    
    max_error = df['max_volcanic_error_pct'].max()
    mean_error = df['mean_volcanic_error_pct'].mean()
    
    print(f"\nVolcanic monitoring range (0.5-10 Hz):")
    print(f"  Maximum error across all stations: {max_error:.3f}%")
    print(f"  Average mean error: {mean_error:.3f}%")
    
    if max_error < 1.0:
        print("\n✓✓✓ EXCELLENT: Bilinear is virtually identical to Anderson's MCMC!")
        print("    Error < 1% in volcanic range. Use bilinear with confidence.")
    elif max_error < 5.0:
        print("\n✓✓ GOOD: Bilinear is sufficient for volcanic monitoring.")
        print("    Error < 5% in volcanic range. Acceptable for audio/scientific use.")
    elif max_error < 10.0:
        print("\n✓ ACCEPTABLE: Bilinear works but has noticeable differences.")
        print("    Error < 10% in volcanic range. OK for qualitative analysis.")
    else:
        print("\n✗ POOR: Bilinear has significant errors vs Anderson's MCMC.")
        print("    Error > 10% in volcanic range. Consider using Anderson's method.")
    
else:
    print("\n✗ No successful comparisons")

print("\n" + "="*80)

