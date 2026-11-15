---
title: Style
sidebar_position: 1
---

# Style

This style is more or less the same as the python style guide with only a few minor differences
that are specific from language to language (such as braces in typescript vs whitespace in python)

## Indentation and Spacing / Horizontal Spacing

Always use 2 space tabbing. (i.e. not `\t` character)  
Keep spacing around operators

```typescript
const sum = a + b; // good
const sum = a + b; // bad
```

Limit line length to be < 80 characters

## Vertical Spacing

Use blank lines to separate logical blocks

```typescript
function foo() {
  validation_user_input();
  process_authentication();

  initialize();
  other_thing();
}
```

It is preferred to use vertical separators sparingly, having single lines of code isolated
vertically is not preferred.

## Braces

Always use K&R style braces as opposed to microsoft/allman style

```typescript
if (true) {
  // good
}

if (true) {
  // bad
}
```

It's better to use braces over single line if statements however for very simple if statements  
single line syntax is okay.

```typescript
if (true) return; // ok
if (condition1 && condition2)
  condition4 ? do_thing(arg1, arg2, arg3) : do_other_thing(arg1); // bad
```

### Records/Dictionaries

When destructuring import or making records in general, space separate the curly braces.
Do not space separate curly braces which are used to pass in props in components or in tsx

```tsx
import { something } from "./somewhere";

setSearchParams({ session: currentTab.sessionId });

<Component prop={variable} />; // good

{
  inputType == "Address" && <Component />;
} // good
```

## Semicolons, commas and quotes

Always use semi colons for statements

```typescript
let doThing = () => {
  console.log("A"); // <-- use this one
}; // <-- unnecessary
```

Always use trailing commas (results in consistent git merging behavior)

```typescript
dict = {
  key: 5,
  key2: 4, // <-- this one
};
```

For quotations always use double quotes: `"`  
Inner single quotes `'` are acceptable

```typescript
"This is a string"; // ok
"This is a 'string'"; // inner ' is acceptable
dict["key"]; // even in dictionary key accessing " is used
```
