/**
 * spectrogram_fft.c
 * Custom WASM wrapper around KissFFT for batched spectrogram computation.
 * Performs windowing + FFT + magnitude extraction in a single WASM call,
 * eliminating per-slice JS↔WASM boundary crossings.
 *
 * Compiled with Emscripten: see wasm/build.sh
 * KissFFT is BSD-3-Clause licensed.
 */

#include "kiss_fftr.h"
#include <math.h>
#include <stdlib.h>
#include <emscripten.h>

/* ─── Cached FFT state ──────────────────────────────────────────────────── */

static kiss_fftr_cfg fft_cfg = NULL;
static int current_fft_size = 0;
static kiss_fft_cpx *fft_output = NULL;  /* (N/2+1) complex bins */

/**
 * Initialize (or reinitialize) FFT state for a given size.
 * Called automatically by processing functions when size changes.
 */
static void ensure_fft_state(int fft_size) {
    if (current_fft_size == fft_size) return;

    if (fft_cfg) {
        kiss_fft_free(fft_cfg);
        free(fft_output);
    }

    fft_cfg = kiss_fftr_alloc(fft_size, 0, NULL, NULL);
    fft_output = (kiss_fft_cpx *)malloc((fft_size / 2 + 1) * sizeof(kiss_fft_cpx));
    current_fft_size = fft_size;
}

/* ─── Single FFT: window + FFT + magnitudes ─────────────────────────────── */

/**
 * Perform a single real-valued FFT with Hann windowing and magnitude extraction.
 *
 * @param signal      Input audio samples (length = fft_size)
 * @param window      Hann window coefficients (length = fft_size)
 * @param magnitudes  Output magnitude buffer (length = fft_size/2), normalized by N
 * @param fft_size    FFT size (must be even, power of 2 recommended)
 * @param windowed    Scratch buffer for windowed signal (length = fft_size)
 */
EMSCRIPTEN_KEEPALIVE
void fft_single(const float *signal, const float *window,
                float *magnitudes, int fft_size, float *windowed) {
    ensure_fft_state(fft_size);

    const int half_n = fft_size / 2;
    const float inv_n = 1.0f / (float)fft_size;

    /* Apply Hann window */
    for (int i = 0; i < fft_size; i++) {
        windowed[i] = signal[i] * window[i];
    }

    /* Real FFT → (N/2+1) complex bins */
    kiss_fftr(fft_cfg, windowed, fft_output);

    /* Extract magnitudes, normalized by N */
    for (int k = 0; k < half_n; k++) {
        float re = fft_output[k].r;
        float im = fft_output[k].i;
        magnitudes[k] = sqrtf(re * re + im * im) * inv_n;
    }
}

/* ─── Batch FFT: process entire tile in one call ────────────────────────── */

/**
 * Process an entire spectrogram tile: windowing + FFT + magnitude extraction
 * for all time slices in a single WASM call.
 *
 * Output layout (row-major, frequency-major):
 *   magnitudes[bin * num_slices + col] = magnitude at (time=col, freq=bin)
 *
 * This matches the GPU texture layout expected by the Three.js renderer.
 *
 * @param audio_data    Raw audio samples for the tile
 * @param window        Pre-computed Hann window (length = fft_size)
 * @param magnitudes    Output Float32 magnitudes (length = num_slices * freq_bins)
 * @param fft_size      FFT size
 * @param hop_size      Samples between consecutive windows
 * @param num_slices    Number of time slices (columns)
 */
EMSCRIPTEN_KEEPALIVE
void fft_batch_magnitudes(const float *audio_data, const float *window,
                          float *magnitudes,
                          int fft_size, int hop_size, int num_slices) {
    ensure_fft_state(fft_size);

    const int freq_bins = fft_size / 2;
    const float inv_n = 1.0f / (float)fft_size;

    /* Scratch buffer for windowed signal */
    float *windowed = (float *)malloc(fft_size * sizeof(float));

    for (int col = 0; col < num_slices; col++) {
        const float *slice = audio_data + col * hop_size;

        /* Apply Hann window */
        for (int i = 0; i < fft_size; i++) {
            windowed[i] = slice[i] * window[i];
        }

        /* Real FFT */
        kiss_fftr(fft_cfg, windowed, fft_output);

        /* Extract magnitudes in row-major (frequency-major) layout */
        for (int bin = 0; bin < freq_bins; bin++) {
            float re = fft_output[bin].r;
            float im = fft_output[bin].i;
            magnitudes[bin * num_slices + col] = sqrtf(re * re + im * im) * inv_n;
        }
    }

    free(windowed);
}

/**
 * Process an entire tile and output Uint8 magnitudes using dB-scale LUT.
 * Combines windowing + FFT + magnitude + dB conversion in one WASM call.
 *
 * Uses the same IEEE 754 bit-trick LUT approach as the JS path:
 * top 16 bits of float32 magnitude → lookup table → uint8 value.
 *
 * @param audio_data      Raw audio samples for the tile
 * @param window          Pre-computed Hann window (length = fft_size)
 * @param output_uint8    Output Uint8 magnitudes (length = num_slices * freq_bins)
 * @param lut             Pre-built magnitude→uint8 LUT (65536 entries)
 * @param fft_size        FFT size
 * @param hop_size        Samples between consecutive windows
 * @param num_slices      Number of time slices
 */
EMSCRIPTEN_KEEPALIVE
void fft_batch_uint8(const float *audio_data, const float *window,
                     unsigned char *output_uint8, const unsigned char *lut,
                     int fft_size, int hop_size, int num_slices) {
    ensure_fft_state(fft_size);

    const int freq_bins = fft_size / 2;
    const float inv_n = 1.0f / (float)fft_size;

    /* Scratch buffer */
    float *windowed = (float *)malloc(fft_size * sizeof(float));

    /* Union for IEEE 754 bit extraction */
    union { float f; unsigned int u; } converter;

    for (int col = 0; col < num_slices; col++) {
        const float *slice = audio_data + col * hop_size;

        /* Apply Hann window */
        for (int i = 0; i < fft_size; i++) {
            windowed[i] = slice[i] * window[i];
        }

        /* Real FFT */
        kiss_fftr(fft_cfg, windowed, fft_output);

        /* Extract magnitudes and convert to uint8 via LUT */
        for (int bin = 0; bin < freq_bins; bin++) {
            float re = fft_output[bin].r;
            float im = fft_output[bin].i;
            float mag = sqrtf(re * re + im * im) * inv_n;

            converter.f = mag;
            unsigned int lut_index = converter.u >> 16;
            output_uint8[bin * num_slices + col] = lut[lut_index];
        }
    }

    free(windowed);
}

/* ─── Utility: generate Hann window ─────────────────────────────────────── */

/**
 * Fill a buffer with Hann window coefficients.
 * Avoids repeated computation on the JS side.
 */
EMSCRIPTEN_KEEPALIVE
void generate_hann_window(float *window, int size) {
    const float two_pi_over_n = 2.0f * 3.14159265358979323846f / (float)size;
    for (int i = 0; i < size; i++) {
        window[i] = 0.5f * (1.0f - cosf(two_pi_over_n * (float)i));
    }
}

/* ─── Memory management helpers for JS ──────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
void *wasm_malloc(int size) {
    return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void wasm_free(void *ptr) {
    free(ptr);
}
