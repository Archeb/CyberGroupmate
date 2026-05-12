import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrefixMap } from "../../sandbox/api-intent-extractor.js";
import {
    generateBriefOverview,
    lookupFullDocs,
    type ModuleEntry,
} from "../../sandbox/modules/module-registry.js";
import { parseDtsFile } from "../../sandbox/dts-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let metaApiRegistryCache: ModuleEntry[] | null = null;
let metaApiReferenceCache: string | null = null;

export function loadMetaApiModuleRegistry(): ModuleEntry[] {
    if (metaApiRegistryCache) {
        return metaApiRegistryCache;
    }

    const modulesDir = join(__dirname, "modules");
    if (!existsSync(modulesDir)) {
        metaApiRegistryCache = [];
        return metaApiRegistryCache;
    }

    metaApiRegistryCache = readdirSync(modulesDir)
        .filter((fileName) => fileName.endsWith(".d.ts"))
        .sort()
        .flatMap((fileName) => {
            const filePath = join(modulesDir, fileName);
            const content = readFileSync(filePath, "utf-8");
            return parseDtsFile(content, `meta-api/${fileName}`);
        })
        .filter((entry) => entry.name !== "default");

    return metaApiRegistryCache;
}

export function buildMetaApiReference(): string {
    if (metaApiReferenceCache) {
        return metaApiReferenceCache;
    }

    const registry = loadMetaApiModuleRegistry();
    metaApiReferenceCache = registry.length > 0
        ? generateBriefOverview(registry)
        : "// Meta API reference not available.";
    return metaApiReferenceCache;
}

export function buildMetaApiPrefixMap(): Record<string, string> {
    return buildPrefixMap(loadMetaApiModuleRegistry());
}

export function lookupMetaApiDocs(calledMethods: string[]): string {
    return lookupFullDocs(loadMetaApiModuleRegistry(), calledMethods);
}

export function resetMetaApiModuleRegistryCache(): void {
    metaApiRegistryCache = null;
    metaApiReferenceCache = null;
}
