/**
 * opengraph-image-guard.test.ts — og:image 下载的地址检查
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { downloadOgImage } from "../src/core/opengraph.js";

describe("downloadOgImage", () => {
    let server: Server;
    let port = 0;
    let hits = 0;

    before(async () => {
        server = createServer((_req, res) => {
            hits++;
            res.writeHead(200, { "content-type": "image/png" });
            res.end("png");
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    after(() => server.close());

    it("refuses loopback, mapped, link-local and non-http targets without requesting them", async () => {
        for (const url of [
            `http://127.0.0.1:${port}/a.png`,
            `http://localhost:${port}/a.png`,
            `http://[::ffff:127.0.0.1]:${port}/a.png`,
            `http://0x7f000001:${port}/a.png`,
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ]) {
            assert.equal(await downloadOgImage(url, 2000), null, url);
        }
        assert.equal(hits, 0);
    });
});
