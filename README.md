# FSM Editor — UML State Machines & Code Generation for VS Code

[![Visual Studio Marketplace version](https://badgen.net/vs-marketplace/v/VinceGoSoftware.fsm-editor)](https://marketplace.visualstudio.com/items?itemName=VinceGoSoftware.fsm-editor)

A visual editor and code generator for UML 2.5.1 state machines. Draw a machine in any `*.fsm` file, with a toolbox, a properties panel, live validation and SVG export, then generate its source code from templates, in VS Code or with the standalone `fsm` command-line generator. Files are standard XMI 2.5.1: the UML model plus its diagram layout in UML DI, in the same file.

It also works in VS Code for the Web: open a repository on [github.dev](https://github.dev) (press `.` on any GitHub repository) or a folder on [vscode.dev](https://vscode.dev), install FSM Editor from the Extensions view, and open a `.fsm` file.

![The FSM Editor showing a media player state machine with composite and orthogonal states, the toolbox on the left and the properties panel on the right](images/overview.png)

## Code generation

*Generate Code…* (the **Code** toolbar button, or the Explorer context menu of a `.fsm` file) turns a machine into source code with a [Handlebars](https://handlebarsjs.com/) template. One template can write several files per machine. Two templates are bundled:

- **`ts`**: a dependency-free TypeScript class with run-to-completion semantics, plus an actions interface for you to implement.
- **`sml`**: C++17 with [Boost.SML](https://github.com/boost-ext/sml): a `.h`/`.cpp` pair per machine holding its Boost.SML transition tables, an events interface (what you send the machine) and an actions interface (what it needs from you: behaviors, conditions, timers). Boost.SML has no transitions across composite states, entry/exit points, forks, joins or UML history: the generated code works around them with a warning for each, and refuses what it cannot express.

The same generator is a command-line tool, available as a standalone executable (no Node.js needed) for Windows, macOS and Linux:

```sh
fsm "models/**/*.fsm" --template ts --out src/generated
fsm "models/**/*.fsm" --template sml --out src/generated
```

See **[docs/CODEGEN.md](docs/CODEGEN.md)** for the command line, the bundled templates, writing templates for other languages, and the code model they receive.

## UML support

The editor covers UML 2.5.1 state machines: composite, orthogonal and submachine states, all pseudostates, connection point references, entry/exit/do behaviors, deferrable events, the external, local and internal transition kinds, time triggers, and protocol state machines. A validator checks the well-formedness rules as you edit.

Behaviors and conditions are argument-less function calls (`rewind(); showTime()`, `hasDisc() && !isJammed()`), and triggers are event names or `after(2s)`.

Submachine states reuse another state machine file. They're entered and left through connection point references bound to that machine's entry and exit points:

![A submachine state Payment with retry, failed and cancelled connection point references, and the properties panel listing the referenced machine's points](images/submachine.png)

Text that breaks the rules is refused as you type, and the validator flags problems on the diagram and in VS Code's Problems panel:

![A guard 'volume > 3' refused with an explanation, and a warning that the state Standby can never be entered](images/validation.png)

See **[docs/UML-CONFORMANCE.md](docs/UML-CONFORMANCE.md)** for:
- the supported features and the text syntax;
- how to use submachines and connection point references;
- how the model and layout are stored in XMI and UML DI;
- where and why the tool deviates from UML 2.5.1;
- every validation rule;
- what the SVG export contains.

## Using the editor

- **Add elements**: click a toolbox item and then the canvas, or drag it onto the canvas. Drop inside a region to nest it. Double-click empty canvas to add a state.
- **Transitions**: select an element and drag its ⊕ handle to the target, or use the Transition tool (T). Drawing from a comment attaches the comment instead.
- **Labels**: double-click a name or transition label to edit it in place. The transition syntax is `event, after(2s) [isReady() && !isBusy()] / doIt(); log()`.
- **Routing**: double-click a transition to add a bend point, double-click a bend point to remove it, and drag labels to move them.
- **Regions**: use the Add Region tool (R) or the properties panel.
- **View**: right-drag, middle-drag or Space+drag pans, the mouse wheel zooms, F fits the diagram.
- **Editing**: Delete removes the selection. Ctrl/Cmd+C/X/V copies, cuts and pastes, including between diagrams. Ctrl/Cmd+D duplicates. Arrow keys nudge (Shift for 10px). Undo and redo are VS Code's own.
- **Shortcuts**: S state, X final, I initial, H history, C choice, J junction, N comment, T transition, R region, V/Esc select. Shift+click a tool to keep it active.

Commands (Command Palette → "FSM"): *New State Machine*, *Generate Code…*, *Export as SVG*, *Open as XMI Text*, *Open in FSM Editor*.

## Development

```sh
npm install
npm run compile      # type-check, then bundle for desktop, web and the CLI; or: npm run watch
npm run test:unit    # code generation tests (Node; compiles the C++ of the sml template when a C++ compiler is found)
npm run test:web     # smoke test in VS Code for the Web (Chromium)
npm run build:bin    # standalone fsm executables in dist/ (uses Bun)
```

Press F5 in VS Code to launch an Extension Development Host with the `examples` folder open, then open `examples/MediaPlayer.fsm`, or `examples/Order.fsm` for a submachine with connection point references (it uses `examples/Payment.fsm`).

Package with `npm run package`, which produces a `.vsix` file.

### Layout

- `src/extension.ts`: commands and registration (bundled by `esbuild.mjs` into `out/extension.js` for desktop and `out/web/extension.js` for the web)
- `src/fsmEditorProvider.ts`: custom text editor; syncs the document and the webview and publishes diagnostics
- `src/model.ts`: the in-memory model the diagram editor works on
- `src/xmi.ts`, `src/xml.ts`: reading and writing `.fsm` files (XMI with UML DI)
- `src/validation.ts`: UML well-formedness rules
- `media/editor.js`, `media/editor.css`: the diagram editor webview (no dependencies)
- `media/expressions.js`: grammar of behaviors, conditions and triggers, shared by the webview and the validator
- `src/util.ts`: path and text helpers that work in both the desktop and web extension hosts
- `src/codegen/`: code generation (`codeModel.ts` builds the code model, `render.ts`, `helpers.ts` and `languages.ts` run templates, `generate.ts` is the whole pipeline); `src/codegenCommand.ts` is the VS Code command and `src/cli.ts` the `fsm` tool
- `templates/`: bundled code templates
- `scripts/build-bin.mjs`: builds the standalone executables
- `test/unit/`: code generation tests run by `npm run test:unit`
- `test/web/`: browser smoke test run by `npm run test:web`
- `docs/UML-CONFORMANCE.md`: supported UML features, deviations, validation rules and export mappings
- `docs/CODEGEN.md`: code generation, templates and the code model
