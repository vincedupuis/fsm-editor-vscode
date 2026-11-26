# Code Generation

FSM Editor turns `.fsm` state machines into source code with [Jinja](https://jinja.palletsprojects.com/) templates. The code generator is [fsm-cli](https://github.com/vincedupuis/fsm-cli), in Rust, with templates rendered by [MiniJinja](https://github.com/mitsuhiko/minijinja). VS Code runs it built as WebAssembly, on the desktop and on the web alike, and the `fsm write` command runs it from the command line. FSM Editor for Visual Studio and for JetBrains IDEs run the same `fsm`.

- [How it works](#how-it-works)
- [From VS Code](#from-vs-code)
- [From the command line](#from-the-command-line)
- [The bundled templates](#the-bundled-templates)
- [UML semantics](#uml-semantics)
- [Tracing](#tracing)
- [Writing a template](#writing-a-template)

## How it works

```
.fsm (JSON) ──read──▶ model ──validate──▶ code model ──render──▶ files
```

1. The generator **reads** the files. Machines used by submachine states are read too, to validate them and to learn their events and connection points, but only the files you give are generated.
2. The **validator** checks every machine with the editor's rules and messages. Generation stops on errors, and warnings are reported.
3. The **code model** works out the UML semantics once for every language. It holds the state tables, the exits and entries of every transition in order, the choices, the static junctions, the joins, the history and the timers. Guards become condition trees, not text in some language.
4. The template is **rendered** on the code model. One template writes **any number of files** through `file` blocks.

Templates are data: they can't run code, and every filter is built in. Generating code from a repository never runs code from it, and a template behaves the same with `fsm write`, in desktop VS Code and on vscode.dev.

## From VS Code

Run **FSM: Generate Code…** from the diagram toolbar (**Code**), the Command Palette, or the context menu of a `.fsm` file in the Explorer. Then:

1. Pick a template: a bundled one (`ts`, `sml`), any `*.jinja` file in the workspace, or **Browse…**.
2. Pick the output folder.

The last template and output folder are remembered. Unsaved changes in open `.fsm` files are used, including those of the machines used by submachine states. It works the same in VS Code for the Web. The **FSM Code Generation** output channel lists the files written and the problems, as `file:line: severity: message`. Handlebars templates (`.hbs`), which earlier versions used, are refused: see [Coming from the Handlebars templates](https://github.com/vincedupuis/fsm-cli#coming-from-the-handlebars-templates) to convert one.

The command also takes arguments, to skip the prompts from a keybinding. It uses the open or selected `.fsm` file. Paths are absolute, or relative to the first workspace folder:

```jsonc
// keybindings.json
{
  "key": "ctrl+alt+g",
  "command": "fsmEditor.generateCode",
  "args": { "template": "templates/cpp.jinja", "out": "src/generated" }
}
```

## From the command line

```sh
fsm write "models/**/*.fsm" --template ts --out src/generated
fsm write "models/**/*.fsm" --template sml --out src/generated --check
```

`fsm` is a single executable for Linux, macOS and Windows, with the bundled templates in a `templates/` folder next to it: download it from the [fsm-cli releases](https://github.com/vincedupuis/fsm-cli/releases). It generates the same files as VS Code, and prints problems to stderr as `file:line: severity: message`, which VS Code problem matchers and CI logs understand. `--check` writes nothing and reports the generated files that are missing or out of date, from the model hash they hold, for a CI step that fails when someone changed a model without regenerating its code. The options, exit codes and `--check` are described in [fsm-cli's README](https://github.com/vincedupuis/fsm-cli#fsm-write).

## The bundled templates

`ts` writes TypeScript without dependencies, `sml` C++17 for [Boost.SML](https://github.com/boost-ext/sml). fsm-cli's [docs/CODEGEN.md](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md) describes the files they write and how to use them, what the Boost.SML template works around, the [code model](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md#code-model-reference) a template receives, and the [semantics of the generated code](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md#semantics-of-the-generated-code).

## UML semantics

The generated code follows UML's run-to-completion semantics, with these choices where UML leaves room or the tool simplifies:

| UML | Generated code |
| --- | --- |
| Conflicting transitions in orthogonal regions: the choice among them isn't specified | The first transition selected fires; a transition whose source has been left meanwhile is skipped. |
| Order of the actions of orthogonal regions isn't specified | Regions are exited and entered in document order. |
| Junction: static conditional branch | Expanded into one transition per path with the guards combined, so a transition only fires when a complete path is enabled. |
| Choice with no enabled branch: ill-formed | The generated code throws an error. |
| Guards on the transitions leaving an entry point | None: all of them are taken, like a fork's, and the validator reports a guard there. |
| A region last exited through its final state, re-entered through history | Default entry, as if there were no history. |
| Protocol violations are left to the implementation | `onConstraintViolation('precondition', …)` when an event finds no transition because a precondition is false. Postconditions are checked after the transition, invariants after every step. |
| Do activities run concurrently with the state | `start…()`/`stop…()` calls. Their end is reported with `activityDone()`, which completes the state. |

The Boost.SML template keeps these semantics, with one exception: Boost.SML fires the transitions of orthogonal regions region after region, so when several regions react to the same event, a later region's guards are evaluated after the earlier regions' transitions fired. The template warns where this can happen.

It stops with an error, and nothing is written, where Boost.SML can't express the machine: a transition between top-level regions, a local transition of a state with several regions, and names that would not compile (see fsm-cli's [docs/CODEGEN.md](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md#the-boostsml-template)).

## Tracing

Both templates report what the machine does through a hook, always generated and doing nothing until you give it something to do: `onTrace` in the TypeScript options, `Listener::onTrace()` in C++ (set with `setListener()`). It is called with four strings, `machine`, `kind` (`event`, `enter`, `exit`, `transition`), `id` (the element's id, derived from the names: `Off`, `Off#1`) and `name`, described in fsm-cli's [Tracing](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md#tracing).

A compound transition reports each of its transitions: through junctions and choices, the branches taken. Writing them as lines in the Trace Player's built-in format, `fsm <machine> <kind> <id> <name>` after a timestamp, lets FSM Editor replay the log on the diagrams (see the [README](../README.md#trace-player)):

```ts
const order = new Order(new MyOrderActions(), {
  onTrace: (machine, kind, id, name) => console.log(`${new Date().toISOString()} fsm ${machine} ${kind} ${id} ${name}`),
});
```

```cpp
struct TraceToLog : Order::Listener {
    void onTrace(const char* machine, const char* kind, const char* id, const char* name) override {
        std::clog << timestamp() << " fsm " << machine << ' ' << kind << ' ' << id << ' ' << name << '\n';
    }
};
TraceToLog tracer;
order.setListener(&tracer);
```

## Writing a template

A template is a Jinja file, with optional front matter that picks a language preset for the `guard` and `id` filters and holds options. It gets the [code model](https://github.com/vincedupuis/fsm-cli/blob/main/docs/CODEGEN.md#code-model-reference) of the machine, one variable per field, and writes files with `file` blocks:

```jinja
---
lang: cpp
---
{% filter file(machine.name ~ "Actions.h") %}
struct {{ machine.name }}Actions {
{% for a in actions %}
    virtual void {{ a | id }}() = 0;
{% endfor %}
};
{% endfilter %}
```

[fsm-cli's README](https://github.com/vincedupuis/fsm-cli#writing-a-template) documents the template language: the front matter, the variables, the filters and functions (`file`, `guard`, `id`, the case filters, `quote`, `warn()`, `error()`), whitespace control, and how to print steps with macros. The bundled `ts.jinja` and `sml.jinja`, in fsm-cli's [templates](https://github.com/vincedupuis/fsm-cli/tree/main/templates) folder, are complete examples to copy.
