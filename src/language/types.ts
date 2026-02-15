import * as vscode from 'vscode';

export interface WrenFieldSymbol {
    name: string;
    range: vscode.Range;
    isStatic: boolean;
    detail?: string;
}

export interface WrenMethodSymbol {
    name: string;
    params: string[];
    isStatic: boolean;
    isConstructor: boolean;
    range: vscode.Range;
    detail: string;
    className: string;
}

export interface WrenClassSymbol {
    name: string;
    range: vscode.Range;
    selectionRange: vscode.Range;
    methods: WrenMethodSymbol[];
    staticMethods: WrenMethodSymbol[];
    fields: WrenFieldSymbol[];
}

export interface WrenImportSymbol {
    moduleName: string;        // raw module name as written (e.g. "utils", "random")
    path: string;              // normalized file path (e.g. "./utils.wren")
    range: vscode.Range;       // range of the import path string in source
    variables: string[] | null; // names after 'for' (null = import everything)
}

export interface WrenFileIndex {
    uri: vscode.Uri;
    version: number;
    classes: WrenClassSymbol[];
    imports: WrenImportSymbol[];
    parsedAt: number;
}

export interface AggregatedClassIndex {
    name: string;
    methods: Map<string, WrenMethodSymbol[]>;
    staticMethods: Map<string, WrenMethodSymbol[]>;
}

export interface AggregatedWorkspaceIndex {
    classes: Map<string, AggregatedClassIndex>;
}
