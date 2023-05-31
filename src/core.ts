import * as _ from "lodash";
import fs from "fs";
import path from 'path';
import {is_dev, sleep} from "./lib/util";
import {get_full_list_of_durable_objects, get_kvs_from_durable_object} from "./lib-app/api";
import {get_db} from "./lib-app/db";


const get_db_from_config = (config) => {
    // const config = read_config_from_file(opts.config_file);

    if (true && is_dev()) {
        console.log("Deleting database during dev", {db_file: config.db_file});
        try {
            fs.unlinkSync(config.db_file);
            fs.unlinkSync(config.db_file + "-shm");
            fs.unlinkSync(config.db_file + "-wal");
        } catch (e) {
            // When: WAL files do not exist as they have been merged.
        }

    }

    // console.log({
    //     __filename,
    //     __dirname,
    //     cwd: process.cwd()
    // });

    // @todo/low Check if better-sqlite3 has fixes for these issues (or bundling support).
    // Avoid these two errors:
    // 1. Error: Could not find module root given file: "node:internal/modules/cjs/loader". Do you have a `package.json` file?
    // 2. Error: Could not locate the bindings file. Tried:

    // When `better-sqlite3` is first initialized it assumes it is running with a cwd of the npm root.
    // - This is not the case when installing it globally (run from anywhere) or running it in dev from any other dir.
    // Fix: Set the cwd to the npm root, init the DB, then set it back (for reading files relative to the cli cwd).


    const orig_cwd = process.cwd();

    // Must be absolute as better-sqlite3 resolves relative to cwd.
    const abs_db_file = path.join(orig_cwd, config.db_file);
    // console.log({abs_db_file});


    const npm_root = __dirname.replace(/dist$/, "");

    process.chdir(npm_root);
    const db = get_db(abs_db_file);
    process.chdir(orig_cwd);


    return {
        db
    }
}

// For logging.
const get_server_id = (server) => {
    return {
        ws_url: server.ws_url
    }
}


const do_to_row = (x) => {
    const write_id = {

        // A DO will not have a write_id when there have been no writes.
        // @todo/low A DO may have data but not write_id (when adding DF to an existing DO where the writes happened before the write functions were wrapped).
        log_id: null,
        write_id: null,


        ...(_.isObject(x.cur_write_id) ? x.cur_write_id : {})
    }

    return {
        ...x.obj,
        ...write_id
    }
}

const readact_secrets = (config) => {
    const x = _.cloneDeep(config);
    for (const s of x.servers) {
        s.auth_token = "REDACTED"
    }
    return x;
}


const init = (opts) => {
    const {config} = opts;

    const {db} = get_db_from_config(config);

    console.log("Using config", readact_secrets(config));

    const start = async () => {
        // Multiple servers write to a single DB file.
        // - Each CF worker exposes a ws server.
        // - Avoid having to use service bindings in CF workers which are difficult to coordinate between workers.
        for (const s of config.servers) {
            await download_all_from_one_worker(s);
        }
    }

    // Download all the data from every Durable Object within a given workers namespace.
    const download_all_from_one_worker = async (server_opts) => {
        // const {
        //     ws_url,
        //     auth_token
        // } = opts;
        const server_id = get_server_id(server_opts);


        console.log(`Downloading current list of Durable Objects.`, server_id);
        const all = (await get_full_list_of_durable_objects(server_opts)).durable_object_list;
        console.log({all});
        const rows = all.map((x) => do_to_row(x));

        if (rows.length === 0) {
            console.log("Durable Objects list is empty - no key/values to download.", server_id);
            return;
        }


        db.wtx(() => {
            for (const x of rows) {
                const {changes} = db.tbl_durable_objects.upsert(x);
                if (changes !== 1) {
                    throw Error("Row not written.");
                }
            }

            const {changes} = db.tbl_kv.delete_all_keys_that_do_not_match_current_latest_log_id();
            if (changes > 0) {
                console.log(`Deleted ${changes} old key/vals (they were deleted via 'storage.deleteAll').`);
            }
        });

        console.log(`Wrote ${all.length} Durable Object id's to db.`, server_id);
        console.log(`Downloading all key/vals from all Durable Objects. Using up to ${config.concurrent_downloads} concurrent WebSocket connections (directly connecting to each Durable Object).`, server_id);

        const to_download = filter_only_needs_download(rows);
        const queue = [...to_download].reverse();

        if (queue.length === 0) {
            console.log(`All Durable Objects up to date - no download needed.`, server_id);
            return;
        }


        console.log({queue});

        const default_stat = {
            objects_matching: 0,
            kv_rows_changed: 0,
        }

        const stats = {
            from_start: {...default_stat},
            changes_only: {...default_stat},
            no_changes: {...default_stat},
        };
        const tasks = [];
        for (let i = 0; i < config.concurrent_downloads; i++) {
            tasks.push(new Promise(async (resolve, reject) => {
                while (queue.length > 0) {
                    const x = queue.pop();
                    console.log(`Downloading key/vals from Durable Object.`, {
                        class_name: x.class_name,
                        name: x.name,
                        id: x.id.slice(0, 8)
                    });
                    const {
                        read_type,
                        changes
                    } = await download_new_kv_data_from_do_write_to_db(server_opts, x);
                    console.log({read_type});
                    stats[read_type].kv_rows_changed += changes;
                    stats[read_type].objects_matching++;
                }
                resolve(null);
            }));
        }

        await Promise.all(tasks);

        console.log(`Downloaded all changes from all Durable Objects (${to_download.length} objects, ${stats.from_start.kv_rows_changed + stats.changes_only.kv_rows_changed} key/vals)`, {
            worker_name: to_download[0].worker_name,
            stats
        });

    }

    const download_new_kv_data_from_do_write_to_db = async (server_opts, durable_object_row) => {
        const max_local_write_id = db.tbl_durable_objects.get_local_max_write_id({id: durable_object_row.id});
        const data = await get_kvs_from_durable_object(server_opts, durable_object_row, max_local_write_id);
        const {read_type} = data.start;

        // Avoid getting DB write lock.
        if (read_type === "no_changes") {
            return {
                read_type,
                changes: 0
            }
        }

        // @todo/next deleteAll should start a new log_id, and delete all old keys.
        // @todo/next delete Should remove the keys that were deleted.
        const {changes} = db.wtx(() => {
            let i = 0;

            for (const [k, v] of _.toPairs(data.keys_and_values)) {
                const row = {
                    // do_id is copied using a sub query.
                    id: durable_object_row.id,
                    worker_name: durable_object_row.worker_name,
                    class_name: durable_object_row.class_name,
                    name: durable_object_row.name,
                    key: k,
                    val: JSON.stringify(v),
                    read_at_log_id: data.start.cur_write_id.log_id,
                    read_at_write_id: data.start.cur_write_id.write_id
                }

                const {changes} = db.tbl_kv.upsert(row);
                if (changes !== 1) {
                    throw Error("DB row not written");
                }

                i += changes;
            }

            for (const key of data.deleted_keys) {
                db.tbl_kv.delete({id: durable_object_row.id, key});
            }

            db.tbl_durable_objects.update_local_max_write_id({
                id: durable_object_row.id,
                local_max_log_id: data.start.cur_write_id.log_id,
                local_max_write_id: data.start.cur_write_id.write_id
            });

            return {
                changes: i
            }
        });

        return {
            read_type,
            changes
        }
    }

    const filter_only_needs_download = (all) => {
        return db.rtx(() => {
            return all.filter((x) => {
                // When: no data stored in DO.
                if (x.log_id === null) {
                    return false;
                }

                const local_max = db.tbl_durable_objects.get_local_max_write_id({id: x.id});

                // local can be a newer write_id if writes happen on the remote after reading the list of durable objects with their current write_id.
                const local_is_same_or_newer = (
                    _.isString(x.log_id) && x.log_id.length > 0 &&
                    (x.log_id === local_max.log_id && x.write_id <= local_max.write_id)
                );

                return !local_is_same_or_newer;
            });
        });
    }


    const poll = async (opts) => {
        while (true) {
            await start();
            await sleep(opts.every_ms);
        }
    }


    return {
        start,
        poll
    }
}


export {
    init
}
