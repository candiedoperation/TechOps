import logging
from datetime import datetime
from unittest.mock import Mock

import pytest
from postgrest.exceptions import APIError
from pydantic import ValidationError

import Repository.UserRepo as user_repo
from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import (
    DatabaseException,
    ForeignKeyViolationException,
    UserAlreadyExistsException,
    UserNotFoundException,
)


def install_query(monkeypatch, execute: Mock) -> Mock:
    query = Mock()
    for method in ("insert", "select", "update", "delete", "eq", "order", "limit"):
        getattr(query, method).return_value = query
    query.execute = execute
    table = Mock(return_value=query)
    monkeypatch.setattr(user_repo.supabase, "table", table)
    return query


def response(data):
    return Mock(data=data)


def api_error(code: str, message: str = "db failure", details="detail") -> APIError:
    return APIError({"message": message, "code": code, "hint": None, "details": details})


class TestDatabaseEdgeCases:
    def test_add_user_returns_inserted_row_and_ignores_extra_columns(self, monkeypatch):
        query = install_query(
            monkeypatch,
            Mock(return_value=response([{"slack_user_id": "U1", "slack_user_name": "ada", "points": 0, "extra": "x"}])),
        )
        user = User(slack_user_id="U1", slack_user_name="ada")

        saved = user_repo.create_user(user)

        assert saved == User(slack_user_id="U1", slack_user_name="ada", points=0)
        query.insert.assert_called_once_with(user.model_dump())

    def test_add_user_maps_unique_violation(self, monkeypatch):
        install_query(monkeypatch, Mock(side_effect=api_error("23505", details="Key already exists.")))

        with pytest.raises(UserAlreadyExistsException) as exc_info:
            user_repo.create_user(User(slack_user_id="U1", slack_user_name="ada"))

        assert exc_info.value.code == "409"
        assert exc_info.value.message == "User already exists"
        assert exc_info.value.__cause__.details == "Key already exists."

    def test_add_user_empty_insert_response_is_user_not_found(self, monkeypatch):
        install_query(monkeypatch, Mock(return_value=response([])))

        with pytest.raises(UserNotFoundException) as exc_info:
            user_repo.create_user(User(slack_user_id="U1", slack_user_name="ada"))

        assert exc_info.value.code == "404"
        assert exc_info.value.message == "User not found"
        assert isinstance(exc_info.value.__cause__, IndexError)

    def test_get_user_returns_first_row(self, monkeypatch):
        query = install_query(
            monkeypatch,
            Mock(return_value=response([{"slack_user_id": "U1", "slack_user_name": "ada", "points": 10}])),
        )

        found = user_repo.get_user("U1")

        assert found.points == 10
        query.eq.assert_called_once_with("slack_user_id", "U1")
        query.limit.assert_called_once_with(1)

    def test_get_user_missing_row_is_user_not_found(self, monkeypatch):
        install_query(monkeypatch, Mock(return_value=response([])))

        with pytest.raises(UserNotFoundException) as exc_info:
            user_repo.get_user("missing")

        assert exc_info.value.code == "404"
        assert exc_info.value.message == "User not found"
        assert isinstance(exc_info.value.__cause__, IndexError)

    def test_get_user_maps_foreign_key_violation(self, monkeypatch):
        install_query(monkeypatch, Mock(side_effect=api_error("23503")))

        with pytest.raises(ForeignKeyViolationException) as exc_info:
            user_repo.get_user("U9")

        assert exc_info.value.code == "409"
        assert exc_info.value.message == "Foreign key violation"
        assert exc_info.value.__cause__.code == "23503"

    def test_update_user_sends_new_points(self, monkeypatch):
        query = install_query(
            monkeypatch,
            Mock(return_value=response([{"slack_user_id": "U1", "slack_user_name": "ada", "points": 20}])),
        )

        updated = user_repo.update_points("U1", 20)

        assert updated.points == 20
        payload = query.update.call_args.args[0]
        assert payload["points"] == 20
        assert isinstance(payload["updated_at"], datetime)
        query.eq.assert_called_once_with("slack_user_id", "U1")

    def test_update_user_maps_unknown_api_error(self, monkeypatch, caplog):
        install_query(monkeypatch, Mock(side_effect=api_error("08006", message="connection failure")))

        with caplog.at_level(logging.ERROR):
            with pytest.raises(DatabaseException) as exc_info:
                user_repo.update_points("U1", 20)

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert exc_info.value.message == "Internal server error"
        assert exc_info.value.__cause__.code == "08006"
        assert "Raising DatabaseException" in caplog.text

    def test_update_user_timeout_becomes_internal_error(self, monkeypatch):
        install_query(monkeypatch, Mock(side_effect=TimeoutError("timed out")))

        with pytest.raises(DatabaseException) as exc_info:
            user_repo.update_points("U1", 1)

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert isinstance(exc_info.value.__cause__, TimeoutError)

    def test_get_top_keeps_query_order(self, monkeypatch):
        query = install_query(
            monkeypatch,
            Mock(
                return_value=response(
                    [
                        {"slack_user_id": "U1", "slack_user_name": "ada", "points": 30},
                        {"slack_user_id": "U2", "slack_user_name": "grace", "points": 0},
                    ]
                )
            ),
        )

        leaders = user_repo.get_top(5)

        assert [user.slack_user_name for user in leaders] == ["ada", "grace"]
        query.order.assert_called_once_with("points", desc=True)
        query.limit.assert_called_once_with(5)

    def test_get_top_returns_empty_list(self, monkeypatch):
        install_query(monkeypatch, Mock(return_value=response([])))

        assert user_repo.get_top(5) == []

    def test_get_top_invalid_row_becomes_internal_error(self, monkeypatch):
        install_query(monkeypatch, Mock(return_value=response([{"slack_user_name": "ada", "points": 1}])))

        with pytest.raises(DatabaseException) as exc_info:
            user_repo.get_top(5)

        assert type(exc_info.value) is DatabaseException
        assert exc_info.value.code == "500"
        assert isinstance(exc_info.value.__cause__, ValidationError)

    def test_delete_user_returns_deleted_row(self, monkeypatch):
        query = install_query(
            monkeypatch,
            Mock(return_value=response([{"slack_user_id": "U1", "slack_user_name": "ada", "points": 4}])),
        )

        deleted = user_repo.delete_user("U1")

        assert deleted.slack_user_id == "U1"
        query.delete.assert_called_once_with()
        query.eq.assert_called_once_with("slack_user_id", "U1")

    def test_delete_user_missing_row_is_user_not_found(self, monkeypatch):
        install_query(monkeypatch, Mock(return_value=response([])))

        with pytest.raises(UserNotFoundException) as exc_info:
            user_repo.delete_user("nobody")

        assert exc_info.value.code == "404"
        assert exc_info.value.message == "User not found"
        assert isinstance(exc_info.value.__cause__, IndexError)
