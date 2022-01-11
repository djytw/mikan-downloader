import * as fs from 'fs';
import * as process from 'process';
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
    static toBase64 = (typeof window !== 'undefined' && window.btoa) ? this.toBase64_browser : this.toBase64_node;
    static toBase64_browser(buffer) {
        let bin = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return window.btoa(bin);
    }
    static toBase64_node(buffer) {
        return Buffer.from(buffer).toString("base64");
    }
    static deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }
    static getMikanInfo(rss) {
        return new MikanInfo(rss.link.split("/").pop(), rss.torrent.pubDate, rss.title, rss.enclosure["@_url"]);
    }
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
    async formRPC(obj) {
        obj.params.unshift(this.secret);
        obj.id = 'mikan';
        const body = JSON.stringify(obj);
        return fetch(this.config.jsonrpc, {
            method: "POST",
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: body
        });
    }
    async connectionTest() {
        try {
            const request = MikanMonitor.deepCopy(MikanMonitor.jsonrpc_getVersion);
            const response = await this.formRPC(request);
            const data = await response.json();
            if (data.error) {
                throw new Error("RPC Connection failed. reason: " + JSON.stringify(data.error));
            }
            return data.result?.enabledFeatures instanceof Array && data.result.enabledFeatures.includes('BitTorrent');
        }
        catch (err) {
            if (err && err.message) {
                this.logger.error(err.message);
            }
            else {
                this.logger.error(err);
            }
            return false;
        }
    }
    async download(hash, torrent) {
        try {
            const response = await fetch(torrent);
            const data = MikanMonitor.toBase64(await response.arrayBuffer());
            const request = MikanMonitor.deepCopy(MikanMonitor.jsonrpc_addTorrent);
            request.params = [data, [], { dir: this.config.folder + "/" + hash + "/" }];
            const response2 = await this.formRPC(request);
            return await response2.json();
        }
        catch (err) {
            if (err && err.message) {
                this.logger.error(err.message);
            }
            else {
                this.logger.error(err);
            }
            return undefined;
        }
    }
    async getUpdates() {
        const tasks = this.config.list.map(async (req) => {
            try {
                const response = await fetch(req.rss);
                const data = MikanMonitor.parser.parse(await response.text());
                const items = data.rss?.channel?.item;
                if (items === null || items === undefined) {
                    this.logger.warn("No data: " + req.title);
                    return [];
                }
                if (items instanceof Array) {
                    return items
                        .filter(item => item.title.includes(req.key))
                        .map(MikanMonitor.getMikanInfo);
                }
                if (typeof items.link === "string" || items.link instanceof String) {
                    if (!items.title.includes(req.key)) {
                        return [];
                    }
                    else {
                        return [MikanMonitor.getMikanInfo(items)];
                    }
                }
                this.logger.error("Invalid response: " + JSON.stringify(items));
                return [];
            }
            catch (err) {
                if (err && err.message) {
                    this.logger.error("RSS error: " + err.message);
                }
                else {
                    this.logger.error("RSS error: " + err);
                }
                return [];
            }
        });
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
run(mikan).catch(() => {
    process.exit(0);
});
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
