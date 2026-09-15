let artifactRoot = "../artifacts/latest";

const state = {
  data: null,
  profileData: null,
  members: [],
  profiles: [],
  repositories: [],
  organizations: [],
  view: "members",
  search: "",
  organization: "all",
  sort: "name",
};

const $ = (selector) => document.querySelector(selector);
const formatNumber = (value) => new Intl.NumberFormat().format(Number(value || 0));
const formatMetric = (value) => value === null || value === undefined ? "—" : formatNumber(value);
const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] || 0), 0);
const sumAvailable = (items, key) => {
  const values = items.map((item) => item[key]).filter((value) => value !== null && value !== undefined);
  return values.length ? values.reduce((total, value) => total + Number(value || 0), 0) : null;
};
const escapeHTML = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function makeRepositoryRows(organizations) {
  return organizations.flatMap((organization) => (organization.repositories || []).map((repo) => ({
    ...repo,
    organization: repo.organization || organization.organization,
    commitCount: (repo.commits || []).length,
    pullCount: (repo.pulls || []).length,
    mergedCount: (repo.pulls || []).filter((pull) => pull.merged).length,
  })));
}

function makeOrganizationRows(organizations, members) {
  return organizations.map((organization) => {
    const name = organization.organization;
    const repos = organization.repositories || [];
    const orgMembers = members.filter((member) => (member.organizations || []).includes(name));
    return {
      name,
      roster: organization.member_count || orgMembers.length,
      activeMembers: orgMembers.filter((member) => memberHasActivity(member)).length,
      repositories: repos.length,
      branches: repos.reduce((total, repo) => total + (repo.branches || []).length, 0),
      commits: repos.reduce((total, repo) => total + (repo.commits || []).length, 0),
      pulls: repos.reduce((total, repo) => total + (repo.pulls || []).length, 0),
      merged: repos.reduce((total, repo) => total + (repo.pulls || []).filter((pull) => pull.merged).length, 0),
      issues: repos.reduce((total, repo) => total + Number(repo.issue_count || 0), 0),
      blameLines: sumAvailable(orgMembers, "blame_lines"),
    };
  });
}

function memberHasActivity(member) {
  return ["commits", "pulls_opened", "reviews_submitted", "issues_opened", "blame_lines"]
    .some((key) => Number(member[key] || 0) > 0);
}

function fetchJSON(url) {
  return HorizonSession.fetch(`${url}?t=${Date.now()}`)
    .then((response) => {
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      return response.json();
    });
}

function loadData() {
  setStatus("Loading combined member profiles…");
  return fetchJSON("../artifacts/latest/manifest.json").then((manifest) => {
    if (!manifest.run_id) throw new Error("Artifact manifest has no run version.");
    artifactRoot = `../artifacts/${encodeURIComponent(manifest.run_id)}`;
    HorizonSession.runId = manifest.run_id;
    return Promise.all([fetchJSON(`${artifactRoot}/analytics.json`), fetchJSON(`${artifactRoot}/member-profiles.json`)]);
  })
    .then(([data, profileData]) => {
      state.data = data;
      state.profileData = profileData;
      state.members = data.members || [];
      state.profiles = profileData?.profiles || [];
      state.repositories = makeRepositoryRows(data.organizations || []);
      state.organizations = makeOrganizationRows(data.organizations || [], state.members);
      renderAll();
      const warnings = [
        ...(data.warnings || []),
        ...coverageWarnings(data.coverage || []),
        ...(profileData?.summary?.warnings || []),
        ...(!profileData ? ["Combined member profile artifact is not available; showing Gitea-only data"] : []),
      ];
      renderWarnings([...new Set(warnings)]);
      $("#error-state").hidden = true;
      $("#scope-pill").className = "pill ready";
      $("#scope-pill").textContent = profileData ? `${state.profiles.length} profiles` : (data.history_scope || "Latest run");
      const blameNote = data.blame?.status === "disabled"
        ? "Line ownership was not collected for this run."
        : `Line ownership status: ${data.blame?.status || "unknown"}.`;
      $("#scope-note").textContent = profileData
        ? `Profiles use normalized People Portal email as the stable key; matched Gitea aliases are retained on the linked record. ${blameNote} Diff stats are requested for every selected commit and marked unavailable when collection fails. Metrics are descriptive indicators, not a performance score.`
        : `${data.history_scope?.includes("all discovered") ? "Commit history includes discovered branches; diff stats are requested for every selected commit and marked unavailable when collection fails." : "Commit history uses the default branch."} ${blameNote} Metrics are descriptive indicators, not a score.`;
      setStatus(`Profiles built ${formatDate(profileData?.generated_at || data.generated_at)} · ${formatNumber(state.profiles.length)} member profiles`);
    })
    .catch((error) => {
      $("#scope-pill").className = "pill muted";
      $("#scope-pill").textContent = "No data";
      $("#error-state").hidden = false;
      setStatus(`Could not load analytics: ${error.message}`);
    });
}

function renderWarnings(warnings) {
  const banner = $("#warning-banner");
  if (!warnings.length) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <p class="warning-title">${formatNumber(warnings.length)} data-quality warning${warnings.length === 1 ? "" : "s"}</p>
    <ul>${warnings.map((warning) => `<li><code>${escapeHTML(warning)}</code></li>`).join("")}</ul>
  `;
}

function coverageWarnings(coverage) {
  const gaps = coverage.filter((event) => event && event.status && event.status !== "complete");
  const grouped = new Map();
  gaps.forEach((event) => {
    const key = `${event.status}:${event.path || "unknown endpoint"}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  });
  return [...grouped.entries()].slice(0, 20).map(([key, count]) => {
    const [status, path] = key.split(":", 2);
    return `Gitea ${status} coverage for ${path}${count > 1 ? ` (${count} occurrences)` : ""}`;
  });
}

function renderAll() {
  renderSummary();
  populateOrganizationFilter();
  renderMembers();
  renderRepositories();
  renderOrganizations();
  setView(state.view);
}

function profileMetrics(profile) {
  return profile?.gitea?.metrics || {};
}

function profileName(profile) {
  return profile?.member?.name || profile?.member?.username || profile?.person_id || "Member";
}

function profileOrganizations(profile) {
  return profileMetrics(profile).organizations || [];
}

function stageCount(profile, stage) {
  return Number(profile?.people_portal?.stageCounts?.[stage] || 0);
}

function renderSummary() {
  const data = state.data;
  const repositories = state.repositories;
  const profileSummary = state.profileData?.summary || {};
  const cards = [
    ["Member profiles", state.profiles.length],
    ["Applications", profileSummary.applicationRecordsIncludedInProfiles || 0],
    ["Résumé files", profileSummary.retrievedResumeFiles || 0],
    ["Profiles with notes", profileSummary.profilesWithInterviewNotes || 0],
    ["Gitea-linked profiles", profileSummary.giteaMatchedProfiles || 0],
    ["Gitea roster records", profileSummary.giteaRosterRecords || 0],
    ["Contributor aliases", profileSummary.giteaIdentityAliases || 0],
    ["Unavailable team orgs", profileSummary.giteaUnavailableOrganizations || 0],
    ["Organizations", data.organizations?.length || 0],
    ["Repositories", repositories.length],
    ["Commits", repositories.reduce((total, repo) => total + repo.commitCount, 0)],
    ["Pull requests", repositories.reduce((total, repo) => total + repo.pullCount, 0)],
    ["Issues", repositories.reduce((total, repo) => total + Number(repo.issue_count || 0), 0)],
  ];
  $("#summary-cards").innerHTML = cards.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-label">${escapeHTML(label)}</div>
      <div class="metric-value">${formatNumber(value)}</div>
    </article>
  `).join("");
}

function populateOrganizationFilter() {
  const select = $("#organization-filter");
  const current = state.organization;
  select.innerHTML = '<option value="all">All organizations</option>' + state.organizations
    .map((organization) => `<option value="${escapeHTML(organization.name)}">${escapeHTML(organization.name)}</option>`)
    .join("");
  select.value = state.organizations.some((organization) => organization.name === current) ? current : "all";
  state.organization = select.value;
}

function sortValue(profile) {
  if (state.sort === "name") return profileName(profile).toLowerCase();
  if (state.sort === "applications") return Number(profile?.people_portal?.applicationCount || 0);
  return Number(profileMetrics(profile)[state.sort] || 0);
}

function sortGiteaValue(member) {
  if (state.sort === "name") return String(member.name || member.login || member.email || "").toLowerCase();
  return Number(member[state.sort] || 0);
}

function filteredProfiles() {
  const query = state.search.trim().toLowerCase();
  return state.profiles
    .map((profile, index) => ({ profile, index }))
    .filter(({ profile }) => {
      const matchesOrg = state.organization === "all" || profileOrganizations(profile).includes(state.organization);
      const searchable = [
        profileName(profile),
        profile.person_id,
        profile.member?.username,
        ...(profile.people_portal?.currentRoles || []),
        ...(profile.people_portal?.applicationTeamNames || []),
        ...(profileOrganizations(profile) || []),
        ...(profile.gitea?.identities || []).map((identity) => identity.login),
      ].filter(Boolean).join(" ").toLowerCase();
      return matchesOrg && (!query || searchable.includes(query));
    })
    .sort((left, right) => {
      if (state.sort === "name") return sortValue(left.profile).localeCompare(sortValue(right.profile));
      return sortValue(right.profile) - sortValue(left.profile);
    });
}

function filteredGiteaOnlyMembers() {
  const query = state.search.trim().toLowerCase();
  const linkedLogins = new Set(
    state.profiles.flatMap((profile) => (profile.gitea?.identities || [])
      .map((identity) => identity.login)
      .filter(Boolean))
  );
  return state.members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => {
      if (linkedLogins.has(member.login)) return false;
      const matchesOrg = state.organization === "all" || (member.organizations || []).includes(state.organization);
      const searchable = [member.name, member.login, member.email, ...(member.organizations || [])]
        .filter(Boolean).join(" ").toLowerCase();
      return matchesOrg && (!query || searchable.includes(query));
    })
    .sort((left, right) => {
      if (state.sort === "name") return sortGiteaValue(left.member).localeCompare(sortGiteaValue(right.member));
      return sortGiteaValue(right.member) - sortGiteaValue(left.member);
    });
}

function profileBadge(profile) {
  const badges = [];
  if (!profile.gitea?.matched) badges.push('<span class="badge unmatched">no Gitea match</span>');
  if (profile.gitea?.matched && !profile.gitea?.match?.rosterRecordCount) {
    badges.push('<span class="badge warning">contributor identity only</span>');
  }
  if ((profile.provenance?.warnings || []).length) badges.push('<span class="badge warning">incomplete</span>');
  return badges.join("");
}

function renderMembers() {
  const profiles = filteredProfiles();
  const giteaOnly = filteredGiteaOnlyMembers();
  $("#member-count").textContent = `${formatNumber(profiles.length)} profiles · ${formatNumber(giteaOnly.length)} unlinked Gitea records`;
  const profileRows = profiles.map(({ profile, index }) => ({ kind: "profile", profile, index }));
  const giteaRows = giteaOnly.map(({ member, index }) => ({ kind: "gitea", member, index }));
  const rows = [...profileRows, ...giteaRows].sort((left, right) => {
    const leftValue = left.kind === "profile" ? sortValue(left.profile) : sortGiteaValue(left.member);
    const rightValue = right.kind === "profile" ? sortValue(right.profile) : sortGiteaValue(right.member);
    if (state.sort === "name") return leftValue.localeCompare(rightValue);
    return rightValue - leftValue;
  });
  $("#member-table-body").innerHTML = rows.length ? rows.map((row) => {
    if (row.kind === "gitea") {
      const member = row.member;
      return `
        <tr data-member-index="${row.index}" tabindex="0" role="button" aria-label="View ${escapeHTML(member.name || member.login || member.email)}">
          <td><span class="primary-cell">${escapeHTML(member.name || member.login || "Unmatched identity")} <span class="badge unmatched">unlinked Gitea</span></span><span class="secondary-cell">${escapeHTML(member.email || member.login || "no email")}</span></td>
          <td>${escapeHTML((member.organizations || []).join(", ") || "—")}</td>
          <td class="number-cell">—</td><td class="number-cell">—</td><td class="number-cell">—</td><td class="number-cell">—</td>
          <td class="number-cell">${formatNumber(member.commits)}</td><td class="number-cell">${formatNumber(member.pulls_merged)}</td>
          <td class="number-cell">${formatNumber(member.reviews_submitted)}</td><td class="number-cell">${formatNumber(member.issues_opened)}</td><td class="number-cell">${formatNumber(member.active_days)}</td>
        </tr>
      `;
    }
    const profile = row.profile;
    const metrics = profileMetrics(profile);
    const pp = profile.people_portal || {};
    const resumeLabel = pp.resumeCount ? `${pp.resumeRetrievedCount}/${pp.resumeCount}` : "—";
    const giteaValue = (key) => profile.gitea?.matched ? formatMetric(metrics[key]) : "—";
    const roleTeamLabel = [...(pp.currentRoles || []), ...(pp.applicationTeamNames || [])];
    return `
      <tr data-profile-index="${row.index}" tabindex="0" role="button" aria-label="View ${escapeHTML(profileName(profile))}">
        <td><span class="primary-cell">${escapeHTML(profileName(profile))}${profileBadge(profile)}</span><span class="secondary-cell">${escapeHTML(profile.person_id)}</span></td>
        <td>${escapeHTML(roleTeamLabel.join(", ") || "—")}</td>
        <td class="number-cell">${formatNumber(pp.applicationCount)}</td>
        <td class="number-cell">${formatNumber(stageCount(profile, "Hired"))}</td>
        <td class="number-cell">${formatNumber(pp.notesCount)}</td>
        <td class="number-cell">${escapeHTML(resumeLabel)}</td>
        <td class="number-cell">${giteaValue("commits")}</td>
        <td class="number-cell">${giteaValue("pulls_merged")}</td>
        <td class="number-cell">${giteaValue("reviews_submitted")}</td>
        <td class="number-cell">${giteaValue("issues_opened")}</td>
        <td class="number-cell">${giteaValue("active_days")}</td>
      </tr>
    `;
  }).join("") : emptyRow(11, "No profiles or unlinked Gitea records match the current filters.");
}

function renderRepositories() {
  const rows = [...state.repositories].sort((a, b) => b.commitCount - a.commitCount || a.name.localeCompare(b.name));
  $("#repository-count").textContent = `${formatNumber(rows.length)} repositories`;
  $("#repository-table-body").innerHTML = rows.length ? rows.map((repo) => `
    <tr>
      <td><span class="primary-cell">${escapeHTML(repo.name)}</span><span class="secondary-cell">${escapeHTML(repo.organization)}/${escapeHTML(repo.name)}</span></td>
      <td>${escapeHTML(repo.organization)}</td><td>${escapeHTML(repo.default_branch || "—")}</td>
      <td class="number-cell">${formatNumber((repo.branches || []).length)}</td><td class="number-cell">${formatNumber(repo.commitCount)}</td>
      <td class="number-cell">${formatNumber(repo.pullCount)}</td><td class="number-cell">${formatNumber(repo.mergedCount)}</td>
      <td class="number-cell">${formatNumber(repo.issue_count)}</td>
      <td><a class="link-icon" href="${escapeHTML(/^https?:\/\//i.test(repo.html_url || "") ? repo.html_url : "#")}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHTML(repo.name)} in Gitea">↗</a></td>
    </tr>
  `).join("") : emptyRow(9, "No repositories were collected.");
}

function renderOrganizations() {
  const rows = [...state.organizations].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  $("#organization-count").textContent = `${formatNumber(rows.length)} organizations`;
  $("#organization-table-body").innerHTML = rows.length ? rows.map((organization) => `
    <tr>
      <td class="primary-cell">${escapeHTML(organization.name)}</td><td class="number-cell">${formatNumber(organization.roster)}</td>
      <td class="number-cell">${formatNumber(organization.activeMembers)}</td><td class="number-cell">${formatNumber(organization.repositories)}</td>
      <td class="number-cell">${formatNumber(organization.branches)}</td><td class="number-cell">${formatNumber(organization.commits)}</td>
      <td class="number-cell">${formatNumber(organization.pulls)}</td><td class="number-cell">${formatNumber(organization.merged)}</td>
      <td class="number-cell">${formatNumber(organization.issues)}</td><td class="number-cell">${formatMetric(organization.blameLines)}</td>
    </tr>
  `).join("") : emptyRow(10, "No organizations were collected.");
}

function displayObject(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderObjectList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return `<dl class="profile-fields">${Object.entries(value).map(([key, child]) => `
    <div><dt>${escapeHTML(key)}</dt><dd>${escapeHTML(displayObject(child))}</dd></div>
  `).join("")}</dl>`;
}

function renderApplication(application, index) {
  const info = application.applicationInfo || {};
  const card = application.applicationCard || {};
  const stage = info.stage || card.stage || "Unknown";
  const roles = info.rolePreferences || card.rolePreferences || [];
  const stageHistory = Array.isArray(info.stageHistory)
    ? [...info.stageHistory].sort((left, right) => String(left.changedAt || "").localeCompare(String(right.changedAt || "")))
    : [];
  const responses = info.responses && typeof info.responses === "object" ? info.responses : {};
  const note = info.notes ? `<div class="application-note"><strong>Interview notes</strong><p>${escapeHTML(info.notes)}</p></div>` : "";
  const responseMarkup = Object.keys(responses).length
    ? `<div class="application-responses"><strong>Responses</strong>${Object.entries(responses).map(([question, answer]) => `<div class="response"><span>${escapeHTML(question)}</span><p>${escapeHTML(displayObject(answer))}</p></div>`).join("")}</div>`
    : "";
  const historyMarkup = stageHistory.length
    ? `<div class="application-history"><strong>Stage history</strong><ul>${stageHistory.map((event) => `<li>${escapeHTML(event.stage || "Unknown")} · ${escapeHTML(formatDate(event.changedAt) || "undated")}</li>`).join("")}</ul></div>`
    : "";
  return `
    <article class="application-card">
      <div class="application-heading"><strong>${escapeHTML(application.teamName || application.teamId || `Application ${index + 1}`)}</strong><span class="stage-pill">${escapeHTML(stage)}</span></div>
      <p class="secondary-cell">Applied ${escapeHTML(formatDate(info.appliedAt || card.appliedAt) || "date unavailable")} · ${escapeHTML(String(info.stars ?? card.stars ?? "No rating"))} stars</p>
      <p><strong>Role preferences:</strong> ${escapeHTML(Array.isArray(roles) ? roles.map((role) => role.role || role.name || displayObject(role)).join(", ") : displayObject(roles)) || "—"}</p>
      ${note}${historyMarkup}${responseMarkup}
    </article>
  `;
}

function showProfile(profile) {
  const member = profile.member || {};
  const attributes = member.attributes || {};
  const metrics = profileMetrics(profile);
  const pp = profile.people_portal || {};
  const resumeMarkup = (pp.resumes || []).length
    ? `<ul class="resume-list">${pp.resumes.map((resume) => resume.path
      ? `<li><a href="${artifactRoot}/${escapeHTML(resume.path)}" data-resume-download>Open résumé</a><span>${escapeHTML(resume.retrieved ? "Retrieved locally" : "Available but not retrieved")}</span></li>`
      : `<li><span>Résumé ${escapeHTML(resume.available ? "available but not retrieved" : "not available")}</span></li>`).join("")}</ul>`
    : "<p>No résumé record is linked to this profile.</p>";
  const giteaMetricRows = [
    ["Commits", metrics.commits], ["Additions", metrics.additions], ["Deletions", metrics.deletions],
    ["PRs opened", metrics.pulls_opened], ["PRs merged", metrics.pulls_merged], ["Reviews", metrics.reviews_submitted],
    ["Approvals", metrics.reviews_approved], ["Issues", metrics.issues_opened], ["Active days", metrics.active_days],
    ["Blame lines", metrics.blame_lines],
  ];
  const identityAliases = (profile.gitea?.identities || [])
    .flatMap((identity) => identity.identityAliases || []);
  const matchLabel = profile.gitea?.match?.method === "normalized_email_exact"
    ? "Exact normalized email"
    : "No deterministic match";
  $("#dialog-member-name").textContent = profileName(profile);
  $("#dialog-content").innerHTML = `
    <div class="profile-summary"><span>${escapeHTML(profile.person_id)}</span><span>${escapeHTML(attributes.major || "Major not recorded")}</span><span>${escapeHTML(attributes.expectedGrad ? `Graduation ${formatDate(attributes.expectedGrad)}` : "Graduation not recorded")}</span></div>
    <div class="detail-section"><h3>Membership and identity</h3><p>${escapeHTML(member.username || "No People Portal username")} · Current roles: ${escapeHTML((pp.currentRoles || []).join(", ") || "No current roles recorded")}</p><p>Historical application teams: ${escapeHTML((pp.applicationTeamNames || []).join(", ") || "No application teams")}</p>${renderObjectList(attributes)}</div>
    <div class="detail-section"><h3>Résumé files</h3>${resumeMarkup}</div>
    <div class="detail-section"><h3>People Portal applications</h3>${(pp.applications || []).length ? (pp.applications || []).map(renderApplication).join("") : "<p>No member-linked applications were found in this snapshot.</p>"}</div>
    <div class="detail-section"><h3>Gitea activity</h3>${profile.gitea?.matched ? `<div class="detail-grid">${giteaMetricRows.map(([label, value]) => `<div class="detail-metric"><span class="detail-label">${escapeHTML(label)}</span><strong>${formatMetric(value)}</strong></div>`).join("")}</div><p>Match: ${escapeHTML(matchLabel)} · ${profile.gitea?.match?.rosterRecordCount ? "Gitea roster member" : "contributor identity only"}</p><p>Linked login(s): ${escapeHTML((profile.gitea.identities || []).map((identity) => identity.login).filter(Boolean).join(", ") || "—")}</p><p>Preserved contributor aliases: ${formatNumber(identityAliases.length)}</p><p>Organizations: ${escapeHTML((metrics.organizations || []).join(", ") || "—")}</p>` : "<p>No Gitea record matched this normalized email.</p>"}</div>
    <div class="detail-section"><h3>Data quality and provenance</h3><p>People Portal snapshot: ${escapeHTML(formatDate(profile.provenance?.peoplePortalGeneratedAt) || "unknown")} · Gitea snapshot: ${escapeHTML(formatDate(profile.provenance?.giteaGeneratedAt) || "unknown")}</p><p>Gitea scope: ${escapeHTML(profile.provenance?.giteaHistoryScope || "unknown")}</p><p>Line ownership: ${escapeHTML(profile.provenance?.giteaBlame?.status || "unknown")} · Line stats: ${escapeHTML(metrics.commit_stats_status || "unknown")}</p>${(profile.provenance?.warnings || []).length ? `<ul class="warning-list">${profile.provenance.warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join("")}</ul>` : "<p>No profile-specific warnings.</p>"}</div>
  `;
  const dialog = $("#member-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
}

function showGiteaOnlyMember(member) {
  $("#dialog-member-name").textContent = member.name || member.login || "Gitea member";
  const metrics = [
    ["Commits", member.commits], ["Additions", member.additions], ["Deletions", member.deletions],
    ["PRs opened", member.pulls_opened], ["PRs merged", member.pulls_merged], ["Reviews", member.reviews_submitted],
    ["Approvals", member.reviews_approved], ["Issues", member.issues_opened], ["Active days", member.active_days],
    ["Blame lines", member.blame_lines],
  ];
  const candidates = [...new Set((member.identity_aliases || [])
    .flatMap((alias) => alias.candidate_identities || []))];
  $("#dialog-content").innerHTML = `<div class="detail-section"><h3>Gitea identity</h3><p>${escapeHTML(member.login || "—")} · ${escapeHTML(member.email || "no email")}</p><p>This activity was collected from Gitea but is not attached to a People Portal profile. It remains visible here rather than being discarded.</p><div class="detail-grid">${metrics.map(([label, value]) => `<div class="detail-metric"><span class="detail-label">${escapeHTML(label)}</span><strong>${formatMetric(value)}</strong></div>`).join("")}</div><p>Organizations: ${escapeHTML((member.organizations || []).join(", ") || "—")}</p>${candidates.length ? `<p>Candidate roster identities: ${escapeHTML(candidates.join(", "))}</p>` : ""}</div>`;
  const dialog = $("#member-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${view}`));
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function emptyRow(columns, message) {
  return `<tr class="empty-row"><td colspan="${columns}">${escapeHTML(message)}</td></tr>`;
}

function setStatus(message) {
  $("#status-message").textContent = message;
}

$("#refresh-button").addEventListener("click", loadData);
$("#member-search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderMembers();
});
$("#organization-filter").addEventListener("change", (event) => {
  state.organization = event.target.value;
  renderMembers();
});
$("#member-sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderMembers();
});
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
$("#member-table-body").addEventListener("click", (event) => {
  const profileRow = event.target.closest("tr[data-profile-index]");
  if (profileRow) return showProfile(state.profiles[Number(profileRow.dataset.profileIndex)]);
  const memberRow = event.target.closest("tr[data-member-index]");
  if (memberRow) showGiteaOnlyMember(state.members[Number(memberRow.dataset.memberIndex)]);
});
$("#member-table-body").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const profileRow = event.target.closest("tr[data-profile-index]");
  const memberRow = event.target.closest("tr[data-member-index]");
  if (profileRow || memberRow) {
    event.preventDefault();
    if (profileRow) showProfile(state.profiles[Number(profileRow.dataset.profileIndex)]);
    else showGiteaOnlyMember(state.members[Number(memberRow.dataset.memberIndex)]);
  }
});
$("#close-dialog").addEventListener("click", () => $("#member-dialog").close());
$("#member-dialog").addEventListener("click", (event) => {
  if (event.target === $("#member-dialog")) $("#member-dialog").close();
});

loadData();

window.addEventListener("horizon-session-change", loadData);
document.addEventListener("click", async (event) => {
  const link = event.target.closest("[data-resume-download]");
  if (!link) return;
  event.preventDefault();
  try {
    const response = await HorizonSession.fetch(link.href);
    const url = URL.createObjectURL(await response.blob());
    const download = document.createElement("a");
    download.href = url;
    download.download = "resume.pdf";
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { setStatus(error.message); }
});
