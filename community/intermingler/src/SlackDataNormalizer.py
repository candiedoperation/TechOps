import os
import re
from functools import wraps

import requests

USER_MENTION = re.compile(r"<@([^|>]+)")


def mentioned_user_ids(event: dict) -> list[str]:
    return USER_MENTION.findall(event["text"])


def display_name(slack_user_id: str) -> str:
    response = requests.get(
        f"https://slack.com/api/users.info?user={slack_user_id}",
        headers={"Authorization": f"Bearer {os.environ.get('SLACK_BOT_TOKEN')}"},
    )
    return response.json()["user"]["name"]


def with_mentioned_users(func):
    @wraps(func)
    def wrapper(event, *args, **kwargs):
        return func(event=mentioned_user_ids(event), *args, **kwargs)

    return wrapper
