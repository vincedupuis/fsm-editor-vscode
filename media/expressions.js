// @ts-check
/**
 * Grammar of the text a state machine may contain. Shared by the webview
 * (loaded as a script, exposed as `FsmExpressions`) and the extension
 * (required as a CommonJS module).
 *
 * The state machine holds no variables: behaviors and conditions are calls to
 * functions without arguments; the parentheses only mark the call.
 *
 *   actions   := call (';' call)*                      entry, exit, do, effect
 *   condition := or                                     guard, invariant, pre/postcondition
 *   or        := and ('||' and)*
 *   and       := unary ('&&' unary)*
 *   unary     := '!' unary | call | '(' or ')'
 *   guard     := 'else' | condition                     'else' only on choice/junction branches
 *   trigger   := event | 'after(' number unit ')'       unit: ms, s, m, h
 *   event     := name                                   also used for deferrable events
 *   call      := name '()'
 *   stereotype:= name
 *   name      := [A-Za-z_][A-Za-z0-9_]*
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FsmExpressions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const TIME = /^after\s*\(\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*\)$/;

  const ok = (value) => ({ ok: true, value });
  const fail = (error) => ({ ok: false, error });

  class SyntaxProblem extends Error {}

  function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (/\s/.test(c)) {
        i++;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
        tokens.push({ t: 'name', v: text.slice(i, j) });
        i = j;
      } else if (text.startsWith('&&', i) || text.startsWith('||', i)) {
        tokens.push({ t: text.slice(i, i + 2) });
        i += 2;
      } else if ('()!;'.includes(c)) {
        tokens.push({ t: c });
        i++;
      } else if (c === '.') {
        throw new SyntaxProblem('Dotted names are not allowed: use a single function name like doThing().');
      } else if ('<>=+-*/%&|'.includes(c) || /\d/.test(c)) {
        throw new SyntaxProblem(
          `'${c}' is not allowed: the state machine has no variables, so use function calls like isReady() combined with !, && and ||.`,
        );
      } else {
        throw new SyntaxProblem(`Unexpected character '${c}'.`);
      }
    }
    return tokens;
  }

  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.i = 0;
    }
    peek() {
      return this.tokens[this.i];
    }
    next() {
      return this.tokens[this.i++];
    }
    call() {
      return `${this.callName()}()`;
    }
    callName() {
      const tok = this.next();
      if (!tok || tok.t !== 'name') {
        throw new SyntaxProblem(tok ? `Expected a function call, found '${tok.t}'.` : 'Expected a function call.');
      }
      const open = this.next();
      if (!open || open.t !== '(') {
        throw new SyntaxProblem(`'${tok.v}' must be a function call: write ${tok.v}().`);
      }
      const close = this.next();
      if (!close || close.t !== ')') {
        throw new SyntaxProblem(`Functions take no arguments: write ${tok.v}().`);
      }
      return tok.v;
    }
    or() {
      const parts = [this.and()];
      while (this.peek() && this.peek().t === '||') {
        this.next();
        parts.push(this.and());
      }
      return parts.join(' || ');
    }
    and() {
      const parts = [this.unary()];
      while (this.peek() && this.peek().t === '&&') {
        this.next();
        parts.push(this.unary());
      }
      return parts.join(' && ');
    }
    unary() {
      const tok = this.peek();
      if (tok && tok.t === '!') {
        this.next();
        return `!${this.unary()}`;
      }
      if (tok && tok.t === '(') {
        this.next();
        const inner = this.or();
        const close = this.next();
        if (!close || close.t !== ')') throw new SyntaxProblem('Missing closing parenthesis.');
        return `(${inner})`;
      }
      return this.call();
    }
    // Same grammar as or/and/unary, building a tree instead of normalized text.
    orTree() {
      const args = [this.andTree()];
      while (this.peek() && this.peek().t === '||') {
        this.next();
        args.push(this.andTree());
      }
      return args.length === 1 ? args[0] : { op: 'or', args };
    }
    andTree() {
      const args = [this.unaryTree()];
      while (this.peek() && this.peek().t === '&&') {
        this.next();
        args.push(this.unaryTree());
      }
      return args.length === 1 ? args[0] : { op: 'and', args };
    }
    unaryTree() {
      const tok = this.peek();
      if (tok && tok.t === '!') {
        this.next();
        return { op: 'not', arg: this.unaryTree() };
      }
      if (tok && tok.t === '(') {
        this.next();
        const inner = this.orTree();
        const close = this.next();
        if (!close || close.t !== ')') throw new SyntaxProblem('Missing closing parenthesis.');
        return inner;
      }
      return { op: 'call', name: this.callName() };
    }
    end() {
      const tok = this.peek();
      if (tok) throw new SyntaxProblem(`Unexpected '${tok.v ?? tok.t}'.`);
    }
  }

  function guarded(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof SyntaxProblem) return fail(e.message);
      throw e;
    }
  }

  /** Condition built from calls, !, && and ||. Empty text is allowed (no condition). */
  function checkCondition(text) {
    const s = String(text ?? '').trim();
    if (!s) return ok('');
    return guarded(() => {
      const p = new Parser(tokenize(s));
      const value = p.or();
      p.end();
      return ok(value);
    });
  }

  /**
   * Condition as a tree: { op: 'call', name } | { op: 'not', arg } | { op: 'and' | 'or', args }.
   * Empty text gives null (no condition).
   */
  function parseCondition(text) {
    const s = String(text ?? '').trim();
    if (!s) return ok(null);
    return guarded(() => {
      const p = new Parser(tokenize(s));
      const value = p.orTree();
      p.end();
      return ok(value);
    });
  }

  /** Names of the functions a behavior calls, in order. */
  function parseActions(text) {
    const r = checkActions(text);
    if (!r.ok) return r;
    return ok(r.value ? r.value.split('; ').map((c) => c.slice(0, -2)) : []);
  }

  /** Transition guard: a condition, or 'else' when `allowElse` is set. */
  function checkGuard(text, allowElse) {
    const s = String(text ?? '').trim();
    if (s === 'else') {
      return allowElse ? ok('else') : fail("[else] is only allowed on transitions leaving a choice or junction.");
    }
    return checkCondition(s);
  }

  /** Behavior: calls separated by ';'. Empty text is allowed (no behavior). */
  function checkActions(text) {
    const s = String(text ?? '').trim().replace(/;\s*$/, '');
    if (!s) return ok('');
    return guarded(() => {
      const p = new Parser(tokenize(s));
      const calls = [p.call()];
      while (p.peek() && p.peek().t === ';') {
        p.next();
        calls.push(p.call());
      }
      const tok = p.peek();
      if (tok) {
        throw new SyntaxProblem(
          tok.t === '&&' || tok.t === '||' || tok.t === '!'
            ? 'Actions cannot use !, && or ||: separate several calls with ;'
            : `Unexpected '${tok.v ?? tok.t}': separate several calls with ;`,
        );
      }
      return ok(calls.join('; '));
    });
  }

  /** Event name (used for triggers and deferrable events). */
  function checkEvent(text) {
    const s = String(text ?? '').trim();
    if (!s) return fail('Empty event name.');
    if (/^after\b/.test(s)) return fail('A time event cannot be deferred; use a named event.');
    if (/\(/.test(s)) return fail(`Events are plain names without (): write ${s.replace(/\s*\(.*$/, '')}.`);
    if (!NAME.test(s)) return fail(`'${s}' is not a valid event name (letters, digits and _ only).`);
    return ok(s);
  }

  /** A plain name (letters, digits and _), e.g. a stereotype. */
  function checkName(text) {
    const s = String(text ?? '').trim();
    if (!s) return ok('');
    if (!NAME.test(s)) return fail(`'${s}' is not a valid name: use letters, digits and _ only, not starting with a digit.`);
    return ok(s);
  }

  /** One trigger: an event name, or after(<number><ms|s|m|h>). */
  function checkTrigger(text) {
    const s = String(text ?? '').trim();
    if (/^after\b/.test(s)) {
      const m = TIME.exec(s);
      if (!m) return fail('Time triggers are written after(<number><unit>) with unit ms, s, m or h, e.g. after(500ms) or after(2s).');
      if (Number(m[1]) <= 0) return fail('The time of an after() trigger must be greater than zero.');
      return ok(`after(${m[1]}${m[2]})`);
    }
    if (/^when\b/.test(s)) return fail('Change events (when) are not supported: use a named event or after(...).');
    if (!s) return fail('Empty trigger.');
    if (/\(/.test(s)) return fail(`Events are plain names without (): write ${s.replace(/\s*\(.*$/, '')}. The only exception is after(...).`);
    if (!NAME.test(s)) return fail(`'${s}' is not a valid event name (letters, digits and _ only).`);
    return ok(s);
  }

  /** Comma-separated list checked item by item; returns the normalized array. */
  function checkList(text, check) {
    const items = String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const item of items) {
      const r = check(item);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }

  /** Parses an after() trigger into milliseconds, or returns null. */
  function timeTriggerMs(trigger) {
    const m = TIME.exec(String(trigger ?? '').trim());
    if (!m) return null;
    const factor = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]];
    return Number(m[1]) * factor;
  }

  return {
    checkCondition,
    checkGuard,
    checkActions,
    checkEvent,
    checkName,
    checkTrigger,
    checkList,
    timeTriggerMs,
    parseCondition,
    parseActions,
  };
});
