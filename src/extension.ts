import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Wren extension is now active!');

    const disposable = vscode.commands.registerCommand('wren.helloWorld', () => {
        vscode.window.showInformationMessage('Hello from Wren!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
