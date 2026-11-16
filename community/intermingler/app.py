import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from BusinessLogic import PointDist
from Database.DatabaseErrors.DatabaseError import UserNotFoundException, UserAlreadyExistsException, DatabaseException
from listeners import register_listeners
from logging_config import configure_logging

configure_logging()

app = App(token=os.environ.get("SLACK_BOT_TOKEN"))

# Register Listeners
register_listeners(app)


@app.message("people")
def increment_points(message, say):
    try:
        PointDist.increment_points_helper(message)
        say("points updated!")
    except UserNotFoundException as error:
        say(f"User not found: {error.message}")


@app.message("add")
def add_user(message, say):
    try:
        users = PointDist.add_user_through_message(message)
        say(f"users {', '.join(users)} added to the competition!")
    except UserAlreadyExistsException as error:
        say(f"Could not add users: {error.code} - {error.message}")


@app.event("member_joined_channel")
def member_joined_channel(body, say):
    try:
        PointDist.add_user(body["user"])
        say(f"user {body['user']} joined the competition!")
    except UserAlreadyExistsException as error:
        say(f"Could not add user: {error.code} - {error.message}")


@app.message("leaderboard")
def leaderboard(say):
    try:
        temp_leaderboard = []
        leaderboard = PointDist.get_top_five_users()
        for user in leaderboard:
            temp_leaderboard.append(f"@{user.slack_user_name}: {user.points}")
        say("\n".join(temp_leaderboard))
    except DatabaseException as error:
        say(f"Could not get leaderboard: {error.code} - {error.message}")


@app.error
def error_handler(error, say):
    if isinstance(error, UserAlreadyExistsException):
        say(f"User already exists: {error.code}")
    elif isinstance(error, UserNotFoundException):
        say(f"User not found: {error.code}")
    elif isinstance(error, DatabaseException):
        say(f"Database error: {error.code}")
    else:
        say(f"Unknown error: {error.message}")

if __name__ == "__main__":
    SocketModeHandler(app, os.environ.get("SLACK_APP_TOKEN")).start()
