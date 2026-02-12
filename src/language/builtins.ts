import * as vscode from 'vscode';
import { WrenClassSymbol, WrenMethodSymbol } from './types';

/** A zero-length range used for built-in symbols that have no source location. */
const BUILTIN_RANGE = new vscode.Range(0, 0, 0, 0);

function method(
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

function cls(name: string, methods: WrenMethodSymbol[], staticMethods: WrenMethodSymbol[]): WrenClassSymbol {
    return {
        name,
        range: BUILTIN_RANGE,
        selectionRange: BUILTIN_RANGE,
        fields: [],
        methods,
        staticMethods,
    };
}

// ============================================================================
// Core classes — always available, no import needed
// Source: wren/src/vm/wren_core.wren + wren_core.c
// ============================================================================

// --- Object ---
// Base class of all Wren objects.
const OBJECT_CLASS = cls('Object', [
    method('Object', '!', []),
    method('Object', '==', ['other']),
    method('Object', '!=', ['other']),
    method('Object', 'is', ['class']),
    method('Object', 'toString', []),
    method('Object', 'type', []),
], [
    method('Object', 'same', ['a', 'b'], { isStatic: true }),
]);

// --- Class ---
// Metaclass of all classes.
const CLASS_CLASS = cls('Class', [
    method('Class', 'name', []),
    method('Class', 'supertype', []),
    method('Class', 'toString', []),
    method('Class', 'attributes', []),
], []);

// --- Bool ---
const BOOL_CLASS = cls('Bool', [
    method('Bool', '!', []),
    method('Bool', 'toString', []),
], []);

// --- Null ---
const NULL_CLASS = cls('Null', [
    method('Null', '!', []),
    method('Null', 'toString', []),
], []);

// --- Num ---
const NUM_CLASS = cls('Num', [
    // Arithmetic operators
    method('Num', '-', ['other']),
    method('Num', '+', ['other']),
    method('Num', '*', ['other']),
    method('Num', '/', ['other']),
    method('Num', '%', ['other']),
    // Comparison operators
    method('Num', '<', ['other']),
    method('Num', '>', ['other']),
    method('Num', '<=', ['other']),
    method('Num', '>=', ['other']),
    method('Num', '==', ['other']),
    method('Num', '!=', ['other']),
    // Bitwise operators
    method('Num', '&', ['other']),
    method('Num', '|', ['other']),
    method('Num', '^', ['other']),
    method('Num', '<<', ['other']),
    method('Num', '>>', ['other']),
    method('Num', '~', []),
    // Range operators
    method('Num', '..', ['other']),
    method('Num', '...', ['other']),
    // Unary / math
    method('Num', '-', []),  // unary negate
    method('Num', 'abs', []),
    method('Num', 'acos', []),
    method('Num', 'asin', []),
    method('Num', 'atan', []),
    method('Num', 'atan', ['x']),
    method('Num', 'cbrt', []),
    method('Num', 'ceil', []),
    method('Num', 'cos', []),
    method('Num', 'floor', []),
    method('Num', 'round', []),
    method('Num', 'sin', []),
    method('Num', 'sqrt', []),
    method('Num', 'tan', []),
    method('Num', 'log', []),
    method('Num', 'log2', []),
    method('Num', 'exp', []),
    method('Num', 'pow', ['exponent']),
    method('Num', 'fraction', []),
    method('Num', 'truncate', []),
    method('Num', 'sign', []),
    method('Num', 'isInteger', []),
    method('Num', 'isNan', []),
    method('Num', 'isInfinity', []),
    method('Num', 'min', ['other']),
    method('Num', 'max', ['other']),
    method('Num', 'clamp', ['min', 'max']),
    method('Num', 'toString', []),
], [
    // Static properties / constructors
    method('Num', 'fromString', ['value'], { isStatic: true }),
    method('Num', 'infinity', [], { isStatic: true }),
    method('Num', 'nan', [], { isStatic: true }),
    method('Num', 'pi', [], { isStatic: true }),
    method('Num', 'tau', [], { isStatic: true }),
    method('Num', 'largest', [], { isStatic: true }),
    method('Num', 'smallest', [], { isStatic: true }),
    method('Num', 'maxSafeInteger', [], { isStatic: true }),
    method('Num', 'minSafeInteger', [], { isStatic: true }),
]);

// --- Sequence ---
// Base class for all iterable types. Defined in wren_core.wren.
const SEQUENCE_CLASS = cls('Sequence', [
    method('Sequence', 'all', ['f']),
    method('Sequence', 'any', ['f']),
    method('Sequence', 'contains', ['element']),
    method('Sequence', 'count', []),
    method('Sequence', 'count', ['f']),
    method('Sequence', 'each', ['f']),
    method('Sequence', 'isEmpty', []),
    method('Sequence', 'map', ['transformation']),
    method('Sequence', 'skip', ['count']),
    method('Sequence', 'take', ['count']),
    method('Sequence', 'where', ['predicate']),
    method('Sequence', 'reduce', ['f']),
    method('Sequence', 'reduce', ['acc', 'f']),
    method('Sequence', 'join', []),
    method('Sequence', 'join', ['separator']),
    method('Sequence', 'toList', []),
    method('Sequence', 'toString', []),
], []);

// --- String ---
const STRING_CLASS = cls('String', [
    method('String', '+', ['other']),
    method('String', '*', ['count']),
    method('String', '==', ['other']),
    method('String', '!=', ['other']),
    method('String', '[', ['index']),
    method('String', 'byteAt_', ['index']),
    method('String', 'byteCount_', []),
    method('String', 'codePointAt_', ['index']),
    method('String', 'contains', ['other']),
    method('String', 'count', []),
    method('String', 'endsWith', ['suffix']),
    method('String', 'indexOf', ['search']),
    method('String', 'indexOf', ['search', 'start']),
    method('String', 'iterate', ['iterator']),
    method('String', 'iteratorValue', ['iterator']),
    method('String', 'replace', ['old', 'new']),
    method('String', 'split', ['delimiter']),
    method('String', 'startsWith', ['prefix']),
    method('String', 'trim', []),
    method('String', 'trim', ['chars']),
    method('String', 'trimEnd', []),
    method('String', 'trimEnd', ['chars']),
    method('String', 'trimStart', []),
    method('String', 'trimStart', ['chars']),
    method('String', 'bytes', []),
    method('String', 'codePoints', []),
    method('String', 'toString', []),
], [
    method('String', 'fromCodePoint', ['codePoint'], { isStatic: true }),
    method('String', 'fromByte', ['byte'], { isStatic: true }),
]);

// --- List ---
const LIST_CLASS = cls('List', [
    method('List', '[', ['index']),
    method('List', '[]=', ['index', 'value']),
    method('List', 'add', ['item']),
    method('List', 'addAll', ['other']),
    method('List', 'clear', []),
    method('List', 'count', []),
    method('List', 'indexOf', ['element']),
    method('List', 'insert', ['index', 'item']),
    method('List', 'iterate', ['iterator']),
    method('List', 'iteratorValue', ['iterator']),
    method('List', 'remove', ['value']),
    method('List', 'removeAt', ['index']),
    method('List', 'sort', []),
    method('List', 'sort', ['comparator']),
    method('List', 'swap', ['indexA', 'indexB']),
    method('List', '+', ['other']),
    method('List', '*', ['count']),
    method('List', 'toString', []),
], [
    method('List', 'new', [], { isConstructor: true }),
    method('List', 'filled', ['size', 'element'], { isStatic: true }),
]);

// --- Map ---
const MAP_CLASS = cls('Map', [
    method('Map', '[', ['key']),
    method('Map', '[]=', ['key', 'value']),
    method('Map', 'clear', []),
    method('Map', 'containsKey', ['key']),
    method('Map', 'count', []),
    method('Map', 'keys', []),
    method('Map', 'values', []),
    method('Map', 'iterate', ['iterator']),
    method('Map', 'remove', ['key']),
    method('Map', 'toString', []),
], [
    method('Map', 'new', [], { isConstructor: true }),
]);

// --- Range ---
const RANGE_CLASS = cls('Range', [
    method('Range', 'from', []),
    method('Range', 'to', []),
    method('Range', 'min', []),
    method('Range', 'max', []),
    method('Range', 'isInclusive', []),
    method('Range', 'iterate', ['iterator']),
    method('Range', 'iteratorValue', ['iterator']),
    method('Range', 'toString', []),
], []);

// --- Fiber ---
const FIBER_CLASS = cls('Fiber', [
    method('Fiber', 'call', []),
    method('Fiber', 'call', ['value']),
    method('Fiber', 'error', []),
    method('Fiber', 'isDone', []),
    method('Fiber', 'transfer', []),
    method('Fiber', 'transfer', ['value']),
    method('Fiber', 'transferError', ['error']),
    method('Fiber', 'try', []),
    method('Fiber', 'try', ['value']),
], [
    method('Fiber', 'new', ['fn'], { isConstructor: true }),
    method('Fiber', 'abort', ['error'], { isStatic: true }),
    method('Fiber', 'current', [], { isStatic: true }),
    method('Fiber', 'suspend', [], { isStatic: true }),
    method('Fiber', 'yield', [], { isStatic: true }),
    method('Fiber', 'yield', ['value'], { isStatic: true }),
]);

// --- Fn ---
const FN_CLASS = cls('Fn', [
    method('Fn', 'arity', []),
    method('Fn', 'call', []),
    method('Fn', 'call', ['a']),
    method('Fn', 'call', ['a', 'b']),
    method('Fn', 'call', ['a', 'b', 'c']),
    method('Fn', 'call', ['a', 'b', 'c', 'd']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o']),
    method('Fn', 'call', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']),
    method('Fn', 'toString', []),
], [
    method('Fn', 'new', ['fn'], { isConstructor: true }),
]);

// --- System ---
// All methods are static.
const SYSTEM_CLASS = cls('System', [], [
    method('System', 'print', [], { isStatic: true }),
    method('System', 'print', ['object'], { isStatic: true }),
    method('System', 'printAll', ['sequence'], { isStatic: true }),
    method('System', 'write', ['object'], { isStatic: true }),
    method('System', 'writeAll', ['sequence'], { isStatic: true }),
    method('System', 'clock', [], { isStatic: true }),
    method('System', 'gc', [], { isStatic: true }),
]);

// --- MapEntry (used by Map iteration) ---
const MAP_ENTRY_CLASS = cls('MapEntry', [
    method('MapEntry', 'key', []),
    method('MapEntry', 'value', []),
    method('MapEntry', 'toString', []),
], []);

/**
 * Core classes that are always available in every Wren program (no import needed).
 */
export const CORE_CLASSES: WrenClassSymbol[] = [
    OBJECT_CLASS,
    CLASS_CLASS,
    BOOL_CLASS,
    NULL_CLASS,
    NUM_CLASS,
    SEQUENCE_CLASS,
    STRING_CLASS,
    LIST_CLASS,
    MAP_CLASS,
    RANGE_CLASS,
    FIBER_CLASS,
    FN_CLASS,
    SYSTEM_CLASS,
    MAP_ENTRY_CLASS,
];

// ============================================================================
// Optional built-in modules — require `import`
// ============================================================================

// --- Random module ---
// https://wren.io/modules/random/random.html

const RANDOM_CLASS = cls('Random', [
    method('Random', 'float', []),
    method('Random', 'float', ['end']),
    method('Random', 'float', ['start', 'end']),
    method('Random', 'int', ['end']),
    method('Random', 'int', ['start', 'end']),
    method('Random', 'sample', ['list']),
    method('Random', 'sample', ['list', 'count']),
    method('Random', 'shuffle', ['list']),
], [
    method('Random', 'new', [], { isConstructor: true }),
    method('Random', 'new', ['seed'], { isConstructor: true }),
]);

// --- Meta module ---
// https://wren.io/modules/meta/meta.html

const META_CLASS = cls('Meta', [], [
    method('Meta', 'getModuleVariables', ['module'], { isStatic: true }),
    method('Meta', 'eval', ['source'], { isStatic: true }),
    method('Meta', 'compileExpression', ['source'], { isStatic: true }),
    method('Meta', 'compile', ['source'], { isStatic: true }),
]);

const BUILTIN_MODULES: Record<string, WrenClassSymbol[]> = {
    'random': [RANDOM_CLASS],
    'meta': [META_CLASS],
};

/**
 * Returns the class symbols for a built-in module, or undefined if not built-in.
 */
export function getBuiltinClasses(moduleName: string): WrenClassSymbol[] | undefined {
    return BUILTIN_MODULES[moduleName];
}
