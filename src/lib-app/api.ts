import WebSocket from "ws";
import * as _ from "lodash";
import {is_dev} from "../lib/util";

// JS functions that wrap the HTTP/WebSocket API.

const url_paths = {
    external_do_read_all_from: `/external/do/read_all_from`,
    external_do_get_and_watch_index: `/external/do/get_and_watch_index`
};


const is_plaintext_websocket = (x) => x.protocol === "ws:";
const target_is_localhost = (x) => {
    return (
        // E.g. durafetch_worker-x.localhost
        x.hostname.endsWith("localhost") ||

        // E.g. "127.0.0.1:1234" when using a local reverse proxy which forwards to the above subdomain.
        x.hostname === "127.0.0.1"
    )
}
const plaintext_websocket_used_must_exit_message = (ws_url) => `WebSocket server URL must be a secure connection (wss://) when in production. Tried to connect to: ${ws_url}. You can disable this check by running in dev mode: 'NODE_ENV="development" durafetch ...'`;


const plaintext_warning_in_prod = {};

// Avoid using plaintext WebSocket in prod.
const exit_if_plaintext_websocket_used_in_production = (ws_url) => {
    const x = new URL(ws_url);


    if (!is_dev()) {
        // Prod
        if (is_plaintext_websocket(x)) {
            if (target_is_localhost(x)) {
                if(!(ws_url in plaintext_warning_in_prod)) {
                    // Just once (when polling do not print out on every poll).
                    plaintext_warning_in_prod[ws_url] = true;
                    const msg = `Note: Connecting to a plaintext Websocket: ${ws_url}. Ensure connections are encrypted if they travel over the internet, or that you are only using test data.`;
                    console.log(msg);
                }
            } else {
                console.error(plaintext_websocket_used_must_exit_message(ws_url));
                process.exit(1);
            }
        }
    } else {
        // Dev (for CLI build)
        if (is_plaintext_websocket(x)) {
            if (!target_is_localhost(x)) {
                const msg = `Connecting to a plaintext Websocket that does not contain "localhost" - please ensure the underlying network connections are private or you are using only test data. Connecting to: ${ws_url}.`;
                console.log(msg);
            }
        }
    }
}


// Note: This ws endpoint will also stream new keys as they are created.
// - But the current version just does a download of the DO data that has changed since the last download and exits.
const get_full_list_of_durable_objects = async (server_opts) => {
    const {
        ws_url,
        auth_token
    } = server_opts;

    exit_if_plaintext_websocket_used_in_production(ws_url);


    return new Promise((resolve, reject) => {

        const ws = new WebSocket(
            `${ws_url}${url_paths.external_do_get_and_watch_index}`,
            [],
            {
                headers: {
                    'Authorization': `Bearer ${auth_token}`
                }
            }
        );


        ws.on('error', (error) => {
            // console.error(error);

            if (error.code === "ENOTFOUND") {
                if (error.hostname.endsWith(".localhost")) {
                    console.log(`Note: If you are trying to use subdomains with localhost, you will need to add an entry to /etc/hosts like this: "127.0.0.1\t${error.hostname}"`)
                }
            }

            reject(error);
        });

        ws.on('open', () => {
        });

        // @todo/med Retry on fail, handle errors
        ws.on('close', () => {
            reject("disconnected from websocket");
        });

        // @see https://github.com/websockets/ws/blob/8.11.0/doc/ws.md#event-message
        ws.on('message', (data, is_binary) => {
            if (!is_binary) {
                try {
                    const m = JSON.parse(data.toString())
                    if (m.kind === "full_index") {
                        resolve(m);
                        ws.close();
                        return;
                    }
                } catch (e) {
                    console.error(e);
                }

                // resolve
            } else {
                console.error("Binary ws message received (should not have been sent).", data);
            }
            ws.close();
            reject("Could not parse JSON")
        });

    });
}


const get_kvs_from_durable_object = async (server_opts, x, max_local_write_id) => {
    const {
        ws_url,
        auth_token
    } = server_opts;

    exit_if_plaintext_websocket_used_in_production(ws_url);


    const url = new URL(`${ws_url}${url_paths.external_do_read_all_from}`);
    const params = {
        worker_name: x.worker_name,
        class_name: x.class_name,
        id: x.id,

        // Note: x.log_id and x.write_id are the current *remote* max write_id.
        // This request needs to send the current *local* max write_id + 1 to read from - the response includes from_write_id.
        from_log_id: null,
        from_write_id: null,
    };

    if (max_local_write_id !== null) {
        params.from_log_id = max_local_write_id.log_id;
        params.from_write_id = max_local_write_id.write_id + 1;
    }

    for (const [k, v] of _.toPairs(params)) {
        if (v === null) {
            // Skip null as it is encoded as a string: `null`.
            continue;
        }
        url.searchParams.set(k, v);
    }

    // This is implemented as a WebSocket and not a single HTTP request because the CF worker is limited to 128MB RAM.
    // - This may be too small to store all the DO data, but streaming it over a WebSocket should be OK.
    return new Promise((resolve, reject) => {

        const ws = new WebSocket(
            url.toString(),
            [],
            {
                headers: {
                    'Authorization': `Bearer ${auth_token}`
                }
            }
        );


        ws.on('error', (error) => {
            console.error(error);
            reject(error);
        });

        ws.on('open', () => {
        });

        // @todo/med Retry on fail, handle errors
        ws.on('close', () => {
            reject("disconnected from websocket");
        });


        const ret = {
            start: null,
            keys_and_values: {},
            deleted_keys: []
        };

        // @see https://github.com/websockets/ws/blob/8.11.0/doc/ws.md#event-message
        ws.on('message', (data, is_binary) => {
            if (!is_binary) {
                try {
                    const m = JSON.parse(data.toString())
                    if (m.kind === "start") {
                        // Contains metadata (read-up-to write_id, read type (full, changes only, no changes)).
                        ret.start = m;
                    }
                    if (m.kind === "keys_and_values") {
                        _.extend(ret.keys_and_values, m.keys_and_values);
                    }
                    if (m.kind === "deleted_keys") {
                        ret.deleted_keys = m.deleted_keys;
                    }
                    if (m.kind === "end") {
                        resolve(ret);
                        ws.close();
                        return;
                    }
                    return;

                } catch (e) {
                    console.error(e);
                }
                // resolve
            } else {
                console.error("Binary ws message received (should not have been sent).", data);
            }
            ws.close();
            reject("Could not parse JSON")
        });

    });
}


export {
    get_full_list_of_durable_objects,
    get_kvs_from_durable_object
}