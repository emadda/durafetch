# Test `npm install --global`

# Remove prev run.
npm uninstall -g durafetch

npm pack --pack-destination /tmp

# Note:
# - `better-sqlite` compiles SQLite from source - takes around 30 seconds on M1.
# - `npm install ./local-dir` does not install `node_modules`, or run the `postinstall` scripts.
npm install --loglevel verbose --global /tmp/durafetch-1.0.0.tgz
