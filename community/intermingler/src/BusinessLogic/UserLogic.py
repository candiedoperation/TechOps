from BusinessLogic.models.UserModel import User
from Database.DatabaseErrors.DatabaseError import UserNotFoundException
from Repository import LedgerRepo, UserRepo

POINTS_PER_MENTION = 10


def register_user(slack_user_id: str, slack_user_name: str) -> User:
    user = UserRepo.create_user(User(slack_user_id=slack_user_id, slack_user_name=slack_user_name, points=0))
    LedgerRepo.add_entry(slack_user_id, 0, "set", "User added to the database")
    return user


def award_points(user_ids: list[str], display_name) -> list[User]:
    awarded = []
    for slack_user_id in user_ids:
        try:
            user = UserRepo.get_user(slack_user_id)
        except UserNotFoundException:
            user = register_user(slack_user_id, display_name(slack_user_id))
        user.points += POINTS_PER_MENTION
        user = UserRepo.update_points(user.slack_user_id, user.points)
        LedgerRepo.add_entry(user.slack_user_id, POINTS_PER_MENTION, "increment", "User participated in intermingling")
        awarded.append(user)
    return awarded


def top_users(limit: int = 5) -> list[User]:
    return UserRepo.get_top(limit)
