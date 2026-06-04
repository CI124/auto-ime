/**
 * Normal Mode Listener
 * For editors without Vim extension
 * Listens to selection and document changes
 */

import * as vscode from 'vscode';
import { IModeListener, ModeContext } from '../core/types';

export class NormalModeListener implements IModeListener {
    readonly name = 'normal';

    register(ctx: ModeContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        // Selection change (cursor movement)
        const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!e.textEditor.document) return;
            ctx.analyzeAndSwitch(e.textEditor);
        });
        disposables.push(selectionChange);

        // Document change (typing)
        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            ctx.analyzeAndSwitch(editor);
        });
        disposables.push(documentChange);

        return disposables;
    }
}
