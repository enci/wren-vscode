import * as vscode from 'vscode';
import { analyze, DiagnosticSeverity } from '../wren-analyzer/src/index.js';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
    [DiagnosticSeverity.Error]: vscode.DiagnosticSeverity.Error,
    [DiagnosticSeverity.Warning]: vscode.DiagnosticSeverity.Warning,
    [DiagnosticSeverity.Info]: vscode.DiagnosticSeverity.Information,
};

export function analyzeDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const source = document.getText();
    const { diagnostics } = analyze(source, document.uri.fsPath);

    return diagnostics.map(d => {
        const start = document.positionAt(d.span.start);
        const end = document.positionAt(d.span.start + d.span.length);
        const diag = new vscode.Diagnostic(
            new vscode.Range(start, end),
            d.message,
            SEVERITY_MAP[d.severity] ?? vscode.DiagnosticSeverity.Information
        );
        diag.source = 'wren-analyzer';
        diag.code = d.code;
        return diag;
    });
}
