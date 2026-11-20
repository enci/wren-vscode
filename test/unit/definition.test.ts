import { describe, it, expect } from "vitest";
import { Lexer, Parser, SourceFile } from "../../wren-analyzer/src/index";
import { findDefinition, importStatements } from "../../src/language/definition";
import type { ModuleGraph } from "../../src/language/definition";

/**
 * Resolve go-to-definition for the `$` cursor marker in `main.wren`.
 * Other files are imported by name: `import "util"` → `util.wren`.
 * Returns the target file and the source line of the target token (trimmed),
 * with the target token wrapped in «».
 */
function def(files: Record<string, string>): string | null {
    const sources: Record<string, string> = {};
    let offset = -1;
    for (const [name, text] of Object.entries(files)) {
        const i = text.indexOf("$");
        if (name === "main.wren") {
            if (i < 0) throw new Error("no cursor marker");
            offset = i;
            sources[name] = text.slice(0, i) + text.slice(i + 1);
        } else {
            sources[name] = text;
        }
    }

    const graph: ModuleGraph = new Map();
    for (const [name, text] of Object.entries(sources)) {
        const module = new Parser(new Lexer(new SourceFile(name, text))).parseModule();
        const imports = importStatements(module).map(imp => ({
            moduleName: imp.moduleName,
            variables: imp.variables,
            resolvedPath: sources[`${imp.moduleName}.wren`] !== undefined ? `${imp.moduleName}.wren` : null,
        }));
        graph.set(name, { file: name, module, imports });
    }

    const r = findDefinition(graph, "main.wren", offset);
    if (!r) return null;
    if (r.isFile) return `${r.file} (file)`;
    const text = sources[r.file]!;
    const lineStart = text.lastIndexOf("\n", r.start - 1) + 1;
    let lineEnd = text.indexOf("\n", r.start);
    if (lineEnd < 0) lineEnd = text.length;
    const marked = text.slice(lineStart, r.start) + "«" + text.slice(r.start, r.start + r.length) + "»"
        + text.slice(r.start + r.length, lineEnd);
    return `${r.file}: ${marked.trim()}`;
}

const main = (src: string) => def({ "main.wren": src });

describe("go-to-definition: basics", () => {
    it("finds a local variable", () => {
        expect(main(`
var count = 1
System.print(co$unt)
`)).toBe("main.wren: var «count» = 1");
    });

    it("finds a class", () => {
        expect(main(`
class Foo {}
var f = Fo$o.new()
`)).toBe("main.wren: class «Foo» {}");
    });

    it("finds a static method and a constructor", () => {
        const src = `
class Foo {
  construct new() {}
  static make() { Foo.new() }
}
`;
        expect(main(src + "Foo.ma$ke()\n")).toBe("main.wren: static «make»() { Foo.new() }");
        expect(main(src + "Foo.ne$w()\n")).toBe("main.wren: construct «new»() {}");
    });

    it("navigates to an import path and imported class", () => {
        const files = {
            "util.wren": "class Helper {\n  static run() {}\n}\n",
            "main.wren": `import "ut$il" for Helper\n`,
        };
        expect(def(files)).toBe("util.wren (file)");
        expect(def({ ...files, "main.wren": `import "util" for Helper\nHel$per.run()\n` }))
            .toBe("util.wren: class «Helper» {");
        expect(def({ ...files, "main.wren": `import "util" for Helper\nHelper.r$un()\n` }))
            .toBe("util.wren: static «run»() {}");
    });

    it("finds a class from a type annotation", () => {
        expect(main(`
class Vec2 {}
var p: Ve$c2 = null
`)).toBe("main.wren: class «Vec2» {}");
    });
});

describe("go-to-definition: previously broken cases", () => {
    it("1. resolves chained calls through annotated return types", () => {
        expect(main(`
class B { name -> String { "b" } }
class A {
  construct new() {}
  b -> B { B.new() }
}
var a = A.new()
a.b.na$me
`)).toBe("main.wren: class B { «name» -> String { \"b\" } }");
    });

    it("1. resolves calls on fields", () => {
        expect(main(`
class Vec2 {
  construct new() {}
  length { 0 }
}
class Body {
  construct new() { _pos = Vec2.new() }
  size { _pos.len$gth }
}
`)).toBe("main.wren: «length» { 0 }");
    });

    it("1. resolves calls on fields typed by constructor parameters", () => {
        expect(main(`
class Vec2 { length { 0 } }
class Body {
  construct new(p: Vec2) { _pos = p }
  size { _pos.len$gth }
}
`)).toBe("main.wren: class Vec2 { «length» { 0 } }");
    });

    it("1. resolves calls on the result of a call", () => {
        expect(main(`
class Item { price { 1 } }
class Shop {
  static first() -> Item { null }
}
Shop.first().pri$ce
`)).toBe("main.wren: class Item { «price» { 1 } }");
    });

    it("2. finds inherited methods, including across files", () => {
        const files = {
            "base.wren": "class Animal {\n  speak() {}\n}\n",
            "main.wren": `
import "base" for Animal
class Dog is Animal { construct new() {} }
var d = Dog.new()
d.spe$ak()
`,
        };
        expect(def(files)).toBe("base.wren: «speak»() {}");
    });

    it("3. resolves implicit this calls", () => {
        expect(main(`
class Game {
  update() { dr$aw() }
  draw() {}
}
`)).toBe("main.wren: «draw»() {}");
    });

    it("3. resolves implicit this calls to inherited methods", () => {
        expect(main(`
class Base { helper() {} }
class Game is Base {
  update() { hel$per() }
}
`)).toBe("main.wren: class Base { «helper»() {} }");
    });

    it("4. respects arity overloads", () => {
        const src = `
class Vec2 {
  construct new() {}
  construct new(x, y) {}
}
`;
        expect(main(src + "Vec2.ne$w(1, 2)\n")).toBe("main.wren: construct «new»(x, y) {}");
        expect(main(src + "Vec2.ne$w()\n")).toBe("main.wren: construct «new»() {}");
    });

    it("4. distinguishes getters and setters", () => {
        const src = `
class P {
  construct new() {}
  x { _x }
  x=(v) { _x = v }
}
var p = P.new()
`;
        expect(main(src + "p.$x = 3\n")).toBe("main.wren: «x»=(v) { _x = v }");
        expect(main(src + "System.print(p.$x)\n")).toBe("main.wren: «x» { _x }");
    });

    it("5. parameters resolve within their own method", () => {
        expect(main(`
class A {
  first(x) { x }
  second(x) { $x }
}
`)).toBe("main.wren: second(«x») { x }");
    });

    it("6. respects shadowing", () => {
        expect(main(`
var value = 1
{
  var value = 2
  System.print(val$ue)
}
`)).toBe("main.wren: var «value» = 2");
    });

    it("6. does not see inner variables from outside their block", () => {
        expect(main(`
var value = 1
{
  var value = 2
}
System.print(val$ue)
`)).toBe("main.wren: var «value» = 1");
    });

    it("6. finds variables and parameters inside closures", () => {
        expect(main(`
var f = Fn.new {|item|
  var doubled = item * 2
  System.print(doub$led)
}
`)).toBe("main.wren: var «doubled» = item * 2");
        expect(main(`
var list = [1, 2]
list.each {|item| System.print(it$em) }
`)).toBe("main.wren: list.each {|«item»| System.print(item) }");
    });

    it("7. finds capitalized module variables", () => {
        expect(main(`
var Config = {}
class Game {
  static start() { Con$fig }
}
`)).toBe("main.wren: var «Config» = {}");
    });

    it("8. finds fields first assigned inside nested expressions", () => {
        expect(main(`
class A {
  construct new() {
    if (true) {
      System.print(_cache = {})
    }
  }
  get { _cac$he }
}
`)).toBe("main.wren: System.print(«_cache» = {})");
    });

    it("8. prefers the constructor assignment for fields", () => {
        expect(main(`
class A {
  reset() { _n = 0 }
  construct new() { _n = 1 }
  n { _$n }
}
`)).toBe("main.wren: construct new() { «_n» = 1 }");
    });

    it("resolves super calls", () => {
        expect(main(`
class Base {
  construct new() {}
  update() {}
}
class Child is Base {
  construct new() { super() }
  update() { super.upd$ate() }
}
`)).toBe("main.wren: «update»() {}");
    });

    it("resolves user-defined operators", () => {
        expect(main(`
class V {
  construct new() {}
  +(other: V) -> V { this }
}
var a = V.new()
var b = a $+ a
`)).toBe("main.wren: «+»(other: V) -> V { this }");
    });
});

describe("go-to-definition: language limits (no result expected)", () => {
    it("returns nothing for an unknown receiver type", () => {
        expect(main(`
class A { foo() {} }
var make = Fn.new { A.new() }
var x = make.call()
x.fo$o()
`)).toBeNull();
    });

    it("returns nothing for core library methods", () => {
        expect(main(`System.pr$int("hi")\n`)).toBeNull();
    });
});
