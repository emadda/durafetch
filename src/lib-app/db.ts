import Database from 'better-sqlite3';
import * as _ from "lodash";

// Handling BUSY/DB locked.
// - Issue: With high lock contention, the Node.js process will be blocked waiting for large amounts of time.
//      - Possible fix: Use threads/get read/write tx in a thread, hand over to main.
//          - @see https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md
//
// https://github.com/WiseLibs/better-sqlite3/issues/155#issuecomment-419746924


const schema = [
    // local_max_x keys are stored here because deleting rows from the `kv` table will remove the max vals.
    `
    CREATE TABLE IF NOT EXISTS durable_objects (
        do_id INTEGER PRIMARY KEY,
        worker_name TEXT NOT NULL,
        class_name TEXT NOT NULL,
        name TEXT,
        id TEXT,
        
        last_started_at TEXT,
        
        log_id TEXT,
        write_id INTEGER,
        
        local_max_log_id TEXT,
        local_max_write_id INTEGER,
        
        insert_ts TEXT,
        update_ts TEXT
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS i_durable_objects_id ON durable_objects(id)`,
    `CREATE INDEX IF NOT EXISTS i_durable_objects_name ON durable_objects(name)`,

    // read_at_x is the position that the value was read at to insert into this table (not always the write_id when it was written - it could be a later one as all changed values are batched into a single read at the current_write_id).
    // `id` FK not used to save space (it's a sha1 hex like hash), do_id used instead (20 bytes vs 4 bytes).
    `
    CREATE TABLE IF NOT EXISTS kv (
        val_id INTEGER PRIMARY KEY,
        do_id INTEGER NOT NULL,
        
        worker_name TEXT NOT NULL,
        class_name TEXT NOT NULL,
        name TEXT,
        
        key TEXT NOT NULL,
        val TEXT,
        
        read_at_log_id TEXT NOT NULL,
        read_at_write_id INTEGER NOT NULL,
        
        insert_ts TEXT,
        update_ts TEXT
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS i_kv_key ON kv(do_id, key)`,
    `CREATE INDEX IF NOT EXISTS i_kv_name ON kv(name)`,
    `CREATE INDEX IF NOT EXISTS i_kv_write_id ON kv(read_at_log_id, read_at_write_id)`,
];


const create_db_if_not_exists = (db, schema) => {
    const run_tx = db.transaction(() => {
        for (const one of schema) {
            const stmt = db.prepare(one);
            const info = stmt.run();
        }
    });

    run_tx();
}

// Convert strings that contain ISO dates to real dates.
// 2022-08-22T23:35:39.474Z
const dateFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const reviver = (key, value) => {
    if (typeof value === "string" && dateFormat.test(value)) {
        return new Date(value);
    }

    return value;
}

const json_parse = (x) => {
    return JSON.parse(x, reviver)
};


const now = `datetime('now')`;


const get_db = (db_file) => {
    const db = new Database(db_file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 30000');

    // Tables must exist for prepared statements to work.
    create_db_if_not_exists(db, schema);
    console.log("DB file exists", {db_file});

    const stmt_durable_objects = {
        // @todo/high Do not overwrite a string name with null (in the case the same durable object is referenced by name, and then later by id).
        upsert: db.prepare(`
            INSERT INTO durable_objects (worker_name, class_name, name, id, last_started_at, log_id, write_id, insert_ts, update_ts) VALUES (:worker_name, :class_name, :name, :id, :last_started_at, :log_id, :write_id, ${now}, ${now})
            ON CONFLICT DO
            UPDATE SET (last_started_at, log_id, write_id, update_ts) = (:last_started_at, :log_id, :write_id, ${now}) WHERE id = :id
        `),

        update_local_max_write_id: db.prepare(`
            UPDATE durable_objects SET (local_max_log_id, local_max_write_id, update_ts) = (:local_max_log_id, :local_max_write_id, ${now}) WHERE id = :id
        `),

        get_local_max_write_id: db.prepare(`SELECT local_max_log_id, local_max_write_id FROM durable_objects WHERE id = :id`),

        clear_local_max_write_id_if_different_from_remote: db.prepare(`UPDATE durable_objects SET (local_max_log_id, local_max_write_id) = (NULL, 0) WHERE log_id IS NOT NULL AND local_max_log_id IS NOT NULL AND log_id != local_max_log_id`),
    };

    const tbl_durable_objects = {
        upsert: (x) => {
            return stmt_durable_objects.upsert.run(x);
        },

        update_local_max_write_id: (x) => {
            return stmt_durable_objects.update_local_max_write_id.run(x);
        },

        get_local_max_write_id: (x) => {
            const row = stmt_durable_objects.get_local_max_write_id.get(x);
            if (row === undefined) {
                return null;
            }

            return {
                log_id: row.local_max_log_id,
                write_id: row.local_max_write_id,
            }
        },

        clear_local_max_write_id_if_different_from_remote: () => {
            return stmt_durable_objects.clear_local_max_write_id_if_different_from_remote.run();
        }
    }


    const stmt_kv = {
        // Conflict triggered by any unique index constraint, update applies to the single row with the constraint.
        upsert: db.prepare(`
            INSERT INTO kv (do_id, worker_name, class_name, name, key, val, read_at_log_id, read_at_write_id, insert_ts, update_ts) VALUES ((select do_id from durable_objects where id = :id), :worker_name, :class_name, :name, :key, :val, :read_at_log_id, :read_at_write_id, ${now}, ${now})
            ON CONFLICT DO
            UPDATE SET (val, read_at_log_id, read_at_write_id, update_ts) = (:val, :read_at_log_id, :read_at_write_id, ${now})            
        `),

        // @todo/low Optimization: Maybe faster to keep track of log_id change as durable_object is upserted, and then delete via kv.do_id in a loop.
        delete_all_keys_that_do_not_match_current_latest_log_id: db.prepare(`DELETE FROM kv AS kv WHERE read_at_log_id != (SELECT log_id FROM durable_objects do WHERE do.do_id = kv.do_id)`),

        delete: db.prepare(`DELETE FROM kv AS kv WHERE do_id = (SELECT do_id FROM durable_objects WHERE id = :id) AND key = :key`),

    };

    const tbl_kv = {
        upsert: (x) => {
            return stmt_kv.upsert.run(x);
        },

        // `storage.deleteAll` starts a new write branch (indicated by a change in log_id).
        // - Delete old key/vals in preparation for receiving the new writes since the `deleteAll`.
        delete_all_keys_that_do_not_match_current_latest_log_id: () => {
            const res = stmt_kv.delete_all_keys_that_do_not_match_current_latest_log_id.run();

            // Target the same DO's as the above query.
            tbl_durable_objects.clear_local_max_write_id_if_different_from_remote();
            return res;
        },

        delete: (x) => {
            return stmt_kv.delete.run(x);
        },
    }

    const util = {
        // Write tx - gets immediate write lock.
        wtx: (fn) => {
            return db.transaction(fn).immediate();
        },
        // Read tx.
        rtx: (fn) => {
            return db.transaction(fn)();
        },
    }


    return {
        db,

        wtx: util.wtx,
        rtx: util.rtx,

        tbl_durable_objects,
        tbl_kv
    }


};


export {
    get_db
}