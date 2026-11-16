# Code Generation

FSM Editor turns `.fsm` state machines into source code with [Jinja](https://jinja.palletsprojects.com/) templates. The code generator is [fsm-cli](https://github.com/vincedupuis/fsm-cli), in Rust, with templates rendered by [MiniJinja](https://github.com/mitsuhiko/minijinja). VS Code runs it built as WebAssembly, on the desktop and on the web alike, and the `fsm write` command runs it from the command line. FSM Editor for Visual Studio and for JetBrains IDEs run the same `fsm`.

- [How it works](#how-it-works)
- [From VS Code](#from-vs-code)
- [From the command line](#from-the-command-line)
- [The TypeScript template](#the-typescript-template)
- [The Boost.SML template](#the-boostsml-template)
- [Writing a template](#writing-a-template)
- [Code model reference](#code-model-reference)
- [Semantics of the generated code](#semantics-of-the-generated-code)

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

## The TypeScript template

The `ts` template (`ts.jinja`) writes two files per machine, for example for `Order`:

| File | Contents |
| --- | --- |
| `OrderActions.ts` | Event, state, activity and entry/exit point types, the `OrderActions` interface, options |
| `Order.ts` | The `Order` class |

Generated files are overwritten every time the code is generated, so don't edit them. Put your code in your own class implementing `OrderActions`, in a file of your own:

```ts
import { Order } from './Order';
import { MyOrderActions } from './MyOrderActions'; // your class: implements OrderActions

const order = new Order(new MyOrderActions(), { onFinished: () => console.log('done') });
order.start();
order.dispatch('checkout');
order.isIn('Payment');   // true
order.activeStates;      // ['Payment']
```

- **Actions:** every function called by an entry, exit or transition action behavior is a `void` method of the actions interface. Every function called by a guard, invariant or pre/postcondition is a `boolean` method.
- **Do activities** `do / blinkLed()` become `startBlinkLed()` and `stopBlinkLed()`. Call `machine.activityDone('blinkLed')` when an activity ends by itself. A state with do activities completes when all of them have ended. An activity listed twice in one `do` is started, stopped and awaited once.
- **Time events** `after(5m)` use `setTimeout`. Pass `{ clock }` to control time in tests.
- **Submachines:** each machine gets its own class. `OrderActions.submachines.Payment` gives the actions of the `Payment` submachine state. The parent routes events to the running submachine and follows its exit points. `Order.ts` imports `Payment.ts`, so generate `Payment.fsm` too, for example with `fsm write "models/*.fsm" …`.
- **Constraints:** invariants, preconditions and postconditions call `onConstraintViolation(kind, element)`.
- `terminate` calls `onTerminate()` and stops the machine.
- **Tracing:** pass `onTrace` in the options to know what the machine does, for example to write a log for the [Trace Player](#tracing).
- **Other methods:** `startAt(point)` enters through one of the machine's entry points. `stop()` leaves every state. `resume()` re-enters what was active when it was stopped.
- Identifiers that are TypeScript keywords get a `_` suffix (`delete()` → `delete_()`).

The generated code has no dependencies, is strict-mode clean, and runs in browsers and Node.js.

## The Boost.SML template

The `sml` template (`sml.jinja`) writes C++17 for [Boost.SML](https://github.com/boost-ext/sml) (tested with 1.2.0), four files per machine, for example for `Order`, and `FsmTimers.h`, shared by all machines:

| File | Contents |
| --- | --- |
| `OrderEvents.h` | What the machine reacts to: the `OrderEvents` interface, one method per event (and `activityDone()`), and the `OrderEvent` enum. |
| `OrderActions.h` | What the machine needs: the `OrderActions` interface to implement, with its behaviors, conditions, do activities, `onConstraintViolation()`, `onTerminate()` and submachine actions. |
| `FsmTimers.h` | The `FsmTimers` interface that runs the timers of time events, the same for every machine. Written only by machines with time events (their own or their submachines'). |
| `Order.h` | The `Order` class, which implements `OrderEvents`, and the `OrderState`, `OrderEntryPoint` and `OrderExitPoint` enums. |
| `Order.cpp` | Its implementation: the Boost.SML transition tables and the runtime around them. Only this file includes `<boost/sml.hpp>`. |

Compile the `.cpp` files with your code, with `boost/sml.hpp` on the include path and C++ exceptions enabled (a terminate pseudostate stops the machine by unwinding). Put your code in your own class implementing `OrderActions`:

```cpp
#include "Order.h"
#include "MyOrderActions.h" // your class: public OrderActions

MyOrderActions actions;
Order order(actions);
order.startMachine();
order.checkout();                      // an event
order.isIn(OrderState::Payment);       // true
order.activeStates();                  // {OrderState::Payment}
```

- **Events** are the methods of `OrderEvents`. They are queued and processed one at a time, each to completion, also when sent from within an action.
- **Behaviors** are `void` methods of the actions interface and **conditions** (guards, invariants, pre/postconditions) `bool` methods, as in the TypeScript template.
- **Do activities** become `startBlinkLed()` and `stopBlinkLed()`; call `activityDone(MediaPlayerActivity::blinkLed)` when one ends by itself.
- **Timers** go through `FsmTimers`, which you implement once and pass to the constructor of every machine with time events, `Order(actions, timers)`. A machine passes it on to its submachines. `startTimer(delay, fire)` must call `fire()` once after `delay` unless `cancelTimer()` comes first, on the thread that sends the events. Delays are rounded up to whole milliseconds. A late `fire()` does nothing.
- **Submachines:** each machine gets its own class, run by its submachine states. `OrderActions::submachinePayment()` gives the actions of the `Payment` submachine state. Generate `Payment.fsm` too.
- **Other methods:** `startMachineAt(point)` enters through an entry point, `stopMachine()` leaves every state, `resumeMachine()` re-enters what was active when it was stopped. `setListener()` is told when the machine finishes or leaves through an exit point, and through `Listener::onTrace()` what the machine does (see [Tracing](#tracing)). They are named so that they don't clash with events such as `start` or `stop`.
- Identifiers that are C++ keywords get a `_` suffix.

Boost.SML runs the transition tables: one per composite state, with a `*` initial state per region, and the machine's own. The runtime around them gives the machine UML's semantics where Boost.SML's differ: the event queue, completion events (processed before other events), deferred events (dispatched again after the next state change, after the completion events), timers, constraints and submachines. Boost.SML has no counterpart for some UML features; the template works around them, keeping the order of exits, transition actions and entries, and prints a warning for each:

| UML | Generated code |
| --- | --- |
| Transition leaving a composite state from one of its substates, exit point, join | The substate takes the event, then the table of the composite state being left takes an internal event that continues the transition. A join's sources check, when they complete, that the others have completed. |
| Transition entering a nested state, entry point, fork, history | Every region starts in an initial pseudostate whose anonymous transitions enter the region by default, follow the route set by the transition, or restore the region's last active state (shallow or deep). |
| Local transition | A transition of each substate of the composite state, which leaves the active substate but not the composite state. |
| Orthogonal regions reacting to the same event | Boost.SML fires the transitions region after region, so a later region's guards see the earlier regions' actions (UML selects them all first). This is the one difference in behavior, hence the warning. |

What it cannot express stops the generation with an error, and nothing is written: a transition between top-level regions, a local transition of a state with several regions, and names that would not compile (an event named like a method of the generated class, a function used both as a behavior and as a condition).

## Tracing

Both templates report what the machine does through a hook, always generated and doing nothing until you give it something to do: `onTrace` in the TypeScript options, `Listener::onTrace()` in C++ (set with `setListener()`). It is called with four strings:

| Argument | |
| --- | --- |
| `machine` | The machine's name. For a submachine, followed by the submachine states leading to it: `Order.Payment`. |
| `kind` | `event` (an event or time event is processed), `enter` (a state is entered, before its entry behavior), `exit` (a state was left, after its exit behavior), `transition` (a transition is taken, before its action). |
| `id` | The id of the state or transition in its `.fsm` file, derived from the names (see the file format in [fsm-cli's README](https://github.com/vincedupuis/fsm-cli#ids)): a state's name (`Off`), a transition's source and position among its transitions (`Off#1`, `On.fault#1`, `MediaPlayer.initial#1`); for an event, its name. |
| `name` | The name of the state, the transition (`Cart -> Payment (checkout)`) or the event. |

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

A template prints the `transition` steps (see [Steps](#steps)) and the table action of the same name to report transitions.

## Writing a template

A template is a Jinja file, with optional front matter that picks a language preset for the `guard` and `id` filters and holds options. It gets the [code model](#code-model-reference) of the machine, one variable per field, and writes files with `file` blocks:

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

## Code model reference

Top level:

| Field | |
| --- | --- |
| `machine` | `name` (identifier), `displayName`, `kind` (`behavioral`/`protocol`), `protocol`, `documentation`, `sourceFile`, `modelHash` (the hash of the model in the `.fsm` file, without its layout: see the file format in [UML-CONFORMANCE.md](UML-CONFORMANCE.md#file-format)) |
| `states` | All states and final states, depth first ([below](#states)). |
| `regions`, `topRegions` | `index`, `name`, `displayName`, `top`, `owner`/`ownerIndex` (-1 at the top), `states`, `defaultSteps` (the initial transition; empty when the region has no initial pseudostate) |
| `events` | Named events: `name`, `index`, `signalIndex`, `own` (false when only a submachine handles it) |
| `timers` | One per `after(...)` and source state: `name` (`Paused_after_5m`), `index`, `signalIndex`, `ms`, `trigger`, `state`, `stateIndex` |
| `signals` | Events then timers, numbered from 0: `name`, `index`, `kind` (`event`/`timer`) |
| `actions`, `conditions`, `activities` | Names of the functions called by behaviors, by conditions, and by do activities. |
| `transitions` | Everything that can fire: `index`, `id` (of the UML transition, or of the join), `name`, `label`, `kind` (`external`/`internal`/`local`/`join`/`exitPoint`), `source`/`sourceIndex`, `steps`, `via` (the pseudostates it goes through, in order: `kind`, `name`, `id`; those of its own way through junctions, and those of every branch of its choices) |
| `submachines` | Distinct machines used by submachine states: `name`, `href` (the path of its file, as the submachine state writes it), `events`, `entryPoints` and `exitPoints` (names), `timers` (it uses time events, itself or in its submachines), `states` |
| `entryPoints`, `exitPoints` | The machine's own connection points: `name`, `id`, and `steps` for entry points. |
| `start` | Steps of the default entry. |
| `invariants` | The states that have an invariant. |
| `features` | Booleans: `timers`, `submachineTimers`, `anyTimers` (one of the two), `activities`, `history`, `deferral`, `choices`, `joins`, `terminate`, `submachines`, `entryPoints`, `exitPoints`, `invariants`, `preconditions`, `postconditions`, `constraints`, so a template can leave out unused runtime parts. |
| `tables` | The machine as nested transition tables ([below](#transition-tables)). |

References to other elements are `{ name, index }` objects, or a `…Index` number.

### States

| Field | |
| --- | --- |
| `index`, `id`, `name`, `displayName` | `id` is the state's id in the file: its name. `name` is unique (an identifier made from the name). Generated names (ending with `*`) count as no name: final states without a name of their own are named `Final`. |
| `kind`, `isFinal` | `simple`, `composite`, `submachine`, `final` |
| `region`/`regionIndex`, `parent`/`parentIndex`, `depth`, `regions` | Position in the hierarchy. |
| `entry`, `exit` | Steps of the state's own entry: the entry behavior, then starting do activities and timers. Steps of its own exit: stopping the submachine, timers and activities, then the exit behavior. |
| `activities`, `timers`, `deferred`, `invariant`, `stereotype`, `submachine` | `submachine` is `{ machine, href }` or null. |
| `completes` | When the completion event occurs: `immediate`, `activities`, `regions`, `submachine`, `never` |
| `handlers` | Triggered transitions grouped by signal: `signal`, `signalIndex`, `kind`, `candidates`, `exhaustive` (the last candidate is unconditional) |
| `completion` | Candidates for the completion event. |
| `exits` | Submachine states: `{ point, candidates }` for each exit point reference. |

A **candidate** has `transition`/`transitionIndex`, `guard` (condition or null), `precondition` (protocol machines), `requires` (joins: states that must all be active and completed) and `label`. Candidates are in priority order: take the first enabled one.

A **condition** is `{ op: "call", name }`, `{ op: "not", arg }`, or `{ op: "and" | "or", args }`.

### Steps

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `call` | `action` | Call a behavior function. |
| `startActivity`, `stopActivity` | `activity` | Start or abort a do activity. |
| `startTimer`, `cancelTimer` | `timer`, `timerIndex`, `ms` | Arm or cancel a time event. |
| `exit` | `state`, `stateIndex` | If the state is active: exit its active substates (innermost first), run its `exit` steps, and record it as its region's history. |
| `exitRegion` | `region`, `regionIndex` | Exit the region's active state, if any. |
| `enter` | `state`, `stateIndex` | Make the state active and run its `entry` steps, but not its regions: they get their own steps. |
| `enterRegion` | `region`, `regionIndex` | Default entry of the region (run its `defaultSteps`). |
| `restoreHistory` | `region`, `regionIndex`, `deep`, `defaultSteps` | Re-enter the region's last active state (and, for deep history, theirs, recursively), or run `defaultSteps` when there is none. |
| `choice` | `label`, `branches` (`guard`, `isElse`, `steps`, `via`: the pseudostates the branch goes through after the choice), `hasElse`, `region`/`regionIndex` | Evaluate the guards now and take the first enabled branch. `region` is where the choice is evaluated. |
| `startSubmachine` | `state`, `stateIndex`, `point` | Start the submachine by default, or through its entry point `point`. |
| `stopSubmachine` | `state`, `stateIndex` | Exit all states of the submachine. |
| `exitMachine` | `point` | Leave through the machine's exit point: exit every state, then tell the parent machine. |
| `terminate` | | Stop the machine without exit behaviors. |
| `check` | `constraint` (`postcondition`), `element`, `condition` | Report a violation when the condition is false. |
| `transition` | `id`, `label` | A transition is taken (one of the transitions of a compound transition, before its action): report it for [tracing](#tracing), or print nothing. |

`exit`, `exitRegion`, `enterRegion` and `restoreHistory` depend on the configuration at run time. They need a small runtime: an active state per region, a history per region, and the tables in the code model. See `ts.jinja`.

### Transition tables

`tables` is the same machine for frameworks whose transitions stay inside one table, such as Boost.SML: a table per composite state with the transitions between its substates, and one for the machine. Such frameworks can't leave a composite state from a substate or enter a nested state directly, so the tables do it with two mechanisms that keep UML's order of exits, transition actions and entries:

- **Continuations** (leaving from inside): the substate takes the event without changing state and posts a continuation, a table event that the table of the composite state being left takes right away, once per state left when actions come between the exits.
- **Routes** (entering inside): every region starts in an `init` pseudostate whose anonymous rows enter the region by default (route 0), restore its last active state (route 1, deep resume, or the route of a history pseudostate), or follow the route a transition set before entering the composite state.

| Field | |
| --- | --- |
| `list` | Tables, innermost first, the machine's last: `state` (null for the machine's), `name`, `top`, `regions` (`index`, `name`, `init`, `off`: the pseudostate the machine's regions wait in until started), `states`, `pseudostates`, `rows` |
| `events` | Table events, numbered from 0: `name`, `index`, `kind` (`start`, `stop`, `timer`, `completion`, `continuation`, `exitPoint`), `ref` (the timer or state), `point` |
| `timerEvents`, `completionEvents` | The table event of each timer, and of each state's completion (null when no transition waits for it). |
| `postconditions` | `index`, `element`, `condition`: checked after their transition. |
| `routes` | Number of routes; 0 and 1 are reserved. |
| `entryPoints` | The machine's entry points: `name`, and the `route` actions to start through it. |
| `notes`, `problems` | What the tables work around, and what they can't express: `kind`, `id`, `element`, `state`, `detail`. A template turns them into `warn()` and `error()`. |

A **row** has a `source` and a `target` (null for an internal transition), each `{ kind: "state" \| "pseudo", name, index, composite, role }`, `initial` (the region's initial state), `trigger` (`{ kind, name, index }` with kind `event`, `table`, `entry` or `exit`, or null for an anonymous row taken as soon as the source is entered), `guard` (terms that must all hold, in order), `actions` and a `comment`. Rows are in priority order for a source and trigger: offers to a submachine, then the transitions, then deferral.

Guard terms: `condition`, `precondition` (`condition`, `label`), `requires` (joins), `offer` (the submachine of `state` uses the event), `routed` (`region`, `route`), `restores` (`region`, `route`, `state`), `defaults` (`region`).

Actions: `stateEntry` and `stateExit` (with the `state`, whose `entry`/`exit` steps to run), `call`, `transition` (`id`, `label`: for tracing, as the step), `postcondition`, `terminate`, `exitMachine`, `continue` (post the continuation `event`), `route` (`region`, `route`, `history`: 0, 1 shallow, 2 deep), `submachineAt` (`state`, `point`, `pointIndex`), `entering` and `restore` (the region forgets its route), `defer`, `noBranch` (`label`).

## Semantics of the generated code

The code model and the TypeScript template implement UML run-to-completion semantics:

- **Events** are queued and processed one at a time. Each run-to-completion step first selects the enabled transitions, then fires them.
- **Priority:** the innermost states get the event first. A state's own transitions apply only when none of its substates used the event. Orthogonal regions each fire their own transition in the same step. When two selected transitions conflict (the first one fired has left the source of the other), only the first fires.
- **Completion events** (states entered, do activities ended, all regions final, submachine finished) are processed before the next event. A completion event whose transitions are all disabled is lost.
- **Deferred events** are kept while a deferring state is active and there is no transition for them. They are dispatched again after the next state change. A deferring state has priority over transitions of the states around it.
- **Order of actions:** exits from the innermost state outwards, then the transition actions, then entries from the outside in. Other orthogonal regions get their default entry.
- **Choices** are evaluated when reached, after the exits and actions before them. When no branch is enabled, the generated code throws.
- **Junctions** are static: each way through a chain of junctions becomes its own transition whose guard combines all the guards (`else` is the negation of its siblings). A transition fires only when a whole path is enabled.
- **Forks** enter all their targets, and regions without a target get their default entry. **Joins** fire when all their source states are active and completed (join incoming transitions have no triggers).
- **History:** shallow history restores the last active substate with default entry below it. Deep history restores all levels, including submachines. A region last left in a final state restores by default.
- **Entry points** of a composite state: the state is entered, then the entry point's transitions. Their guards are ignored. **Exit points:** the state is exited, then the exit point's transitions are taken like a junction's.
- **Submachines** run as separate objects. The parent offers them each event before its own transitions (they have priority like substates), starts them by default or through an entry point, stops them when the submachine state is exited, and follows their exit points and completion.
- **Protocol state machines:** preconditions select transitions. An event that finds no transition because a precondition is false is a protocol violation. Postconditions are checked after the transition, and invariants after every step.
