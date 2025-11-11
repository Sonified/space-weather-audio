"""
Extract TDD package data WITHOUT installing R package
Download from CRAN archive and load data files directly
"""
import urllib.request
import tarfile
import os
import rpy2.robjects as ro

print("="*80)
print("EXTRACTING ANDERSON'S TDD DATA")
print("="*80)

# Set R_HOME explicitly
os.environ['R_HOME'] = '/opt/anaconda3/lib/R'

# Download TDD source package
url = "https://cran.r-project.org/src/contrib/Archive/TDD/TDD_0.4.tar.gz"
tarball = "TDD_0.4.tar.gz"

print("\n1. Downloading TDD package from CRAN archive...")
print(f"   URL: {url}")
urllib.request.urlretrieve(url, tarball)
print(f"   ✓ Downloaded: {tarball}")

print("\n2. Extracting tarball...")
with tarfile.open(tarball, "r:gz") as tar:
    tar.extractall()
print("   ✓ Extracted to: TDD/")

print("\n3. Loading data files into R environment...")
# The data files are in TDD/data/
ro.r('load("TDD/data/DPZLIST.rda")')
ro.r('load("TDD/data/PZLIST.rda")')
print("   ✓ Loaded DPZLIST.rda")
print("   ✓ Loaded PZLIST.rda")

print("\n4. Loading signal library...")
ro.r('library(signal)')
print("   ✓ signal library loaded")

print("\n5. Testing data access...")
# Check structure
print("\nDPZLIST structure:")
print("  - Number of seismometers:", len(ro.r('DPZLIST')))
print("  - Sample rates per seismometer:", len(ro.r('DPZLIST[[1]]')))

# Test: Extract CMG-40T (index 12) at 100 Hz (index 6)
print("\n6. Testing coefficient extraction (CMG-40T @ 100 Hz)...")
test = ro.r('''
zpk2sos(
    DPZLIST[[12]][[6]]$Zpg$zero,
    DPZLIST[[12]][[6]]$Zpg$pole,
    DPZLIST[[12]][[6]]$Zpg$gain
)
''')

print(f"   ✓ Extracted SOS matrix shape: {test.shape}")
print(f"   ✓ Number of biquad sections: {test.shape[0]}")

print("\n" + "="*80)
print("SUCCESS! TDD data is loaded and ready to use")
print("="*80)
print("\nYou can now run the full extraction script to get all coefficients.")


