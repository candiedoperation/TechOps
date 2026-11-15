---
title: Typing
sidebar_position: 4
---

# Typing

Since we are using typescript and there are many language features there are a number of standards to set in
how things should be typed.

It is worth noting the verbage on some of these standards. Never/always should be followed however the usage of
"preferred" or "rarely" means decisions are up to the programmer and should take some consideration. If a
bad-practice of typing is required than it should be denoted in a PR description.

## 1. Assertions

Rarely use ‘as’ assertation, it just silences the compiler instead use an if statement to do type assertation.

```typescript
if (!(x instance of Foo)) throw new Error("bad type");
```

## 2. Typing records

Always use ‘:’ as opposed to ‘as’ for records, this is because typescript compiler does not enforce type
checking over records with ‘as’.

```typescript
const foo = {
    bar: 123,
    bam: "abc",
} as Foo; // bad!

const foo: Foo = {
    bar: 123,
    bam: "abc",
}; // good! Will throw error if wrong
```

Always use interfaces over the type alias for consistency. They are the same however we must pick one :)

```typescript
interface User {
    // good!
    firstName: string;
    lastName: string;
}

type User = {
    // bad!
    firstName: string;
    lastName: string;
};
```

## 3. General typing practice

Never use ‘any’ unless there is a specific reason which should always be documented with a comment and
in the git PR, consider using unknown if appropriate.

Never use wrapper types. (i.e. String, Boolean, Number)

Always use strict equality `===` & `!==` to avoid unexpected bugs, unless there is supposed to be type
flexibility (which shouldn't happen very often or at all).
