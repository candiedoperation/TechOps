---
title: Language Features
sidebar_position: 3
---

# Language Features

## General

### 1. Dictionary Access

Accessing dictionary values: Always use `[]` syntax instead of `.get()`, unless you are using
`.get()`’s optional argument to specify a default value.

```python
value = data["key"]  # good
value = data.get("key")  # avoid (same behavior as above but doesn't error if key is missing)
value = data.get("key", "default_value")  # good
```

There may be situations where you don't want to error if a key is missing but it's better to
be explicit about what value is provided in the case that a key is missing. Allows for type
of the `value` variable to be known no matter what just from reading.

### 2. Imports

Prefer absolute imports over relative imports for accessing parent modules. Use relative imports
when the path would be overly long or importing within the same package.

```python
from app.file_name import xyz  # good
from ..file_name import xyz  # avoid when possible
```

Also never use wildcard imports to make it clear which names are present in the namespace and make
it easier to trace where a method came from.

```python
from file_name import specific_method, HelperClass # good
from file_name import * # bad
```

### 3. String Templating / `f-strings`

Use `f-strings` instead of string concatenation.

```python
f"Variable: {variable}" # good
"Variable: " + str(variable) # bad (hard to read)
```

### 4. List Iterating

This isn't that serious but preference for pythonic list iterating such as `zip()` and `enumerate()`

```python
for i, fruit in enumerate(fruits):
    print(f"Index {i}: {fruit}")

for name, score in zip(names, scores):
    print(f"{name}: {score}")
```

### 5. Default Mutable Arguments

Never use default mutable arguments.

```python
def add_to_list(num: int, lst: list[int] = []): # lst default value is [] which is mutable
    lst.append(num)
    return lst
add_to_list(5) # returns [5]
add_to_list(6) # return [5, 6]
```

The default value keeps accumulating since it's mutable which is unexpected and can lead to
difficult to debug bugs. Instead:

```python
def add_to_list(num: int, lst: list[int] | None = None):
    if not lst:
        lst = []
    lst.append(num)
    return lst
```

## Typing

Typing is a smaller language feature for Python when compared to Typescript so instead of
getting it's own typing page as Typescript did, it is a subsection of language features.

### 1. Type hinting

Type hint all public functions and all FastAPI endpoints (inputs and outputs).

```python
async def create_shapefile(self, latitude: float, longitude: float) -> str:
```

```python
@router.get("/{uuid}/geojson", status_code=status.HTTP_200_OK, responses=GetGeojsonExampleResponses)
async def get_shapefile_geojson(uuid: str, simplify: float | None = None) -> GeojsonConversionOut:
```

More details on typing FastAPI endpoint in [FastAPI Specific](./fastapi-specific.md) page.

### 2. Typing collections

Use prebuilt generics for collections (e.g., `list[str]`, `dict[str, int]`), as opposed to
outdated typed collections from the typing module.

```python
from typing import Dict
def xyz() -> Dict[str, int]: # bad, comes from typing module

def xyz() -> dict[str, int]: # good, uses generics
```

### 3. Optional Values

Use `| None` for optional values (e.g., `str | None`) as opposed to `Optional[str]`

```python
from typing import Optional
simplify: Optional[float] = None # bad, slightly less readable and outdated syntax

simplify: float | None = None # good
```

### 4. `Any` type

Avoid `Any` unless it is required; add a short comment explaining why.

### 5. Fixed dictionary shape

Use `pydantic` models when a dictionary object has a fixed shape.

```python
from pydantic import BaseModel
class CreateSessionOut(BaseModel):
    session_id: str
    shapefiles: list[str]
```

### 6. Constrained string values

Always use `Literal` for constrained string values.

```python
from typing import Literal
Status = Literal["pending", "active", "disabled"]
```
