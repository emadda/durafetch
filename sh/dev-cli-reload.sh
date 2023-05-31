# --verbose
# When the server source code changes and reboots, reboot/reconnect the client.
nodemon \
    --delay 1000ms \
    --ext js,ts,json,sh,html \
    --watch ./ \
    --watch /Users/enzo/Dev/my-projects/tabserve/src/cf-workers/w1 \
    --exec 'node --stack-trace-limit=50 --enable-source-maps --inspect ./dist/cli.js --config-file ./src/test/config-examples/01-config.json'
