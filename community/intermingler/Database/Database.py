import os

from dotenv import load_dotenv
from supabase import Client, create_client

from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import exception_decorator

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# Check if the Supabase environment variables are set
if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing Supabase environment variables")

# Create a Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# Add a user to the database to track user's points
@exception_decorator
def add_user(user: User) -> User:
    response = supabase.table("user").insert(user.model_dump()).execute()
    return User.model_validate(response.data[0], extra="ignore")


# Get a user from the database by their slack user id
@exception_decorator
def get_user(slack_user_id: str) -> User:
    response = supabase.table("user").select("*").eq("slack_user_id", slack_user_id).limit(1).execute()
    return User.model_validate(response.data[0], extra="ignore")


# Update a user's points in the database
@exception_decorator
def update_user(slack_user_id: str, new_points: int) -> User:
    response = supabase.table("user").update({"points": new_points}).eq("slack_user_id", slack_user_id).execute()
    return User.model_validate(response.data[0], extra="ignore")


# Get the top five user by points
@exception_decorator
def get_top_five_user() -> list[User]:
    response = supabase.table("user").select("*").order("points", desc=True).limit(5).execute()
    return [User.model_validate(user, extra="ignore") for user in response.data]


# Delete a user from the database
@exception_decorator
def delete_user(slack_user_id: str) -> User:
    response = supabase.table("user").delete().eq("slack_user_id", slack_user_id).execute()        
    return User.model_validate(response.data[0], extra="ignore")
