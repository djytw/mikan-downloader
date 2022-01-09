import fetch from 'node-fetch'
import { XMLParser } from 'fast-xml-parser'

interface MikanConfig {
    interval: number;
    jsonrpc: string;
    secret: string | undefined;
    folder: string;
    list: Array<MikanItem>;
}

interface MikanItem {
    title: string;
    rss: string;
    key: string;
}

interface RPCParams {
    params: Array<any>;
    method: string;
}

class MikanInfo {
    constructor(
        public hash: string,
        public time: string,
        public title: string,
        public torrent: string
    ){}
}

export declare class MikanLogger {
    debug(message: any, ...args: any[]): void;
    info(message: any, ...args: any[]): void;
    warn(message: any, ...args: any[]): void;
    error(message: any, ...args: any[]): void;
}

export class MikanMonitor {

    private static parser = new XMLParser({ignoreAttributes: false});
    private static jsonrpc_getVersion: RPCParams = {
        "method": "aria2.getVersion",
        "params": []
    };
    private static jsonrpc_addTorrent: RPCParams = {
        "method": "aria2.addTorrent",
        "params": []
    };

    public config: MikanConfig;
    private secret: string;
    private logger: MikanLogger;
    private ignoreHash: (hash: string) => boolean;

    constructor(config: MikanConfig, logger: MikanLogger, ignoreHash: (hash: string) => boolean) {
        this.config = config;
        this.secret = ["token:", config.secret].join("");
        this.logger = logger;
        this.ignoreHash = ignoreHash;
    }

    private formRPC(obj: RPCParams) {
        obj.params.unshift(this.secret);
        (obj as any).id = 'mikan';
        return JSON.stringify(obj);
    }

    public async connectionTest() {
        const request = JSON.parse(JSON.stringify(MikanMonitor.jsonrpc_getVersion));
        return fetch(this.config.jsonrpc, {
            method: "POST",
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: this.formRPC(request)
        })
        .then(response => response.json() as any)
        .then(data => {
            if (data.error) {
                throw new Error("RPC Connection failed. reason: " + JSON.stringify(data.error));
            }
            return data.result?.enabledFeatures instanceof Array && data.result.enabledFeatures.includes('BitTorrent')
        })
        .catch(err => {
            this.logger.error(err.message);
            return false;
        })
    }

    public async download(hash: string, torrent: string) {
        const request = JSON.parse(JSON.stringify(MikanMonitor.jsonrpc_addTorrent));
        return fetch(torrent)
            .then(response => response.arrayBuffer())
            .then(data => Buffer.from(data).toString("base64"))
            .then(data => {
                request.params = [data, [], {dir: this.config.folder + "/" + hash + "/"}];
                return fetch(this.config.jsonrpc, {
                    method: "POST",
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: this.formRPC(request)
                });
            })
            .then(response => response.json() as any)
            .catch(err => {
                this.logger.error("Download error: " + err.message);
            })
    }

    public async getUpdates() {
        const tasks = this.config.list.map(req =>
            fetch(req.rss)
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
                            .map(item => 
                                new MikanInfo(
                                    item.link.split("/").pop(),
                                    item.torrent.pubDate,
                                    item.title,
                                    item.enclosure["@_url"]
                                )
                            );
                    }
                    if (typeof items.link === "string" || items.link instanceof String) {
                        if (!items.title.includes(req.key)) {
                            return [];
                        } else {
                            return [new MikanInfo(
                                       items.link.split("/").pop(),
                                       items.torrent.pubDate,
                                       items.title,
                                       items.enclosure["@_url"]
                                   )];
                        }
                    }
                    this.logger.error("Invalid response: " + JSON.stringify(items));
                    return [];
                })
                .catch(err => {
                    this.logger.error("RSS error: " + err.message);
                    return [];
                })
        )
        return Promise.all(tasks)
            .then(results => results.flat().filter(i => !this.ignoreHash(i.hash)));
    }
    
}
