from typing import Optional

from pydantic import BaseModel


class User(BaseModel):
    slack_user_id: str
    slack_user_name: str = ""
    points: int = 0
