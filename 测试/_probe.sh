#!/bin/sh
cd "$(dirname "$0")"
echo "== non-stream =="
curl -s -m 25 -o _r1.txt -w "http=%{http_code} time=%{time_total}\n" -X POST "http://wbapi.internal:45217/v1/chat/completions" -H "Content-Type: application/json" --data-binary @_probe_req.json
echo "-- body --"
head -c 900 _r1.txt
echo
echo "== stream =="
curl -s -m 25 -N -o _r2.txt -w "http=%{http_code} time=%{time_total}\n" -X POST "http://wbapi.internal:45217/v1/chat/completions" -H "Content-Type: application/json" --data-binary @_probe_stream.json
echo "-- body --"
head -c 1500 _r2.txt
echo
