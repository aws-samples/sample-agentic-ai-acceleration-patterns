// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * An in-memory DynamoDB with real condition and update expression semantics
 * for the commands the registry uses (ADR-0036): Get, Put, Update, Delete and
 * Scan, with `ConditionExpression`, `UpdateExpression` (`SET` with `+` and
 * `if_not_exists`), `ExpressionAttributeNames` and `ExpressionAttributeValues`.
 * An expression it does not understand throws, so a test fails loudly instead
 * of passing on a condition nobody evaluated. `aws-sdk-client-mock` routes the
 * document client's commands to it.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

class ConditionalCheckFailedException extends Error {
  public constructor() {
    super('The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

const TOKEN = /\s*(<>|<=|>=|=|<|>|\(|\)|,|\+|[#:]?[A-Za-z_][A-Za-z0-9_]*)/y;

function tokenize(text: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(text);
    if (m === null) throw new Error(`dynamo double: cannot tokenize "${text}" at ${TOKEN.lastIndex}`);
    out.push(m[1]);
  }
  return out;
}

class Parser {
  protected pos = 0;
  public constructor(protected readonly tokens: string[], protected readonly names: Names, protected readonly values: Values) {}

  protected peek(): string | undefined {
    return this.tokens[this.pos];
  }

  protected next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new Error('dynamo double: unexpected end of expression');
    return t;
  }

  protected expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`dynamo double: expected ${t}, got ${got}`);
  }

  protected attrName(token: string): string {
    if (token.startsWith('#')) {
      const n = this.names?.[token];
      if (n === undefined) throw new Error(`dynamo double: ${token} is not in ExpressionAttributeNames`);
      return n;
    }
    return token;
  }

  protected value(token: string): unknown {
    if (!(this.values !== undefined && token in this.values)) throw new Error(`dynamo double: ${token} is not in ExpressionAttributeValues`);
    const v = this.values[token];
    if (v === undefined) throw new Error(`dynamo double: ${token} is undefined`);
    return v;
  }
}

/** Evaluates a ConditionExpression against an item (undefined = no item). */
class ConditionEvaluator extends Parser {
  public constructor(tokens: string[], names: Names, values: Values, private readonly item: Item | undefined) {
    super(tokens, names, values);
  }

  public evaluate(): boolean {
    const r = this.or();
    if (this.pos !== this.tokens.length) throw new Error(`dynamo double: trailing ${this.peek()}`);
    return r;
  }

  private or(): boolean {
    let r = this.and();
    while (this.peek()?.toUpperCase() === 'OR') {
      this.next();
      const rhs = this.and();
      r = r || rhs;
    }
    return r;
  }

  private and(): boolean {
    let r = this.not();
    while (this.peek()?.toUpperCase() === 'AND') {
      this.next();
      const rhs = this.not();
      r = r && rhs;
    }
    return r;
  }

  private not(): boolean {
    if (this.peek()?.toUpperCase() === 'NOT') {
      this.next();
      return !this.not();
    }
    return this.primary();
  }

  private primary(): boolean {
    const t = this.peek();
    if (t === '(') {
      this.next();
      const r = this.or();
      this.expect(')');
      return r;
    }
    if (t === 'attribute_exists' || t === 'attribute_not_exists') {
      this.next();
      this.expect('(');
      const name = this.attrName(this.next());
      this.expect(')');
      const exists = this.item !== undefined && name in this.item;
      return t === 'attribute_exists' ? exists : !exists;
    }
    const left = this.operand();
    const op = this.next();
    const right = this.operand();
    if (!['=', '<>', '<', '<=', '>', '>='].includes(op)) throw new Error(`dynamo double: unsupported operator ${op}`);
    // A comparison with a missing attribute is false (and so is <> on one).
    if (left === MISSING || right === MISSING) return false;
    const l = left as number | string;
    const r = right as number | string;
    switch (op) {
      case '=': return l === r;
      case '<>': return l !== r;
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      default: return l >= r;
    }
  }

  private operand(): unknown {
    const t = this.next();
    if (t.startsWith(':')) return this.value(t);
    const name = this.attrName(t);
    return this.item !== undefined && name in this.item ? this.item[name] : MISSING;
  }
}

const MISSING = Symbol('missing');

/** Applies a `SET a = x, b = b + :n, c = if_not_exists(c, :z) + :g` expression. */
class UpdateEvaluator extends Parser {
  public constructor(tokens: string[], names: Names, values: Values, private readonly item: Item) {
    super(tokens, names, values);
  }

  public apply(): string[] {
    this.expect('SET');
    const changed: string[] = [];
    const writes: Array<[string, unknown]> = [];
    for (;;) {
      const target = this.attrName(this.next());
      this.expect('=');
      writes.push([target, this.sum()]);
      changed.push(target);
      if (this.peek() === ',') {
        this.next();
        continue;
      }
      break;
    }
    if (this.pos !== this.tokens.length) throw new Error(`dynamo double: trailing ${this.peek()}`);
    // Every right-hand side reads the item as it was before the update.
    for (const [k, v] of writes) this.item[k] = v;
    return changed;
  }

  private sum(): unknown {
    let acc = this.term();
    while (this.peek() === '+') {
      this.next();
      const rhs = this.term();
      if (typeof acc !== 'number' || typeof rhs !== 'number') throw new Error('dynamo double: + needs numbers');
      acc += rhs;
    }
    return acc;
  }

  private term(): unknown {
    const t = this.next();
    if (t === 'if_not_exists') {
      this.expect('(');
      const name = this.attrName(this.next());
      this.expect(',');
      const fallback = this.sum();
      this.expect(')');
      return name in this.item ? this.item[name] : fallback;
    }
    if (t.startsWith(':')) return this.value(t);
    const name = this.attrName(t);
    if (!(name in this.item)) throw new Error(`dynamo double: ${name} does not exist in the update expression`);
    return this.item[name];
  }
}

/** Words DynamoDB reserves, a subset of its list: an expression must write these through `#name` placeholders. */
const RESERVED = new Set(['STATE', 'STATUS', 'NAME', 'DATA', 'VALUE', 'TYPE', 'SIZE', 'KEY', 'TIMESTAMP', 'ZONE', 'TOKEN', 'USER', 'SESSION']);

/** Rejects a bare reserved word and a placeholder no expression uses, as DynamoDB's validation does. */
function validateExpressions(i: Record<string, unknown>): void {
  const exprs = [i.ConditionExpression, i.UpdateExpression].filter((e): e is string => typeof e === 'string');
  const tokens = exprs.flatMap(tokenize);
  for (const t of tokens) {
    if (RESERVED.has(t.toUpperCase()) && !t.startsWith('#') && !t.startsWith(':')) throw new Error(`dynamo double: reserved word ${t} used bare`);
  }
  const used = new Set(tokens);
  for (const name of Object.keys((i.ExpressionAttributeNames as Names) ?? {})) {
    if (!used.has(name)) throw new Error(`dynamo double: unused ExpressionAttributeNames entry ${name}`);
  }
  for (const value of Object.keys((i.ExpressionAttributeValues as Values) ?? {})) {
    if (!used.has(value)) throw new Error(`dynamo double: unused ExpressionAttributeValues entry ${value}`);
  }
}

function condition(expr: string | undefined, names: Names, values: Values, item: Item | undefined): void {
  if (expr === undefined) return;
  if (!new ConditionEvaluator(tokenize(expr), names, values, item).evaluate()) throw new ConditionalCheckFailedException();
}

export type Operation = 'get' | 'put' | 'update' | 'delete' | 'scan';

export class DynamoDouble {
  public readonly items = new Map<string, Item>();
  /** Every operation in order, for assertions on how many writes a path made. */
  public readonly log: Array<{ op: Operation; key?: string; ok: boolean }> = [];
  /** Called before each operation runs: a test uses it to make another caller win a race. */
  public hook?: (op: Operation, input: Record<string, unknown>) => void | Promise<void>;
  /** Items per Scan page, to exercise paging. */
  public pageSize = 25;
  public readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  public constructor() {
    const mock = mockClient(this.client);
    mock.on(GetCommand).callsFake((i) => this.run('get', i, () => this.get(i)));
    mock.on(PutCommand).callsFake((i) => this.run('put', i, () => this.put(i)));
    mock.on(UpdateCommand).callsFake((i) => this.run('update', i, () => this.update(i)));
    mock.on(DeleteCommand).callsFake((i) => this.run('delete', i, () => this.delete(i)));
    mock.on(ScanCommand).callsFake((i) => this.run('scan', i, () => this.scan(i)));
  }

  private async run<T>(op: Operation, input: Record<string, unknown>, fn: () => T): Promise<T> {
    if (this.hook !== undefined) await this.hook(op, input);
    const key = input.Key === undefined ? undefined : this.keyOf(input.Key as Item);
    try {
      const out = fn();
      this.log.push({ op, key, ok: true });
      return out;
    } catch (error) {
      this.log.push({ op, key, ok: false });
      throw error;
    }
  }

  private keyOf(k: Item): string {
    return `${String(k.PK)}|${String(k.SK)}`;
  }

  /** The item as stored, or undefined. */
  public row(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  /** Writes an item directly, bypassing every condition (test setup, or a rival caller). */
  public seed(item: Item): void {
    this.items.set(this.keyOf(item), { ...item });
  }

  private check(i: Record<string, unknown>, existing: Item | undefined): void {
    validateExpressions(i);
    condition(i.ConditionExpression as string | undefined, i.ExpressionAttributeNames as Names, i.ExpressionAttributeValues as Values, existing);
  }

  private get(i: Record<string, unknown>) {
    const found = this.items.get(this.keyOf(i.Key as Item));
    return { Item: found === undefined ? undefined : { ...found }, $metadata: {} };
  }

  private put(i: Record<string, unknown>) {
    const item = i.Item as Item;
    const key = this.keyOf(item);
    this.check(i, this.items.get(key));
    this.items.set(key, { ...item });
    return { $metadata: {} };
  }

  private update(i: Record<string, unknown>) {
    const k = i.Key as Item;
    const key = this.keyOf(k);
    const existing = this.items.get(key);
    this.check(i, existing);
    const next: Item = existing === undefined ? { ...k } : { ...existing };
    const changed = new UpdateEvaluator(
      tokenize(i.UpdateExpression as string), i.ExpressionAttributeNames as Names, i.ExpressionAttributeValues as Values, next,
    ).apply();
    this.items.set(key, next);
    const mode = i.ReturnValues as string | undefined;
    let Attributes: Item | undefined;
    if (mode === 'ALL_NEW') Attributes = { ...next };
    if (mode === 'UPDATED_NEW') Attributes = Object.fromEntries(changed.map((c) => [c, next[c]]));
    return { Attributes, $metadata: {} };
  }

  private delete(i: Record<string, unknown>) {
    const key = this.keyOf(i.Key as Item);
    this.check(i, this.items.get(key));
    this.items.delete(key);
    return { $metadata: {} };
  }

  private scan(i: Record<string, unknown>) {
    const keys = [...this.items.keys()].sort();
    const start = i.ExclusiveStartKey === undefined ? 0 : keys.indexOf(this.keyOf(i.ExclusiveStartKey as Item)) + 1;
    const page = keys.slice(start, start + this.pageSize);
    const more = start + this.pageSize < keys.length;
    const last = page.length > 0 ? this.items.get(page[page.length - 1]) : undefined;
    return {
      Items: page.map((k) => ({ ...(this.items.get(k) as Item) })),
      LastEvaluatedKey: more && last !== undefined ? { PK: last.PK, SK: last.SK } : undefined,
      $metadata: {},
    };
  }
}
