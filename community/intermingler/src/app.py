import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from BusinessLogic.UserLogic import award_points, register_user, top_users
from Database.DatabaseErrors.DatabaseError import DatabaseException, UserAlreadyExistsException, UserNotFoundException
from listeners import register_listeners
from logging_config import configure_logging
from SlackDataNormalizer import display_name, with_mentioned_users

configure_logging()

app = App(token=os.environ.get("SLACK_BOT_TOKEN"))

register_listeners(app)


@app.message("people")
@with_mentioned_users
def increment_points(event, message, say):
    awarded = award_points(event, display_name)
    names = ", ".join(user.slack_user_name for user in awarded)
    say(f"points updated for {names}")


@app.message("add")
@with_mentioned_users
def add_user(event, message, say):
    print(event)
    added = [register_user(user_id, display_name(user_id)) for user_id in event]
    print(added)
    names = ", ".join(user.slack_user_name for user in added)
    say(f"users {names} added to the competition!")


@app.event("member_joined_channel")
def member_joined_channel(body, say):
    user = register_user(body["user"], display_name(body["user"]))
    say(f"user {user.slack_user_name} joined the competition!")


@app.message("leaderboard")
def leaderboard(say):
    lines = [f"@{user.slack_user_name}: {user.points}" for user in top_users()]
    say("\n".join(lines))


@app.error
def error_handler(error, say):
    if isinstance(error, UserAlreadyExistsException):
        say(f"User already exists: {error.code}")
    elif isinstance(error, UserNotFoundException):
        say(f"User not found: {error.code}")
    elif isinstance(error, DatabaseException):
        say(f"Internal server error: {error.code}")
    else:
        say(f"Unknown error: {error}")


if __name__ == "__main__":
    SocketModeHandler(app, os.environ.get("SLACK_APP_TOKEN")).start()
