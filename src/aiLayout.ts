/**
 * AI Layout: the language model the user picked in VS Code lays out the open
 * diagram, in a loop the extension runs. Each round the model proposes a layout
 * through the private propose_layout tool; the diagram fits, measures and
 * renders it, the fitted layout is written to the document (so each proposal is
 * one undo step), and the model gets the problems and the image back to make
 * targeted fixes. The diagram is locked meanwhile and shows a Stop button.
 * Stopping keeps the version shown; a run that finishes ends on the best-scoring
 * proposal. Only the layout (UML DI) changes. Prompt, tool and reports are in
 * layoutPrompt.ts. The "FSM Editor AI Layout" output channel logs each run: the
 * prompt, the model's answers and tool calls, and the reports sent back.
 */
import * as vscode from 'vscode';
import { ActiveEditor, FsmEditorProvider } from './fsmEditorProvider';
import { LAYOUT_TOOL, LayoutMode, applyProposal, buildPrompt, proposalReport, withoutRouting } from './layoutPrompt';
import { FsmModel } from './model';
import { fromXmi } from './xmi';

const MAX_PROPOSALS = 5;
const MODEL_SETTING = 'aiLayout.model';
const JUSTIFICATION = 'FSM Editor uses the language model to lay out the state machine diagram.';

let running = false;
let channel: vscode.LogOutputChannel | undefined;

/** The output channel that logs the runs, created on the first one. */
export function aiLog(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel('FSM Editor AI Layout', { log: true }));
}

/** `text` with each run of JSON lines (the diagram data in the prompt) replaced by a count. */
function withoutJson(text: string): string {
  const out: string[] = [];
  let json = 0;
  const flush = () => {
    if (json) out.push(`(${json} line${json === 1 ? '' : 's'} of JSON data)`);
    json = 0;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('{')) json++;
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** What a propose_layout call holds, without its coordinates. */
function callSummary(input: object): string {
  const count = (k: string, one: string, many: string) => {
    const v = (input as Record<string, unknown>)[k];
    const n = Array.isArray(v) ? v.length : 0;
    return `${n} ${n === 1 ? one : many}`;
  };
  return [count('vertices', 'vertex', 'vertices'), count('regionLayouts', 'region layout', 'region layouts'), count('transitions', 'transition', 'transitions')].join(', ');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What a user message can carry. */
type UserPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart;

/** Something other than the run changed the document. */
class DiagramChanged extends Error {}

interface Best {
  model: FsmModel;
  n: number;
  score: number;
  problems: number;
}

/** A run as it goes. */
interface RunState {
  /** Document version after the run's last write. */
  version: number;
  /** Set while the run writes, so its own changes aren't taken for someone else's. */
  writing: boolean;
  changed: boolean;
  /** Proposals evaluated, and the one the document shows. */
  proposals: number;
  shown: number;
  best?: Best;
  /** The model's last text answer. */
  text: string;
}

export async function aiLayout(provider: FsmEditorProvider, mode: LayoutMode): Promise<void> {
  const editor = provider.activeEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Open a .fsm state machine in the FSM Editor first.');
    return;
  }
  if (running) {
    void vscode.window.showInformationMessage('AI Layout is already running.');
    return;
  }
  running = true;
  try {
    await run(provider, editor, mode);
  } catch (e) {
    if (!(e instanceof vscode.CancellationError)) {
      void vscode.window.showErrorMessage(`AI Layout failed: ${e instanceof Error ? e.message : e}`);
    }
  } finally {
    running = false;
  }
}

/** The model named by the fsmEditor.aiLayout.model setting, or one the user picks (then saved in the setting). */
async function chooseModel(): Promise<vscode.LanguageModelChat | undefined> {
  const config = vscode.workspace.getConfiguration('fsmEditor');
  const id = (config.get<string>(MODEL_SETTING) ?? '').trim();
  const models = await vscode.lm.selectChatModels();
  if (!models.length) {
    void vscode.window.showErrorMessage(
      'AI Layout needs a language model, and VS Code has none. Install and sign in to an extension that provides chat models, such as GitHub Copilot.',
    );
    return undefined;
  }
  if (id) {
    const found = models.find((m) => m.id === id);
    if (found) return found;
    void vscode.window.showWarningMessage(`The language model "${id}" set in fsmEditor.${MODEL_SETTING} is not available. Choose another one.`);
  }
  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.name, description: `${m.vendor} · ${m.id}`, model: m })),
    { title: 'AI Layout', placeHolder: `Language model to lay out diagrams (saved in the fsmEditor.${MODEL_SETTING} setting)` },
  );
  if (!pick) return undefined;
  await config.update(MODEL_SETTING, pick.model.id, vscode.ConfigurationTarget.Global);
  return pick.model;
}

async function run(provider: FsmEditorProvider, editor: ActiveEditor, mode: LayoutMode) {
  const chat = await chooseModel();
  if (!chat) return;
  const { document } = editor;
  const log = aiLog();
  log.show(true);
  log.info(`${mode === 'redesign' ? 'Redesign' : 'Improve'} ${document.uri.toString(true)} with ${chat.name} (${chat.vendor} · ${chat.id}, ${chat.maxInputTokens} input tokens)`);
  const model = fromXmi(document.getText());
  const stop = new vscode.CancellationTokenSource();
  const state: RunState = { version: document.version, writing: false, changed: false, proposals: 0, shown: 0, text: '' };

  /** Shows a layout by writing it to the document, one undo step each. */
  const write = async (m: FsmModel) => {
    if (state.changed || document.version !== state.version) throw new DiagramChanged();
    state.writing = true;
    try {
      await provider.applyModel(document, m);
    } finally {
      state.writing = false;
    }
    state.version = document.version;
  };
  // Any other change (Undo from the Edit menu, the XMI edited as text) stops the run.
  const watch = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document === document && e.contentChanges.length && !state.writing && document.version !== state.version) {
      state.changed = true;
      stop.cancel();
    }
  });
  provider.aiStop = () => stop.cancel();
  provider.postAiState(editor, { running: true, n: 0, max: MAX_PROPOSALS });

  let ending: 'finished' | 'stopped' | 'changed' | 'failed';
  let failure: unknown;
  try {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AI Layout with ${chat.name}`, cancellable: true },
        async (progress, token) => {
          const sub = token.onCancellationRequested(() => stop.cancel());
          try {
            await loop(provider, editor, chat, mode, model, state, write, progress, stop.token);
          } finally {
            sub.dispose();
          }
        },
      );
      ending = state.changed ? 'changed' : stop.token.isCancellationRequested ? 'stopped' : 'finished';
    } catch (e) {
      ending = state.changed || e instanceof DiagramChanged ? 'changed' : stop.token.isCancellationRequested ? 'stopped' : 'failed';
      failure = e;
    } finally {
      watch.dispose();
      provider.aiStop = undefined;
    }
    // A run that finishes ends on its best proposal.
    if (ending === 'finished' && state.best && state.best.n !== state.shown) {
      try {
        await write(state.best.model);
        state.shown = state.best.n;
      } catch (e) {
        if (!(e instanceof DiagramChanged)) throw e;
        ending = 'changed';
      }
    }
    log.info(
      ending === 'failed'
        ? `Failed: ${errorText(failure)}`
        : `${ending[0].toUpperCase()}${ending.slice(1)} after ${state.proposals} proposal${state.proposals === 1 ? '' : 's'}` +
            (state.best ? `; best: proposal ${state.best.n} (score ${state.best.score}); shown: proposal ${state.shown || 'none (the original)'}` : ''),
    );
  } finally {
    stop.dispose();
    provider.postAiState(editor, { running: false });
  }

  const steps = state.shown ? ' Undo and Redo step through the proposals.' : '';
  switch (ending) {
    case 'finished': {
      const { best } = state;
      if (!best) {
        const reply = state.text.trim() ? ` It replied: ${state.text.trim().slice(0, 300)}` : '';
        void vscode.window.showWarningMessage(`${chat.name} did not propose a layout.${reply}`);
        break;
      }
      const left = best.problems ? ` It still has ${best.problems} problem${best.problems === 1 ? '' : 's'}.` : '';
      void vscode.window.showInformationMessage(
        state.proposals > 1
          ? `AI Layout shows proposal ${best.n} of ${state.proposals}, the best one.${left}${steps}`
          : `AI Layout applied the proposal.${left} Undo reverts it.`,
      );
      break;
    }
    case 'stopped':
      if (state.shown) void vscode.window.showInformationMessage(`AI Layout stopped at proposal ${state.shown}.${steps}`);
      break;
    case 'changed':
      void vscode.window.showWarningMessage('The diagram changed while AI Layout was running, so it stopped.');
      break;
    case 'failed':
      void vscode.window.showErrorMessage(`AI Layout failed: ${failure instanceof Error ? failure.message : failure}${steps}`);
      break;
  }
}

async function loop(
  provider: FsmEditorProvider,
  editor: ActiveEditor,
  chat: vscode.LanguageModelChat,
  mode: LayoutMode,
  model: FsmModel,
  state: RunState,
  write: (m: FsmModel) => Promise<void>,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<void> {
  const log = aiLog();
  progress.report({ message: 'reading the diagram…' });
  const start = await provider.evaluateLayout(editor, model, { fit: false, image: mode === 'improve' });
  log.info(`Current layout: score ${start.metrics.score}, ${start.metrics.problems.length} problem${start.metrics.problems.length === 1 ? '' : 's'}`);
  const prompt = buildPrompt(model, start, mode, MAX_PROPOSALS);
  log.info(`Prompt${start.png ? ' (with an image of the diagram)' : ''}:\n${withoutJson(prompt)}`);
  const first: UserPart[] = [new vscode.LanguageModelTextPart(prompt)];
  if (start.png) first.push(vscode.LanguageModelDataPart.image(fromBase64(start.png), 'image/png'));
  const messages = [vscode.LanguageModelChatMessage.User(first)];

  // Images go along until the model refuses a request with them.
  let images = true;
  let requests = 0;
  const ask = async () => {
    for (;;) {
      const n = ++requests;
      const started = Date.now();
      log.info(`Request ${n}: ${messages.length} message${messages.length === 1 ? '' : 's'}${images ? '' : ', without images'}`);
      try {
        const response = await chat.sendRequest(messages, { tools: [LAYOUT_TOOL], justification: JUSTIFICATION }, token);
        let text = '';
        const calls: vscode.LanguageModelToolCallPart[] = [];
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) text += part.value;
          else if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        log.info(`Answer ${n} after ${secs} s: ${calls.length} tool call${calls.length === 1 ? '' : 's'}${text.trim() ? `, text:\n${text.trim()}` : ', no text'}`);
        for (const call of calls) log.info(`Tool call ${call.name} (${call.callId}): ${callSummary(call.input)}`);
        return { text, calls };
      } catch (e) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        log.warn(`Request ${n} failed: ${errorText(e)}`);
        if (images && stripImages(messages)) {
          images = false;
          log.info('Retrying without images');
          continue;
        }
        throw e;
      }
    }
  };

  let current = mode === 'redesign' ? withoutRouting(model) : model;
  let nudged = false;
  while (state.proposals < MAX_PROPOSALS) {
    if (token.isCancellationRequested) return;
    progress.report({ message: state.proposals ? `refining (proposal ${state.proposals + 1} of at most ${MAX_PROPOSALS})…` : 'designing the layout…' });
    const { text, calls } = await ask();
    if (token.isCancellationRequested) return;
    state.text = text;
    if (!calls.length) {
      if (state.best || nudged) return;
      // Once, ask again for the tool call instead of a text answer.
      nudged = true;
      log.info(`No tool call: asking for ${LAYOUT_TOOL.name}`);
      messages.push(
        vscode.LanguageModelChatMessage.Assistant(text || '(no answer)'),
        vscode.LanguageModelChatMessage.User(`Call ${LAYOUT_TOOL.name} with your layout.`),
      );
      continue;
    }
    messages.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
    const parts: UserPart[] = [];
    let png: string | undefined;
    for (const call of calls) {
      if (call.name !== LAYOUT_TOOL.name || state.proposals >= MAX_PROPOSALS) {
        const why = call.name !== LAYOUT_TOOL.name ? `There is no tool ${call.name}.` : 'No proposals left.';
        log.warn(`Tool call ${call.callId} refused: ${why}`);
        parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(why)]));
        continue;
      }
      const n = ++state.proposals;
      progress.report({ message: `checking proposal ${n}…` });
      const { model: proposed, errors } = applyProposal(current, call.input);
      const ev = await provider.evaluateLayout(editor, proposed, { fit: true, image: images });
      // Stopped while checking: the version shown stays.
      if (token.isCancellationRequested) return;
      log.info(`Proposal ${n}: score ${ev.metrics.score}, ${ev.metrics.problems.length} problem${ev.metrics.problems.length === 1 ? '' : 's'}`);
      current = ev.model;
      // On a tie the later proposal wins: the model saw the earlier one and refined it.
      if (!state.best || ev.metrics.score <= state.best.score) state.best = { model: ev.model, n, score: ev.metrics.score, problems: ev.metrics.problems.length };
      await write(ev.model);
      state.shown = n;
      provider.postAiState(editor, { running: true, n, max: MAX_PROPOSALS, best: state.best.n });
      const report = proposalReport(n, MAX_PROPOSALS, ev, state.best, errors);
      log.info(`Report on proposal ${n}${images && ev.png ? ' (with an image)' : ''}:\n${withoutJson(report)}`);
      parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(report)]));
      png = ev.png;
    }
    if (images && png) {
      parts.push(new vscode.LanguageModelTextPart(`The diagram as proposal ${state.proposals} draws it:`), vscode.LanguageModelDataPart.image(fromBase64(png), 'image/png'));
    }
    messages.push(vscode.LanguageModelChatMessage.User(parts));
  }
}

/** Removes the images from `messages`; returns whether there were any. */
function stripImages(messages: vscode.LanguageModelChatMessage[]): boolean {
  let found = false;
  for (const m of messages) {
    const kept = m.content.filter((p) => !(p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith('image/')));
    if (kept.length !== m.content.length) {
      found = true;
      m.content = kept;
    }
  }
  return found;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
