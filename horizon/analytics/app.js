
const state = {
  data: null,
  members: [],
  repositories: [],
  organizations: [],
  view: "members",
  search: "",
  organization: "all",
  sort: "commits",
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

function loadData() {
  setStatus("Loading latest analytics…");
  return HorizonSession.fetch('../artifacts/latest/manifest.json')
    .then(response => response.json())
    .then(manifest => {
      if (!manifest.run_id) throw new Error('Artifact manifest has no run version.');
      HorizonSession.runId = manifest.run_id;
      return HorizonSession.fetch(`../artifacts/${encodeURIComponent(manifest.run_id)}/analytics.json`);
    })
    .then((response) => {
      if (!response.ok) throw new Error(`analytics.json returned HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      state.data = data;
      state.members = data.members || [];
      state.repositories = makeRepositoryRows(data.organizations || []);
      state.organizations = makeOrganizationRows(data.organizations || [], state.members);
      renderAll();
      renderWarnings([...new Set([...(data.warnings || []), ...coverageWarnings(data.coverage || [])])]);
      $("#error-state").hidden = true;
      $("#scope-pill").className = "pill ready";
      $("#scope-pill").textContent = data.history_scope || "Latest run";
      const historyNote = data.history_scope?.includes("all discovered")
        ? "Commit history includes discovered branches; diff stats are requested for every selected commit and marked unavailable when collection fails."
        : "Commit history uses the default branch.";
      const blameNote = data.blame?.status === "disabled"
        ? "Line ownership was not collected for this run."
        : `Line ownership status: ${data.blame?.status || "unknown"}.`;
      $("#scope-note").textContent = `${historyNote} ${blameNote} Metrics are descriptive indicators, not a score.`;
      setStatus(`Updated ${formatDate(data.generated_at)} · ${formatNumber(data.api_calls)} API calls`);
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
    <p class="warning-title">${formatNumber(warnings.length)} collection warning${warnings.length === 1 ? "" : "s"} — some data is missing from this run</p>
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

function renderSummary() {
  const data = state.data;
  const repositories = state.repositories;
  const cards = [
    ["Organizations", data.organizations?.length || 0],
    ["Repositories", repositories.length],
    ["Roster memberships", sum(data.organizations || [], "member_count")],
    ["Roster members", state.members.filter((member) => member.roster_member !== false && !member.service_or_admin).length],
    ["Unmatched identities", state.members.filter((member) => member.roster_member === false).length],
    ["Repository commits", repositories.reduce((total, repo) => total + repo.commitCount, 0)],
    ["Pull requests", repositories.reduce((total, repo) => total + repo.pullCount, 0)],
    ["Issues", repositories.reduce((total, repo) => total + Number(repo.issue_count || 0), 0)],
    ["Blame lines", sumAvailable(state.members, "blame_lines")],
  ];
  $("#summary-cards").innerHTML = cards.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-label">${escapeHTML(label)}</div>
      <div class="metric-value">${formatMetric(value)}</div>
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

function filteredMembers() {
  const query = state.search.trim().toLowerCase();
  return state.members
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => {
      const matchesOrg = state.organization === "all" || (member.organizations || []).includes(state.organization);
      const searchable = [member.name, member.login, member.email, ...(member.organizations || [])]
        .filter(Boolean).join(" ").toLowerCase();
      return matchesOrg && (!query || searchable.includes(query));
    })
    .sort((left, right) => {
      if (state.sort === "name") return displayName(left.member).localeCompare(displayName(right.member));
      return Number(right.member[state.sort] || 0) - Number(left.member[state.sort] || 0);
    });
}

function memberBadge(member) {
  if (member.service_or_admin) {
    return ' <span class="badge service" title="Admin or automation account; not comparable with member rows">service</span>';
  }
  if (member.roster_member === false) {
    return ' <span class="badge unmatched" title="Commit identity that could not be matched to a Gitea roster member; may duplicate a member row">unmatched</span>';
  }
  return "";
}

function renderMembers() {
  const rows = filteredMembers();
  $("#member-count").textContent = `${formatNumber(rows.length)} of ${formatNumber(state.members.length)} records`;
  $("#member-table-body").innerHTML = rows.length ? rows.map(({ member, index }) => `
    <tr data-member-index="${index}" data-member-login="${escapeHTML(member.login)}" tabindex="0" role="button" aria-label="View ${escapeHTML(displayName(member))}">
      <td><span class="primary-cell">${escapeHTML(displayName(member))}${memberBadge(member)}</span><span class="secondary-cell">${escapeHTML(member.login || member.email || "unmatched identity")}</span></td>
      <td>${escapeHTML((member.organizations || []).join(", ") || "—")}</td>
      <td class="number-cell">${formatNumber(member.commits)}</td>
      <td class="number-cell positive">${formatMetric(member.additions)}</td>
      <td class="number-cell">${formatMetric(member.deletions)}</td>
      <td class="number-cell">${formatMetric(member.unique_files ?? member.files_changed)}</td>
      <td class="number-cell">${formatNumber(member.pulls_opened)}</td>
      <td class="number-cell">${formatNumber(member.pulls_merged)}</td>
      <td class="number-cell">${formatNumber(member.reviews_submitted)}</td>
      <td class="number-cell">${formatNumber(member.reviews_approved)}</td>
      <td class="number-cell">${formatNumber(member.issues_opened)}</td>
      <td class="number-cell">${formatNumber(member.active_days)}</td>
      <td class="number-cell">${formatMetric(member.blame_lines)}</td>
    </tr>
  `).join("") : emptyRow(13, "No members match the current filters.");
}

function renderRepositories() {
  const rows = [...state.repositories].sort((a, b) => b.commitCount - a.commitCount || a.name.localeCompare(b.name));
  $("#repository-count").textContent = `${formatNumber(rows.length)} repositories`;
  $("#repository-table-body").innerHTML = rows.length ? rows.map((repo) => `
    <tr>
      <td><span class="primary-cell">${escapeHTML(repo.name)}</span><span class="secondary-cell">${escapeHTML(repo.organization)}/${escapeHTML(repo.name)}</span></td>
      <td>${escapeHTML(repo.organization)}</td>
      <td>${escapeHTML(repo.default_branch || "—")}</td>
      <td class="number-cell">${formatNumber((repo.branches || []).length)}</td>
      <td class="number-cell">${formatNumber(repo.commitCount)}</td>
      <td class="number-cell">${formatNumber(repo.pullCount)}</td>
      <td class="number-cell">${formatNumber(repo.mergedCount)}</td>
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
      <td class="primary-cell">${escapeHTML(organization.name)}</td>
      <td class="number-cell">${formatNumber(organization.roster)}</td>
      <td class="number-cell">${formatNumber(organization.activeMembers)}</td>
      <td class="number-cell">${formatNumber(organization.repositories)}</td>
      <td class="number-cell">${formatNumber(organization.branches)}</td>
      <td class="number-cell">${formatNumber(organization.commits)}</td>
      <td class="number-cell">${formatNumber(organization.pulls)}</td>
      <td class="number-cell">${formatNumber(organization.merged)}</td>
      <td class="number-cell">${formatNumber(organization.issues)}</td>
      <td class="number-cell">${formatMetric(organization.blameLines)}</td>
    </tr>
  `).join("") : emptyRow(10, "No organizations were collected.");
}

function showMember(member) {
  $("#dialog-member-name").textContent = displayName(member);
  const firstActivity = formatDate(member.first_activity);
  const lastActivity = formatDate(member.last_activity);
  const activityWindow = firstActivity || lastActivity
    ? `${firstActivity || "Unknown start"} → ${lastActivity || "Unknown end"}`
    : "No recorded activity in the collected scope";
  const metrics = [
    ["Commits", member.commits], ["Additions", member.additions], ["Deletions", member.deletions],
    ["Files changed", member.files_changed], ["PRs opened", member.pulls_opened], ["PRs merged", member.pulls_merged],
    ["Reviews", member.reviews_submitted], ["Approvals", member.reviews_approved], ["Issues", member.issues_opened],
    ["Active days", member.active_days], ["Blame lines", member.blame_lines], ["Blame files", member.blame_files],
  ];
  $("#dialog-content").innerHTML = `
    <div class="detail-grid">${metrics.map(([label, value]) => `
      <div class="detail-metric"><span class="detail-label">${escapeHTML(label)}</span><strong>${formatMetric(value)}</strong></div>
    `).join("")}</div>
    <div class="detail-section"><h3>Identity</h3><p>${escapeHTML(member.login || "—")} · ${escapeHTML(member.email || "no email")}</p></div>
    <div class="detail-section"><h3>Organizations</h3><p>${escapeHTML((member.organizations || []).join(", ") || "—")}</p></div>
    <div class="detail-section"><h3>Repositories touched</h3><p>${escapeHTML((member.repositories || []).join(", ") || "—")}</p></div>
    <div class="detail-section"><h3>Activity window</h3><p>${escapeHTML(activityWindow)}</p></div>
  `;
  const dialog = $("#member-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${view}`));
}

function displayName(member) {
  return member.name || member.login || member.email || "Unmatched identity";
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
  const row = event.target.closest("tr[data-member-index]");
  if (row) showMember(state.members[Number(row.dataset.memberIndex)]);
});
$("#member-table-body").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-member-index]");
  if (row) { event.preventDefault(); showMember(state.members[Number(row.dataset.memberIndex)]); }
});
$("#close-dialog").addEventListener("click", () => $("#member-dialog").close());
$("#member-dialog").addEventListener("click", (event) => {
  if (event.target === $("#member-dialog")) $("#member-dialog").close();
});

loadData();

window.addEventListener("horizon-session-change", loadData);
