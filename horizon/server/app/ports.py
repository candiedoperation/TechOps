"""Integration seams, NOT an assertion that planned database tables exist."""

from collections.abc import Sequence
from typing import Protocol
from uuid import UUID

from .auth import Principal
from .errors import ReadUnavailable
from .models import MemberRow, Project, Run, Semester


class ReadStore(Protocol):
    def projects_for(self, user_pk: str) -> list[Project]: ...
    def semesters(self) -> list[Semester]: ...
    def runs(self, season_type: str, season_year: int) -> Sequence[Run]: ...
    def rows(self, run_id: UUID) -> Sequence[MemberRow]: ...


class RankingAudit(Protocol):
    # The approved Track 7 adapter must durably accept the read before records leave the API.
    def record_read(
        self, user: Principal, action: str, run_id: UUID, member_pk: str | None
    ) -> None: ...


class UnavailableStore:
    def __getattr__(self, name):
        raise ReadUnavailable()


def get_store() -> ReadStore:
    # Track 4 publications and project memberships have no checked-in schema.
    # Never silently substitute roster/source tables or fictional records here.
    return UnavailableStore()


def get_audit() -> RankingAudit:
    # Missing audit storage/policy must block executive ranking reads, not skip audit.
    raise ReadUnavailable()
