import * as vscode from 'vscode';
import { WrenLanguageService } from './language/languageService';
import { AggregatedWorkspaceIndex, WrenClassSymbol, WrenMethodSymbol, WrenFileIndex } from './language/types';
import { getCoreRegistry } from '../wren-analyzer/src/core/core-registry';
import { isBuiltinModule } from '../wren-analyzer/src/index';
import type { Module, Stmt, Expr, Method, Body, ClassStmt, Token } from '../wren-analyzer/src/index';

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
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
            if (!wordRange) {
                // Maybe cursor is on an import path string
                return this.findImportPathDefinition(document, position);
            }
            const word = document.getText(wordRange);

            const line = document.lineAt(position.line).text;
            const beforeWord = line.slice(0, wordRange.start.character);
            const ctx = analyzeSymbolContext(beforeWord, word);
            const offset = document.offsetAt(position);

            switch (ctx.kind) {
                case 'class-name':
                    return this.findClassDefinition(document, word);

                case 'method-on-class':
                    return this.findMethodDefinition(document, ctx.receiver!, word, true);

                case 'method-on-instance': {
                    const resolution = this.service.getTypedLocals(document, offset);
                    const receiverType = ctx.receiver === 'this'
                        ? resolution.enclosingClass
                        : resolution.locals.get(ctx.receiver!);
                    if (receiverType) {
                        return this.findMethodDefinition(document, receiverType, word, false);
                    }
                    return null;
                }

                case 'field':
                    return this.findFieldDefinition(document, word, offset);

                case 'standalone': {
                    // Try variable declaration first
                    const varDef = this.findVariableDeclaration(document, word, offset);
                    if (varDef) return varDef;
                    // Try class name
                    return this.findClassDefinition(document, word);
                }

                default:
                    return null;
            }
        } catch {
            return null;
        }
    }

    private async findClassDefinition(document: vscode.TextDocument, className: string): Promise<vscode.Location | null> {
        // Check current file
        const index = await this.service.getFileIndex(document);
        const cls = index.classes.find(c => c.name === className);
        if (cls && !isBuiltinSymbol(cls)) {
            return new vscode.Location(cls.uri!, cls.selectionRange);
        }

        // Check imports
        return this.findInImports(document, index, className);
    }

    private async findMethodDefinition(
        document: vscode.TextDocument,
        className: string,
        methodName: string,
        isStatic: boolean,
    ): Promise<vscode.Location | null> {
        // Search current file
        const index = await this.service.getFileIndex(document);
        const localResult = this.findMethodInIndex(index, className, methodName, isStatic);
        if (localResult) return localResult;

        // Search imports
        for (const imp of index.imports) {
            if (isBuiltinModule(imp.moduleName)) continue;
            const resolvedPath = this.service.resolveModulePath(document, imp.moduleName);
            if (!resolvedPath) continue;
            const importedIndex = await this.service.getFileIndexByPath(resolvedPath);
            if (!importedIndex) continue;
            const result = this.findMethodInIndex(importedIndex, className, methodName, isStatic);
            if (result) return result;
        }

        return null;
    }

    private findMethodInIndex(
        index: WrenFileIndex,
        className: string,
        methodName: string,
        isStatic: boolean,
    ): vscode.Location | null {
        const cls = index.classes.find(c => c.name === className);
        if (!cls || isBuiltinSymbol(cls)) return null;
        const methods = isStatic ? cls.staticMethods : cls.methods;
        const method = methods.find(m => m.name === methodName);
        if (method) {
            return new vscode.Location(cls.uri!, method.range);
        }
        return null;
    }

    private async findInImports(
        document: vscode.TextDocument,
        index: WrenFileIndex,
        className: string,
    ): Promise<vscode.Location | null> {
        for (const imp of index.imports) {
            if (isBuiltinModule(imp.moduleName)) continue;
            // If import uses `for`, check if className is in the list
            if (imp.variables !== null && !imp.variables.includes(className)) continue;
            const resolvedPath = this.service.resolveModulePath(document, imp.moduleName);
            if (!resolvedPath) continue;
            const importedIndex = await this.service.getFileIndexByPath(resolvedPath);
            if (!importedIndex) continue;
            const cls = importedIndex.classes.find(c => c.name === className);
            if (cls && !isBuiltinSymbol(cls)) {
                return new vscode.Location(cls.uri!, cls.selectionRange);
            }
        }
        return null;
    }

    private findFieldDefinition(
        document: vscode.TextDocument,
        fieldName: string,
        offset: number,
    ): vscode.Location | null {
        const resolution = this.service.getTypedLocals(document, offset);
        if (!resolution.enclosingClass) return null;
        const module = this.service.getModule(document);
        for (const stmt of module.statements) {
            if (stmt.kind === 'ClassStmt') {
                const cls = stmt as ClassStmt;
                if (cls.name.text !== resolution.enclosingClass) continue;
                // Search all method bodies for the first assignment to this field
                for (const method of cls.methods) {
                    if (!method.body) continue;
                    const fieldToken = findFieldInBody(method.body, fieldName);
                    if (fieldToken) {
                        return new vscode.Location(document.uri, tokenToRange(document, fieldToken));
                    }
                }
            }
        }
        return null;
    }

    private findVariableDeclaration(
        document: vscode.TextDocument,
        varName: string,
        cursorOffset: number,
    ): vscode.Location | null {
        const module = this.service.getModule(document);
        return findDeclInModule(module, varName, cursorOffset, document);
    }

    private async findImportPathDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Location | null> {
        const index = await this.service.getFileIndex(document);
        for (const imp of index.imports) {
            if (imp.range.contains(position)) {
                if (isBuiltinModule(imp.moduleName)) return null;
                const resolvedPath = this.service.resolveModulePath(document, imp.moduleName);
                if (resolvedPath) {
                    return new vscode.Location(
                        vscode.Uri.file(resolvedPath),
                        new vscode.Position(0, 0),
                    );
                }
            }
        }
        return null;
    }
}

// =============================================================================
// Variable declaration finder (AST walk)
// =============================================================================

function findDeclInModule(module: Module, name: string, offset: number, doc: vscode.TextDocument): vscode.Location | null {
    for (const stmt of module.statements) {
        const result = findDeclInStmt(stmt, name, offset, doc);
        if (result) return result;
    }
    return null;
}

function findDeclInStmt(stmt: Stmt, name: string, offset: number, doc: vscode.TextDocument): vscode.Location | null {
    switch (stmt.kind) {
        case 'VarStmt':
            if (stmt.name.text === name && stmt.name.start < offset) {
                return new vscode.Location(doc.uri, tokenToRange(doc, stmt.name));
            }
            return null;

        case 'ClassStmt': {
            const cls = stmt as ClassStmt;
            const classStart = cls.foreignKeyword?.start ?? cls.classKeyword.start;
            const classEnd = cls.rightBrace.start + cls.rightBrace.length;
            if (offset < classStart || offset > classEnd) return null;

            for (const method of cls.methods) {
                const result = findDeclInMethod(method, name, offset, doc);
                if (result) return result;
            }
            return null;
        }

        case 'ImportStmt':
            if (stmt.variables) {
                for (const v of stmt.variables) {
                    if (v.text === name) {
                        return new vscode.Location(doc.uri, tokenToRange(doc, v));
                    }
                }
            }
            return null;

        case 'ForStmt': {
            const forStart = stmt.variable.start;
            const forBody = stmt.body;
            if (offset >= forStart && stmt.variable.text === name) {
                return new vscode.Location(doc.uri, tokenToRange(doc, stmt.variable));
            }
            return findDeclInStmt(forBody, name, offset, doc);
        }

        case 'BlockStmt':
            for (const s of stmt.statements) {
                const result = findDeclInStmt(s, name, offset, doc);
                if (result) return result;
            }
            return null;

        case 'IfStmt': {
            const r1 = findDeclInStmt(stmt.thenBranch, name, offset, doc);
            if (r1) return r1;
            if (stmt.elseBranch) return findDeclInStmt(stmt.elseBranch, name, offset, doc);
            return null;
        }

        case 'WhileStmt':
            return findDeclInStmt(stmt.body, name, offset, doc);

        default:
            // Expression statement — check for block arguments
            if (typeof stmt === 'object' && stmt !== null && 'kind' in stmt) {
                return findDeclInExpr(stmt as Expr, name, offset, doc);
            }
            return null;
    }
}

function findDeclInMethod(method: Method, name: string, offset: number, doc: vscode.TextDocument): vscode.Location | null {
    // Check method range — only search if cursor is within this method
    const methodStart = method.foreignKeyword?.start ?? method.staticKeyword?.start ?? method.constructKeyword?.start ?? method.name.start;
    // We don't have the closing brace token, so check body
    if (offset < methodStart) return null;

    if (method.parameters) {
        for (const param of method.parameters) {
            if (param.name.text === name) {
                return new vscode.Location(doc.uri, tokenToRange(doc, param.name));
            }
        }
    }
    if (method.subscriptParameters) {
        for (const param of method.subscriptParameters) {
            if (param.name.text === name) {
                return new vscode.Location(doc.uri, tokenToRange(doc, param.name));
            }
        }
    }
    if (method.body) {
        return findDeclInBody(method.body, name, offset, doc);
    }
    return null;
}

function findDeclInBody(body: Body, name: string, offset: number, doc: vscode.TextDocument): vscode.Location | null {
    // Check block parameters ({|x, y| ...})
    if (body.parameters) {
        for (const param of body.parameters) {
            if (param.name.text === name) {
                return new vscode.Location(doc.uri, tokenToRange(doc, param.name));
            }
        }
    }
    if (body.statements) {
        for (const s of body.statements) {
            const result = findDeclInStmt(s, name, offset, doc);
            if (result) return result;
        }
    }
    if (body.expression) {
        return findDeclInExpr(body.expression, name, offset, doc);
    }
    return null;
}

function findDeclInExpr(expr: Expr, name: string, offset: number, doc: vscode.TextDocument): vscode.Location | null {
    if (!expr || typeof expr !== 'object') return null;
    switch (expr.kind) {
        case 'CallExpr':
            if (expr.blockArgument) {
                return findDeclInBody(expr.blockArgument, name, offset, doc);
            }
            return null;
        default:
            return null;
    }
}

// =============================================================================
// Field finder (for go-to-definition on _field / __field)
// =============================================================================

function findFieldInBody(body: Body, fieldName: string): Token | null {
    if (body.statements) {
        for (const stmt of body.statements) {
            const result = findFieldInStmt(stmt, fieldName);
            if (result) return result;
        }
    }
    if (body.expression) {
        return findFieldInExpr(body.expression, fieldName);
    }
    return null;
}

function findFieldInStmt(stmt: Stmt, fieldName: string): Token | null {
    switch (stmt.kind) {
        case 'BlockStmt':
            for (const s of stmt.statements) {
                const r = findFieldInStmt(s, fieldName);
                if (r) return r;
            }
            return null;
        case 'IfStmt': {
            const r1 = findFieldInStmt(stmt.thenBranch, fieldName);
            if (r1) return r1;
            return stmt.elseBranch ? findFieldInStmt(stmt.elseBranch, fieldName) : null;
        }
        case 'WhileStmt':
            return findFieldInStmt(stmt.body, fieldName);
        case 'ForStmt':
            return findFieldInStmt(stmt.body, fieldName);
        default:
            if (typeof stmt === 'object' && 'kind' in stmt) {
                return findFieldInExpr(stmt as Expr, fieldName);
            }
            return null;
    }
}

function findFieldInExpr(expr: Expr, fieldName: string): Token | null {
    if (!expr || typeof expr !== 'object') return null;
    if (expr.kind === 'FieldExpr' && expr.name.text === fieldName) {
        return expr.name;
    }
    if (expr.kind === 'StaticFieldExpr' && expr.name.text === fieldName) {
        return expr.name;
    }
    if (expr.kind === 'AssignmentExpr') {
        const r = findFieldInExpr(expr.target, fieldName);
        if (r) return r;
        return findFieldInExpr(expr.value, fieldName);
    }
    return null;
}
