import * as vscode from 'vscode';

class WrenDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const symbols: vscode.DocumentSymbol[] = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();

            // Skip empty lines and comments
            if (!text || text.startsWith('//') || text.startsWith('/*')) {
                continue;
            }

            // Match class declarations
            const classMatch = text.match(/^class\s+(\w+)\s*\{?/);
            if (classMatch) {
                const className = classMatch[1];
                const range = new vscode.Range(i, 0, i, line.text.length);
                const classSymbol = new vscode.DocumentSymbol(
                    className,
                    'class',
                    vscode.SymbolKind.Class,
                    range,
                    range
                );
                classSymbol.children = [];
                symbols.push(classSymbol);
                continue;
            }

            // Match subscript getter [params]
            const subscriptGetterMatch = text.match(/^\[([^\]]+)\]\s*\{?/);
            if (subscriptGetterMatch && symbols.length > 0) {
                const params = subscriptGetterMatch[1];
                const range = new vscode.Range(i, 0, i, line.text.length);
                const methodSymbol = new vscode.DocumentSymbol(
                    `[${params}]`,
                    'subscript getter',
                    vscode.SymbolKind.Method,
                    range,
                    range
                );

                // Add as child of the last class
                const lastSymbol = symbols[symbols.length - 1];
                lastSymbol.children!.push(methodSymbol);
                continue;
            }

            // Match subscript setter [params]=(value)
            const subscriptSetterMatch = text.match(/^\[([^\]]+)\]\s*=\s*\(([^)]*)\)\s*\{?/);
            if (subscriptSetterMatch && symbols.length > 0) {
                const params = subscriptSetterMatch[1];
                const value = subscriptSetterMatch[2];
                const range = new vscode.Range(i, 0, i, line.text.length);
                const methodSymbol = new vscode.DocumentSymbol(
                    `[${params}]=(${value})`,
                    'subscript setter',
                    vscode.SymbolKind.Method,
                    range,
                    range
                );

                // Add as child of the last class
                const lastSymbol = symbols[symbols.length - 1];
                lastSymbol.children!.push(methodSymbol);
                continue;
            }

            // Match method declarations (within classes)
            const methodMatch = text.match(/^(?:#\S*\s+)*(\w+)\s*\([^)]*\)\s*\{?/);
            if (methodMatch && symbols.length > 0) {
                const methodName = methodMatch[1];
                // Skip keywords that look like methods
                if (['class', 'if', 'else', 'for', 'while', 'return', 'var', 'import', 'foreign'].includes(methodName)) {
                    continue;
                }

                const range = new vscode.Range(i, 0, i, line.text.length);
                const methodSymbol = new vscode.DocumentSymbol(
                    methodName,
                    'method',
                    vscode.SymbolKind.Method,
                    range,
                    range
                );

                // Add as child of the last class
                const lastSymbol = symbols[symbols.length - 1];
                lastSymbol.children!.push(methodSymbol);
            }
        }

        return symbols;
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Register Document Symbol Provider for outline pane
    const symbolProvider = new WrenDocumentSymbolProvider();
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider('wren', symbolProvider)
    );
}

export function deactivate() {}
