#!/bin/sh
python3 "$(dirname "$0")/_mock_sse.py" 45300 hb &
python3 "$(dirname "$0")/_mock_sse.py" 45301 &
sleep 1
echo "mock servers up: 45300(hb) 45301(plain)"
wait
