from unittest.mock import Mock

import pytest
import requests

import BusinessLogic.PointDist as point_dist
from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import UserAlreadyExistsException, UserNotFoundException


class TestIdentifyUsers:
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
        assert point_dist.identify_users_helper({"text": text}) == expected

    def test_missing_text_raises(self):
        with pytest.raises(KeyError):
            point_dist.identify_users_helper({})

    def test_none_event_raises(self):
        with pytest.raises(TypeError):
            point_dist.identify_users_helper(None)


class TestAddUser:
    def test_add_user_stores_slack_display_name(self, monkeypatch):
        monkeypatch.setattr(point_dist, "get_user_name", lambda slack_user_id: "ada")
        stored = {}

        def add_user(user: User) -> User:
            stored["user"] = user
            return user

        monkeypatch.setattr(point_dist.Database, "add_user", add_user)

        saved = point_dist.add_user("U1")

        assert saved.slack_user_name == "ada"
        assert stored["user"].slack_user_id == "U1"
        assert stored["user"].points == 0

    def test_add_user_propagates_lookup_failure(self, monkeypatch):
        monkeypatch.setattr(point_dist, "get_user_name", Mock(side_effect=KeyError("user")))
        add_user = Mock()
        monkeypatch.setattr(point_dist.Database, "add_user", add_user)

        with pytest.raises(KeyError):
            point_dist.add_user("U1")

        add_user.assert_not_called()

    def test_add_user_through_message_returns_added_names(self, monkeypatch):
        def add_user(slack_user_id: str) -> User:
            return User(slack_user_id=slack_user_id, slack_user_name=f"name-{slack_user_id}")

        monkeypatch.setattr(point_dist, "add_user", add_user)

        assert point_dist.add_user_through_message({"text": "add <@U1|ada> <@U2>"}) == ["name-U1", "name-U2"]

    def test_add_user_through_message_with_no_mentions_adds_nobody(self, monkeypatch):
        add_user = Mock()
        monkeypatch.setattr(point_dist, "add_user", add_user)

        assert point_dist.add_user_through_message({"text": "add nobody"}) == []
        add_user.assert_not_called()

    def test_add_user_through_message_stops_when_a_later_user_fails(self, monkeypatch):
        seen = []

        def add_user(slack_user_id: str) -> User:
            seen.append(slack_user_id)
            if slack_user_id == "U2":
                raise UserAlreadyExistsException()
            return User(slack_user_id=slack_user_id, slack_user_name="ada")

        monkeypatch.setattr(point_dist, "add_user", add_user)

        with pytest.raises(UserAlreadyExistsException):
            point_dist.add_user_through_message({"text": "add <@U1> <@U2> <@U3>"})

        assert seen == ["U1", "U2"]


class TestIncrementPoints:
    def test_no_mentions_skips_the_database(self, monkeypatch):
        get_user = Mock()
        monkeypatch.setattr(point_dist.Database, "get_user", get_user)

        assert point_dist.increment_points_helper({"text": "people"}) is True
        get_user.assert_not_called()

    def test_existing_user_gains_ten_points(self, monkeypatch):
        user = User(slack_user_id="U1", slack_user_name="ada", points=5)
        updated = {}
        monkeypatch.setattr(point_dist.Database, "get_user", lambda slack_user_id: user)

        def update_user(slack_user_id: str, points: int) -> User:
            updated["slack_user_id"] = slack_user_id
            updated["points"] = points
            return user

        monkeypatch.setattr(point_dist.Database, "update_user", update_user)
        monkeypatch.setattr(point_dist.Database, "add_user", Mock(side_effect=AssertionError("should not add")))

        assert point_dist.increment_points_helper({"text": "people <@U1>"}) is True
        assert updated == {"slack_user_id": "U1", "points": 15}
        assert user.points == 15

    def test_missing_user_is_created_with_ten_points(self, monkeypatch):
        created = {}
        monkeypatch.setattr(point_dist.Database, "get_user", lambda slack_user_id: None)

        def add_user(user: User) -> User:
            created["user"] = user
            return user

        monkeypatch.setattr(point_dist.Database, "add_user", add_user)
        monkeypatch.setattr(point_dist.Database, "update_user", Mock(side_effect=AssertionError("should not update")))

        assert point_dist.increment_points_helper({"text": "<@U2>"}) is True
        assert created["user"].slack_user_id == "U2"
        assert created["user"].points == 10
        assert created["user"].slack_user_name == ""

    def test_mixed_mentions_update_and_create(self, monkeypatch):
        existing = User(slack_user_id="U1", slack_user_name="ada", points=0)

        def get_user(slack_user_id: str):
            if slack_user_id == "U1":
                return existing
            return None

        created = []
        updated = []
        monkeypatch.setattr(point_dist.Database, "get_user", get_user)
        monkeypatch.setattr(point_dist.Database, "add_user", lambda user: created.append(user) or user)
        monkeypatch.setattr(
            point_dist.Database,
            "update_user",
            lambda slack_user_id, points: updated.append((slack_user_id, points)),
        )

        assert point_dist.increment_points_helper({"text": "<@U1> <@U2>"}) is True
        assert updated == [("U1", 10)]
        assert [user.slack_user_id for user in created] == ["U2"]

    def test_database_exception_propagates_after_earlier_users(self, monkeypatch):
        first = User(slack_user_id="U1", slack_user_name="ada", points=1)
        updated = []

        def get_user(slack_user_id: str):
            if slack_user_id == "U2":
                raise UserNotFoundException()
            return first

        monkeypatch.setattr(point_dist.Database, "get_user", get_user)
        monkeypatch.setattr(
            point_dist.Database,
            "update_user",
            lambda slack_user_id, points: updated.append((slack_user_id, points)),
        )

        with pytest.raises(UserNotFoundException):
            point_dist.increment_points_helper({"text": "<@U1> <@U2>"})

        assert updated == [("U1", 11)]


class TestSlackUserLookup:
    def test_get_user_name_reads_slack_profile(self, monkeypatch):
        captured = {}

        def get(url, headers):
            captured["url"] = url
            captured["headers"] = headers
            response = Mock()
            response.json.return_value = {"ok": True, "user": {"name": "ada"}}
            return response

        monkeypatch.setattr(point_dist.requests, "get", get)

        assert point_dist.get_user_name("U123") == "ada"
        assert captured["url"].endswith("user=U123")
        assert captured["headers"]["Authorization"].startswith("Bearer ")

    def test_get_user_name_raises_when_slack_omits_the_user(self, monkeypatch):
        response = Mock()
        response.json.return_value = {"ok": False, "error": "user_not_found"}
        monkeypatch.setattr(point_dist.requests, "get", lambda url, headers: response)

        with pytest.raises(KeyError):
            point_dist.get_user_name("U999")

    def test_get_user_name_propagates_request_failures(self, monkeypatch):
        monkeypatch.setattr(
            point_dist.requests,
            "get",
            Mock(side_effect=requests.ConnectionError("slack unreachable")),
        )

        with pytest.raises(requests.ConnectionError, match="slack unreachable"):
            point_dist.get_user_name("U1")

    def test_get_user_name_raises_when_body_is_not_json(self, monkeypatch):
        response = Mock()
        response.json.side_effect = requests.JSONDecodeError("bad", "doc", 0)
        monkeypatch.setattr(point_dist.requests, "get", lambda url, headers: response)

        with pytest.raises(requests.JSONDecodeError):
            point_dist.get_user_name("U1")


class TestLeaderboardLookup:
    def test_get_top_five_users_delegates_to_the_database(self, monkeypatch):
        leaders = [User(slack_user_id="U1", slack_user_name="ada", points=3)]
        monkeypatch.setattr(point_dist.Database, "get_top_five_users", lambda: leaders)

        assert point_dist.get_top_five_users() is leaders
