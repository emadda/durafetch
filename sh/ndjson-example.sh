# If you need timestamps for logging in development, you can pretty print the ndjson log output:

# config.json should contain:
# "logging": {
#     "ndjson": true
# }

# rg ignores any non ndjson lines (like the Node debugger log, unexpected stack traces).
durafetch --config-file ./config.json | rg --line-buffered "^\{.+?\}$" | jq
