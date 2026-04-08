# Email to CDAWeb Team — DataIntervals Proposal

**To:** R-NASA Candey <robert.m.candey@nasa.gov>, "Kovalick, Tamara J. (GSFC-672.0)[ADNET SYSTEMS INC]" <tamara.j.kovalick@nasa.gov>
**Subject:** CDAWeb Audification gap metadata & proposed patch for audio_wav.pro
**Attachments:** audio_wav.pro (patched)

---

Hi Bobby and Tami,

I'm working with a team submitting a ROSES Science Activation proposal called SONARA (Sounds of NASA: Research Activated) to scale up sonification of heliophysics data for citizen science, education, and music outreach. I've been using the format=audio endpoint heavily for spaceweather.now.audio and ran into an issue with how gaps are handled. When a time range has missing CDF records (common with PSP cruise phase, MMS burst modes, etc.), audio_wav.pro concatenates whatever records exist into the WAV without any indication of where the gaps were. The audio timeline ends up not matching wall-clock time.

I wrote a patch for audio_wav.pro, which is attached. The new code starts at line 540, right after mytime = edat[rbegin:rend]. It detects contiguous data blocks and prints DATAINTERVAL= lines to STDOUT, following the convention of the existing AUDIO=, STATUS=, and ERROR= lines. Each DATAINTERVAL= line contains the start epoch, end epoch, sample count, and cadence for one contiguous block. The cadence is in native epoch units (nanoseconds for TT2000, milliseconds for CDF_EPOCH), so the Java side could normalize it when building the JSON response since it already knows the epoch type from the CDF metadata. Continuous data with no gaps emits exactly one line. The WAV output itself is unchanged, so it's fully backward compatible.

The Java side will just need to parse the new DATAINTERVAL= lines and add them to the FileDescription response, the same way it already parses the other STDOUT lines. The response could look something like:

  "DataIntervals": [
    {"Start": "2020-01-29T00:01:09Z", "End": "2020-01-29T02:03:48Z", "Samples": 67740, "CadenceMs": 109.227},
    {"Start": "2020-01-29T10:54:26Z", "End": "2020-01-29T11:24:38Z", "Samples": 17408, "CadenceMs": 109.227}
  ]

With DataIntervals in the response, clients can insert silence where gaps were so the audio matches wall-clock time. Right now a 12-hour PSP request with only 3 hours of data plays as if it's continuous, and there's no way to know where those 3 hours actually sit in the 12-hour window.

I tested the algorithm against 5 real CDF datasets (PSP, GOES, MMS, Solar Orbiter) in both Python and GDL. Let me know if this change looks feasible on your end, and feel free to reach out with any questions!

Best,
Robert
