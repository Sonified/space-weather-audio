#ifndef RTPGHI_STRETCH_H
#define RTPGHI_STRETCH_H

#include <emscripten.h>

/* Phase mode constants */
#define RTPGHI_PHASE_FULL  0
#define RTPGHI_PHASE_TIME  1
#define RTPGHI_PHASE_FREQ  2
#define RTPGHI_PHASE_ZERO  3

/* Window type constants */
#define RTPGHI_WINDOW_GAUSS 0
#define RTPGHI_WINDOW_HANN  1

/* Opaque plan handle */
typedef struct RTPGHIPlan RTPGHIPlan;

/* Initialize plan with given parameters. Returns plan pointer. */
EMSCRIPTEN_KEEPALIVE
RTPGHIPlan* rtpghi_init(int M, int hop_div, float gamma, float tol,
                        int phase_mode, int window_type);

/* Free plan and all associated memory. */
EMSCRIPTEN_KEEPALIVE
void rtpghi_free(RTPGHIPlan* plan);

/* Query output length for given parameters (call before allocating output buffer). */
EMSCRIPTEN_KEEPALIVE
int rtpghi_output_length(int input_length, int M, int hop_div, float stretch_factor);

/* Full block stretch. Returns actual number of output samples written. */
EMSCRIPTEN_KEEPALIVE
int rtpghi_stretch_block(RTPGHIPlan* plan, const float* input, int input_length,
                         float* output, int max_output_length, float stretch_factor);

/* Streaming (chunked) stretch API — for async processing with progress */
EMSCRIPTEN_KEEPALIVE
int rtpghi_begin_stretch(RTPGHIPlan* plan, const float* input, int input_length,
                         float* output, int max_output_length, float stretch_factor);

EMSCRIPTEN_KEEPALIVE
int rtpghi_process_frames(RTPGHIPlan* plan, int max_frames);

EMSCRIPTEN_KEEPALIVE
int rtpghi_finish_stretch(RTPGHIPlan* plan);

/* Memory helpers for JS interop */
EMSCRIPTEN_KEEPALIVE void* wasm_malloc(int size);
EMSCRIPTEN_KEEPALIVE void  wasm_free(void* ptr);

#endif /* RTPGHI_STRETCH_H */
