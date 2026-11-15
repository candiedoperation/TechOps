---
title: Error Handling
sidebar_position: 5
---

# Error Handling

**Note: This error handling doc was specifically catered to suit the Amazon Leo team's needs and
may be over specific for different use cases.**

This doc is structured to discuss how error handling is done at different levels of abstraction
from the router level to the service level. This doc is largely based off of this [article](https://medium.com/delivus/exception-handling-best-practices-in-python-a-fastapi-perspective-98ede2256870).
Feel free to read from there if you want more background and reasoning for these error handling
patterns.

## Background

### Abstraction Levels

- Router Level: Code that exposes an API endpoint.
- Business/Service Level: Code that implements the functionality behind the API, independent
  of the web framework.
- Helper Level: Code that provides reusable abstractions for tasks such as database operations.

To summarize how error handling is done is that the router level will raise HTTP exception,
the service level will raise custom exceptions which return `ErrorContext` and the helper level
just raises whatever exception is needed. You may be wondering, why doesn't just every abstraction
level raise an HTTP exception and let it propogate up the stack? The reasoning for this
is that the service level and helper level are independent of the web framework so that it can
more easily be unit tested. Also there may be situations where not enough context exists where
the error occurs and more context is available at the service/route level.

### `ErrorContext`

ErrorContext encapsulates error information in a consistent structure, allowing the frontend to
handle API errors predictably.

```python
class ErrorContext(BaseModel):
    type: str
    message: str
    location: list[str]
```

_Note: while the implementation of the `ErrorContext` class is subject to change, it is included
in the docs to better explain the purpose of the class and how it will be used._

`type` - for the frontend to handle the type of exception appropriately if the `status_code` has
any duplicates.  
`message` - for a developer who is looking through the network tab from the frontend to get
insight on the error.  
`location` - contains info about the error that cannot be addressed in the `type` field. For
example, this could include a list of inputs that were in the route payload which are invalid.

### Custom Errors

Custom errors that are required to return an `ErrorContext` object must all inherit from `BaseError`
which includes some boilerplate. An example of a custom error class is available below under the
`Service Level` section.

All custom errors must end with the word `Error`. (`MultipleLoginsError`, `ValidationError`)

## Router Level

As discussed in [FastAPI specific guidelines](./fastapi-specific.md), the router itself is
not responsible for the business logic. Therefore the responsibility of the router in terms of
error handling is to convert the errors produced by business logic and to convert them in to
understandable HTTP exceptions that can easily be handled by the frontend.

Here's an example:

```python
@app.get("/users/{user_id}")
async def get_user(user_id: int) -> UserData:
    try:
        return user_data = await service.get_user_details(user_id)
    except ResourceNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.context())
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=e.context())
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=ErrorContext(
            type="file_not_found",
            message="User file does not exist",
            location=[],
        ))
    except Exception as e:
        raise HTTPException(status_code=500, detail="Internal server error")
```

The except blocks specifically catch the custom error classes which may have been raised
in the service code. Since these custom error classes are our own they will have a `context()`
method which will return an `ErrorContext` object. In the case an error is raised which is not
custom such as `FileNotFoundError`, we must construct the detail dict ourselves.

Finally the last exception is just to catch unhandled errors. In production/main branch code,
`500` status code errors should never be expected. In other words, all known errors should be
handled directly with a custom error class if appropriate so that error context can be provided
to the frontend.

## Service Level

The purpose of error handling in the service level is to convert any errors which happen in our
code to our own custom errors and to raise any new errors as needed.

Here's an example of converting an error which comes from an AWS s3 call.

```python
# in schemas file
class UserFileNotFoundError(BaseError):
    DEFAULT_MESSAGE = "User file not found when attempting to request from S3"
    TYPE = "user_file_not_found"

    def __init__(self, message: str | None = None, location: list[str] | None = None):
        super().__init__(self.TYPE, self.DEFAULT_MESSAGE, message, location)

# in service file
try:
    response = self.client.get_object(Bucket=self.bucket_name, Key=s3_key)
except ClientError as e:
    raise UserFileNotFoundError(message=str(e))
```

Without this `try/except` block our program would have just returned an AWS `ClientError` which
is difficult to understand without the context that it comes from an AWS call but by instead
rethrowing our own error we provide more context which can then be easily handled by the frontend.

The `message` parameter is appended to the `DEFAULT_MESSAGE` to maintain additional context as the
error propagates.

## Helper Level

At the helper level (e.g., dynamo_db.py), functions are not called directly by the router.
Therefore, custom errors with .context() are generally not required at this level. Simple custom
errors or just built-in exceptions can be raised as needed.
