#!/usr/bin/env Rscript
# Load Anderson's pre-calculated MCMC-optimized IIR coefficients
# TDD package includes pre-calculated responses for common seismometers

library(TDD)
library(jsonlite)

cat("===============================================================================\n")
cat("Loading Anderson's Pre-Calculated MCMC-Optimized Coefficients\n")
cat("===============================================================================\n\n")

cat("TDD Package Seismometers:\n")
cat("  Broadband:\n")
cat("    1. Streckeisen STS-1 (360 s)\n")
cat("    4. Guralp CMG-3T\n")
cat("    5. Streckeisen STS-2 (generation 1)\n")
cat("    6. Streckeisen STS-2 (generation 2)\n")
cat("    7. Streckeisen STS-2 (generation 3)\n")
cat("    8. Trillium 120\n")
cat("  Intermediate:\n")
cat("    11. Guralp CMG-3ESP\n")
cat("    12. Guralp CMG-40T (30 s)\n")
cat("\n")

# HV.HLPD.10.HHZ likely uses a Trillium 120 or similar broadband
# For this test, we'll use Trillium 120 (common at Hawaiian Volcano Observatory)
# Seismometer #8, sample rate 0.01s (100 Hz)

seismometer_id <- 8  # Trillium 120
dt <- 0.01  # 100 Hz

cat(sprintf("Selected: Trillium 120 (ID=%d) @ %.2f Hz\n", seismometer_id, 1/dt))
cat("Loading pre-calculated response...\n\n")

# Load pre-calculated discrete response
# GetDPZ returns a list of responses
dpz_list <- GetDPZ(seismometer_id, dt)
DPZ <- dpz_list[[1]]

cat("✓ Loaded pre-calculated MCMC-optimized coefficients!\n\n")

# DPZ contains:
# - Zpg: digital poles/zeros/gain (z-transform)
# - fmax: maximum frequency where response is accurate within 1%
# - dt: sample interval

cat("Response properties:\n")
cat(sprintf("  Sample rate: %.2f Hz\n", 1/DPZ$dt))
cat(sprintf("  Valid up to: %.2f Hz (%.1f%% of Nyquist)\n", 
            DPZ$fmax, DPZ$fmax / (0.5/DPZ$dt) * 100))
cat(sprintf("  Method: Anderson's MCMC optimization\n"))
cat(sprintf("  Poles: %d\n", length(DPZ$Zpg$pole)))
cat(sprintf("  Zeros: %d\n", length(DPZ$Zpg$zero)))
cat(sprintf("  Gain: %.6e\n", DPZ$Zpg$gain))

# Extract z-transform poles/zeros
zpg <- DPZ$Zpg
poles <- zpg$pole
zeros <- zpg$zero
gain <- zpg$gain

# Save as JSON for Python
output <- list(
  poles_real = Re(poles),
  poles_imag = Im(poles),
  zeros_real = Re(zeros),
  zeros_imag = Im(zeros),
  gain = gain,
  sample_rate = 1/dt,
  method = "Anderson MCMC (pre-calculated)",
  fmax = DPZ$fmax,
  seismometer = "Trillium 120"
)

write_json(output, "tests/anderson_mcmc_coefficients.json", 
           auto_unbox = TRUE, pretty = TRUE)

cat("\n✓ Saved coefficients to: tests/anderson_mcmc_coefficients.json\n")
cat("\nNow run: python tests/test_audification_comparison.py\n")
cat("===============================================================================\n")

