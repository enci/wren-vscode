// =============================================================================
// Built-in class symbols for autocomplete and signature help.
//
// Instead of maintaining 380+ lines of hand-coded definitions, we parse the
// Wren stub strings from the analyzer's core module.  The stubs declare every
// method signature as `foreign`, so the parser extracts names, arities, and
// parameter names automatically.
//
// `Null` and `Class` cannot appear in stub source (they are Wren keywords), so
// they are defined manually below — their methods are simple and rarely change.
// =============================================================================

import * as vscode from 'vscode';
import { WrenClassSymbol, WrenMethodSymbol } from './types';
import { Lexer, Parser, SourceFile } from '../../wren-analyzer/src/index';
import type { ClassStmt, Method, Module } from '../../wren-analyzer/src/index';
import {
    CORE_MODULE_SOURCE,
    RANDOM_MODULE_SOURCE,
    META_MODULE_SOURCE,
} from '../../wren-analyzer/src/core/stubs';

/** A zero-length range used for built-in symbols that have no source location. */
const BUILTIN_RANGE = new vscode.Range(0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Parse a Wren stub source string into a Module AST. */
function parseStubSource(source: string, path: string): Module {
    const file = new SourceFile(path, source);
    const lexer = new Lexer(file);
    const parser = new Parser(lexer);
    return parser.parseModule();
}

/** Convert a parsed Method AST node into a WrenMethodSymbol. */
function convertMethod(className: string, m: Method): WrenMethodSymbol {
    const isStatic = m.staticKeyword !== null;
    const isConstructor = m.constructKeyword !== null;

    // Collect parameter names from the AST.
    // For subscript operators like `[index]` the params are in subscriptParameters;
    // for setters like `[index]=(value)` we combine subscript + regular params.
    const params: string[] = [];
    if (m.subscriptParameters) {
        for (const p of m.subscriptParameters) {
            params.push(p.name.text);
        }
    }
    if (m.parameters) {
        for (const p of m.parameters) {
            params.push(p.name.text);
        }
    }

    // Build a human-readable detail string for hover / signature help
    const prefixes: string[] = [];
    if (isConstructor) prefixes.push('construct');
    if (isStatic) prefixes.push('static');
    const qualifier = prefixes.length ? `${prefixes.join(' ')} ` : '';
    const detail = `${qualifier}${className}.${m.name.text}(${params.join(', ')})`;

    return {
        name: m.name.text,
        params,
        isStatic,
        isConstructor,
        range: BUILTIN_RANGE,
        detail,
        className,
    };
}

/** Convert a parsed ClassStmt into a WrenClassSymbol. */
function convertClass(cls: ClassStmt): WrenClassSymbol {
    const methods: WrenMethodSymbol[] = [];
    const staticMethods: WrenMethodSymbol[] = [];

    for (const m of cls.methods) {
        const sym = convertMethod(cls.name.text, m);
        if (sym.isStatic || sym.isConstructor) {
            staticMethods.push(sym);
        } else {
            methods.push(sym);
        }
    }

    return {
        name: cls.name.text,
        range: BUILTIN_RANGE,
        selectionRange: BUILTIN_RANGE,
        fields: [],
        methods,
        staticMethods,
    };
}

/** Parse a Wren stub string and return WrenClassSymbol[] for all classes in it. */
function parseModuleClasses(source: string, path: string): WrenClassSymbol[] {
    const module = parseStubSource(source, path);
    const result: WrenClassSymbol[] = [];
    for (const stmt of module.statements) {
        if (stmt.kind === 'ClassStmt') {
            result.push(convertClass(stmt as ClassStmt));
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Manually-defined classes (keywords that can't be parsed as class names)
// ---------------------------------------------------------------------------

function manualMethod(
    className: string,
    name: string,
    params: string[],
    opts: { isStatic?: boolean; isConstructor?: boolean } = {},
): WrenMethodSymbol {
    const isStatic = opts.isStatic ?? false;
    const isConstructor = opts.isConstructor ?? false;
    const prefixes: string[] = [];
    if (isConstructor) prefixes.push('construct');
    if (isStatic) prefixes.push('static');
    const qualifier = prefixes.length ? `${prefixes.join(' ')} ` : '';
    const detail = `${qualifier}${className}.${name}(${params.join(', ')})`;

    return {
        name,
        params,
        isStatic,
        isConstructor,
        range: BUILTIN_RANGE,
        detail,
        className,
    };
}

function manualClass(name: string, methods: WrenMethodSymbol[], staticMethods: WrenMethodSymbol[]): WrenClassSymbol {
    return {
        name,
        range: BUILTIN_RANGE,
        selectionRange: BUILTIN_RANGE,
        fields: [],
        methods,
        staticMethods,
    };
}

/** `Class` — metaclass of all classes. `class` is a keyword so can't be in stubs. */
const CLASS_CLASS = manualClass('Class', [
    manualMethod('Class', 'name', []),
    manualMethod('Class', 'supertype', []),
    manualMethod('Class', 'toString', []),
    manualMethod('Class', 'attributes', []),
], []);

/** `Null` — `null` is a keyword so can't be in stubs. */
const NULL_CLASS = manualClass('Null', [
    manualMethod('Null', '!', []),
    manualMethod('Null', 'toString', []),
], []);

// ---------------------------------------------------------------------------
// Cached results — parsed once at startup
// ---------------------------------------------------------------------------

let coreClassesCache: WrenClassSymbol[] | null = null;
let randomClassesCache: WrenClassSymbol[] | null = null;
let metaClassesCache: WrenClassSymbol[] | null = null;

function getCoreClassesCached(): WrenClassSymbol[] {
    if (!coreClassesCache) {
        const parsed = parseModuleClasses(CORE_MODULE_SOURCE, '<core>');
        // Add the manually-defined keyword classes
        coreClassesCache = [...parsed, CLASS_CLASS, NULL_CLASS];
    }
    return coreClassesCache;
}

function getRandomClassesCached(): WrenClassSymbol[] {
    if (!randomClassesCache) {
        randomClassesCache = parseModuleClasses(RANDOM_MODULE_SOURCE, '<random>');
    }
    return randomClassesCache;
}

function getMetaClassesCached(): WrenClassSymbol[] {
    if (!metaClassesCache) {
        metaClassesCache = parseModuleClasses(META_MODULE_SOURCE, '<meta>');
    }
    return metaClassesCache;
}

// ---------------------------------------------------------------------------
// Public API (same interface as before)
// ---------------------------------------------------------------------------

/**
 * Core classes that are always available in every Wren program (no import needed).
 */
export const CORE_CLASSES: WrenClassSymbol[] = getCoreClassesCached();

/**
 * Returns the class symbols for a built-in module, or undefined if not built-in.
 */
export function getBuiltinClasses(moduleName: string): WrenClassSymbol[] | undefined {
    switch (moduleName) {
        case 'random':
            return getRandomClassesCached();
        case 'meta':
            return getMetaClassesCached();
        default:
            return undefined;
    }
}
