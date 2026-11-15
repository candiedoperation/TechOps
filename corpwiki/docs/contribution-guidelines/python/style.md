---
title: Style
sidebar_position: 1
---

# Style

## Indentation and Spacing / Horizontal Spacing

Always use 4 space tabbing. (i.e. not `\t` character)  
Keep spacing around operators

```python
sum = a + b  # good
sum=a+b      # bad
```

Limit line length to be < 80 characters

## Vertical Spacing

Use blank lines to separate logical blocks

```python
def foo():
  validation_user_input()
  process_authentication()

  initialize()
  other_thing()
```

It is preferred to use vertical separators sparingly, having single lines of code isolated
vertically is not preferred.

## Commas and quotes

Always use trailing commas (results in consistent git merging behavior)

```python
data = {
    "key": 5,
    "key2": 4, # <-- this one
}
```

For quotations always use double quotes: `"`  
Inner single quotes `'` are acceptable

```python
"This is a string" # ok
"This is a 'string'" # inner ' is acceptable
dict["key"] # even in dictionary key accessing " is used
```
