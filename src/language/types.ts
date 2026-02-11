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

export interface WrenFileIndex {
    uri: vscode.Uri;
    version: number;
    classes: WrenClassSymbol[];
    imports: string[];
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
