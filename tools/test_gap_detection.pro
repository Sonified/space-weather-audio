; ============================================================================
; test_gap_detection.pro — Standalone test of the DATAINTERVAL= patch
; Tests the exact gap detection algorithm from patched audio_wav.pro
; against PSP cruise epoch data (85660 TT2000 records with known gaps).
; ============================================================================

PRO test_gap_detection

    bin_file = FILE_DIRNAME(ROUTINE_FILEPATH()) + $
        '/gap_test_wavs/epoch_psp_cruise.bin'

    PRINT, '================================================================'
    PRINT, 'GAP DETECTION PATCH TEST — GDL'
    PRINT, '================================================================'
    PRINT, 'Epoch binary: ', bin_file

    IF  ~FILE_TEST(bin_file) THEN BEGIN
        PRINT, 'ERROR: Binary file not found!'
        RETURN
    ENDIF

    ; Read raw int64 epoch array
    buf_sz = FILE_LINES(bin_file)  ; won't work for binary
    info = FILE_INFO(bin_file)
    buf_sz = info.SIZE / 8L   ; 8 bytes per int64
    PRINT, 'Records: ', buf_sz

    mytime = LON64ARR(buf_sz)
    OPENR, lun, bin_file, /GET_LUN
    READU, lun, mytime
    FREE_LUN, lun

    PRINT, 'First epoch: ', mytime[0]
    PRINT, 'Last epoch:  ', mytime[buf_sz-1]

    ; =================================================================
    ; THIS IS THE EXACT CODE FROM THE PATCH (audio_wav.pro lines 540-620)
    ; =================================================================

    n_intervals = 0L

    IF  buf_sz gt 1 THEN BEGIN

        ; Compute time differences
        time_diffs = mytime [1:*] - mytime [0:-2]

        ; Median cadence
        med_cadence = MEDIAN (time_diffs)

        ; Gap threshold: 2x median
        gap_threshold = 2.0D0 * med_cadence

        ; Find gap positions
        gap_idx = WHERE (time_diffs gt gap_threshold, n_gaps)

        ; Build interval list
        n_intervals = n_gaps + 1

        interval_start_epoch = LON64ARR (n_intervals)
        interval_end_epoch   = LON64ARR (n_intervals)
        interval_samples     = LONARR (n_intervals)
        interval_cadence     = DBLARR (n_intervals)

        blk_start = 0L

        FOR blk = 0, n_intervals - 1 DO BEGIN

            IF  blk lt n_gaps THEN blk_end = gap_idx [blk] $
            ELSE blk_end = buf_sz - 1

            interval_start_epoch [blk] = mytime [blk_start]
            interval_end_epoch [blk]   = mytime [blk_end]
            interval_samples [blk]     = blk_end - blk_start + 1

            IF  blk_end gt blk_start THEN BEGIN
                blk_diffs = mytime [blk_start+1:blk_end] - mytime [blk_start:blk_end-1]
                interval_cadence [blk] = MEDIAN (blk_diffs)
            ENDIF ELSE BEGIN
                interval_cadence [blk] = med_cadence
            ENDELSE

            blk_start = blk_end + 1

        ENDFOR

    ENDIF ELSE BEGIN

        n_intervals = 1
        interval_start_epoch = [mytime [0]]
        interval_end_epoch   = [mytime [0]]
        interval_samples     = [1L]
        interval_cadence     = [0.0D0]

    ENDELSE

    ; Print DataIntervals (the STDOUT output)
    PRINT, ''
    PRINT, 'DATAINTERVAL= STDOUT output:'
    PRINT, '-----------------------------'
    FOR blk = 0, n_intervals - 1 DO BEGIN
        PRINT, 'DATAINTERVAL=', $
            STRTRIM (STRING (interval_start_epoch [blk]), 2), ',', $
            STRTRIM (STRING (interval_end_epoch [blk]), 2), ',', $
            STRTRIM (STRING (interval_samples [blk]), 2), ',', $
            STRTRIM (STRING (interval_cadence [blk], FORMAT='(D0.6)'), 2), $
            FORMAT='(A,A,A,A,A,A,A,A)'
    ENDFOR

    ; =================================================================
    ; VERIFICATION
    ; =================================================================
    PRINT, ''
    PRINT, 'VERIFICATION:'
    PRINT, '-----------------------------'
    PRINT, 'Intervals found: ', n_intervals

    total_samples = LONG(TOTAL(interval_samples))
    PRINT, 'Total samples:   ', total_samples
    PRINT, 'CDF records:     ', buf_sz

    IF  total_samples eq buf_sz THEN BEGIN
        PRINT, 'Sample count:    PASS (exact match)'
    ENDIF ELSE BEGIN
        PRINT, 'Sample count:    FAIL (mismatch: ', total_samples - buf_sz, ')'
    ENDELSE

    ; Expected values from Python validation
    PRINT, ''
    PRINT, 'Cross-check vs Python:'
    PRINT, '  Python found 3 intervals with epochs:'
    PRINT, '    [0] 631108869193929600 - 631116268114105088  (67740 samples)'
    PRINT, '    [1] 631148066755966464 - 631148073732819968  (512 samples)'
    PRINT, '    [2] 631148075494003712 - 631149878928804352  (17408 samples)'

    ; Check interval 0
    IF  n_intervals ge 1 THEN BEGIN
        IF  interval_start_epoch[0] eq 631108869193929600LL AND $
            interval_samples[0] eq 67740L THEN BEGIN
            PRINT, '  Block 0: MATCH'
        ENDIF ELSE BEGIN
            PRINT, '  Block 0: MISMATCH'
            PRINT, '    Got start=', interval_start_epoch[0], ' samples=', interval_samples[0]
        ENDELSE
    ENDIF

    IF  n_intervals ge 3 THEN BEGIN
        IF  interval_samples[1] eq 512L AND interval_samples[2] eq 17408L THEN BEGIN
            PRINT, '  Block 1: MATCH'
            PRINT, '  Block 2: MATCH'
        ENDIF ELSE BEGIN
            PRINT, '  Block 1: samples=', interval_samples[1], ' (expected 512)'
            PRINT, '  Block 2: samples=', interval_samples[2], ' (expected 17408)'
        ENDELSE
    ENDIF

    ; Gap durations
    IF  n_intervals gt 1 THEN BEGIN
        PRINT, ''
        PRINT, 'Gap details:'
        FOR i = 0, n_intervals - 2 DO BEGIN
            gap_ns = interval_start_epoch[i+1] - interval_end_epoch[i]
            gap_sec = DOUBLE(gap_ns) / 1.0D9
            gap_hr = gap_sec / 3600.0D0
            PRINT, FORMAT='("  Gap after block ",I0,": ",F0.1,"s (",F0.2,"h)")', $
                i, gap_sec, gap_hr
        ENDFOR
    ENDIF

    PRINT, ''
    PRINT, '================================================================'
    IF  total_samples eq buf_sz AND n_intervals eq 3 THEN BEGIN
        PRINT, 'RESULT: ALL CHECKS PASSED — IDL patch verified in GDL'
    ENDIF ELSE IF total_samples eq buf_sz THEN BEGIN
        PRINT, 'RESULT: SAMPLE COUNT OK but interval count unexpected'
    ENDIF ELSE BEGIN
        PRINT, 'RESULT: FAILED'
    ENDELSE
    PRINT, '================================================================'

END
