import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AggregatedClassIndex, AggregatedWorkspaceIndex, WrenFileIndex } from './types';
import { analyzeDocument, normalizeImportPath } from './astIndex';
import type { AnalysisOutput } from './astIndex';

interface CachedAnalysis {
    index: WrenFileIndex;
    diagnostics: vscode.Diagnostic[];
}

interface ExternalCacheEntry {
    analysis: CachedAnalysis;
    mtime: number;
}

export class WrenLanguageService {
    private readonly documentCache = new Map<string, CachedAnalysis>();
    private readonly externalCache = new Map<string, ExternalCacheEntry>();
    private additionalSearchRoots: string[] = [];

    constructor() {
        this.refreshConfiguration();
    }

    handleConfigurationChange(event?: vscode.ConfigurationChangeEvent) {
        if (!event || event.affectsConfiguration('wren.additionalModuleDirectories')) {
            this.refreshConfiguration();
            this.externalCache.clear();
        }
    }

    invalidateDocument(document: vscode.TextDocument) {
        const key = document.uri.fsPath;
        this.documentCache.delete(key);
    }

    evictPath(fsPath: string) {
        this.documentCache.delete(fsPath);
        this.externalCache.delete(fsPath);
    }

    /** Run full analysis (lexer + parser + resolver + type-checker) and cache the result. */
    private analyzeAndCache(document: vscode.TextDocument): CachedAnalysis {
        const key = document.uri.fsPath;
        const cached = this.documentCache.get(key);
        if (cached && cached.index.version === document.version) {
            return cached;
        }
        const { index, diagnostics } = analyzeDocument(document);
        const entry = { index, diagnostics };
        this.documentCache.set(key, entry);
        return entry;
    }

    async getFileIndex(document: vscode.TextDocument): Promise<WrenFileIndex> {
        return this.analyzeAndCache(document).index;
    }

    getDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
        return this.analyzeAndCache(document).diagnostics;
    }

    async getWorkspaceAggregate(document: vscode.TextDocument): Promise<AggregatedWorkspaceIndex> {
        const rootIndex = await this.getFileIndex(document);
        const indexes = await this.collectWorkspaceIndexes(rootIndex);
        const classes = new Map<string, AggregatedClassIndex>();

        for (const fileIndex of indexes) {
            for (const cls of fileIndex.classes) {
                let bucket = classes.get(cls.name);
                if (!bucket) {
                    bucket = {
                        name: cls.name,
                        methods: new Map(),
                        staticMethods: new Map()
                    };
                    classes.set(cls.name, bucket);
                }

                for (const method of cls.methods) {
                    const list = bucket.methods.get(method.name) ?? [];
                    list.push(method);
                    bucket.methods.set(method.name, list);
                }

                for (const method of cls.staticMethods) {
                    const list = bucket.staticMethods.get(method.name) ?? [];
                    list.push(method);
                    bucket.staticMethods.set(method.name, list);
                }
            }
        }

        return { classes };
    }

    private async collectWorkspaceIndexes(entry: WrenFileIndex): Promise<WrenFileIndex[]> {
        const results: WrenFileIndex[] = [];
        const visited = new Set<string>();
        const pending = [entry];

        while (pending.length > 0) {
            const current = pending.pop()!;
            const fsPath = current.uri.fsPath;
            if (visited.has(fsPath)) {
                continue;
            }
            visited.add(fsPath);
            results.push(current);

            for (const request of current.imports) {
                const candidates = this.resolveCandidates(fsPath, request);
                for (const candidate of candidates) {
                    if (visited.has(candidate)) {
                        continue;
                    }
                    const index = await this.loadIndex(candidate);
                    if (index) {
                        pending.push(index);
                    }
                }
            }
        }

        return results;
    }

    private resolveCandidates(currentFile: string, importRequest: string): string[] {
        const normalized = normalizeImportPath(importRequest);
        const resolved = new Set<string>();
        const baseDir = path.dirname(currentFile);
        resolved.add(path.resolve(baseDir, normalized));
        for (const root of this.additionalSearchRoots) {
            resolved.add(path.resolve(root, normalized));
        }
        return [...resolved];
    }

    private async loadIndex(fsPath: string): Promise<WrenFileIndex | undefined> {
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === fsPath);
        if (document) {
            return this.getFileIndex(document);
        }

        try {
            const stat = await fs.stat(fsPath);
            const cached = this.externalCache.get(fsPath);
            if (cached && cached.mtime === stat.mtimeMs) {
                return cached.analysis.index;
            }

            const fileUri = vscode.Uri.file(fsPath);
            const diskDocument = await vscode.workspace.openTextDocument(fileUri);
            const analysis = analyzeDocument(diskDocument);
            this.externalCache.set(fsPath, { analysis, mtime: stat.mtimeMs });
            return analysis.index;
        } catch {
            return undefined;
        }
    }

    private refreshConfiguration() {
        const config = vscode.workspace.getConfiguration('wren');
        const userPaths = config.get<string[]>('additionalModuleDirectories', []) ?? [];
        const roots = new Set<string>();
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolders) {
            for (const rel of userPaths) {
                if (!rel || !rel.trim()) {
                    continue;
                }
                roots.add(path.resolve(folder.uri.fsPath, rel));
            }
        }
        this.additionalSearchRoots = [...roots];
    }
}
