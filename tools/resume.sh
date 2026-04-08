#!/bin/bash
pid=$(pgrep -f gap_cataloger)
if [ -z "$pid" ]; then
    echo "Gap cataloger is not running."
else
    kill -CONT "$pid"
    echo "Resumed gap cataloger (pid $pid)."
fi
