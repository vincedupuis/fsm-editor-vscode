export type Check<T = string> = { ok: true; value: T } | { ok: false; error: string };

export type Condition =
  | { op: 'call'; name: string }
  | { op: 'not'; arg: Condition }
  | { op: 'and' | 'or'; args: Condition[] };

export function checkCondition(text: string | undefined): Check;
export function checkGuard(text: string | undefined, allowElse: boolean): Check;
export function checkActions(text: string | undefined): Check;
export function checkEvent(text: string | undefined): Check;
export function checkName(text: string | undefined): Check;
export function checkTrigger(text: string | undefined): Check;
export function checkList(text: string | undefined, check: (item: string) => Check): Check<string[]>;
export function timeTriggerMs(trigger: string | undefined): number | null;
export function parseCondition(text: string | undefined): Check<Condition | null>;
export function parseActions(text: string | undefined): Check<string[]>;
