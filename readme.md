# Wren Language Extension

Visual Studio Code extension for the <a href="https://wren.io">Wren</a> programming language.

## Features:

### Syntax Highlighting

Syntax highlighting for Wren 0.4, including attributes (`#`)

<!-- TODO: ![Syntax highlighting screenshot](images/syntax-highlighting.png) -->

### Document Outline & Symbols

Navigate your code with the outline panel. Classes, methods, constructors, subscript operators, and fields are all listed hierarchically.

<!-- TODO: ![Document outline screenshot](images/document-outline.png) -->

### Code Completion

Context-aware autocompletion for:

- **Class names** — all classes in the current file, imported modules, and the Wren core library
- **Static members** — type `List.` to see `new()`, `filled()`, etc.
- **Instance methods** — type `value.` to see all known instance methods
- **Constructors** — `Fiber.new`, `Map.new`, `List.new`, …
- **Keywords** — `class`, `construct`, `import`, `var`, …

<!-- TODO: ![Code completion screenshot](images/code-completion.png) -->

### Signature Help

Inline parameter hints appear as you type inside parentheses, showing all overloads with their parameter names.

<!-- TODO: ![Signature help screenshot](images/signature-help.png) -->

### Diagnostics

Real-time error and warning squiggles powered by an analysis pipeline (lexer → parser → resolver → (optional) type-checker). Catches syntax errors, unresolved variables, and type annotation warnings as you type.

<!-- TODO: ![Diagnostics screenshot](images/diagnostics.png) -->

### Import Resolution

The extension follows `import` statements to discover classes across your project. It understands:

- Relative imports (`import "utils"`)
- Selective imports (`import "utils" for Helper, Config`)
- Configurable search paths via `wren.additionalModuleDirectories`
- Unresolved import warnings with squiggles on the import path

<!-- TODO: ![Import resolution screenshot](images/import-resolution.png) -->

### Built-in API IntelliSense

Code completion for the Wren standard library and the optional modules 
classes (`Random`, `Meta`) 

### File Icons

Custom file icons for `.wren` sources in both light and dark themes.

---

## Configuration

### `wren.additionalModuleDirectories`

An array of directories to search when resolving `import` statements.

- **Relative paths** are resolved per workspace folder
- **Absolute paths** work as-is (useful in global user settings for engine/framework modules)

---

## Acknowledgements

Based on the Wren extension by Johann Muszynski.

Analysis powered by [wren-analyzer](https://github.com/enci/wren-analyzer), a TypeScript port of [wrenalyzer](https://github.com/munificent/wrenalyzer) by Bob Nystrom, extended with optional type-checking support.