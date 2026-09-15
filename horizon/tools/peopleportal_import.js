/*
 * Local People Portal recruiting importer.
 *
 * This file is intentionally run inside corp.appdevclub.com by injecting it
 * from a localhost script tag. That lets fetch() reuse the existing browser
 * session without reading cookies or tokens. Every People Portal request is a
 * GET. The result is downloaded as one local ZIP containing JSON artifacts and
 * résumé PDFs; no data is uploaded anywhere.
 */
(() => {
  "use strict";

  if (window.__horizonPeoplePortalImportRunning) return;
  window.__horizonPeoplePortalImportRunning = true;

  const MIN_REQUEST_INTERVAL_MS = 300;
  const DROP_KEYS = new Set([
    "avatar",
    "resumeUrl",
    "resumeURL",
    "signedUrl",
    "downloadUrl",
    "uploadUrl",
  ]);
  const state = {
    nextRequestAt: 0,
    requestCount: 0,
    activeMembers: [],
    teams: [],
    applications: [],
    resumes: [],
    failures: [],
    resumeFiles: [],
    inaccessibleTeams: [],
  };

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function show(message) {
    let panel = document.getElementById("horizon-peopleportal-import-status");
    if (!panel) {
      panel = document.createElement("pre");
      panel.id = "horizon-peopleportal-import-status";
      panel.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "top:12px",
        "right:12px",
        "width:420px",
        "max-height:80vh",
        "overflow:auto",
        "padding:14px",
        "background:#101827",
        "color:#e5eefb",
        "border:1px solid #4b6b91",
        "border-radius:8px",
        "font:12px/1.45 ui-monospace,monospace",
        "white-space:pre-wrap",
      ].join(";");
      document.documentElement.appendChild(panel);
    }
    panel.textContent = message;
  }

  async function pace() {
    const wait = Math.max(0, state.nextRequestAt - Date.now());
    if (wait > 0) await sleep(wait);
    state.nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
    state.requestCount += 1;
  }

  function recordFailure(path, status) {
    state.failures.push({ path, status });
  }

  async function getJson(path) {
    await pace();
    const response = await fetch(path, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) recordFailure(path, response.status);
    return { response, data };
  }

  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (DROP_KEYS.has(key)) continue;
      result[key] = scrub(child);
    }
    return result;
  }

  function normalizeEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function safePart(value) {
    return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "unknown";
  }

  function uniqueResumeName(base, used) {
    const root = `${safePart(base.memberPk || base.applicantId)}_${safePart(base.teamId)}_resume`;
    let name = `${root}.pdf`;
    let suffix = 2;
    while (used.has(name)) name = `${root}-${suffix++}.pdf`;
    used.add(name);
    return name;
  }

  function groupFailures() {
    return state.failures.reduce((groups, failure) => {
      const key = String(failure.status);
      groups[key] = (groups[key] || 0) + 1;
      return groups;
    }, {});
  }

  async function collectPeople() {
    let page = 1;
    let totalPages = 1;
    const people = [];
    do {
      show(`Loading active members page ${page}/${totalPages}…\nGET requests: ${state.requestCount}`);
      const result = await getJson(`/api/org/people?page=${page}`);
      if (!result.response.ok || !result.data) break;
      people.push(...(result.data.users || []));
      totalPages = Number(result.data.pagination?.total_pages || page);
      page += 1;
    } while (page <= totalPages);

    state.activeMembers = people
      .filter((person) => person.active === true)
      .map((person) => scrub(person));
  }

  async function collectTeams() {
    let cursor = "";
    do {
      const query = new URLSearchParams({ limit: "500" });
      if (cursor) query.set("cursor", cursor);
      show(`Loading teams…\nCollected: ${state.teams.length}\nGET requests: ${state.requestCount}`);
      const result = await getJson(`/api/org/teams?${query.toString()}`);
      if (!result.response.ok || !result.data) break;
      state.teams.push(...(result.data.teams || []).map(scrub));
      cursor = result.data.nextCursor || "";
    } while (cursor);

    if (!state.teams.length) {
      const fallback = await getJson("/api/org/myteams");
      if (fallback.response.ok && Array.isArray(fallback.data?.teams)) {
        state.teams.push(...fallback.data.teams.map(scrub));
      }
    }
  }

  function activeMemberIndexes() {
    const byPk = new Map();
    const byEmail = new Map();
    for (const member of state.activeMembers) {
      if (member.pk !== undefined && member.pk !== null) byPk.set(String(member.pk), member);
      const email = normalizeEmail(member.email);
      if (email) byEmail.set(email, member);
    }
    return { byPk, byEmail };
  }

  async function collectApplications() {
    const indexes = activeMemberIndexes();
    const cards = [];

    for (const team of state.teams) {
      const teamId = team.pk || team.id;
      if (!teamId) continue;
      show(`Loading applications for ${teamId}…\nTeams remaining: ${state.teams.length - cards.length}\nGET requests: ${state.requestCount}`);
      const result = await getJson(`/api/ats/applications/${encodeURIComponent(teamId)}`);
      if (result.response.status === 401 || result.response.status === 403) {
        state.inaccessibleTeams.push({ teamId: String(teamId), status: result.response.status });
      }
      if (!result.response.ok || !Array.isArray(result.data)) continue;
      for (const card of result.data) cards.push({ teamId: String(teamId), card });
    }

    for (let index = 0; index < cards.length; index += 1) {
      const { teamId, card } = cards[index];
      const applicationId = card.id || card.applicationId;
      if (!applicationId) continue;
      show(`Loading application details ${index + 1}/${cards.length}…\nGET requests: ${state.requestCount}`);
      const result = await getJson(`/api/ats/applications/${encodeURIComponent(teamId)}/${encodeURIComponent(applicationId)}/info`);
      if (!result.response.ok || !result.data || result.data.error) continue;

      const info = result.data;
      const linkedMember = indexes.byPk.get(String(info.appDevInternalPk ?? ""))
        || indexes.byEmail.get(normalizeEmail(info.email));
      if (!linkedMember) continue;

      state.applications.push({
        memberPk: linkedMember.pk,
        memberName: linkedMember.name,
        memberEmail: linkedMember.email,
        teamId,
        applicationId: String(applicationId),
        applicantId: info.applicantId || card.applicantId || null,
        applicationCard: scrub(card),
        applicationInfo: scrub(info),
        otherApplications: null,
        resume: null,
      });
    }
  }

  async function collectOtherApplications() {
    const seen = new Set();
    for (let index = 0; index < state.applications.length; index += 1) {
      const application = state.applications[index];
      if (!application.applicantId) continue;
      const key = `${application.teamId}/${application.applicantId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      show(`Loading related applications ${seen.size}…\nGET requests: ${state.requestCount}`);
      const result = await getJson(`/api/ats/applications/${encodeURIComponent(application.teamId)}/${encodeURIComponent(application.applicantId)}/otherapps`);
      const related = result.response.ok && Array.isArray(result.data) ? scrub(result.data) : null;
      for (const candidate of state.applications) {
        if (`${candidate.teamId}/${candidate.applicantId}` === key) candidate.otherApplications = related;
      }
    }
  }

  async function collectResumes() {
    const seenApplicants = new Set();
    const usedNames = new Set();
    for (let index = 0; index < state.applications.length; index += 1) {
      const application = state.applications[index];
      if (!application.applicantId || seenApplicants.has(String(application.applicantId))) continue;
      seenApplicants.add(String(application.applicantId));
      show(`Loading résumé ${seenApplicants.size}…\nGET requests: ${state.requestCount}`);

      const path = `/api/ats/applications/${encodeURIComponent(application.teamId)}/${encodeURIComponent(application.applicantId)}/resume`;
      const result = await getJson(path);
      const resume = {
        applicantId: String(application.applicantId),
        memberPk: application.memberPk,
        teamId: application.teamId,
        available: false,
        retrieved: false,
        fileName: null,
        status: result.response.status,
      };

      const signedUrl = result.data?.resumeUrl;
      if (result.response.ok && typeof signedUrl === "string" && signedUrl) {
        try {
          const pdfResponse = await fetch(signedUrl, { method: "GET", cache: "no-store" });
          resume.available = true;
          resume.status = pdfResponse.status;
          if (pdfResponse.ok) {
            const fileName = uniqueResumeName(resume, usedNames);
            state.resumeFiles.push({ name: `resumes/${fileName}`, bytes: new Uint8Array(await pdfResponse.arrayBuffer()) });
            resume.retrieved = true;
            resume.fileName = `resumes/${fileName}`;
          } else {
            state.failures.push({ path: "resume-object", status: pdfResponse.status });
          }
        } catch (_) {
          state.failures.push({ path: "resume-object", status: "network-error" });
        }
      }

      state.resumes.push(resume);
      for (const candidate of state.applications) {
        if (String(candidate.applicantId) === String(application.applicantId)) candidate.resume = resume;
      }
    }
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function u16(value) {
    return new Uint8Array([value & 255, (value >>> 8) & 255]);
  }

  function u32(value) {
    return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(file.bytes);
      const checksum = crc32(data);
      const local = concatBytes([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
      ]);
      localParts.push(local);
      centralParts.push(concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
      ]));
      offset += local.length;
    }
    const central = concatBytes(centralParts);
    const end = concatBytes([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
    return concatBytes([...localParts, central, end]);
  }

  function downloadExport(report) {
    const encoder = new TextEncoder();
    const json = (value) => JSON.stringify(value, null, 2);
    const files = [
      { name: "peopleportal/manifest.json", bytes: encoder.encode(json(report)) },
      { name: "peopleportal/active-members.json", bytes: encoder.encode(json(report.activeMembers)) },
      { name: "peopleportal/applications.json", bytes: encoder.encode(json(report.applications)) },
      { name: "peopleportal/teams.json", bytes: encoder.encode(json(report.teams)) },
      { name: "peopleportal/failures.json", bytes: encoder.encode(json(report.failures)) },
      ...state.resumeFiles,
    ];
    const archive = makeZip(files);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
    link.download = `horizon-peopleportal-${stamp}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  async function run() {
    try {
      show("Starting local People Portal import…");
      await collectPeople();
      await collectTeams();
      await collectApplications();
      await collectOtherApplications();
      await collectResumes();

      const report = {
        schema: "horizon.peopleportal.recruiting.v1",
        generatedAt: new Date().toISOString(),
        source: location.origin,
        readMethod: "authenticated GET requests only",
        activeMembers: state.activeMembers,
        teams: state.teams,
        applications: state.applications,
        resumes: state.resumes,
        failures: state.failures,
        summary: {
          activeMembers: state.activeMembers.length,
          teamsChecked: state.teams.length,
          accessibleTeams: state.teams.length - new Set(state.inaccessibleTeams.map((team) => team.teamId)).size,
          inaccessibleTeams: state.inaccessibleTeams,
          applications: state.applications.length,
          uniqueApplicants: new Set(state.applications.map((application) => application.applicantId).filter(Boolean)).size,
          resumesAvailable: state.resumes.filter((resume) => resume.available).length,
          resumesRetrieved: state.resumes.filter((resume) => resume.retrieved).length,
          applicationsWithNotes: state.applications.filter((application) => Boolean(application.applicationInfo?.notes)).length,
          applicationsWithRatings: state.applications.filter((application) => application.applicationInfo?.stars !== undefined).length,
          failedRequests: state.failures.length,
          failedRequestsByStatus: groupFailures(),
          sourceGetRequests: state.requestCount,
        },
      };

      show(`Preparing local Horizon archive…\nActive members: ${report.summary.activeMembers}\nApplications: ${report.summary.applications}\nRésumés retrieved: ${report.summary.resumesRetrieved}\nFailures: ${report.summary.failedRequests}`);
      downloadExport(report);
      show(`Export downloaded locally.\nActive members: ${report.summary.activeMembers}\nApplications: ${report.summary.applications}\nRésumés retrieved: ${report.summary.resumesRetrieved}\nFailures: ${report.summary.failedRequests}\n\nMove the downloaded ZIP into Horizon/output to load it into the local tool.`);
    } catch (error) {
      show(`Import stopped: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      window.__horizonPeoplePortalImportRunning = false;
    }
  }

  void run();
})();
