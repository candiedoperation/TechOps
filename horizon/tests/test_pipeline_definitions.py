from dagster import AssetKey, Definitions

from pipeline.assets.parse import _PARSED_ATTRIBUTES
from pipeline.config import PipelineSettings
from pipeline.definitions import defs
from pipeline.resources import (
    AuthentikClient,
    GiteaClient,
    GitWorkspace,
    PostgresResource,
    build_resources,
)


ASSET_KEYS = {
    AssetKey("gitea_repository"),
    AssetKey("authentik_users"),
    AssetKey("gitea_pull_request_reviews"),
    AssetKey("gitea_pull_request_commits"),
    AssetKey("blame_capture"),
    AssetKey("blame_records"),
    AssetKey("file_ownership"),
    AssetKey("member_repository_ownership"),
    AssetKey("member_ownership"),
    AssetKey("identity_clusters"),
    AssetKey("eligible_file_ownership"),
    AssetKey("engineering_contribution"),
    AssetKey("member_pr_review_counts"),
    AssetKey("pr_linked_commit_messages"),
    AssetKey("feature_store_schema"),
    AssetKey("pipeline_run_started"),
    AssetKey("pipeline_run_completed"),
    AssetKey("persist_blame_records"),
    AssetKey("persist_authentik_roster_snapshot"),
    AssetKey("persist_git_identity_mapping"),
    AssetKey("persist_file_ownership"),
    AssetKey("persist_member_repository_ownership"),
    AssetKey("persist_member_ownership"),
    AssetKey("persist_eligible_file_ownership"),
    AssetKey("persist_engineering_contribution"),
    AssetKey("persist_member_pr_review_counts"),
    AssetKey("persist_pr_linked_commit_messages"),
}


def test_definitions_expose_the_blame_assets():
    assert isinstance(defs, Definitions)
    assert set(defs.resolve_all_asset_keys()) == ASSET_KEYS


def test_definitions_resolve_into_a_repository():
    """This is what `dagster dev` does on boot, so it catches bad wiring here."""
    assert set(defs.get_repository_def().assets_defs_by_key) == ASSET_KEYS


def test_the_layers_depend_on_each_other_in_order():
    """The graph, not the import order, is what makes each layer follow the last."""
    assets_by_key = defs.get_repository_def().assets_defs_by_key

    def deps_of(name):
        key = AssetKey(name)
        return assets_by_key[key].asset_deps[key]

    assert AssetKey("gitea_repository") in deps_of("blame_capture")
    assert AssetKey("blame_capture") in deps_of("blame_records")
    assert AssetKey("blame_records") in deps_of("file_ownership")
    assert AssetKey("file_ownership") in deps_of("member_repository_ownership")
    assert AssetKey("member_repository_ownership") in deps_of("member_ownership")
    assert AssetKey("blame_records") in deps_of("member_ownership")
    assert AssetKey("gitea_pull_request_commits") in deps_of("identity_clusters")
    assert AssetKey("identity_clusters") in deps_of("pr_linked_commit_messages")


def test_each_layer_is_its_own_group():
    """One box per layer in the UI, so a failure localises to a layer."""
    assets_by_key = defs.get_repository_def().assets_defs_by_key

    groups = {
        key.to_user_string(): definition.group_names_by_key[key]
        for key, definition in assets_by_key.items()
    }
    assert groups == {
        "gitea_repository": "01_sources",
        "authentik_users": "01_sources",
        "gitea_pull_request_reviews": "01_sources",
        "gitea_pull_request_commits": "01_sources",
        "blame_capture": "02_capture",
        "blame_records": "03_parse",
        "file_ownership": "05_ownership",
        "member_repository_ownership": "05_ownership",
        "member_ownership": "05_ownership",
        "identity_clusters": "04_identity",
        "eligible_file_ownership": "05_ownership",
        "engineering_contribution": "05_ownership",
        "member_pr_review_counts": "06_pr_metrics",
        "pr_linked_commit_messages": "06_pr_metrics",
        "feature_store_schema": "07_database",
        "pipeline_run_started": "07_database",
        "pipeline_run_completed": "07_database",
        "persist_blame_records": "07_database",
        "persist_authentik_roster_snapshot": "07_database",
        "persist_git_identity_mapping": "07_database",
        "persist_file_ownership": "07_database",
        "persist_member_repository_ownership": "07_database",
        "persist_member_ownership": "07_database",
        "persist_eligible_file_ownership": "07_database",
        "persist_engineering_contribution": "07_database",
        "persist_member_pr_review_counts": "07_database",
        "persist_pr_linked_commit_messages": "07_database",
    }


def test_every_check_is_registered_against_its_asset():
    checks = defs.get_repository_def().asset_checks_defs_by_key

    assert {(key.asset_key, key.name) for key in checks} == {
        (AssetKey("blame_capture"), "capture_is_non_empty"),
        (AssetKey("blame_capture"), "capture_accounts_for_every_tracked_file"),
        (AssetKey("blame_records"), "records_carry_every_field"),
        (AssetKey("blame_records"), "records_parse_completely"),
        (AssetKey("authentik_users"), "roster_is_non_empty"),
        (AssetKey("identity_clusters"), "git_identity_mappings_need_review"),
        (AssetKey("member_pr_review_counts"), "pr_reviewers_resolve_or_need_review"),
    }


def test_persistence_assets_depend_on_schema_setup_and_computed_rows():
    assets_by_key = defs.get_repository_def().assets_defs_by_key

    def deps_of(name):
        key = AssetKey(name)
        return assets_by_key[key].asset_deps[key]

    persistence_assets = {
        "persist_blame_records": "blame_records",
        "persist_authentik_roster_snapshot": "authentik_users",
        "persist_git_identity_mapping": "identity_clusters",
        "persist_file_ownership": "file_ownership",
        "persist_member_repository_ownership": "member_repository_ownership",
        "persist_member_ownership": "member_ownership",
        "persist_eligible_file_ownership": "eligible_file_ownership",
        "persist_engineering_contribution": "engineering_contribution",
        "persist_member_pr_review_counts": "member_pr_review_counts",
        "persist_pr_linked_commit_messages": "pr_linked_commit_messages",
    }
    for persistence_asset, data_asset in persistence_assets.items():
        assert AssetKey("feature_store_schema") in deps_of(persistence_asset)
        assert AssetKey(data_asset) in deps_of(persistence_asset)
        assert AssetKey("pipeline_run_started") in deps_of(persistence_asset)
    assert AssetKey("feature_store_schema") in deps_of("pipeline_run_started")
    assert AssetKey("blame_capture") in deps_of("pipeline_run_started")
    assert AssetKey("authentik_users") in deps_of("pipeline_run_started")
    assert AssetKey("pipeline_run_started") in deps_of("pipeline_run_completed")
    assert all(
        AssetKey(name) in deps_of("pipeline_run_completed")
        for name in persistence_assets
    )


def test_blame_records_publishes_its_parsed_attributes():
    definition = defs.get_repository_def().assets_defs_by_key[AssetKey("blame_records")]
    metadata = definition.metadata_by_key[AssetKey("blame_records")]

    attributes = metadata["parsed_attributes"].value
    schema_names = [column.name for column in metadata["dagster/column_schema"].columns]

    assert [attribute["name"] for attribute in attributes] == schema_names
    assert all(attribute["source"] for attribute in attributes)
    assert all(attribute["description"] for attribute in attributes)

    preview = metadata["attribute_preview"].value
    assert len(preview.records) == len(attributes)
    assert [column.name for column in preview.schema.columns] == [
        "attribute",
        "type",
        "source",
        "description",
    ]


def test_ownership_assets_publish_table_schemas_for_dagster():
    assets_by_key = defs.get_repository_def().assets_defs_by_key
    expected = {
        "file_ownership": [
            "organization",
            "repository",
            "file_path",
            "author_name",
            "author_email",
            "surviving_lines",
            "file_lines",
            "ownership_share",
        ],
        "member_repository_ownership": [
            "organization",
            "repository",
            "author_name",
            "author_email",
            "surviving_lines",
            "repository_lines",
            "ownership_share",
            "files_owned",
            "majority_owned_files",
            "rank",
        ],
        "member_ownership": [
            "organization",
            "author_name",
            "author_email",
            "surviving_lines",
            "surviving_commits",
            "files_owned",
            "repositories",
            "majority_owned_files",
            "average_file_share",
        ],
    }

    for name, columns in expected.items():
        metadata = assets_by_key[AssetKey(name)].metadata_by_key[AssetKey(name)]
        assert [column.name for column in metadata["dagster/column_schema"].columns] == columns
        assert metadata["table"] == name


def test_definitions_expose_shared_resources():
    assert set(defs.resources) == {
        "gitea",
        "authentik",
        "workspace",
        "postgres",
    }


def test_resources_are_built_from_settings():
    settings = PipelineSettings(
        HORIZON_GITEA_URL="https://git.example.com",
        HORIZON_GITEA_API_TOKEN="token-value",
        HORIZON_AUTHENTIK_URL="https://auth.example.com",
        HORIZON_AUTHENTIK_API_TOKEN="auth-token-value",
        HORIZON_DATABASE_URL="postgresql://u@127.0.0.1:5433/db",
    )

    resources = build_resources(settings)

    assert isinstance(resources["gitea"], GiteaClient)
    assert isinstance(resources["authentik"], AuthentikClient)
    assert isinstance(resources["workspace"], GitWorkspace)
    assert isinstance(resources["postgres"], PostgresResource)
    assert resources["gitea"].base_url == "https://git.example.com"
    assert resources["gitea"].api_token == "token-value"
    assert resources["authentik"].base_url == "https://auth.example.com"
    assert resources["authentik"].api_token == "auth-token-value"
    assert resources["postgres"].database_url == "postgresql://u@127.0.0.1:5433/db"


def test_resources_build_even_when_nothing_is_configured():
    """A missing database URL must not stop the UI from booting."""
    resources = build_resources(PipelineSettings())

    assert resources["gitea"].base_url is None
    assert resources["authentik"].base_url is None
    assert resources["authentik"].api_token is None
    assert resources["postgres"].database_url is None
