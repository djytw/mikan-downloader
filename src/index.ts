import * as fs from "fs";
import * as process from "process";
import {MikanMonitor} from "./Mikan";

const logger = {
    time: () => "[" + new Date().toISOString() + "]",
    write: (log: any) => {
        fs.appendFileSync("debug.log", log + "\n");
    },
    debug: (log: any) => {
        console.debug("\x1B[0m" + logger.time() + "[DEBUG]", log);
        logger.write(logger.time() + "[DEBUG] " + log);
    },
    info: (log: any) => {
        console.info("\x1B[36m" + logger.time() + "[INFO]\x1B[0m", log);
        logger.write(logger.time() + "[INFO] " + log);
    },
    warn: (log: any) => {
        console.warn("\x1B[33m" + logger.time() + "[WARN]\x1B[0m", log);
        logger.write(logger.time() + "[WARN] " + log);
    },
    error: (log: any) => {
        console.error("\x1B[31m" + logger.time() + "[ERROR]\x1B[0m", log);
        logger.write(logger.time() + "[ERROR] " + log);
    }
};

function updateFinishedHash() {
    try {
        finishedHash = fs
            .readFileSync("finished.log")
            .toString()
            .split("\n");
    } catch (ignored) {
        finishedHash = [];
    }
}


let finishedHash: string[] = [];
updateFinishedHash();
const mikan = new MikanMonitor(
    JSON.parse(fs.readFileSync("./config.json").toString()), 
    logger,
    hash => finishedHash.includes(hash)
);
run(mikan).catch(() => {
    process.exit(0);
});

async function run(mikan: MikanMonitor) {

    return mikan.connectionTest().then(result => {
        if (!result) {
            logger.error("Failed to connect to RPC server.")
            throw "Failed to connect to RPC server.";
        }
        return mikan.getUpdates();
    }).then(data => {
        if (data.length == 0) {
            logger.debug("No updates.");
        }
        return Promise.all(data.map(async item => {
            logger.info("Mikan Update | " + item.time + " | " + item.title);
            const data = await mikan.download(item.hash, item.torrent);
            if (data !== undefined && (typeof data.result === "string" || data.result instanceof String)) {
                logger.info("Start download: " + item.title);
                logger.debug(" -> Hash: " + item.hash + ", ID: " + data.result);
                fs.appendFileSync("finished.log", item.hash + "\n");
                updateFinishedHash();
                return;
            }
            logger.error("Download failed: " + item.title);
            logger.error(data);
        }))
    }).then(() => {
        setTimeout(() => run(mikan), mikan.config.interval * 1000);
    })

}
