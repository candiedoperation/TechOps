---
title: Typing
sidebar_position: 4
---

# Typing

Java is a statically typed language so the compiler enforces most type safety by default. That said,
there are still patterns and pitfalls worth standardizing around generics, casting, and nullability.

It is worth noting the verbage on some of these standards. Never/always should be followed however the usage of
"preferred" or "rarely" means decisions are up to the programmer and should take some consideration. If a
bad-practice of typing is required than it should be denoted in a PR description.

## Casting

Rarely use explicit casting. Always guard casts with an `instanceof` check to avoid
`ClassCastException` at runtime.

```java
// good
if (animal instanceof Dog dog) { // pattern matching instanceof (Java 16+)
  dog.bark();
}

// bad
Dog dog = (Dog) animal;          // will throw runtime exception if animal is not a Dog
```

## Generics

Never use raw types, always provide type parameters. Raw types disable compile-time type
checking and can cause `ClassCastException` at runtime.

```java
List<String> names = new ArrayList<>(); // good

List names = new ArrayList();           // bad
```

Wildcard types (`?`) should be used sparingly and only when the type genuinely doesn't matter
to the operation. Prefer bounded wildcards when you need flexibility.

```java
public void printAll(List<? extends Shape> shapes) { ... } // ok — read-only, bounded

public void processAll(List<?> items) { ... } // rarely — only if truly type-agnostic
```

## Nullability

Never return `null` from a method when absence of a value is a valid outcome, use
`Optional<T>` instead. This makes the possibility of an absent value explicit in the type
signature.

```java
public Optional<User> findUser(String id) { ... } // good

public User findUser(String id) { ... } // bad — null return is invisible to the caller
```

Always annotate with `@Nullable` when `null` is a valid value for a parameter or field.
Unannotated parameters and return types are assumed non-null.

```java
public void process(@Nullable String input) { ... } // explicitly nullable

public void process(String input) { ... } // assumed non-null
```

Never use `Optional` as a method parameter or field type, only as a return type.

```java
public void process(Optional<String> name) { ... } // bad — use @Nullable or overloads instead
```

## `var`

`var` is acceptable for local variables when the inferred type is immediately obvious from
the right-hand side. Never use it when the type would be unclear to a reader.

```java
var users = new ArrayList<User>();   // ok — type is obvious

var result = service.process(input); // bad — type is not clear without checking the method
```

Never use `var` for fields, method parameters, or return types. Only local variables.

## Wrapper Types

Never use wrapper types (`Integer`, `Boolean`, `Long`, etc.) for local variables or method
parameters unless required (e.g. a collection element type or an explicitly nullable value).
Prefer primitives.

```java
int count = 0;     // good
Integer count = 0; // bad — unnecessary boxing
List<Integer> ids; // good — collections require wrapper types
```

## Enums Over Stringly-Typed Values

Never use `String` or `int` constants to represent a fixed set of values. Always use enums,
which are type-safe and checked at compile time.

```java
// good
enum Status { PENDING, ACTIVE, CLOSED }
Status s = Status.ACTIVE;

// bad
static final String STATUS_ACTIVE = "active";
String s = STATUS_ACTIVE; // nothing stops passing any arbitrary string
```
