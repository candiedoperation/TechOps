---
title: Language Features
sidebar_position: 3
---

# Language Features

The following expectations on usage of language features are vaguely based off of google's
typescript [guide](https://google.github.io/styleguide/tsguide.html).

## General

### 1. Const & Let

Never use var as it is function scoped and not block scoped.

```typescript
const foo = otherValue; // Use if "foo" never changes.
let bar = someValue; // Use if "bar" is ever assigned into later on.
```

### 2. Named vs. Anonymous Functions

Named functions are always preferred over an anonymous (or arrow function).

```typescript
function foo() {
    // preferred
    return 42;
}
const foo = () => 42; // not preferred
```

When passing in a callback however arrow function is always used (this includes react event handlers),
given that a function doesn't already exist for this function.

```typescript
const numbers = ["11", "5", "3"].map((n) => parseInt(n));
```

### 3. Template Literals

Always use string templating to insert variables into a string.

```typescript
`Template literal: ${value}`;
```

### 4. Imperative vs. Functional Style of Programming

Always opt to use a functional style of programming if it is not overly tedious to do so

```typescript
numbers = [1, 2, 3, 4];
for (const x of numbers) {
    // Ok but not preferred
    console.log(x * 2);
}

numbers.map((x) => console.log(x * 2)); // Preferred
```

This overall leads to less bugs with the way that react state handling works since set state requires
that a new object get passed in and sometimes imperatively changing it instead of passing in an arrow
function can lead to some difficult to debug bugs.

## Import rules

### 1. Do not use default exports

```typescript
export class Foo { ... }
export default class Foo { ... } // BAD!
```

The purpose of this is to make sure that import statements are consistent

```typescript
import Foo from "./bar"; // This would work
import Bar from "./bar"; // This would work too (problem!)
```

### 2. Always type annotate

```typescript
import type { Foo } from "./foo";
import { Bar } from "./foo";
```

### 3. Always order imports consistently

Order in this way:

1. React builtin
2. External imports
3. Internal imports

```typescript
import React from "react";

import { PropTypes } from "prop-types";
import styled from "styled-components/native";

import ErrorImg from "../../assets/images/error.png";
import colors from "../../styles/colors";
```
