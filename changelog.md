# Change Log

All notable changes to the "Wren" extension will be documented in this file.

## [0.2.0] - 2025-02-12

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
