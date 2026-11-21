import * as vscode from 'vscode';

const shown: string[] = [];

/** Shows an error message, as `vscode.window.showErrorMessage` does, and keeps it for the tests' API (`errors`). */
export function showError(message: string, ...items: string[]): Thenable<string | undefined> {
  shown.push(message);
  return vscode.window.showErrorMessage(message, ...items);
}

/** The error messages shown, oldest first. */
export const errorsShown = (): string[] => [...shown];
