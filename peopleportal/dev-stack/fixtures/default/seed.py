#!/usr/bin/env python3
"""Seed the default People Portal fixture into a running dev-stack slot.

Run through `scripts/fixture.sh load default --slot N` (which exports the slot's
settings). Uses only the Python standard library. Idempotent: existing groups and
users are reused and Mongo documents are upserted, so a second run is harmless.

Everything is created the way the server itself does it (same group names,
attributes, role titles and Mongo shapes), so the portal treats the data as
native. Authentik pks are looked up after creation and written into Mongo, which
keeps the two stores consistent whatever pks the target slot hands out.

All seeded users share the password in PASSWORD (local-only, documented in
fixtures/README.md).
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

PASSWORD = "portal-dev"
BASE = f"http://127.0.0.1:{os.environ['AUTHENTIK_PORT']}/api/v3"
TOKEN = os.environ["AUTHENTIK_BOOTSTRAP_TOKEN"]
PROJECT = os.environ["COMPOSE_PROJECT_NAME"]
YEAR = 2026

# Bindle sets copied from server/src/config.ts (PROJECT template) plus extras.
LEADERSHIP = {
    "PeoplePortalClient": {"corp:awsaccess": True, "corp:hiringaccess": True},
    "SlackClient": {"slack:universalaccess": True},
    "GiteaClient": {"repo:allowcreate": True, "repo:brprotect-approvals": True,
                    "repo:brprotect-override": True, "repo:brprotect-merge": True},
}
ENGINEERING = {"GiteaClient": {"repo:brprotect-override": True, "repo:brprotect-merge": True}}
DESIGN = {"PeoplePortalClient": {"corp:membermgmt": True, "corp:subteamaccess": True}}
MANAGER = {"PeoplePortalClient": {"corp:permissionsmgmt": True, "corp:bindlesync": True,
                                  "corp:membermgmt": True, "corp:subteamaccess": True}}


def api(method, path, body=None, ok=(200, 201, 204)):
    req = urllib.request.Request(
        BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        if err.code in ok:
            return {}
        sys.exit(f"Authentik {method} {path} -> {err.code}: {err.read().decode()[:300]}")


def find_group(name):
    results = api("GET", f"/core/groups/?name={name}&include_users=false")["results"]
    return next((g for g in results if g["name"] == name), None)


def group(name, friendly, description, team_type, parent=None, bindles=None, service=False):
    existing = find_group(name)
    if existing:
        return str(existing["pk"])
    attrs = {
        "friendlyName": friendly, "teamType": team_type,
        "seasonType": "ROLLING" if service else "FALL", "seasonYear": YEAR,
        "description": description, "teamStartDate": f"{YEAR}-08-01",
        "teamEndDate": f"{YEAR}-12-31", "peoplePortalCreation": True,
        "rootTeamSettings": {}, "bindlePermissions": bindles or {},
    }
    made = api("POST", "/core/groups/", {
        "name": name, "is_superuser": False,
        "parents": [parent] if parent else [], "attributes": attrs})
    return str(made["pk"])


def user(username, name, major):
    found = api("GET", f"/core/users/?username={username}")["results"]
    if found:
        return found[0]["pk"]
    made = api("POST", "/core/users/", {
        "username": username, "name": name, "email": f"{username}@terpmail.umd.edu",
        "is_active": True, "path": "peopleportal.atheesh.org/onboardeduser",
        "attributes": {"peoplePortalCreation": True, "alumniAccount": False, "major": major,
                       "expectedGrad": f"{YEAR + 2}-05-15", "phoneNumber": "5555550100", "roles": {}}})
    api("POST", f"/core/users/{made['pk']}/set_password/", {"password": PASSWORD})
    return made["pk"]


def join(user_pk, group_pk, title):
    """Mirror OrgController.addTeamMemberWrapper: membership + roles attribute."""
    api("POST", f"/core/groups/{group_pk}/add_user/", {"pk": user_pk})
    info = api("GET", f"/core/users/{user_pk}/")
    attrs = info["attributes"]
    attrs["roles"] = {**attrs.get("roles", {}), group_pk: title}
    api("PATCH", f"/core/users/{user_pk}/", {"attributes": attrs})


def mongo(script):
    subprocess.run(["docker", "compose", "-p", PROJECT, "exec", "-T", "mongo", "mongosh", "--quiet",
                    "people-portal", "--eval", script], check=True)


# --- Authentik: service teams (the server reconciles bindles on next boot) -----------
exec_root = group("ExecutiveBoard", "Executive Board", "The President and Other Club Executives", "SERVICE", service=True)
exec_members = group("ExecutiveBoardMembers", "Current Executives", "The Current President and Club Executives",
                     "CORPORATE", parent=exec_root, service=True)

# --- Root team with a few subteams ---------------------------------------------------
orbit = group("OrbitPlatformFALL2026", "Orbit Platform", "Internal tooling platform team", "PROJECT")
orbit_lead = group("OrbitPlatformLeadershipFALL2026", "Leadership", "Project and Tech Leads", "PROJECT", orbit, LEADERSHIP)
orbit_eng = group("OrbitPlatformEngineeringFALL2026", "Engineering", "UI/UX, PMs, SWEs, etc.", "PROJECT", orbit, ENGINEERING)
orbit_design = group("OrbitPlatformDesignFALL2026", "Design", "Product and visual design", "PROJECT", orbit, DESIGN)
orbit_qa = group("OrbitPlatformQAFALL2026", "QA", "Testing, no special bindles", "PROJECT", orbit, {})
orbit_mgmt = group("OrbitPlatformManagementFALL2026", "Management", "Permissions and member management", "PROJECT", orbit, MANAGER)

# --- Recruiting team -----------------------------------------------------------------
beacon = group("BeaconFALL2026", "Beacon", "Community app, recruiting this season", "PROJECT")
beacon_lead = group("BeaconLeadershipFALL2026", "Leadership", "Project and Tech Leads", "PROJECT", beacon, LEADERSHIP)
beacon_eng = group("BeaconEngineeringFALL2026", "Engineering", "UI/UX, PMs, SWEs, etc.", "PROJECT", beacon, ENGINEERING)
beacon_design = group("BeaconDesignFALL2026", "Design", "Product and visual design", "PROJECT", beacon, DESIGN)

people = [  # username, name, major, [(group pk, role title)]
    ("prez", "Pat President", "Government", [(exec_members, "President")]),
    ("techlead", "Taylor Lead", "Computer Science", [(orbit, "Tech Lead")]),
    ("pmlead", "Morgan Manager", "Information Science", [(orbit_lead, "Project Manager")]),
    ("swe1", "Sam Engineer", "Computer Science", [(orbit_eng, "Software Engineer")]),
    ("swe2", "Jordan Backend", "Computer Engineering", [(orbit_eng, "Backend Engineer")]),
    ("designer", "Devon Designer", "Art", [(orbit_design, "Product Designer")]),
    ("qa1", "Quinn Tester", "Mathematics", [(orbit_qa, "QA Engineer")]),
    ("permsadmin", "Avery Admin", "Information Science", [(orbit_mgmt, "Operations")]),
    ("recruitowner", "Rory Recruiter", "Psychology", [(beacon, "Project Lead")]),
    ("recruiter", "Riley Hiring", "Business", [(beacon_lead, "Hiring Manager")]),
    ("beaconeng", "Blake Builder", "Computer Science", [(beacon_eng, "Software Engineer")]),
    ("beacondesign", "Bailey Brand", "Design", [(beacon_design, "Product Designer")]),
    ("nobindles", "Casey Newbie", "Biology", []),
]
pks = {}
for username, name, major, memberships in people:
    pks[username] = user(username, name, major)
    for group_pk, title in memberships:
        info = api("GET", f"/core/users/{pks[username]}/")
        if group_pk not in info["groups"]:
            join(pks[username], group_pk, title)

api("PATCH", f"/core/users/{api('GET', '/core/users/?username=akadmin')['results'][0]['pk']}/", {"name": "Dev Admin"})

# --- Mongo: recruiting config, applicants, applications -----------------------------
now = datetime.now(timezone.utc)
stages = ["Applied"] * 3 + ["Interview"] * 2 + ["Rejected"] * 2 + ["Potential Hire"] * 2 + ["Hired"]
order = ["Applied", "Interview", "Potential Hire", "Hired", "Rejected"]
first = ["Alex", "Bri", "Chris", "Dana", "Eli", "Fran", "Gus", "Hana", "Ivy", "Jun"]
last = ["Nguyen", "Patel", "Garcia", "Kim", "Okafor", "Silva", "Rossi", "Haddad", "Novak", "Tanaka"]
docs = []
for i, stage in enumerate(stages):
    sub, role = (beacon_eng, "Software Engineer") if i % 3 else (beacon_design, "Product Designer")
    history, when = [], now - timedelta(days=20 - i)
    for s in order[: order.index(stage) + 1] if stage != "Rejected" else ["Applied", "Interview", "Rejected"]:
        history.append({"stage": s, "changedAt": when.isoformat(), **({"changedBy": "recruiter"} if s != "Applied" else {})})
        when += timedelta(days=2)
    docs.append({
        "i": i, "email": f"applicant{i + 1}@example.test", "name": f"{first[i]} {last[i]}",
        "stage": stage, "sub": sub, "role": role, "history": history,
        "hired": stage == "Hired", "stars": (i * 2) % 6,
    })
script = f"""
const oid = (n) => ObjectId(('000000000000000000000000' + n.toString(16)).slice(-24));
const now = new Date();
db.teamrecruitingstatuses.updateOne({{teamPk: {json.dumps(beacon)}}}, {{$set: {{teamPk: {json.dumps(beacon)},
  isRecruiting: true, recruitingSubteamPks: [{json.dumps(beacon_eng)}, {json.dumps(beacon_design)}], updatedAt: now}},
  $setOnInsert: {{createdAt: now, __v: 0}}}}, {{upsert: true}});
const cfg = [[{json.dumps(beacon_eng)}, ["Software Engineer", "Backend Engineer"]],
             [{json.dumps(beacon_design)}, ["Product Designer"]]];
for (const [pk, roles] of cfg) {{
  const qs = {{}}; roles.forEach((r) => qs[r] = ["Describe a project you are proud of as a " + r + "."]);
  db.subteamconfigs.updateOne({{subteamPk: pk}}, {{$set: {{subteamPk: pk, isRecruiting: true, roles, roleSpecificQuestions: qs, updatedAt: now}},
    $setOnInsert: {{createdAt: now, __v: 0}}}}, {{upsert: true}});
}}
const people = {json.dumps(docs)};
for (const p of people) {{
  const id = oid(p.i + 1), appId = oid(0x100 + p.i + 1);
  db.applicants.updateOne({{email: p.email}}, {{$set: {{email: p.email, fullName: p.name, applicationIds: [appId],
    profile: {{resumeUrl: "https://example.invalid/resume-" + (p.i + 1) + ".pdf", whyAppDev: "I want to build real products with a team.",
      instagramFollow: "yes", linkedinUrl: "https://www.linkedin.com/in/example-" + (p.i + 1), githubUrl: "https://github.com/example-" + (p.i + 1)}},
    updatedAt: now}}, $setOnInsert: {{_id: id, createdAt: now, __v: 0}}}}, {{upsert: true}});
  const applicant = db.applicants.findOne({{email: p.email}});
  const resp = {{}}; resp["Why are you interested in Beacon?"] = "The mission and the people on the team stood out to me.";
  resp["Describe a project you are proud of as a " + p.role + "."] = "I shipped a course project end to end with three teammates.";
  db.applications.updateOne({{applicantId: applicant._id, teamPk: {json.dumps(beacon)}}}, {{$set: {{
    applicantId: applicant._id, teamPk: {json.dumps(beacon)}, rolePreferences: [{{role: p.role, subteamPk: p.sub}}],
    stage: p.stage, responses: resp, appliedAt: new Date(p.history[0].changedAt),
    stageHistory: p.history.map((h) => ({{stage: h.stage, changedAt: new Date(h.changedAt), ...(h.changedBy ? {{changedBy: h.changedBy}} : {{}})}})),
    stars: p.stars, notes: p.stage === "Hired" ? "Strong interview; offer accepted." : "", ...(p.hired ? {{hiredRole: p.role, hiredSubteamPk: p.sub}} : {{}}),
    updatedAt: now}}, $setOnInsert: {{_id: appId, createdAt: now, __v: 0}}}}, {{upsert: true}});
  const app = db.applications.findOne({{applicantId: applicant._id, teamPk: {json.dumps(beacon)}}});
  db.applicants.updateOne({{_id: applicant._id}}, {{$set: {{applicationIds: [app._id]}}}});
}}
print("seeded " + db.applications.countDocuments() + " applications");
"""
mongo(script)
print(f"Seeded users: akadmin (superuser) + {', '.join(pks)} | password for seeded users: {PASSWORD}", file=sys.stderr)
