#!/bin/sh
SRC="/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/.scripting/agent-custom-providers.json"
DST="/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/agent-custom-providers.backup-test.json"
cp "$SRC" "$DST" && echo "backup ok: $DST"
