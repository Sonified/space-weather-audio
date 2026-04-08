FUNCTION parse_display_attribute, buf, indlst, varlst

n_terms = 0

WHILE 1 DO BEGIN
       
    ; Check to make sure the term has the following form:
    ; y=varname[(t0,t1,..tn)]
    ; No Z terms.  Were not doing spectagrams !!
    ; IF STREGEX (terms [i], 'y=([a-zA-Z0-9]+)

    pos = STREGEX (buf, '^y=([a-zA-Z_0-9]+)', LENGTH=len, /SUBEXPR)
    
    ; Break out of the loop any errors
    IF pos [0] eq -1 THEN RETURN, 0

    ; Get the name of the variable to index
    var = STRMID (buf, pos [1], len [1])

    ; Eat the buf
    buf = STRMID (buf, len [0])

    ; Make sure buf is not used up. Otherwise quit.
    IF ~ buf THEN RETURN, 0

    ; Check to make sure the next character is a '('.  If it is then eat it.
    c = STRMID (buf, 0, 1)

    IF c ne '(' THEN RETURN, 0

    buf = STRMID (buf, 1)

    ; Make sure buf is not used up. Otherwise quit.
    IF ~ buf THEN RETURN, 0

    ind = INTARR (3)
    
    ind [*] = -1

    in = 0

    ; Get all indexes.  Max is 3.
    FOR cnt = 0, 2 DO BEGIN 

        ; Try to read a number
        pos = STREGEX (buf, '^[0-9]+', LENGTH=len)

        ; Check for success
        IF pos [0] eq -1 THEN RETURN, 0

        ; Read the index
        READS, STRMID (buf, 0, len), in

        ind [cnt] = in

        ; Eat the number
        buf = STRMID (buf, len)

        ; Make sure buf is not used up. Otherwise quit.
        IF ~ buf THEN RETURN, 0 

        ; Check if the next character is a comma.  If it's not then break
        ; out of the loop.
        c = STRMID (buf, 0, 1)

        IF c ne ',' THEN BREAK

        ; Eat the comma
        buf = STRMID (buf, 1)

        ; Make sure buf is not used up. Otherwise quit.
        IF ~ buf THEN RETURN, 0

    ENDFOR

    ; Check if the next character is a ')'.  If it is, then eat it.
    c = STRMID (buf, 0, 1)

    IF c ne ')' THEN RETURN, 0

    buf = STRMID (buf, 1)

    ; Made it to here.  Add what we found to variable and index arrays.   
    varlst = [varlst, var]
    indlst = [indlst, [[ind [0]], [ind [1]], [ind [2]]]]

    n_terms = n_terms + 1

    ; Check if there is any more input to parse.  
    ; If buf is empty then we are done.
    IF ~ buf THEN BREAK
    
    ; Check if the next character is a ','.  If it is, then eat it.
    ; Alas we have more work to do.
    c = STRMID (buf, 0, 1)

    IF c ne ',' THEN RETURN, 0

    buf = STRMID (buf, 1)

ENDWHILE

RETURN, n_terms

END

PRO interpolate_audio_data, data, findex, i0, i1

    n_data = N_ELEMENTS (data)

    CASE 1 OF
        
        (findex [i0] eq 0) : data [0:findex[i1]] = data [findex[i1]+1]


        (findex [i1] eq (n_data-1) ) : data [findex [i0]:n_data-1] = data [findex[i0]-1]

        ELSE : BEGIN

                delta_x  = i1 - i0 + 2
                x0 = findex[i0]-1
                y0 = data [x0]
                y1 = data [findex[i1]+1]
                
                FOR i = 1, delta_x - 1 DO BEGIN
                    y = (y0 * (delta_x - i) + y1 * i) / delta_x 

                    data [x0 + i] = y
                END

            END
    ENDCASE

END

FUNCTION AUDIO_WAV, astruct, vname, RANGE=range, GIF=gif, REDUCE_ALL=reduce, VECTOR_AUDIO=vec_audio, $
                   TSTART=TSTART, TSTOP=TSTOP, REPORT=reportflag, DEBUG=debugflag


; Set report flag to a default value if not passed.
IF keyword_set (reportflag) THEN reportflag=1L ELSE reportflag=0L

; Set the reduce flag to a default value if not passed.
IF keyword_set (reduce) THEN reduce = 1 ELSE reduce = 0

; Set the vec_audio flag to a d default value if not passed.
IF keyword_set (vec_audio) THEN vec_audio = 1 ELSE vec_audio = 0

; Determine the field number associated with the variable 'vname'
w = WHERE(tag_names(astruct) eq strupcase(vname),wc)
IF (wc eq 0) THEN BEGIN
  print,'ERROR=No variable with the name:',vname,' in param 1!' & RETURN,-1
ENDIF ELSE vnum = w[0]

; Verify the type of the first parameter and retrieve the data
a = size(astruct.(vnum))
IF (a[n_elements(a)-2] ne 8) THEN BEGIN
  print,'ERROR= 1st parameter to audio_wav not a structure' & RETURN,-1
ENDIF ELSE BEGIN
  a = tagindex('DAT',tag_names(astruct.(vnum)))
  IF (a[0] ne -1) THEN idat = astruct.(vnum).DAT $
  ELSE BEGIN
    a = tagindex('HANDLE',tag_names(astruct.(vnum)))
    IF (a[0] ne -1) THEN handle_value,astruct.(vnum).HANDLE,idat $
    ELSE BEGIN
      print,'ERROR= 1st parameter does not have DAT or HANDLE tag' & RETURN,-1
    ENDELSE
  ENDELSE
ENDELSE

; Determine which variable in the structure is the 'Epoch' data and retrieve it
b = astruct.(vnum).DEPEND_0 & c = tagindex(b[0],tag_names(astruct))
d = tagindex('DAT',tag_names(astruct.(c)))
IF (d[0] ne -1) THEN edat = astruct.(c).DAT $
ELSE BEGIN
  d = tagindex('HANDLE',tag_names(astruct.(c)))
  IF (d[0] ne -1) THEN handle_value,astruct.(c).HANDLE,edat $
  ELSE BEGIN
    print,'ERROR= Time parameter does not have DAT or HANDLE tag' & RETURN,-1
  ENDELSE
ENDELSE

; Get some info about the data using the SIZE function.
idat_size = SIZE (idat, /STRUCTURE)

; Make sure we are working a valid data type.
IF ((idat_size.type eq 0) or (idat_size.type gt 6 and idat_size.type lt 12)) THEN BEGIN

  PRINT,'STATUS=datatype indicates that data is not plottable' 
  RETURN,-1

ENDIF

; Get the DISPLAY attribute
found_display = 0 

a = tagindex ('DISPLAY_TYPE', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN 
   b = SIZE (astruct.(vnum).DISPLAY_TYPE, /N_ELEMENTS)
   IF (b ne 0) THEN BEGIN
      display = STRCOMPRESS (astruct.(vnum).DISPLAY_TYPE, /REMOVE_ALL) 
      found_display = 1
   ENDIF 
ENDIF

; Check if there was no DISPLAY attribute.  Throw a Warning.
IF  (found_display eq 0 && reduce eq 0) THEN BEGIN
    PRINT,'WARNING=Can not read the DISPLAY_TYPE attribute.' 
    PRINT,'STATUS=File requested for audification does not have a DISPLAY_TYPE attribute.'
ENDIF

; Check the reduce flag to see if it set.  If the reduce flag is set and the variable contains
; is non-scalar (either a vector or multidimensional array) then the mean of all elements is taken 
; in order to reduce the varaible to single value per record.

; This will allow audification of any variable, even those no specifically set up to generate
; audio files.
IF  (reduce) THEN BEGIN


    n_wave_files = 1

    ; Reduce until we have a vector (scalar vs time)
    FOR i = 0, idat_size.N_DIMENSIONS - 2 DO idat = MEAN (idat, DIMENSION=1)

ENDIF ELSE BEGIN
    ; Otherwise, proceed normally.
     
    ; Split the value recieved for DISPLAY_TYPE at the '>' character.  The presence indicates
    ; that the next part of the DISPLAY_TYPE will give a specific formula to use to
    ; reduce a multidemsional array to a single dimension.  If no display_type then just set
    ; dsp to the empty string.
    IF  found_display THEN dsp = STRSPLIT (display, '>', /EXTRACT) ELSE dsp = ''

    ; This logic sucks, but I don't really care anymore.
    IF  ~vec_audio && found_display && (N_ELEMENTS (dsp) ge 2) THEN BEGIN

        ; Extract a comma deliminated set of terms.  Each term will generate a new
        ; audio file.
        ; terms = STRSPLIT (dsp [1], ',', /EXTRACT)
        indlst = INTARR (1, 3)
        varlst = ['']

        n_terms = parse_display_attribute( dsp [1], indlst, varlst )
        
        IF  n_terms gt 0 THEN BEGIN

            indlst = indlst [1:*, *]
            varlst = varlst [1:*]

        ENDIF ELSE BEGIN
            PRINT,'ERROR=Can not parse extended display attributes' 
            PRINT,'STATUS=There is an error in the extended display attributes or they are ' + $
                  'not appropiate for the audify display type.'
            RETURN, -1

        ENDELSE

        new_data = MAKE_ARRAY (idat_size.DIMENSIONS [idat_size.N_DIMENSIONS - 1], n_terms, TYPE=idat_size.TYPE)

        FOR i = 0, n_terms - 1 DO BEGIN
     
            ; Exteded display attributes can only reference the current variable
            IF  varlst [i] ne astruct.(vnum).VARNAME THEN BEGIN

                PRINT,'ERROR=Extended display attributes can not referance other variables.' 
                PRINT,'STATUS=Extended display attributes for audify can not referance other variables.' 

                RETURN, -1        
          
            ENDIF 

            ; Get the appropiate index array
            ind = REFORM (indlst [i, *])

            ; Remove unneeded indices.
            ind = ind [WHERE (ind ne -1)]

            ; Find the requested dimensionality
            dim = N_ELEMENTS (ind)

            ; Make sure our data supports this.
            IF  dim ne idat_size.N_DIMENSIONS - 1 THEN BEGIN

                PRINT,'ERROR=Mismatch between extended display type request and data dimesnion.' 
                PRINT,'STATUS=Mismatch between extended display type request and data dimesnion.'
                RETURN, -1

            ENDIF 

            ; Extract the data that we are interested in
            CASE dim OF
               1:  new_data [*, i]  = REFORM (idat [ind [0], *])
               2:  new_data [*, i]  = REFORM (idat [ind [0], ind [1], *])
               3:  new_data [*, i]  = REFORM (idat [ind [0], ind [1], ind [2], *])
            ENDCASE

        ENDFOR

        idat = new_data 

        n_wave_files = n_terms

    ENDIF ELSE BEGIN 

        ; Make sure that we can create an audio file from the data.
        CASE idat_size.N_DIMENSIONS OF
          0   : BEGIN
                   PRINT,'ERROR=Can not create audio file from single data point' 
                   PRINT,'STATUS=Re-select longer time interval. Can not create audio file.' 
                   RETURN, -1
                END

          1   : BEGIN
                   
                   n_wave_files = 1

                   ; Make sure that we have data points for each time and vica versa.
        	       IF (N_ELEMENTS(idat) ne N_ELEMENTS(edat)) THEN BEGIN

                      print, 'STATUS=Re-select longer time interval; one value found for ', $
                             vname, ' and not useable.' 

                      RETURN, -1

        	       ENDIF

                END

         2   :  BEGIN
                  elist = indgen(idat_size.DIMENSIONS [0])

                  ; Make sure that we have data points for each time and vica versa.
	              IF  (idat_size.DIMENSIONS [1] ne N_ELEMENTS(edat)) THEN BEGIN

                      print, 'STATUS=Re-select longer time interval; one value found for ', $
                          vname, ' and not useable.' 

                      RETURN, -1

	              ENDIF

                  n_wave_files = idat_size.DIMENSIONS [0]

                  ; Transpose the data to match what is generated if the DISPLAY
                  idat = TRANSPOSE (idat)

                END
               
          ELSE: BEGIN
                   PRINT,'ERROR=Cannot create audio files for data with multiple dimensions' 
                   RETURN, -1
                END
        ENDCASE

    ENDELSE

ENDELSE

NUM_TEST = '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eEdD][-+]?[0-9]+)?$'

; Determine the proper start and stop times of the audio file.

; default to data
tbegin = edat [0] 
tend   = edat [N_ELEMENTS (edat) - 1] 

; set tbegin
IF KEYWORD_SET (tstart) THEN BEGIN 
  tbegin = tstart & tbegin16 = tstart & tbegintt = tstart
  ; If tstart is a string, convert it
  a = SIZE (TSTART, /TYPE)
  IF (a eq 7) THEN BEGIN 
      split_ep = STRSPLIT (tstart, '.', /EXTRACT)
      ; Corrected bug to millisec is not avaialable from time.
      ; Ron Yurow (Dec 14, 2020)
      msec = (N_ELEMENTS (split_ep) gt 1) ? split_ep [1] : 0
      ; Epoch
      tbegin   = ENCODE_CDFEPOCH (tstart)
      ; Epoch16
      tbegin16 = ENCODE_CDFEPOCH (tstart, /EPOCH16, MSEC=msec) ; MSEC=split_ep[1])
      ; TT2000
      tbegintt = ENCODE_CDFEPOCH (tstart, /TT2000, MSEC=msec) ; MSEC=split_ep[1])
  ENDIF
ENDIF

; set tend
IF KEYWORD_SET (tstop) THEN BEGIN
  tend = tstop & tend16 = tstop & tendtt = tstop
  ; If tstart is a string, convert it
  a = SIZE (tstop, /TYPE)
  IF (a eq 7) THEN BEGIN 
      split_ep = STRSPLIT (tstop, '.', /EXTRACT)
      ; Corrected bug to millisec is not avaialable from time.
      ; Ron Yurow (Dec 14, 2020)
      msec = (N_ELEMENTS (split_ep) gt 1) ? split_ep [1] : 0
      ; Epoch
      tend   = ENCODE_CDFEPOCH (tstop)
      ; Epoch16
      tend16 = ENCODE_CDFEPOCH (tstop, /EPOCH16, MSEC=msec) ; MSEC=split_ep[1])
      ; TT2000
      tendtt = ENCODE_CDFEPOCH (tstop, /TT2000, MSEC=msec) ; MSEC=split_ep[1]) 
  ENDIF
ENDIF

; Set tbegin and tend to their final values.
ep16 = 0 & eptt=0
if (size(edat[0],/tname) eq 'DCOMPLEX')then begin 
    ep16 = 1
    tend = tend16 
    tbegin = tbegin16
endif

if (size(edat[0],/tname) eq 'LONG64')then begin 
    eptt = 1
    tend = tendtt 
    tbegin = tbegintt
endif

rbegin = 0L 
w = WHERE ((CDF_EPOCH_COMPARE (edat, tbegin) ge 0), wc)

IF  (wc gt 0) THEN rbegin = w [0]

rend = N_ELEMENTS (edat) - 1 
w = WHERE ((CDF_EPOCH_COMPARE (edat, tend) le 0), wc)

IF (wc gt 0) THEN rend = w [-1]

; Check for innapropiate data bounds.
IF  (rbegin ge rend) THEN BEGIN
    print, 'rbegin and end = ', rbegin, rend
    print,'STATUS=No data within specidied time range.' 
    RETURN, -1
ENDIF

found_vmin = 0

a = tagindex ('VALIDMIN', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN 
   b = SIZE (astruct.(vnum).VALIDMIN, /STRUCTURE)
   IF (b.TYPE eq 7) THEN BEGIN
      ex = STREGEX (astruct.(vnum).VALIDMIN, NUM_TEST, /EXTRACT)
      IF  (ex ne '') THEN  BEGIN
          vmin = FLOAT (ex)
          found_vmin = 1
      ENDIF  
   ENDIF ELSE BEGIN
      IF  (b.N_ELEMENTS ne 0) THEN BEGIN
          vmin = astruct.(vnum).VALIDMIN
          found_vmin = 1
      ENDIF
   ENDELSE
ENDIF

IF  (~ found_vmin) THEN BEGIN
    vmin = MAKE_ARRAY (n_wave_files, VALUE = -16000.0)
    PRINT,'WARNING=Unable to determine validmin for ', vname
ENDIF

found_vmax = 0

a = tagindex ('VALIDMAX', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN 
   b = SIZE (astruct.(vnum).VALIDMAX, /STRUCTURE)
   IF (b.TYPE eq 7) THEN BEGIN
      ex = STREGEX (astruct.(vnum).VALIDMAX, NUM_TEST, /EXTRACT)
      IF  (ex ne '') THEN  BEGIN
          vmax = FLOAT (ex)
          found_vmax = 1
      ENDIF  
   ENDIF ELSE BEGIN
      IF  (b.N_ELEMENTS ne 0) THEN BEGIN
          vmax = astruct.(vnum).VALIDMAX
          found_vmax = 1
      ENDIF
   ENDELSE
ENDIF

IF  (~ found_vmax) THEN BEGIN
    vmax = MAKE_ARRAY (n_wave_files, VALUE = 16000.0)
    PRINT,'WARNING=Unable to determine validmax for ', vname   
ENDIF 

found_fill = 0 

a = tagindex ('FILLVAL', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN 
   b = SIZE (astruct.(vnum).FILLVAL, /STRUCTURE)
   IF (b.TYPE eq 7) THEN BEGIN
      ex = STREGEX (astruct.(vnum).FILLVAL, NUM_TEST, /EXTRACT)
      IF  (ex ne '') THEN  BEGIN
          fill = FLOAT (ex)
          found_fill = 1
      ENDIF  
   ENDIF ELSE BEGIN
      IF  (b.N_ELEMENTS ne 0) THEN BEGIN
          fill = astruct.(vnum).FILLVAL
          found_fill = 1
      ENDIF
   ENDELSE
ENDIF

IF  (~ found_fill) THEN BEGIN       
    fill = 0 ; figure out what this value should be
    PRINT,'WARNING=Unable to determine fill value for ', vname
ENDIF 

smin = vmin

a = tagindex ('SCALEMIN', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN 
   b = SIZE (astruct.(vnum).SCALEMIN, /STRUCTURE)
   IF (b.TYPE eq 7) THEN BEGIN
      ex = STREGEX (astruct.(vnum).SCALEMIN, NUM_TEST, /EXTRACT)
      IF  (ex ne '') THEN smin = FLOAT (ex)  
   ENDIF ELSE BEGIN
      IF  (b.N_ELEMENTS ne 0) THEN smin = astruct.(vnum).SCALEMIN
   ENDELSE
ENDIF

smax = vmax

a = tagindex ('SCALEMAX', tag_names (astruct.(vnum)))
IF (a[0] ne -1) THEN BEGIN
   b = SIZE (astruct.(vnum).SCALEMAX, /STRUCTURE)
   IF (b.TYPE eq 7) THEN BEGIN
      ex = STREGEX (astruct.(vnum).SCALEMAX, NUM_TEST, /EXTRACT)
      IF  (ex ne '') THEN smax = FLOAT (ex)  
   ENDIF ELSE BEGIN
      IF  (b.N_ELEMENTS ne 0) THEN smax = astruct.(vnum).SCALEMAX
   ENDELSE
ENDIF

; Select the correct time range.
mytime = edat [rbegin:rend]

buf_sz = rend - rbegin + 1

; If numbber of wave files to created is more than 100, clamp it to 100.
IF  n_wave_files gt 100 THEN BEGIN

    PRINT,'WARNING=", n_wave_files, " requested.  Only the first 100 will be created."

    n_wave_files = 100
    
ENDIF

; Create each file in turn.
FOR wave_file = 0, n_wave_files - 1 DO BEGIN 

    ; Select data points within the requested time range.
    mydata = REFORM (idat [rbegin:rend, wave_file])

    ; Reset data that is set to fillval to validmin. 
    ;w = WHERE (idat eq fill, wc)
    ;IF  (wc gt 0) THEN BEGIN 
    ;    mydata [w] = vmin
    ;ENDIF
    
    ;mydata = mydata [WHERE (mydata ne fill)]

    ; Replace any records that are set to the fill value with a linear 
    ; interpolation.
    fill_index = WHERE (mydata eq fill, fill_count)

    IF  (fill_count eq buf_sz) THEN CONTINUE

    CASE 1 OF
        ; No fill values.  Nothing to do.
        (fill_count eq 0) :

        ; Some fill.  Do linear interpolation.
        ELSE : BEGIN

            last_index = fill_count - 1

            ptr = 1L
            v0  = 0L
            v1  = 0L 
    
            sequent = 0L


            WHILE (ptr lt fill_count) DO BEGIN

                IF  fill_index [ptr] eq fill_index [ptr-1] + 1 THEN BEGIN

                    v1 = ptr

                ENDIF ELSE BEGIN

                    ; Do linear interpolation for fillval (v0 to v1)

                    interpolate_audio_data, mydata, fill_index, v0, v1

                    v0 = ptr
                    v1 = ptr

                ENDELSE
                
                ptr++

            ENDWHILE

            interpolate_audio_data, mydata, fill_index, v0, v1

            END
    ENDCASE

    IF N_ELEMENTS (vmin) gt 1 THEN minval = vmin [wave_file] ELSE minval = vmin

    w = WHERE (mydata lt minval, wc)
    IF  (wc gt 0) THEN BEGIN

        mydata [w] = minval

    ENDIF

    IF N_ELEMENTS (vmax) gt 1 THEN maxval = vmax [wave_file] ELSE maxval = vmax

    ; Reset any data above validmax to validmax
    w = WHERE (mydata gt maxval, wc)
    IF  (wc gt 0) THEN BEGIN

        mydata [w] = maxval

    ENDIF

    t0 = CDF_ENCODE_EPOCH (tbegin, EPOCH=2) 
    t1 = CDF_ENCODE_EPOCH (tend, EPOCH=2)

    ; file_name = STRING (FORMAT = '(A, "_", I3.3, "_", A, "_", A, ".wav")', gif, wave_file, t0, t1)
    file_name = STRING (FORMAT = '(A, "_", I3.3, ".wav")', gif, wave_file)

    ;minval = smin
    ;maxval = smax
    ;minval = vmin
    ;maxval = vmax
    minval = MIN (mydata)
    maxval = MAX (mydata) 

    scaledata = -32768 + UINT (65535.0 * (mydata - minval) / (maxval - minval))
    
    IF (reportflag eq 1) THEN printf, 1, 'AUDIO=', file_name
   
    PRINT, 'AUDIO=', file_name, FORMAT='(A,A)'

    ;write_wav, file_name, scaledata, 44100
    ;write_wav, file_name, scaledata, 4000
    write_wav, file_name, scaledata, 22000

ENDFOR

return, 0

END
