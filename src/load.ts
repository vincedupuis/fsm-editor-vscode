/**
 * Reading a machine's model from a file's text, in either format: the JSON format (format.ts), or the XMI of earlier
 * versions (xmi.ts, read as it is, without converting it).
 */
import { applyLayout, isOldFormat, readModel } from './format';
import { FsmModel } from './model';
import { decodeHref } from './util';
import { fromXmi } from './xmi';

export class LoadError extends Error {}

/**
 * The model of a `.fsm` file's text, and of its layout file's text when given (else every element is placed
 * automatically). Throws LoadError when the text can't be
 * read (the first problem, with its line).
 */
export function loadModel(text: string, layout?: string): FsmModel {
  if (isOldFormat(text)) {
    try {
      return fromXmi(text);
    } catch (e) {
      throw new LoadError(e instanceof Error ? e.message : String(e));
    }
  }
  const read = readModel(text);
  if ('problems' in read) throw new LoadError(`Line ${read.problems[0].line}: ${read.problems[0].message}`);
  // Without a layout file, elements are placed automatically.
  applyLayout(read, layout);
  return read.model;
}

/** The submachine paths of a model, relative to its file (`Payment.fsm`; an old file's hrefs without their `#id`). */
export function submachineFiles(model: FsmModel): string[] {
  const old = 'xmiId' in model;
  return model.vertices.flatMap((v) => {
    if (v.type !== 'state' || !v.submachine) return [];
    return [old ? decodeHref(v.submachine.split('#')[0]) : v.submachine];
  });
}
