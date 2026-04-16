#!/bin/sh
mkdir -p /data
exec node dist/server.js --db /data/agent-comm.db --port 3420
