# Change Log

All notable changes to the "Wren" extension will be documented in this file.

## [Unreleased]

### Added
- Heuristic language service that powers document symbols, autocompletion, and signature help
- `wren.additionalModuleDirectories` setting to scan extra folders when resolving imports

### Changed
- Document outline now groups methods, subscripts, and fields under their containing classes

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
