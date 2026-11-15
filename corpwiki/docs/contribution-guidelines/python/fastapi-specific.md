---
title: FastAPI Specific
sidebar_position: 4
---

# FastAPI Specific

## Input Placement

Put all API input in the endpoint parameters. For request bodies, always use a developer-defined
subclass of Pydantic's `BaseModel`. If there is a single body field, name it `payload`.

```python
from pydantic import BaseModel

class Item(BaseModel):
    name: str
    description: str | None = None
    price: float
    tax: float | None = None

@app.put("/items/{item_id}")
async def update_item(item_id: int, payload: Item, q: str | None = None):
    ...
```

For more information on how FastAPI endpoint input works read up [here](https://fastapi.tiangolo.com/tutorial/path-params/).
I would suggest reading from `Path Parameters` to `Request Body`.

## Structuring API Endpoints

Use a consistent structure in each endpoint:

1. Destructure query parameters, path parameters, or request body.
2. Validate input and return errors if necessary.
3. Call business logic methods or perform simple database queries.
4. Return the response.

```python
# Destructure query parameters, path parameters, or request body
@app.get("/more_route/info/{item_id}", status_code=status.HTTP_200_OK)
async def get_info(item_id: int) -> int:
    # Validate input
    if not valid(item_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ErrorContext("Item does not exist", "invalid_id", []),
        )
    # Perform business logic
    result = perform_action(item_id)
    # Return expected result
    return result
```

Note: `ErrorContext` is a pydantic class which is discussed in more detail in [Error Handling](./error-handling.md).

Essentially the idea is the purpose of the route code is primarily just to process input and most
of the actual logic is performed elsewhere.

## Notes

1. Type hint all inputs and outputs for FastAPI endpoints (supports auto-generated docs).
2. Use `HTTPException` for invalid input errors.
3. Do not wrap the final result in a `data` key.
4. Use FastAPI's `status` class for status codes for consistency and readability.
5. Use `_` to separate multiple words in route segments (e.g., `more_route`).
6. Always use the correct HTTP method (know the difference between POST, PUT, and PATCH). [reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods)
