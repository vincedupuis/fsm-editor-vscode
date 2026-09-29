# FSM Editor

VS Code extension (desktop and web: vscode.dev, github.dev): a visual editor for UML 2.5.1 state machines. `*.fsm` files are XMI 2.5.1 documents holding the UML model plus a UML DI diagram with the layout.

## Commands

```sh
npm install
npm run compile            # tsc type-check (noEmit), then esbuild bundles
npm run watch              # esbuild watch
npm run test:unit          # code generation tests (node:test, bundled by test/unit/run.mjs)
npm run test:web           # browser smoke test in VS Code for the Web (Chromium, headless)
npm run check:webview      # syntax-check media/editor.js
npm run package            # builds fsm-editor-<version>.vsix
npm run build:bin          # standalone `fsm` executables in dist/ (Bun; `-- --target current` for this machine only)
node out/cli.js "examples/*.fsm" -t ts -o <dir>   # the CLI after compile
```

F5 launches an Extension Development Host on `examples/`. Automated tests:
- `npm run test:unit` (`test/unit/codegen.test.ts`): generates TypeScript with `templates/ts.hbs` for the examples and for models built in code (`ModelBuilder` in `harness.ts`), bundles it with esbuild and runs it against recorded actions and a fake clock. Add a case here for any change to code generation semantics.
- `npm run test:web` (`test/web/index.ts`): opens copies of the examples in VS Code for the Web and checks activation, validation diagnostics, re-validation after edits, submachine resolution, saving and code generation.

Otherwise verify changes in the development host with the examples (`MediaPlayer.fsm`, and `Order.fsm`, which uses `Payment.fsm` as a submachine).

## Architecture

- Build: `esbuild.mjs` bundles `src/extension.ts` twice, into `out/extension.js` (Node, `main`) and `out/web/extension.js` (web worker, `browser`), plus `src/cli.ts` into `out/cli.js` (`bin`). Extension code must stay web-compatible: no Node modules, `Buffer` or `process`. Use `src/util.ts` for paths and text encoding, and `vscode.workspace.fs` for files. Only `src/cli.ts` may use Node modules.
- `src/extension.ts`: activation and commands (new machine, generate code, SVG export, open as text / as diagram).
- Code generation (`src/codegen/`, documented in `docs/CODEGEN.md`): `fromXmi` → `toCodeModel()` (`codeModel.ts`) → `render()` (`render.ts`, Handlebars) → file map. `toCodeModel` holds all the UML semantics and is language-neutral: guards are condition trees, transitions are step lists (`Step` kinds), no target-language syntax. Language specifics live in templates (`templates/*.hbs`), the built-in helpers (`helpers.ts`) and presets (`languages.ts`); templates can't contain JavaScript. One template writes many files through `{{#file "path"}}` blocks (every file is always overwritten). `generate.ts` runs the whole pipeline (loading submachines, validating, rendering) through a `GenerateHost` for file access, used by `src/codegenCommand.ts` (VS Code) and `src/cli.ts`. `scripts/build-bin.mjs` compiles the CLI with Bun into `dist/`; templates are copied next to the executables, not embedded.
- `src/fsmEditorProvider.ts`: `CustomTextEditorProvider`. The `TextDocument` holds XMI; the webview works on the JSON model (`FsmModel`). Webview `edit` messages carry model JSON, which is converted with `toXmi` and applied as a full-document `WorkspaceEdit`. Document changes are parsed with `fromXmi` and posted back as `update`. `ctx.echo` hands the webview back its own JSON after its own edits, so a save round trip doesn't reload the diagram. VS Code's own undo/redo acts on the document. The provider also lists the workspace's `*.fsm` machines and resolves submachine hrefs (with a cache keyed by document version or mtime), then publishes validation results as diagnostics.
- `src/model.ts`: `FsmModel`, a flat vertex list where `parent` is a region id, or a state id for border vertices (entry/exit points of a state, connection point references). Entry/exit points whose parent is a top-level region are the machine's own connection points.
- `src/xmi.ts` + `src/xml.ts`: the file format, with a dependency-free XML reader/writer. `toXmi(fromXmi(x))` must round-trip without loss (coordinates are rounded to 0.1 px). Layout mapping and element conventions are documented at the top of `xmi.ts` and in `docs/UML-CONFORMANCE.md`.
- `src/validation.ts`: UML well-formedness rules, the text grammar and reachability, as `Issue[]` keyed by element id.
- `media/editor.js` / `editor.css`: the whole diagram editor (toolbox, SVG canvas, properties panel, inline editing, SVG export). It's plain JavaScript without a build step or dependencies, and renders by rebuilding an SVG string. Geometry (header heights, region rectangles) is duplicated in `xmi.ts` for the UML DI region shapes, so keep the two in sync.
- `media/expressions.js`: the text grammar, a UMD module shared by the webview (`window.FsmExpressions`) and the validator (bundled by esbuild, typed by `expressions.d.ts`).

## Project rules

- **Text grammar:** behaviors (`entry`, `exit`, `do`, effect) are argument-less calls separated by `;` (`a(); b()`). Guards, invariants and pre/postconditions are calls combined with `!`, `&&`, `||` and parentheses; `else` is allowed only on choice/junction branches. Triggers are event names or `after(<number><ms|s|m|h>)`. There are no variables, arguments, comparisons, dotted names or `when(...)`. The editor must refuse invalid text, and the validator must report it.
- **Deliberately out of scope:** state machine extension/inheritance (`{extended}`, redefinition) and the transition-oriented notation (send/receive signal symbols). Don't add them or list them as missing.
- **Submachines** reference another file by XMI href (`Payment.fsm#sm`), and connection point references point at point ids in that file.
- **Stereotypes** are plain names, stored through an embedded `FsmStereotypes` profile.
- **User-facing docs:** `README.md` (short guide), `docs/UML-CONFORMANCE.md` (supported features, file format, deviations, validation rules, execution semantics of generated code) and `docs/CODEGEN.md` (CLI, templates, code model). Update the conformance doc when behavior or rules change, and CODEGEN.md when the code model, helpers or CLI change.
