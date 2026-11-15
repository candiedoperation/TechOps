---
title: Language Features
sidebar_position: 3
---

# Language Features

## General

### Enhanced For Loops

Prefer enhanced for loops over index-based loops unless the index is actually needed.

```java
for (String name : names) { // good
  System.out.println(name);
}

for (int i = 0; i < names.size(); i++) { // only if index is needed
  System.out.println(names.get(i));
}
```

### String Templating

Prefer `String.format()` or `formatted()` over string concatenation for readability.

```java
String msg = "Hello, %s!".formatted(name); // good
String msg = "Hello, " + name + "!";       // avoid
```

### Ternary Operator

Ternary operators are acceptable for simple, readable assignments. Do not nest ternaries.

```java
String label = isActive ? "Active" : "Inactive";                           // good

String label = isActive ? (isPremium ? "Premium" : "Active") : "Inactive"; // bad
```

### Switch Expressions

Prefer switch expressions (arrow syntax) over traditional switch statements for assignments.

```java
// good
String label = switch (status) {
  case ACTIVE -> "Active";
  case PENDING -> "Pending";
  default -> "Unknown";
};

// avoid
String label;
switch (status) {
  case ACTIVE:
    label = "Active";
    break;
  ...
}
```

### Optional

Prefer `Optional<T>` for return values that may be absent instead of returning `null`.  
This helps programmers understand your functions and avoid silent `null` returns.

```java
public Optional findUser(String id) { // good
  ...
}

public User findUser(String id) {     // avoid if findUser() could return null
  ...
  if (userNotFound) {
    return null;
  }
}
```

Do not use `Optional` as a method parameter or field, only as a return type.

```java
public void process(Optional name) { ... } // bad — use overloads or @Nullable instead
```

### Avoid Magic Numbers

Always extract magic numbers into named constants.

```java
private static final int MAX_RETRIES = 3;

if (retryCount > MAX_RETRIES) { ... } // good

if (retryCount > 3) { ... }           // bad
```
