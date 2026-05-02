import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_DIR = "tests";
const EXCLUDED_DEFAULT_TEST_PATTERNS = [
    /(?:^|[\\/])[^\\/]*sandbox[^\\/]*\.test\.ts$/i,
];

function collectTestFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTestFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
            files.push(fullPath);
        }
    }
    return files;
}

const allTests = collectTestFiles(TEST_DIR)
    .filter((file) => statSync(file).isFile())
    .map((file) => relative(process.cwd(), file))
    .sort();
const defaultTests = allTests.filter((file) =>
    !EXCLUDED_DEFAULT_TEST_PATTERNS.some((pattern) => pattern.test(file))
);

if (defaultTests.length === 0) {
    console.error("No default test files found.");
    process.exit(1);
}

console.log(`Running ${defaultTests.length} default test files (${allTests.length - defaultTests.length} sandbox tests excluded).`);

const child = spawn(
    process.execPath,
    [
        "--import",
        "tsx",
        "--test",
        ...defaultTests,
    ],
    {
        stdio: "inherit",
        shell: false,
    },
);

child.on("exit", (code, signal) => {
    if (signal) {
        console.error(`Test runner terminated by ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});
