/**
 * Language presets used by the `guard` and `id` template helpers. A template
 * picks one with `lang:` in its front matter and can override any field there.
 */

export interface GuardSyntax {
  /** Put before every call, e.g. `this.actions.` or `self.`. */
  prefix: string;
  /** Put after every call name. */
  suffix: string;
  not: string;
  and: string;
  or: string;
  /** Printed for a missing condition (unguarded or `else` branch). */
  true: string;
}

export interface LanguageConfig {
  name: string;
  /** Reserved words: `id` appends `escape` to identifiers that collide with them. */
  keywords: string[];
  escape: string;
  guard: GuardSyntax;
}

const C_GUARD: GuardSyntax = { prefix: '', suffix: '()', not: '!', and: ' && ', or: ' || ', true: 'true' };

const C_KEYWORDS = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for',
  'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'bool', 'true', 'false', 'NULL',
];

const CPP_KEYWORDS = [
  ...C_KEYWORDS,
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'bitand', 'bitor', 'catch', 'char8_t', 'char16_t', 'char32_t', 'class',
  'compl', 'concept', 'consteval', 'constexpr', 'constinit', 'const_cast', 'co_await', 'co_return', 'co_yield', 'decltype',
  'delete', 'dynamic_cast', 'explicit', 'export', 'friend', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq',
  'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'reinterpret_cast', 'requires', 'static_assert',
  'static_cast', 'template', 'this', 'thread_local', 'throw', 'try', 'typeid', 'typename', 'using', 'virtual', 'wchar_t',
  'xor', 'xor_eq',
];

const TS_KEYWORDS = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'implements', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield', 'await', 'any', 'boolean', 'constructor', 'declare',
  'get', 'module', 'require', 'number', 'set', 'string', 'symbol', 'type', 'from', 'of', 'undefined',
];

const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import',
  'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return',
  'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null', 'var', 'record', 'yield', 'sealed', 'permits',
];

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'self',
];

export const LANGUAGES: Record<string, LanguageConfig> = {
  c: { name: 'c', keywords: C_KEYWORDS, escape: '_', guard: C_GUARD },
  cpp: { name: 'cpp', keywords: CPP_KEYWORDS, escape: '_', guard: C_GUARD },
  ts: { name: 'ts', keywords: TS_KEYWORDS, escape: '_', guard: C_GUARD },
  java: { name: 'java', keywords: JAVA_KEYWORDS, escape: '_', guard: C_GUARD },
  python: {
    name: 'python',
    keywords: PYTHON_KEYWORDS,
    escape: '_',
    guard: { prefix: 'self.', suffix: '()', not: 'not ', and: ' and ', or: ' or ', true: 'True' },
  },
};

/** The preset named `lang` (or a neutral C-like one), with the front matter's overrides applied. */
export function languageConfig(lang: unknown, overrides: { keywords?: unknown; guard?: unknown; escape?: unknown } = {}): LanguageConfig {
  const name = typeof lang === 'string' ? lang : '';
  const base = LANGUAGES[name] ?? { name, keywords: [], escape: '_', guard: C_GUARD };
  const extra = Array.isArray(overrides.keywords) ? overrides.keywords.map(String) : [];
  const guard = { ...base.guard };
  if (overrides.guard && typeof overrides.guard === 'object') {
    for (const [k, v] of Object.entries(overrides.guard as Record<string, unknown>)) {
      if (k in guard && typeof v === 'string') (guard as Record<string, string>)[k] = v;
    }
  }
  return {
    name: base.name,
    keywords: [...base.keywords, ...extra],
    escape: typeof overrides.escape === 'string' ? overrides.escape : base.escape,
    guard,
  };
}
