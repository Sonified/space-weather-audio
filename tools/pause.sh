#!/bin/bash
pid=$(pgrep -f gap_cataloger)
if [ -z "$pid" ]; then
    echo "Gap cataloger is not running."
else
    kill -STOP "$pid"
    echo "Paused gap cataloger (pid $pid). Resume with: tools/resume.sh"
fi
