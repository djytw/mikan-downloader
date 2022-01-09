import * as fs from 'fs';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

class MikanInfo {
    hash;
    time;
    title;
    torrent;
    constructor(hash, time, title, torrent) {
        this.hash = hash;
        this.time = time;
        this.title = title;
        this.torrent = torrent;
    }
}
class MikanMonitor {
    static parser = new XMLParser({ ignoreAttributes: false });
    static jsonrpc_getVersion = {
        "method": "aria2.getVersion",
        "params": []
    };
    static jsonrpc_addTorrent = {
        "method": "aria2.addTorrent",
        "params": []
    };
    config;
    secret;
    logger;
    ignoreHash;
    constructor(config, logger, ignoreHash) {
        this.config = config;
        this.secret = ["token:", config.secret].join("");
        this.logger = logger;
        this.ignoreHash = ignoreHash;
    }
    formRPC(obj) {
        obj.params.unshift(this.secret);
        obj.id = 'mikan';
        return JSON.stringify(obj);
    }
    async connectionTest() {
        const request = JSON.parse(JSON.stringify(MikanMonitor.jsonrpc_getVersion));
        return fetch(this.config.jsonrpc, {
            method: "POST",
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: this.formRPC(request)
        })
            .then(response => response.json())
            .then(data => {
            if (data.error) {
                throw new Error("RPC Connection failed. reason: " + JSON.stringify(data.error));
            }
            return data.result?.enabledFeatures instanceof Array && data.result.enabledFeatures.includes('BitTorrent');
        })
            .catch(err => {
            this.logger.error(err.message);
            return false;
        });
    }
    async download(hash, torrent) {
        const request = JSON.parse(JSON.stringify(MikanMonitor.jsonrpc_addTorrent));
        return fetch(torrent)
            .then(response => response.arrayBuffer())
            .then(data => Buffer.from(data).toString("base64"))
            .then(data => {
            request.params = [data, [], { dir: this.config.folder + "/" + hash + "/" }];
            return fetch(this.config.jsonrpc, {
                method: "POST",
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: this.formRPC(request)
            });
        })
            .then(response => response.json())
            .catch(err => {
            this.logger.error("Download error: " + err.message);
        });
    }
    async getUpdates() {
        const tasks = this.config.list.map(req => fetch(req.rss)
            .then(response => response.text())
            .then(data => MikanMonitor.parser.parse(data))
            .then(data => data.rss?.channel?.item)
            .then(items => {
            if (items === null || items === undefined) {
                this.logger.warn("No data: " + req.title);
                return [];
            }
            if (items instanceof Array) {
                return items
                    .filter(item => item.title.includes(req.key))
                    .map(item => new MikanInfo(item.link.split("/").pop(), item.torrent.pubDate, item.title, item.enclosure["@_url"]));
            }
            if (typeof items.link === "string" || items.link instanceof String) {
                if (!items.title.includes(req.key)) {
                    return [];
                }
                else {
                    return [new MikanInfo(items.link.split("/").pop(), items.torrent.pubDate, items.title, items.enclosure["@_url"])];
                }
            }
            this.logger.error("Invalid response: " + JSON.stringify(items));
            return [];
        })
            .catch(err => {
            this.logger.error("RSS error: " + err.message);
            return [];
        }));
        return Promise.all(tasks)
            .then(results => results.flat().filter(i => !this.ignoreHash(i.hash)));
    }
}

const logger = {
    time: () => "[" + new Date().toISOString() + "]",
    write: (log) => {
        fs.appendFileSync("debug.log", log + "\n");
    },
    debug: (log) => {
        console.debug("\x1B[0m" + logger.time() + "[DEBUG]", log);
        logger.write(logger.time() + "[DEBUG] " + log);
    },
    info: (log) => {
        console.info("\x1B[36m" + logger.time() + "[INFO]\x1B[0m", log);
        logger.write(logger.time() + "[INFO] " + log);
    },
    warn: (log) => {
        console.warn("\x1B[33m" + logger.time() + "[WARN]\x1B[0m", log);
        logger.write(logger.time() + "[WARN] " + log);
    },
    error: (log) => {
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
    }
    catch (ignored) {
        finishedHash = [];
    }
}
let finishedHash = [];
updateFinishedHash();
const mikan = new MikanMonitor(JSON.parse(fs.readFileSync("./config.json").toString()), logger, hash => finishedHash.includes(hash));
run(mikan);
async function run(mikan) {
    return mikan.connectionTest().then(result => {
        if (!result) {
            logger.error("Failed to connect to RPC server.");
            throw "Failed to connect to RPC server.";
        }
        return mikan.getUpdates();
    }).then(data => {
        if (data.length == 0) {
            logger.debug("No updates.");
        }
        return Promise.all(data.map(async (item) => {
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
        }));
    }).then(() => {
        setTimeout(() => run(mikan), mikan.config.interval * 1000);
    });
}
