/**
 * Go-to-definition, resolved on the analyzer AST.
 *
 * The whole module is walked in source order while keeping a lexical scope
 * stack, so when the walk reaches the token under the cursor the set of
 * visible names is exactly what Wren itself would see. This gives correct
 * shadowing, closure parameters, implicit `this` calls, and lets receiver
 * types be inferred for chains like `a.b.c` or `_field.method()`.
 *
 * This file has no dependency on the `vscode` API: imported modules are
 * supplied up front through a `ModuleGraph`, and results are plain offsets.
 */
import type {
    Module, Stmt, Expr, Method, Body, ClassStmt, Token, Parameter, CallExpr,
} from '../../wren-analyzer/src/index';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DefinitionTarget {
    /** File path of the target; equals the requesting file for local hits. */
    file: string;
    start: number;
    length: number;
    /** Set when the target is a whole file (import path). */
    isFile?: boolean;
}

export interface ModuleImport {
    moduleName: string;
    /** Resolved file path, or null when unresolved / built-in. */
    resolvedPath: string | null;
    /** `for X, Y` list, or null to import everything. */
    variables: string[] | null;
}

export interface LoadedModule {
    file: string;
    module: Module;
    imports: ModuleImport[];
}

/** All modules reachable from the requesting file, keyed by file path. */
export type ModuleGraph = Map<string, LoadedModule>;

export function findDefinition(
    graph: ModuleGraph,
    file: string,
    offset: number,
): DefinitionTarget | null {
    const root = graph.get(file);
    if (!root) return null;
    const finder = new DefinitionFinder(graph, root, offset);
    try {
        finder.run();
    } catch (e) {
        if (!(e instanceof Found)) throw e;
    }
    return finder.result;
}

/** Collect the names imported by `import` statements in a module (for graph building). */
export function importStatements(module: Module): { moduleName: string; variables: string[] | null; token: Token }[] {
    const out: { moduleName: string; variables: string[] | null; token: Token }[] = [];
    for (const stmt of module.statements) {
        if (stmt.kind === 'ImportStmt') {
            out.push({
                moduleName: unquote(stmt.path.text),
                variables: stmt.variables ? stmt.variables.map(v => v.text) : null,
                token: stmt.path,
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class Found {}

/** A statically known type: an instance of a class, or the class object itself. */
interface TypeRef {
    className: string;
    isStatic: boolean;
}

interface Local {
    token: Token;
    type: TypeRef | null;
}

interface ClassCtx {
    cls: ClassStmt;
    mod: LoadedModule;
    method: Method | null;
}

interface ResolvedClass {
    cls: ClassStmt;
    mod: LoadedModule;
}

const ANY_ARITY = Number.NaN;

function unquote(s: string): string {
    return s.replace(/^"/, '').replace(/"$/, '');
}

function isUpper(name: string): boolean {
    return /^[A-Z]/.test(name);
}

function contains(token: Token | null | undefined, offset: number): boolean {
    return !!token && offset >= token.start && offset <= token.start + token.length;
}

function callArity(call: { arguments: Expr[] | null; blockArgument: Body | null }): number {
    if (call.arguments === null) return call.blockArgument === null ? -1 : 1;
    return call.arguments.length + (call.blockArgument === null ? 0 : 1);
}

function methodArity(m: Method): number {
    return m.parameters === null ? -1 : m.parameters.length;
}

function isStaticMethod(m: Method): boolean {
    return m.staticKeyword !== null || m.constructKeyword !== null;
}

function literalType(expr: Expr): string | null {
    switch (expr.kind) {
        case 'NumExpr': return 'Num';
        case 'StringExpr':
        case 'InterpolationExpr': return 'String';
        case 'BoolExpr': return 'Bool';
        case 'ListExpr': return 'List';
        case 'MapExpr': return 'Map';
        default: return null;
    }
}

class DefinitionFinder {
    result: DefinitionTarget | null = null;
    private scopes: Map<string, Local>[] = [];
    private classCtx: ClassCtx | null = null;
    /** Field types per class (keyed by class name token start + file). */
    private fieldTypeCache = new Map<ClassStmt, Map<string, TypeRef>>();

    constructor(
        private readonly graph: ModuleGraph,
        private readonly root: LoadedModule,
        private readonly offset: number,
    ) {}

    run(): void {
        this.scopes = [new Map()];
        for (const stmt of this.root.module.statements) {
            this.visitStmt(stmt);
        }
    }

    // --- result helpers ---------------------------------------------------

    private hit(token: Token, file: string = this.root.file): never {
        this.result = { file, start: token.start, length: token.length };
        throw new Found();
    }

    private hitFile(file: string): never {
        this.result = { file, start: 0, length: 0, isFile: true };
        throw new Found();
    }

    private miss(): never {
        this.result = null;
        throw new Found();
    }

    // --- scopes -----------------------------------------------------------

    private push(): void { this.scopes.push(new Map()); }
    private pop(): void { this.scopes.pop(); }

    private declare(token: Token, type: TypeRef | null): void {
        this.scopes[this.scopes.length - 1]!.set(token.text, { token, type });
    }

    private declareParams(params: Parameter[] | null): void {
        if (!params) return;
        for (const p of params) {
            this.declare(p.name, p.typeAnnotation ? { className: p.typeAnnotation.name.text, isStatic: false } : null);
        }
    }

    private lookupLocal(name: string): Local | null {
        // scopes[0] is the module scope; it is handled by lookupModuleVar.
        for (let i = this.scopes.length - 1; i >= 1; i--) {
            const v = this.scopes[i]!.get(name);
            if (v) return v;
        }
        return null;
    }

    // --- module-level names ----------------------------------------------

    /**
     * Find a module-level variable or class named `name` in `mod`, following
     * imports. Returns the declaring token and its module.
     */
    private findModuleVar(
        mod: LoadedModule,
        name: string,
        visited = new Set<string>(),
    ): { token: Token; mod: LoadedModule; cls: ClassStmt | null; varType: TypeRef | null } | null {
        if (visited.has(mod.file)) return null;
        visited.add(mod.file);

        for (const stmt of mod.module.statements) {
            if (stmt.kind === 'ClassStmt' && stmt.name.text === name) {
                return { token: stmt.name, mod, cls: stmt, varType: null };
            }
            if (stmt.kind === 'VarStmt' && stmt.name.text === name) {
                return { token: stmt.name, mod, cls: null, varType: this.varStmtType(stmt.typeAnnotation, stmt.initializer) };
            }
        }
        for (const imp of mod.imports) {
            if (imp.variables !== null && !imp.variables.includes(name)) continue;
            if (!imp.resolvedPath) continue;
            const target = this.graph.get(imp.resolvedPath);
            if (!target) continue;
            const r = this.findModuleVar(target, name, visited);
            if (r) return r;
        }
        return null;
    }

    private findClass(mod: LoadedModule, name: string): ResolvedClass | null {
        const r = this.findModuleVar(mod, name);
        return r && r.cls ? { cls: r.cls, mod: r.mod } : null;
    }

    private superclassOf(rc: ResolvedClass): ResolvedClass | null {
        if (!rc.cls.superclass) return null;
        return this.findClass(rc.mod, rc.cls.superclass.text);
    }

    /**
     * Find a method by name, static-ness and arity, walking the superclass
     * chain for instance methods. Falls back to any arity if no exact match.
     */
    private findMethod(
        start: ResolvedClass,
        name: string,
        isStatic: boolean,
        arity: number,
        preferSetter = false,
    ): { method: Method; owner: ResolvedClass } | null {
        const tryMatch = (exactArity: boolean) => {
            let rc: ResolvedClass | null = start;
            const seen = new Set<ClassStmt>();
            while (rc && !seen.has(rc.cls)) {
                seen.add(rc.cls);
                const candidates = rc.cls.methods.filter(m =>
                    m.name.text === name && isStaticMethod(m) === isStatic);
                const pick = (preferSetter ? candidates.find(m => m.isSetter) : undefined)
                    ?? candidates.find(m => !exactArity || Number.isNaN(arity) || methodArity(m) === arity);
                if (pick) return { method: pick, owner: rc };
                // Static methods are not inherited in Wren.
                if (isStatic) return null;
                rc = this.superclassOf(rc);
            }
            return null;
        };
        return tryMatch(true) ?? tryMatch(false);
    }

    // --- type inference ---------------------------------------------------

    private varStmtType(annotation: { name: Token } | null, init: Expr | null): TypeRef | null {
        if (annotation) return { className: annotation.name.text, isStatic: false };
        if (init) {
            try { return this.typeOf(init); } catch (e) { if (e instanceof Found) return null; throw e; }
        }
        return null;
    }

    /** Infer the static type of an expression, without ever reporting a hit. */
    private typeOf(expr: Expr, depth = 0): TypeRef | null {
        if (depth > 12) return null;
        const lit = literalType(expr);
        if (lit) return { className: lit, isStatic: false };

        switch (expr.kind) {
            case 'GroupingExpr':
                return this.typeOf(expr.expression, depth + 1);
            case 'ThisExpr':
                if (!this.classCtx) return null;
                return {
                    className: this.classCtx.cls.name.text,
                    isStatic: !!this.classCtx.method && this.classCtx.method.staticKeyword !== null,
                };
            case 'FieldExpr':
            case 'StaticFieldExpr':
                if (!this.classCtx) return null;
                return this.fieldTypes(this.classCtx.cls, this.classCtx.mod).get(expr.name.text) ?? null;
            case 'CallExpr':
                return this.callType(expr, depth);
            case 'InfixExpr': {
                const left = this.typeOf(expr.left, depth + 1);
                return left ? this.returnTypeOf(left, expr.operator.text, 1, depth) : null;
            }
            case 'PrefixExpr': {
                const right = this.typeOf(expr.right, depth + 1);
                return right ? this.returnTypeOf(right, expr.operator.text, -1, depth) : null;
            }
            case 'ConditionalExpr': {
                const a = this.typeOf(expr.thenBranch, depth + 1);
                const b = this.typeOf(expr.elseBranch, depth + 1);
                return a && b && a.className === b.className && a.isStatic === b.isStatic ? a : null;
            }
            default:
                return null;
        }
    }

    private callType(call: CallExpr, depth: number): TypeRef | null {
        const name = call.name.text;
        const arity = callArity(call);
        if (call.receiver === null) {
            if (call.arguments === null && call.blockArgument === null) {
                const local = this.lookupLocal(name);
                if (local) return local.type;
            }
            if (this.classCtx && !isUpper(name)) {
                // Implicit `this.name`
                const self = this.typeOf({ kind: 'ThisExpr', keyword: call.name }, depth + 1);
                return self ? this.returnTypeOf(self, name, arity, depth) : null;
            }
            const mv = this.findModuleVar(this.currentModule(), name);
            if (!mv) return null;
            if (mv.cls) return { className: mv.cls.name.text, isStatic: true };
            return mv.varType;
        }
        const recv = this.typeOf(call.receiver, depth + 1);
        if (!recv) return null;
        return this.returnTypeOf(recv, name, arity, depth);
    }

    private returnTypeOf(recv: TypeRef, name: string, arity: number, _depth: number): TypeRef | null {
        const rc = this.findClass(this.currentModule(), recv.className)
            ?? this.findClass(this.root, recv.className);
        if (!rc) return null;
        const found = this.findMethod(rc, name, recv.isStatic, arity);
        if (!found) return null;
        if (found.method.constructKeyword) return { className: rc.cls.name.text, isStatic: false };
        if (found.method.returnType) return { className: found.method.returnType.name.text, isStatic: false };
        return null;
    }

    private currentModule(): LoadedModule {
        return this.classCtx?.mod ?? this.root;
    }

    /**
     * Field types for a class, inferred from assignments (`_pos = Vec2.new()`,
     * `_pos = pos` with `pos: Vec2`) and getters (`pos -> Vec2 { _pos }`).
     */
    private fieldTypes(cls: ClassStmt, mod: LoadedModule): Map<string, TypeRef> {
        const cached = this.fieldTypeCache.get(cls);
        if (cached) return cached;
        const types = new Map<string, TypeRef>();
        this.fieldTypeCache.set(cls, types); // guards against recursion

        for (const m of cls.methods) {
            if (!m.body) continue;
            const params = new Map<string, TypeRef>();
            for (const p of m.parameters ?? []) {
                if (p.typeAnnotation) params.set(p.name.text, { className: p.typeAnnotation.name.text, isStatic: false });
            }
            // Getter returning a field directly
            const e = m.body.expression;
            if (e && (e.kind === 'FieldExpr' || e.kind === 'StaticFieldExpr') && m.returnType && !types.has(e.name.text)) {
                types.set(e.name.text, { className: m.returnType.name.text, isStatic: false });
            }
            walkExprs(m.body, (x) => {
                if (x.kind !== 'AssignmentExpr') return;
                const t = x.target;
                if (t.kind !== 'FieldExpr' && t.kind !== 'StaticFieldExpr') return;
                if (types.has(t.name.text)) return;
                const v = x.value;
                let vt: TypeRef | null = null;
                if (v.kind === 'CallExpr' && v.receiver === null && v.arguments === null && params.has(v.name.text)) {
                    vt = params.get(v.name.text)!;
                } else {
                    const lit = literalType(v);
                    if (lit) vt = { className: lit, isStatic: false };
                    else if (v.kind === 'CallExpr' && v.name.text === 'new' && v.receiver
                        && v.receiver.kind === 'CallExpr' && v.receiver.receiver === null && isUpper(v.receiver.name.text)) {
                        const rc = this.findClass(mod, v.receiver.name.text);
                        if (rc) vt = { className: rc.cls.name.text, isStatic: false };
                    }
                }
                if (vt) types.set(t.name.text, vt);
            });
        }
        return types;
    }

    // --- resolution of the token under the cursor -------------------------

    private resolveClassName(token: Token, mod: LoadedModule = this.currentModule()): never {
        const r = this.findModuleVar(mod, token.text);
        if (r) this.hit(r.token, r.mod.file);
        this.miss();
    }

    private resolveMethod(recv: TypeRef | null, name: string, arity: number, preferSetter: boolean): never {
        if (!recv) this.miss();
        const rc = this.findClass(this.currentModule(), recv.className) ?? this.findClass(this.root, recv.className);
        if (!rc) this.miss();
        const found = this.findMethod(rc, name, recv.isStatic, arity, preferSetter);
        if (found) this.hit(found.method.name, found.owner.mod.file);
        this.miss();
    }

    private resolveField(name: string): never {
        if (!this.classCtx) this.miss();
        const { cls, mod } = this.classCtx;
        // Prefer the first assignment (constructors first), else first use.
        const ordered = [
            ...cls.methods.filter(m => m.constructKeyword),
            ...cls.methods.filter(m => !m.constructKeyword),
        ];
        let firstUse: Token | null = null;
        for (const m of ordered) {
            if (!m.body) continue;
            let assigned: Token | null = null;
            walkExprs(m.body, (x) => {
                if (assigned) return;
                if (x.kind === 'AssignmentExpr'
                    && (x.target.kind === 'FieldExpr' || x.target.kind === 'StaticFieldExpr')
                    && x.target.name.text === name) {
                    assigned = x.target.name;
                }
                if ((x.kind === 'FieldExpr' || x.kind === 'StaticFieldExpr') && x.name.text === name && !firstUse) {
                    firstUse = x.name;
                }
            });
            if (assigned) this.hit(assigned, mod.file);
        }
        if (firstUse) this.hit(firstUse, mod.file);
        this.miss();
    }

    /** Bare identifier `name` (receiver-less call) under the cursor. */
    private resolveBareName(call: CallExpr): never {
        const name = call.name.text;
        const arity = callArity(call);
        if (call.arguments === null && call.blockArgument === null) {
            const local = this.lookupLocal(name);
            if (local) this.hit(local.token);
        }
        // Inside a class, lowercase non-local names are implicit `this` calls.
        if (this.classCtx && !isUpper(name)) {
            const self = this.typeOf({ kind: 'ThisExpr', keyword: call.name });
            this.resolveMethod(self, name, arity, false);
        }
        if (!this.classCtx && call.arguments === null) {
            // Top-level code: module variables declared earlier, or classes.
            const v = this.scopes[0]!.get(name);
            if (v) this.hit(v.token);
        }
        this.resolveClassName(call.name);
    }

    // --- traversal ---------------------------------------------------------

    private visitStmt(stmt: Stmt): void {
        switch (stmt.kind) {
            case 'VarStmt': {
                if (contains(stmt.name, this.offset)) this.hit(stmt.name);
                if (stmt.typeAnnotation && contains(stmt.typeAnnotation.name, this.offset)) {
                    this.resolveClassName(stmt.typeAnnotation.name);
                }
                if (stmt.initializer) this.visitExpr(stmt.initializer);
                this.declare(stmt.name, this.varStmtType(stmt.typeAnnotation, stmt.initializer));
                return;
            }
            case 'ClassStmt':
                this.visitClass(stmt);
                return;
            case 'ImportStmt': {
                if (contains(stmt.path, this.offset)) {
                    const imp = this.root.imports.find(i => i.moduleName === unquote(stmt.path.text));
                    if (imp?.resolvedPath) this.hitFile(imp.resolvedPath);
                    this.miss();
                }
                for (const v of stmt.variables ?? []) {
                    if (contains(v, this.offset)) {
                        const imp = this.root.imports.find(i => i.moduleName === unquote(stmt.path.text));
                        const target = imp?.resolvedPath ? this.graph.get(imp.resolvedPath) : undefined;
                        const r = target ? this.findModuleVar(target, v.text) : null;
                        if (r) this.hit(r.token, r.mod.file);
                        this.miss();
                    }
                    // Not declared in scope: uses resolve through the import
                    // (findModuleVar) straight to the real definition.
                }
                return;
            }
            case 'IfStmt':
                this.visitExpr(stmt.condition);
                this.visitScoped(stmt.thenBranch);
                if (stmt.elseBranch) this.visitScoped(stmt.elseBranch);
                return;
            case 'WhileStmt':
                this.visitExpr(stmt.condition);
                this.visitScoped(stmt.body);
                return;
            case 'ForStmt':
                if (contains(stmt.variable, this.offset)) this.hit(stmt.variable);
                if (stmt.typeAnnotation && contains(stmt.typeAnnotation.name, this.offset)) {
                    this.resolveClassName(stmt.typeAnnotation.name);
                }
                this.visitExpr(stmt.iterator);
                this.push();
                this.declare(stmt.variable, stmt.typeAnnotation
                    ? { className: stmt.typeAnnotation.name.text, isStatic: false } : null);
                this.visitScoped(stmt.body);
                this.pop();
                return;
            case 'ReturnStmt':
                if (stmt.value) this.visitExpr(stmt.value);
                return;
            case 'BlockStmt':
                this.push();
                for (const s of stmt.statements) this.visitStmt(s);
                this.pop();
                return;
            case 'BreakStmt':
            case 'ContinueStmt':
                return;
            default:
                this.visitExpr(stmt as Expr);
        }
    }

    private visitScoped(stmt: Stmt): void {
        this.push();
        this.visitStmt(stmt);
        this.pop();
    }

    private visitClass(cls: ClassStmt): void {
        if (contains(cls.name, this.offset)) this.hit(cls.name);
        if (cls.superclass && contains(cls.superclass, this.offset)) this.resolveClassName(cls.superclass);

        const outerCtx = this.classCtx;
        const outerScopes = this.scopes;
        for (const method of cls.methods) {
            // Methods only see module-level names, not enclosing locals.
            this.classCtx = { cls, mod: this.root, method };
            this.scopes = [outerScopes[0]!];
            this.visitMethod(method);
        }
        this.scopes = outerScopes;
        this.classCtx = outerCtx;
    }

    private visitMethod(m: Method): void {
        if (contains(m.name, this.offset)) this.hit(m.name);
        if (m.returnType && contains(m.returnType.name, this.offset)) this.resolveClassName(m.returnType.name);
        const params = [...(m.subscriptParameters ?? []), ...(m.parameters ?? [])];
        for (const p of params) {
            if (contains(p.name, this.offset)) this.hit(p.name);
            if (p.typeAnnotation && contains(p.typeAnnotation.name, this.offset)) {
                this.resolveClassName(p.typeAnnotation.name);
            }
        }
        this.push();
        this.declareParams(m.subscriptParameters);
        this.declareParams(m.parameters);
        if (m.body) this.visitBody(m.body, /* paramsAlreadyDeclared */ true);
        this.pop();
    }

    private visitBody(body: Body, paramsAlreadyDeclared = false): void {
        this.push();
        if (!paramsAlreadyDeclared) {
            for (const p of body.parameters ?? []) {
                if (contains(p.name, this.offset)) this.hit(p.name);
                if (p.typeAnnotation && contains(p.typeAnnotation.name, this.offset)) {
                    this.resolveClassName(p.typeAnnotation.name);
                }
            }
            this.declareParams(body.parameters);
        }
        if (body.expression) this.visitExpr(body.expression);
        for (const s of body.statements ?? []) this.visitStmt(s);
        this.pop();
    }

    private visitExpr(expr: Expr, assignTarget = false): void {
        switch (expr.kind) {
            case 'FieldExpr':
            case 'StaticFieldExpr':
                if (contains(expr.name, this.offset)) this.resolveField(expr.name.text);
                return;
            case 'ListExpr':
                for (const e of expr.elements) this.visitExpr(e);
                return;
            case 'MapExpr':
                for (const en of expr.entries) { this.visitExpr(en.key); this.visitExpr(en.value); }
                return;
            case 'InterpolationExpr':
                for (const e of expr.expressions) this.visitExpr(e);
                return;
            case 'GroupingExpr':
                this.visitExpr(expr.expression);
                return;
            case 'PrefixExpr':
                if (contains(expr.operator, this.offset)) {
                    this.resolveMethod(this.typeOf(expr.right), expr.operator.text, -1, false);
                }
                this.visitExpr(expr.right);
                return;
            case 'InfixExpr':
                this.visitExpr(expr.left);
                if (contains(expr.operator, this.offset)
                    && expr.operator.text !== '&&' && expr.operator.text !== '||') {
                    this.resolveMethod(this.typeOf(expr.left), expr.operator.text, 1, false);
                }
                this.visitExpr(expr.right);
                return;
            case 'CallExpr': {
                if (expr.receiver) this.visitExpr(expr.receiver);
                if (contains(expr.name, this.offset)) {
                    if (expr.receiver === null) this.resolveBareName(expr);
                    this.resolveMethod(this.typeOf(expr.receiver!), expr.name.text, callArity(expr), assignTarget);
                }
                for (const a of expr.arguments ?? []) this.visitExpr(a);
                if (expr.blockArgument) this.visitBody(expr.blockArgument);
                return;
            }
            case 'SubscriptExpr':
                this.visitExpr(expr.receiver);
                for (const a of expr.arguments) this.visitExpr(a);
                return;
            case 'AssignmentExpr':
                this.visitExpr(expr.target, true);
                this.visitExpr(expr.value);
                return;
            case 'ConditionalExpr':
                this.visitExpr(expr.condition);
                this.visitExpr(expr.thenBranch);
                this.visitExpr(expr.elseBranch);
                return;
            case 'SuperExpr': {
                const ctx = this.classCtx;
                if (ctx && ctx.method && (contains(expr.name, this.offset))) {
                    const sup = this.superclassOf({ cls: ctx.cls, mod: ctx.mod });
                    if (!sup) this.miss();
                    const name = expr.name ? expr.name.text : ctx.method.name.text;
                    const found = this.findMethod(sup, name, ctx.method.staticKeyword !== null, callArity(expr));
                    if (found) this.hit(found.method.name, found.owner.mod.file);
                    this.miss();
                }
                for (const a of expr.arguments ?? []) this.visitExpr(a);
                if (expr.blockArgument) this.visitBody(expr.blockArgument);
                return;
            }
            default:
                return;
        }
    }
}

/** Call `fn` on every expression nested in a body (statements and closures included). */
function walkExprs(body: Body, fn: (e: Expr) => void): void {
    const stmt = (s: Stmt): void => {
        switch (s.kind) {
            case 'VarStmt': if (s.initializer) expr(s.initializer); return;
            case 'ClassStmt':
            case 'ImportStmt':
            case 'BreakStmt':
            case 'ContinueStmt': return;
            case 'IfStmt': expr(s.condition); stmt(s.thenBranch); if (s.elseBranch) stmt(s.elseBranch); return;
            case 'WhileStmt': expr(s.condition); stmt(s.body); return;
            case 'ForStmt': expr(s.iterator); stmt(s.body); return;
            case 'ReturnStmt': if (s.value) expr(s.value); return;
            case 'BlockStmt': s.statements.forEach(stmt); return;
            default: expr(s as Expr);
        }
    };
    const bodyFn = (b: Body): void => {
        if (b.expression) expr(b.expression);
        (b.statements ?? []).forEach(stmt);
    };
    const expr = (e: Expr): void => {
        fn(e);
        switch (e.kind) {
            case 'ListExpr': e.elements.forEach(expr); return;
            case 'MapExpr': e.entries.forEach(en => { expr(en.key); expr(en.value); }); return;
            case 'InterpolationExpr': e.expressions.forEach(expr); return;
            case 'GroupingExpr': expr(e.expression); return;
            case 'PrefixExpr': expr(e.right); return;
            case 'InfixExpr': expr(e.left); expr(e.right); return;
            case 'CallExpr':
                if (e.receiver) expr(e.receiver);
                (e.arguments ?? []).forEach(expr);
                if (e.blockArgument) bodyFn(e.blockArgument);
                return;
            case 'SubscriptExpr': expr(e.receiver); e.arguments.forEach(expr); return;
            case 'AssignmentExpr': expr(e.target); expr(e.value); return;
            case 'ConditionalExpr': expr(e.condition); expr(e.thenBranch); expr(e.elseBranch); return;
            case 'SuperExpr':
                (e.arguments ?? []).forEach(expr);
                if (e.blockArgument) bodyFn(e.blockArgument);
                return;
            default: return;
        }
    };
    bodyFn(body);
}
