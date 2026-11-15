---
title: Style
sidebar_position: 1
---

# Style

This style is influenced from the [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html).

## Indentation and Spacing / Horizontal Spacing

Always use 2 or 4 space tabbing (i.e. not `\t` character).  
Keep spacing around operators.

```java
int sum = a + b; // good
int sum=a+b;     // bad
```

Limit line length to be < 100 characters.

## Vertical Spacing

Use blank lines to separate logical blocks.

```java
void foo() {
  validateUserInput();
  processAuthentication();

  initialize();
  otherThing();
}
```

Prefer to use vertical separators sparingly, having single lines of code isolated
vertically is not preferred.

One blank line between class members (fields, constructors, methods). Two blank lines between
top-level class definitions.

## Braces

Start braces on the same line.

```java
if (true) {
  // good
}

if (true)
{
  // bad
}
```

Always use braces, even for single-line bodies.

```java
if (condition) {
  return; // good
}

if (condition) return; // bad
```

Empty blocks should be written on one line.

```java
void doNothing() {} // good

void doNothing() {
} // bad (unnecessarily spread out)
```

## Declarations

### One declaration per line

```java
// good
int a;
int b;

// bad
int a, b;
```

### Access modifiers

Always declare access modifiers explicitly.  
Order them as: `public / protected / private` → `abstract` → `static` → `final` → `transient` → `volatile`

```java
private static final int MAX = 100; // good
static private final int MAX = 100; // bad
```

### Variable declarations

Declare variables close to where they are first used, not at the top of the block.

```java
// good
processInput(input);

String result = compute();
use(result);

// bad
String result;
processInput(input);
result = compute();
use(result);
```

## Annotations

Each annotation on a class, method, or constructor goes on its own line.

```java
@Override
@Nullable
public String getName() { // good
  ...
}

@Override @Nullable public String getName() { // bad
  ...
}
```

Annotations on fields may appear on the same line when there is only one.

```java
@Nullable private String name; // ok
```

## Imports

Never use wildcard imports, it wastes resources.

```java
import java.util.List;
import java.util.Map; // good

import java.util.*;   // bad
```

Imports are ordered as follows with a blank line separating each group:

1. Static imports
2. `java.*` and `javax.*`
3. Third-party libraries
4. Internal/project imports

Order imports alphabetically within each group.

## Commas

Always use trailing commas in multi-line enums and annotations.

```java
enum Status {
  PENDING,
  ACTIVE,
  CLOSED, // <-- trailing comma
}
```

## Strings

Always use double quotes for string literals. Single quotes are for `char` literals only.

```java
String s = "hello";
char c = 'h';
```

## Comments

Use `//` for inline and single-line comments. Use `/** */` Javadoc for all APIs.

For Javadoc, include description, parameters (`@param`), return value (`@return`), and errors thrown (`@throws`)

```java
/**
 * Process a registration using a one-time token.
 *
 * @param token one-time registration token
 * @param request user email and first/last name captured from the form
 * @return response containing success, message and user email
 * @throws RegistrationException if token is invalid/expired or any step fails
 */
public RegistrationResponse processRegistration(UUID token, RegistrationRequest request) {
    ...
}
```

Don't write comments that just restate the code:

```java
i++; // increments i by 1 — bad

retryCount = 0; // reset retry counter after successful connection — good
```
