from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class PointLedger(BaseModel):
    slack_user_id: str
    points_updated: int
    action: Literal["increment", "decrement", "set"]
    reason: str
    created_at: datetime = datetime.now()
