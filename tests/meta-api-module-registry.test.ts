import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildMetaApiPrefixMap,
    buildMetaApiReference,
    loadMetaApiModuleRegistry,
    lookupMetaApiDocs,
} from "../src/meta-sandbox/meta-api/module-registry.js";

describe("Meta API module registry", () => {
    it("builds prompt and two-pass docs from module declarations", () => {
        const registry = loadMetaApiModuleRegistry();
        const names = registry.map((entry) => entry.name).sort();

        assert.ok(names.includes("conversations"));
        assert.ok(names.includes("dispatch"));
        assert.ok(names.includes("remind"));

        const reference = buildMetaApiReference();
        assert.match(reference, /## dispatch/);
        assert.match(reference, /taskToGroup/);
        assert.doesNotMatch(reference, /@example/);

        const prefixMap = buildMetaApiPrefixMap();
        assert.equal(prefixMap.dispatch, "dispatch");

        const docs = lookupMetaApiDocs(["dispatch.taskToGroup"]);
        assert.match(docs, /### dispatch\.taskToGroup/);
        assert.match(docs, /DispatchTaskSpec/);
        assert.match(docs, /tracking/);
    });
});
