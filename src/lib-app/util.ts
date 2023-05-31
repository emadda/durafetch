import * as fs from "fs";


const read_config_from_file = (file_path) => {
    if (!file_path.endsWith(".json")) {
        console.log("Config file must end in .json");
        process.exit(1);
    }

    let text = null;
    try {
        text = fs.readFileSync(file_path, {encoding: 'utf8', flag: 'r'});
    } catch (e) {
        console.error(`Could not read config file from: ${file_path}`);
        console.error(e);
        process.exit(1);
    }

    try {
        // @todo/low Validate config data type.
        return JSON.parse(text);
    } catch (e) {
        console.error(`Could not read config file from: ${file_path} - not valid JSON.`);
        console.error(e);
        process.exit(1);
    }
};


export {
    read_config_from_file
}