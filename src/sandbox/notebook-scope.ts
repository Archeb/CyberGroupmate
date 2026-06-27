/**
 * notebook-scope.ts — LLM-friendly task-scoped JS notebook semantics.
 *
 * The worker still executes each code block in a fresh async function, but CodeAct
 * sessions can opt into a task-scoped notebook namespace. Top-level declarations
 * are rewritten into assignments to that namespace, so models can reuse familiar
 * names across turns without hitting duplicate `const` errors.
 */

import ts from "typescript";

export const NOTEBOOK_RESERVED_NAMES = new Set([
    "ctx",
    "runtime",
    "scene",
    "skills",
    "fs",
    "mcp",
    "cron",
    "todo",
    "vision",
    "memory",
    "privacy",
    "shell",
    "telegram",
    "discord",
    "onebot",
    "qq",
    "__notebookScope",
    "__notebookWith",
    "__notebookAssign",
    "__notebookDefine",
]);

export interface NotebookTransformResult {
    code: string;
    declaredNames: string[];
    errors: string[];
}

const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
    noImplicitUseStrict: true,
    removeComments: false,
};

export function transformNotebookCode(code: string): NotebookTransformResult {
    const sourceFile = ts.createSourceFile(
        "notebook-input.ts",
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const factory = ts.factory;
    const printer = ts.createPrinter({ removeComments: false });
    const declaredNames = new Set<string>();
    const errors: string[] = [];
    let tempCounter = 0;

    const rememberName = (name: string): void => {
        declaredNames.add(name);
        if (NOTEBOOK_RESERVED_NAMES.has(name)) {
            errors.push(`"${name}" 是 sandbox 保留 API 名，不能作为顶层变量名使用。`);
        }
    };

    const print = (node: ts.Node): string =>
        printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);

    const toJsExpressionSource = (expressionSource: string): string => {
        const output = ts.transpileModule(`(${expressionSource});`, {
            compilerOptions,
        }).outputText.trim();
        return output.replace(/;\s*$/, "");
    };

    const createAssignStatement = (name: string, expression: ts.Expression): ts.Statement => {
        rememberName(name);
        return factory.createExpressionStatement(
            factory.createCallExpression(factory.createIdentifier("__notebookAssign"), undefined, [
                factory.createStringLiteral(name),
                expression,
            ]),
        );
    };

    const createDefineStatement = (
        name: string,
        expression: ts.Expression,
        sourceExpression: string,
    ): ts.Statement => {
        rememberName(name);
        return factory.createExpressionStatement(
            factory.createCallExpression(factory.createIdentifier("__notebookDefine"), undefined, [
                factory.createStringLiteral(name),
                expression,
                factory.createStringLiteral(toJsExpressionSource(sourceExpression)),
            ]),
        );
    };

    const collectBindingNames = (name: ts.BindingName): string[] => {
        if (ts.isIdentifier(name)) return [name.text];
        const result: string[] = [];
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            result.push(...collectBindingNames(element.name));
        }
        return result;
    };

    const isPersistableFunctionValue = (expression: ts.Expression): boolean =>
        ts.isFunctionExpression(expression)
        || ts.isArrowFunction(expression)
        || ts.isClassExpression(expression);

    const transformVariableStatement = (statement: ts.VariableStatement): ts.Statement[] => {
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];

        const transformed: ts.Statement[] = [];
        for (const declaration of statement.declarationList.declarations) {
            const { name, initializer } = declaration;
            if (ts.isIdentifier(name)) {
                if (initializer && isPersistableFunctionValue(initializer)) {
                    transformed.push(createDefineStatement(name.text, initializer, print(initializer)));
                } else {
                    transformed.push(createAssignStatement(
                        name.text,
                        initializer ?? factory.createVoidExpression(factory.createNumericLiteral("0")),
                    ));
                }
                continue;
            }

            const bindingNames = collectBindingNames(name);
            for (const bindingName of bindingNames) rememberName(bindingName);

            const tempName = factory.createUniqueName(`__notebookTmp${++tempCounter}`);
            const tempStatement = factory.createVariableStatement(
                undefined,
                factory.createVariableDeclarationList([
                    factory.createVariableDeclaration(
                        tempName,
                        undefined,
                        undefined,
                        initializer ?? factory.createVoidExpression(factory.createNumericLiteral("0")),
                    ),
                ], ts.NodeFlags.Const),
            );
            const destructureStatement = factory.createVariableStatement(
                undefined,
                factory.createVariableDeclarationList([
                    factory.createVariableDeclaration(name, undefined, undefined, tempName),
                ], ts.NodeFlags.Const),
            );
            const persistStatements = bindingNames.map((bindingName) =>
                factory.createExpressionStatement(
                    factory.createCallExpression(factory.createIdentifier("__notebookAssign"), undefined, [
                        factory.createStringLiteral(bindingName),
                        factory.createIdentifier(bindingName),
                    ]),
                )
            );
            transformed.push(factory.createBlock([
                tempStatement,
                destructureStatement,
                ...persistStatements,
            ], true));
        }
        return transformed;
    };

    const transformFunctionDeclaration = (statement: ts.FunctionDeclaration): ts.Statement[] => {
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
        if (!statement.name) return [];
        const modifiers = statement.modifiers?.filter(
            (modifier): modifier is ts.Modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        );
        const expression = factory.createFunctionExpression(
            modifiers && modifiers.length > 0 ? modifiers : undefined,
            statement.asteriskToken,
            statement.name,
            statement.typeParameters,
            statement.parameters,
            statement.type,
            statement.body ?? factory.createBlock([], true),
        );
        return [createDefineStatement(statement.name.text, expression, print(expression))];
    };

    const transformClassDeclaration = (statement: ts.ClassDeclaration): ts.Statement[] => {
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
        if (!statement.name) return [];
        const expression = factory.createClassExpression(
            undefined,
            statement.name,
            statement.typeParameters,
            statement.heritageClauses,
            statement.members,
        );
        return [createDefineStatement(statement.name.text, expression, print(expression))];
    };

    const statements: ts.Statement[] = [];
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
            statements.push(...transformVariableStatement(statement));
        } else if (ts.isFunctionDeclaration(statement)) {
            statements.push(...transformFunctionDeclaration(statement));
        } else if (ts.isClassDeclaration(statement)) {
            statements.push(...transformClassDeclaration(statement));
        } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
            // Type-only declarations are useful in TS snippets but have no runtime meaning.
            continue;
        } else {
            statements.push(statement);
        }
    }

    const transformedSourceFile = factory.updateSourceFile(sourceFile, statements);
    const transformedTs = printer.printFile(transformedSourceFile);
    const transformedJs = ts.transpileModule(transformedTs, {
        compilerOptions,
    }).outputText.trim();

    return {
        code: transformedJs,
        declaredNames: [...declaredNames],
        errors: [...new Set(errors)],
    };
}
