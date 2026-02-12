import * as path from 'path';
import * as vscode from 'vscode';
import {
    analyze,
    DiagnosticSeverity,
    TokenType,
    RecursiveVisitor,
} from '../../wren-analyzer/src/index.js';
import type {
    ClassStmt,
    Method,
    FieldExpr,
    StaticFieldExpr,
    Token,
    Diagnostic,
} from '../../wren-analyzer/src/index.js';
import { WrenClassSymbol, WrenFieldSymbol, WrenFileIndex, WrenImportSymbol, WrenMethodSymbol } from './types';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
    [DiagnosticSeverity.Error]: vscode.DiagnosticSeverity.Error,
    [DiagnosticSeverity.Warning]: vscode.DiagnosticSeverity.Warning,
    [DiagnosticSeverity.Info]: vscode.DiagnosticSeverity.Information,
};

export interface AnalysisOutput {
    index: WrenFileIndex;
    diagnostics: vscode.Diagnostic[];
}

// Built-in modules provided by the Wren VM — no .wren file to resolve
const BUILTIN_MODULES = new Set(['meta', 'random']);

export function isBuiltinModule(importPath: string): boolean {
    return BUILTIN_MODULES.has(importPath);
}

export function normalizeImportPath(value: string): string {
    let normalized = value.trim();
    if (!normalized.endsWith('.wren')) {
        normalized = `${normalized}.wren`;
    }
    if (!normalized.startsWith('./') && !normalized.startsWith('../')) {
        normalized = `./${normalized}`;
    }
    const sanitized = normalized.replace(/\\/g, '/');
    return path.normalize(sanitized);
}

export function analyzeDocument(document: vscode.TextDocument): AnalysisOutput {
    const source = document.getText();
    const { module, diagnostics: rawDiagnostics } = analyze(source, document.uri.fsPath);

    const classes: WrenClassSymbol[] = [];
    const imports: WrenImportSymbol[] = [];

    for (const stmt of module.statements) {
        if (stmt.kind === 'ClassStmt') {
            classes.push(buildClassSymbol(document, stmt));
        } else if (stmt.kind === 'ImportStmt') {
            const raw = stripQuotes(stmt.path.text);
            if (raw && !isBuiltinModule(raw)) {
                imports.push({
                    path: normalizeImportPath(raw),
                    range: new vscode.Range(
                        document.positionAt(stmt.path.start),
                        document.positionAt(stmt.path.start + stmt.path.length),
                    ),
                    variables: stmt.variables?.map(v => v.text) ?? null,
                });
            }
        }
    }

    const index: WrenFileIndex = {
        uri: document.uri,
        version: document.version,
        classes,
        imports,
        parsedAt: Date.now(),
    };

    const diagnostics = rawDiagnostics.map(d => {
        const start = document.positionAt(d.span.start);
        const end = document.positionAt(d.span.start + d.span.length);
        const diag = new vscode.Diagnostic(
            new vscode.Range(start, end),
            d.message,
            SEVERITY_MAP[d.severity] ?? vscode.DiagnosticSeverity.Information,
        );
        diag.source = 'wren-analyzer';
        diag.code = d.code;
        return diag;
    });

    return { index, diagnostics };
}

function stripQuotes(text: string): string {
    if (text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1);
    }
    return text;
}

function buildClassSymbol(document: vscode.TextDocument, cls: ClassStmt): WrenClassSymbol {
    const className = cls.name.text;

    // Class range: from 'foreign' or 'class' keyword to closing '}'
    const classKeywordStart = cls.foreignKeyword?.start ?? cls.classKeyword.start;

    const classEnd = cls.rightBrace.start + cls.rightBrace.length;
    const range = new vscode.Range(
        document.positionAt(classKeywordStart),
        document.positionAt(classEnd),
    );

    // Selection range: declaration line (up to the '{')
    const selectionRange = new vscode.Range(
        document.positionAt(classKeywordStart),
        document.positionAt(cls.leftBrace.start),
    );

    const methods: WrenMethodSymbol[] = [];
    const staticMethods: WrenMethodSymbol[] = [];
    const fields: WrenFieldSymbol[] = [];

    // Extract methods
    for (const method of cls.methods) {
        const sym = buildMethodSymbol(document, className, method);
        if (sym.isStatic) {
            staticMethods.push(sym);
        } else {
            methods.push(sym);
        }
    }

    // Extract fields from method bodies
    const fieldCollector = new FieldCollector();
    for (const method of cls.methods) {
        if (method.body) {
            fieldCollector.visitBody(method.body);
        }
    }
    for (const [name, token] of fieldCollector.instanceFields) {
        fields.push({
            name,
            range: tokenRange(document, token),
            isStatic: false,
        });
    }
    for (const [name, token] of fieldCollector.staticFields) {
        fields.push({
            name,
            range: tokenRange(document, token),
            isStatic: true,
        });
    }

    return {
        name: className,
        range,
        selectionRange,
        methods,
        staticMethods,
        fields,
    };
}

function buildMethodSymbol(
    document: vscode.TextDocument,
    className: string,
    method: Method,
): WrenMethodSymbol {
    const isStatic = method.staticKeyword !== null;
    const isConstructor = method.constructKeyword !== null;
    const isForeign = method.foreignKeyword !== null;
    const isSubscript = method.name.type === TokenType.RightBracket;

    let name: string;
    let params: string[];

    if (isSubscript) {
        const subParams = (method.subscriptParameters ?? []).map(p => p.name.text);

        if (method.isSetter) {
            const setterParams = (method.parameters ?? []).map(p => p.name.text);
            name = `[${subParams.join(', ')}]=`;
            params = [...subParams, ...setterParams];
        } else {
            name = `[${subParams.join(', ')}]`;
            params = subParams;
        }
    } else {
        name = method.name.text;
        params = (method.parameters ?? []).map(p => p.name.text);

        // Regular setter: name=(value)
        if (method.isSetter) {
            name = `${name}=`;
        }
    }

    const detail = buildSignatureLabel(className, name, params, {
        isStatic,
        isConstructor,
        isForeign,
    });

    // Method range: from first keyword to end of body (or end of name for foreign)
    const methodStart = method.foreignKeyword?.start
        ?? method.staticKeyword?.start
        ?? method.constructKeyword?.start
        ?? method.name.start;

    let methodEnd: number;
    if (method.body) {
        // Body ends at the closing '}'
        // We need to find the end of the body. The body's last statement or expression
        // gives us an approximation; but the actual '}' is consumed by finishBody.
        // For now, use the method name + a generous estimate.
        // Actually, body doesn't store its closing brace either.
        // Use the name token range as the method range (same as simpleParser does for the line).
        methodEnd = method.name.start + method.name.length;
    } else {
        // Foreign method: just the declaration
        methodEnd = method.name.start + method.name.length;
    }

    const range = new vscode.Range(
        document.positionAt(methodStart),
        document.positionAt(methodEnd),
    );

    return {
        name,
        params,
        isStatic,
        isConstructor,
        range,
        detail,
        className,
    };
}

function buildSignatureLabel(
    className: string,
    methodName: string,
    params: string[],
    qualifiers: { isStatic: boolean; isConstructor: boolean; isForeign: boolean },
): string {
    const prefixes: string[] = [];
    if (qualifiers.isConstructor) prefixes.push('construct');
    if (qualifiers.isForeign) prefixes.push('foreign');
    if (qualifiers.isStatic) prefixes.push('static');
    const qualifierBlock = prefixes.length ? `${prefixes.join(' ')} ` : '';

    // Subscript operators already have brackets in the name
    if (methodName.startsWith('[')) {
        return `${qualifierBlock}${className}.${methodName}`;
    }
    return `${qualifierBlock}${className}.${methodName}(${params.join(', ')})`;
}

function tokenRange(document: vscode.TextDocument, token: Token): vscode.Range {
    return new vscode.Range(
        document.positionAt(token.start),
        document.positionAt(token.start + token.length),
    );
}

/**
 * Walks method bodies to collect field usage (_name and __name).
 * Deduplicates by name, keeping the first occurrence for range.
 */
class FieldCollector extends RecursiveVisitor {
    readonly instanceFields = new Map<string, Token>();
    readonly staticFields = new Map<string, Token>();

    visitFieldExpr(node: FieldExpr): void {
        if (!this.instanceFields.has(node.name.text)) {
            this.instanceFields.set(node.name.text, node.name);
        }
    }

    visitStaticFieldExpr(node: StaticFieldExpr): void {
        if (!this.staticFields.has(node.name.text)) {
            this.staticFields.set(node.name.text, node.name);
        }
    }
}
