// Regression tests for the round-2 fix pass 4, cluster "env": the sea's two ripple samples stay
// continuous when their offsets wrap, the particle and skid shaders really apply the scene light,
// and cars wading through the surf throw spray and leave a wake.
// The shaders are run on the CPU by a small GLSL interpreter (below), so the tests check what the
// shader code does with its inputs rather than a copy of it in JS.
// The stub header is copied from fix_render.test.ts (vi.mock cannot be shared between files).

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Effects } from '../../src/render/effects';
import { Environment } from '../../src/render/environment';
import { GameRenderer } from '../../src/render/renderer';
import * as textures from '../../src/render/textures';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { WATER_Y } from '../../src/world/constants';
import type { StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    // Every other 2D call is a no-op; property writes are kept.
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly params: Record<string, unknown>;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.params = params;
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    private target: unknown = null;
    setRenderTarget(t: unknown): void {
      this.target = t;
    }
    getRenderTarget(): unknown {
      return this.target;
    }
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// A small GLSL interpreter. It runs a fragment shader's main() on the CPU, over the part of the
// language these shaders use: float, vec and mat values, swizzles, the arithmetic, comparison and
// logic operators, declarations, (compound) assignments, if and discard, the built-ins in FUNCS, and
// the preprocessor's #if family against the material's defines. #include lines are left out: they are
// three's chunks (tone mapping, colour space, fog), which come after the colour is formed.

class Vec {
  constructor(readonly c: number[]) {}
}
/** A square matrix, column-major as in GLSL. */
class Mat {
  constructor(
    readonly n: number,
    readonly c: number[],
  ) {}
}
/** A texture handle (texture2D hands it to the caller's hook). */
class Sampler {
  constructor(readonly name: string) {}
}
type Val = number | boolean | Vec | Mat | Sampler;

type Expr =
  | { k: 'lit'; v: Val }
  | { k: 'id'; name: string }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'field'; obj: Expr; name: string }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr };
type Stmt =
  | { k: 'decl'; type: string; vars: Array<{ name: string; init: Expr | null }> }
  | { k: 'assign'; target: Expr; op: string; value: Expr }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; c: Expr; then: Stmt; else: Stmt | null }
  | { k: 'block'; body: Stmt[] }
  | { k: 'discard' }
  | { k: 'return' };

interface Hooks {
  texture?: (sampler: Val, uv: Vec) => Vec;
}

const num = (v: Val): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error('a scalar was expected');
};
const comps = (v: Val): number[] => (v instanceof Vec || v instanceof Mat ? v.c : [num(v)]);
const truthy = (v: Val): boolean => (typeof v === 'boolean' ? v : num(v) !== 0);

/** f applied per component, scalars standing for every component (GLSL's component-wise built-ins and operators). */
function each(args: Val[], f: (...x: number[]) => number): Val {
  const vecs = args.filter((a): a is Vec => a instanceof Vec);
  if (vecs.length === 0) return f(...args.map(num));
  const n = vecs[0]!.c.length;
  if (vecs.some((v) => v.c.length !== n)) throw new Error('vectors of different sizes');
  return new Vec(Array.from({ length: n }, (_, i) => f(...args.map((a) => (a instanceof Vec ? a.c[i]! : num(a))))));
}

function vecOf(n: number, args: Val[]): Vec {
  const c = args.flatMap(comps);
  if (c.length === 1) return new Vec(new Array<number>(n).fill(c[0]!));
  if (c.length < n) throw new Error(`vec${n} needs ${n} components`);
  return new Vec(c.slice(0, n));
}

function matOf(n: number, args: Val[]): Mat {
  const c = args.flatMap(comps);
  if (c.length === 1) return new Mat(n, Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? c[0]! : 0)));
  if (c.length !== n * n) throw new Error(`mat${n} needs ${n * n} components`);
  return new Mat(n, c);
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const FUNCS: Record<string, (a: Val[]) => Val> = {
  float: (a) => num(a[0]!),
  vec2: (a) => vecOf(2, a),
  vec3: (a) => vecOf(3, a),
  vec4: (a) => vecOf(4, a),
  mat2: (a) => matOf(2, a),
  mat3: (a) => matOf(3, a),
  length: (a) => Math.hypot(...comps(a[0]!)),
  normalize: (a) => {
    const c = comps(a[0]!);
    const l = Math.hypot(...c);
    return new Vec(c.map((x) => x / l));
  },
  dot: (a) => {
    const y = comps(a[1]!);
    return comps(a[0]!).reduce((s, x, i) => s + x * y[i]!, 0);
  },
  abs: (a) => each(a, Math.abs),
  floor: (a) => each(a, Math.floor),
  fract: (a) => each(a, (x) => x - Math.floor(x)),
  sqrt: (a) => each(a, Math.sqrt),
  exp: (a) => each(a, Math.exp),
  sin: (a) => each(a, Math.sin),
  cos: (a) => each(a, Math.cos),
  min: (a) => each(a, Math.min),
  max: (a) => each(a, Math.max),
  pow: (a) => each(a, Math.pow),
  step: (a) => each(a, (e, x) => (x! < e! ? 0 : 1)),
  clamp: (a) => each(a, (x, lo, hi) => Math.min(Math.max(x!, lo!), hi!)),
  mix: (a) => each(a, (x, y, t) => x! * (1 - t!) + y! * t!),
  smoothstep: (a) => each(a, (e0, e1, x) => smooth(e0!, e1!, x!)),
};

function matMul(a: Val, b: Val): Val {
  if (a instanceof Mat && b instanceof Vec) {
    const n = a.n;
    if (b.c.length !== n) throw new Error('mat * vec sizes');
    return new Vec(Array.from({ length: n }, (_, i) => b.c.reduce((s, x, j) => s + a.c[j * n + i]! * x, 0)));
  }
  if (a instanceof Vec && b instanceof Mat) {
    const n = b.n;
    if (a.c.length !== n) throw new Error('vec * mat sizes');
    return new Vec(Array.from({ length: n }, (_, j) => a.c.reduce((s, x, i) => s + x * b.c[j * n + i]!, 0)));
  }
  if (a instanceof Mat && b instanceof Mat) {
    const n = a.n;
    const c = new Array<number>(n * n).fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[j * n + i] = c[j * n + i]! + a.c[k * n + i]! * b.c[j * n + k]!;
    return new Mat(n, c);
  }
  if (a instanceof Mat) return new Mat(a.n, a.c.map((x) => x * num(b)));
  if (b instanceof Mat) return new Mat(b.n, b.c.map((x) => num(a) * x));
  throw new Error('matrix product');
}

function arith(op: string, a: Val, b: Val): Val {
  if (op === '*' && (a instanceof Mat || b instanceof Mat)) return matMul(a, b);
  if (a instanceof Mat || b instanceof Mat) throw new Error(`matrix ${op}`);
  if (op === '+') return each([a, b], (x, y) => x! + y!);
  if (op === '-') return each([a, b], (x, y) => x! - y!);
  if (op === '*') return each([a, b], (x, y) => x! * y!);
  if (op === '/') return each([a, b], (x, y) => x! / y!);
  throw new Error(`operator ${op}`);
}

function compare(op: string, a: Val, b: Val): boolean {
  if (op === '==' || op === '!=') {
    const x = comps(a);
    const y = comps(b);
    const eq = x.length === y.length && x.every((v, i) => v === y[i]);
    return op === '==' ? eq : !eq;
  }
  const x = num(a);
  const y = num(b);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

function swizzleIdx(name: string, n: number): number[] {
  return [...name].map((ch) => {
    const k = 'xyzw rgba stpq'.indexOf(ch) % 5;
    if (k < 0 || k >= n) throw new Error(`no .${name} on a vec${n}`);
    return k;
  });
}

function swizzle(v: Val, name: string): Val {
  if (!(v instanceof Vec)) throw new Error(`.${name} of a non-vector`);
  const idx = swizzleIdx(name, v.c.length);
  return idx.length === 1 ? v.c[idx[0]!]! : new Vec(idx.map((k) => v.c[k]!));
}

class Scope {
  private readonly vars = new Map<string, Val>();
  constructor(private readonly parent: Scope | null) {}
  declare(name: string, v: Val): void {
    this.vars.set(name, v);
  }
  get(name: string): Val {
    const v = this.vars.get(name);
    if (v !== undefined) return v;
    if (!this.parent) throw new Error(`'${name}' has no value`);
    return this.parent.get(name);
  }
  set(name: string, v: Val): void {
    if (this.vars.has(name)) this.vars.set(name, v);
    else if (this.parent) this.parent.set(name, v);
    else throw new Error(`'${name}' is not declared`);
  }
}

const TOKEN = /(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||[-+*/<>!=?:(),.;{}[\]])|(\S)/g;

function tokenize(src: string, macros?: Map<string, string>): string[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const out: string[] = [];
  for (const m of s.matchAll(TOKEN)) {
    if (m[4]) throw new Error(`unexpected '${m[4]}'`);
    const sub = m[2] ? macros?.get(m[0]) : undefined;
    if (sub) out.push(...tokenize(sub));
    else out.push(m[0]);
  }
  return out;
}

const TYPES = new Set(['void', 'bool', 'int', 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D']);
const QUALIFIERS = new Set(['const', 'highp', 'mediump', 'lowp']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=']);
/** Binary operators by precedence, loosest first. */
const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/']];

class Parser {
  private i = 0;
  constructor(private readonly t: string[]) {}
  private peek(o = 0): string | undefined {
    return this.t[this.i + o];
  }
  private next(): string {
    const s = this.t[this.i++];
    if (s === undefined) throw new Error('unexpected end of shader');
    return s;
  }
  private eat(s: string): void {
    const n = this.next();
    if (n !== s) throw new Error(`expected '${s}', found '${n}' in: ${this.t.slice(Math.max(0, this.i - 6), this.i + 6).join(' ')}`);
  }
  private skip(open: string, close: string): void {
    this.eat(open);
    for (let depth = 1; depth > 0; ) {
      const s = this.next();
      if (s === open) depth++;
      else if (s === close) depth--;
    }
  }

  /** The shader's global constants and main()'s body; uniform and varying declarations are the caller's inputs. */
  program(): { globals: Stmt[]; main: Stmt[] } {
    const globals: Stmt[] = [];
    let main: Stmt[] | null = null;
    while (this.i < this.t.length) {
      const tok = this.peek()!;
      if (tok === ';') {
        this.i++;
      } else if (['uniform', 'varying', 'attribute', 'in', 'out', 'precision'].includes(tok)) {
        while (this.next() !== ';');
      } else {
        let j = this.i;
        while (QUALIFIERS.has(this.t[j] ?? '')) j++;
        if (TYPES.has(this.t[j] ?? '') && this.t[j + 2] === '(') {
          const name = this.t[j + 1];
          this.i = j + 2;
          this.skip('(', ')');
          if (name !== 'main') throw new Error(`function ${name}(): not supported`);
          const body = this.block();
          main = body.k === 'block' ? body.body : [body];
        } else {
          globals.push(this.statement());
        }
      }
    }
    if (!main) throw new Error('no main()');
    return { globals, main };
  }

  private block(): Stmt {
    this.eat('{');
    const body: Stmt[] = [];
    while (this.peek() !== '}') body.push(this.statement());
    this.i++;
    return { k: 'block', body };
  }

  private statement(): Stmt {
    const tok = this.peek();
    if (tok === '{') return this.block();
    if (tok === 'if') {
      this.i++;
      this.eat('(');
      const c = this.expr();
      this.eat(')');
      const then = this.statement();
      let els: Stmt | null = null;
      if (this.peek() === 'else') {
        this.i++;
        els = this.statement();
      }
      return { k: 'if', c, then, else: els };
    }
    if (tok === 'discard' || tok === 'return') {
      this.i++;
      this.eat(';');
      return tok === 'discard' ? { k: 'discard' } : { k: 'return' };
    }
    let j = this.i;
    while (QUALIFIERS.has(this.t[j] ?? '')) j++;
    if (TYPES.has(this.t[j] ?? '') && /^[A-Za-z_]\w*$/.test(this.t[j + 1] ?? '')) {
      const type = this.t[j]!;
      this.i = j + 1;
      const vars: Array<{ name: string; init: Expr | null }> = [];
      for (;;) {
        const name = this.next();
        let init: Expr | null = null;
        if (this.peek() === '=') {
          this.i++;
          init = this.expr();
        }
        vars.push({ name, init });
        if (this.peek() !== ',') break;
        this.i++;
      }
      this.eat(';');
      return { k: 'decl', type, vars };
    }
    const e = this.expr();
    if (ASSIGN.has(this.peek() ?? '')) {
      const op = this.next();
      const value = this.expr();
      this.eat(';');
      return { k: 'assign', target: e, op, value };
    }
    this.eat(';');
    return { k: 'expr', e };
  }

  expr(): Expr {
    const c = this.binary(0);
    if (this.peek() !== '?') return c;
    this.i++;
    const a = this.expr();
    this.eat(':');
    const b = this.expr();
    return { k: 'cond', c, a, b };
  }

  private binary(level: number): Expr {
    if (level === LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    while (LEVELS[level]!.includes(this.peek() ?? '')) {
      const op = this.next();
      a = { k: 'bin', op, a, b: this.binary(level + 1) };
    }
    return a;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t === '-' || t === '+' || t === '!') {
      this.i++;
      return { k: 'unary', op: t, e: this.unary() };
    }
    let e = this.primary();
    while (this.peek() === '.') {
      this.i++;
      e = { k: 'field', obj: e, name: this.next() };
    }
    return e;
  }

  private primary(): Expr {
    const t = this.next();
    if (t === '(') {
      const e = this.expr();
      this.eat(')');
      return e;
    }
    if (/^[\d.]/.test(t)) return { k: 'lit', v: Number(t) };
    if (t === 'true' || t === 'false') return { k: 'lit', v: t === 'true' };
    if (!/^[A-Za-z_]\w*$/.test(t)) throw new Error(`unexpected '${t}'`);
    if (this.peek() !== '(') return { k: 'id', name: t };
    this.i++;
    const args: Expr[] = [];
    while (this.peek() !== ')') {
      args.push(this.expr());
      if (this.peek() === ',') this.i++;
    }
    this.i++;
    return { k: 'call', name: t, args };
  }
}

function evalExpr(e: Expr, s: Scope, h: Hooks): Val {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'id':
      return s.get(e.name);
    case 'field':
      return swizzle(evalExpr(e.obj, s, h), e.name);
    case 'unary': {
      const v = evalExpr(e.e, s, h);
      if (e.op === '!') return !truthy(v);
      return e.op === '-' ? arith('*', v, -1) : v;
    }
    case 'bin': {
      if (e.op === '&&') return truthy(evalExpr(e.a, s, h)) && truthy(evalExpr(e.b, s, h));
      if (e.op === '||') return truthy(evalExpr(e.a, s, h)) || truthy(evalExpr(e.b, s, h));
      const a = evalExpr(e.a, s, h);
      const b = evalExpr(e.b, s, h);
      return ['<', '>', '<=', '>=', '==', '!='].includes(e.op) ? compare(e.op, a, b) : arith(e.op, a, b);
    }
    case 'cond':
      return truthy(evalExpr(e.c, s, h)) ? evalExpr(e.a, s, h) : evalExpr(e.b, s, h);
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, s, h));
      if (e.name === 'texture2D' || e.name === 'texture') {
        const uv = args[1];
        if (!h.texture || !(uv instanceof Vec)) throw new Error(`${e.name} without a texture hook`);
        return h.texture(args[0]!, uv);
      }
      const f = FUNCS[e.name];
      if (!f) throw new Error(`unknown function ${e.name}()`);
      return f(args);
    }
  }
}

function zero(type: string): Val {
  const n = Number(type.slice(-1));
  if (type.startsWith('vec')) return new Vec(new Array<number>(n).fill(0));
  if (type.startsWith('mat')) return new Mat(n, new Array<number>(n * n).fill(0));
  return type === 'bool' ? false : 0;
}

class Discard {}
class Return {}

function exec(st: Stmt, s: Scope, h: Hooks): void {
  switch (st.k) {
    case 'block': {
      const inner = new Scope(s);
      for (const b of st.body) exec(b, inner, h);
      return;
    }
    case 'decl':
      for (const v of st.vars) s.declare(v.name, v.init ? evalExpr(v.init, s, h) : zero(st.type));
      return;
    case 'assign': {
      const t = st.target;
      let v = evalExpr(st.value, s, h);
      if (st.op !== '=') v = arith(st.op[0]!, evalExpr(t, s, h), v);
      if (t.k === 'id') {
        s.set(t.name, v);
      } else if (t.k === 'field' && t.obj.k === 'id') {
        const base = s.get(t.obj.name);
        if (!(base instanceof Vec)) throw new Error(`.${t.name} of a non-vector`);
        const idx = swizzleIdx(t.name, base.c.length);
        const src = comps(v);
        if (src.length !== idx.length) throw new Error(`.${t.name} = a value of ${src.length} components`);
        const c = base.c.slice();
        idx.forEach((k, i) => (c[k] = src[i]!));
        s.set(t.obj.name, new Vec(c));
      } else {
        throw new Error('unsupported assignment');
      }
      return;
    }
    case 'expr':
      evalExpr(st.e, s, h);
      return;
    case 'if':
      if (truthy(evalExpr(st.c, s, h))) exec(st.then, new Scope(s), h);
      else if (st.else) exec(st.else, new Scope(s), h);
      return;
    case 'discard':
      throw new Discard();
    case 'return':
      throw new Return();
  }
}

/** Keeps the lines of `src` the #if family leaves in for these defines; also returns the macros (with #define's). */
function preprocess(src: string, defines: Record<string, string>): { code: string; macros: Map<string, string> } {
  const macros = new Map(Object.entries(defines));
  const ppTrue = (cond: string): boolean => {
    const s = cond.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_m, a?: string, b?: string) => (macros.has((a ?? b)!) ? '1' : '0')).replace(/[A-Za-z_]\w*/g, (id) => macros.get(id) || '0');
    return truthy(evalExpr(new Parser(tokenize(s)).expr(), new Scope(null), {}));
  };
  const out: string[] = [];
  const stack: Array<{ parent: boolean; taken: boolean }> = [];
  let on: boolean = true;
  for (const line of src.split('\n')) {
    const m = /^\s*#\s*(\w+)(.*)$/.exec(line);
    if (!m) {
      if (on) out.push(line);
      continue;
    }
    const dir = m[1]!;
    const rest = m[2]!.trim();
    if (dir === 'ifdef' || dir === 'ifndef' || dir === 'if') {
      const c: boolean = on && (dir === 'if' ? ppTrue(rest) : macros.has(rest) === (dir === 'ifdef'));
      stack.push({ parent: on, taken: c });
      on = c;
    } else if (dir === 'elif' || dir === 'else') {
      const top = stack[stack.length - 1];
      if (!top) throw new Error(`#${dir} without #if`);
      const c: boolean = top.parent && !top.taken && (dir === 'else' || ppTrue(rest));
      top.taken ||= c;
      on = c;
    } else if (dir === 'endif') {
      const top = stack.pop();
      if (!top) throw new Error('#endif without #if');
      on = top.parent;
    } else if (dir === 'define' && on) {
      const d = /^(\w+)\s*(.*)$/.exec(rest)!;
      macros.set(d[1]!, d[2]!);
    }
    // #include (three's chunks, see above), #version, #extension, #pragma: left out.
  }
  if (stack.length) throw new Error('unbalanced #if');
  return { code: out.join('\n'), macros };
}

interface ShaderRun {
  /** A variable at main()'s top level after the run (gl_FragColor, inputs and main's own locals). */
  get(name: string): Val;
  discarded: boolean;
}

/** Parses a fragment shader once for a material's defines; run() executes its main() for given inputs. */
function compileGlsl(src: string, defines: Record<string, unknown> = {}): { run(inputs: Record<string, Val>, hooks?: Hooks): ShaderRun } {
  const { code, macros } = preprocess(src, Object.fromEntries(Object.entries(defines).map(([k, v]) => [k, String(v ?? '')])));
  const { globals, main } = new Parser(tokenize(code, macros)).program();
  return {
    run(inputs, hooks = {}) {
      const root = new Scope(null);
      root.declare('gl_FragColor', new Vec([0, 0, 0, 0]));
      for (const [k, v] of Object.entries(inputs)) root.declare(k, v);
      for (const g of globals) exec(g, root, hooks);
      const body = new Scope(root);
      let discarded = false;
      try {
        for (const st of main) exec(st, body, hooks);
      } catch (e) {
        if (e instanceof Discard) discarded = true;
        else if (!(e instanceof Return)) throw e;
      }
      return { get: (name) => body.get(name), discarded };
    },
  };
}

/** A uniform's value as the shader sees it (textures and other objects as opaque handles). */
function glslValue(v: unknown): Val {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof THREE.Color) return new Vec([v.r, v.g, v.b]);
  if (v instanceof THREE.Vector2) return new Vec([v.x, v.y]);
  if (v instanceof THREE.Vector3) return new Vec([v.x, v.y, v.z]);
  if (v instanceof THREE.Vector4) return new Vec([v.x, v.y, v.z, v.w]);
  if (v instanceof THREE.Matrix3) return new Mat(3, [...v.elements]);
  if (v instanceof THREE.Matrix4) return new Mat(4, [...v.elements]);
  return new Sampler(String(v));
}

function uniformValues(u: Record<string, THREE.IUniform>): Record<string, Val> {
  return Object.fromEntries(Object.entries(u).map(([k, x]) => [k, glslValue(x.value)]));
}

const vecOfColor = (c: Vec): THREE.Color => new THREE.Color(c.c[0]!, c.c[1]!, c.c[2]!);

describe('the GLSL interpreter', () => {
  it('evaluates as GLSL does: column-major matrices, swizzles, the preprocessor, discard', () => {
    const run = (body: string, defines: Record<string, unknown> = {}, inputs: Record<string, Val> = {}) => compileGlsl(`uniform vec3 uIn;\nvoid main() {\n${body}\n}`, defines).run(inputs);
    // mat2(a, b, c, d) has columns (a, b) and (c, d).
    const m = run('vec2 r = mat2( 1.0, 2.0, 3.0, 4.0 ) * vec2( 1.0, 0.0 );\nvec2 q = vec2( 1.0, 0.0 ) * mat2( 1.0, 2.0, 3.0, 4.0 );');
    expect((m.get('r') as Vec).c).toEqual([1, 2]);
    expect((m.get('q') as Vec).c).toEqual([1, 3]);
    const sw = run('gl_FragColor = vec4( uIn, 0.5 );\ngl_FragColor.rgb *= 2.0;\ngl_FragColor.a -= 0.25;\nfloat s = smoothstep( 1.0, 0.25, 0.0 );', {}, { uIn: new Vec([0.1, 0.2, 0.3]) });
    expect((sw.get('gl_FragColor') as Vec).c.map((x) => +x.toFixed(9))).toEqual([0.2, 0.4, 0.6, 0.25]);
    expect(sw.get('s')).toBe(1);
    // Precedence (unary minus, then * and /, then + and -; a swizzle before the minus), and swizzled reads.
    const pr = run('float p = -2.0 * 3.0 + 4.0 / 2.0 - 1.0;\nvec3 w = -vec3( 1.0, 2.0, 3.0 ).zyx * 2.0;\nbool b = 1.0 < 2.0 && ! ( 3.0 < 2.0 ) || false;');
    expect(pr.get('p')).toBe(-5);
    expect((pr.get('w') as Vec).c).toEqual([-6, -4, -2]);
    expect(pr.get('b')).toBe(true);
    const pp = (defines: Record<string, unknown>) => run('float x = 1.0;\n#ifdef A\nx = 2.0;\n#elif defined( B ) && ! defined( C )\nx = 3.0;\n#else\nx = 4.0;\n#endif', defines).get('x');
    expect([pp({ A: '' }), pp({ B: '' }), pp({ B: '', C: '' }), pp({})]).toEqual([2, 3, 4, 4]);
    expect(run('if ( 0.003 < 0.004 ) discard;\ngl_FragColor = vec4( 1.0 );').discarded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The sea's two ripple samples move continuously, also where their offsets wrap

function fakeRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer();
}

/** The ripple tile as three samples it: bilinear, repeating, the canvas flipped (flipY) so that its top row is v = 1. */
function rippleSampler(): (uv: Vec) => Vec {
  const d = textures.waterNormalData();
  const S = textures.WATER_TILE;
  const texel = (x: number, y: number, c: number) => d[((((y % S) + S) % S) * S + (((x % S) + S) % S)) * 4 + c]! / 255;
  return (uv) => {
    const x = uv.c[0]! * S - 0.5;
    const y = (1 - uv.c[1]!) * S - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return new Vec([0, 1, 2, 3].map((c) => (texel(x0, y0, c) * (1 - fx) + texel(x0 + 1, y0, c) * fx) * (1 - fy) + (texel(x0, y0 + 1, c) * (1 - fx) + texel(x0 + 1, y0 + 1, c) * fx) * fy));
  };
}

describe('sea ripples over time', () => {
  // With float colour buffers, and without (where the sea's patch also reflects the sky).
  it.each([true, false])('neither ripple sample jumps where an offset wraps (at 83.3 s and 125 s among others): each moves by its drift only, and so does the sea\'s normal (hdr %s)', (hdr) => {
    const r = fakeRenderer();
    const env = new Environment(new THREE.Scene(), r, { hdr });
    const mat = env.water.material as THREE.MeshStandardMaterial;
    // The normal-map step of three's fragment shader, rewritten by the sea's patch.
    const shader = {
      vertexShader: '',
      fragmentShader: '#include <common>\nvoid main() {\n  vec3 normal = vec3( 0.0, 0.0, 1.0 );\n  mat3 tbn = mat3( 1.0 );\n  #include <normal_fragment_maps>\n}',
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, r);
    expect('uSkyI' in shader.uniforms, 'the sky reflection only without float buffers').toBe(!hdr);
    const prog = compileGlsl(shader.fragmentShader, { USE_NORMALMAP_TANGENTSPACE: '' });
    const sample = rippleSampler();
    const map = mat.normalMap!;
    const cam = new THREE.PerspectiveCamera();
    const focus = new THREE.Vector3();
    // Points of the sea plane (its UV runs 0..1 across its 6 km).
    const points = [
      [0.5012, 0.4987],
      [0.531, 0.512],
      [0.47, 0.55],
    ] as const;
    /** At renderer time t: the UV of each texture2D call (the first sample's, the second's) and the normal at each point. */
    const at = (t: number) => {
      env.update(12, focus, cam, t, r);
      // As three does before it uploads normalMapTransform.
      map.updateMatrix();
      const uniforms = uniformValues(shader.uniforms);
      return points.map(([u, v]) => {
        const uv = new THREE.Vector3(u, v, 1).applyMatrix3(map.matrix);
        const calls: Vec[] = [];
        const out = prog.run(
          { ...uniforms, vNormalMapUv: new Vec([uv.x, uv.y]), normalMap: new Sampler('normalMap'), normalScale: glslValue(mat.normalScale) },
          {
            texture: (_s, p) => {
              calls.push(p);
              return sample(p);
            },
          },
        );
        return { calls, normal: out.get('normal') as Vec };
      });
    };
    let prev = at(0);
    expect(prev[0]!.calls.length, 'two samples of the ripple tile').toBe(2);
    /** Each sample's move over one frame, less whole tiles (which a tiled sample cannot show), at the first frame. */
    let drift: number[][] | null = null;
    let worst = 0;
    let worstAt = '';
    const wraps: Array<{ t: number; dn: number }> = [];
    let ordinary = 0;
    for (let k = 1; k <= 130 * 60; k++) {
      const t = k * DT;
      const cur = at(t);
      let wrapped = false;
      let dn = 0;
      cur.forEach((p, i) => {
        const q = prev[i]!;
        const moves = p.calls.map((uv, s) => {
          const d = [uv.c[0]! - q.calls[s]!.c[0]!, uv.c[1]! - q.calls[s]!.c[1]!];
          if (d.some((x) => Math.abs(x) > 0.5)) wrapped = true;
          return d.map((x) => x - Math.round(x));
        });
        drift ??= moves;
        moves.forEach((m, s) => {
          const e = Math.hypot(m[0]! - drift![s]![0]!, m[1]! - drift![s]![1]!);
          if (e > worst) {
            worst = e;
            worstAt = `sample ${s} at ${t.toFixed(3)} s: moved (${m.map((x) => x.toFixed(5))}) against (${drift![s]!.map((x) => x.toFixed(5))})`;
          }
        });
        dn = Math.max(dn, Math.hypot(...p.normal.c.map((x, c) => x - q.normal.c[c]!)));
      });
      if (wrapped) wraps.push({ t, dn });
      else ordinary = Math.max(ordinary, dn);
      prev = cur;
    }
    // A run with the wraps in it: the first sample's offset wraps at 1 / 0.012 s and 1 / 0.008 s.
    expect(wraps.length, 'offset wraps in the run').toBeGreaterThanOrEqual(2);
    expect(worst, `largest frame move of a sample off its drift (tiles), ${worstAt}`).toBeLessThan(1e-6);
    for (const w of wraps) expect(w.dn, `the sea's normal across the wrap at ${w.t.toFixed(3)} s, against at most ${ordinary.toFixed(5)} over any other frame`).toBeLessThan(1.5 * ordinary);
  });
});

// ---------------------------------------------------------------------------
// The particle and skid shaders apply the scene light (Effects.setLight)

/** The private particle layers and skid marks of an Effects, for inspection. */
interface Layer {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  active: number;
}
interface FxPriv {
  glow: Layer;
  smoke: Layer;
  skids: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> };
}

/** What a layer's fragment shader draws at the middle of a sprite whose (vertex) colour is rgba. */
function spritePixel(layer: Layer, rgba: readonly number[]): Vec {
  const mat = layer.mesh.material;
  const out = compileGlsl(mat.fragmentShader, mat.defines).run({ ...uniformValues(mat.uniforms), vUv: new Vec([0.5, 0.5]), vColor: new Vec([...rgba]) });
  expect(out.discarded).toBe(false);
  return out.get('gl_FragColor') as Vec;
}

/** What the skid marks' fragment shader draws for a mark of opacity vA. */
function skidPixel(fx: FxPriv, vA: number): Vec {
  const mat = fx.skids.mesh.material;
  return compileGlsl(mat.fragmentShader, mat.defines).run({ ...uniformValues(mat.uniforms), vA }).get('gl_FragColor') as Vec;
}

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('lit smoke and skid marks, through their shaders', () => {
  it('the smoke layer\'s shader multiplies its colour by the light, the glow layer\'s does not, and the skid marks take it', () => {
    const fx = new Effects();
    const priv = fx as unknown as FxPriv;
    const rgba = [0.8, 0.7, 0.6, 0.9] as const;
    for (const light of [new THREE.Color(0, 0, 0), new THREE.Color(1, 1, 1), new THREE.Color(0.2, 0.35, 0.7)]) {
      fx.setLight(light);
      const tag = `light ${light.toArray().join(', ')}`;
      const smoke = spritePixel(priv.smoke, rgba);
      for (let c = 0; c < 3; c++) expect(smoke.c[c], `${tag}: smoke channel ${c}`).toBeCloseTo(rgba[c]! * light.toArray()[c]!, 9);
      expect(smoke.c[3], `${tag}: smoke alpha`).toBeCloseTo(rgba[3], 9);
      // Fire, sparks and flashes glow by themselves.
      const glow = spritePixel(priv.glow, rgba);
      for (let c = 0; c < 4; c++) expect(glow.c[c], `${tag}: glow channel ${c}`).toBeCloseTo(rgba[c]!, 9);
      // Rubber on the road: 0.04 grey in the scene light.
      const skid = skidPixel(priv, 0.5);
      for (let c = 0; c < 3; c++) expect(skid.c[c], `${tag}: skid channel ${c}`).toBeCloseTo(0.04 * light.toArray()[c]!, 9);
      expect(skid.c[3]).toBeCloseTo(0.5, 9);
    }
  });

  describe('in a rendered frame', () => {
    let W: StaticWorld;
    let R: GameRenderer;

    beforeAll(() => {
      W = world();
      R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
    });

    /** Drawn colours of a fresh puff of tyre smoke, a fresh spark and a skid mark at a time of day, by their shaders. */
    function drawn(sim: Sim, hours: number): { smoke: THREE.Color; spark: THREE.Color; skid: THREE.Color } {
      R.attach(sim); // a clean slate: the puff and the spark are the first particles of their layers
      R.cameraCtl.mode = 'play';
      R.cameraCtl.reset(sim);
      sim.clock.set(hours);
      sim.clock.rate = 0;
      const p = sim.playerPos();
      R.effects.tireSmoke(p.x + 3, p.y, p.z + 3);
      R.effects.sparks(p.x + 3, p.y + 0.5, p.z + 3, 1);
      R.render(DT, false);
      const fx = R.effects as unknown as FxPriv;
      const first = (layer: Layer) => {
        const c = layer.mesh.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute;
        return vecOfColor(spritePixel(layer, [c.getX(0), c.getY(0), c.getZ(0), c.getW(0)]));
      };
      return { smoke: first(fx.smoke), spark: first(fx.glow), skid: vecOfColor(skidPixel(fx, 0.5)) };
    }

    it('smoke and skid marks dim and turn blue at night and orange at dusk; sparks do not', () => {
      const sim = makeSim({ world: W });
      const noon = drawn(sim, 12);
      const night = drawn(sim, 22);
      const dusk = drawn(sim, 18.6);
      expect(noon.smoke.r).toBeGreaterThan(0.8);
      expect(lum(night.smoke), `night ${night.smoke.toArray()} vs noon ${noon.smoke.toArray()}`).toBeLessThan(0.3 * lum(noon.smoke));
      expect(lum(night.smoke)).toBeGreaterThan(0.1 * lum(noon.smoke));
      expect(night.smoke.b, 'moonlit blue').toBeGreaterThan(night.smoke.r);
      expect(dusk.smoke.r, 'sunset orange').toBeGreaterThan(dusk.smoke.b * 1.5);
      expect(lum(night.skid)).toBeLessThan(0.3 * lum(noon.skid));
      expect(Math.abs(night.spark.r / noon.spark.r - 1)).toBeLessThan(0.05);
      expect(Math.abs(night.spark.g / noon.spark.g - 1)).toBeLessThan(0.05);
    });
  });
});

// ---------------------------------------------------------------------------
// Cars wading through the surf throw spray and leave a wake

describe('wading spray and wake', () => {
  let W: StaticWorld;
  let R: GameRenderer;

  beforeAll(() => {
    W = world();
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
  });

  /** Where along the beach, north of Azura Pier, the sea is `depth` m deep. */
  function beachSpot(depth: number): { x: number; z: number } {
    const pier = W.layout.decks.find((d) => d.name === 'Azura Pier')!;
    const z = pier.rect.minZ - 20;
    let x = W.layout.bounds.beachStartX;
    while (WATER_Y - W.groundHeight(x, z) < depth) x += 0.02;
    return { x, z };
  }

  /**
   * A sports car driven north along the beach from where the sea is `depth` m deep, for `seconds` at full throttle
   * (none with `still`), rendered every frame; the smoke and glow layers as they are at the end.
   */
  function drive(depth: number, seconds: number, still = false): { v: Vehicle; smoke: THREE.Vector3[]; glow: number } {
    const sim = makeSim({ world: W });
    sim.clock.set(12);
    sim.clock.rate = 0;
    const at = beachSpot(depth);
    const v = sim.spawnVehicle('sports', at.x, at.z, Math.PI);
    placeInCar(sim, v);
    R.attach(sim);
    R.cameraCtl.mode = 'play';
    R.cameraCtl.reset(sim);
    const inp = input({ throttle: still ? 0 : 1 });
    for (let t = 0; t < seconds; t += DT) {
      sim.update(DT, inp);
      R.render(DT, false);
    }
    const fx = R.effects as unknown as FxPriv;
    const pos = fx.smoke.mesh.geometry.getAttribute('iPos') as THREE.InstancedBufferAttribute;
    const smoke = Array.from({ length: fx.smoke.active }, (_, i) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    return { v, smoke, glow: fx.glow.active };
  }

  it('a car driving through 0.1-0.8 m of the sea throws spray off its wheels and leaves a wake behind it, on the lit layer', () => {
    for (const depth of [0.2, 0.45, 0.7]) {
      const { v, smoke, glow } = drive(depth, 2);
      const tag = `${depth} m deep`;
      expect(v.inWater, tag).toBe(false);
      expect(WATER_Y - v.pos.y, tag).toBeCloseTo(depth, 1);
      expect(v.speed, tag).toBeGreaterThan(6);
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      let spray = 0;
      let wake = 0;
      for (const p of smoke) {
        const dx = p.x - v.pos.x;
        const dz = p.z - v.pos.z;
        const along = dx * fx + dz * fz;
        const across = dx * fz - dz * fx;
        // Beside the car and trailing it: nothing thrown out ahead of its nose or far to the side.
        expect(along, tag).toBeLessThan(v.halfL + 0.5);
        expect(along, tag).toBeGreaterThan(-40);
        expect(Math.abs(across), tag).toBeLessThan(5);
        if (p.y > WATER_Y + 0.12) spray++;
        else if (Math.abs(p.y - WATER_Y - 0.06) < 0.02 && along < -v.halfL) wake++;
      }
      expect(spray, `${tag}: spray in the air`).toBeGreaterThan(8);
      expect(wake, `${tag}: foam on the water behind the car`).toBeGreaterThan(4);
      // Smoke-layer particles, which take the scene's light (see above); none on the self-lit glow layer.
      expect(glow, tag).toBe(0);
    }
  });

  it('none on wet sand under less than 0.1 m of water, none standing still in the surf, none on dry land', () => {
    expect(drive(0.05, 2).smoke.length, 'under 0.05 m of water').toBe(0);
    expect(drive(0.45, 2, true).smoke.length, 'standing in 0.45 m of water').toBe(0);
    expect(drive(-0.3, 2).smoke.length, 'on the dry beach').toBe(0);
  });

  it('as much spray at 30 frames a second as at 120, more the deeper and the faster, and none while paused', () => {
    const sim = makeSim({ world: W });
    const v = sim.spawnVehicle('sedan', 0, 0, Math.PI);
    /** Particles Effects.wade makes over one second at `fps`, the car moving at `speed` through `depth` m. */
    const emitted = (fps: number, depth: number, speed: number) => {
      v.vel.x = 0;
      v.vel.z = -speed;
      const fx = new Effects();
      for (let i = 0; i < fps; i++) fx.wade(v, WATER_Y, depth, 1 / fps);
      // A frame of no time ages nothing: every particle made is still there.
      fx.update(0, 0);
      return (fx as unknown as FxPriv).smoke.active;
    };
    const at30 = emitted(30, 0.45, 12);
    const at120 = emitted(120, 0.45, 12);
    expect(at30).toBeGreaterThan(50);
    expect(Math.abs(at30 - at120) / at120, `${at30} at 30 fps, ${at120} at 120 fps`).toBeLessThan(0.15);
    expect(emitted(60, 0.75, 12)).toBeGreaterThan(emitted(60, 0.15, 12) * 1.8);
    expect(emitted(60, 0.45, 14)).toBeGreaterThan(emitted(60, 0.45, 4) * 2);
    expect(emitted(60, 0.45, 1)).toBe(0);
    const fx = new Effects();
    fx.wade(v, WATER_Y, 0.45, 0);
    fx.update(0, 0);
    expect((fx as unknown as FxPriv).smoke.active, 'paused').toBe(0);
  });

  it('the wake is left off the end the car leaves behind: its back driving forwards, its nose reversing, at any heading', () => {
    const sim = makeSim({ world: W });
    for (const heading of [0, 1.1, Math.PI, -2.4]) {
      const v = sim.spawnVehicle('sedan', 10, 20, heading);
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      for (const dir of [1, -1]) {
        const tag = `heading ${heading}, ${dir > 0 ? 'forwards' : 'reversing'}`;
        v.vel.x = fx * 8 * dir;
        v.vel.z = fz * 8 * dir;
        const effects = new Effects();
        for (let i = 0; i < 60; i++) effects.wade(v, WATER_Y, 0.45, 1 / 60);
        // Nothing has moved yet: each particle is where it was made.
        effects.update(0, 0);
        const layer = (effects as unknown as FxPriv).smoke;
        const pos = layer.mesh.geometry.getAttribute('iPos') as THREE.InstancedBufferAttribute;
        let wake = 0;
        let spray = 0;
        for (let i = 0; i < layer.active; i++) {
          const along = (pos.getX(i) - v.pos.x) * fx + (pos.getZ(i) - v.pos.z) * fz;
          const across = (pos.getX(i) - v.pos.x) * fz - (pos.getZ(i) - v.pos.z) * fx;
          // The foam starts 0.06 m over the surface, the spray 0.05 m.
          if (Math.abs(pos.getY(i) - WATER_Y - 0.06) < 1e-4) {
            expect(along * dir, tag).toBeLessThan(-v.halfL);
            wake++;
          } else {
            // At a wheel (0.62 of the half-length along, 0.18 m inside the body's side), give or take a few centimetres.
            expect(Math.abs(Math.abs(along) - v.halfL * 0.62), tag).toBeLessThan(0.4);
            expect(Math.abs(Math.abs(across) - (v.halfW - 0.18)), tag).toBeLessThan(0.25);
            spray++;
          }
        }
        expect(wake, tag).toBeGreaterThan(5);
        expect(spray, tag).toBeGreaterThan(20);
      }
    }
  });
});
