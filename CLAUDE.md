# FSM Editor

VS Code extension: a visual editor for UML 2.5.1 state machines. `*.fsm` files are XMI 2.5.1 documents holding the UML model plus a UML DI diagram with the layout.

## Commands

```sh
npm install
npm run compile            # tsc → out/
npm run watch
npm run check:webview      # syntax-check media/editor.js
npm run package            # builds fsm-editor-<version>.vsix
```

F5 launches an Extension Development Host on `examples/`. There is no automated test suite; verify changes in the development host with the examples (`MediaPlayer.fsm`, and `Order.fsm`, which uses `Payment.fsm` as a submachine).

## Architecture

- `src/extension.ts`: activation and commands (new machine, SVG export, open as text / as diagram).
- `src/fsmEditorProvider.ts`: `CustomTextEditorProvider`. The `TextDocument` holds XMI; the webview works on the JSON model (`FsmModel`). Webview `edit` messages carry model JSON, which is converted with `toXmi` and applied as a full-document `WorkspaceEdit`. Document changes are parsed with `fromXmi` and posted back as `update`. `ctx.echo` hands the webview back its own JSON after its own edits, so a save round trip doesn't reload the diagram. VS Code's own undo/redo acts on the document. The provider also lists the workspace's `*.fsm` machines and resolves submachine hrefs (with a cache keyed by document version or mtime), then publishes validation results as diagnostics.
- `src/model.ts`: `FsmModel`, a flat vertex list where `parent` is a region id, or a state id for border vertices (entry/exit points of a state, connection point references). Entry/exit points whose parent is a top-level region are the machine's own connection points.
- `src/xmi.ts` + `src/xml.ts`: the file format, with a dependency-free XML reader/writer. `toXmi(fromXmi(x))` must round-trip without loss (coordinates are rounded to 0.1 px). Layout mapping and element conventions are documented at the top of `xmi.ts` and in `docs/UML-CONFORMANCE.md`.
- `src/validation.ts`: UML well-formedness rules, the text grammar and reachability, as `Issue[]` keyed by element id.
- `media/editor.js` / `editor.css`: the whole diagram editor (toolbox, SVG canvas, properties panel, inline editing, SVG export). It's plain JavaScript without a build step or dependencies, and renders by rebuilding an SVG string. Geometry (header heights, region rectangles) is duplicated in `xmi.ts` for the UML DI region shapes, so keep the two in sync.
- `media/expressions.js`: the text grammar, a UMD module shared by the webview (`window.FsmExpressions`) and the validator (`require`, typed by `expressions.d.ts`).

## Project rules

- **Text grammar:** behaviors (`entry`, `exit`, `do`, effect) are argument-less calls separated by `;` (`a(); b()`). Guards, invariants and pre/postconditions are calls combined with `!`, `&&`, `||` and parentheses; `else` is allowed only on choice/junction branches. Triggers are event names or `after(<number><ms|s|m|h>)`. There are no variables, arguments, comparisons, dotted names or `when(...)`. The editor must refuse invalid text, and the validator must report it.
- **Deliberately out of scope:** state machine extension/inheritance (`{extended}`, redefinition) and the transition-oriented notation (send/receive signal symbols). Don't add them or list them as missing.
- **Submachines** reference another file by XMI href (`Payment.fsm#sm`), and connection point references point at point ids in that file.
- **Stereotypes** are plain names, stored through an embedded `FsmStereotypes` profile.
- **User-facing docs:** `README.md` (short guide) and `docs/UML-CONFORMANCE.md` (supported features, file format, deviations, validation rules). Update the conformance doc when behavior or rules change.
