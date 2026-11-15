# People Portal Server

This project is part of an Nx monorepo. The local `package.json` scripts have been migrated to Nx targets. 

You should execute tasks for this project via the Nx CLI from the root of the workspace.

## Common Commands

* **Start Development Server**: `nx serve pplserver`
* **Build Project**: `nx build pplserver`
* **Start Production Server**: `nx start pplserver`
* **Run Tests**: `nx test pplserver`
* **Run Unit Tests**: `nx test-unit pplserver`
* **Run Integration Tests**: `nx test-integration pplserver`
* **Run DB Seed**: `nx seed pplserver`

*Note: Make sure you run these commands from the root of the monorepo.*

## Event RSVP and attendance fixtures

Create an event in your local portal and copy its ID from the event URL. From
the repository root in WSL, run:

```bash
./nx run pplserver:seed-event --args="<EVENT_ID> 100"
```

The count defaults to 100. The script loads the server's environment files and
requires `PEOPLEPORTAL_MONGO_URL` to name a database on localhost MongoDB. It
refuses production mode. The portal server need not be running while seeding.

Each ten generated people produce six accepted RSVPs (four attended and two
absent), one decline, one cancellation, and two walk-ins. Attendance uses a mix
of QR, code and manual methods. Refresh the event's RSVP and attendance tabs
after running. Fixture emails end in `@example.invalid`, and attendance uses
negative fixture IDs rather than real Authentik IDs.

Reruns reuse the same records; reducing the count does not remove previous
fixtures. These records only test tables, counts and pagination. They do not
create login accounts or exercise authorization, notifications or the actual
check-in flow.
