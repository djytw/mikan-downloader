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
    private static toBase64 = (typeof window !== 'undefined' && window.btoa) ? this.toBase64_browser : this.toBase64_node;

    private static toBase64_browser(buffer: ArrayBuffer) {
        let bin = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i ++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return window.btoa(bin);
    }

    private static toBase64_node(buffer: ArrayBuffer) {
        return Buffer.from(buffer).toString("base64");
    }

    private static deepCopy<T>(obj: T) : T{
        return JSON.parse(JSON.stringify(obj));
    }

    private static getMikanInfo(rss: any) {
        return new MikanInfo(
            rss.link.split("/").pop(),
            rss.torrent.pubDate,
            rss.title,
            rss.enclosure["@_url"]
        );
    }

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

    private async formRPC(obj: RPCParams) {
        obj.params.unshift(this.secret);
        (obj as any).id = 'mikan';
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

    public async connectionTest() {
        try {
            const request = MikanMonitor.deepCopy(MikanMonitor.jsonrpc_getVersion);
            const response = await this.formRPC(request);
            const data = await response.json() as any;
            if (data.error) {
                throw new Error("RPC Connection failed. reason: " + JSON.stringify(data.error));
            }
            return data.result?.enabledFeatures instanceof Array && data.result.enabledFeatures.includes('BitTorrent')
        } catch(err: any) {
            if (err && err.message) {
                this.logger.error(err.message);
            } else {
                this.logger.error(err);
            }
            return false;
        }
    }

    public async download(hash: string, torrent: string) {
        try {
            const response = await fetch(torrent);
            const data = MikanMonitor.toBase64(await response.arrayBuffer());
            const request = MikanMonitor.deepCopy(MikanMonitor.jsonrpc_addTorrent);
            request.params = [data, [], {dir: this.config.folder + "/" + hash + "/"}];
            const response2 = await this.formRPC(request);
            return await response2.json() as any;
        } catch (err: any) {
            if (err && err.message) {
                this.logger.error(err.message);
            } else {
                this.logger.error(err);
            }
            return undefined;
        }
    }

    public async getUpdates() {
        const tasks = this.config.list.map(async req => {
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
                    } else {
                        return [MikanMonitor.getMikanInfo(items)];
                    }
                }
                this.logger.error("Invalid response: " + JSON.stringify(items));
                return [];
            } catch (err: any) {
                if (err && err.message) {
                    this.logger.error("RSS error: " + err.message);
                } else {
                    this.logger.error("RSS error: " + err);
                }
                return [];
            }
        });
        return Promise.all(tasks)
            .then(results => results.flat().filter(i => !this.ignoreHash(i.hash)));
    }
}
