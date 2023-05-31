#!/usr/bin/env node --enable-source-maps
import {get_cli_args_as_obj, is_dev, override_console_logging} from "./lib/util";
import {init} from "./core";
import package_json from "./../package.json";
import {esbuild_vars} from "./lib/esbuild_vars";
import {read_config_from_file} from "./lib-app/util";
import * as _ from "lodash";


// Clear terminal when running nodemon during dev.
if (is_dev()) {
    console.clear();
}

const get_config = () => {
    const kv = get_cli_args_as_obj(process.argv);
    if ("version" in kv) {
        console.log(`Version: ${package_json.version}`);
        process.exit();
    }

    const opts = {};
    if ("config-file" in kv) {
        opts.config_file = kv["config-file"];
    } else {
        console.log(`Provide "--config-file ./example-path/example-file.json" arg to CLI.`);
        process.exit();
    }

    const config = read_config_from_file(opts.config_file);
    const defaults = {
        concurrent_downloads: 50,
        logging: {
            ndjson: false
        }
    }

    return _.merge({}, defaults, config);
}


const config = get_config();

override_console_logging(["warn", "log", "info", "debug"], {dir: '/tmp/durafetch-client-log', ...config.logging});


// console.log({is_dev: is_dev()});
// console.log({...esbuild_vars});
const run = async () => {
    const ins = init({config});
    if (_.isObject(config.poll) && _.isInteger(config.poll.every_ms)) {
        await ins.poll(config.poll);
    } else {
        await ins.start();
        console.log("Complete.");
    }
}

run();





