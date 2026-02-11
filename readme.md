# Wren

Visual Studio Code extension for the Wren programming language.

## Features

- Syntax highlighting (Wren 0.4 + Attributes)
- Symbol outline for classes, methods, subscripts, and fields
- Context-aware completions for classes, static members, and instance methods
- Inline signature help showing parameters for constructors and methods
- File icons for .wren sources

## Acknowledgements

Based on the Wren extension by Johann Muszynski

## Configuration

`wren.additionalModuleDirectories` – array of workspace-relative folders that should be scanned when resolving `import` statements. Useful when your project keeps shared scripts outside of the current package folder.