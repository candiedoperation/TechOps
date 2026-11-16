import re
import os
import requests
import Database.Database as Database
from BusinessLogic.models.UserModel import User
from dotenv import load_dotenv

load_dotenv()

# Regular expression to match user mentions in the event text
USER_MENTION = re.compile(r"<@([^|>]+)")
SLACK_BOT_TOKEN = os.environ.get('SLACK_BOT_TOKEN')


# Identify users mentioned in the event
def identify_users_helper(event) -> list[str]:
    return USER_MENTION.findall(event["text"])


# Add a user to the database
def add_user(slack_user_id: str) -> User:
    user_name = get_user_name(slack_user_id)
    return Database.add_user(User(slack_user_id=slack_user_id, slack_user_name=user_name))


# Add a user to the database from a message
def add_user_through_message(message: str) -> list[str]:
    users_list = []
    users = identify_users_helper(message)
    for user in users:
        users_list.append(add_user(user).slack_user_name)
    return users_list


# Increment points for the users mentioned in the event
def increment_points_helper(event) -> bool:
    users = identify_users_helper(event)
    for user in users:
        temp = Database.get_user(user)
        if temp is None:
            Database.add_user(User(slack_user_id=user, points=10))
            continue
        temp.points += 10
        Database.update_user(temp.slack_user_id, temp.points)
    return True


# Get the top five users by points
def get_top_five_users() -> list[User]:
    return Database.get_top_five_users()


# Get the name of a user from their slack user id
def get_user_name(slack_user_id: str) -> str:
    res = requests.get(
        f"https://slack.com/api/users.info?user={slack_user_id}"
        , headers={"Authorization": f"Bearer {SLACK_BOT_TOKEN}"})
    res = res.json()
    return res["user"]["name"]