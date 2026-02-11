import * as path from 'path';
import * as vscode from 'vscode';
import { WrenClassSymbol, WrenFieldSymbol, WrenFileIndex, WrenMethodSymbol } from './types';

interface ScrubResult {
    source: string;
    mask: Uint8Array;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;

export function parseWrenDocument(document: vscode.TextDocument): WrenFileIndex {
    const parser = new SimpleWrenParser(document);
    return parser.parse();
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

class SimpleWrenParser {
    private readonly text: string;
    private readonly scrubbed: string;
    private readonly mask: Uint8Array;

    constructor(private readonly document: vscode.TextDocument) {
        this.text = document.getText();
        const scrubbed = scrubSource(this.text);
        this.scrubbed = scrubbed.source;
        this.mask = scrubbed.mask;
    }

    parse(): WrenFileIndex {
        return {
            uri: this.document.uri,
            version: this.document.version,
            classes: this.parseClasses(),
            imports: this.parseImports(),
            parsedAt: Date.now()
        };
    }

    private parseClasses(): WrenClassSymbol[] {
        const classes: WrenClassSymbol[] = [];
        const classPattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/gy;
        let match: RegExpExecArray | null;
        while ((match = classPattern.exec(this.scrubbed)) !== null) {
            const className = match[1];
            const braceIndex = this.scrubbed.indexOf('{', classPattern.lastIndex);
            if (braceIndex === -1) {
                continue;
            }
            const endBrace = findMatchingBrace(this.scrubbed, braceIndex);
            if (endBrace === -1) {
                continue;
            }

            const range = new vscode.Range(
                this.document.positionAt(match.index),
                this.document.positionAt(endBrace + 1)
            );
            const selectionRange = new vscode.Range(
                this.document.positionAt(match.index),
                this.document.positionAt(braceIndex)
            );
            const bodyStart = braceIndex + 1;
            const bodyEnd = endBrace;
            const analysis = this.parseClassBody(className, bodyStart, bodyEnd);

            classes.push({
                name: className,
                range,
                selectionRange,
                methods: analysis.methods,
                staticMethods: analysis.staticMethods,
                fields: analysis.fields
            });
        }

        return classes;
    }

    private parseClassBody(className: string, bodyStart: number, bodyEnd: number) {
        const methods: WrenMethodSymbol[] = [];
        const staticMethods: WrenMethodSymbol[] = [];
        const fields: WrenFieldSymbol[] = [];

        let depth = 0;
        let lineStart = bodyStart;
        let lineDepthBefore = depth;

        for (let i = bodyStart; i <= bodyEnd; i++) {
            if (i === lineStart) {
                lineDepthBefore = depth;
            }

            const ch = this.scrubbed[i] ?? '\n';
            if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth = Math.max(0, depth - 1);
            }

            if (ch === '\n') {
                if (lineDepthBefore === 0) {
                    this.processClassLine(className, lineStart, i, methods, staticMethods, fields);
                }
                lineStart = i + 1;
            }
        }

        if (lineStart < bodyEnd) {
            this.processClassLine(className, lineStart, bodyEnd, methods, staticMethods, fields);
        }

        return { methods, staticMethods, fields };
    }

    private processClassLine(
        className: string,
        start: number,
        end: number,
        methods: WrenMethodSymbol[],
        staticMethods: WrenMethodSymbol[],
        fields: WrenFieldSymbol[]
    ) {
        const fullLine = this.text.slice(start, end);
        const trimmed = fullLine.trim();
        if (!trimmed) {
            return;
        }

        const leadingWhitespace = fullLine.length - fullLine.trimStart().length;
        const trailingWhitespace = fullLine.length - fullLine.trimEnd().length;
        const statementStart = start + leadingWhitespace;
        const statementEnd = end - trailingWhitespace;
        const statementRange = new vscode.Range(
            this.document.positionAt(statementStart),
            this.document.positionAt(statementEnd)
        );

        if (trimmed.startsWith('var ')) {
            const nameMatch = /^var\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
            if (nameMatch) {
                fields.push({
                    name: nameMatch[1],
                    range: statementRange,
                    isStatic: /^var\s+__/.test(trimmed)
                });
            }
            return;
        }

        const qualifierStripped = trimmed.replace(/^(?:#\S+\s+)*/g, '');
        const qualifierResult = extractQualifiers(qualifierStripped);
        const remaining = qualifierResult.remaining;
        const qualifiers = qualifierResult.qualifiers;

        if (remaining.startsWith('[')) {
            // Subscript getters/setters are treated as methods for the outline.
            const subscript = parseSubscriptSignature(remaining, className, statementRange);
            if (subscript) {
                const target = subscript.isStatic ? staticMethods : methods;
                target.push(subscript);
            }
            return;
        }

        IDENTIFIER.lastIndex = 0;
        const nameMatch = IDENTIFIER.exec(remaining);
        if (!nameMatch) {
            return;
        }

        const name = nameMatch[0];
        const paramMatch = remaining.slice(name.length).match(/^\s*\(([^)]*)\)/);
        const params = paramMatch ? splitParams(paramMatch[1]) : [];
        const isStatic = qualifiers.has('static');
        const isConstructor = qualifiers.has('construct');
        const detail = buildSignatureLabel(className, name, params, qualifiers);

        const method: WrenMethodSymbol = {
            name,
            params,
            isStatic,
            isConstructor,
            range: statementRange,
            detail,
            className
        };

        (isStatic ? staticMethods : methods).push(method);
    }

    private parseImports(): string[] {
        const imports = new Set<string>();
        const importPattern = /\bimport\s+"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = importPattern.exec(this.text)) !== null) {
            if (!this.isCode(match.index)) {
                continue;
            }
            imports.add(normalizeImportPath(match[1]));
        }
        return [...imports];
    }

    private isCode(index: number): boolean {
        if (index < 0 || index >= this.mask.length) {
            return false;
        }
        return this.mask[index] === 1;
    }
}

function extractQualifiers(source: string) {
    const qualifiers = new Set<string>();
    let remaining = source;
    const qualifierPattern = /^(foreign|static|construct)\b\s*/;
    while (true) {
        const match = qualifierPattern.exec(remaining);
        if (!match) {
            break;
        }
        qualifiers.add(match[1]);
        remaining = remaining.slice(match[0].length);
    }
    return { qualifiers, remaining };
}

function splitParams(segment: string): string[] {
    return segment
        .split(',')
        .map(token => token.trim())
        .filter(Boolean);
}

function buildSignatureLabel(
    className: string,
    methodName: string,
    params: string[],
    qualifiers: Set<string>
): string {
    const prefixes: string[] = [];
    if (qualifiers.has('construct')) {
        prefixes.push('construct');
    }
    if (qualifiers.has('foreign')) {
        prefixes.push('foreign');
    }
    if (qualifiers.has('static')) {
        prefixes.push('static');
    }
    const qualifierBlock = prefixes.length ? `${prefixes.join(' ')} ` : '';
    return `${qualifierBlock}${className}.${methodName}(${params.join(', ')})`;
}

function parseSubscriptSignature(line: string, className: string, range: vscode.Range): WrenMethodSymbol | undefined {
    const setterMatch = /^\[([^\]]+)\]\s*=\s*\(([^)]*)\)/.exec(line);
    if (setterMatch) {
        const params = splitParams(`${setterMatch[1]}, ${setterMatch[2]}`);
        return {
            name: `[${setterMatch[1]}]=`,
            params,
            isStatic: false,
            isConstructor: false,
            range,
            detail: `${className}.[${setterMatch[1]}]=(${setterMatch[2]})`,
            className
        } as WrenMethodSymbol;
    }

    const getterMatch = /^\[([^\]]+)\]/.exec(line);
    if (!getterMatch) {
        return undefined;
    }
    const params = splitParams(getterMatch[1]);
    return {
        name: `[${getterMatch[1]}]`,
        params,
        isStatic: false,
        isConstructor: false,
        range,
        detail: `${className}.[${getterMatch[1]}]`,
        className
    } as WrenMethodSymbol;
}

function scrubSource(text: string): ScrubResult {
    const chars = text.split('');
    const mask = new Uint8Array(chars.length).fill(1);
    let i = 0;

    while (i < chars.length) {
        const ch = chars[i];
        const next = chars[i + 1];

        if (ch === '/' && next === '/') {
            mask[i] = 0;
            mask[i + 1] = 0;
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            while (i < chars.length && chars[i] !== '\n') {
                mask[i] = 0;
                if (chars[i] !== '\n') {
                    chars[i] = ' ';
                }
                i += 1;
            }
            continue;
        }

        if (ch === '/' && next === '*') {
            mask[i] = 0;
            mask[i + 1] = 0;
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            let depth = 1;
            while (i < chars.length && depth > 0) {
                const current = chars[i];
                const upcoming = chars[i + 1];
                mask[i] = 0;
                if (current === '/' && upcoming === '*') {
                    mask[i + 1] = 0;
                    chars[i] = ' ';
                    chars[i + 1] = ' ';
                    depth += 1;
                    i += 2;
                    continue;
                }
                if (current === '*' && upcoming === '/') {
                    mask[i + 1] = 0;
                    chars[i] = ' ';
                    chars[i + 1] = ' ';
                    depth -= 1;
                    i += 2;
                    continue;
                }
                if (current === '\n') {
                    i += 1;
                    continue;
                }
                chars[i] = ' ';
                i += 1;
            }
            continue;
        }

        if (ch === '"') {
            mask[i] = 0;
            chars[i] = ' ';
            i += 1;
            while (i < chars.length) {
                mask[i] = 0;
                const current = chars[i];
                if (current === '\\') {
                    if (i + 1 < chars.length) {
                        mask[i + 1] = 0;
                        if (chars[i + 1] !== '\n') {
                            chars[i + 1] = ' ';
                        }
                    }
                    chars[i] = ' ';
                    i += 2;
                    continue;
                }
                if (current === '"') {
                    chars[i] = ' ';
                    i += 1;
                    break;
                }
                if (current !== '\n') {
                    chars[i] = ' ';
                }
                i += 1;
            }
            continue;
        }

        i += 1;
    }

    return { source: chars.join(''), mask };
}

function findMatchingBrace(text: string, openIndex: number): number {
    let depth = 1;
    for (let i = openIndex + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}
