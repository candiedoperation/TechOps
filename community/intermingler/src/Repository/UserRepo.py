from datetime import datetime

from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import exception_decorator
from Database.SupabaseClient import get_supabase

supabase = get_supabase()


@exception_decorator
def get_user(slack_user_id: str) -> User:
    response = supabase.table("user").select("*").eq("slack_user_id", slack_user_id).limit(1).execute()
    return User.model_validate(response.data[0], extra="ignore")


@exception_decorator
def create_user(user: User) -> User:
    response = supabase.table("user").insert(user.model_dump()).execute()
    return User.model_validate(response.data[0], extra="ignore")


@exception_decorator
def update_points(slack_user_id: str, points: int) -> User:
    response = (
        supabase.table("user")
        .update({"points": points, "updated_at": datetime.now()})
        .eq("slack_user_id", slack_user_id)
        .execute()
    )
    return User.model_validate(response.data[0], extra="ignore")


@exception_decorator
def get_top(limit: int) -> list[User]:
    response = supabase.table("user").select("*").order("points", desc=True).limit(limit).execute()
    return [User.model_validate(row, extra="ignore") for row in response.data]


@exception_decorator
def delete_user(slack_user_id: str) -> User:
    response = supabase.table("user").delete().eq("slack_user_id", slack_user_id).execute()
    return User.model_validate(response.data[0], extra="ignore")
