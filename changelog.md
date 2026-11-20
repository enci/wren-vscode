# Change Log

All notable changes to the "Wren" extension will be documented in this file.

## [Unreleased]

### Added
- Argument type checking: passing a value whose type is known (literal, annotated variable/parameter, or a call with an annotated return type) to a parameter annotated with an incompatible type now warns, e.g. `Data.getBool(5)` -> "Argument 1 of 'Data.getBool' expects String but got Num". Subclasses and `null` are accepted; unannotated parameters accept anything. Operator arguments (`1 + "a"`) are checked too.

### Fixed
- Go-to-definition rewritten to resolve on the AST with real lexical scopes. It now handles chained calls (`a.b.c`), calls on fields (`_pos.x`) and on call results, inherited methods (across files), implicit `this` calls (`update()` inside a class), arity overloads and getter/setter pairs, parameters with the same name in different methods, shadowed variables, variables inside closures, capitalized module variables, fields first assigned in nested expressions, `super` calls, user-defined operators, and class names in type annotations.
- `Random.new(seed)` no longer restricts the seed to `Num` (Wren also accepts a sequence of numbers).

## [0.2.3] - 2026-09-23

### Fixed
- Syntax highlighting for the `[]` subscript operator: `foreign [args] -> Type` declarations, and getters/setters with a `-> Type` return-type annotation or an opening `{` on its own line, no longer break highlighting for the rest of the class.

## [0.2.2] - 2026-05-20

### Added
- `wren.enableDiagnostics` setting to toggle analyzer diagnostics on/off
- Hover provider: shows type info for classes, methods, fields, variables, and `this`
- Go-to-definition: navigate to class definitions, methods, fields, variables, and import paths (cross-file)
- Return type annotations shown in hover and completion details (e.g. `-> ReturnType`)

### Changed
- Graceful error handling in the analyzer for more reliable autocomplete when code has errors
- `null` is now treated as a compatible value for any type in the analyzer

## [0.2.0] - 2026-02-12

### Added
- Full analysis pipeline (lexer → parser → resolver → type-checker) powered by wren-analyzer
- Real-time diagnostics with error and warning squiggles
- Import resolution: follows `import` statements to discover classes across files
- Selective import support (`import "mod" for X, Y` filters completions)
- Unresolved import warnings with squiggles on the import path
- Built-in module IntelliSense for `Random` and `Meta` (available after import)
- Complete Wren core API IntelliSense: `Object`, `Class`, `Bool`, `Null`, `Num`, `String`, `List`, `Map`, `Range`, `Sequence`, `Fiber`, `Fn`, `System`, `MapEntry`
- Absolute path support in `wren.additionalModuleDirectories` for global user settings

### Changed
- Replaced regex-based parser with AST-based analysis from wren-analyzer
- Unified parsing: single analysis pass produces both IntelliSense index and diagnostics
- Code completions and signature help now leverage the full workspace aggregate (current file + imports + core API)

## [0.1.2] - 2025-11-19

### Added
- Support for subscript operator syntax `[params]` and `[params]=(value)` in symbol provider
- Auto-closing pairs for brackets: `()`, `[]`, `{}`, and `""`
- Surrounding pairs support (wrap selection with brackets)
- Documentation comment syntax highlighting for `///` comments

### Changed
- Improved syntax highlighting for subscript getter and setter operators

## [0.1.1] - 2025-11-06

### Changed
- Updated extension icon with higher resolution version

## [0.1.0] - 2025-11-06

### Added
- Initial release
- Syntax highlighting for Wren 0.4 with attributes support
- Custom icon for .wren files
