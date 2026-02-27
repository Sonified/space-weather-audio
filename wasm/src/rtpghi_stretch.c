/*
 * RTPGHI Stretch — Real-Time Phase Gradient Heap Integration (Prusa et al.)
 * WASM implementation using KissFFT for offline time-stretching.
 *
 * Port of the JavaScript RTPGHIStretcher class.
 */

#include "rtpghi_stretch.h"
#include "kiss_fftr.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif
#define EPS 1e-20f
#define TWO_PI (2.0f * M_PI)

struct RTPGHIPlan {
    int M;
    int bins;        /* M/2 + 1 */
    int hop_div;
    int a_syn;       /* M / hop_div */
    float gamma;
    float tol;
    int phase_mode;
    int window_type;

    /* KissFFT configs */
    kiss_fftr_cfg fft_forward;
    kiss_fftr_cfg fft_inverse;

    /* Window (length M) */
    float* window;

    /* Scratch buffers (reused across frames) */
    kiss_fft_cpx* freq_buf;   /* length bins */
    float* windowed;          /* length M */
    float* syn_frame;         /* length M */
    float* mag;               /* length bins */
    float* log_mag;           /* length bins */
    float* phase_curr;        /* length bins */

    /* Persistent state across frames */
    float* log_mag_prev;      /* length bins */
    float* phase_prev;        /* length bins */
};

/* ===== Memory helpers for JS interop ===== */

void* wasm_malloc(int size) {
    return malloc((size_t)size);
}

void wasm_free(void* ptr) {
    free(ptr);
}

/* ===== Init / Free ===== */

RTPGHIPlan* rtpghi_init(int M, int hop_div, float gamma, float tol,
                        int phase_mode, int window_type)
{
    RTPGHIPlan* p = (RTPGHIPlan*)calloc(1, sizeof(RTPGHIPlan));
    if (!p) return NULL;

    p->M = M;
    p->bins = M / 2 + 1;
    p->hop_div = hop_div;
    p->a_syn = M / hop_div;
    p->gamma = (gamma > 0.0f) ? gamma : (float)M * (float)M * 0.006f;
    p->tol = tol;
    p->phase_mode = phase_mode;
    p->window_type = window_type;

    /* KissFFT configs: forward (inverse_fft=0) and inverse (inverse_fft=1) */
    p->fft_forward = kiss_fftr_alloc(M, 0, NULL, NULL);
    p->fft_inverse = kiss_fftr_alloc(M, 1, NULL, NULL);

    /* Window function */
    p->window = (float*)malloc(M * sizeof(float));
    if (window_type == RTPGHI_WINDOW_HANN) {
        for (int i = 0; i < M; i++) {
            p->window[i] = 0.5f * (1.0f - cosf(TWO_PI * (float)i / (float)M));
        }
    } else {
        /* Gaussian */
        float half = (float)M * 0.5f;
        for (int i = 0; i < M; i++) {
            float t = (float)i - half;
            p->window[i] = expf(-M_PI * t * t / p->gamma);
        }
    }

    /* Allocate scratch and state buffers */
    p->freq_buf     = (kiss_fft_cpx*)malloc(p->bins * sizeof(kiss_fft_cpx));
    p->windowed     = (float*)malloc(M * sizeof(float));
    p->syn_frame    = (float*)malloc(M * sizeof(float));
    p->mag          = (float*)malloc(p->bins * sizeof(float));
    p->log_mag      = (float*)malloc(p->bins * sizeof(float));
    p->phase_curr   = (float*)malloc(p->bins * sizeof(float));
    p->log_mag_prev = (float*)calloc(p->bins, sizeof(float));
    p->phase_prev   = (float*)calloc(p->bins, sizeof(float));

    return p;
}

void rtpghi_free(RTPGHIPlan* plan) {
    if (!plan) return;
    kiss_fftr_free(plan->fft_forward);
    kiss_fftr_free(plan->fft_inverse);
    free(plan->window);
    free(plan->freq_buf);
    free(plan->windowed);
    free(plan->syn_frame);
    free(plan->mag);
    free(plan->log_mag);
    free(plan->phase_curr);
    free(plan->log_mag_prev);
    free(plan->phase_prev);
    free(plan);
}

/* ===== Internal: Analyze Frame ===== */

static void analyze_frame(RTPGHIPlan* p, const float* input, int input_length,
                          float source_pos)
{
    int M = p->M;
    int bins = p->bins;
    float* w = p->windowed;

    /* Extract M samples at fractional position with linear interpolation, apply window */
    for (int i = 0; i < M; i++) {
        float pos = source_pos + (float)i;
        int idx = (int)floorf(pos);
        float frac = pos - (float)idx;
        float sample = 0.0f;
        if (idx >= 0 && idx < input_length - 1) {
            sample = input[idx] * (1.0f - frac) + input[idx + 1] * frac;
        } else if (idx >= 0 && idx < input_length) {
            sample = input[idx];
        }
        w[i] = sample * p->window[i];
    }

    /* Forward real FFT: M real samples -> bins complex */
    kiss_fftr(p->fft_forward, w, p->freq_buf);

    /* Extract magnitude and log-magnitude */
    for (int m = 0; m < bins; m++) {
        float re = p->freq_buf[m].r;
        float im = p->freq_buf[m].i;
        p->mag[m] = sqrtf(re * re + im * im);
        p->log_mag[m] = logf(p->mag[m] + EPS);
    }
}

/* ===== Internal: RTPGHI Phase Update ===== */

static void rtpghi_update(RTPGHIPlan* p)
{
    int bins = p->bins;
    int M = p->M;
    int a_syn = p->a_syn;
    float lambda = p->gamma / ((float)a_syn * (float)M);
    int phase_mode = p->phase_mode;

    float* log_mag_prev = p->log_mag_prev;
    float* log_mag_curr = p->log_mag;
    float* phase_prev = p->phase_prev;
    float* phase_curr = p->phase_curr;

    /* Find magnitude threshold */
    float max_log = -1e30f;
    for (int m = 0; m < bins; m++) {
        if (log_mag_curr[m] > max_log) max_log = log_mag_curr[m];
    }
    float threshold = max_log - p->tol;

    /* Time gradient pathway */
    if (phase_mode == RTPGHI_PHASE_FULL || phase_mode == RTPGHI_PHASE_TIME) {
        for (int m = 0; m < bins; m++) {
            float dLogdW;
            if (m == 0) {
                dLogdW = log_mag_curr[1] - log_mag_curr[0];
            } else if (m == bins - 1) {
                dLogdW = log_mag_curr[bins - 1] - log_mag_curr[bins - 2];
            } else {
                dLogdW = (log_mag_curr[m + 1] - log_mag_curr[m - 1]) * 0.5f;
            }
            float tgrad = dLogdW * lambda + TWO_PI * (float)a_syn * (float)m / (float)M;
            phase_curr[m] = phase_prev[m] + tgrad;
        }
    } else {
        /* zero mode */
        memset(phase_curr, 0, bins * sizeof(float));
    }

    /* Frequency gradient pathway (forward + backward sweeps) */
    if (phase_mode == RTPGHI_PHASE_FULL || phase_mode == RTPGHI_PHASE_FREQ) {
        /* Forward sweep */
        for (int m = 1; m < bins; m++) {
            if (log_mag_curr[m] > threshold && log_mag_curr[m] > log_mag_curr[m - 1]) {
                float dLogdT_m  = log_mag_curr[m]     - log_mag_prev[m];
                float dLogdT_m1 = log_mag_curr[m - 1] - log_mag_prev[m - 1];
                float fgrad = -(dLogdT_m + dLogdT_m1) * 0.5f * lambda;
                phase_curr[m] = phase_curr[m - 1] + fgrad;
            }
        }
        /* Backward sweep */
        for (int m = bins - 2; m >= 0; m--) {
            if (log_mag_curr[m] > threshold && log_mag_curr[m] > log_mag_curr[m + 1]) {
                float dLogdT_m  = log_mag_curr[m]     - log_mag_prev[m];
                float dLogdT_m1 = log_mag_curr[m + 1] - log_mag_prev[m + 1];
                float fgrad = -(dLogdT_m + dLogdT_m1) * 0.5f * lambda;
                phase_curr[m] = phase_curr[m + 1] - fgrad;
            }
        }
    }
}

/* ===== Internal: Synthesize Frame ===== */

static void synthesize_frame(RTPGHIPlan* p)
{
    int M = p->M;
    int bins = p->bins;

    /* Reconstruct complex spectrum from magnitude + phase */
    for (int m = 0; m < bins; m++) {
        p->freq_buf[m].r = p->mag[m] * cosf(p->phase_curr[m]);
        p->freq_buf[m].i = p->mag[m] * sinf(p->phase_curr[m]);
    }

    /* Inverse real FFT: bins complex -> M real samples */
    kiss_fftri(p->fft_inverse, p->freq_buf, p->syn_frame);

    /* kiss_fftri does NOT normalize — divide by M */
    float inv_M = 1.0f / (float)M;
    for (int i = 0; i < M; i++) {
        p->syn_frame[i] *= inv_M;
    }

    /* Apply synthesis window */
    for (int i = 0; i < M; i++) {
        p->syn_frame[i] *= p->window[i];
    }
}

/* ===== Output Length Query ===== */

int rtpghi_output_length(int input_length, int M, int hop_div, float stretch_factor)
{
    int a_syn = M / hop_div;
    float a_ana = (float)a_syn / stretch_factor;
    int num_frames = (int)floorf((float)(input_length - M) / a_ana) + 1;
    if (num_frames < 1) return 0;
    int output_pos = num_frames * a_syn;
    int raw_length = output_pos + M;
    int trim_start = M / 2;
    int trim_end = output_pos + M / 2;
    if (trim_end > raw_length) trim_end = raw_length;
    return trim_end - trim_start;
}

/* ===== Block Stretch ===== */

int rtpghi_stretch_block(RTPGHIPlan* p, const float* input, int input_length,
                         float* output, int max_output_length, float stretch_factor)
{
    int M = p->M;
    int a_syn = p->a_syn;
    float a_ana = (float)a_syn / stretch_factor;
    int bins = p->bins;

    int num_frames = (int)floorf((float)(input_length - M) / a_ana) + 1;
    if (num_frames < 1) return 0;

    int output_length = num_frames * a_syn + M;
    if (output_length > max_output_length) output_length = max_output_length;

    /* Zero output buffer */
    memset(output, 0, output_length * sizeof(float));

    /* Window sum buffer for normalization */
    float* window_sum = (float*)calloc(output_length, sizeof(float));
    if (!window_sum) return 0;

    /* Reset persistent phase state */
    memset(p->phase_prev, 0, bins * sizeof(float));
    memset(p->log_mag_prev, 0, bins * sizeof(float));

    /* Initialize with first frame's log_mag */
    analyze_frame(p, input, input_length, 0.0f);
    memcpy(p->log_mag_prev, p->log_mag, bins * sizeof(float));

    float source_pos = 0.0f;
    int output_pos = 0;

    for (int frame = 0; frame < num_frames; frame++) {
        /* Analyze current frame */
        analyze_frame(p, input, input_length, source_pos);

        /* RTPGHI phase reconstruction */
        rtpghi_update(p);

        /* Synthesize output frame */
        synthesize_frame(p);

        /* Overlap-add */
        for (int i = 0; i < M && (output_pos + i) < output_length; i++) {
            output[output_pos + i] += p->syn_frame[i];
            window_sum[output_pos + i] += p->window[i] * p->window[i];
        }

        /* Save state for next frame */
        memcpy(p->log_mag_prev, p->log_mag, bins * sizeof(float));
        memcpy(p->phase_prev, p->phase_curr, bins * sizeof(float));

        source_pos += a_ana;
        output_pos += a_syn;
    }

    /* Normalize by window overlap */
    for (int i = 0; i < output_length; i++) {
        if (window_sum[i] > 1e-8f) output[i] /= window_sum[i];
    }

    free(window_sum);

    /* Trim edges (M/2 from start) */
    int trim_start = M / 2;
    int trim_end = output_pos + M / 2;
    if (trim_end > output_length) trim_end = output_length;
    int trimmed_length = trim_end - trim_start;
    if (trimmed_length <= 0) return 0;

    /* Shift trimmed data to beginning of output buffer */
    memmove(output, output + trim_start, trimmed_length * sizeof(float));

    return trimmed_length;
}
