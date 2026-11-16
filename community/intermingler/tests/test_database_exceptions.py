import logging
from typing import Any

import pytest
from postgrest.exceptions import APIError

from Database.DatabaseErrors.DatabaseError import (
    DatabaseException,
    ForeignKeyViolationException,
    UserAlreadyExistsException,
    UserNotFoundException,
    exception_decorator,
)


def api_error(code: Any, message: str | None = "db failure", details: Any = "detail text") -> APIError:
    return APIError({"message": message, "code": code, "hint": None, "details": details})


@exception_decorator
def guarded(value: str = "ok"):
    if value == "unique":
        raise api_error("23505", message="duplicate key", details="Key (slack_user_id)=(U1) already exists.")
    if value == "unique-int":
        raise api_error(23505, details=None)
    if value == "missing-fk":
        raise api_error("23503", message="foreign key", details="Key (slack_user_id)=(U9) is not present.")
    if value == "other":
        raise api_error("XX000", message="connection reset", details=None)
    if value == "empty":
        raise api_error(None, message=None, details=None)
    if value == "missing-row":
        raise IndexError("list index out of range")
    if value == "domain":
        raise UserNotFoundException()
    if value == "boom":
        raise RuntimeError("not a database error")
    return value


class TestExceptionDecorator:
    def test_returns_value_when_call_succeeds(self):
        assert guarded("ok") == "ok"
        assert guarded.__name__ == "guarded"

    def test_unique_violation_becomes_user_already_exists(self):
        with pytest.raises(UserAlreadyExistsException) as exc_info:
            guarded("unique")

        error = exc_info.value
        assert error.code == "409"
        assert error.message == "User already exists"
        assert isinstance(error.__cause__, APIError)
        assert error.__cause__.code == "23505"
        assert error.__cause__.details == "Key (slack_user_id)=(U1) already exists."

    def test_numeric_unique_code_is_an_internal_error(self, caplog):
        with caplog.at_level(logging.ERROR):
            with pytest.raises(DatabaseException) as exc_info:
                guarded("unique-int")

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert exc_info.value.message == "Internal server error"
        assert exc_info.value.__cause__.code == 23505
        assert caplog.text == ""

    def test_foreign_key_violation_becomes_foreign_key_exception(self):
        with pytest.raises(ForeignKeyViolationException) as exc_info:
            guarded("missing-fk")

        error = exc_info.value
        assert error.code == "409"
        assert error.message == "Foreign key violation"
        assert error.__cause__.code == "23503"

    def test_unknown_api_error_becomes_internal_database_exception(self, caplog):
        with caplog.at_level(logging.ERROR):
            with pytest.raises(DatabaseException) as exc_info:
                guarded("other")

        error = exc_info.value
        assert type(error) is DatabaseException
        assert error.code == "500"
        assert error.message == "Internal server error"
        assert error.__cause__.code == "XX000"
        assert caplog.text == ""

    def test_api_error_without_code_or_message_becomes_internal_error(self, caplog):
        with caplog.at_level(logging.ERROR):
            with pytest.raises(DatabaseException) as exc_info:
                guarded("empty")

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert exc_info.value.message == "Internal server error"
        assert caplog.text == ""

    def test_domain_exception_is_wrapped_as_an_internal_error(self):
        with pytest.raises(DatabaseException) as exc_info:
            guarded("domain")

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert isinstance(exc_info.value.__cause__, UserNotFoundException)

    def test_missing_row_becomes_user_not_found(self):
        with pytest.raises(UserNotFoundException) as exc_info:
            guarded("missing-row")

        assert exc_info.value.code == "404"
        assert exc_info.value.message == "User not found"
        assert isinstance(exc_info.value.__cause__, IndexError)

    def test_unclassified_error_becomes_internal_database_exception(self):
        with pytest.raises(DatabaseException) as exc_info:
            guarded("boom")

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert isinstance(exc_info.value.__cause__, RuntimeError)

    def test_known_codes_are_not_logged_as_internal_errors(self, caplog):
        with caplog.at_level(logging.ERROR):
            with pytest.raises(UserAlreadyExistsException):
                guarded("unique")

        assert "Database error" not in caplog.text
