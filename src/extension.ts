import * as vscode from 'vscode';
import { WrenLanguageService } from './language/languageService';
import { AggregatedWorkspaceIndex, WrenClassSymbol, WrenMethodSymbol, WrenFileIndex } from './language/types';
import { getCoreRegistry } from '../wren-analyzer/src/core/core-registry';
import { isBuiltinModule } from '../wren-analyzer/src/index';
import type { Module, Token, ClassStmt } from '../wren-analyzer/src/index';
import { findDefinition, importStatements } from './language/definition';
import type { ModuleGraph, ModuleImport } from './language/definition';

const KEYWORDS = ['class', 'construct', 'foreign', 'import', 'return', 'static', 'var'];

export function activate(context: vscode.ExtensionContext) {
    const languageService = new WrenLanguageService();

    // --- Static analysis diagnostics (from the same analyze() call that powers IntelliSense) ---
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('wren');
    context.subscriptions.push(diagnosticCollection);

    const refreshDiagnostics = async (document: vscode.TextDocument) => {
        if (document.languageId !== 'wren') { return; }
        diagnosticCollection.set(document.uri, await languageService.getDiagnostics(document));
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            languageService.handleConfigurationChange(event);
            if (event.affectsConfiguration('wren.enableDiagnostics')) {
                vscode.workspace.textDocuments.forEach(refreshDiagnostics);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'wren') {
                languageService.invalidateDocument(event.document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document.languageId === 'wren') {
                languageService.evictPath(document.uri.fsPath);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider('wren', new AnalyzerDocumentSymbolProvider(languageService))
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('wren', new AnalyzerCompletionProvider(languageService), '.', '"')
    );

    context.subscriptions.push(
        vscode.languages.registerSignatureHelpProvider('wren', new AnalyzerSignatureHelpProvider(languageService), '(', ',')
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('wren', new WrenHoverProvider(languageService))
    );

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('wren', new WrenDefinitionProvider(languageService))
    );

    // Analyze all currently open wren documents
    vscode.workspace.textDocuments.forEach(refreshDiagnostics);

    // Re-analyze on edit (debounced)
    let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId !== 'wren') { return; }
            clearTimeout(diagnosticTimer);
            diagnosticTimer = setTimeout(() => refreshDiagnostics(event.document), 300);
        }),
        vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
        vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri))
    );
}

export function deactivate() {}

class AnalyzerDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(private readonly service: WrenLanguageService) {}

    async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        try {
            const index = await this.service.getFileIndex(document);
            return index.classes.map(convertClassToSymbol);
        } catch {
            return [];
        }
    }
}

class AnalyzerCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly service: WrenLanguageService) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        try {
            const aggregate = await this.service.getWorkspaceAggregate(document);
            const contextInfo = analyzeCompletionContext(document, position);

            // Resolve type of lowercase receiver via AST type annotations / inference
            if (contextInfo.isMemberAccess && contextInfo.receiver && !contextInfo.receiverIsClass) {
                const offset = document.offsetAt(position);
                const resolution = this.service.getTypedLocals(document, offset);

                if (contextInfo.receiver === 'this') {
                    contextInfo.resolvedType = resolution.enclosingClass ?? undefined;
                } else {
                    contextInfo.resolvedType = resolution.locals.get(contextInfo.receiver);
                }
            }

            return buildCompletionItems(aggregate, contextInfo);
        } catch {
            return [];
        }
    }
}

class AnalyzerSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(private readonly service: WrenLanguageService) {}

    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token?: vscode.CancellationToken,
        _context?: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | null> {
        try {
            const aggregate = await this.service.getWorkspaceAggregate(document);
            const contextInfo = analyzeSignatureContext(document, position);
            if (!contextInfo) {
                return null;
            }
            const signatures = buildSignatures(aggregate, contextInfo);
            if (!signatures.length) {
                return null;
            }
            const help = new vscode.SignatureHelp();
            help.signatures = signatures;
            help.activeSignature = 0;
            help.activeParameter = Math.min(contextInfo.parameterIndex, signatures[0].parameters.length - 1);
            return help;
        } catch {
            return null;
        }
    }
}

function convertClassToSymbol(cls: WrenClassSymbol): vscode.DocumentSymbol {
    const classSymbol = new vscode.DocumentSymbol(cls.name, 'class', vscode.SymbolKind.Class, cls.range, cls.selectionRange);
    classSymbol.children = [];

    for (const field of cls.fields) {
        classSymbol.children.push(
            new vscode.DocumentSymbol(
                field.name,
                field.isStatic ? 'static field' : 'field',
                vscode.SymbolKind.Field,
                field.range,
                field.range
            )
        );
    }

    const addMethod = (method: WrenMethodSymbol, isStatic: boolean) => {
        const detail = isStatic ? 'static' : 'method';
        classSymbol.children!.push(
            new vscode.DocumentSymbol(
                method.name,
                detail,
                vscode.SymbolKind.Method,
                method.range,
                method.range
            )
        );
    };

    cls.staticMethods.forEach(method => addMethod(method, true));
    cls.methods.forEach(method => addMethod(method, false));

    return classSymbol;
}

interface CompletionContext {
    isMemberAccess: boolean;
    receiver?: string;
    receiverIsClass: boolean;
    resolvedType?: string;
    range: vscode.Range;
}

function analyzeCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContext {
    const line = document.lineAt(position.line).text;
    const beforeCursor = line.slice(0, position.character);
    const memberMatch = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(beforeCursor);
    if (memberMatch) {
        const receiver = memberMatch[1];
        const fragment = memberMatch[2] ?? '';
        const start = position.character - fragment.length;
        const range = new vscode.Range(new vscode.Position(position.line, start), position);
        return {
            isMemberAccess: true,
            receiver,
            receiverIsClass: /^[A-Z]/.test(receiver),
            range
        };
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    return {
        isMemberAccess: false,
        receiverIsClass: false,
        range: wordRange ?? new vscode.Range(position, position)
    };
}

function buildCompletionItems(aggregate: AggregatedWorkspaceIndex, context: CompletionContext): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    const register = (key: string, item: vscode.CompletionItem) => {
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        items.push(item);
    };

    if (context.isMemberAccess && context.receiver) {
        if (context.receiverIsClass) {
            // PascalCase receiver: show static methods of that class
            const classBucket = aggregate.classes.get(context.receiver);
            if (classBucket) {
                for (const methods of classBucket.staticMethods.values()) {
                    methods.forEach(method => register(`static:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
                }
            }
            return items;
        }

        if (context.resolvedType) {
            // Type is known: show only instance methods of the resolved class
            const classBucket = aggregate.classes.get(context.resolvedType);
            if (classBucket) {
                for (const methods of classBucket.methods.values()) {
                    methods.forEach(method => register(`instance:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
                }
            }
            return items;
        }

        // Lowercase receiver with unknown type: return empty (don't dump everything)
        return items;
    }

    // No member access: show keywords and class names
    KEYWORDS.forEach(keyword => {
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.range = context.range;
        register(`keyword:${keyword}`, item);
    });

    for (const cls of aggregate.classes.values()) {
        const item = new vscode.CompletionItem(cls.name, vscode.CompletionItemKind.Class);
        item.range = context.range;
        register(`class:${cls.name}`, item);
    }

    return items;
}

function createMethodCompletion(method: WrenMethodSymbol, range: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(method.name, method.isStatic ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Method);
    item.detail = method.detail;
    item.range = range;
    if (method.params.length) {
        const snippetParams = method.params.map((param, index) => `\${${index + 1}:${param}}`).join(', ');
        item.insertText = new vscode.SnippetString(`${method.name}(${snippetParams})`);
    }
    return item;
}

interface SignatureContext {
    methodName: string;
    receiver?: string;
    receiverIsClass: boolean;
    parameterIndex: number;
}

function analyzeSignatureContext(document: vscode.TextDocument, position: vscode.Position): SignatureContext | undefined {
    const line = document.lineAt(position.line).text.slice(0, position.character);
    let depth = 0;
    let openParenIndex = -1;
    for (let i = line.length - 1; i >= 0; i--) {
        const ch = line[i];
        if (ch === '(') {
            if (depth === 0) {
                openParenIndex = i;
                break;
            }
            depth -= 1;
        } else if (ch === ')') {
            depth += 1;
        }
    }

    if (openParenIndex === -1) {
        return undefined;
    }

    const head = line.slice(0, openParenIndex).trimEnd();
    const methodMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(head);
    if (!methodMatch) {
        return undefined;
    }

    const methodName = methodMatch[1];
    const headBeforeMethod = head.slice(0, head.length - methodName.length);
    const receiverMatch = /([A-Za-z_][A-Za-z0-9_]*)\.\s*$/.exec(headBeforeMethod);
    const receiver = receiverMatch ? receiverMatch[1] : undefined;

    const argumentSlice = line.slice(openParenIndex + 1);
    let parameterIndex = 0;
    depth = 0;
    for (const ch of argumentSlice) {
        if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            if (depth === 0) {
                break;
            }
            depth -= 1;
        } else if (ch === ',' && depth === 0) {
            parameterIndex += 1;
        }
    }

    return {
        methodName,
        receiver,
        receiverIsClass: receiver ? /^[A-Z]/.test(receiver) : false,
        parameterIndex
    };
}

function buildSignatures(aggregate: AggregatedWorkspaceIndex, context: SignatureContext): vscode.SignatureInformation[] {
    const signatures: vscode.SignatureInformation[] = [];
    const pushMethods = (methods: Map<string, WrenMethodSymbol[]>) => {
        const overloads = methods.get(context.methodName);
        if (!overloads) {
            return;
        }
        overloads.forEach(method => {
            const signature = new vscode.SignatureInformation(method.detail);
            signature.parameters = method.params.map(param => new vscode.ParameterInformation(param));
            signatures.push(signature);
        });
    };

    if (context.receiver && context.receiverIsClass) {
        const bucket = aggregate.classes.get(context.receiver);
        if (bucket) {
            pushMethods(bucket.staticMethods);
        }
    } else {
        for (const bucket of aggregate.classes.values()) {
            pushMethods(bucket.methods);
        }
    }

    return signatures;
}

// =============================================================================
// Shared context analysis for hover & definition
// =============================================================================

interface SymbolContext {
    kind: 'method-on-class' | 'method-on-instance' | 'class-name' | 'field' | 'this' | 'standalone';
    receiver?: string;
}

function analyzeSymbolContext(textBeforeWord: string, word: string): SymbolContext {
    // Check for dot-access: "receiver.word"
    const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.\s*$/.exec(textBeforeWord);
    if (dotMatch) {
        const receiver = dotMatch[1];
        if (/^[A-Z]/.test(receiver)) {
            return { kind: 'method-on-class', receiver };
        }
        return { kind: 'method-on-instance', receiver };
    }
    if (word === 'this') {
        return { kind: 'this' };
    }
    if (word.startsWith('_')) {
        return { kind: 'field' };
    }
    if (/^[A-Z]/.test(word)) {
        return { kind: 'class-name' };
    }
    return { kind: 'standalone' };
}

function tokenToRange(document: vscode.TextDocument, token: Token): vscode.Range {
    return new vscode.Range(
        document.positionAt(token.start),
        document.positionAt(token.start + token.length),
    );
}

function isBuiltinSymbol(sym: { uri?: vscode.Uri }): boolean {
    return sym.uri === undefined;
}

function wrenCodeBlock(text: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(text, 'wren');
    return md;
}

// =============================================================================
// Hover Provider
// =============================================================================

class WrenHoverProvider implements vscode.HoverProvider {
    constructor(private readonly service: WrenLanguageService) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | null> {
        try {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
            if (!wordRange) return null;
            const word = document.getText(wordRange);

            const line = document.lineAt(position.line).text;
            const beforeWord = line.slice(0, wordRange.start.character);
            const ctx = analyzeSymbolContext(beforeWord, word);

            const aggregate = await this.service.getWorkspaceAggregate(document);
            const offset = document.offsetAt(position);
            const resolution = this.service.getTypedLocals(document, offset);

            switch (ctx.kind) {
                case 'class-name':
                    return this.hoverClass(word, document);

                case 'method-on-class':
                    return this.hoverMethod(ctx.receiver!, word, true, aggregate);

                case 'method-on-instance': {
                    const receiverType = ctx.receiver === 'this'
                        ? resolution.enclosingClass
                        : resolution.locals.get(ctx.receiver!);
                    if (receiverType) {
                        return this.hoverMethod(receiverType, word, false, aggregate);
                    }
                    return null;
                }

                case 'this':
                    if (resolution.enclosingClass) {
                        return new vscode.Hover(wrenCodeBlock(`this: ${resolution.enclosingClass}`), wordRange);
                    }
                    return null;

                case 'field': {
                    if (!resolution.enclosingClass) return null;
                    const index = await this.service.getFileIndex(document);
                    const cls = index.classes.find(c => c.name === resolution.enclosingClass);
                    if (cls) {
                        const field = cls.fields.find(f => f.name === word);
                        if (field) {
                            const prefix = field.isStatic ? 'static field' : 'field';
                            return new vscode.Hover(wrenCodeBlock(`(${prefix}) ${word}`), wordRange);
                        }
                    }
                    return null;
                }

                case 'standalone': {
                    // Check if it's a known class
                    if (aggregate.classes.has(word)) {
                        return this.hoverClass(word, document);
                    }
                    // Check if it's a typed variable
                    const varType = resolution.locals.get(word);
                    if (varType) {
                        return new vscode.Hover(wrenCodeBlock(`(variable) ${word}: ${varType}`), wordRange);
                    }
                    return null;
                }
            }
        } catch {
            return null;
        }
    }

    private hoverClass(className: string, document: vscode.TextDocument): vscode.Hover | null {
        // Try user-defined class (check AST for superclass)
        const module = this.service.getModule(document);
        for (const stmt of module.statements) {
            if (stmt.kind === 'ClassStmt' && (stmt as ClassStmt).name.text === className) {
                const cls = stmt as ClassStmt;
                const superPart = cls.superclass ? ` is ${cls.superclass.text}` : '';
                return new vscode.Hover(wrenCodeBlock(`class ${className}${superPart}`));
            }
        }
        // Try core registry for superclass info
        const registry = getCoreRegistry();
        const info = registry.get(className);
        if (info) {
            const superPart = info.superclass ? ` is ${info.superclass}` : '';
            return new vscode.Hover(wrenCodeBlock(`class ${className}${superPart}`));
        }
        // Fallback: class exists in aggregate but no superclass info
        return new vscode.Hover(wrenCodeBlock(`class ${className}`));
    }

    private hoverMethod(
        className: string,
        methodName: string,
        isStatic: boolean,
        aggregate: AggregatedWorkspaceIndex,
    ): vscode.Hover | null {
        const bucket = aggregate.classes.get(className);
        if (!bucket) return null;
        const methodMap = isStatic ? bucket.staticMethods : bucket.methods;
        const overloads = methodMap.get(methodName);
        if (!overloads || overloads.length === 0) return null;

        const details = overloads.map(m => m.detail).join('\n');
        return new vscode.Hover(wrenCodeBlock(details));
    }
}

// =============================================================================
// Definition Provider
// =============================================================================

class WrenDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly service: WrenLanguageService) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Definition | null> {
        try {
            const file = document.uri.fsPath;
            const graph = await this.buildGraph(document);
            const target = findDefinition(graph, file, document.offsetAt(position));
            if (!target) return null;

            const uri = vscode.Uri.file(target.file);
            if (target.isFile) {
                return new vscode.Location(uri, new vscode.Position(0, 0));
            }
            const targetDoc = target.file === file
                ? document
                : await vscode.workspace.openTextDocument(uri);
            return new vscode.Location(uri, new vscode.Range(
                targetDoc.positionAt(target.start),
                targetDoc.positionAt(target.start + target.length),
            ));
        } catch {
            return null;
        }
    }

    /** Load the current module and everything it (transitively) imports. */
    private async buildGraph(document: vscode.TextDocument): Promise<ModuleGraph> {
        const graph: ModuleGraph = new Map();
        const queue: { file: string; module: Module }[] = [
            { file: document.uri.fsPath, module: this.service.getModule(document) },
        ];
        const MAX_MODULES = 200;
        while (queue.length > 0 && graph.size < MAX_MODULES) {
            const { file, module } = queue.shift()!;
            if (graph.has(file)) continue;
            const imports: ModuleImport[] = importStatements(module).map(imp => ({
                moduleName: imp.moduleName,
                variables: imp.variables,
                resolvedPath: this.service.resolveModulePathFrom(file, imp.moduleName),
            }));
            graph.set(file, { file, module, imports });
            for (const imp of imports) {
                if (!imp.resolvedPath || graph.has(imp.resolvedPath)) continue;
                const mod = await this.service.getModuleByPath(imp.resolvedPath);
                if (mod) queue.push({ file: imp.resolvedPath, module: mod });
            }
        }
        return graph;
    }
}
