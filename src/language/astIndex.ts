import * as path from 'path';
import * as vscode from 'vscode';
import {
    analyze,
    DiagnosticSeverity,
    TokenType,
    RecursiveVisitor,
} from '../../wren-analyzer/src/index';
import type {
    Module,
    Stmt,
    Expr,
    ClassStmt,
    Method,
    Body,
    FieldExpr,
    StaticFieldExpr,
    VarStmt,
    ForStmt,
    BlockStmt,
    IfStmt,
    WhileStmt,
    CallExpr,
    Token,
    Diagnostic,
    Parameter,
} from '../../wren-analyzer/src/index';
import { WrenClassSymbol, WrenFieldSymbol, WrenFileIndex, WrenImportSymbol, WrenMethodSymbol } from './types';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
    [DiagnosticSeverity.Error]: vscode.DiagnosticSeverity.Error,
    [DiagnosticSeverity.Warning]: vscode.DiagnosticSeverity.Warning,
    [DiagnosticSeverity.Info]: vscode.DiagnosticSeverity.Information,
};

export interface AnalysisOutput {
    index: WrenFileIndex;
    diagnostics: vscode.Diagnostic[];
    module: Module;
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
            if (raw) {
                imports.push({
                    moduleName: raw,
                    path: normalizeImportPath(raw),
                    range: new vscode.Range(
                        document.positionAt(stmt.path.start),
                        document.positionAt(stmt.path.start + stmt.path.length),
                    ),
                    variables: stmt.variables?.map((v: Token) => v.text) ?? null,
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

    const diagnostics = rawDiagnostics.map((d: Diagnostic) => {
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

    return { index, diagnostics, module };
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
        const subParams = (method.subscriptParameters ?? []).map((p: Parameter) => p.name.text);

        if (method.isSetter) {
            const setterParams = (method.parameters ?? []).map((p: Parameter) => p.name.text);
            name = `[${subParams.join(', ')}]=`;
            params = [...subParams, ...setterParams];
        } else {
            name = `[${subParams.join(', ')}]`;
            params = subParams;
        }
    } else {
        name = method.name.text;
        params = (method.parameters ?? []).map((p: Parameter) => p.name.text);

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

// ============================================================================
// Scope-aware type resolution
// ============================================================================

export interface TypeResolution {
    /** Variable name → type name (e.g. "c" → "C", "n" → "Num") */
    locals: Map<string, string>;
    /** The class name the cursor is inside, if any (for `this.` resolution) */
    enclosingClass: string | null;
}

/**
 * Resolves the types of all visible local variables at a given character offset.
 * Walks the module AST, collecting VarStmt and Parameter type annotations
 * that are visible at the cursor position, respecting lexical scoping.
 */
export function resolveTypeAtPosition(module: Module, offset: number): TypeResolution {
    const locals = new Map<string, string>();
    let enclosingClass: string | null = null;

    // Walk top-level statements
    for (const stmt of module.statements) {
        if (stmt.kind === 'ClassStmt') {
            const cls = stmt;
            const classStart = cls.foreignKeyword?.start ?? cls.classKeyword.start;
            const classEnd = cls.rightBrace.start + cls.rightBrace.length;

            if (offset >= classStart && offset <= classEnd) {
                enclosingClass = cls.name.text;
                // Search inside this class's methods
                for (const method of cls.methods) {
                    collectFromMethod(method, offset, locals);
                }
                break; // Cursor is inside this class, stop top-level walk
            }
        } else if (stmt.kind === 'VarStmt') {
            // Module-level var: visible if declared before cursor
            if (stmt.name.start < offset) {
                const typeName = resolveVarType(stmt);
                if (typeName) {
                    locals.set(stmt.name.text, typeName);
                }
            }
        }
    }

    return { locals, enclosingClass };
}

function collectFromMethod(method: Method, offset: number, locals: Map<string, string>): void {
    if (!method.body) return;

    // Check if cursor is inside this method's body
    // Method range: from first keyword to end (we approximate using body content)
    const methodStart = method.foreignKeyword?.start
        ?? method.staticKeyword?.start
        ?? method.constructKeyword?.start
        ?? method.name.start;

    // We need the end of the method body. Since Body doesn't store its closing brace,
    // we check if offset is after method start. If the cursor is inside any of this
    // method's body statements, we'll find it during traversal.
    if (offset < methodStart) return;

    // Collect method parameters
    if (method.parameters) {
        for (const param of method.parameters) {
            if (param.typeAnnotation) {
                locals.set(param.name.text, param.typeAnnotation.name.text);
            }
        }
    }

    // Collect subscript parameters
    if (method.subscriptParameters) {
        for (const param of method.subscriptParameters) {
            if (param.typeAnnotation) {
                locals.set(param.name.text, param.typeAnnotation.name.text);
            }
        }
    }

    // Walk body
    collectFromBody(method.body, offset, locals);
}

function collectFromBody(body: Body, offset: number, locals: Map<string, string>): void {
    // Block argument parameters (e.g. {|x| ... })
    if (body.parameters) {
        for (const param of body.parameters) {
            if (param.typeAnnotation) {
                locals.set(param.name.text, param.typeAnnotation.name.text);
            }
        }
    }

    if (body.statements) {
        collectFromStatements(body.statements, offset, locals);
    }
}

function collectFromStatements(statements: Stmt[], offset: number, locals: Map<string, string>): void {
    for (const stmt of statements) {
        collectFromStmt(stmt, offset, locals);
    }
}

function collectFromStmt(stmt: Stmt, offset: number, locals: Map<string, string>): void {
    switch (stmt.kind) {
        case 'VarStmt':
            // Only collect if declared before cursor
            if (stmt.name.start < offset) {
                const typeName = resolveVarType(stmt);
                if (typeName) {
                    locals.set(stmt.name.text, typeName);
                }
            }
            break;

        case 'BlockStmt':
            collectFromStatements(stmt.statements, offset, locals);
            break;

        case 'IfStmt':
            collectFromStmt(stmt.thenBranch, offset, locals);
            if (stmt.elseBranch) {
                collectFromStmt(stmt.elseBranch, offset, locals);
            }
            break;

        case 'WhileStmt':
            collectFromStmt(stmt.body, offset, locals);
            break;

        case 'ForStmt':
            // For loop variable with type annotation
            if (stmt.variable.start < offset && stmt.typeAnnotation) {
                locals.set(stmt.variable.text, stmt.typeAnnotation.name.text);
            }
            collectFromStmt(stmt.body, offset, locals);
            break;

        default:
            // Expression statements — walk into CallExpr block arguments
            collectFromExprBlockArgs(stmt, offset, locals);
            break;
    }
}

/**
 * Walk expression trees looking for block arguments (closures) that may
 * contain the cursor position and have typed parameters or var declarations.
 */
function collectFromExprBlockArgs(expr: Expr | Stmt, offset: number, locals: Map<string, string>): void {
    if (!expr || typeof expr !== 'object' || !('kind' in expr)) return;

    if (expr.kind === 'CallExpr') {
        if (expr.blockArgument) {
            collectFromBody(expr.blockArgument, offset, locals);
        }
    }
}

/**
 * Resolve the type of a VarStmt from its annotation or initializer.
 */
function resolveVarType(stmt: VarStmt): string | null {
    // Explicit type annotation takes priority
    if (stmt.typeAnnotation) {
        return stmt.typeAnnotation.name.text;
    }

    // Infer from initializer expression
    if (stmt.initializer) {
        return inferExprType(stmt.initializer);
    }

    return null;
}

/**
 * Infer the type of an expression from its AST node kind.
 */
function inferExprType(expr: Expr): string | null {
    switch (expr.kind) {
        case 'NumExpr':
            return 'Num';
        case 'StringExpr':
        case 'InterpolationExpr':
            return 'String';
        case 'BoolExpr':
            return 'Bool';
        case 'NullExpr':
            return 'Null';
        case 'ListExpr':
            return 'List';
        case 'MapExpr':
            return 'Map';
        case 'CallExpr': {
            // Foo.new() → type is Foo
            const call = expr;
            if (call.name.text === 'new' && call.receiver) {
                const receiverName = getReceiverClassName(call.receiver);
                if (receiverName) {
                    return receiverName;
                }
            }
            return null;
        }
        case 'GroupingExpr':
            return inferExprType(expr.expression);
        default:
            return null;
    }
}

/**
 * Extract the class name from a receiver expression (for Foo.new() patterns).
 */
function getReceiverClassName(expr: Expr): string | null {
    // Direct class reference: CallExpr { receiver: null, name: "Foo", arguments: null }
    if (expr.kind === 'CallExpr') {
        const call = expr as CallExpr;
        if (call.receiver === null && call.arguments === null && /^[A-Z]/.test(call.name.text)) {
            return call.name.text;
        }
    }
    return null;
}

// ============================================================================
// Field collection
// ============================================================================

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
