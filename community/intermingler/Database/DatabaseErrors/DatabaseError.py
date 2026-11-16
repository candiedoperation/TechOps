import logging
from functools import wraps
from typing import Callable, NoReturn

import httpx
from postgrest.exceptions import APIError

logger = logging.getLogger(__name__)


class DatabaseException(Exception):
    def __init__(self, code: str, message: str, error: Exception | None = None, details: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        cause = getattr(error, "message", None) or error
        logged_details = getattr(error, "details", None)
        if logged_details is None:
            logged_details = details
        logger.error(
            "Raising %s code=%s message=%s cause_code=%s cause=%s details=%s",
            type(self).__name__,
            code,
            message,
            getattr(error, "code", None),
            cause,
            logged_details,
            exc_info=error,
        )


class UserNotFoundException(DatabaseException):
    def __init__(self, error: Exception | None = None):
        super().__init__(code="404", message="User not found", error=error, details="User not found")


class UserAlreadyExistsException(DatabaseException):
    def __init__(self, error: Exception | None = None):
        super().__init__(code="409", message="User already exists", error=error, details="User already exists")


class ForeignKeyViolationException(DatabaseException):
    def __init__(self, error: Exception | None = None):
        super().__init__(code="409", message="Foreign key violation", error=error, details="Foreign key violation")


def handle_database_error(error: Exception) -> NoReturn:
    if isinstance(error, APIError):
        if error.code == "23505":
            raise UserAlreadyExistsException(error) from error
        if error.code == "23503":
            raise ForeignKeyViolationException(error) from error
        raise DatabaseException(code="500", message="Internal server error", error=error) from error
    if isinstance(error, IndexError):
        raise UserNotFoundException(error) from error
    if isinstance(error, httpx.HTTPError):
        raise DatabaseException(code="503", message="Service unavailable", error=error) from error
    raise DatabaseException(code="500", message="Internal server error", error=error) from error


def exception_decorator(func: Callable):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            handle_database_error(e)

    return wrapper
