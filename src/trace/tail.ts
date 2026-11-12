/**
 * Reads a growing file from an offset: on the desktop, only the bytes after it (log files can be large). The web build
 * replaces this file with tail.web.ts (esbuild.mjs), and other file systems than the disk read the whole file.
 */
import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { readAllFrom } from './tail.web';

/** Whether traces can be followed as they grow (Live): not in the web edition. */
export const canFollow = true;

/** The file's size, and its bytes from `offset` to the end (none when it is shorter). */
export async function readFrom(uri: vscode.Uri, offset: number): Promise<{ size: number; bytes: Uint8Array }> {
  if (uri.scheme !== 'file') return readAllFrom(uri, offset);
  const file = await open(uri.fsPath, 'r');
  try {
    const { size } = await file.stat();
    const bytes = new Uint8Array(Math.max(0, size - offset));
    let n = 0;
    while (n < bytes.length) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, offset + n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    return { size, bytes: bytes.subarray(0, n) };
  } finally {
    await file.close();
  }
}
