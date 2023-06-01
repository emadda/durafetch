#!/usr/bin/env node

// Moves multiple remote durable objects through different state steps, runs the `durafetch` CLI after each step and checks the SQLite db reflects the correct state.
//
// Steps:
// 1. do_started
// 2. create
// 3. update
// 4. delete
// 5. delete_all
//
// - Must be running the CF worker for this test: `durafetch-server/test/worker-2`

const test = require("node:test");
const assert = require('assert');
const fs = require("fs");
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const Database = require('better-sqlite3');
const _ = require("lodash");

const server = `http://127.0.0.1:8787`;
const auth_token = "secret_http_auth_bearer_token_replace_this_with_more_than_40_chars";
const db_file = `db/test-01.sqlite`;


const config = JSON.parse(fs.readFileSync("config.json", {encoding: 'utf8', flag: 'r'}));

// Subdomain is required for the worker routing to correctly route to the DURAFETCH_DO `fetch` handler.
// const durafetch_server = `http://durafetch_worker-2.localhost:8787`;
const url = new URL(config.servers[0].ws_url);
const durafetch_server = `http://${url.host}`


const sleep = async (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const delete_db = async () => {
    return exec(`rm -rf ${db_file}*`);
}

const delete_do_list_from_server = async () => {
    return fetch(
        `${durafetch_server}/external/do/delete_all`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                'Authorization': `Bearer ${auth_token}`
            },
            body: JSON.stringify({})
        }
    );
};

const run_durafetch_once = async () => {
    return exec('node ./../../dist/cli.js --config-file config.json');
}

const set_step_many = async (body) => {
    return fetch(
        `${server}/set-step-many`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );
}

const get_entire_db = () => {
    const db = new Database(db_file);

    return {
        durable_objects: db.prepare(`SELECT * FROM durable_objects`).all(),
        kv: db.prepare(`SELECT * FROM kv`).all(),
    }
}

const assert_step_1 = (name_prefix, names) => {
    const db = get_entire_db();

    // Durable objects exist with no saved key/vals.
    return (
        db.kv.length === 0 &&
        _.isEqual(db.durable_objects.map(x => x.name).sort(), names)
    )
}

const assert_step_2 = (name_prefix, names) => {
    const db = get_entire_db();

    // Keys exist.
    return (
        db.kv.length === names.length * 4 &&
        _.isEqual(db.durable_objects.map(x => x.name).sort(), names)
    )
}


const assert_step_3 = (name_prefix, names) => {
    const db = get_entire_db();


    // Keys exist with updated vals.
    return (
        db.kv.length === names.length * 4 &&
        // Note: all vals are strings.
        db.kv.every(x => x.val === '2') &&
        _.isEqual(db.durable_objects.map(x => x.name).sort(), names)
    )
}


const assert_step_4 = (name_prefix, names) => {
    const db = get_entire_db();

    // Keys deleted except for `key-d`
    return (
        db.kv.length === names.length &&
        // Note: all vals are strings.
        db.kv.every(x => x.key === 'key-d') &&
        db.kv.every(x => x.val === '2') &&
        _.isEqual(db.durable_objects.map(x => x.name).sort(), names)
    )
}


const assert_step_5 = (name_prefix, names) => {
    const db = get_entire_db();

    // `storage.deleteAll` removes all keys, but keeps the objects in the list.
    return (
        db.kv.length === 0 &&
        _.isEqual(db.durable_objects.map(x => x.name).sort(), names)
    )
}


const number_of_durable_objects = 30;
const run = async () => {
    let x;
    const now = new Date();
    const name_prefix = now.toISOString();

    await delete_do_list_from_server();
    console.log("Deleted the Durable Object list from DURAFETCH_DO so that the DO's from previous runs will not be read.");


    await delete_db();
    console.log("Deleted previous test db file.");
    console.log(`Using db file: ${db_file}.`);


    // Generate list of durable object names.
    const names = [];
    for (let i = 1; i <= number_of_durable_objects; i++) {
        names.push(`${name_prefix}/${i.toString().padStart(5, '0')}`);
    }
    console.log("Using durable object names", {names});

    // @todo/low Allow `deleteAll` on DURAFETCH_DO using `fetch` to clear the list of DO's. In dev just restart the dev server.


    console.log(`Setting step-1`);
    await set_step_many({
        names,
        step: `step-1`
    });

    console.log("Running durafetch once");
    x = await run_durafetch_once();

    test("STEP 1", (t) => {
        assert.strictEqual(assert_step_1(name_prefix, names), true);
    });


    console.log(`Setting step-2`);
    await set_step_many({
        names,
        step: `step-2`
    });

    console.log("Running durafetch once");
    x = await run_durafetch_once();

    test("STEP 2", (t) => {
        assert.strictEqual(assert_step_2(name_prefix, names), true);
    });


    console.log(`Setting step-3`);
    await set_step_many({
        names,
        step: `step-3`
    });

    console.log("Running durafetch once");
    x = await run_durafetch_once();

    test("STEP 3", (t) => {
        assert.strictEqual(assert_step_3(name_prefix, names), true);
    });


    console.log(`Setting step-4`);
    await set_step_many({
        names,
        step: `step-4`
    });

    console.log("Running durafetch once");
    x = await run_durafetch_once();

    test("STEP 4", (t) => {
        assert.strictEqual(assert_step_4(name_prefix, names), true);
    });


    console.log(`Setting step-5`);
    await set_step_many({
        names,
        step: `step-5`
    });

    console.log("Running durafetch once");
    x = await run_durafetch_once();

    test("STEP 5", (t) => {
        assert.strictEqual(assert_step_5(name_prefix, names), true);
    });


    // Run step-2 again to ensure that writes after deleteAll are still downloaded. (a deleteAll would also delete any durafetch meta data stored in the durable object).
    console.log(`Setting step-2 (again)`);
    await set_step_many({
        names,
        step: `step-2`
    });

    // After writes occur on a DO they notify DURAFETCH_DO, but rate limited at once per 100ms.
    // - Wait for this notification of the latest writes to happen before trying to download.
    await sleep(100);

    console.log("Running durafetch once");
    x = await run_durafetch_once();


    test("STEP 2 AGAIN", (t) => {
        assert.strictEqual(assert_step_2(name_prefix, names), true);
    });


    // @todo/low Test downloading with 128MB+ stored state.

}


run();