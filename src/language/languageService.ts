import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AggregatedClassIndex, AggregatedWorkspaceIndex, WrenClassSymbol, WrenFileIndex } from './types';
import { analyzeDocument, resolveTypeAtPosition } from './astIndex';
import type { AnalysisOutput, TypeResolution } from './astIndex';
import type { Module } from '../../wren-analyzer/src/index';
import { ModuleResolver, isBuiltinModule } from '../../wren-analyzer/src/index';
import { getBuiltinClasses, CORE_CLASSES } from './builtins';

interface CachedAnalysis {
    index: WrenFileIndex;
    diagnostics: vscode.Diagnostic[];
    module: Module;
}

interface ExternalCacheEntry {
    analysis: CachedAnalysis;
    mtime: number;
}

interface IndexEntry {
    classes: WrenClassSymbol[];
    visibleNames: Set<string> | null;
}

export class WrenLanguageService {
    private readonly documentCache = new Map<string, CachedAnalysis>();
    private readonly externalCache = new Map<string, ExternalCacheEntry>();
    private additionalSearchRoots: string[] = [];
    private enableDiagnostics: boolean = true;

    constructor() {
        this.refreshConfiguration();
    }

    handleConfigurationChange(event?: vscode.ConfigurationChangeEvent) {
        if (!event || event.affectsConfiguration('wren.additionalModuleDirectories')) {
            this.refreshConfiguration();
            this.externalCache.clear();
        }
        if (event && event.affectsConfiguration('wren.enableDiagnostics')) {
            this.refreshConfiguration();
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
        const searchPaths = this.getSearchPaths(document);
        const { index, diagnostics, module } = analyzeDocument(document, searchPaths);
        const entry = { index, diagnostics, module };
        this.documentCache.set(key, entry);
        return entry;
    }

    /**
     * Build the list of search paths for module resolution.
     * Includes the file's own directory plus any configured additional roots.
     */
    private getSearchPaths(document: vscode.TextDocument): string[] {
        const paths: string[] = [];
        // The file's own directory (for sibling imports)
        paths.push(path.dirname(document.uri.fsPath));
        // Workspace folder roots
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const root = folder.uri.fsPath;
            if (!paths.includes(root)) {
                paths.push(root);
            }
        }
        // User-configured additional search paths
        for (const root of this.additionalSearchRoots) {
            if (!paths.includes(root)) {
                paths.push(root);
            }
        }
        return paths;
    }

    async getFileIndex(document: vscode.TextDocument): Promise<WrenFileIndex> {
        return this.analyzeAndCache(document).index;
    }

    async getDiagnostics(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
        const all = this.analyzeAndCache(document).diagnostics;
        if (!this.enableDiagnostics) {
            // Keep parse/scope errors, suppress analyzer warnings
            const alwaysShow = new Set(['parse-error', 'duplicate-variable', 'undefined-variable']);
            return all.filter(d => alwaysShow.has(String(d.code)));
        }
        return all;
    }

    /**
     * Resolve typed local variables at a character offset in the document.
     * Returns variable→type mappings and the enclosing class name (for `this.`).
     */
    getTypedLocals(document: vscode.TextDocument, offset: number): TypeResolution {
        const cached = this.analyzeAndCache(document);
        return resolveTypeAtPosition(cached.module, offset);
    }

    async getWorkspaceAggregate(document: vscode.TextDocument): Promise<AggregatedWorkspaceIndex> {
        const rootIndex = await this.getFileIndex(document);
        const entries = await this.collectWorkspaceEntries(rootIndex);
        const classes = new Map<string, AggregatedClassIndex>();

        for (const { classes: entryClasses, visibleNames } of entries) {
            for (const cls of entryClasses) {
                // If imported with `for X, Y`, only include listed classes
                if (visibleNames !== null && !visibleNames.has(cls.name)) {
                    continue;
                }

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

    private async collectWorkspaceEntries(entry: WrenFileIndex): Promise<IndexEntry[]> {
        const results: IndexEntry[] = [];
        const visited = new Set<string>();

        // Core classes are always available (no import needed)
        results.push({ classes: CORE_CLASSES, visibleNames: null });

        // Root file: all its own classes are visible
        const pending: { index: WrenFileIndex; visibleNames: Set<string> | null }[] = [
            { index: entry, visibleNames: null }
        ];

        while (pending.length > 0) {
            const current = pending.pop()!;
            const fsPath = current.index.uri.fsPath;
            if (visited.has(fsPath)) {
                continue;
            }
            visited.add(fsPath);
            results.push({
                classes: current.index.classes,
                visibleNames: current.visibleNames,
            });

            for (const imp of current.index.imports) {
                const visibleNames = imp.variables ? new Set(imp.variables) : null;

                // Built-in modules: inject hardcoded class definitions
                if (isBuiltinModule(imp.moduleName)) {
                    const builtinClasses = getBuiltinClasses(imp.moduleName);
                    if (builtinClasses) {
                        results.push({ classes: builtinClasses, visibleNames });
                    }
                    continue;
                }

                // User modules: resolve from disk using the analyzer's ModuleResolver
                const resolver = new ModuleResolver(this.getSearchPathsForFile(fsPath));
                const moduleName = imp.moduleName;
                const resolvedPath = resolver.resolve(moduleName, fsPath);
                if (resolvedPath && !visited.has(resolvedPath)) {
                    const index = await this.loadIndex(resolvedPath);
                    if (index) {
                        pending.push({ index, visibleNames });
                    }
                }
            }
        }

        return results;
    }

    /** Build search paths for a file path (not a TextDocument). */
    private getSearchPathsForFile(fsPath: string): string[] {
        const paths: string[] = [];
        paths.push(path.dirname(fsPath));
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const root = folder.uri.fsPath;
            if (!paths.includes(root)) {
                paths.push(root);
            }
        }
        for (const root of this.additionalSearchRoots) {
            if (!paths.includes(root)) {
                paths.push(root);
            }
        }
        return paths;
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
            const searchPaths = this.getSearchPaths(diskDocument);
            const analysis = analyzeDocument(diskDocument, searchPaths);
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
        for (const entry of userPaths) {
            if (!entry || !entry.trim()) {
                continue;
            }
            if (path.isAbsolute(entry)) {
                // Absolute paths work as-is (useful for global user settings)
                roots.add(entry);
            } else {
                // Relative paths are resolved per workspace folder
                for (const folder of workspaceFolders) {
                    roots.add(path.resolve(folder.uri.fsPath, entry));
                }
            }
        }
        this.additionalSearchRoots = [...roots];
        this.enableDiagnostics = config.get<boolean>('enableDiagnostics', true);
    }
}
