import fs from "fs";
import * as _ from "lodash";
import {esbuild_vars} from "./esbuild_vars";

const sleep = async (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const is_dev = () => {
    const default_node_env = esbuild_vars.NODE_ENV;

    // Allow override by setting `NODE_ENV=x node x.js` (no re-build needed).
    if ("NODE_ENV" in process.env) {
        return process.env["NODE_ENV"] !== 'production';
    }

    return default_node_env !== "production";
}

// Issue: `console.log`:
// - Does not add timestamps.
// - Pretty prints JSON, which is good in dev but does not work with some stdout log collectors (like gcloud/docker).
//
// Fix:
// - Use ndjson.
//      - In dev, pretty print the lines and write to a file so the JSON event/values can be easily read.
//      - In prod, just output vanilla ndjson, one JSON per line.
//
// @see https://stackoverflow.com/a/18815667/4949386 (override console.log)
// @see https://stackoverflow.com/a/33707230/4949386 (console.dir)
//
// Note: using override of console.log instead of a custom `log` function to avoid dependencies having to depend on and import this util file.
// - This will allow reverting to the old standard console.log in the future.
const override_console_logging = (keys = [], opts) => {
    const {ndjson = false} = opts;

    let f = null;

    // @todo/low Allow writing a second ndjson stream to a log file.
    // if (false) {
    //     // Write pretty formatted ndjson to file (stdout is used for easy-to-read version in dev, and flat ndjson in prod).
    //     // - Enables using a text editor to grep and view the event log for a specific run.
    //     const dir = opts.dir;
    //     if (!fs.existsSync(dir)) {
    //         fs.mkdirSync(dir);
    //     }
    //     let date = (new Date()).toISOString().replace("Z", "").replaceAll(/[^\d]/g, "_");
    //     f = `${dir}/${date}.json`;
    // }

    for (const k of keys) {
        const orig = console[k];

        console[k] = (...args) => {

            const o = {
                ts: (new Date).toISOString(),
                level: k,
                msg: null
            }

            let [msg = null, data = null] = args;

            if (_.isString(msg)) {
                o.msg = msg;
            } else if (_.isObject(msg) || _.isArray(msg)) {
                if (_.isObject(data) || _.isArray(data)) {
                    throw Error("Passed two objects to console.log. Use an object, a string, or a string then object.");
                }
                data = msg;
            }


            if (_.isObject(data) || _.isArray(data)) {
                o.data = data;
            } else if (data !== null) {
                throw Error("Second arg to console.log was not an object or array");
            }

            if (!ndjson) {
                // Pretty print
                // Issue: too difficult to scan during dev.
                // console.dir(o, {depth: null, colors: true});


                orig.apply(console, [""]);

                // When: `console.log({x: 1})`, data will equal object, msg=null.
                if (o.msg !== null) {
                    orig.apply(console, [o.msg]);
                }

                if ("data" in o) {
                    console.dir(o.data, {depth: null, colors: true});
                }


                // orig.apply(console, [JSON.stringify(o, null, 4)]);
            } else {
                // ndjson
                orig.apply(console, [JSON.stringify(o)]);
            }

        };
    }


};


const get_cli_args_as_obj = (argv) => {
    const args = argv.slice(2);

    try {
        const o = [];
        for (const x of args) {
            if (x.startsWith(`--`)) {
                // Key
                o.push([x.replace(/^--/, ""), null])
            } else {
                // Value
                _.last(o)[1] = x;
            }
        }

        return _.fromPairs(o);
    } catch (e) {
    }

    return null;
}

export {
    is_dev,
    override_console_logging,
    sleep,
    get_cli_args_as_obj
}