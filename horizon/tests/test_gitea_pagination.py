import httpx
import pytest

from pipeline.resources import GiteaClient, GiteaError


def test_paginated_gitea_list_requires_and_reads_every_page():
    def handler(request: httpx.Request) -> httpx.Response:
        page = request.url.params["page"]
        if page == "1":
            return httpx.Response(
                200,
                json=[{"id": 1}, {"id": 2}],
                headers={
                    "X-Total-Count": "3",
                    "X-Page": "1",
                    "Link": '<https://git.example/api/v1/items?page=2>; rel="next"',
                },
            )
        return httpx.Response(
            200,
            json=[{"id": 3}],
            headers={"X-Total-Count": "3", "X-Page": "2"},
        )

    client = GiteaClient(base_url="https://git.example")
    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        rows = client._get_paginated_list(http_client, "https://git.example/api/v1", "/items")

    assert [row["id"] for row in rows] == [1, 2, 3]


def test_paginated_gitea_list_rejects_a_truncated_snapshot():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"id": 1}], headers={"X-Total-Count": "2"})

    client = GiteaClient(base_url="https://git.example")
    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        with pytest.raises(GiteaError, match="ended after 1 of 2"):
            client._get_paginated_list(
                http_client, "https://git.example/api/v1", "/items"
            )
