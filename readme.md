# Durafetch

Durafetch is a CLI that downloads your Cloudflare Durable Object state to a local SQLite database.

See [durafetch-server](https://github.com/emadda/durafetch-server) for more details.



# Usage

Assuming you have added the server side component to your Cloudflare worker:

Install:
- `npm install --global durafetch`


Write to `config.json`:
```
{
    "db_file": "./db.sqlite",
    "servers": [
        {
            "ws_url": "wss://durafetch_worker-1.your-domain.com",
            "auth_token": "secret_http_auth_bearer_token_replace_this_with_more_than_40_chars"
        }
    ],
    "poll": {
        "every_ms": 1000
    },
    "concurrent_downloads": 50,
    "logging": {
        "ndjson": false
    }
}
```


Run:
- `durafetch --config-file config.json`


