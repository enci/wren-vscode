import * as vscode from 'vscode';
import { WrenLanguageService } from './language/languageService';
import { AggregatedWorkspaceIndex, WrenClassSymbol, WrenMethodSymbol } from './language/types';

const KEYWORDS = ['class', 'construct', 'foreign', 'import', 'return', 'static', 'var'];

export function activate(context: vscode.ExtensionContext) {
    const languageService = new WrenLanguageService();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => languageService.handleConfigurationChange(event)),
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

    // --- Static analysis diagnostics (from the same analyze() call that powers IntelliSense) ---
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('wren');
    context.subscriptions.push(diagnosticCollection);

    const refreshDiagnostics = (document: vscode.TextDocument) => {
        if (document.languageId !== 'wren') { return; }
        diagnosticCollection.set(document.uri, languageService.getDiagnostics(document));
    };

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
        const index = await this.service.getFileIndex(document);
        return index.classes.map(convertClassToSymbol);
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
        const aggregate = await this.service.getWorkspaceAggregate(document);
        const contextInfo = analyzeCompletionContext(document, position);
        return buildCompletionItems(aggregate, contextInfo);
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
        const classBucket = aggregate.classes.get(context.receiver);
        if (context.receiverIsClass) {
            if (classBucket) {
                for (const methods of classBucket.staticMethods.values()) {
                    methods.forEach(method => register(`static:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
                }
                return items;
            }
        } else {
            for (const bucket of aggregate.classes.values()) {
                for (const methods of bucket.methods.values()) {
                    methods.forEach(method => register(`instance:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
                }
            }
            return items;
        }
    }

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

    for (const bucket of aggregate.classes.values()) {
        for (const methods of bucket.methods.values()) {
            methods.forEach(method => register(`method:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
        }
        for (const methods of bucket.staticMethods.values()) {
            methods.forEach(method => register(`static-global:${method.className}:${method.detail}`, createMethodCompletion(method, context.range)));
        }
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
