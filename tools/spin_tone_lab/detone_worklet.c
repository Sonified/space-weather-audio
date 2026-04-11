/**
 * detone_worklet.c — WASM notch filter bank for AudioWorklet
 *
 * Manages up to MAX_NOTCHES simultaneous IIR notch filters.
 * Simple and clean — matches the version that sounded perfect on the test page.
 */

#include <math.h>

#define MAX_NOTCHES 16
#define PI 3.14159265358979323846

typedef struct {
    float b0, b1, b2;
    float a1, a2;
    float z1, z2;
    float freq;
    float active;
    int hold;           // samples remaining in hold phase
    float gain;         // 0..1 envelope for release fade
} Notch;

#define HOLD_MS 200
#define RELEASE_MS 100
static int hold_samples = 0;
static float release_coeff = 0.0f;  // per-sample decay toward 0

static Notch notches[MAX_NOTCHES];
static float sample_rate = 44100.0f;
static float notch_q = 40.0f;
static int num_active = 0;

void init(float sr, float q) {
    sample_rate = sr;
    notch_q = q;
    for (int i = 0; i < MAX_NOTCHES; i++) {
        notches[i].b0 = 1.0f; notches[i].b1 = 0.0f; notches[i].b2 = 0.0f;
        notches[i].a1 = 0.0f; notches[i].a2 = 0.0f;
        notches[i].z1 = 0.0f; notches[i].z2 = 0.0f;
        notches[i].freq = 0.0f;
        notches[i].active = 0.0f;
        notches[i].hold = 0;
        notches[i].gain = 0.0f;
    }
    num_active = 0;
    hold_samples = (int)(HOLD_MS * 0.001f * sr);
    release_coeff = 1.0f / (RELEASE_MS * 0.001f * sr);  // linear ramp down
}

static void compute_coeffs(Notch* n, float freq) {
    if (freq <= 0.0f || freq >= sample_rate * 0.5f) {
        n->b0 = 1.0f; n->b1 = 0.0f; n->b2 = 0.0f;
        n->a1 = 0.0f; n->a2 = 0.0f;
        return;
    }
    float w0 = 2.0f * PI * freq / sample_rate;
    float alpha = sinf(w0) / (2.0f * notch_q);
    float a0 = 1.0f + alpha;
    n->b0 = 1.0f / a0;
    n->b1 = -2.0f * cosf(w0) / a0;
    n->b2 = 1.0f / a0;
    n->a1 = -2.0f * cosf(w0) / a0;
    n->a2 = (1.0f - alpha) / a0;
    n->freq = freq;
}

void update_tones(float* freqs, int count) {
    num_active = count < MAX_NOTCHES ? count : MAX_NOTCHES;
    float bin_width = sample_rate / 4096.0f;

    for (int i = 0; i < MAX_NOTCHES; i++) {
        if (i < num_active && freqs[i] > 0.0f && freqs[i] < sample_rate * 0.5f) {
            float f = freqs[i];
            float old_freq = notches[i].freq;
            float delta = fabsf(f - old_freq);
            if (delta > bin_width * 0.25f || notches[i].active == 0.0f) {
                if (delta > bin_width * 2.0f || notches[i].active == 0.0f) {
                    notches[i].z1 = 0.0f;
                    notches[i].z2 = 0.0f;
                }
                compute_coeffs(&notches[i], f);
            }
            notches[i].active = 1.0f;
            notches[i].gain = 1.0f;
            notches[i].hold = hold_samples;
        } else {
            // Don't deactivate yet — hold keeps it alive through brief gaps
            if (notches[i].hold > 0) {
                // Still holding — stay active at current freq
            } else {
                notches[i].active = 0.0f;
                notches[i].freq = 0.0f;
                notches[i].z1 = 0.0f;
                notches[i].z2 = 0.0f;
            }
        }
    }
}

void process(float* samples, int length) {
    for (int n = 0; n < length; n++) {
        float x = samples[n];
        for (int i = 0; i < MAX_NOTCHES; i++) {
            if (notches[i].active == 0.0f && notches[i].gain <= 0.0f) continue;

            // Update hold + gain envelope
            if (notches[i].hold > 0) {
                notches[i].hold--;
                notches[i].gain = 1.0f;  // full notch during hold
            } else if (notches[i].active == 0.0f) {
                // Release: ramp gain down linearly
                notches[i].gain -= release_coeff;
                if (notches[i].gain <= 0.0f) {
                    notches[i].gain = 0.0f;
                    notches[i].z1 = 0.0f;
                    notches[i].z2 = 0.0f;
                    notches[i].freq = 0.0f;
                    continue;
                }
            } else {
                notches[i].gain = 1.0f;
            }

            // Run IIR
            float y = notches[i].b0 * x + notches[i].z1;
            notches[i].z1 = notches[i].b1 * x - notches[i].a1 * y + notches[i].z2;
            notches[i].z2 = notches[i].b2 * x - notches[i].a2 * y;

            // Apply: full notch at gain=1, blend toward passthrough as gain→0
            float g = notches[i].gain;
            x = x + (y - x) * g;
        }
        samples[n] = x;
    }
}

static float tone_input[MAX_NOTCHES];
#define AUDIO_BUF_SIZE 8192
static float audio_buf[AUDIO_BUF_SIZE];

float* get_tone_input_ptr(void) { return tone_input; }
float* get_audio_buf_ptr(void) { return audio_buf; }
int get_audio_buf_size(void) { return AUDIO_BUF_SIZE; }

void process_buf(int length) {
    int len = length < AUDIO_BUF_SIZE ? length : AUDIO_BUF_SIZE;
    process(audio_buf, len);
}

int get_active_count(void) {
    int c = 0;
    for (int i = 0; i < MAX_NOTCHES; i++) {
        if (notches[i].active > 0.0f) c++;
    }
    return c;
}
