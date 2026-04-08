;+------------------------------------------------------------------------
; NAME: AUDIOMASTER
; PURPOSE: To plot the data given in 1 to 30 anonymous structure of the type
;          returned by the read_mycdf function.  This function creates an
;          audio file based data on each variable in each input structure.
; CALLING SEQUENCE:
;       out = audiomaster (a,[more_structures])
; INPUTS:
;       a = structure returned by the read_mycdf procedure.
;
; KEYWORD PARAMETERS:
;   TSTART =  String of the form '1996/01/02 12:00:00' or a DOUBLE CDF_EPOCH
;   time that is the desired start time of the plots. Data is clipped or
;   padded to conform to this time. Default is the start time of the
;   earliest data.
;
;   TSTOP = String of the form '1996/01/02 12:00:00' or a DOUBLE
;   CDF_EPOCH time that is the desired stop time of the plots. Data is
;   clipped or padded to conform to this time. Default is the stop time of
;   the latest data.
;
;   PID
;   May be used to customize part of the name of a gif file. The value of
;   PID may be either a number or a string and will be inserted in the gif
;   file name as follows: Spacecraft_instrument_pid_#.gif. If GIF is not
;   set then the plot(s) will be put into an x-window and this keyword is
;   ignored.
;
;   OUTDIR
;   This keyword indiates the output directory where a gif file will be
;   placed. If GIF is set but OUTDIR is not, then the gif file will be put
;   in the user's current working directory.GIF
;
;   AUTO
;   Set this keyword to use autoscaling instead of the variables SCALEMIN
;   and SCALEMAX attribute values. The scales will be set to the min and
;   max values of the data, after fill values have been filtered from the
;   data (see also NONOISE keyword). If the user wishes to modify variable
;   scale values for plotting purposes, you may do so by changing the
;   appropriate data structure values, ie. struct.variable.scalemin = 0.0.
;   Please use great care in modifying the data structures values since
;   they will greatly influence what your plots or listings may look like.
;
; OUTPUTS:
;       out = status flag, 0=0k, -1 = problem occurred.
; AUTHOR:
;       Ron Yurow, NASA/GSFC/Code 672.0, Dec 13, 1996
; MODIFICATION HISTORY:
;
;Copyright 1996-2013 United States Government as represented by the
;Administrator of the National Aeronautics and Space Administration. All Rights Reserved.
;
;-------------------------------------------------------------------------
FUNCTION audiomaster, a0,a1,a2,a3,a4,a5,a6,a7,a8,a9, $
  a10,a11,a12,a13,a14,a15,a16,a17,a18,a19, $
  a20,a21,a22,a23,a24,a25,a26,a27,a28,a29, GIF=GIF, $
  TSTART=TSTART, TSTOP=TSTOP, AUTO=AUTO, DEBUG=DEBUG, $
  PID=PID, STATUS=STATUS, OUTDIR=OUTDIR

  compile_opt idl2

  ; Verify that number of parameters is acceptable
  if ((n_params() le 0)OR(n_params() gt 30)) then begin
    print, 'STATUS= No data selected for plotting'
    print, 'ERROR=Number of parameters must be from 1 to 30'
    return, -1
  endif

  PS = 0 ; Initialize plot script structure

  ; Initialize other local variables
  a          = 0       ; create variable to be filled via the execute function
  a_id       = -1      ; initialize the current structure number
  ini_complex = dcomplex(0.0D0)

  template = {BASEDESC,snum:0,vname:'',vnum:0,ptype:0, $
    btime:0.0D0,etime:0.0D0,btime16:ini_complex,ibad:0, $
    etime16:ini_complex,btimett2000:long64(0),etimett2000:long64(0),source:''}

  ; statusflag is not currently checked before printing
  if keyword_set(STATUS) then statusflag= 1L else statusflag= 0L

  if keyword_set(OUTDIR) then outdir=OUTDIR else outdir=''

  if keyword_set(PID) then pid=strtrim(string(PID),2) else pid=''

  gif_ps_open = 0L ; initialize flag indicating no gif or ps is currently open

  if keyword_set(AUTO) then autoscale = 1L else autoscale = 0L

  ; Evaluate each dataset structure, and each variable within each dataset,
  ; in order to determine the plot type for each variable, as well as the total
  ; number of panels to be plotted so that the windows (or Z-buffer) can be
  ; created with the proper size.

  plottable_found = 0 ; initialize flag

  for i=0, n_params()-1 do begin ; process each structure parameter
    w = execute('a=a'+strtrim(string(i),2))
    if w ne 1 then begin
      print,'ERROR= Error in EXECUTE function'
      print, 'STATUS= A plotting error has occurred'
      return, -1
    endif
    ; RTB Add code to trap a=-1 bad structures
    ibad=0
    str_tst=size(a)
    if(str_tst[str_tst[0]+1] ne 8) then begin
      ibad=1
      v_data='DATASET=UNDEFINED'
      v_err='ERROR=a'+strtrim(string(i),2)+' not a structure.'
      v_stat='STATUS=Cannot plot this data'
      a=create_struct('DATASET',v_data,'ERROR',v_err,'STATUS',v_stat)
    endif else begin
      ; Test for errors trapped in read_myCDF
      atags=tag_names(a)
      rflag=tagindex('DATASET',atags)
      if(rflag[0] ne -1) then ibad=1
    endelse

    if (ibad) then begin
      atags=tag_names(a)
      aw=where(atags eq 'ERROR',awc)
      print,a.DATASET
      if(awc gt 0) then print,a.ERROR
      print,a.STATUS
      p=template
      ;TJK 1/24/01 - change the ptype to -1 so that the plotting s/w lower down
      ;won't bother trying to do anything w/ this variables data (since it won't
      ;be there).  I believe, the main reason we end up here is that the data
      ;is fill and indicates that the instrument was off.
      ;      p(0).ptype=0
      p[0].ptype=-1
      p[0].snum=i
      ; Needed to distiguish the no_plot display type from invalid data structures.
      ; Ron Yurow (March 9, 2017)
      p[0].ibad=1
    endif else begin
      vnames = tag_names(a)
      p = replicate(template,n_elements(vnames))
      for j=0,n_elements(tag_names(a))-1 do begin
        b = evaluate_varstruct(a.(j)) & c = size(b)
        if c[n_elements(c)-2] ge 8 then begin ; record the evaluation results
          p[j].snum   = i        & p[j].vnum    = j
          p[j].ptype  = b.ptype  ; use this as a flag to ensure that an audio file can be created.  
          p[j].btime  = b.btime  & p[j].etime   = b.etime
          p[j].btime16  = b.btime16  & p[j].etime16   = b.etime16
          p[j].btimett2000  = b.btimett2000  & p[j].etimett2000   = b.etimett2000
          p[j].source   = b.source

          if (b.vname ne '') then p[j].vname=b.vname else p[j].vname=vnames[j]

          ; Check to make sure that a depend0 is set.  Audio files can only be created
          ; from time based variables.
          depend_0_index = tagindex ('DEPEND_0', TAG_NAMES (a.(j)))
          IF  depend_0_index eq -1 || STRLEN (a.(j).DEPEND_0) eq 0 THEN BEGIN 
              P[j].ptype = 0
              CONTINUE
          ENDIF

          var_type = tagindex ('VAR_TYPE', TAG_NAMES (a.(j)))
          IF var_type eq -1 || ~ STRCMP (a.(j).VAR_TYPE, 'data', /FOLD_CASE) THEN BEGIN
             P[j].ptype = 0
             CONTINUE
           ENDIF

          
          allow_bin_index = tagindex ('ALLOW_BIN', TAG_NAMES (a.(j)))
          IF  allow_bin_index ne -1 && STRCMP (a.(j).ALLOW_BIN, 'FALSE', /FOLD_CASE) THEN BEGIN 

              P[j].ptype = 0
              print, 'STATUS=Audification of multi-dimensional variables is not supported, ' + $ 
                     'please select scalar variables.'
          ENDIF

          if b.ptype ne 0 then plottable_found = 1; set flag

        endif else begin ; fatal error during evaluation
          print,'STATUS=A plotting error has occurred'
          print,'ERROR=FATAL error during eval'
          return,-1
        endelse
      endfor ; for every variable
    endelse

    ; append the plot evaluations of the current structure to any previous ones
    if (i eq 0) then PS = p else PS = [PS,p]
    ; RTB changed from a_id = i
    ; a_id = i
    ; if (i eq 0) then a_id=-1 else a_id = i ; set parameter id variable
  endfor ; evaluate every data structure

  ;********************************************************************************

  ; Check flag to determine if any plottable variables were found.
  ;TJK changed the two status messages to be a little more descriptive -
  ;basically, no data was found that could be plotted.
  ;TJK 12/21/2005 added check for ptype - if its equal to -1, then we've
  ;already printed out the error and status, don't print the message below
  if (plottable_found eq 0) then begin
    if (p[0].ptype gt -1) then begin
      print,'STATUS=No plottable data found for selected variables.'
      print,'STATUS=Please select another time range. Either your time range was too short (no data found for the interval) or'
      print,'STATUS=too long (your session timed out before all of the data you requested could be read).'
    endif

    return,-1
  endif


  gif_counter = 0L ; maybe rename this??
  ; 

  ; TJK commented out start_time = 0.0D0 ; initialize
  ; need to set default values for start_time and stop_time
  ; if min in p.btime = [0,0,epoch] then min epoch will be missed RTB
  btime=ps.btime                                ; RTB
  we=where(btime ne 0.D0,wc)                   ; RTB
  if (wc gt 0) then min_ep=btime[we] $
  else min_ep=0.D0  ; need some default value. min_ep would be
  ;undefined below if time range requested has no data in it

  ; RCJ 05/28/2003  var fUHR from dataset po_h1_pwi caused problem here
  ; when one of its cdfs had all virtual values for epoch,
  ; making btime=0.0D0, the default
  ; TJK 10/27/2006 - add checking for epoch16 times when epoch doesn't exist
  ; RCJ 04/09/2013  Look for tt2000 too
  if we[0] eq -1 then begin
    ;btime = ps.btime16 ;try looking for epoch16 value
    ;we=where(btime ne 0.D0,wc)
    ;if we[0] eq -1 then min_ep=0.0D0 else min_ep=btime[we]
    btime16 = ps.btime16 ;try looking for epoch16 value
    btime2000 = ps.btimett2000 ;try looking for tt2000 value
    we1=-1 & we2=-1
    we1=where(btime16 ne 0.D0,wc)
    we2=where(btime2000 ne long64(0),wc)
    if we1[0] ne -1 then min_ep=btime16[we1]
    if we2[0] ne -1 then min_ep=btime2000[we2]
  endif

  etime=ps.etime
  we=where(etime ne 0.D0,wc)
  if (wc gt 0) then max_ep=etime[we] else $
    max_ep=0.D0  ; need some default value. max_ep would be
  ;undefined below if time range requested has no data in it


  ;TJK 10/27/2006 - add checking for epoch16 end times when epoch doesn't exist
  ; RCJ 04/09/2013  Look for tt2000 too
  if we[0] eq -1 then begin
    ;etime = ps.etime16 ;try looking for epoch16 value
    ;we=where(etime ne 0.D0,wc)
    ;if we[0] eq -1 then max_ep=0.0D0 else max_ep=etime[we]
    etime16 = ps.etime16 ;try looking for epoch16 value
    etime2000 = ps.etimett2000 ;try looking for tt2000 value
    we1=-1 & we2=-1
    we1=where(etime16 ne 0.D0,wc)
    we2=where(etime2000 ne 0.D0,wc)
    if we1[0] ne -1 then max_ep=etime16[we1]
    if we2[0] ne -1 then max_ep=etime2000[we2]
  endif

  start_time = min(min_ep)
  stop_time = max(max_ep)
  ;print,'start time ', start_time, ' ', 'stop_time ',stop_time, ' before tstart/tstop code'

  ; TJK 7/20/2006 - compute the equivalent epoch16 start/stop times so
  ;                 that comparison w/ data stored as epoch16 is
  ;                 possible.

  ;if keyword_set(TSTART) then begin ; determine datatype and process if needed
  if (keyword_set(TSTART) or ((not keyword_set(TSTART)) and (start_time ne 0.0))) then begin ; determine datatype and process if needed
    if ((not keyword_set(TSTART)) and (start_time ne 0.0)) then TSTART=start_time
    b = size(TSTART) & c = n_elements(b)
    ;   if (b(c-2) eq 5) then start_time = TSTART $    ; double float already
    ;   else if (b(c-2) eq 7) then start_time = encode_cdfepoch(TSTART) $ ; string

    case b[c-2] of
      5: begin
        start_time = TSTART
      end
      7: begin
        ;TJK 10/23/2009 if the TSTART value has a milliseconds component, use
        ;that when computing the start time (to get the precision)
        split_ep=strsplit(TSTART,'.',/extract)

        start_time = encode_cdfepoch(TSTART) ; string
        ;start_time16 = encode_cdfepoch(TSTART,/EPOCH16) ; string
        if (n_elements(split_ep) eq 2) then begin
          start_time16 = encode_cdfepoch(TSTART,/EPOCH16,msec=split_ep[1]) ; string
          start_timett = encode_cdfepoch(TSTART, /TT2000, MSEC=split_ep[1])    ;TJK added for TT2000 time
        endif else begin
          start_time16 = encode_cdfepoch(TSTART,/EPOCH16) ; string
          start_timett = encode_cdfepoch(TSTART, /TT2000)    ;TJK added for TT2000 time
        endelse
      end
      14:  begin
        start_timett=TSTART ; already long64
      end
      else: begin
        if (reportflag eq 1) then $
          printf,1,'STATUS= Time Range Error' & close, 1
        print,'STATUS= Time Range Error'
        print,'ERROR= TSTART parameter must be STRING or DOUBLE' & return,-1
      end
    endcase

  endif

  ; If we are combining variables from different megastructures, then we must
  ; determine the stop time of the data so that they can be plotted along a
  ; common axis.  This is overridden by TSTOP keyword.
  ; TJK commented out stop_time = 0.0D0 ; initialize

  ;if keyword_set(TSTOP) then begin ; determine datatype and process if needed
  if (keyword_set(TSTOP) or ((not keyword_set(TSTOP)) and (stop_time ne 0.0)))  then begin ; determine datatype and process if needed
    if ((not keyword_set(TSTOP)) and (stop_time ne 0.0)) then TSTOP=stop_time
    b = size(TSTOP) & c = n_elements(b)
    ;   if (b(c-2) eq 5) then stop_time = TSTOP $ ; double float already
    ;   else if (b(c-2) eq 7) then stop_time = encode_cdfepoch(TSTOP) $ ; string

    case b[c-2] of
      5: begin
        stop_time = TSTOP       ; stop_time is double float already
      end
      7: begin
        ;TJK 10/23/2009 if the TSTOP value has a milliseconds component, use
        ;that when computing the start time (to get the precision)
        split_ep=strsplit(TSTOP,'.',/extract)
        stop_time = encode_cdfepoch(TSTOP) ; string
        ;          stop_time16 = encode_cdfepoch(TSTOP,/EPOCH16) ; string
        if (n_elements(split_ep) eq 2) then begin
          stop_time16 = encode_cdfepoch(TSTOP,/EPOCH16,msec=split_ep[1]) ; string
          stop_timett = encode_cdfepoch(TSTOP, /TT2000, MSEC=split_ep[1])    ;TJK added for TT2000 time
        endif else begin
          stop_time16 = encode_cdfepoch(TSTOP,/EPOCH16) ; string
          stop_timett = encode_cdfepoch(TSTOP, /TT2000)    ;TJK added for TT2000 time
        endelse
      end
      14: begin
        stop_timett= TSTOP  ; already long64
      end
      else: begin
        if (reportflag eq 1) then $
          printf,1,'STATUS= Time range error.' & close,1
        print,'ERROR= TSTOP parameter must be STRING or DOUBLE' & return,-1
        print, 'STATUS= Time range error.'
      end
    endcase

  endif


  a_id=-1 ; Reset structure id
  ; Make a pass thru the plot script and generate all sound files for audio
  for i=0,n_elements(PS)-1 do begin
    if (PS[i].ptype ne 0) then begin
    ;if ((PS[i].ptype eq 22) and (plottype ne 'pscript')) then begin
      ; Ensure that 'a' holds the correct data structure
      if (PS[i].snum ne a_id) then begin
        s=execute('a=a'+strtrim(string(PS[i].snum),2)) & a_id = PS[i].snum
      endif
      ; Determine name for new audio file.
      if keyword_set(GIF) then begin
        if(gif_counter lt 100) then gifn='0'+strtrim(string(gif_counter),2)
        if(gif_counter lt 10) then gifn='00'+strtrim(string(gif_counter),2)
        if(gif_counter ge 100) then gifn=strtrim(string(gif_counter),2)
        ;GIF=outdir+PS[i].source+'_'+pid+'_'+gifn+'.mpg'
        GIF=outdir+PS[i].source+'_'+pid+'_'+gifn
        gif_counter = gif_counter + 1
      endif

      ; Produce debug output if requested
      if keyword_set(DEBUG) then print,'Writing  ',PS[i].vname,' as audio file...'

      print, 'DATASET=',PS[i].source+': '+strupcase(PS[i].vname)
      
      ; Produce the audio file

      ; Add VECTOR_AUDIO keyword.  Setting this keyword will cause AUDIO_WAV  not to
      ; intergate the display attribute.
      s = AUDIO_WAV (a,PS[i].vname, RANGE=range, TSTART=TSTART, TSTOP=TSTOP, /VECTOR_AUDIO, $
        GIF=gif, DEBUG=debugflag)

      if(s eq -1) then begin
        print, 'STATUS=Audio file creation failed'
        return, -1
      endif

    endif
  endfor
; end for audio file generation
;++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

; Set plot back to native method

return,0
end









