// Test file demonstrating Wren attribute syntax highlighting

// Simple attribute without value
#key
class Example1 {
  method() {}
}

// Runtime attribute
#!runtimeAccess
class Example2 {
  method() {}
}

// Attribute with string value (now properly highlighted)
#author = "John Doe"
class Example3 {
  method() {}
}

// Attribute with numeric value (now properly highlighted)
#version = 2
class Example4 {
  method() {}
}

// Attribute with floating point value
#timeout = 3.5
class Example5 {
  method() {}
}

// Attribute with boolean value (now properly highlighted)
#deprecated = false
class Example6 {
  method() {}
}

// Attribute with null value
#value = null
class Example7 {
  method() {}
}

// Complex attribute with multiple parameters
#group(key1 = "value1", key2 = 42, key3 = true)
class Example8 {
  method() {}
}

// Runtime complex attribute
#!settings(enabled = true, timeout = 3000)
class Example9 {
  method() {}
}

// Attribute on methods
class Example10 {
  #deprecated
  oldMethod() {}

  #!getter
  getter() {}

  #validator = "email"
  validateEmail() {}
}

// Multiple attributes stacked
#author = "Jane"
#version = 1
#!internal = true
class Example11 {
  method() {}
}

// Hex number in attribute
#color = 0xFF6B6B
class Example12 {
  method() {}
}

// Scientific notation in attribute
#factor = 1.5e-3
class Example13 {
  method() {}
}
