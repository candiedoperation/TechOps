from typing import Literal

from BusinessLogic.models.PointLedgerModel import PointLedger
from Database.DatabaseErrors.DatabaseError import exception_decorator
from Database.SupabaseClient import get_supabase

supabase = get_supabase()


@exception_decorator
def add_entry(
    slack_user_id: str,
    points_updated: int,
    action: Literal["increment", "decrement", "set"],
    reason: str,
) -> PointLedger:
    entry = PointLedger(slack_user_id=slack_user_id, points_updated=points_updated, action=action, reason=reason)
    response = supabase.table("points-ledger").insert(entry.model_dump()).execute()
    return PointLedger.model_validate(response.data[0], extra="ignore")
