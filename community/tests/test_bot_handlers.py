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
        message = {"text": "people <@U1>"}
        monkeypatch.setattr(
            bot,
            "award_points",
            lambda user_ids, name_for: [User(slack_user_id="U1", slack_user_name="ada", points=10)],
        )

        bot.increment_points(message, say)

        say.assert_called_once_with("points updated for ada")

    def test_passes_parsed_ids_to_award_points(self, monkeypatch):
        say = Mock()
        seen = {}

        def award(user_ids, name_for):
            seen["user_ids"] = user_ids
            seen["name_for"] = name_for
            return []

        monkeypatch.setattr(bot, "award_points", award)

        bot.increment_points({"text": "people <@U1> <@U2>"}, say)

        assert seen["user_ids"] == ["U1", "U2"]
        assert seen["name_for"] is bot.display_name
        say.assert_called_once_with("points updated for ")

    def test_missing_user_is_reported(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "award_points", Mock(side_effect=UserNotFoundException()))

        with pytest.raises(UserNotFoundException):
            bot.increment_points({"text": "people <@U9>"}, say)

        say.assert_not_called()

    def test_other_database_errors_propagate(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(
            bot,
            "award_points",
            Mock(side_effect=DatabaseException(code="500", message="Internal server error")),
        )

        with pytest.raises(DatabaseException):
            bot.increment_points({"text": "people <@U1>"}, say)

        say.assert_not_called()

    def test_say_failures_propagate(self, monkeypatch):
        say = Mock(side_effect=RuntimeError("slack down"))
        monkeypatch.setattr(bot, "award_points", lambda user_ids, name_for: [])

        with pytest.raises(RuntimeError, match="slack down"):
            bot.increment_points({"text": "people <@U1>"}, say)


class TestAddUserHandler:
    def test_success_lists_added_names(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "display_name", lambda slack_user_id: {"U1": "ada", "U2": "grace"}[slack_user_id])
        monkeypatch.setattr(
            bot,
            "register_user",
            lambda slack_user_id, slack_user_name: User(slack_user_id=slack_user_id, slack_user_name=slack_user_name),
        )

        bot.add_user({"text": "add <@U1> <@U2>"}, say)

        say.assert_called_once_with("users ada, grace added to the competition!")

    def test_no_mentions_still_replies(self, monkeypatch):
        say = Mock()
        register = Mock()
        monkeypatch.setattr(bot, "register_user", register)

        bot.add_user({"text": "add"}, say)

        register.assert_not_called()
        say.assert_called_once_with("users  added to the competition!")

    def test_duplicate_user_is_reported(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "display_name", lambda slack_user_id: "ada")
        monkeypatch.setattr(bot, "register_user", Mock(side_effect=UserAlreadyExistsException()))

        with pytest.raises(UserAlreadyExistsException):
            bot.add_user({"text": "add <@U1>"}, say)

        say.assert_not_called()

    def test_user_not_found_is_not_caught(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "display_name", lambda slack_user_id: "ada")
        monkeypatch.setattr(bot, "register_user", Mock(side_effect=UserNotFoundException()))

        with pytest.raises(UserNotFoundException):
            bot.add_user({"text": "add <@U9>"}, say)

        say.assert_not_called()


class TestMemberJoinedHandler:
    def test_success_adds_the_joining_user(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "display_name", lambda slack_user_id: "ada")
        register = Mock(return_value=User(slack_user_id="U42", slack_user_name="ada"))
        monkeypatch.setattr(bot, "register_user", register)

        bot.member_joined_channel({"user": "U42"}, say)

        register.assert_called_once_with("U42", "ada")
        say.assert_called_once_with("user ada joined the competition!")

    def test_duplicate_join_is_reported(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "display_name", lambda slack_user_id: "ada")
        monkeypatch.setattr(bot, "register_user", Mock(side_effect=UserAlreadyExistsException()))

        with pytest.raises(UserAlreadyExistsException):
            bot.member_joined_channel({"user": "U42"}, say)

        say.assert_not_called()

    def test_missing_user_field_propagates(self):
        say = Mock()

        with pytest.raises(KeyError):
            bot.member_joined_channel({}, say)

        say.assert_not_called()


class TestLeaderboardHandler:
    def test_formats_ranked_users(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(
            bot,
            "top_users",
            lambda: [
                User(slack_user_id="U1", slack_user_name="ada", points=30),
                User(slack_user_id="U2", slack_user_name="grace", points=10),
            ],
        )

        bot.leaderboard(say)

        say.assert_called_once_with("@ada: 30\n@grace: 10")

    def test_empty_leaderboard_replies_with_an_empty_message(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "top_users", lambda: [])

        bot.leaderboard(say)

        say.assert_called_once_with("")

    def test_blank_display_name_is_still_rendered(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "top_users", lambda: [User(slack_user_id="U1", slack_user_name="", points=0)])

        bot.leaderboard(say)

        say.assert_called_once_with("@: 0")

    def test_database_failure_is_reported(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(
            bot,
            "top_users",
            Mock(side_effect=DatabaseException(code="500", message="Internal server error")),
        )

        with pytest.raises(DatabaseException):
            bot.leaderboard(say)

        say.assert_not_called()

    def test_unexpected_errors_propagate(self, monkeypatch):
        say = Mock()
        monkeypatch.setattr(bot, "top_users", Mock(side_effect=RuntimeError("query failed")))

        with pytest.raises(RuntimeError, match="query failed"):
            bot.leaderboard(say)

        say.assert_not_called()
