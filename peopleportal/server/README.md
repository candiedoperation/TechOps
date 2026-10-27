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

## ATS code map

`src/controllers/ATSController.ts` defines the HTTP routes, required access,
and response status. Its methods delegate to the following files in
`src/services/ats/`:

| File | Responsibility |
| --- | --- |
| `ATSApplicantService.ts` | Resume upload/download links, shared applicant profile, and application submission. |
| `ATSApplicationService.ts` | Recruiter application lists/details, manual feedback, resume links, applicant history, and stage changes. |
| `ATSRecruitmentService.ts` | Team/subteam recruitment settings, open-role listings, cache updates, and recruitment statistics. |
| `ATSHelpers.ts` | Shared types, validation rules, resume keys/signing, and response formatting. PDF verification reads object storage. |

The controller's undecorated forwarding methods support existing internal
callers; they are not extra HTTP endpoints. Authentication itself lives in
`AuthController` and `auth.ts`. The ATS has manual star ratings, but does not
extract resume text, call an AI model, or calculate an AI score yet.

### Request flow

1. **Configure recruitment:** an authorized recruiter saves a subteam's roles,
   questions, and open/closed setting. The parent team's recruiting list is
   updated and the public-listing cache is invalidated.
2. **Browse:** applicants see recruiting teams and their roles. MongoDB supplies
   configuration, Authentik supplies team information, and Redis caches the
   public list. Missing directory results are hidden without deleting records.
3. **Authenticate:** an applicant verifies their email through the guest/OTP
   flow. That flow creates their applicant record. Recruiters use normal OIDC
   login and need team ownership or `corp:hiringaccess`.
4. **Upload a PDF:** the server returns a short-lived upload form. The browser
   sends the file directly to S3 under `resumes/<applicant-id>.pdf`. The profile
   stores the object key; it does not store the PDF bytes or a permanent URL.
5. **Submit:** check the session, open team, role ownership, profile, and required
   answers; reject duplicates; verify the resume key and stored PDF header.
   Then save the profile, application, and applicant/application link in one
   MongoDB transaction. Failure rolls back all three writes.
6. **Review:** recruiters open application cards, read answers, open a temporary
   resume link, and add manual stars or notes. Notes include the author and time.
7. **Change stage:** check access and allowed transitions, then save the new
   stage, one history entry, and any pending follow-up work. Send email or
   perform hiring actions afterward. A repeated request resumes unfinished work.

### Stage rules

| Current stage | Allowed next stages | Follow-up when entering the next stage |
| --- | --- | --- |
| Applied | Interview, Rejected | Interview requires a link and 50–500 characters of guidelines; rejection sends an email. |
| Interview | Potential Hire, Hired, Rejected | Potential Hire sends no email. Hired adds an existing member or sends an external applicant an onboarding invite. |
| Potential Hire | Hired, Rejected | The same hiring/rejection actions apply. |
| Hired / Rejected | No new stage | Repeating the current stage can still retry pending work. |

## Testing the ATS refactor

### Automated checks (no S3 access required)

From the monorepo root:

```bash
./nx run pplserver:test
```

This builds the server and runs the full backend suite. The ATS coverage is in:

- `test/integration/ats-behavior.test.js`: 105 saved behavior comparisons for
  responses, status codes, redirects, and relevant client calls. The fixtures
  come from the controller before the split. The submission, stage, and public
  listing cases compare responses while separate tests cover their intentional
  persistence changes.
- `test/integration/ats-reliability.test.js`: a disposable MongoDB replica set
  verifies transaction commit/rollback, simultaneous duplicate submissions,
  foreign-team role rejection, retry payload retention, concurrent stage claims,
  expired leases, membership recovery, invite reuse, current permissions, and
  preservation of recruitment data during directory failures.

These tests replace S3, email, and directory calls with controlled responses.
They do not verify AWS credentials or access, and they do not modify the database
from your `.env`. The database reliability tests create their own database and
remove only their own fixture records.

To run just the ATS tests after building:

```bash
./nx run pplserver:build
cd peopleportal/server
../../nx exec -p pplserver -- node --require ./test/helpers/bootstrap.js --test ./test/integration/ats-behavior.test.js ./test/integration/ats-reliability.test.js
```

### Browser/API checklist

Open `http://localhost:5173`. Use a dedicated development team and synthetic
applicants for write tests. If your environment points to a shared database or
directory, creating teams or hiring people changes those shared services.
Available email capture is at `http://localhost:8025` when SMTP points to the
local Mailpit service; the original login provider does not use its passwords.

| Test | Action | Expected result |
| --- | --- | --- |
| Normal login | Sign in with the configured existing OIDC account. | Dashboard loads; recruiter permissions match the account. |
| Recruitment settings | Open a development team's Recruitment Tracker → Recruitment Settings. Add a role/question, enable recruitment, save, and refresh. | Saved settings persist and the team appears at `/apply`. Disabling the last recruiting subteam removes it from the open list. |
| Team detail | Open that team's card at `/apply`. | Only that team's recruiting subteams, roles, and questions appear. |
| Application details | In Recruitment Tracker → Applications, open a synthetic application. | Name, role order, answers, current stage, and history are correct. This does not require opening its resume. |
| Feedback | Give the test application 1–5 stars and a Markdown note. Refresh and add a second note. | Rating persists; the newest note appears first with author/time; previous notes remain. |
| Invalid feedback | Through the API, send stars outside 1–5, blank notes, or an unclosed code fence. | HTTP 400; previous feedback remains. |
| Valid stages | Move separate test applications through the paths in the stage table. | One history entry per successful move; expected emails appear in the configured test inbox. Potential Hire sends none. |
| Invalid stages | Through the API, try Applied → Hired, move a terminal application to another stage, or omit the interview link/guidelines. | HTTP 400; no new stage history or notification. |
| Review access | Request protected ATS data while logged out or as a user without access to that team. | Access is denied. An application ID belonging to another team cannot be read through the current team's route. |
| Retry behavior | Run the reliability tests listed above. | Failed work resumes with saved input; concurrent work returns 409; completed membership is skipped and an invite ID is reused. |
| Statistics | As an executive, open team recruitment totals. | Counts match test applications; active teams with no applications show zeroes. |

Use `/api/docs` to inspect request bodies and routes when a negative case cannot
be sent through the browser form. The browser can prevent some invalid input
before it reaches the API. For failed stage requests, refreshing may show the
already-saved stage; retry the same `PUT /api/ats/applications/{teamId}/{applicationId}/stage`
request to finish pending work. The board has no dedicated retry button.

### Resume checks and the S3 limitation

Without access to the configured bucket, you cannot view existing resumes or
fully test new uploads, resume profile changes, or successful submission in the
browser. MongoDB contains only file keys, so there are no PDF copies to recover
from the applicant records. Signing a download URL can succeed even when S3
later denies access or the object does not exist. A successful signing response
alone does not prove the PDF is readable.

The upload API checks the filename and content type, allows only PDFs up to
10 MiB, and fixes the storage key to the signed-in applicant. Submission reads
the stored file header; it must remain enabled when testing. An unavailable
bucket can therefore surface as `InvalidFileSignature`, not just an AWS error
in the browser.

Once a test bucket is available, test these end to end:

1. Upload a synthetic PDF below 10 MiB and open it from both the applicant view
   and the authorized recruiter view. Confirm it is the same file.
2. Submit with the required profile fields and answers. Expect one application
   in Applied, one applicant/application link, and the same ordered roles and
   answers in the recruiter view.
3. Repeat submission to the same team. Expect HTTP 409 and one application.
4. Reject a non-PDF filename/type, a file exceeding 10 MiB, and non-PDF bytes
   renamed to `.pdf`. A guest must not upload or download another applicant's key.
5. Test missing profile fields, more than 200 words for Why App Dev, missing or
   shorter-than-10-word answers, answers over 2,000 characters, and roles from
   another team. Invalid requests must not create an application or update the
   submitted profile. Use API requests for cases blocked by the form.

Existing AWS resumes require access to their original bucket and objects. A
local S3-compatible test bucket can hold new synthetic PDFs, but cannot retrieve
those originals. The current S3 client does not consume `S3_ENDPOINT` or
`S3_FORCE_PATH_STYLE`; setting them in `.env` alone does not enable local storage.
Local storage would require explicit client support, a bucket with browser CORS,
and a separate test configuration. Do not replace real resumes with dummy files
or skip file validation to make a test pass.

## ATS persistence and retries

Application submission requires a MongoDB replica set or sharded cluster for
transactions. The local dev stack initializes its own single-node replica set;
see `peopleportal/dev-stack/README.md` when upgrading an existing environment.

Stage changes save their follow-up work with the application before sending
notifications or changing membership. If a request fails after the stage was
saved, repeat the same stage request to resume its pending work. The saved
payload is reused and hiring access is checked again. A concurrent request
receives HTTP 409 while work is running, and another stage cannot overwrite
unfinished work. Processing leases renew while active and can be reclaimed
after five minutes if a worker stops.

Completed membership steps are recorded and onboarding retries reuse one invite
ID. SMTP delivery cannot be made exactly once: a process failure after SMTP
accepts an email but before the completion record is written can still cause
a duplicate email on retry. There is no automatic background retry worker;
retrying the same stage request resumes the saved action.
