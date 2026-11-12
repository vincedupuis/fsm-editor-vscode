/** tail.ts for the web build: VS Code's file system API reads whole files only. */
import * as vscode from 'vscode';

export const readFrom = readAllFrom;

/** Whether traces can be followed as they grow (Live): not in the web edition. */
export const canFollow = false;

/** The file's size, and its bytes from `offset` to the end (none when it is shorter), reading the whole file. */
export async function readAllFrom(uri: vscode.Uri, offset: number): Promise<{ size: number; bytes: Uint8Array }> {
  const data = await vscode.workspace.fs.readFile(uri);
  return { size: data.length, bytes: data.subarray(Math.min(offset, data.length)) };
}
