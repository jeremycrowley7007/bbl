let players = [];
let playerOrder = [];
let currentTab = "standings";
let adminMode = false;
let currentDetailReqId = null;
let photoUploadPlayerId = null;

let requestCache = {};

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
  flair: "FLR",
};

const STAT_FULL = {
  placement: "Placement",
  bowling: "Bowling",
  tilt_aversion: "Tilt Aversion",
  wall_ball: "Wall Ball",
  substance_use: "Substance Use",
  flair: "Flair",
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

function computeOverallFromRequest(r, prefix) {
  const values = STAT_KEYS.map((key) => r[`${prefix}_${key}`]);
  if (values.some((v) => v == null)) return null;
  return computeOverallFromValues(values);
}

function getRequestOverallChange(r, player) {
  if (!player || r.request_type === "new_player") return null;

  const proposedOverall = computeOverallFromRequest(r, "proposed");
  if (proposedOverall == null) return null;

  const isApproved = r.status === "approved";
  if (isApproved) {
    const beforeOverall = computeOverallFromRequest(r, "before");
    if (beforeOverall == null) {
      return { baseline: null, proposed: proposedOverall, diff: null, legacy: true };
    }
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

function renderOverallChangePill(r, player) {
  const change = getRequestOverallChange(r, player);
  if (!change) return "";

  if (change.legacy) {
    return `<span class="stat-change-pill overall-pill">Overall: ${change.proposed}</span>`;
  }
  if (change.diff === 0) return "";

  const cls = change.diff > 0 ? "up" : "down";
  const sign = change.diff > 0 ? "+" : "";
  return `<span class="stat-change-pill overall-pill ${cls}">Overall ${sign}${change.diff}</span>`;
}

function renderOverallCompareRow(r, player) {
  const change = getRequestOverallChange(r, player);
  if (!change) return "";

  if (change.legacy) {
    return `
    <div class="stat-compare-row overall-compare-row">
      <span class="stat-compare-label">Overall</span>
      <span class="stat-compare-current">—</span>
      <span class="stat-compare-arrow">→</span>
      <span class="stat-compare-proposed">${change.proposed}</span>
    </div>`;
  }

  const cls = change.diff > 0 ? "up" : change.diff < 0 ? "down" : "same";
  return `
    <div class="stat-compare-row overall-compare-row">
      <span class="stat-compare-label">Overall</span>
      <span class="stat-compare-current">${change.baseline}</span>
      <span class="stat-compare-arrow">→</span>
      <span class="stat-compare-proposed ${cls}">${change.proposed}</span>
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

async function loadRequests() {
  const [openRes, closedRes] = await Promise.all([
    fetch("/api/requests?status=open"),
    fetch("/api/requests?status=closed"),
  ]);
  const openReqs = await openRes.json();
  const closedReqs = await closedRes.json();

  document.getElementById("open-count").textContent = openReqs.length;
  document.getElementById("closed-count").textContent = closedReqs.length;

  if (currentTab !== "open" && currentTab !== "closed") return;

  const reqs = currentTab === "open" ? openReqs : closedReqs;

  const details = await Promise.all(
    reqs.map((r) => fetch(`/api/requests/${r.id}`).then((res) => res.json()))
  );
  details.forEach((d) => { requestCache[d.id] = d; });

  renderRequests(details);
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

function renderRequestCard(r) {
  const isNewPlayer = r.request_type === "new_player";
  const player = players.find((p) => p.id === r.player_id);
  let statPills = "";

  if (!isNewPlayer && player) {
    const isApproved = r.status === "approved";
    const overallPill = renderOverallChangePill(r, player);
    statPills = Object.keys(STAT_NAMES)
      .map((key) => {
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        // For approved requests, the player row was already updated, so
        // current === proposed and a normal diff would always be zero.
        // Use the snapshot captured at approval time as the baseline instead.
        let baseline;
        if (isApproved) {
          if (r[`before_${key}`] == null) {
            // Legacy approved request with no snapshot — show the value
            // that was applied without a diff, so it's still visible.
            return `<span class="stat-change-pill">${STAT_FULL[key]}: ${proposed}</span>`;
          }
          baseline = r[`before_${key}`];
        } else {
          baseline = player[key];
        }
        const diff = proposed - baseline;
        if (diff === 0) return "";
        const cls = diff > 0 ? "up" : "down";
        const sign = diff > 0 ? "+" : "";
        return `<span class="stat-change-pill ${cls}">${STAT_FULL[key]} ${sign}${diff}</span>`;
      })
      .join("");
    statPills = overallPill + statPills;
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
        <span class="${tagClass}">${tagLabel}${isNewPlayer ? ": " + escapeHtml(r.proposed_name || r.player_name) : ""}</span>
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
        ${renderRecordStrip(p)}
        ${statDescHtml}
      </div>
    </div>`;

  overlay.classList.add("visible");
}

function renderRecordStrip(p) {
  const rec = p.record || { wins: 0, losses: 0, games_played: 0, point_diff: 0 };
  if (!rec.games_played) {
    return `
      <div class="zoom-record empty">
        <span class="zoom-record-label">LIFETIME</span>
        <span class="zoom-record-none">No games logged yet</span>
      </div>`;
  }
  const pct = formatPct(rec.wins / rec.games_played);
  const diff = formatDiff(rec.point_diff);
  return `
    <div class="zoom-record">
      <span class="zoom-record-label">LIFETIME</span>
      <span class="zoom-record-wl">${rec.wins}<span class="zoom-record-sep">–</span>${rec.losses}</span>
      <span class="zoom-record-meta">${pct} win rate · ${diff} pt diff · ${rec.games_played} game${
        rec.games_played === 1 ? "" : "s"
      }</span>
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
    const isApproved = r.status === "approved";
    statsHtml = renderOverallCompareRow(r, player) + Object.keys(STAT_NAMES)
      .map((key) => {
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        // For approved requests, use the snapshot captured at approval time
        // so we can still show the original "before" value.
        let baseline;
        let baselineLabel;
        if (isApproved) {
          if (r[`before_${key}`] == null) {
            return `
            <div class="stat-compare-row">
              <span class="stat-compare-label">${STAT_FULL[key]}</span>
              <span class="stat-compare-current">—</span>
              <span class="stat-compare-arrow">→</span>
              <span class="stat-compare-proposed">${proposed}</span>
            </div>`;
          }
          baseline = r[`before_${key}`];
          baselineLabel = baseline;
        } else {
          baseline = player[key];
          baselineLabel = baseline;
        }
        const diff = proposed - baseline;
        const cls = diff > 0 ? "up" : diff < 0 ? "down" : "same";
        return `
        <div class="stat-compare-row">
          <span class="stat-compare-label">${STAT_FULL[key]}</span>
          <span class="stat-compare-current">${baselineLabel}</span>
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

function leagueLogResult() {
  if (currentTab !== "standings" && currentTab !== "log") switchTab("log");
  openLogGameModal();
}

function leagueNewPlayer() {
  if (currentTab !== "open") switchTab("open");
  openNewPlayerModal();
}

function leagueStatChange() {
  if (currentTab !== "open") switchTab("open");
  openNewRequestModal();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll("#league-section .league-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });

  const isGames = tab === "standings" || tab === "log";
  document.getElementById("games-body").classList.toggle("league-panel-hidden", !isGames);
  document.getElementById("requests-list").classList.toggle("league-panel-hidden", isGames);

  if (isGames) {
    renderGamesBody();
  } else {
    loadRequests();
  }
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
    renderGamesBody();
    loadRequests();
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
  renderGamesBody();
  loadRequests();
  if (currentDetailReqId) {
    openDetailModal(currentDetailReqId);
  }
}

// --- Admin Reset All Stats ---

async function resetAllStats() {
  const input = prompt("Reset ALL players to what baseline? (1–99)", "70");
  if (input === null) return;
  const baseline = parseInt(input);
  if (isNaN(baseline) || baseline < 1 || baseline > 99) {
    alert("Enter a number between 1 and 99.");
    return;
  }
  if (!confirm(`This will set every stat for every player to ${baseline}. Are you sure?`)) return;

  const res = await fetch("/api/admin/reset-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey, baseline }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  await loadPlayers();
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

// --- Init ---

document.addEventListener("DOMContentLoaded", () => {
  loadPlayers();
  loadRequests();
  loadGames();
  switchTab("standings");
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
    }
  }
});

// =====================================================================
// GAME RESULTS — standings, game log, and the log-a-result form
// =====================================================================

const LG_MAX_PER_TEAM = 4;
const LG_TEAM_LABELS = ["TEAM 1", "TEAM 2"];

let games = [];
let standings = [];

// One form, two teams. Team 1 is active by default; click a team tab to
// switch where roster taps and the score field apply.
let lgEditingId = null;
let lgActiveTeam = 0;
let lgTeams = [];
let lgGuests = [];
let lgGuestCounter = 0;

function formatGameDate(playedAt) {
  // played_at is stored as naive local time exactly as it was entered, so it is
  // parsed piecewise rather than through Date(string), which would assume UTC.
  const [datePart, timePart = "00:00"] = playedAt.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm);

  const dateStr = dt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: dt.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
  if (!hh && !mm) return dateStr;
  return `${dateStr} · ${dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatPct(pct) {
  if (pct === null || pct === undefined) return "—";
  return pct.toFixed(3).replace(/^0/, "");
}

function formatDiff(diff) {
  if (!diff) return "0";
  return diff > 0 ? `+${diff}` : String(diff);
}

// --- Loading + tabs ---

async function loadGames() {
  const [recordsRes, gamesRes] = await Promise.all([
    fetch("/api/records"),
    fetch("/api/games"),
  ]);
  standings = await recordsRes.json();
  games = await gamesRes.json();

  document.getElementById("games-count").textContent = games.length;
  if (currentTab === "standings" || currentTab === "log") {
    renderGamesBody();
  }
}

function renderGamesBody() {
  const body = document.getElementById("games-body");
  if (!body) return;
  body.innerHTML = currentTab === "standings" ? renderStandings() : renderGameLog();
}

function renderStandings() {
  if (!standings.some((s) => s.games_played > 0)) {
    return `
      <div class="empty-state">
        <div class="emoji">🏆</div>
        <p>No games logged yet. Log a result and the standings build themselves.</p>
      </div>`;
  }

  const rows = standings
    .map((s, i) => {
      const played = s.games_played;
      const rank = played ? i + 1 : "—";
      const diff = formatDiff(s.point_diff);
      const diffCls = s.point_diff > 0 ? "up" : s.point_diff < 0 ? "down" : "";
      return `
      <tr class="${played ? "" : "st-inactive"}">
        <td class="st-rank">${rank}</td>
        <td class="st-player">
          <span class="st-avatar">${
            s.photo_url
              ? `<img src="${s.photo_url}" alt="${escapeHtml(s.name)}">`
              : getInitials(s.name)
          }</span>
          ${escapeHtml(s.name)}
        </td>
        <td class="st-w">${s.wins}</td>
        <td class="st-l">${s.losses}</td>
        <td class="st-pct">${formatPct(s.win_pct)}</td>
        <td class="st-diff ${diffCls}">${played ? diff : "—"}</td>
      </tr>`;
    })
    .join("");

  return `
    <table class="standings">
      <thead>
        <tr>
          <th class="st-rank">#</th>
          <th class="st-player">Player</th>
          <th class="st-w">W</th>
          <th class="st-l">L</th>
          <th class="st-pct" title="Win percentage">PCT</th>
          <th class="st-diff" title="Total point differential">pt diff</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderGameLog() {
  if (games.length === 0) {
    return `
      <div class="empty-state">
        <div class="emoji">📋</div>
        <p>No games logged yet.</p>
      </div>`;
  }
  return `<div class="game-log">${games.map(renderGameCard).join("")}</div>`;
}

function renderGameCard(g) {
  const sides = g.teams
    .map((t) => {
      const names = t.players
        .map((m) => {
          const label = escapeHtml(m.name);
          return m.is_guest ? `${label}<sup class="gc-guest-mark">g</sup>` : label;
        })
        .join(", ");
      return `
      <span class="gc-side gc-team-${t.team_index} ${t.won ? "won" : "lost"}">
        <span class="gc-score">${t.score}</span>
        <span class="gc-names">${names || "—"}</span>
      </span>`;
    })
    .join('<span class="gc-vs">vs</span>');

  const editBtn =
    g.teams.length === 2
      ? `<button class="btn btn-small btn-secondary" onclick="openLogGameModal(${g.id})">Edit</button>`
      : `<span class="gc-admin-note">${g.teams.length} teams</span>`;

  const adminHtml = adminMode
    ? `<div class="gc-actions">
        ${editBtn}
        <button class="btn btn-small btn-secondary gc-delete" onclick="deleteGame(${g.id})">Del</button>
      </div>`
    : "";

  return `
  <div class="gc-card">
    <div class="gc-row">
      <span class="gc-date">${formatGameDate(g.played_at)}</span>
      ${g.location ? `<span class="gc-location">${escapeHtml(g.location)}</span>` : ""}
      <div class="gc-result">${sides}</div>
      ${adminHtml}
    </div>
    ${g.notes ? `<div class="gc-notes">${escapeHtml(g.notes)}</div>` : ""}
  </div>`;
}

// --- Log a result ---

function lgLocalNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openLogGameModal(gameId) {
  lgEditingId = null;
  lgActiveTeam = 0;
  lgTeams = [
    { members: [], score: "" },
    { members: [], score: "" },
  ];
  lgGuests = [];
  lgGuestCounter = 0;

  const game = gameId ? games.find((g) => g.id === gameId) : null;

  if (game) {
    lgEditingId = game.id;
    game.teams.slice(0, 2).forEach((t, i) => {
      lgTeams[i].score = String(t.score);
      t.players.forEach((m) => {
        if (m.is_guest) {
          lgGuestCounter += 1;
          const key = `g${lgGuestCounter}`;
          lgGuests.push({ key, name: m.name });
          lgTeams[i].members.push(key);
        } else {
          lgTeams[i].members.push(`p${m.player_id}`);
        }
      });
    });
  }

  document.getElementById("lg-notes").value = game ? game.notes || "" : "";
  document.getElementById("lg-title").textContent = game ? "Edit Game Result" : "Log Game Result";
  document.getElementById("lg-save-btn").textContent = game ? "SAVE CHANGES" : "SAVE RESULT";
  document.getElementById("lg-guest-name").value = "";

  lgRender();
  document.getElementById("log-game-modal").classList.add("visible");
}

function closeLogGameModal() {
  document.getElementById("log-game-modal").classList.remove("visible");
}

function lgMemberInfo(key) {
  if (key.startsWith("g")) {
    const guest = lgGuests.find((g) => g.key === key);
    return guest ? { key, name: guest.name, player_id: null, is_guest: true } : null;
  }
  const player = players.find((p) => `p${p.id}` === key);
  return player
    ? { key, name: player.name, player_id: player.id, is_guest: false, photo_url: player.photo_url }
    : null;
}

function lgTeamOf(key) {
  return lgTeams.findIndex((t) => t.members.includes(key));
}

function lgPersistScores() {
  [0, 1].forEach((i) => {
    const el = document.getElementById(`lg-score-${i}`);
    if (el) lgTeams[i].score = el.value.trim();
  });
}

function lgSelectTeam(i) {
  lgPersistScores();
  if (i === lgActiveTeam) return;
  lgActiveTeam = i;
  lgRender();
  document.getElementById(`lg-score-${i}`).focus();
}

function lgScoreInput(i) {
  lgActiveTeam = i;
  lgTeams[i].score = document.getElementById(`lg-score-${i}`).value.trim();
  [0, 1].forEach((j) => {
    document.getElementById(`lg-tab-${j}`).classList.toggle("active", j === lgActiveTeam);
  });
  document.getElementById("lg-active-label").textContent = LG_TEAM_LABELS[i].replace("TEAM ", "Team ");
  lgRenderStatus();
}

// Tapping someone on the active team removes them. Tapping someone on the
// other team switches to that team instead of reshuffling chip styles. The
// team pill stays put either way, so switching teams never janks the roster.
function lgToggle(key) {
  lgPersistScores();
  const assigned = lgTeamOf(key);

  if (assigned === lgActiveTeam) {
    const idx = lgTeams[assigned].members.indexOf(key);
    if (idx >= 0) lgTeams[assigned].members.splice(idx, 1);
  } else if (assigned >= 0) {
    lgActiveTeam = assigned;
    lgRender();
    return;
  } else if (lgTeams[lgActiveTeam].members.length >= LG_MAX_PER_TEAM) {
    lgFlashStatus(`${LG_TEAM_LABELS[lgActiveTeam]} already has ${LG_MAX_PER_TEAM} players.`);
    return;
  } else {
    lgTeams[lgActiveTeam].members.push(key);
  }
  lgRender();
}

function lgAddGuest() {
  const input = document.getElementById("lg-guest-name");
  const name = input.value.trim();
  if (!name) return;

  const team = lgTeams[lgActiveTeam];
  if (team.members.length >= LG_MAX_PER_TEAM) {
    lgFlashStatus(`This team already has ${LG_MAX_PER_TEAM} players.`);
    return;
  }

  lgGuestCounter += 1;
  const key = `g${lgGuestCounter}`;
  lgGuests.push({ key, name });
  team.members.push(key);

  input.value = "";
  lgRender();
  input.focus();
}

function lgRemoveGuest(key) {
  lgGuests = lgGuests.filter((g) => g.key !== key);
  lgTeams.forEach((t) => {
    const idx = t.members.indexOf(key);
    if (idx >= 0) t.members.splice(idx, 1);
  });
  lgRender();
}

function lgRender() {
  document.getElementById("lg-active-label").textContent =
    LG_TEAM_LABELS[lgActiveTeam].replace("TEAM ", "Team ");

  [0, 1].forEach((i) => {
    const el = document.getElementById(`lg-score-${i}`);
    if (document.activeElement !== el) el.value = lgTeams[i].score;
    document.getElementById(`lg-count-${i}`).textContent =
      `${lgTeams[i].members.length} / ${LG_MAX_PER_TEAM}`;
    document.getElementById(`lg-tab-${i}`).classList.toggle("active", i === lgActiveTeam);
  });

  lgRenderRoster();
  lgRenderStatus();
}

function lgRenderRoster() {
  const entries = [
    ...players.map((p) => `p${p.id}`),
    ...lgGuests.map((g) => g.key),
  ]
    .map(lgMemberInfo)
    .filter(Boolean);

  document.getElementById("lg-roster").innerHTML = entries
    .map((e) => {
      const assigned = lgTeamOf(e.key);
      const editing = assigned === lgActiveTeam;

      const avatar = e.photo_url
        ? `<img src="${e.photo_url}" alt="${escapeHtml(e.name)}">`
        : `<span class="lg-chip-initials">${getInitials(e.name)}</span>`;
      const removeBtn = e.is_guest
        ? `<span class="lg-chip-remove" onclick="event.stopPropagation(); lgRemoveGuest('${e.key}')" title="Remove guest">&times;</span>`
        : "";
      const teamPill =
        assigned >= 0
          ? `<span class="lg-chip-team t${assigned + 1}">T${assigned + 1}</span>`
          : "";

      return `
      <div class="lg-chip ${assigned >= 0 ? `team-${assigned}` : ""} ${editing ? "editing" : ""}"
           onclick="lgToggle('${e.key}')">
        <span class="lg-chip-avatar">${avatar}</span>
        <span class="lg-chip-name">${escapeHtml(e.name)}</span>
        ${teamPill}
        ${e.is_guest ? '<span class="lg-chip-guest">guest</span>' : ""}
        ${removeBtn}
      </div>`;
    })
    .join("");
}

function lgValidateForm() {
  lgPersistScores();

  for (let i = 0; i < 2; i++) {
    if (!lgTeams[i].members.length) {
      return { ok: false, message: `${LG_TEAM_LABELS[i]} needs at least one player.` };
    }
    if (lgTeams[i].score === "") {
      return { ok: false, message: `Enter a score for ${LG_TEAM_LABELS[i]}.` };
    }
    const score = Number(lgTeams[i].score);
    if (!Number.isInteger(score) || score < 0) {
      return { ok: false, message: "Scores have to be whole numbers, zero or higher." };
    }
  }

  const s0 = Number(lgTeams[0].score);
  const s1 = Number(lgTeams[1].score);
  if (s0 === s1) return { ok: false, message: "No ties — someone has to win." };

  const winner = s0 > s1 ? 0 : 1;
  return {
    ok: true,
    message: `${LG_TEAM_LABELS[winner]} wins ${Math.max(s0, s1)}–${Math.min(s0, s1)}`,
  };
}

function lgFlashStatus(message) {
  const status = document.getElementById("lg-status");
  status.textContent = message;
  status.classList.remove("valid");
}

function lgRenderStatus() {
  lgPersistScores();

  const state = lgValidateForm();
  const status = document.getElementById("lg-status");
  status.textContent = state.message;
  status.classList.toggle("valid", state.ok);
  document.getElementById("lg-save-btn").disabled = !state.ok;
}

async function submitGameResult() {
  if (!lgValidateForm().ok) return;

  const editing = lgEditingId !== null;

  const body = {
    notes: document.getElementById("lg-notes").value.trim(),
    teams: lgTeams.map((t) => {
      const members = t.members.map(lgMemberInfo).filter(Boolean);
      return {
        score: Number(t.score),
        player_ids: members.filter((m) => !m.is_guest).map((m) => m.player_id),
        guests: members.filter((m) => m.is_guest).map((m) => m.name),
      };
    }),
  };

  if (editing) {
    body.admin_key = adminKey;
  } else {
    body.played_at = lgLocalNow();
  }

  const btn = document.getElementById("lg-save-btn");
  btn.disabled = true;

  const res = await fetch(editing ? `/api/games/${lgEditingId}` : "/api/games", {
    method: editing ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (data.error) {
    const status = document.getElementById("lg-status");
    status.textContent = data.error;
    status.classList.remove("valid");
    btn.disabled = false;
    return;
  }

  closeLogGameModal();
  switchTab("log");
  await Promise.all([loadGames(), loadPlayers()]);
}

async function deleteGame(gameId) {
  if (!confirm("Delete this game? Every record built from it will be recalculated.")) return;

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

  await Promise.all([loadGames(), loadPlayers()]);
}

// =====================================================================
// GAME DAY — Team Picker
// =====================================================================

const GD_TEAMS = [
  { tag: "TEAM",   name: "ROSSO",   color: "#d44a4a" },
  { tag: "TEAM",   name: "AZZURRI", color: "#3b7dd8" },
  { tag: "TEAM",   name: "VERDE",   color: "#2a9d6e" },
  { tag: "TEAM",   name: "VIOLA",   color: "#7c5cbf" },
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
  switch (n) {
    case 2: return [1, 1];
    case 3: return [1, 2];
    case 4: return [2, 2];
    case 5: return [2, 3];
    case 6: return [3, 3];
    case 7: return null;
    case 8: return [2, 2, 2, 2];
    default:
      if (n < 2) return null;
      return [Math.floor(n / 2), Math.ceil(n / 2)];
  }
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
          <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">FLR</span></div>
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
                <div class="fut-stat"><span class="fut-stat-val">--</span><span class="fut-stat-label">FLR</span></div>
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
