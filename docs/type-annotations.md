# Type Annotations Guide

The Wren analyzer supports optional type annotations on parameters, return types, and variables. These annotations enable better diagnostics (method existence checks, type mismatch warnings) and improved autocomplete through return type inference.

## Syntax

### Parameter types

Add `: TypeName` after a parameter name:

```wren
greet(name: String) {
  System.print("Hello, %(name)!")
}

static lerp(a: Num, b: Num, t: Num) -> Num { (a * (1.0 - t)) + (b * t) }
```

### Return types

Add `-> TypeName` after the parameter list (or method name for getters):

```wren
// Getter with return type
name -> String { _name }

// Method with return type
distance(other: Vec2) -> Num {
  return (this - other).magnitude
}

// Static method
static fromAngle(angle: Num) -> Vec2 {
  return Vec2.new(angle.cos, angle.sin)
}
```

### Variable types

Add `: TypeName` between the variable name and `=`:

```wren
var score: Num = 0
var name: String = "Player"
var alive: Bool = true
var items: List = []
var position: Vec2 = Vec2.new(100, 200)
```

### For loop variables

```wren
for (item: Num in scores) {
  total = total + item
}
```

### Block parameters

```wren
list.map {|x: Num| x * 2 }
```

### Constructor parameters

```wren
construct new(x: Num, y: Num) {
  _x = x
  _y = y
}
```

### Operators

Operators are methods, so the same syntax applies:

```wren
+(other: Vec2) -> Vec2 { Vec2.new(x + other.x, y + other.y) }
*(v: Num) -> Vec2 { Vec2.new(x * v, y * v) }
==(other: Vec2) -> Bool { x == other.x && y == other.y }
```

Prefix operators are getters:

```wren
- -> Vec2 { Vec2.new(-x, -y) }
```

### Setters

```wren
x=(v: Num) { _x = v }
```

### Subscript operators

```wren
[index: Num] -> Num { _data[index] }
[index: Num]=(value: Num) { _data[index] = value }
```

## What the analyzer does with annotations

### Method existence checking

When the analyzer knows a variable's type, it checks that methods you call on it actually exist:

```wren
var pos: Vec2 = Vec2.new(10, 20)
pos.magnitude    // OK - Vec2 has a magnitude getter
pos.foo()        // Warning: Type 'Vec2' does not define an instance method 'foo'
```

### Arity checking

The analyzer verifies you're calling methods with the right number of arguments:

```wren
var n: Num = 42
n.clamp(0, 100)  // OK - Num.clamp takes 2 args
n.clamp(0)       // Warning: defines 'clamp' but not as a method with 1 argument
```

### Return type inference

When a method has a return type annotation, the analyzer propagates it:

```wren
// Num.abs -> Num, so x is inferred as Num
var x = 42.abs
x.ceil         // OK - Num has ceil
x.foo()        // Warning: Num does not define 'foo'

// String.split -> List, so parts is inferred as List
var parts = "a,b,c".split(",")
parts.count    // OK - List has count
parts.foo()    // Warning: List does not define 'foo'

// Operators are also inferred
var sum = 1 + 2      // sum is Num (Num.+ -> Num)
var ok = 1 < 2       // ok is Bool (Num.< -> Bool)
var r = 1..10        // r is Range (Num... -> Range)
var s = "a" + "b"    // s is String (String.+ -> String)
```

### Variable assignment checking

Explicit annotations catch type mismatches on initialization and reassignment:

```wren
var x: Num = "hello"  // Warning: declared as Num but initialized with String
var y: Num = 42
y = "oops"            // Warning: declared as Num but assigned String
```

### Return value checking

Methods with return type annotations are checked for consistent returns:

```wren
distance(other: Vec2) -> Num {
  return "far"  // Warning: expects return type Num but returns String
}
```

## Available built-in types

These are always available without imports:

| Type       | Description                            |
|------------|----------------------------------------|
| `Num`      | Numbers (integers and floats)          |
| `String`   | Text strings                           |
| `Bool`     | `true` or `false`                      |
| `Null`     | The `null` value                       |
| `List`     | Ordered collections                    |
| `Map`      | Key-value hash maps                    |
| `Range`    | Numeric ranges (`1..10`, `0...n`)      |
| `Sequence` | Base class for all iterables           |
| `Fn`       | Function values / closures             |
| `Fiber`    | Coroutines                             |
| `Object`   | Root of the class hierarchy            |

And your own classes work as types too:

```wren
var pos: Vec2 = Vec2.new(10, 20)
var color: Color = Color.new(255, 0, 0)
var player: Entity = Entity.new()
```

## Annotating your own classes

Here's an example using `Vec2` from the xs engine, showing what the fully annotated version looks like:

### Before (no annotations)

```wren
class Vec2 {
    construct new() {
        _x = 0
        _y = 0
    }
    construct new(x, y) {
        _x = x
        _y = y
    }

    x { _x }
    y { _y }
    x=(v) { _x = v }
    y=(v) { _y = v }

    +(other) { Vec2.new(x + other.x, y + other.y) }
    -(other) { this + -other }
    *(v) { Vec2.new(x * v, y * v) }
    /(v) { Vec2.new(x / v, y / v) }
    ==(other) { (other != null) && (x == other.x) && (y == other.y) }
    !=(other) { !(this == other) }
    - { Vec2.new(-x, -y) }

    magnitude { (x * x + y * y).sqrt }
    magnitudeSq { x * x + y * y }
    normal { this / this.magnitude }
    normalized { this / this.magnitude }
    perp { Vec2.new(-y, x) }

    dot(other) { (x * other.x + y * other.y) }
    cross(other) { (x * other.y - y * other.x) }

    rotated(a) {
        return Vec2.new(a.cos * _x - a.sin * _y,
                        a.sin * _x + a.cos * _y)
    }

    toString { "[%(_x), %(_y)]" }

    static distance(a, b) {
        var xdiff = a.x - b.x
        var ydiff = a.y - b.y
        return ((xdiff * xdiff) + (ydiff * ydiff)).sqrt
    }

    static reflect(incident, normal) {
        return incident - normal * (2.0 * normal.dot(incident))
    }

    static fromAngle(angle) {
        return Vec2.new(angle.cos, angle.sin)
    }
}
```

### After (with annotations)

```wren
class Vec2 {
    construct new() {
        _x = 0
        _y = 0
    }
    construct new(x: Num, y: Num) {
        _x = x
        _y = y
    }

    x -> Num { _x }
    y -> Num { _y }
    x=(v: Num) { _x = v }
    y=(v: Num) { _y = v }

    +(other: Vec2) -> Vec2 { Vec2.new(x + other.x, y + other.y) }
    -(other: Vec2) -> Vec2 { this + -other }
    *(v: Num) -> Vec2 { Vec2.new(x * v, y * v) }
    /(v: Num) -> Vec2 { Vec2.new(x / v, y / v) }
    ==(other) -> Bool { (other != null) && (x == other.x) && (y == other.y) }
    !=(other) -> Bool { !(this == other) }
    - -> Vec2 { Vec2.new(-x, -y) }

    magnitude -> Num { (x * x + y * y).sqrt }
    magnitudeSq -> Num { x * x + y * y }
    normal -> Vec2 { this / this.magnitude }
    normalized -> Vec2 { this / this.magnitude }
    perp -> Vec2 { Vec2.new(-y, x) }

    dot(other: Vec2) -> Num { (x * other.x + y * other.y) }
    cross(other: Vec2) -> Num { (x * other.y - y * other.x) }

    rotated(a: Num) -> Vec2 {
        return Vec2.new(a.cos * _x - a.sin * _y,
                        a.sin * _x + a.cos * _y)
    }

    toString -> String { "[%(_x), %(_y)]" }

    static distance(a: Vec2, b: Vec2) -> Num {
        var xdiff = a.x - b.x
        var ydiff = a.y - b.y
        return ((xdiff * xdiff) + (ydiff * ydiff)).sqrt
    }

    static reflect(incident: Vec2, normal: Vec2) -> Vec2 {
        return incident - normal * (2.0 * normal.dot(incident))
    }

    static fromAngle(angle: Num) -> Vec2 {
        return Vec2.new(angle.cos, angle.sin)
    }
}
```

### Foreign methods

Foreign methods work exactly the same way:

```wren
class Render {
    foreign static loadImage(path: String) -> Num
    foreign static loadShape(path: String) -> Num
    foreign static loadFont(font: String, size: Num) -> Num
    foreign static getImageWidth(imageId: Num) -> Num
    foreign static getImageHeight(imageId: Num) -> Num
    foreign static createSprite(imageId: Num, x0: Num, y0: Num, x1: Num, y1: Num) -> Num
    foreign static destroyShape(shapeId: Num)
    foreign static setOffset(x: Num, y: Num)
    foreign static sprite(spriteId: Num, x: Num, y: Num, z: Num, scale: Num, rotation: Num, mul: Num, add: Num, flags: Num)
    foreign static text(fontId: Num, txt: String, x: Num, y: Num, z: Num, mul: Num, add: Num, flags: Num)
}
```

### Static constants (no annotation needed)

Getters that return constants don't benefit much from annotations, but you can add them if you like:

```wren
// These are fine without annotations
static spriteNone   { 0 << 0 }
static spriteBottom { 1 << 1 }
static keySpace     { 32 }

// Or with annotations
static spriteNone -> Num   { 0 << 0 }
static spriteBottom -> Num { 1 << 1 }
static keySpace -> Num     { 32 }
```

## Tips

- **Start with return types** on getters and methods. These give the most value because they enable return type inference chains.
- **Annotate constructors' parameters** so the analyzer knows what types to expect.
- **Skip dynamic types.** If a method can return different types depending on input (like a generic container's `[index]`), leave it unannotated.
- **Your own classes are valid types.** `Vec2`, `Color`, `Entity` - any class name works.
- **Annotations are optional.** Add them gradually. Unannotated code still works, the analyzer just can't check as much.
- **No generic types.** You can't write `List<Num>` - just use `List`. The analyzer doesn't track element types.

## Limitations

- **Simple type names only** - no `List<Num>`, no `Num | String`, no `Fn<(Num) -> Bool>`
- **Assignment checks only work for literals** - `var x: Num = "hello"` warns, but `var x: Num = someFunc()` does not (the return type of arbitrary function calls isn't always known)
- **No type narrowing** - `if (x is Num) { x.abs }` doesn't narrow `x` to `Num` inside the branch
- **Constructor return types are automatic** - you don't need `-> ClassName` on constructors, the analyzer infers it
