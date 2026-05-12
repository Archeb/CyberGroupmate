import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { TELEGRAM_MTCUTE_GUIDE_METHODS } from "../core/telegram-mtcute-passthrough.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const mtcuteCoreRoot = join(repoRoot, "node_modules", "@mtcute", "core");
const clientDtsPath = join(mtcuteCoreRoot, "highlevel", "client.d.ts");
const tlDtsPath = join(mtcuteCoreRoot, "tl", "index.d.ts");
const guideDir = join(repoRoot, "src", "sandbox", "builtin-guides", "telegram");

type GuideGroupName = keyof typeof TELEGRAM_MTCUTE_GUIDE_METHODS;

interface GuideMeta {
    readonly file: string;
    readonly guideMethod: string;
    readonly title: string;
    readonly when: string;
    readonly notes: readonly string[];
    readonly extraSections?: readonly string[];
}

interface MethodDoc {
    readonly name: string;
    readonly docs: string;
    readonly signature: string;
    readonly typeRefs: readonly string[];
    readonly tlRawRefs: readonly string[];
}

interface DeclarationDoc {
    readonly name: string;
    readonly sourcePath: string;
    readonly text: string;
}

const GUIDE_META: Record<GuideGroupName, GuideMeta> = {
    accountProfile: {
        file: "useAccountProfile.md",
        guideMethod: "telegram.useAccountProfile",
        title: "账号资料",
        when: "用于不常驻 brief 的个人账号资料操作，例如修改 bio、姓名、用户名、头像、生日、emoji status、close friends 和资料照片。",
        notes: [
            "这些方法通常会直接修改当前登录账号。调用前确认目标字段和值，尤其是用户名、头像和生日。",
            "需要 peer 的地方优先使用 `InputPeerLike`：`'me'`、`'self'`、username、marked ID 或 mtcute raw/input peer 都可以。",
        ],
    },
    advancedMessages: {
        file: "useAdvancedMessages.md",
        guideMethod: "telegram.useAdvancedMessages",
        title: "高级消息",
        when: "用于不适合常驻 brief 的消息流程：转发、复制、评论、引用、定时消息、网页预览、reaction 用户和消息关联查询。",
        notes: [
            "`answer*`、`reply*`、`comment*` 需要已有 mtcute `Message` 对象；如果只有 message id，先用常驻 `getMessages` 或相应检索 API 获取消息对象。",
            "转发、复制、评论、引用和定时发送都会改变聊天内容，调用前确认目标 chat。",
        ],
    },
    chatAdministration: {
        file: "useChatAdministration.md",
        guideMethod: "telegram.useChatAdministration",
        title: "群组与频道管理",
        when: "用于群组/频道管理：建群建频道、标题描述头像、用户名、颜色、TTL、慢速模式、内容保护、默认权限、成员封禁/限制、管理员和事件日志。",
        notes: [
            "`restrictChatMember` 的字段叫 `restrictions`，类型来自 mtcute/Telegram TL；这些 flag 是限制项，不是允许项，例如 `sendMessages: true` 表示禁止发消息。",
            "管理类写操作通常需要当前账号拥有对应 admin rights。失败时优先检查权限、peer 类型和目标是否为 supergroup/channel。",
        ],
    },
    invites: {
        file: "useInvites.md",
        guideMethod: "telegram.useInvites",
        title: "邀请链接与入群请求",
        when: "用于创建、编辑、导出、查询和撤销邀请链接，分页查看邀请链接成员，处理 join request，以及预览邀请链接。",
        notes: [
            "邀请链接和 join request 处理会影响群成员入口；批量批准/拒绝前先确认 link、chatId 和 approved 值。",
            "分页方法一般有 `get*` 一次取一页和 `iter*` 流式遍历两种形式。",
        ],
    },
    forumTopics: {
        file: "useForumTopics.md",
        guideMethod: "telegram.useForumTopics",
        title: "论坛话题",
        when: "用于 Telegram forum supergroup 的 topic 管理：列出/查找 topic、创建编辑话题、删除话题历史、关闭/置顶话题、隐藏 General topic 和更新 forum 设置。",
        notes: [
            "先用常驻 `getFullChat(chatId)` 判断 `isForum`，再使用 topic API。",
            "发送到某个 topic 通常需要在发送参数里使用 reply/topic 相关字段；本 guide 只负责 topic 本身管理。",
        ],
    },
    stories: {
        file: "useStories.md",
        guideMethod: "telegram.useStories",
        title: "Stories",
        when: "用于完整 Story 流程：判断是否可发、读取 all/profile/peer stories、查询互动和观看者、阅读/增加浏览、发布、编辑、删除、置顶、归档和发送 reaction。",
        notes: [
            "Story 多数能力仅用户账号可用，机器人账号可能不可用或受 Telegram 限制。",
            "本项目 adapter 会把 `{ media: { type, file } }` 里的本地文件路径转为 mtcute 可上传文件；其他参数按 mtcute 签名传入。",
        ],
    },
    pollsAndTodos: {
        file: "usePolls.md",
        guideMethod: "telegram.usePolls",
        title: "投票与 Todo",
        when: "用于投票和 Telegram todo list 的完整流程：创建投票/测验、读取结果、投票、关闭投票、追加 todo item 和切换 todo 完成状态。",
        notes: [
            "创建投票和读取投票结果使用本项目 adapter 的封装 API；投票、关闭投票和 todo 操作转发到 mtcute high-level method。",
            "关闭投票、追加 todo 和切换完成状态会修改已有消息。",
        ],
        extraSections: [
            [
                "## Adapter 封装 API",
                "",
                "以下两个方法不是 mtcute high-level 原生方法，而是本项目 adapter 的封装；它们保留在本 guide 内，避免污染常驻 brief。",
                "",
                "```ts",
                "telegram.sendPoll(chatId: number | string, question: string, options: string[], opts?: {",
                "  anonymous?: boolean;",
                "  multipleChoice?: boolean;",
                "  quiz?: boolean;",
                "  correctOptionId?: number;",
                "  explanation?: string;",
                "  replyTo?: number;",
                "  silent?: boolean;",
                "}): Promise<MessageLike>;",
                "",
                "telegram.getPollResults(chatId: number | string, messageId: number): Promise<{",
                "  question?: string;",
                "  totalVoters?: number;",
                "  closed?: boolean;",
                "  multipleChoice?: boolean;",
                "  quiz?: boolean;",
                "  options: Array<{ text: string; voters?: number; chosen?: boolean; correct?: boolean }>;",
                "}>;",
                "```",
            ].join("\n"),
        ],
    },
};

const BUILTIN_TYPE_NAMES = new Set([
    "AbortSignal",
    "Array",
    "AsyncIterable",
    "Awaited",
    "BigInt",
    "Boolean",
    "Date",
    "Error",
    "Exclude",
    "Extract",
    "File",
    "Float32Array",
    "Float64Array",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Iterable",
    "Long",
    "Map",
    "NonNullable",
    "Number",
    "Object",
    "Omit",
    "Parameters",
    "Partial",
    "Pick",
    "Promise",
    "Readonly",
    "Record",
    "Required",
    "ReturnType",
    "Set",
    "String",
    "Uint16Array",
    "Uint32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "URL",
]);

function readSourceFile(path: string): ts.SourceFile {
    return ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
}

function normalizeJsDoc(raw: string): string {
    return raw
        .split(/\r?\n/)
        .map(line => line
            .replace(/^\s*\/\*\*\s?/, "")
            .replace(/\s*\*\/\s*$/, "")
            .replace(/^\s*\*\s?/, ""))
        .join("\n")
        .replace(/\{@link\s+([^}\s]+)\s+([^}]+)\}/g, "$2 ($1)")
        .replace(/\{@link\s+([^}]+)\}/g, "$1")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

function leadingJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string {
    const fullText = sourceFile.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, node.pos) ?? [];
    const jsDoc = [...ranges].reverse().find(range => fullText.startsWith("/**", range.pos));
    if (!jsDoc) return "";
    return normalizeJsDoc(fullText.slice(jsDoc.pos, jsDoc.end));
}

function declarationText(node: ts.Node, sourceFile: ts.SourceFile): string {
    const docs = leadingJsDoc(node, sourceFile);
    const text = node.getText(sourceFile).trim();
    return docs ? `/**\n${docs.split("\n").map(line => ` * ${line}`).join("\n")}\n */\n${text}` : text;
}

function methodNameOf(member: ts.ClassElement | ts.TypeElement): string | null {
    if (!("name" in member) || !member.name) return null;
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
        return member.name.text;
    }
    return null;
}

function telegramSignature(name: string, member: ts.MethodSignature): string {
    const text = member.getText().trim().replace(/;\s*$/, ";");
    return text.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s*\\()`), `telegram.${name}`);
}

function typeNameText(name: ts.EntityName): string {
    if (ts.isIdentifier(name)) return name.text;
    return `${typeNameText(name.left)}.${name.right.text}`;
}

function collectTypeRefsFromNode(node: ts.Node, refs: Set<string>, tlRawRefs: Set<string>): void {
    if (ts.isTypeReferenceNode(node)) {
        const name = typeNameText(node.typeName);
        if (name.startsWith("tl.Raw")) {
            tlRawRefs.add(name.slice("tl.".length));
        } else if (!name.includes(".") && /^[A-Z]/.test(name) && !BUILTIN_TYPE_NAMES.has(name)) {
            refs.add(name);
        }
    }

    ts.forEachChild(node, child => collectTypeRefsFromNode(child, refs, tlRawRefs));
}

function collectParameterTypeRefs(member: ts.MethodSignature): { typeRefs: string[]; tlRawRefs: string[] } {
    const refs = new Set<string>();
    const tlRawRefs = new Set<string>();

    for (const param of member.parameters) {
        if (param.type) {
            collectTypeRefsFromNode(param.type, refs, tlRawRefs);
        }
    }

    return {
        typeRefs: [...refs].sort((a, b) => a.localeCompare(b)),
        tlRawRefs: [...tlRawRefs].sort((a, b) => a.localeCompare(b)),
    };
}

function extractClientMethods(): Map<string, MethodDoc> {
    const sourceFile = readSourceFile(clientDtsPath);
    const methods = new Map<string, MethodDoc>();

    for (const statement of sourceFile.statements) {
        if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== "TelegramClient") continue;

        for (const member of statement.members) {
            if (!ts.isMethodSignature(member)) continue;
            const name = methodNameOf(member);
            if (!name) continue;
            const typeRefs = collectParameterTypeRefs(member);

            methods.set(name, {
                name,
                docs: leadingJsDoc(member, sourceFile),
                signature: telegramSignature(name, member),
                typeRefs: typeRefs.typeRefs,
                tlRawRefs: typeRefs.tlRawRefs,
            });
        }
    }

    return methods;
}

function listDtsFiles(root: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...listDtsFiles(path));
        } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
            result.push(path);
        }
    }
    return result;
}

function declarationName(node: ts.Node): string | null {
    if (
        ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isEnumDeclaration(node)
    ) {
        return node.name?.text ?? null;
    }
    return null;
}

function buildHighlevelDeclarationIndex(): Map<string, DeclarationDoc> {
    const index = new Map<string, DeclarationDoc>();
    const roots = [
        join(mtcuteCoreRoot, "highlevel"),
        join(mtcuteCoreRoot, "types"),
    ];

    for (const root of roots) {
        if (!existsSync(root)) continue;

        for (const file of listDtsFiles(root)) {
            if (file === clientDtsPath) continue;
            const sourceFile = readSourceFile(file);
            for (const statement of sourceFile.statements) {
                const name = declarationName(statement);
                if (!name || index.has(name)) continue;
                index.set(name, {
                    name,
                    sourcePath: file,
                    text: declarationText(statement, sourceFile),
                });
            }
        }
    }

    return index;
}

function buildTlDeclarationIndex(): Map<string, DeclarationDoc> {
    const index = new Map<string, DeclarationDoc>();
    const sourceFile = readSourceFile(tlDtsPath);

    for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement) || statement.name.getText(sourceFile) !== "tl") continue;
        if (!statement.body || !ts.isModuleBlock(statement.body)) continue;

        for (const nested of statement.body.statements) {
            const name = declarationName(nested);
            if (!name || index.has(name)) continue;
            index.set(name, {
                name,
                sourcePath: tlDtsPath,
                text: declarationText(nested, sourceFile),
            });
        }
    }

    return index;
}

function formatSource(path: string): string {
    return relative(repoRoot, path).replace(/\\/g, "/");
}

function compactDeclaration(text: string): string {
    const maxLength = 12000;
    if (text.length <= maxLength) return text;
    const lines = text.slice(0, maxLength).split("\n");
    lines.pop();
    return [
        ...lines,
        "/* ... declaration truncated in generated guide; inspect the source file listed above for the full type. */",
    ].join("\n");
}

function renderDeclarationSection(title: string, declarations: DeclarationDoc[]): string {
    if (!declarations.length) return "";

    return [
        `## ${title}`,
        "",
        "这些声明由生成脚本从本地 mtcute `.d.ts` 摘录，用来解释上面签名里出现的输入类型。遇到更深的嵌套类型时，按 Source 路径继续查本地 mtcute 声明。",
        "",
        ...declarations.flatMap(decl => [
            `### ${decl.name}`,
            "",
            `Source: \`${formatSource(decl.sourcePath)}\``,
            "",
            "```ts",
            compactDeclaration(decl.text),
            "```",
            "",
        ]),
    ].join("\n").trimEnd();
}

function renderGuide(
    groupName: GuideGroupName,
    docs: MethodDoc[],
    highlevelDecls: Map<string, DeclarationDoc>,
    tlDecls: Map<string, DeclarationDoc>,
): string {
    const meta = GUIDE_META[groupName];
    const highlevelTypeRefs = [...new Set(docs.flatMap(doc => doc.typeRefs))]
        .sort((a, b) => a.localeCompare(b))
        .map(name => highlevelDecls.get(name))
        .filter((decl): decl is DeclarationDoc => Boolean(decl));
    const tlTypeRefs = [...new Set(docs.flatMap(doc => doc.tlRawRefs))]
        .sort((a, b) => a.localeCompare(b))
        .map(name => tlDecls.get(name))
        .filter((decl): decl is DeclarationDoc => Boolean(decl));

    const methodSections = docs.flatMap(doc => [
        `### telegram.${doc.name}`,
        "",
        doc.docs || "_mtcute did not provide a JSDoc description for this method._",
        "",
        "```ts",
        doc.signature,
        "```",
        "",
    ]);

    const sections = [
        "<!-- AUTO-GENERATED by src/tools/generate-telegram-mtcute-guides.ts. Do not edit this file manually. -->",
        "",
        `TelegramGuide: ${meta.guideMethod.replace(/^telegram\./, "")}`,
        "",
        `## ${meta.title}`,
        "",
        meta.when,
        "",
        "调用本 guide 方法只会把本文注入上下文；真正执行时直接调用下面的 `telegram.<method>(...)`。这些方法会由 adapter 通过同名 mtcute high-level method 转发给当前登录的 mtcute client。",
        "",
        "## 使用要点",
        "",
        ...meta.notes.map(note => `- ${note}`),
        "",
        ...(meta.extraSections ? [...meta.extraSections, ""] : []),
        "## mtcute high-level API",
        "",
        ...methodSections,
        renderDeclarationSection("Referenced mtcute input types", highlevelTypeRefs),
        "",
        renderDeclarationSection("Referenced Telegram TL raw types", tlTypeRefs),
        "",
    ];

    return sections.filter(section => section !== "").join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function main(): void {
    if (!existsSync(clientDtsPath)) {
        throw new Error(`Cannot find mtcute client declarations at ${clientDtsPath}`);
    }

    const methods = extractClientMethods();
    const highlevelDecls = buildHighlevelDeclarationIndex();
    const tlDecls = buildTlDeclarationIndex();
    const missing: string[] = [];
    const guides = new Map<GuideGroupName, MethodDoc[]>();

    for (const [groupName, methodNames] of Object.entries(TELEGRAM_MTCUTE_GUIDE_METHODS) as Array<[GuideGroupName, readonly string[]]>) {
        const groupDocs: MethodDoc[] = [];

        for (const methodName of methodNames) {
            const doc = methods.get(methodName);
            if (!doc) {
                missing.push(`${groupName}.${methodName}`);
            } else {
                groupDocs.push(doc);
            }
        }

        guides.set(groupName, groupDocs);
    }

    if (missing.length) {
        throw new Error([
            "The following Telegram mtcute guide methods are not present on the local TelegramClient type:",
            ...missing.map(item => `- ${item}`),
            "",
            `Source checked: ${formatSource(clientDtsPath)}`,
        ].join("\n"));
    }

    mkdirSync(guideDir, { recursive: true });

    const generatedFiles = new Set(Object.values(GUIDE_META).map(meta => meta.file));

    for (const entry of readdirSync(guideDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md") || generatedFiles.has(entry.name)) continue;
        const filePath = join(guideDir, entry.name);
        if (readFileSync(filePath, "utf-8").startsWith("<!-- AUTO-GENERATED by src/tools/generate-telegram-mtcute-guides.ts.")) {
            unlinkSync(filePath);
        }
    }

    for (const [groupName, groupDocs] of guides) {
        const meta = GUIDE_META[groupName];
        writeFileSync(join(guideDir, meta.file), renderGuide(groupName, groupDocs, highlevelDecls, tlDecls), "utf-8");
    }
}

main();
