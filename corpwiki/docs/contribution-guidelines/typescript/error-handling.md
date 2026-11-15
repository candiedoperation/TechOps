---
title: Error Handling
sidebar_position: 6
---

# Error Handling

## 1. Only throw (subclass of) `Error`

```typescript
// Throw only Errors (also always include new keyword for consistency)
throw new Error("oh noes!");
```

## 2. Always provide additional context

If throwing a new error in, always provide more context so that looking at the stack trace is helpful.

```typescript
throw new Error(`Failed to fetch user with id=${id}: ${err.message}`);
```

## 3. Always limit the amount of code in a try block

_To Do: Add a better of example of a lot of code in a try block_

```typescript
try {
    // bad!
    const result = methodThatMayThrow();
    use(result);
} catch (error: unknown) {
    // ...
}

let result;
try {
    // good!
    result = methodThatMayThrow();
} catch (error: unknown) {
    // ...
}
use(result);
```

The reason for this is that the purpose of try blocks are to gracefully handle errors and the handling of errors
can be more specific is the code that is running in a try block is limited. Code in try blocks should only be
code that may throw an error in production. If a line should never throw an error in production then by including
it in the try block may obscure a bug.

However often times it is overly verbose to make an uninitialized let variable to eventually store the output
of the function that is run in the try block. It is up to the programmer's discretion but it is best practice to
avoid long try blocks for the reasons described above.
