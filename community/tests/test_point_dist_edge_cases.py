from unittest.mock import Mock

import pytest
import requests

import BusinessLogic.UserLogic as user_logic
import SlackDataNormalizer as slack_data
from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import DatabaseException, UserAlreadyExistsException, UserNotFoundException


class TestMentionParsing:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("people <@U1> <@U2>", ["U1", "U2"]),
            ("thanks <@U1|ada> and <@W2|grace>", ["U1", "W2"]),
            ("no mentions here", []),
            ("broken <@>", []),
            ("unclosed <@U1", ["U1"]),
            ("", []),
        ],
    )
    def test_mention_parsing(self, text, expected):
        assert slack_data.mentioned_user_ids({"text": text}) == expected

    def test_missing_text_raises(self):
        with pytest.raises(KeyError):
            slack_data.mentioned_user_ids({})

    def test_none_event_raises(self):
        with pytest.raises(TypeError):
            slack_data.mentioned_user_ids(None)

    def test_decorator_passes_ids_and_the_original_event(self):
        @slack_data.with_mentioned_users
        def receive(user_ids, event, say):
            return user_ids, event["text"], say

        assert receive({"text": "people <@U1> <@U2>"}, "say") == (["U1", "U2"], "people <@U1> <@U2>", "say")


class TestRegisterUser:
    def test_register_user_stores_the_name_and_opens_a_zero_ledger(self, monkeypatch):
        stored = {}

        def create_user(user: User) -> User:
            stored["user"] = user
            return user

        ledger = Mock()
        monkeypatch.setattr(user_logic.UserRepo, "create_user", create_user)
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", ledger)

        saved = user_logic.register_user("U1", "ada")

        assert saved.slack_user_name == "ada"
        assert stored["user"].slack_user_id == "U1"
        assert stored["user"].points == 0
        ledger.assert_called_once_with("U1", 0, "set", "User added to the database")

    def test_register_user_propagates_a_duplicate(self, monkeypatch):
        monkeypatch.setattr(user_logic.UserRepo, "create_user", Mock(side_effect=UserAlreadyExistsException()))
        ledger = Mock()
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", ledger)

        with pytest.raises(UserAlreadyExistsException):
            user_logic.register_user("U1", "ada")

        ledger.assert_not_called()


class TestAwardPoints:
    def test_no_ids_skips_the_database(self, monkeypatch):
        get_user = Mock()
        monkeypatch.setattr(user_logic.UserRepo, "get_user", get_user)

        assert user_logic.award_points([], lambda slack_user_id: "ada") == []
        get_user.assert_not_called()

    def test_existing_user_gains_ten_points(self, monkeypatch):
        user = User(slack_user_id="U1", slack_user_name="ada", points=5)
        monkeypatch.setattr(user_logic.UserRepo, "get_user", lambda slack_user_id: user)
        monkeypatch.setattr(
            user_logic.UserRepo,
            "update_points",
            lambda slack_user_id, points: User(slack_user_id=slack_user_id, slack_user_name="ada", points=points),
        )
        monkeypatch.setattr(user_logic, "register_user", Mock(side_effect=AssertionError("should not register")))
        ledger = Mock()
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", ledger)

        awarded = user_logic.award_points(["U1"], lambda slack_user_id: "ada")

        assert awarded == [User(slack_user_id="U1", slack_user_name="ada", points=15)]
        ledger.assert_called_once_with("U1", 10, "increment", "User participated in intermingling")

    def test_missing_user_is_registered_then_awarded(self, monkeypatch):
        monkeypatch.setattr(user_logic.UserRepo, "get_user", Mock(side_effect=UserNotFoundException()))

        def register(slack_user_id: str, slack_user_name: str) -> User:
            return User(slack_user_id=slack_user_id, slack_user_name=slack_user_name, points=0)

        monkeypatch.setattr(user_logic, "register_user", register)
        monkeypatch.setattr(
            user_logic.UserRepo,
            "update_points",
            lambda slack_user_id, points: User(slack_user_id=slack_user_id, slack_user_name="ada", points=points),
        )
        ledger = Mock()
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", ledger)

        awarded = user_logic.award_points(["U2"], lambda slack_user_id: "ada")

        assert awarded == [User(slack_user_id="U2", slack_user_name="ada", points=10)]
        ledger.assert_called_once_with("U2", 10, "increment", "User participated in intermingling")

    def test_mixed_ids_update_and_register(self, monkeypatch):
        existing = User(slack_user_id="U1", slack_user_name="ada", points=0)

        def get_user(slack_user_id: str):
            if slack_user_id == "U1":
                return existing
            raise UserNotFoundException()

        created = []
        updated = []
        monkeypatch.setattr(user_logic.UserRepo, "get_user", get_user)
        monkeypatch.setattr(
            user_logic,
            "register_user",
            lambda slack_user_id, slack_user_name: (
                created.append(slack_user_id) or User(slack_user_id=slack_user_id, slack_user_name=slack_user_name, points=0)
            ),
        )
        monkeypatch.setattr(
            user_logic.UserRepo,
            "update_points",
            lambda slack_user_id, points: (
                updated.append((slack_user_id, points)) or User(slack_user_id=slack_user_id, points=points)
            ),
        )
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", Mock())

        awarded = user_logic.award_points(["U1", "U2"], lambda slack_user_id: "ada")

        assert [user.slack_user_id for user in awarded] == ["U1", "U2"]
        assert updated == [("U1", 10), ("U2", 10)]
        assert created == ["U2"]

    def test_database_exception_propagates_after_earlier_users(self, monkeypatch):
        first = User(slack_user_id="U1", slack_user_name="ada", points=1)
        updated = []

        def get_user(slack_user_id: str):
            if slack_user_id == "U2":
                raise UserNotFoundException()
            return first

        monkeypatch.setattr(user_logic.UserRepo, "get_user", get_user)
        monkeypatch.setattr(
            user_logic,
            "register_user",
            Mock(side_effect=DatabaseException(code="500", message="Internal server error")),
        )
        monkeypatch.setattr(
            user_logic.UserRepo,
            "update_points",
            lambda slack_user_id, points: updated.append((slack_user_id, points)) or first,
        )
        monkeypatch.setattr(user_logic.LedgerRepo, "add_entry", Mock())

        with pytest.raises(DatabaseException):
            user_logic.award_points(["U1", "U2"], lambda slack_user_id: "ada")

        assert updated == [("U1", 11)]


class TestSlackUserLookup:
    def test_display_name_reads_slack_profile(self, monkeypatch):
        captured = {}

        def get(url, headers):
            captured["url"] = url
            captured["headers"] = headers
            response = Mock()
            response.json.return_value = {"ok": True, "user": {"name": "ada"}}
            return response

        monkeypatch.setattr(slack_data.requests, "get", get)

        assert slack_data.display_name("U123") == "ada"
        assert captured["url"].endswith("user=U123")
        assert captured["headers"]["Authorization"].startswith("Bearer ")

    def test_display_name_raises_when_slack_omits_the_user(self, monkeypatch):
        response = Mock()
        response.json.return_value = {"ok": False, "error": "user_not_found"}
        monkeypatch.setattr(slack_data.requests, "get", lambda url, headers: response)

        with pytest.raises(KeyError):
            slack_data.display_name("U999")

    def test_display_name_propagates_request_failures(self, monkeypatch):
        monkeypatch.setattr(
            slack_data.requests,
            "get",
            Mock(side_effect=requests.ConnectionError("slack unreachable")),
        )

        with pytest.raises(requests.ConnectionError, match="slack unreachable"):
            slack_data.display_name("U1")

    def test_display_name_raises_when_body_is_not_json(self, monkeypatch):
        response = Mock()
        response.json.side_effect = requests.JSONDecodeError("bad", "doc", 0)
        monkeypatch.setattr(slack_data.requests, "get", lambda url, headers: response)

        with pytest.raises(requests.JSONDecodeError):
            slack_data.display_name("U1")


class TestLeaderboard:
    def test_top_users_asks_the_repository_for_the_limit(self, monkeypatch):
        leaders = [User(slack_user_id="U1", slack_user_name="ada", points=3)]
        monkeypatch.setattr(user_logic.UserRepo, "get_top", lambda limit: leaders if limit == 5 else [])

        assert user_logic.top_users() == leaders
