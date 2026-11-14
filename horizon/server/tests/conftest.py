from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.auth import Principal, current_user
from app.config import Settings
from app.main import create_app
from app.models import (
    Bucket,
    Evidence,
    Explanation,
    MemberRow,
    Metric,
    Project,
    RankingRow,
    Run,
    Semester,
)
from app.ports import get_audit, get_store


class FictionalStore:
    def __init__(self):
        now = datetime.now(timezone.utc)
        self.publications = [
            Run(
                ranking_run_id=UUID(int=index),
                season_type="FALL",
                season_year=2026,
                as_of=now - timedelta(days=12 - index),
                is_final=index in (1, 2),
                status="complete"
                if index < 4
                else "failed"
                if index == 4
                else "running",
                rubric_version="fictional-rubric-v1",
            )
            for index in range(1, 6)
        ]
        self.publications.append(
            Run(
                ranking_run_id=UUID(int=6),
                season_type="SPRING",
                season_year=2026,
                as_of=now,
                is_final=False,
                status="complete",
                rubric_version="fictional-v1",
            )
        )

    def projects_for(self, user_pk):
        return (
            [Project(project_pk="fiction-project", friendly_name="Fictional Lantern")]
            if user_pk == "fiction-exec"
            else []
        )

    def semesters(self):
        return [Semester(season_type="FALL", season_year=2026)]

    def runs(self, season_type, season_year):
        return [
            run
            for run in self.publications
            if run.season_type == season_type and run.season_year == season_year
        ]

    def rows(self, run_id):
        values = []
        # Input deliberately unsorted. Numeric values model persisted outputs, never API scoring.
        for index in (3, 1, 4, 2):
            missing = index == 4
            ranking = RankingRow(
                user_pk=f"fiction-user-{index}",
                name=f"Fictional Member {index}",
                project_pk="fiction-project" if index < 3 else "fiction-other",
                project_name="Fictional Lantern",
                role="engineer" if index < 3 else "tech_lead",
                comparison_group="a" if index < 3 else "b",
                overall_score=None if missing else 90 - index - int(run_id),
                coverage=0 if missing else 0.8,
                status="insufficient_data" if missing else "ranked",
                rank_in_group=None if missing else index,
                ranked_in_group=3,
                buckets=[
                    Bucket(
                        bucket_key="fiction-bucket",
                        weight=1,
                        score=None if missing else 80,
                    )
                ],
            )
            values.append(
                MemberRow(
                    ranking=ranking,
                    metrics=[
                        Metric(
                            metric_key="fiction-metric",
                            missing_reason="Fictional evidence absent",
                        )
                    ],
                    evidence=[]
                    if missing
                    else [
                        Evidence(
                            evidence_id="fiction-evidence",
                            source_type="fixture",
                            reference="fiction-reference",
                        )
                    ],
                    explanations=[]
                    if missing
                    else [
                        Explanation(
                            text="Fictional generated explanation",
                            model_version="fixture-model",
                        )
                    ],
                )
            )
        return values


class RecordingAudit:
    def __init__(self):
        self.events = []

    def record_read(self, *event):
        self.events.append(event)


@pytest.fixture
def api():
    application = create_app(Settings(_env_file=None))
    store, audit = FictionalStore(), RecordingAudit()
    application.dependency_overrides[get_store] = lambda: store
    application.dependency_overrides[get_audit] = lambda: audit
    with TestClient(application) as client:
        yield client, application, store, audit
    application.dependency_overrides.clear()


@pytest.fixture
def executive(api):
    client, application, store, audit = api
    application.dependency_overrides[current_user] = lambda: Principal(
        "fiction-exec", "Fictional Executive", True
    )
    return client, application, store, audit
