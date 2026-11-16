import os
from unittest.mock import Mock, patch

import pytest

os.environ["SLACK_BOT_TOKEN"] = "xoxb-test"
os.environ["SLACK_APP_TOKEN"] = "xapp-test"

with patch(
    "slack_sdk.web.client.WebClient.auth_test",
    return_value={"ok": True, "user_id": "UBOT", "team_id": "T1", "bot_id": "B1"},
):
    import app as bot
from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import (
    DatabaseException,
    UserAlreadyExistsException,
    UserNotFoundException,
)


class TestIncrementPointsHandler:
    def test_success_confirms_the_update(self, monkeypatch):
        say = Mock()
        helper = Mock(return_value=True)
        message = {"text": "people <@U1>"}
        monkeypatch.setattr(bot.PointDist, "increment_points_helper", helper)

        bot.increment_points(message, say)

        helper.assert_called_once_with(message)
        say.assert_called_once_with("points updated!")

    def test_missing_user_is_reported(self, monkeypatch):
        say = Mock()

        def helper(_message):
            raise UserNotFoundException()

        monkeypatch.setattr(bot.PointDist, "increment_points_helper", helper)

        bot.increment_points({"text": "people <@U9>"}, say)

        say.assert_called_once_with("User not found: User not found")

    def test_other_database_errors_propagate(self, monkeypatch):
        say = Mock()

        def helper(_message):
            raise DatabaseException(code="500", message="Internal server error")

        monkeypatch.setattr(bot.PointDist, "increment_points_helper", helper)

        with pytest.raises(DatabaseException):
            bot.increment_points({"text": "people <@U1>"}, say)

        say.assert_not_called()

    def test_say_failures_propagate(self, monkeypatch):
        say = Mock(side_effect=RuntimeError("slack down"))
        monkeypatch.setattr(bot.PointDist, "increment_points_helper", Mock(return_value=True))

        with pytest.raises(RuntimeError, match="slack down"):
            bot.increment_points({"text": "people <@U1>"}, say)


class TestAddUserHandler:
    def test_success_lists_added_names(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot.PointDist, "add_user_through_message", lambda message: ["ada", "grace"])

        bot.add_user({"text": "add <@U1> <@U2>"}, say)

        say.assert_called_once_with("users ada, grace added to the competition!")

    def test_no_mentions_still_replies(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot.PointDist, "add_user_through_message", lambda message: [])

        bot.add_user({"text": "add"}, say)

        say.assert_called_once_with("users  added to the competition!")

    def test_duplicate_user_is_reported(self, monkeypatch):
        say = Mock()

        def add_users(_message):
            raise UserAlreadyExistsException()

        monkeypatch.setattr(bot.PointDist, "add_user_through_message", add_users)

        bot.add_user({"text": "add <@U1>"}, say)

        say.assert_called_once_with("Could not add users: 409 - User already exists")

    def test_user_not_found_is_not_caught(self, monkeypatch):
        say = Mock()

        def add_users(_message):
            raise UserNotFoundException()

        monkeypatch.setattr(bot.PointDist, "add_user_through_message", add_users)

        with pytest.raises(UserNotFoundException):
            bot.add_user({"text": "add <@U9>"}, say)

        say.assert_not_called()


class TestMemberJoinedHandler:
    def test_success_adds_the_joining_user(self, monkeypatch):
        say = Mock()
        add_user = Mock()
        monkeypatch.setattr(bot.PointDist, "add_user", add_user)

        bot.member_joined_channel({"user": "U42"}, say)

        add_user.assert_called_once_with("U42")
        say.assert_called_once_with("user U42 joined the competition!")

    def test_duplicate_join_is_reported(self, monkeypatch):
        say = Mock()

        def add_user(_user):
            raise UserAlreadyExistsException()

        monkeypatch.setattr(bot.PointDist, "add_user", add_user)

        bot.member_joined_channel({"user": "U42"}, say)

        say.assert_called_once_with("Could not add user: 409 - User already exists")

    def test_missing_user_field_propagates(self):
        say = Mock()

        with pytest.raises(KeyError):
            bot.member_joined_channel({}, say)

        say.assert_not_called()


class TestLeaderboardHandler:
    def test_formats_ranked_users(self, monkeypatch):
        say = Mock()
        leaders = [
            User(slack_user_id="U1", slack_user_name="ada", points=30),
            User(slack_user_id="U2", slack_user_name="grace", points=10),
        ]
        monkeypatch.setattr(bot.PointDist, "get_top_five_users", lambda: leaders)

        bot.leaderboard(say)

        say.assert_called_once_with("@ada: 30\n@grace: 10")

    def test_empty_leaderboard_replies_with_an_empty_message(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot.PointDist, "get_top_five_users", lambda: [])

        bot.leaderboard(say)

        say.assert_called_once_with("")

    def test_blank_display_name_is_still_rendered(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(
            bot.PointDist,
            "get_top_five_users",
            lambda: [User(slack_user_id="U1", slack_user_name="", points=0)],
        )

        bot.leaderboard(say)

        say.assert_called_once_with("@: 0")

    def test_database_failure_is_reported(self, monkeypatch):
        say = Mock()

        def leaders():
            raise DatabaseException(code="500", message="Internal server error")

        monkeypatch.setattr(bot.PointDist, "get_top_five_users", leaders)

        bot.leaderboard(say)

        say.assert_called_once_with("Could not get leaderboard: 500 - Internal server error")

    def test_unexpected_errors_propagate(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot.PointDist, "get_top_five_users", Mock(side_effect=RuntimeError("query failed")))

        with pytest.raises(RuntimeError, match="query failed"):
            bot.leaderboard(say)

        say.assert_not_called()
