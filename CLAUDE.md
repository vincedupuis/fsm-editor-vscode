# FSM Editor

VS Code extension (desktop and web: vscode.dev, github.dev): a visual editor for UML 2.5.1 state machines. `*.fsm` files are XMI 2.5.1 documents holding the UML model plus a UML DI diagram with the layout.

## Commands

```sh
npm install
npm run build:fsm          # fsm-cli (../fsm-cli) as WebAssembly, with its templates, into fsm/ (needs Rust + wasm32-unknown-unknown)
npm run compile            # tsc type-check (noEmit), then esbuild bundles
npm run watch              # esbuild watch
npm run test:unit          # unit and code generation tests (node:test, bundled by test/unit/run.mjs)
npm run test:web           # browser smoke test in VS Code for the Web (Chromium, headless)
npm run check:webview      # syntax-check media/editor.js
npm run package            # builds fsm-editor-<version>.vsix
```

`fsm/` (`fsm.wasm`, `templates/ts.jinja`, `templates/sml.jinja`) is git-ignored: code generation, its tests and the VSIX need it. Run `npm run build:fsm` once, and again after changing `../fsm-cli`; it finds `cargo` on the PATH or in `~/.cargo/bin`. The workflows download it from the fsm-cli release pinned by `FSM_CLI_VERSION` in `release.yml` (`test-windows.yml` reads the pin from there), so that release must exist before this extension is released.

F5 launches an Extension Development Host on `examples/`. Automated tests:
- `npm run test:unit` (`test/unit/codegen.test.ts`): generates TypeScript through `fsm/fsm.wasm` with `ts.jinja` for the examples and for models built in code (`ModelBuilder` in `harness.ts`), bundles it with esbuild and runs it against recorded actions and a fake clock. Code model assertions go through a template that prints the code model as JSON (`codeModel()` in `harness.ts`). Add a case here for any change to code generation semantics (made in `../fsm-cli`).
- `npm run test:unit` (`test/unit/sml.test.ts`): generates C++ with `sml.jinja` for the examples and for a model of every feature, compiles it (`-Wall -Wextra -Wpedantic -Werror`) with a driver that records the calls (`cpp.ts`), and runs the same scenarios as the TypeScript tests. Needs a C++17 compiler (`CXX`, or `c++`/`clang++`/`g++`) and Boost.SML: `SML_INCLUDE`, or downloaded once into `node_modules/.cache`; skipped without them, but failed when `CI` is set (GitHub Actions sets it). CI compiles it with GCC, so check GCC too when changing the template (e.g. in a `gcc` container).
- `npm run test:web` (`test/web/index.ts`): opens copies of the examples in VS Code for the Web and checks activation, validation diagnostics, re-validation after edits, submachine resolution, saving and code generation.

Otherwise verify changes in the development host with the examples (`MediaPlayer.fsm`, and `Order.fsm`, which uses `Payment.fsm` as a submachine).

## Architecture

- Build: `esbuild.mjs` bundles `src/extension.ts` twice, into `out/extension.js` (Node, `main`) and `out/web/extension.js` (web worker, `browser`). Extension code must stay web-compatible: no Node modules, `Buffer` or `process`. Use `src/util.ts` for paths and text encoding, and `vscode.workspace.fs` for files. Only `src/trace/tail.ts` may use Node modules; the web build replaces it with `tail.web.ts` (esbuild plugin in `esbuild.mjs`).
- `src/extension.ts`: activation and commands (new machine, generate code, SVG and PNG export, open as text / as diagram).
- Code generation (documented in `docs/CODEGEN.md`) is fsm-cli (`../fsm-cli`, Rust: validation, code model, Jinja templates), built as a WebAssembly module (`fsm/fsm.wasm`) that the extension runs on desktop and web alike. `src/fsmCli.ts` instantiates it with the standard `WebAssembly` API (no imports) and passes JSON: the texts of the `.fsm` files and of the template in, the files to write and the problems (`issues`, `error`) out; the request and response are described in fsm-cli's README ("WebAssembly"). The module reads no files: `src/codegenCommand.ts` reads the machine and the machines its submachine states reference, transitively (an open document's text when it is open), keyed by `/`-separated paths, then writes the files through `vscode.workspace.fs`. Templates are `.jinja` only; the module refuses `.hbs` with its own message, which the command shows as it is. The code model, the template language and the bundled templates are fsm-cli's.
- `src/fsmEditorProvider.ts`: `CustomTextEditorProvider`. The `TextDocument` holds XMI; the webview works on the JSON model (`FsmModel`). Webview `edit` messages carry model JSON, which is converted with `toXmi` and applied as a full-document `WorkspaceEdit`. Document changes are parsed with `fromXmi` and posted back as `update`. `ctx.echo` hands the webview back its own JSON after its own edits, so a save round trip doesn't reload the diagram. VS Code's own undo/redo acts on the document. The provider also lists the workspace's `*.fsm` machines and resolves submachine hrefs (with a cache keyed by document version or mtime), then publishes validation results as diagnostics.
- `src/model.ts`: `FsmModel`, a flat vertex list where `parent` is a region id, or a state id for border vertices (entry/exit points of a state, connection point references). Entry/exit points whose parent is a top-level region are the machine's own connection points.
- `src/xmi.ts` + `src/xml.ts`: the file format, with a dependency-free XML reader/writer. `toXmi(fromXmi(x))` must round-trip without loss (coordinates are rounded to 0.1 px). Layout mapping and element conventions are documented at the top of `xmi.ts` and in `docs/UML-CONFORMANCE.md`. Files have no `<modelHash>` line any more (0.6.2 wrote one; the reader ignores it): fsm-cli computes the model hash from the file.
- `src/validation.ts`: UML well-formedness rules, the text grammar and reachability, as `Issue[]` keyed by element id.
- `media/editor.js` / `editor.css`: the whole diagram editor (toolbox, SVG canvas, properties panel, inline editing, SVG and PNG export). It's plain JavaScript without a build step or dependencies, and renders by rebuilding an SVG string. Its `cleanGroups` repeats `normalizeGroups` of `src/model.ts`, which the webview can't import. Geometry (header heights, region rectangles) is duplicated in `xmi.ts` for the UML DI region shapes, so keep the two in sync. It is also ported to `Geometry.cs` (`../fsm-editor-vs`) and `Geometry.kt` (`../fsm-editor-jb`).
- `media/expressions.js`: the text grammar, a UMD module shared by the webview (`window.FsmExpressions`) and the validator (bundled by esbuild, typed by `expressions.d.ts`).

## Project rules

- **Reference edition:** the Visual Studio (`../fsm-editor-vs`, C#) and JetBrains (`../fsm-editor-jb`, Kotlin) editions reimplement this one. A change to the text grammar, validation rules or messages, XMI output, clipboard JSON or editor behavior needs the same change there. Their parity fixtures are made from `src/xmi.ts`, `src/validation.ts` and `media/expressions.js`: after changing those, regenerate the fixtures from the umbrella repo with `node parity/fixtures.mjs`. The validator runs twice, here (`src/validation.ts`, for the editor's diagnostics) and in `../fsm-cli` (before generating code): a change to its rules or messages goes to both. Code model and template changes are made in `../fsm-cli` only; run `npm run build:fsm` and `npm run test:unit` here after them.
- **Text grammar:** behaviors (`entry`, `exit`, `do`, effect) are argument-less calls separated by `;` (`a(); b()`). Guards, invariants and pre/postconditions are calls combined with `!`, `&&`, `||` and parentheses; `else` is allowed only on choice/junction branches. Triggers are event names or `after(<number><ms|s|m|h>)`. There are no variables, arguments, comparisons, dotted names or `when(...)`. The editor must refuse invalid text, and the validator must report it.
- **Deliberately out of scope:** state machine extension/inheritance (`{extended}`, redefinition) and the transition-oriented notation (send/receive signal symbols). Don't add them or list them as missing.
- **Submachines** reference another file by XMI href (`Payment.fsm#sm`), and connection point references point at point ids in that file.
- **Stereotypes** are plain names, stored through an embedded `FsmStereotypes` profile.
- **User-facing docs:** `README.md` (short guide), `docs/UML-CONFORMANCE.md` (supported features, file format, deviations, validation rules, execution semantics of generated code) and `docs/CODEGEN.md` (code generation from VS Code, the bundled templates, the code model reference). The template language and the `fsm` command are documented once, in fsm-cli's README: CODEGEN.md links to it. Update the conformance doc when behavior or rules change, and CODEGEN.md when the code model or the bundled templates change.
