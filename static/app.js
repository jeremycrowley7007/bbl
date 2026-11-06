let players = [];
let playerOrder = [];
let currentTab = "season";
let activeSeason = null;
let adminMode = false;
let currentDetailReqId = null;
let photoUploadPlayerId = null;
let requestPage = 1;
let pastPlayerFilter = "";
let requestLoadToken = 0;

let requestCache = {};

const REQUESTS_PER_PAGE = 6;
const TN_MAX_PER_PLACE = 4;

let tournaments = [];

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name, value) {
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
}

const sessionVotes = JSON.parse(getCookie('bbl_votes') || '{}');

function saveVotes() {
  setCookie('bbl_votes', JSON.stringify(sessionVotes));
}

const STAT_NAMES = {
  placement: "PLC",
  bowling: "BWL",
  tilt_aversion: "TLT",
  wall_ball: "WBL",
  substance_use: "SUB",
  flair: "CLH",
};

const STAT_FULL = {
  placement: "Placement",
  bowling: "Bowling",
  tilt_aversion: "Tilt Aversion",
  wall_ball: "Wall Ball",
  substance_use: "Substance Use",
  flair: "Clutch",
};

const STAT_DESC = {
  placement: "Accuracy when laying the ball near the pallino",
  bowling: "Power and consistency on approach throws",
  tilt_aversion: "Composure a mature player shows in tough situations",
  wall_ball: "Bank shots and using the court edges",
  substance_use: "Performance enhancement via beverages",
  flair: "How often they turn a round from -x to +x with their last shot",
};

const STAT_KEYS = Object.keys(STAT_NAMES);

function computeOverallFromValues(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, val) => sum + val, 0) / values.length);
}

function isClosedRequest(r) {
  return r.status !== "open";
}

function getStatBaseline(r, player, key) {
  if (!player) return null;
  if (isClosedRequest(r) && r[`before_${key}`] != null) {
    return r[`before_${key}`];
  }
  return player[key];
}

function getMergedStatValues(r, player, prefix) {
  if (!player) return null;
  const closed = isClosedRequest(r);
  return STAT_KEYS.map((key) => {
    const fromRequest = r[`${prefix}_${key}`];
    if (fromRequest != null) return fromRequest;
    if (prefix === "proposed" && closed) {
      return r[`before_${key}`] ?? player[key];
    }
    if (prefix === "before") {
      return r[`before_${key}`] ?? player[key];
    }
    return player[key];
  });
}

function computeMergedOverall(r, player, prefix) {
  const values = getMergedStatValues(r, player, prefix);
  if (!values) return null;
  return computeOverallFromValues(values);
}

function getRequestOverallChange(r, player) {
  if (!player || r.request_type === "new_player") return null;

  const hasProposedChange = STAT_KEYS.some((key) => r[`proposed_${key}`] != null);
  if (!hasProposedChange) return null;

  const proposedOverall = computeMergedOverall(r, player, "proposed");
  if (proposedOverall == null) return null;

  if (isClosedRequest(r)) {
    const hasBefore = STAT_KEYS.some((key) => r[`before_${key}`] != null);
    if (!hasBefore) {
      return { baseline: null, proposed: proposedOverall, diff: null, legacy: true };
    }
    const beforeOverall = computeMergedOverall(r, player, "before");
    return {
      baseline: beforeOverall,
      proposed: proposedOverall,
      diff: proposedOverall - beforeOverall,
      legacy: false,
    };
  }

  return {
    baseline: player.overall,
    proposed: proposedOverall,
    diff: proposedOverall - player.overall,
    legacy: false,
  };
}

function renderOverallInTag(r, player) {
  const change = getRequestOverallChange(r, player);
  if (!change) return "";

  if (change.legacy) {
    return `<span class="rc-overall-delta legacy">→ <span class="ovr-new">${change.proposed}</span></span>`;
  }

  if (change.diff === 0) return "";

  const cls = change.diff > 0 ? "up" : "down";
  return `<span class="rc-overall-delta ${cls}"><span class="ovr-old">${change.baseline}</span>→<span class="ovr-new">${change.proposed}</span></span>`;
}

function renderOverallCompareRow(r, player) {
  const change = getRequestOverallChange(r, player);
  if (!change) return "";

  if (change.legacy) {
    return `
    <div class="detail-overall-strip legacy">
      <span class="detail-overall-strip-label">Overall</span>
      <span class="detail-overall-strip-values">→ <span class="ovr-new">${change.proposed}</span></span>
    </div>`;
  }

  const cls = change.diff > 0 ? "up" : change.diff < 0 ? "down" : "same";
  return `
    <div class="detail-overall-strip ${cls}">
      <span class="detail-overall-strip-label">Overall</span>
      <span class="detail-overall-strip-values"><span class="ovr-old">${change.baseline}</span> → <span class="ovr-new">${change.proposed}</span></span>
    </div>`;
}

function getStoredName() {
  return localStorage.getItem("bocce_name") || "";
}

function setStoredName(name) {
  localStorage.setItem("bocce_name", name);
}

function statColor(val) {
  if (val >= 75) return "high";
  if (val >= 60) return "mid";
  return "low";
}

function cardTier(overall) {
  if (overall >= 75) return "gold";
  if (overall >= 65) return "silver";
  return "bronze";
}

function timeAgo(dateStr) {
  const d = new Date(dateStr + "Z");
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function getInitials(name) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Rendering ---

async function loadPlayers() {
  const res = await fetch("/api/players");
  players = await res.json();
  renderPlayerCards();
  populatePlayerSelect();
  populatePastPlayerFilter();
  if (currentTab === "trophies") renderTrophyRoom();
  if (currentTab === "season") loadSeason();
}

// The roster is dealt in a fresh random order on every visit so the same faces
// aren't always on top. The order is held for the rest of the session, though,
// so cards don't reshuffle underneath you when the grid re-renders.
function rosterOrder() {
  const byId = new Map(players.map((p) => [p.id, p]));
  const seen = playerOrder.filter((id) => byId.has(id));
  const fresh = players.filter((p) => !seen.includes(p.id)).map((p) => p.id);
  playerOrder = [...seen, ...shuffle(fresh)];
  return playerOrder.map((id) => byId.get(id));
}

function renderPlayerCards() {
  const grid = document.getElementById("player-cards");
  const statRows = [
    ["placement", "wall_ball"],
    ["bowling", "substance_use"],
    ["tilt_aversion", "flair"],
  ];

  grid.innerHTML = rosterOrder()
    .map((p) => {
      const tier = cardTier(p.overall);
      const hasPhoto = p.photo_url && p.photo_url.length > 0;
      const photoHtml = hasPhoto
        ? `<img src="${p.photo_url}" alt="${p.name}">`
        : `<span class="fut-photo-initials">${getInitials(p.name)}</span>`;

      const statsHtml = statRows
        .map(
          ([left, right]) => `
          <div class="fut-stat-row">
            <div class="fut-stat">
              <span class="fut-stat-val">${p[left]}</span>
              <span class="fut-stat-label">${STAT_NAMES[left]}</span>
            </div>
            <div class="fut-stat">
              <span class="fut-stat-val">${p[right]}</span>
              <span class="fut-stat-label">${STAT_NAMES[right]}</span>
            </div>
          </div>`
        )
        .join("");

      const adminEditBtn = adminMode
        ? `<div class="fut-admin-edit" onclick="event.stopPropagation(); openAdminEditModal(${p.id})">EDIT</div>`
        : "";

      return `
      <div class="fut-card tier-${tier}" onclick="openCardZoom(${p.id})">
        <div class="fut-card-inner">
          <div class="fut-card-face">
            ${adminEditBtn}
            <div class="fut-card-name">${p.name}</div>
            <div class="fut-card-body">
              <div class="fut-card-meta">
                <div class="fut-rating">${p.overall}</div>
                <div class="fut-position">BBL</div>
              </div>
              <div class="fut-photo" onclick="event.stopPropagation(); triggerPhotoUpload(${p.id})">
                ${photoHtml}
                <div class="fut-photo-overlay"><span>+</span></div>
              </div>
            </div>
            <div class="fut-card-divider"></div>
            <div class="fut-card-stats">
              ${statsHtml}
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function populatePlayerSelect() {
  const select = document.getElementById("req-player");
  select.innerHTML =
    '<option value="">Select player...</option>' +
    players.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
}

function populatePastPlayerFilter() {
  const select = document.getElementById("past-player-filter");
  if (!select) return;
  const options = players
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">All players</option>${options}`;
  select.value = pastPlayerFilter;
}

async function loadRequests() {
  const token = ++requestLoadToken;
  const countsPromise = fetch("/api/requests/counts").then((res) => res.json());

  if (currentTab === "trophies") {
    const [counts, loaded] = await Promise.all([
      countsPromise,
      fetch("/api/tournaments").then((res) => res.json()),
    ]);
    if (token !== requestLoadToken) return;
    updateRequestCounts(counts);
    tournaments = loaded;
    renderTrophyRoom();
    return;
  }

  if (currentTab === "season") {
    const counts = await countsPromise;
    if (token !== requestLoadToken) return;
    updateRequestCounts(counts);
    return;
  }

  if (currentTab !== "open" && currentTab !== "closed") return;

  const params = new URLSearchParams({
    status: currentTab,
    page: String(requestPage),
    per_page: String(REQUESTS_PER_PAGE),
  });
  if (currentTab === "closed" && pastPlayerFilter) {
    params.set("player_id", pastPlayerFilter);
  }

  const list = document.getElementById("requests-list");
  list.classList.add("requests-loading");

  const [counts, pageData] = await Promise.all([
    countsPromise,
    fetch(`/api/requests?${params}`).then((res) => res.json()),
  ]);
  if (token !== requestLoadToken) return;

  updateRequestCounts(counts);
  requestPage = pageData.page;

  const details = await Promise.all(
    pageData.items.map((r) => fetch(`/api/requests/${r.id}`).then((res) => res.json()))
  );
  if (token !== requestLoadToken) return;

  details.forEach((d) => { requestCache[d.id] = d; });
  renderRequests(details);
  renderRequestPagination(pageData);
  list.classList.remove("requests-loading");
}

function updateRequestCounts(counts) {
  document.getElementById("open-count").textContent = counts.open;
  document.getElementById("closed-count").textContent = counts.closed;
}

function changePastPlayerFilter(playerId) {
  pastPlayerFilter = playerId;
  requestPage = 1;
  loadRequests();
}

function goToRequestPage(page) {
  requestPage = page;
  loadRequests();
  document.getElementById("league-section").scrollIntoView({ behavior: "smooth" });
}

function renderRequestPagination(pageData) {
  const container = document.getElementById("request-pagination");
  if (pageData.pages <= 1) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <button type="button" class="page-btn" onclick="goToRequestPage(${pageData.page - 1})"
      ${pageData.page <= 1 ? "disabled" : ""} aria-label="Previous page">&larr;</button>
    <span>Page ${pageData.page} of ${pageData.pages}</span>
    <button type="button" class="page-btn" onclick="goToRequestPage(${pageData.page + 1})"
      ${pageData.page >= pageData.pages ? "disabled" : ""} aria-label="Next page">&rarr;</button>`;
}

function renderRequests(reqs) {
  const container = document.getElementById("requests-list");

  if (reqs.length === 0) {
    const openCta =
      currentTab === "open"
        ? `<div class="empty-state-actions">
            <button type="button" class="btn btn-primary" onclick="leagueStatChange()">Request Stat Change</button>
            <button type="button" class="btn btn-secondary" onclick="leagueNewPlayer()">New Player</button>
          </div>`
        : "";
    container.innerHTML = `
      <div class="empty-state">
        <div class="emoji">${currentTab === "open" ? "🎯" : "📋"}</div>
        <p>${
          currentTab === "open"
            ? "No open requests yet. Think someone's stats need updating?"
            : "No past requests yet."
        }</p>
        ${openCta}
      </div>`;
    return;
  }

  container.innerHTML = reqs.map((r) => renderRequestCard(r)).join("");
}

const PLACE_META = {
  1: { medal: "🏆", label: "Champion" },
  2: { medal: "🥈", label: "Runner-up" },
  3: { medal: "🥉", label: "Third Place" },
};

function renderTrophyRoom() {
  const room = document.getElementById("trophy-room");
  const cabinets = trophyCabinets();
  const adminTools = adminMode
    ? `<div class="trophy-admin">
        <button type="button" class="btn btn-primary" onclick="openTournamentModal()">Add Tournament Results</button>
        ${tournaments.length ? `<div class="trophy-admin-list">${tournaments.map((t) => `
          <div class="trophy-admin-row">
            <span>${escapeHtml(t.name)}</span>
            <button type="button" class="btn btn-small btn-secondary" onclick="openTournamentModal(${t.id})">Edit</button>
            <button type="button" class="btn btn-small btn-secondary trophy-delete" onclick="deleteTournament(${t.id})">Delete</button>
          </div>`).join("")}</div>` : ""}
      </div>`
    : "";

  room.innerHTML = `
    <div class="trophy-intro">
      <span class="trophy-intro-mark" aria-hidden="true">🏆</span>
      <div>
        <h3>Trophy Room</h3>
        <p>Every tournament finish, kept with the player who earned it.</p>
      </div>
    </div>
    ${adminTools}
    ${cabinets.length
      ? `<div class="trophy-case-grid">${cabinets.map(renderTrophyCabinet).join("")}</div>`
      : `<div class="empty-state"><div class="emoji">🏆</div><p>No tournament results yet.</p></div>`}`;
}

function trophyCabinets() {
  const byPerson = new Map();
  tournaments.forEach((tournament) => {
    [1, 2, 3].forEach((place) => {
      const team = tournament.places[String(place)] || [];
      team.forEach((person) => {
        const key = person.player_id ? `p${person.player_id}` : `g${person.name.toLowerCase()}`;
        if (!byPerson.has(key)) {
          byPerson.set(key, {
            key,
            name: person.name,
            playerId: person.player_id,
            photoUrl: person.photo_url || "",
            trophies: [],
          });
        }
        const cabinet = byPerson.get(key);
        cabinet.name = person.name;
        if (person.photo_url) cabinet.photoUrl = person.photo_url;
        cabinet.trophies.push({
          place,
          ...PLACE_META[place],
          tournament: tournament.name,
          partners: team.filter((mate) => mate.name !== person.name).map((mate) => mate.name),
        });
      });
    });
  });

  const tally = (cabinet, place) => cabinet.trophies.filter((t) => t.place === place).length;
  return [...byPerson.values()]
    .map((cabinet) => {
      cabinet.trophies.sort((a, b) => a.place - b.place || a.tournament.localeCompare(b.tournament));
      return cabinet;
    })
    .sort(
      (a, b) =>
        tally(b, 1) - tally(a, 1) ||
        tally(b, 2) - tally(a, 2) ||
        tally(b, 3) - tally(a, 3) ||
        a.name.localeCompare(b.name)
    );
}

function renderTrophyCabinet(cabinet) {
  const photo = cabinet.photoUrl
    ? `<img src="${cabinet.photoUrl}" alt="${escapeHtml(cabinet.name)}">`
    : `<span>${getInitials(cabinet.name)}</span>`;
  const best = cabinet.trophies[0];
  const bestCount = cabinet.trophies.filter((t) => t.place === best.place).length;
  const headline = bestCount > 1 ? `${bestCount}× ${best.label}` : best.label;
  const shelf = cabinet.trophies
    .map((trophy) => `
      <div class="trophy-item">
        <span class="trophy-item-medal" aria-hidden="true">${trophy.medal}</span>
        <div class="trophy-item-text">
          <strong>${trophy.label}</strong>
          <span>${escapeHtml(trophy.tournament)}${trophy.partners.length ? ` · w/ ${trophy.partners.map(escapeHtml).join(", ")}` : ""}</span>
        </div>
      </div>`)
    .join("");

  return `
    <article class="trophy-case">
      <div class="trophy-case-head">
        <div class="trophy-case-photo">${photo}</div>
        <div class="trophy-case-id">
          <h4>${escapeHtml(cabinet.name)}</h4>
          <span class="trophy-case-headline">${headline}</span>
          <span class="trophy-case-count" aria-label="${cabinet.trophies.length} trophies">${cabinet.trophies.map((t) => t.medal).join("")}</span>
        </div>
      </div>
      <div class="trophy-shelf">${shelf}</div>
    </article>`;
}

let tnEditingId = null;
let tnActivePlace = 1;
let tnPlaces = { 1: [], 2: [], 3: [] };
let tnGuestCounter = 0;

function openTournamentModal(tournamentId) {
  tnEditingId = tournamentId || null;
  tnActivePlace = 1;
  tnGuestCounter = 0;
  tnPlaces = { 1: [], 2: [], 3: [] };

  const tournament = tournaments.find((t) => t.id === tournamentId);
  document.getElementById("tn-title").textContent = tournament ? "Edit Tournament" : "Add Tournament Results";
  document.getElementById("tn-save-btn").textContent = tournament ? "Save Changes" : "Save Results";
  document.getElementById("tn-name").value = tournament
    ? tournament.name
    : `BBL Tournament ${tournaments.length + 1}`;
  document.getElementById("tn-guest-name").value = "";
  document.getElementById("tn-status").textContent = "";

  if (tournament) {
    [1, 2, 3].forEach((place) => {
      (tournament.places[String(place)] || []).forEach((person) => {
        tnPlaces[place].push(person.player_id
          ? { key: `p${person.player_id}`, player_id: person.player_id, name: person.name }
          : { key: `g${++tnGuestCounter}`, player_id: null, name: person.name });
      });
    });
  }

  renderTournamentForm();
  document.getElementById("tournament-modal").classList.add("visible");
  document.getElementById("tn-name").focus();
}

function closeTournamentModal() {
  document.getElementById("tournament-modal").classList.remove("visible");
}

function tnSelectPlace(place) {
  tnActivePlace = place;
  renderTournamentForm();
}

function tnAssignedPlace(key) {
  return [1, 2, 3].find((place) => tnPlaces[place].some((person) => person.key === key)) || 0;
}

function tnToggle(key) {
  const assigned = tnAssignedPlace(key);
  if (assigned === tnActivePlace) {
    tnPlaces[assigned] = tnPlaces[assigned].filter((person) => person.key !== key);
  } else if (assigned) {
    tnActivePlace = assigned;
  } else if (tnPlaces[tnActivePlace].length >= TN_MAX_PER_PLACE) {
    tnSetStatus(`${PLACE_META[tnActivePlace].label} already has ${TN_MAX_PER_PLACE} players.`);
    return;
  } else {
    const player = players.find((p) => `p${p.id}` === key);
    if (player) tnPlaces[tnActivePlace].push({ key, player_id: player.id, name: player.name });
  }
  renderTournamentForm();
}

function tnAddGuest() {
  const input = document.getElementById("tn-guest-name");
  const name = input.value.trim();
  if (!name) return;
  const rosterMatch = players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (rosterMatch) {
    const key = `p${rosterMatch.id}`;
    if (tnAssignedPlace(key)) tnActivePlace = tnAssignedPlace(key);
    else tnToggle(key);
    input.value = "";
    renderTournamentForm();
    return;
  }
  if ([1, 2, 3].some((place) => tnPlaces[place].some((person) => person.name.toLowerCase() === name.toLowerCase()))) {
    tnSetStatus(`${name} is already on the podium.`);
    return;
  }
  if (tnPlaces[tnActivePlace].length >= TN_MAX_PER_PLACE) {
    tnSetStatus(`${PLACE_META[tnActivePlace].label} already has ${TN_MAX_PER_PLACE} players.`);
    return;
  }
  tnGuestCounter += 1;
  tnPlaces[tnActivePlace].push({ key: `g${tnGuestCounter}`, player_id: null, name });
  input.value = "";
  renderTournamentForm();
}

function tnRemove(key) {
  [1, 2, 3].forEach((place) => {
    tnPlaces[place] = tnPlaces[place].filter((person) => person.key !== key);
  });
  renderTournamentForm();
}

function tnSetStatus(message, ok) {
  const status = document.getElementById("tn-status");
  status.textContent = message;
  status.classList.toggle("valid", !!ok);
}

function renderTournamentForm() {
  [1, 2, 3].forEach((place) => {
    const card = document.getElementById(`tn-place-${place}`);
    card.classList.toggle("active", place === tnActivePlace);
    document.getElementById(`tn-count-${place}`).textContent =
      `${tnPlaces[place].length} / ${TN_MAX_PER_PLACE}`;
    document.getElementById(`tn-members-${place}`).innerHTML = tnPlaces[place].length
      ? tnPlaces[place].map((person) => `
          <span class="tn-member">${escapeHtml(person.name)}
            <button type="button" onclick="event.stopPropagation(); tnRemove('${person.key}')" aria-label="Remove ${escapeHtml(person.name)}">&times;</button>
          </span>`).join("")
      : `<span class="tn-empty">Tap players below</span>`;
  });

  const assigned = new Set([1, 2, 3].flatMap((place) => tnPlaces[place].map((person) => person.key)));
  document.getElementById("tn-roster").innerHTML = players.map((player) => {
    const key = `p${player.id}`;
    const place = tnAssignedPlace(key);
    return `
      <button type="button" class="tn-chip ${place ? "assigned" : ""}" onclick="tnToggle('${key}')">
        <span>${escapeHtml(player.name)}</span>
        ${place ? `<b>${place}</b>` : ""}
      </button>`;
  }).join("") + [...assigned].filter((key) => key.startsWith("g")).map((key) => {
    const person = [1, 2, 3].flatMap((place) => tnPlaces[place]).find((entry) => entry.key === key);
    const place = tnAssignedPlace(key);
    return `
      <button type="button" class="tn-chip assigned guest" onclick="tnRemove('${key}')">
        <span>${escapeHtml(person.name)}</span>
        <b>${place}</b>
      </button>`;
  }).join("");

  tnSetStatus(tnPlaces[1].length ? "" : "First place needs at least one player.");
}

async function saveTournament() {
  const name = document.getElementById("tn-name").value.trim();
  if (!name) {
    tnSetStatus("Give the tournament a name.");
    return;
  }
  if (!tnPlaces[1].length) {
    tnSetStatus("First place needs at least one player.");
    return;
  }

  const places = {};
  [1, 2, 3].forEach((place) => {
    places[place] = tnPlaces[place].map((person) => (
      person.player_id ? { player_id: person.player_id } : { guest_name: person.name }
    ));
  });

  const btn = document.getElementById("tn-save-btn");
  btn.disabled = true;
  const res = await fetch(tnEditingId ? `/api/tournaments/${tnEditingId}` : "/api/tournaments", {
    method: tnEditingId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey, name, places }),
  });
  const data = await res.json();
  btn.disabled = false;
  if (data.error) {
    tnSetStatus(data.error);
    return;
  }
  closeTournamentModal();
  if (currentTab !== "trophies") switchTab("trophies");
  else loadRequests();
}

async function deleteTournament(tournamentId) {
  const tournament = tournaments.find((t) => t.id === tournamentId);
  if (!tournament) return;
  if (!confirm(`Delete ${tournament.name}? The trophies from it come off every card.`)) return;
  const res = await fetch(`/api/tournaments/${tournamentId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  loadRequests();
}

function renderRequestCard(r) {
  const isNewPlayer = r.request_type === "new_player";
  const player = players.find((p) => p.id === r.player_id);
  let statPills = "";
  let overallInTag = "";

  if (!isNewPlayer && player) {
    overallInTag = renderOverallInTag(r, player);
    statPills = Object.keys(STAT_NAMES)
      .map((key) => {
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        if (isClosedRequest(r) && r[`before_${key}`] == null) {
          return `<span class="stat-change-pill">${STAT_FULL[key]}: ${proposed}</span>`;
        }
        const baseline = getStatBaseline(r, player, key);
        const diff = proposed - baseline;
        if (diff === 0) return "";
        const cls = diff > 0 ? "up" : "down";
        const sign = diff > 0 ? "+" : "";
        return `<span class="stat-change-pill ${cls}">${STAT_FULL[key]} ${sign}${diff}</span>`;
      })
      .join("");
  }

  const tagLabel = isNewPlayer ? "NEW PLAYER" : r.player_name;
  const tagClass = isNewPlayer ? "request-player-tag new-player" : "request-player-tag";

  const cardStatus = r.status === "open" ? "open" : r.status;
  const cardLabel = r.status === "approved" ? "Approved" : r.status === "denied" ? "Denied" : r.status;

  const ups = r.upvote_count || 0;
  const downs = r.downvote_count || 0;
  const net = ups - downs;
  const sv = sessionVotes[r.id] || null;

  const isClosed = r.status !== "open";

  const commentsArr = r.comments || [];
  const commentsHtml = commentsArr
    .map(
      (c) => `
      <div class="rc-comment">
        <span class="rc-comment-author">${escapeHtml(c.author)}</span>
        <span class="rc-comment-body">${escapeHtml(c.body)}</span>
        <span class="rc-comment-time">${timeAgo(c.created_at)}</span>
      </div>`
    )
    .join("");

  const commentFormHtml = isClosed
    ? ""
    : `<div class="rc-comment-form" onclick="event.stopPropagation()">
        <input type="text" id="rc-author-${r.id}" placeholder="Name" value="${escapeHtml(getStoredName())}">
        <input type="text" id="rc-body-${r.id}" placeholder="Add a comment..."
               onkeypress="if(event.key==='Enter')postInlineComment(${r.id})">
        <button onclick="postInlineComment(${r.id})">Reply</button>
      </div>`;

  const adminHtml = (adminMode && r.status === "open")
    ? `<div class="rc-admin-actions" onclick="event.stopPropagation()">
        <input type="text" id="rc-admin-note-${r.id}" class="admin-note-input" placeholder="Admin note (optional)">
        <div style="display:flex;gap:0.5rem;margin-top:0.4rem;">
          <button class="btn btn-green" style="flex:1" onclick="${
            isNewPlayer ? `approveNewPlayer(${r.id})` : `closeRequest(${r.id}, true)`
          }">${isNewPlayer ? "Add Player & Close" : "Apply & Close"}</button>
          <button class="btn btn-red" style="flex:1" onclick="closeRequest(${r.id}, false)">Deny</button>
        </div>
      </div>`
    : "";

  const deniedBanner = r.status === "denied"
    ? `<div class="rc-denied-banner">DENIED</div>`
    : "";

  let adminNoteHtml = "";
  if (r.admin_note) {
    adminNoteHtml = `<div class="admin-note-display" style="margin-top:0.75rem">${escapeHtml(r.admin_note)}</div>`;
  }

  return `
  <div class="rc-post ${cardStatus}" id="rc-post-${r.id}">
    ${deniedBanner}
    <div class="rc-vote-col" onclick="event.stopPropagation()">
      <button class="rc-vote-btn rc-up ${sv === "up" ? "active" : ""} ${isClosed ? "disabled" : ""}"
              onclick="${isClosed ? "" : `inlineVote(${r.id},'up')`}" ${isClosed ? "disabled" : ""}>▲</button>
      <span class="rc-vote-score ${net > 0 ? "positive" : net < 0 ? "negative" : ""}">${net}</span>
      <button class="rc-vote-btn rc-down ${sv === "down" ? "active" : ""} ${isClosed ? "disabled" : ""}"
              onclick="${isClosed ? "" : `inlineVote(${r.id},'down')`}" ${isClosed ? "disabled" : ""}>▼</button>
    </div>
    <div class="rc-body">
      <div class="rc-header">
        <span class="${tagClass}">${tagLabel}${isNewPlayer ? ": " + escapeHtml(r.proposed_name || r.player_name) : ""}${overallInTag}</span>
        <span class="rc-meta">by ${escapeHtml(r.requested_by)} · ${timeAgo(r.created_at)}</span>
        <span class="status-badge ${cardStatus}" style="margin-left:auto">${cardLabel}</span>
      </div>
      <div class="rc-description">${escapeHtml(r.description)}</div>
      ${statPills ? `<div class="request-stats-preview">${statPills}</div>` : ""}
      ${adminNoteHtml}
      ${adminHtml}
      <div class="rc-comments-section">
        ${commentsArr.length > 0 ? `<div class="rc-comments">${commentsHtml}</div>` : ""}
        ${commentFormHtml}
      </div>
    </div>
  </div>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Card Zoom ---

function openCardZoom(playerId) {
  const p = players.find((pl) => pl.id === playerId);
  if (!p) return;

  const tier = cardTier(p.overall);
  const hasPhoto = p.photo_url && p.photo_url.length > 0;
  const photoHtml = hasPhoto
    ? `<img src="${p.photo_url}" alt="${p.name}">`
    : `<span class="fut-photo-initials">${getInitials(p.name)}</span>`;

  const statRows = [
    ["placement", "wall_ball"],
    ["bowling", "substance_use"],
    ["tilt_aversion", "flair"],
  ];

  const statsHtml = statRows
    .map(
      ([left, right]) => `
      <div class="fut-stat-row">
        <div class="fut-stat">
          <span class="fut-stat-val">${p[left]}</span>
          <span class="fut-stat-label">${STAT_NAMES[left]}</span>
        </div>
        <div class="fut-stat">
          <span class="fut-stat-val">${p[right]}</span>
          <span class="fut-stat-label">${STAT_NAMES[right]}</span>
        </div>
      </div>`
    )
    .join("");

  const statDescHtml = Object.keys(STAT_NAMES)
    .map(
      (key) => `
      <div class="zoom-stat-desc-row">
        <span class="zoom-stat-desc-abbr">${STAT_NAMES[key]}</span>
        <span class="zoom-stat-desc-val">${p[key]}</span>
        <span class="zoom-stat-desc-name">${STAT_FULL[key]}</span>
        <span class="zoom-stat-desc-text">${STAT_DESC[key]}</span>
      </div>`
    )
    .join("");

  const overlay = document.getElementById("card-zoom-overlay");
  overlay.innerHTML = `
    <button type="button" class="card-zoom-back" onclick="event.stopPropagation(); closeCardZoom()" aria-label="Back to roster">
      <span class="card-zoom-back-icon" aria-hidden="true">&larr;</span>
      Back to Roster
    </button>
    <div class="card-zoom-content" onclick="event.stopPropagation()">
      <div class="card-zoom-card fut-card tier-${tier}">
        <div class="fut-card-inner">
          <div class="fut-card-face">
            <div class="fut-card-name">${p.name}</div>
            <div class="fut-card-body">
              <div class="fut-card-meta">
                <div class="fut-rating">${p.overall}</div>
                <div class="fut-position">BBL</div>
              </div>
              <div class="fut-photo">
                ${photoHtml}
              </div>
            </div>
            <div class="fut-card-divider"></div>
            <div class="fut-card-stats">
              ${statsHtml}
            </div>
          </div>
        </div>
      </div>
      <div class="card-zoom-details">
        ${renderCapabilityChart(p)}
        ${statDescHtml}
      </div>
    </div>`;

  overlay.classList.add("visible");
}

// Six-axis capability chart. The ring is this player's own average, so a
// round shape is an even game and a spike or dent is a real lean. Absolute
// ratings stay on the labels; the shape is only about balance.
function renderCapabilityChart(p) {
  const keys = STAT_KEYS;
  const n = keys.length;
  const cx = 180;
  const cy = 152;
  const evenR = 72;
  const pxPerPoint = 5.5;
  const spokeR = 112;

  const values = keys.map((key) => p[key]);
  const mean = values.reduce((sum, val) => sum + val, 0) / n;

  const pointAt = (i, radius) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };

  const radiusFor = (val) => {
    const raw = evenR + (val - mean) * pxPerPoint;
    return Math.max(20, Math.min(spokeR, raw));
  };

  const ring = (radius, cls) =>
    `<circle cx="${cx}" cy="${cy}" r="${radius}" class="${cls}" />`;

  const spokes = keys
    .map((_, i) => {
      const [x, y] = pointAt(i, spokeR);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="cap-spoke" />`;
    })
    .join("");

  const poly = keys
    .map((key, i) => pointAt(i, radiusFor(p[key])).map((n) => n.toFixed(1)).join(","))
    .join(" ");

  const peak = Math.max(...values);
  const dots = keys
    .map((key, i) => {
      const [x, y] = pointAt(i, radiusFor(p[key]));
      const hot = p[key] === peak && peak - mean >= 3.5;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${hot ? 5 : 3.5}" class="cap-dot${hot ? " cap-dot-peak" : ""}" />`;
    })
    .join("");

  const labels = keys
    .map((key, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const labelR = spokeR + 16;
      const x = cx + labelR * Math.cos(angle);
      const y = cy + labelR * Math.sin(angle);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const anchor = cos > 0.4 ? "start" : cos < -0.4 ? "end" : "middle";
      const dy = sin > 0.5 ? 12 : sin < -0.5 ? -4 : 4;
      return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" class="cap-label"><tspan class="cap-abbr">${STAT_NAMES[key]}</tspan> <tspan class="cap-num">${p[key]}</tspan></text>`;
    })
    .join("");

  const ranked = keys
    .map((key) => ({ key, delta: p[key] - mean }))
    .sort((a, b) => b.delta - a.delta);
  const high = ranked[0];
  const low = ranked[ranked.length - 1];
  const highLean = high.delta >= 3.5;
  const lowLean = low.delta <= -3.5;
  let lean = "Even across the board";
  if (highLean && lowLean) {
    lean = `Leans ${STAT_FULL[high.key]} · light on ${STAT_FULL[low.key]}`;
  } else if (highLean) {
    lean = `Leans ${STAT_FULL[high.key]}`;
  } else if (lowLean) {
    lean = `Light on ${STAT_FULL[low.key]}`;
  }

  return `
    <div class="cap-chart">
      <div class="cap-chart-title">Capabilities</div>
      <svg viewBox="0 0 360 312" class="cap-svg" role="img" aria-label="Capability chart">
        ${ring(evenR - 5 * pxPerPoint, "cap-guide")}
        ${ring(evenR + 5 * pxPerPoint, "cap-guide")}
        ${ring(evenR, "cap-even")}
        ${spokes}
        <polygon points="${poly}" class="cap-shape" />
        ${dots}
        ${labels}
      </svg>
      <p class="cap-lean">${lean}</p>
      <p class="cap-scale-note">Ring is this player's average. A spike is a strength.</p>
    </div>`;
}

function closeCardZoom() {
  document.getElementById("card-zoom-overlay").classList.remove("visible");
}

// --- Photo Upload ---

function triggerPhotoUpload(playerId) {
  photoUploadPlayerId = playerId;
  document.getElementById("photo-upload-input").click();
}

async function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if (!file || !photoUploadPlayerId) return;

  const formData = new FormData();
  formData.append("photo", file);

  const res = await fetch(`/api/players/${photoUploadPlayerId}/photo`, {
    method: "POST",
    body: formData,
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    await loadPlayers();
  }

  event.target.value = "";
  photoUploadPlayerId = null;
}

// --- Request Detail ---

async function openDetailModal(reqId) {
  currentDetailReqId = reqId;
  const res = await fetch(`/api/requests/${reqId}`);
  const r = await res.json();
  const player = players.find((p) => p.id === r.player_id);

  document.getElementById("detail-title").textContent = `${r.player_name} — Stat Update Request`;

  const storedName = getStoredName();
  const hasVoted = r.upvoters.includes(storedName);
  const hasDownvoted = (r.downvoters || []).includes(storedName);

  let statsHtml = "";
  if (player) {
    statsHtml = renderOverallCompareRow(r, player) + Object.keys(STAT_NAMES)
      .map((key) => {
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        if (isClosedRequest(r) && r[`before_${key}`] == null) {
          return `
            <div class="stat-compare-row">
              <span class="stat-compare-label">${STAT_FULL[key]}</span>
              <span class="stat-compare-current">—</span>
              <span class="stat-compare-arrow">→</span>
              <span class="stat-compare-proposed">${proposed}</span>
            </div>`;
        }
        const baseline = getStatBaseline(r, player, key);
        const diff = proposed - baseline;
        const cls = diff > 0 ? "up" : diff < 0 ? "down" : "same";
        return `
        <div class="stat-compare-row">
          <span class="stat-compare-label">${STAT_FULL[key]}</span>
          <span class="stat-compare-current">${baseline}</span>
          <span class="stat-compare-arrow">→</span>
          <span class="stat-compare-proposed ${cls}">${proposed}</span>
        </div>`;
      })
      .join("");
  }

  const commentsHtml = r.comments
    .map(
      (c) => `
    <div class="comment">
      <div class="comment-header">
        <span class="comment-author">${escapeHtml(c.author)}</span>
        <span class="comment-time">${timeAgo(c.created_at)}</span>
      </div>
      <div class="comment-body">${escapeHtml(c.body)}</div>
    </div>`
    )
    .join("");

  const isNewPlayer = r.request_type === "new_player";
  let adminHtml = "";
  if (adminMode && r.status === "open") {
    const approveLabel = isNewPlayer ? "Add Player & Close" : "Apply & Close";
    const approveAction = isNewPlayer
      ? `approveNewPlayer(${r.id})`
      : `closeRequest(${r.id}, true)`;
    adminHtml = `
      <div class="admin-actions">
        <input type="text" class="admin-note-input" id="admin-note" placeholder="Admin note (optional)">
      </div>
      <div class="admin-actions">
        <button class="btn btn-green" onclick="${approveAction}">${approveLabel}</button>
        <button class="btn btn-red" onclick="closeRequest(${r.id}, false)">Deny & Close</button>
      </div>`;
  }

  let adminNoteHtml = "";
  if (r.admin_note) {
    adminNoteHtml = `
      <div class="admin-note-display">
        <strong>Admin Note:</strong><br>
        ${escapeHtml(r.admin_note)}
      </div>`;
  }

  const isClosed = r.status !== "open";
  const statusLabel = r.status === "approved" ? "Approved" : r.status === "denied" ? "Denied" : r.status;

  const actionsHtml = isClosed
    ? `<div class="detail-actions">
        <span class="upvote-count-static">👍 ${r.upvote_count}</span>
        <span class="upvote-count-static">👎 ${r.downvote_count || 0}</span>
      </div>`
    : `<div class="detail-actions">
        <button class="upvote-btn ${hasVoted ? "voted" : ""}" onclick="toggleUpvote(${r.id})">
          👍 <span>${r.upvote_count}</span>
        </button>
        <button class="downvote-btn ${hasDownvoted ? "voted" : ""}" onclick="toggleDownvote(${r.id})">
          👎 <span>${r.downvote_count || 0}</span>
        </button>
      </div>`;

  const commentFormHtml = isClosed
    ? ""
    : `<div class="comment-form">
        <input type="text" id="comment-author" placeholder="Your name" value="${escapeHtml(storedName)}">
        <input type="text" id="comment-body" placeholder="Add a comment..." style="flex:2"
               onkeypress="if(event.key==='Enter')postComment(${r.id})">
        <button onclick="postComment(${r.id})">Send</button>
      </div>`;

  const deniedBanner = r.status === "denied"
    ? `<div class="denied-banner">DENIED</div>`
    : "";

  document.getElementById("detail-body").innerHTML = `
    ${deniedBanner}
    <div class="request-meta" style="margin-bottom:0.75rem;">
      Requested by <strong>${escapeHtml(r.requested_by)}</strong> · ${timeAgo(r.created_at)}
      · <span class="status-badge ${r.status}">${statusLabel}</span>
    </div>
    <div class="detail-description">${escapeHtml(r.description)}</div>
    ${statsHtml ? `<div class="detail-stats-compare">${statsHtml}</div>` : ""}
    ${actionsHtml}
    ${adminNoteHtml}
    ${adminHtml}
    <div class="comments-section">
      <h4>COMMENTS (${r.comments.length})</h4>
      ${commentsHtml}
      ${commentFormHtml}
    </div>`;

  document.getElementById("request-detail-modal").classList.add("visible");
}

function closeDetailModal() {
  document.getElementById("request-detail-modal").classList.remove("visible");
  currentDetailReqId = null;
}

// --- Actions ---

const sessionVoterName = getCookie('bbl_voter') || ("anon_" + Math.random().toString(36).slice(2, 10));
setCookie('bbl_voter', sessionVoterName);

async function inlineVote(reqId, direction) {
  const current = sessionVotes[reqId];
  if (current === direction) return;

  if (current) {
    const removeEndpoint = current === "up" ? "upvote" : "downvote";
    await fetch(`/api/requests/${reqId}/${removeEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voter: sessionVoterName }),
    });
  }

  const addEndpoint = direction === "up" ? "upvote" : "downvote";
  await fetch(`/api/requests/${reqId}/${addEndpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voter: sessionVoterName }),
  });

  sessionVotes[reqId] = direction;
  saveVotes();
  await refreshSingleRequest(reqId);
}

async function postInlineComment(reqId) {
  const authorEl = document.getElementById(`rc-author-${reqId}`);
  const bodyEl = document.getElementById(`rc-body-${reqId}`);
  const author = authorEl.value.trim();
  const body = bodyEl.value.trim();
  if (!author || !body) return;

  setStoredName(author);

  await fetch(`/api/requests/${reqId}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author, body }),
  });

  await refreshSingleRequest(reqId);
}

async function refreshSingleRequest(reqId) {
  const res = await fetch(`/api/requests/${reqId}`);
  const r = await res.json();
  requestCache[r.id] = r;

  const el = document.getElementById(`rc-post-${reqId}`);
  if (el) {
    el.outerHTML = renderRequestCard(r);
  }

  const [openRes, closedRes] = await Promise.all([
    fetch("/api/requests?status=open"),
    fetch("/api/requests?status=closed"),
  ]);
  document.getElementById("open-count").textContent = (await openRes.json()).length;
  document.getElementById("closed-count").textContent = (await closedRes.json()).length;
}

async function toggleUpvote(reqId) {
  await inlineVote(reqId, "up");
}

async function toggleDownvote(reqId) {
  await inlineVote(reqId, "down");
}

async function postComment(reqId) {
  const authorEl = document.getElementById("comment-author");
  const bodyEl = document.getElementById("comment-body");
  const author = authorEl.value.trim();
  const body = bodyEl.value.trim();
  if (!author || !body) return;

  setStoredName(author);

  await fetch(`/api/requests/${reqId}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author, body }),
  });

  bodyEl.value = "";
  openDetailModal(reqId);
  loadRequests();
}

async function closeRequest(reqId, applyChanges) {
  const adminNote =
    document.getElementById(`rc-admin-note-${reqId}`)?.value ||
    document.getElementById("admin-note")?.value || "";

  const res = await fetch(`/api/requests/${reqId}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      admin_key: adminKey,
      apply_changes: applyChanges,
      admin_note: adminNote || "",
    }),
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  await loadPlayers();
  await loadRequests();
  closeDetailModal();
}

// --- New Request Modal ---

function openNewRequestModal() {
  const nameInput = document.getElementById("req-author");
  nameInput.value = getStoredName();
  document.getElementById("req-player").value = "";
  renderStatInputs(null);
  document.getElementById("new-request-modal").classList.add("visible");
}

function closeNewRequestModal() {
  document.getElementById("new-request-modal").classList.remove("visible");
}

function onPlayerSelectChange() {
  const playerId = parseInt(document.getElementById("req-player").value);
  const player = players.find((p) => p.id === playerId);
  renderStatInputs(player);
}

function renderStatInputs(player) {
  const container = document.getElementById("stat-inputs-container");

  if (!player) {
    container.innerHTML = '<p class="stat-inputs-placeholder">Select a player above to edit stats</p>';
    return;
  }

  const statFields = Object.keys(STAT_NAMES);

  const overallPreview = `
    <div class="overall-preview" id="overall-preview">
      <span class="overall-preview-label">Overall</span>
      <span class="overall-preview-current" id="overall-current">${player.overall}</span>
      <span class="stat-arrow">→</span>
      <span class="overall-preview-proposed" id="overall-proposed">${player.overall}</span>
      <span class="stat-diff" id="overall-diff"></span>
    </div>`;

  container.innerHTML = overallPreview + '<div class="stat-inputs">' + statFields.map((key) => {
    const current = player[key];
    return `
      <div class="stat-input-group">
        <label>${STAT_FULL[key]}</label>
        <div class="stat-input-row">
          <span class="stat-current-val">${current}</span>
          <span class="stat-arrow">→</span>
          <input type="number" id="req-${key}" min="1" max="99" value="${current}"
                 data-original="${current}" oninput="updateStatDiff(this); updateOverallPreview()">
          <span class="stat-diff" id="diff-${key}"></span>
        </div>
      </div>`;
  }).join("") + '</div>';
}

function updateOverallPreview() {
  const statFields = Object.keys(STAT_NAMES);
  let total = 0;
  let count = 0;
  for (const key of statFields) {
    const input = document.getElementById(`req-${key}`);
    if (!input) return;
    const val = parseInt(input.value);
    if (isNaN(val)) return;
    total += val;
    count++;
  }
  const proposed = Math.round(total / count);
  const currentEl = document.getElementById("overall-current");
  const proposedEl = document.getElementById("overall-proposed");
  const diffEl = document.getElementById("overall-diff");
  if (!currentEl || !proposedEl || !diffEl) return;

  const current = parseInt(currentEl.textContent);
  proposedEl.textContent = proposed;

  const diff = proposed - current;
  if (diff === 0) {
    diffEl.textContent = "";
    diffEl.className = "stat-diff";
    proposedEl.className = "overall-preview-proposed";
  } else {
    const sign = diff > 0 ? "+" : "";
    diffEl.textContent = `${sign}${diff}`;
    diffEl.className = `stat-diff ${diff > 0 ? "up" : "down"}`;
    proposedEl.className = `overall-preview-proposed ${diff > 0 ? "up" : "down"}`;
  }
}

function updateStatDiff(input) {
  const original = parseInt(input.dataset.original);
  const current = parseInt(input.value);
  const key = input.id.replace("req-", "");
  const diffEl = document.getElementById(`diff-${key}`);

  if (!diffEl || isNaN(current)) return;

  const diff = current - original;
  if (diff === 0) {
    diffEl.textContent = "";
    diffEl.className = "stat-diff";
  } else {
    const sign = diff > 0 ? "+" : "";
    diffEl.textContent = `${sign}${diff}`;
    diffEl.className = `stat-diff ${diff > 0 ? "up" : "down"}`;
  }
}

async function submitRequest(e) {
  e.preventDefault();

  const name = document.getElementById("req-author").value.trim();
  setStoredName(name);

  const playerId = parseInt(document.getElementById("req-player").value);

  const body = {
    player_id: playerId,
    requested_by: name,
    description: document.getElementById("req-description").value.trim(),
  };

  const statFields = Object.keys(STAT_NAMES);
  for (const f of statFields) {
    const input = document.getElementById(`req-${f}`);
    if (!input) continue;
    const val = parseInt(input.value);
    const orig = parseInt(input.dataset.original);
    if (!isNaN(val) && val !== orig) {
      body[`proposed_${f}`] = val;
    }
  }

  await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  closeNewRequestModal();
  document.getElementById("new-request-form").reset();
  switchTab("open");
  loadRequests();
}

// --- Modal Helpers ---

function closeModal(event) {
  if (event.target === event.currentTarget) {
    event.target.classList.remove("visible");
    currentDetailReqId = null;
  }
}

// --- Tabs ---

function leagueNewPlayer() {
  if (currentTab !== "open") switchTab("open");
  openNewPlayerModal();
}

function leagueStatChange() {
  if (currentTab !== "open") switchTab("open");
  openNewRequestModal();
}

function switchTab(tab) {
  if (tab !== currentTab) requestPage = 1;
  currentTab = tab;
  document.querySelectorAll("#league-section .league-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });

  const isSeason = tab === "season";
  const isTrophies = tab === "trophies";
  const isRequests = tab === "open" || tab === "closed";

  document.getElementById("season-panel").classList.toggle("league-panel-hidden", !isSeason);
  document.getElementById("trophy-room").classList.toggle("league-panel-hidden", !isTrophies);
  document.getElementById("requests-panel").classList.toggle("league-panel-hidden", !isRequests);
  document.getElementById("past-request-tools").classList.toggle("league-panel-hidden", tab !== "closed");

  if (isSeason) loadSeason();
  else if (isTrophies) renderTrophyRoom();
  else loadRequests();
}

// --- Admin ---

let adminKey = "";

function toggleAdminMode() {
  if (adminMode) {
    exitAdminMode();
  } else {
    showAdminLogin();
  }
}

function showAdminLogin() {
  document.getElementById("admin-login").classList.remove("hidden");
  document.getElementById("admin-login-error").classList.add("hidden");
  document.getElementById("admin-key-input").value = "";
  document.getElementById("admin-key-input").focus();
}

function cancelAdminLogin() {
  document.getElementById("admin-login").classList.add("hidden");
}

async function attemptAdminLogin() {
  const input = document.getElementById("admin-key-input");
  const key = input.value.trim();
  if (!key) return;

  const res = await fetch("/api/admin/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: key }),
  });
  const data = await res.json();

  if (data.valid) {
    adminKey = key;
    adminMode = true;
    document.getElementById("admin-login").classList.add("hidden");
    document.getElementById("admin-bar").classList.remove("hidden");
    document.body.classList.add("admin-active");
    const btn = document.getElementById("admin-toggle-btn");
    btn.textContent = "Admin ON";
    btn.classList.add("admin-on");
    renderPlayerCards();
    if (currentTab === "season") loadSeason();
    else loadRequests();
    if (currentDetailReqId) {
      openDetailModal(currentDetailReqId);
    }
  } else {
    const err = document.getElementById("admin-login-error");
    err.classList.remove("hidden");
    input.value = "";
    input.focus();
    input.classList.add("shake");
    setTimeout(() => input.classList.remove("shake"), 500);
  }
}

function exitAdminMode() {
  adminMode = false;
  adminKey = "";
  document.getElementById("admin-bar").classList.add("hidden");
  document.body.classList.remove("admin-active");
  const btn = document.getElementById("admin-toggle-btn");
  btn.textContent = "Admin";
  btn.classList.remove("admin-on");
  renderPlayerCards();
  if (currentTab === "season") loadSeason();
  else loadRequests();
  if (currentDetailReqId) {
    openDetailModal(currentDetailReqId);
  }
}

// --- Admin Edit Player ---

function openAdminEditModal(playerId) {
  const player = players.find((p) => p.id === playerId);
  if (!player) return;

  const statFields = Object.keys(STAT_NAMES);
  const statsHtml = statFields
    .map(
      (key) => `
    <div class="stat-input-group">
      <label>${STAT_FULL[key]}</label>
      <input type="number" id="admin-edit-${key}" min="1" max="99" value="${player[key]}">
    </div>`
    )
    .join("");

  document.getElementById("admin-edit-title").textContent = `Edit: ${player.name}`;
  document.getElementById("admin-edit-body").innerHTML = `
    <div class="form-group">
      <label>Player Name</label>
      <input type="text" id="admin-edit-name" value="${escapeHtml(player.name)}">
    </div>
    <h4 class="proposed-title">Stats</h4>
    <div class="stat-inputs">
      ${statsHtml}
    </div>
    <button class="btn btn-primary btn-full" onclick="saveAdminEdit(${player.id})">Save Changes</button>
    <button class="btn btn-red btn-full" style="margin-top:0.5rem" onclick="deletePlayer(${player.id})">Delete Player</button>
  `;

  document.getElementById("admin-edit-modal").classList.add("visible");
}

function closeAdminEditModal() {
  document.getElementById("admin-edit-modal").classList.remove("visible");
}

async function saveAdminEdit(playerId) {
  const body = { admin_key: adminKey };
  const nameVal = document.getElementById("admin-edit-name").value.trim();
  if (nameVal) body.name = nameVal;

  const statFields = Object.keys(STAT_NAMES);
  for (const f of statFields) {
    const val = parseInt(document.getElementById(`admin-edit-${f}`).value);
    if (!isNaN(val)) body[f] = val;
  }

  const res = await fetch(`/api/players/${playerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  closeAdminEditModal();
  await loadPlayers();
}

async function deletePlayer(playerId) {
  if (!confirm("Are you sure you want to delete this player? This cannot be undone.")) return;

  const res = await fetch(`/api/players/${playerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  closeAdminEditModal();
  await loadPlayers();
}

// --- New Player Modal ---

function openNewPlayerModal() {
  document.getElementById("np-author").value = getStoredName();
  document.getElementById("new-player-modal").classList.add("visible");
}

function closeNewPlayerModal() {
  document.getElementById("new-player-modal").classList.remove("visible");
}

async function submitNewPlayerRequest(e) {
  e.preventDefault();

  const name = document.getElementById("np-author").value.trim();
  setStoredName(name);

  // Stats are intentionally NOT sent — every new player joins at the league
  // baseline (server default). Stats earn their way up via stat-update requests.
  const body = {
    proposed_name: document.getElementById("np-name").value.trim(),
    requested_by: name,
    description: document.getElementById("np-description").value.trim(),
  };

  await fetch("/api/requests/new-player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  closeNewPlayerModal();
  document.getElementById("new-player-form").reset();
  switchTab("open");
  loadRequests();
}

async function approveNewPlayer(reqId) {
  const adminNote = document.getElementById("admin-note")?.value || "";

  const res = await fetch(`/api/requests/${reqId}/approve-player`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey, admin_note: adminNote }),
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  await loadPlayers();
  await loadRequests();
  closeDetailModal();
}

// =====================================================================
// SEASON — standings, game log, log result
// =====================================================================

function formatDiff(diff) {
  if (!diff) return "0";
  return diff > 0 ? `+${diff}` : String(diff);
}

function formatGameDate(playedAt) {
  const [datePart, timePart = "00:00"] = String(playedAt).split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh || 0, mm || 0);
  const dateStr = dt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: dt.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
  if (!hh && !mm) return dateStr;
  return `${dateStr} · ${dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function sgLocalNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function seasonTeamOptionLabel(team) {
  const names = (team.players || []).map((p) => p.name).filter(Boolean);
  if (!names.length) return team.name;
  return `${team.name} — ${names.join(", ")}`;
}

function renderSeasonMiniCard(p) {
  const name = p.name;
  const tier = cardTier(p.overall);
  const overall = p.overall ?? "—";
  const photoUrl = (p.photo_url || "").trim();
  const hasPhoto = photoUrl.length > 0;
  const photoHtml = hasPhoto
    ? `<img src="${photoUrl}" alt="${escapeHtml(name)}">`
    : `<span class="fut-photo-initials">${getInitials(name)}</span>`;

  return `
    <div class="season-mini-card fut-card tier-${tier}" onclick="openCardZoom(${p.id})" title="${escapeHtml(name)}">
      <div class="fut-card-inner">
        <div class="fut-card-face">
          <div class="fut-card-name">${escapeHtml(name)}</div>
          <div class="fut-card-body">
            <div class="fut-card-meta">
              <div class="fut-rating">${overall}</div>
              <div class="fut-position">BBL</div>
            </div>
            <div class="fut-photo">${photoHtml}</div>
          </div>
        </div>
      </div>
    </div>`;
}

async function loadSeason() {
  const body = document.getElementById("season-body");
  if (!body) return;
  body.innerHTML = `<div class="empty-state"><p>Loading season…</p></div>`;

  try {
    const res = await fetch("/api/seasons/active");
    const data = await res.json();
    if (data.error) {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`;
      return;
    }
    activeSeason = data;
    const tab = document.querySelector('#league-section .league-tab[data-tab="season"]');
    if (tab) tab.textContent = data.name || "Season 1";
    renderSeason();
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><p>Could not load season.</p></div>`;
  }
}

function renderSeason() {
  const body = document.getElementById("season-body");
  if (!body || !activeSeason) return;

  const standings = activeSeason.standings || [];
  const games = activeSeason.games || [];

  const rows = standings
    .map((t, i) => {
      const played = t.games_played > 0;
      const diff = formatDiff(t.point_diff);
      const diffCls = t.point_diff > 0 ? "up" : t.point_diff < 0 ? "down" : "";
      const miniCards = (t.players || []).map(renderSeasonMiniCard).join("");
      const rosterEmpty = !miniCards
        ? `<span class="season-team-roster">—</span>`
        : `<div class="season-team-cards">${miniCards}</div>`;
      const isEditing = editingTeamId === t.id;
      const nameBlock = isEditing
        ? `<div class="season-rename-inline">
            <input type="text" id="season-rename-input-${t.id}" class="season-rename-input"
              maxlength="40" autocomplete="off" value="${escapeHtml(t.name)}">
            <div class="season-rename-actions">
              <button type="button" class="btn btn-small btn-primary" data-rename-save="${t.id}">Save</button>
              <button type="button" class="btn btn-small btn-secondary" data-rename-cancel>Cancel</button>
            </div>
            <p id="rename-team-error-${t.id}" class="rename-team-error hidden"></p>
          </div>`
        : `<button type="button" class="season-team-name" data-rename-team="${t.id}" title="Rename team">
            ${escapeHtml(t.name)}
          </button>`;
      return `
      <tr>
        <td class="st-rank">${played ? i + 1 : "—"}</td>
        <td class="st-player season-team-cell">
          ${nameBlock}
          ${rosterEmpty}
        </td>
        <td class="st-w">${t.wins}</td>
        <td class="st-l">${t.losses}</td>
        <td class="st-diff ${diffCls}">${played ? diff : "—"}</td>
      </tr>`;
    })
    .join("");

  const standingsHtml = standings.length
    ? `<table class="standings season-standings">
        <thead>
          <tr>
            <th class="st-rank">#</th>
            <th class="st-player">Team</th>
            <th class="st-w">W</th>
            <th class="st-l">L</th>
            <th class="st-diff">pt diff</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="empty-state"><p>No teams in this season yet.</p></div>`;

  const logHtml = games.length
    ? `<div class="game-log">${games.map(renderSeasonGameCard).join("")}</div>`
    : `<div class="empty-state season-empty-log"><p>No games logged yet. Hit Log Game to start the season.</p></div>`;

  body.innerHTML = `
    <div class="season-toolbar">
      <button type="button" class="btn btn-primary season-log-btn" onclick="openLogGameModal()">
        + Log Game
      </button>
      <p class="season-hint">Ranked by record and point differential. Tap a team name to rename it.</p>
    </div>
    ${standingsHtml}
    <h3 class="season-log-title">Game Log</h3>
    ${logHtml}
  `;

  if (editingTeamId) {
    requestAnimationFrame(() => {
      const input = document.getElementById(`season-rename-input-${editingTeamId}`);
      input?.focus();
      input?.select();
    });
  }
}

function renderSeasonGameCard(g) {
  const sides = (g.sides || [])
    .map((s) => {
      const names = (s.players || []).map((p) => escapeHtml(p.name)).join(", ");
      return `
      <span class="gc-side ${s.won ? "won" : "lost"}">
        <span class="gc-score">${s.score}</span>
        <span class="gc-names"><b>${escapeHtml(s.team_name)}</b>${names ? ` · ${names}` : ""}</span>
      </span>`;
    })
    .join('<span class="gc-vs">vs</span>');

  const adminHtml = adminMode
    ? `<div class="gc-actions">
        <button class="btn btn-small btn-secondary gc-delete" onclick="deleteSeasonGame(${g.id})">Del</button>
      </div>`
    : "";

  return `
  <div class="gc-card">
    <div class="gc-row">
      <span class="gc-date">${formatGameDate(g.played_at)}</span>
      <div class="gc-result">${sides}</div>
      ${adminHtml}
    </div>
    ${g.notes ? `<div class="gc-notes">${escapeHtml(g.notes)}</div>` : ""}
  </div>`;
}

let editingTeamId = null;

function showRenameError(teamId, message) {
  const err = document.getElementById(`rename-team-error-${teamId}`);
  if (!err) return;
  err.textContent = message;
  err.classList.remove("hidden");
}

function startRenameTeam(teamId) {
  const team = (activeSeason?.standings || []).find((t) => t.id === teamId);
  if (!team) return;
  editingTeamId = teamId;
  renderSeason();
}

function cancelRenameTeam() {
  editingTeamId = null;
  renderSeason();
}

async function submitRenameTeamInline(teamId) {
  if (!activeSeason) return;
  const input = document.getElementById(`season-rename-input-${teamId}`);
  if (!input) return;
  const name = input.value.trim();
  const team = (activeSeason.standings || []).find((t) => t.id === teamId);
  if (!team) return;
  if (!name) {
    showRenameError(teamId, "Team name is required.");
    return;
  }
  if (name === team.name) {
    editingTeamId = null;
    renderSeason();
    return;
  }
  const ok = await renameSeasonTeam(teamId, name);
  if (ok) editingTeamId = null;
}

async function renameSeasonTeam(teamId, name) {
  try {
    const res = await fetch(`/api/season-teams/${teamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) {
      showRenameError(teamId, data.error);
      return false;
    }
    activeSeason = data;
    renderSeason();
    return true;
  } catch {
    showRenameError(teamId, "Could not save. Check your connection and try again.");
    return false;
  }
}

function openLogGameModal() {
  if (!activeSeason) return;
  const teams = activeSeason.standings || [];
  [0, 1].forEach((i) => {
    const sel = document.getElementById(`sg-team-${i}`);
    sel.innerHTML = teams
      .map((t) => `<option value="${t.id}">${escapeHtml(seasonTeamOptionLabel(t))}</option>`)
      .join("");
    if (teams[i]) sel.value = String(teams[i].id);
    else if (teams[0]) sel.value = String(teams[0].id);
    document.getElementById(`sg-score-${i}`).value = "";
  });
  // Default B to a different team when possible
  if (teams.length >= 2) {
    document.getElementById("sg-team-1").value = String(teams[1].id);
  }
  document.getElementById("sg-notes").value = "";
  sgValidate();
  document.getElementById("log-game-modal").classList.add("visible");
}

function closeLogGameModal() {
  document.getElementById("log-game-modal").classList.remove("visible");
}

function sgValidate() {
  const t0 = document.getElementById("sg-team-0").value;
  const t1 = document.getElementById("sg-team-1").value;
  const s0 = document.getElementById("sg-score-0").value.trim();
  const s1 = document.getElementById("sg-score-1").value.trim();
  const status = document.getElementById("sg-status");
  const btn = document.getElementById("sg-save-btn");

  let ok = false;
  let message = "";
  if (!t0 || !t1) message = "Pick both teams.";
  else if (t0 === t1) message = "Pick two different teams.";
  else if (s0 === "" || s1 === "") message = "Enter both scores.";
  else if (!Number.isInteger(Number(s0)) || !Number.isInteger(Number(s1)) || Number(s0) < 0 || Number(s1) < 0) {
    message = "Scores have to be whole numbers, zero or higher.";
  } else if (Number(s0) === Number(s1)) message = "No ties — someone has to win.";
  else {
    ok = true;
    const a = activeSeason.standings.find((t) => String(t.id) === t0);
    const b = activeSeason.standings.find((t) => String(t.id) === t1);
    const winner = Number(s0) > Number(s1) ? a : b;
    const hi = Math.max(Number(s0), Number(s1));
    const lo = Math.min(Number(s0), Number(s1));
    message = `${winner?.name || "Winner"} wins ${hi}–${lo}`;
  }

  status.textContent = message;
  status.classList.toggle("valid", ok);
  btn.disabled = !ok;
}

async function submitSeasonGame() {
  sgValidate();
  if (document.getElementById("sg-save-btn").disabled || !activeSeason) return;

  const body = {
    season_id: activeSeason.id,
    played_at: sgLocalNow(),
    notes: document.getElementById("sg-notes").value.trim(),
    sides: [
      {
        season_team_id: Number(document.getElementById("sg-team-0").value),
        score: Number(document.getElementById("sg-score-0").value),
      },
      {
        season_team_id: Number(document.getElementById("sg-team-1").value),
        score: Number(document.getElementById("sg-score-1").value),
      },
    ],
  };

  const btn = document.getElementById("sg-save-btn");
  btn.disabled = true;
  const res = await fetch("/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    const status = document.getElementById("sg-status");
    status.textContent = data.error;
    status.classList.remove("valid");
    btn.disabled = false;
    return;
  }

  closeLogGameModal();
  await loadSeason();
}

async function deleteSeasonGame(gameId) {
  if (!confirm("Delete this game? Standings will recalculate.")) return;
  const res = await fetch(`/api/games/${gameId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  await loadSeason();
}

// --- Init ---

document.addEventListener("DOMContentLoaded", () => {
  loadPlayers();
  switchTab("season");

  const seasonPanel = document.getElementById("season-panel");
  seasonPanel?.addEventListener("click", (e) => {
    const renameBtn = e.target.closest("[data-rename-team]");
    if (renameBtn) {
      startRenameTeam(Number(renameBtn.dataset.renameTeam));
      return;
    }
    const saveBtn = e.target.closest("[data-rename-save]");
    if (saveBtn) {
      submitRenameTeamInline(Number(saveBtn.dataset.renameSave));
      return;
    }
    if (e.target.closest("[data-rename-cancel]")) {
      cancelRenameTeam();
    }
  });

  seasonPanel?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !editingTeamId) return;
    const input = document.getElementById(`season-rename-input-${editingTeamId}`);
    if (e.target !== input) return;
    e.preventDefault();
    submitRenameTeamInline(editingTeamId);
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const zoom = document.getElementById("card-zoom-overlay");
    if (zoom && zoom.classList.contains("visible")) {
      closeCardZoom();
      return;
    }
    const gd = document.getElementById("game-day-overlay");
    if (gd && gd.classList.contains("visible")) {
      closeGameDayPicker();
      return;
    }
    if (editingTeamId) cancelRenameTeam();
  }
});

// =====================================================================
// GAME DAY — Team Picker
// =====================================================================

const GD_TEAMS = [
  { tag: "TEAM", name: "ROSSO",   color: "#d44a4a" },
  { tag: "TEAM", name: "AZZURRI", color: "#3b7dd8" },
  { tag: "TEAM", name: "VERDE",   color: "#2a9d6e" },
  { tag: "TEAM", name: "VIOLA",   color: "#7c5cbf" },
  { tag: "TEAM", name: "GIALLO",  color: "#d4a017" },
  { tag: "TEAM", name: "ARANCIO", color: "#e07a2f" },
  { tag: "TEAM", name: "CELESTE", color: "#2aa8c4" },
  { tag: "TEAM", name: "ROSA",    color: "#d45a8c" },
];

const gdSelected = new Set();
let gdGuests = [];
let gdGuestCounter = 0;
let gdSeparationGroups = [];
let gdSepDraft = new Set();
let gdSepMode = false;
let gdRevealRunning = false;

const GD_SEP_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function gdPlayerKey(p) {
  return p.isGuest ? p.id : String(p.id);
}

function gdPlayerName(id) {
  if (id.startsWith("g_")) {
    const guest = gdGuests.find((g) => g.id === id);
    return guest ? guest.name : "Guest";
  }
  const p = players.find((pl) => String(pl.id) === id);
  return p ? p.name : "Player";
}

function gdSepGroupLabel(index) {
  return GD_SEP_LABELS[index] || String(index + 1);
}

function gdPlayerSepClasses(id) {
  const classes = [];
  if (gdSepMode && gdSepDraft.has(id)) classes.push("sep-draft");
  if (gdSeparationGroups.some((g) => g.includes(id))) classes.push("sep-grouped");
  return classes.join(" ");
}

function gdGetTeamSplit(n) {
  // Prefer teams of 2. Use a single team of 3 only when the count is odd.
  // Never put more than 3 on a team. Need at least two teams to pick.
  if (n < 2) return null;
  if (n === 2) return [1, 1];
  if (n === 3) return [1, 2];

  const teams = [];
  let remaining = n;
  if (remaining % 2 === 1) {
    teams.push(3);
    remaining -= 3;
  }
  while (remaining > 0) {
    teams.push(2);
    remaining -= 2;
  }
  return teams;
}

function gdFormatString(split) {
  return split.join(" vs ").toUpperCase();
}

function openGameDayPicker() {
  gdSelected.clear();
  gdGuests = [];
  gdGuestCounter = 0;
  gdSeparationGroups = [];
  gdSepDraft = new Set();
  gdSepMode = false;
  document.getElementById("gd-stage-pick").classList.add("active");
  document.getElementById("gd-stage-reveal").classList.remove("active");
  document.getElementById("gd-stage-reveal").innerHTML = `
    <div class="gd-reveal-bg"></div>
    <div class="gd-reveal-spotlights"></div>
    <div id="gd-reveal-content" class="gd-reveal-content"></div>
    <div id="gd-reveal-actions" class="gd-reveal-actions"></div>`;
  gdRenderPickStage();
  gdRenderSepSection();
  document.getElementById("game-day-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
}

function closeGameDayPicker() {
  document.getElementById("game-day-overlay").classList.remove("visible");
  document.body.style.overflow = "";
}

function gdRenderPickStage() {
  const grid = document.getElementById("gd-player-grid");
  const cards = [
    ...players.map((p) => gdRenderPickCard(p, false)),
    ...gdGuests.map((g) => gdRenderPickCard(g, true)),
  ];
  grid.innerHTML = cards.join("");
  gdUpdateSummary();
  gdRenderSepSection();
}

function gdRenderSepSection() {
  const draftEl = document.getElementById("gd-sep-draft");
  const groupsEl = document.getElementById("gd-sep-groups");
  const newBtn = document.getElementById("gd-sep-new-btn");
  const saveBtn = document.getElementById("gd-sep-save-btn");
  const cancelBtn = document.getElementById("gd-sep-cancel-btn");
  const subtitle = document.getElementById("gd-subtitle");

  if (!draftEl || !groupsEl) return;

  newBtn.classList.toggle("hidden", gdSepMode);
  saveBtn.classList.toggle("hidden", !gdSepMode);
  cancelBtn.classList.toggle("hidden", !gdSepMode);
  saveBtn.disabled = gdSepDraft.size < 2;

  subtitle.textContent = gdSepMode
    ? "Tap players who shouldn't share a team, then save the group."
    : "Tap to pick. Add guests if needed. Let fate sort the rest.";

  if (gdSepMode) {
    draftEl.classList.remove("hidden");
    if (gdSepDraft.size === 0) {
      draftEl.innerHTML = `<span class="gd-sep-draft-empty">Select 2 or more players for this group</span>`;
    } else {
      draftEl.innerHTML = [...gdSepDraft]
        .map(
          (id) =>
            `<span class="gd-sep-chip draft">${escapeHtml(gdPlayerName(id))}</span>`
        )
        .join("");
    }
  } else {
    draftEl.classList.add("hidden");
    draftEl.innerHTML = "";
  }

  if (gdSeparationGroups.length === 0) {
    groupsEl.innerHTML = "";
    return;
  }

  groupsEl.innerHTML = gdSeparationGroups
    .map(
      (group, i) => `
      <div class="gd-sep-group-row">
        <span class="gd-sep-group-tag">Set ${gdSepGroupLabel(i)}</span>
        <span class="gd-sep-group-names">${group.map((id) => escapeHtml(gdPlayerName(id))).join(" · ")}</span>
        <button type="button" class="gd-sep-remove" onclick="gdRemoveSepGroup(${i})" title="Remove group">&times;</button>
      </div>`
    )
    .join("");
}

function gdToggleSepMode() {
  gdSepMode = true;
  gdSepDraft = new Set();
  gdRenderPickStage();
}

function gdCancelSepMode() {
  gdSepMode = false;
  gdSepDraft = new Set();
  gdRenderPickStage();
}

function gdSaveSepGroup() {
  if (gdSepDraft.size < 2) return;
  gdSeparationGroups.push([...gdSepDraft]);
  gdSepMode = false;
  gdSepDraft = new Set();
  gdRenderPickStage();
}

function gdRemoveSepGroup(index) {
  gdSeparationGroups.splice(index, 1);
  gdRenderPickStage();
}

function gdToggleSepDraft(id) {
  if (gdSepDraft.has(id)) {
    gdSepDraft.delete(id);
  } else {
    gdSepDraft.add(id);
  }
  const el = document.querySelector(`.gd-pick-card[data-gd-id="${id}"]`);
  if (el) {
    el.classList.toggle("sep-draft", gdSepDraft.has(id));
  }
  gdRenderSepSection();
}

function gdRenderPickCard(p, isGuest) {
  const id = isGuest ? p.id : String(p.id);
  const selected = gdSelected.has(id);
  const tier = isGuest ? "temp" : cardTier(p.overall);

  let body;
  if (isGuest) {
    body = `
      <div class="fut-card-body">
        <div class="fut-card-meta">
          <div class="fut-rating">GUEST</div>
          <div class="fut-position">BBL</div>
        </div>
        <div class="fut-photo">
          <span class="fut-photo-initials">${getInitials(p.name)}</span>
        </div>
      </div>
      <div class="fut-card-divider"></div>
      <div class="fut-card-stats">
        <div class="fut-stat-row">
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">PLC</span></div>
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">WBL</span></div>
        </div>
        <div class="fut-stat-row">
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">BWL</span></div>
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">SUB</span></div>
        </div>
        <div class="fut-stat-row">
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">TLT</span></div>
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">CLH</span></div>
        </div>
      </div>`;
  } else {
    const hasPhoto = p.photo_url && p.photo_url.length > 0;
    const photoHtml = hasPhoto
      ? `<img src="${p.photo_url}" alt="${p.name}">`
      : `<span class="fut-photo-initials">${getInitials(p.name)}</span>`;
    const statRows = [
      ["placement", "wall_ball"],
      ["bowling", "substance_use"],
      ["tilt_aversion", "flair"],
    ];
    const statsHtml = statRows
      .map(
        ([l, r]) => `
        <div class="fut-stat-row">
          <div class="fut-stat"><span class="fut-stat-val">${p[l]}</span><span class="fut-stat-label">${STAT_NAMES[l]}</span></div>
          <div class="fut-stat"><span class="fut-stat-val">${p[r]}</span><span class="fut-stat-label">${STAT_NAMES[r]}</span></div>
        </div>`
      )
      .join("");
    body = `
      <div class="fut-card-body">
        <div class="fut-card-meta">
          <div class="fut-rating">${p.overall}</div>
          <div class="fut-position">BBL</div>
        </div>
        <div class="fut-photo">${photoHtml}</div>
      </div>
      <div class="fut-card-divider"></div>
      <div class="fut-card-stats">${statsHtml}</div>`;
  }

  const removeBtn = isGuest
    ? `<div class="gd-guest-remove" onclick="event.stopPropagation(); gdRemoveGuest('${id}')" title="Remove guest">&times;</div>`
    : "";

  const sepClasses = gdPlayerSepClasses(id);

  return `
    <div class="gd-pick-card fut-card tier-${tier} ${selected ? "selected" : ""} ${sepClasses}"
         onclick="gdToggleSelect('${id}')" data-gd-id="${id}">
      <div class="gd-pick-check">&#10003;</div>
      ${removeBtn}
      <div class="fut-card-inner">
        <div class="fut-card-face">
          <div class="fut-card-name">${escapeHtml(p.name)}</div>
          ${body}
        </div>
      </div>
    </div>`;
}

function gdToggleSelect(id) {
  if (gdSepMode) {
    gdToggleSepDraft(id);
    return;
  }
  if (gdSelected.has(id)) {
    gdSelected.delete(id);
  } else {
    gdSelected.add(id);
  }
  const el = document.querySelector(`.gd-pick-card[data-gd-id="${id}"]`);
  if (el) el.classList.toggle("selected", gdSelected.has(id));
  gdUpdateSummary(true);
}

function gdSelectAll() {
  players.forEach((p) => gdSelected.add(String(p.id)));
  gdGuests.forEach((g) => gdSelected.add(g.id));
  document.querySelectorAll(".gd-pick-card").forEach((el) => el.classList.add("selected"));
  gdUpdateSummary(true);
}

function gdClearAll() {
  gdSelected.clear();
  document.querySelectorAll(".gd-pick-card").forEach((el) => el.classList.remove("selected"));
  gdUpdateSummary(true);
}

function gdAddGuest() {
  const input = document.getElementById("gd-guest-name");
  const name = input.value.trim();
  if (!name) return;

  gdGuestCounter += 1;
  const id = `g_${gdGuestCounter}_${Date.now()}`;
  gdGuests.push({ id, name });
  gdSelected.add(id);
  input.value = "";
  gdRenderPickStage();
  input.focus();
}

function gdRemoveGuest(id) {
  gdGuests = gdGuests.filter((g) => g.id !== id);
  gdSelected.delete(id);
  gdRenderPickStage();
}

function gdUpdateSummary(bump) {
  const n = gdSelected.size;
  const countEl = document.getElementById("gd-selected-count");
  countEl.textContent = n;
  if (bump) {
    countEl.classList.add("bump");
    setTimeout(() => countEl.classList.remove("bump"), 220);
  }

  const formatEl = document.getElementById("gd-format");
  const btn = document.getElementById("gd-pick-btn");
  const split = gdGetTeamSplit(n);
  const sepCheck = gdValidateSeparationForPick(split);

  if (n < 2) {
    formatEl.textContent = "Pick at least 2 players";
    formatEl.classList.remove("invalid");
    btn.disabled = true;
  } else if (n === 7) {
    formatEl.textContent = "7 PLAYERS — DOESN'T SPLIT WELL. ADD OR DROP ONE.";
    formatEl.classList.add("invalid");
    btn.disabled = true;
  } else if (!split) {
    formatEl.textContent = "Invalid count";
    formatEl.classList.add("invalid");
    btn.disabled = true;
  } else if (!sepCheck.ok) {
    formatEl.textContent = sepCheck.message;
    formatEl.classList.add("invalid");
    btn.disabled = true;
  } else {
    const sepNote =
      gdSeparationGroups.length > 0 ? " · keep-apart rules on" : "";
    formatEl.textContent = `${n} PLAYERS  →  ${gdFormatString(split)}${sepNote}`;
    formatEl.classList.remove("invalid");
    btn.disabled = false;
  }
}

function gdValidateSeparationForPick(split) {
  if (!split || gdSeparationGroups.length === 0) return { ok: true };
  const numTeams = split.length;
  for (let i = 0; i < gdSeparationGroups.length; i++) {
    const active = gdSeparationGroups[i].filter((id) => gdSelected.has(id));
    if (active.length > numTeams) {
      return {
        ok: false,
        message: `SET ${gdSepGroupLabel(i)} HAS ${active.length} PLAYERS — NEED MORE TEAMS`,
      };
    }
  }
  return { ok: true };
}

// --- Team generation ---

function gdBuildSelectedPool() {
  const pool = [];
  gdSelected.forEach((id) => {
    if (id.startsWith("g_")) {
      const guest = gdGuests.find((g) => g.id === id);
      if (guest) pool.push({ ...guest, isGuest: true });
    } else {
      const p = players.find((pl) => String(pl.id) === id);
      if (p) pool.push({ ...p, isGuest: false });
    }
  });
  return pool;
}

function gdTeamsFromPool(pool, split) {
  const teams = [];
  let cursor = 0;
  for (let i = 0; i < split.length; i++) {
    const size = split[i];
    teams.push({
      ...GD_TEAMS[i % GD_TEAMS.length],
      index: i,
      players: pool.slice(cursor, cursor + size),
    });
    cursor += size;
  }
  return teams;
}

function gdTeamsSatisfySeparation(teams, groups) {
  if (!groups.length) return true;
  for (const team of teams) {
    const ids = team.players.map(gdPlayerKey);
    for (const group of groups) {
      let count = 0;
      for (const id of group) {
        if (ids.includes(id)) count++;
      }
      if (count > 1) return false;
    }
  }
  return true;
}

function gdGenerateTeamsConstrained(pool, split) {
  const numTeams = split.length;
  const teams = split.map((size, i) => ({
    ...GD_TEAMS[i % GD_TEAMS.length],
    index: i,
    players: [],
    maxSize: size,
  }));

  const order = shuffle([...pool]);
  for (const player of order) {
    const pid = gdPlayerKey(player);
    const valid = teams.filter((t) => {
      if (t.players.length >= t.maxSize) return false;
      const teamIds = t.players.map(gdPlayerKey);
      for (const group of gdSeparationGroups) {
        if (!group.includes(pid)) continue;
        if (teamIds.some((id) => group.includes(id))) return false;
      }
      return true;
    });
    if (!valid.length) return null;
    valid.sort((a, b) => a.players.length - b.players.length);
    valid[0].players.push(player);
  }

  return teams.map(({ maxSize, ...team }) => team);
}

function gdGenerateTeams() {
  const pool = gdBuildSelectedPool();
  const split = gdGetTeamSplit(pool.length);
  if (!split) return null;

  if (gdSeparationGroups.length === 0) {
    return gdTeamsFromPool(shuffle([...pool]), split);
  }

  for (let attempt = 0; attempt < 500; attempt++) {
    const teams = gdTeamsFromPool(shuffle([...pool]), split);
    if (gdTeamsSatisfySeparation(teams, gdSeparationGroups)) return teams;
  }

  return gdGenerateTeamsConstrained(pool, split);
}

// --- Reveal sequence ---

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function gdStartReveal() {
  if (gdRevealRunning) return;

  const teams = gdGenerateTeams();
  if (!teams) {
    alert(
      "Couldn't build fair teams with the current keep-apart groups. Try removing a group or changing who's playing."
    );
    return;
  }

  gdRevealRunning = true;

  try {
    document.getElementById("gd-stage-pick").classList.remove("active");
    document.getElementById("gd-stage-reveal").classList.add("active");

    const overlay = document.getElementById("game-day-overlay");
    if (overlay) overlay.scrollTo({ top: 0, behavior: "smooth" });

    const content = document.getElementById("gd-reveal-content");
    content.innerHTML = `<div class="gd-picking-text">PICKING TEAMS...</div>`;
    document.getElementById("gd-reveal-actions").classList.remove("visible");
    document.getElementById("gd-reveal-actions").innerHTML = "";

    await wait(1400);

    content.innerHTML = "";

    for (let i = 0; i < teams.length; i++) {
      await gdRevealTeam(teams[i], content);
    }

    await wait(450);
    gdShowFinalActions();
  } finally {
    gdRevealRunning = false;
  }
}

async function gdRevealTeam(team, container) {
  const teamEl = document.createElement("div");
  teamEl.className = `gd-team gd-team-${team.index}`;
  teamEl.innerHTML = `
    <div class="gd-team-banner">
      <span class="gd-team-tag">${team.tag}</span>
      <span class="gd-team-name">${team.name}</span>
    </div>
    <div class="gd-team-cards" id="gd-team-cards-${team.index}"></div>`;
  container.appendChild(teamEl);

  // Pull the new team into view BEFORE the banner slams in, so the user's
  // eye follows the action instead of being yanked around after the cards
  // have already landed. Single scroll per team — no per-card adjustments.
  gdScrollToTeam(teamEl);

  gdFireFlash(team.index);
  await wait(20);
  teamEl.classList.add("entering");
  gdShakeStage();

  await wait(700);

  const cardsEl = document.getElementById(`gd-team-cards-${team.index}`);
  const directions = ["from-left", "from-right", "from-top"];
  for (let i = 0; i < team.players.length; i++) {
    const dir = directions[i % directions.length];
    const cardHtml = gdRenderRevealCard(team.players[i], dir);
    cardsEl.insertAdjacentHTML("beforeend", cardHtml);
    await wait(550);
  }

  await wait(550);
}

function gdScrollToTeam(teamEl) {
  const overlay = document.getElementById("game-day-overlay");
  if (!overlay) return;
  // Only scroll if the banner would land below ~30% from the top of the
  // viewport — otherwise the team is already comfortably visible and any
  // scroll would just be noise.
  const targetTop = teamEl.offsetTop - Math.round(window.innerHeight * 0.12);
  if (targetTop > overlay.scrollTop + 4) {
    overlay.scrollTo({ top: targetTop, behavior: "smooth" });
  }
}

function gdRenderRevealCard(p, dir) {
  if (p.isGuest) {
    return `
      <div class="gd-card-slot ${dir} fut-card tier-temp">
        <div class="fut-card-inner">
          <div class="fut-card-face">
            <div class="fut-card-name">${escapeHtml(p.name)}</div>
            <div class="fut-card-body">
              <div class="fut-card-meta">
                <div class="fut-rating">GUEST</div>
                <div class="fut-position">BBL</div>
              </div>
              <div class="fut-photo">
                <span class="fut-photo-initials">${getInitials(p.name)}</span>
              </div>
            </div>
            <div class="fut-card-divider"></div>
            <div class="fut-card-stats">
              <div class="fut-stat-row">
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">PLC</span></div>
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">WBL</span></div>
              </div>
              <div class="fut-stat-row">
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">BWL</span></div>
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">SUB</span></div>
              </div>
              <div class="fut-stat-row">
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">TLT</span></div>
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">CLH</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  const tier = cardTier(p.overall);
  const hasPhoto = p.photo_url && p.photo_url.length > 0;
  const photoHtml = hasPhoto
    ? `<img src="${p.photo_url}" alt="${p.name}">`
    : `<span class="fut-photo-initials">${getInitials(p.name)}</span>`;

  const statRows = [
    ["placement", "wall_ball"],
    ["bowling", "substance_use"],
    ["tilt_aversion", "flair"],
  ];
  const statsHtml = statRows
    .map(
      ([l, r]) => `
      <div class="fut-stat-row">
        <div class="fut-stat"><span class="fut-stat-val">${p[l]}</span><span class="fut-stat-label">${STAT_NAMES[l]}</span></div>
        <div class="fut-stat"><span class="fut-stat-val">${p[r]}</span><span class="fut-stat-label">${STAT_NAMES[r]}</span></div>
      </div>`
    )
    .join("");

  return `
    <div class="gd-card-slot ${dir} fut-card tier-${tier}">
      <div class="fut-card-inner">
        <div class="fut-card-face">
          <div class="fut-card-name">${escapeHtml(p.name)}</div>
          <div class="fut-card-body">
            <div class="fut-card-meta">
              <div class="fut-rating">${p.overall}</div>
              <div class="fut-position">BBL</div>
            </div>
            <div class="fut-photo">${photoHtml}</div>
          </div>
          <div class="fut-card-divider"></div>
          <div class="fut-card-stats">${statsHtml}</div>
        </div>
      </div>
    </div>`;
}

function gdFireFlash(teamIndex) {
  const flash = document.createElement("div");
  flash.className = `gd-flash team-${teamIndex} fire`;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 600);
}

function gdShakeStage() {
  const stage = document.getElementById("gd-stage-reveal");
  stage.classList.remove("gd-shake");
  void stage.offsetWidth;
  stage.classList.add("gd-shake");
  setTimeout(() => stage.classList.remove("gd-shake"), 450);
}

function gdShowFinalActions() {
  const actions = document.getElementById("gd-reveal-actions");
  actions.innerHTML = `
    <button class="gd-lets-go" onclick="closeGameDayPicker()">LET'S GO!</button>
    <button class="gd-pick-again" onclick="gdPickAgain()">Pick Again</button>`;
  actions.classList.add("visible");
}

function gdPickAgain() {
  gdStartReveal();
}
