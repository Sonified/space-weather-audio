#!/usr/bin/env Rscript
# Extract Anderson's pre-calculated coefficients from TDD package
# Extract poles, zeros, gain - will convert to SOS in Python

# Load the data
load("TDD/data/DPZLIST.RData")

# Anderson's 14 seismometers (from TDD documentation)
SEISMOMETERS <- c(
    'STS-1_360s',
    'Trillium-240_gen1',
    'Trillium-240_gen2',
    'CMG-3T',
    'STS-2_gen1',
    'STS-2_gen2',
    'STS-2_gen3',
    'Trillium-120',
    'Compact-Trillium',
    'Trillium-40',
    'CMG-3ESP',
    'CMG-40T_30s',
    'STS-1_20s',
    'CMG-40T_1s'
)

# Sample rates (from TDD documentation)
SAMPLE_RATES <- c(1.0, 10.0, 20.0, 40.0, 50.0, 100.0)

anderson_coefficients <- list()

cat("Extracting Anderson's pre-calculated coefficients...\n")
cat("====================================================\n\n")

for (seis_idx in 1:length(SEISMOMETERS)) {
    seis_name <- SEISMOMETERS[seis_idx]
    cat(sprintf("Seismometer %d: %s\n", seis_idx, seis_name))
    
    for (rate_idx in 1:length(SAMPLE_RATES)) {
        fs <- SAMPLE_RATES[rate_idx]
        key <- sprintf("%s_%.0fHz", seis_name, fs)
        
        cat(sprintf("  Extracting %s...", key))
        
        tryCatch({
            # Get the DPZ object
            dpz <- DPZLIST[[seis_idx]][[rate_idx]]
            
            if (is.null(dpz)) {
                cat(" SKIP (NULL)\n")
                next
            }
            
            # Extract poles, zeros, gain
            zeros <- dpz$Zpg$zero
            poles <- dpz$Zpg$pole
            gain <- dpz$Zpg$gain
            
            # Store in list (will convert to SOS in Python)
            anderson_coefficients[[key]] <- list(
                seismometer = seis_name,
                sample_rate = fs,
                zeros = zeros,
                poles = poles,
                gain = gain,
                method = "anderson_mcmc",
                num_poles = length(poles),
                num_zeros = length(zeros)
            )
            
            cat(sprintf(" ✓ (%d poles, %d zeros)\n", length(poles), length(zeros)))
            
        }, error = function(e) {
            cat(sprintf(" FAILED: %s\n", e$message))
        })
    }
    cat("\n")
}

cat("====================================================\n")
cat(sprintf("Extracted %d coefficient sets\n", length(anderson_coefficients)))
cat("====================================================\n\n")

# Save to RData file (can be loaded by Python via rpy2 or just R)
cat("Saving to data/anderson_coefficients.RData...\n")
save(anderson_coefficients, file = "data/anderson_coefficients.RData")
cat("✓ Saved!\n")

# Also save individual ZPG files (easier for Python to read)
cat("\nSaving individual ZPG files to data/anderson_zpg/...\n")
dir.create("data/anderson_zpg", recursive = TRUE, showWarnings = FALSE)

for (name in names(anderson_coefficients)) {
    coef <- anderson_coefficients[[name]]
    
    # Save poles (real and imaginary parts)
    poles_df <- data.frame(
        real = Re(coef$poles),
        imag = Im(coef$poles)
    )
    filename <- sprintf("data/anderson_zpg/%s_poles.csv", name)
    write.csv(poles_df, filename, row.names = FALSE)
    
    # Save zeros (real and imaginary parts)
    zeros_df <- data.frame(
        real = Re(coef$zeros),
        imag = Im(coef$zeros)
    )
    filename <- sprintf("data/anderson_zpg/%s_zeros.csv", name)
    write.csv(zeros_df, filename, row.names = FALSE)
    
    # Save gain and metadata
    meta_df <- data.frame(
        gain = coef$gain,
        sample_rate = coef$sample_rate,
        num_poles = coef$num_poles,
        num_zeros = coef$num_zeros
    )
    filename <- sprintf("data/anderson_zpg/%s_meta.csv", name)
    write.csv(meta_df, filename, row.names = FALSE)
    
    cat(sprintf("  ✓ %s\n", name))
}
cat("✓ All ZPG files saved!\n")

# Print summary
cat("\nSummary:\n")
for (name in names(anderson_coefficients)) {
    coef <- anderson_coefficients[[name]]
    cat(sprintf("  %s: %d poles, %d zeros, gain=%.2e\n", 
                name, coef$num_poles, coef$num_zeros, coef$gain))
}

