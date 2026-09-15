import asyncio
from backend.config import get_settings
from backend.people_portal import PeoplePortalSdkClient

async def main():
    settings = get_settings()
    client = PeoplePortalSdkClient(base_url=settings.people_portal_url, token=settings.people_portal_api_token)
    try:
        catalog = await client.list_project_catalog()
        print(f"Catalog fetched: {len(catalog)} items or keys")
        print(catalog.keys())
        teams = await client.list_team_hierarchy()
        print(f"Teams fetched: {len(teams)}")
    except Exception as e:
        import traceback
        traceback.print_exc()

asyncio.run(main())
