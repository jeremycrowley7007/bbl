let players = [];
let currentTab = "open";
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

// --- Rendering ---

async function loadPlayers() {
  const res = await fetch("/api/players");
  players = await res.json();
  renderPlayerCards();
  populatePlayerSelect();
}

function renderPlayerCards() {
  const grid = document.getElementById("player-cards");
  const statRows = [
    ["placement", "wall_ball"],
    ["bowling", "substance_use"],
    ["tilt_aversion", "flair"],
  ];

  grid.innerHTML = players
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
    container.innerHTML = `
      <div class="empty-state">
        <div class="emoji">${currentTab === "open" ? "🎯" : "📋"}</div>
        <p>${
          currentTab === "open"
            ? "No open requests. Think someone's stats need updating?"
            : "No past requests yet."
        }</p>
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
    statPills = Object.keys(STAT_NAMES)
      .map((key) => {
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        const current = player[key];
        const diff = proposed - current;
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
        ${statDescHtml}
      </div>
    </div>`;

  overlay.classList.add("visible");
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
    statsHtml = Object.keys(STAT_NAMES)
      .map((key) => {
        const current = player[key];
        const proposed = r[`proposed_${key}`];
        if (proposed == null) return "";
        const diff = proposed - current;
        const cls = diff > 0 ? "up" : diff < 0 ? "down" : "same";
        return `
        <div class="stat-compare-row">
          <span class="stat-compare-label">${STAT_FULL[key]}</span>
          <span class="stat-compare-current">${current}</span>
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

  container.innerHTML = '<div class="stat-inputs">' + statFields.map((key) => {
    const current = player[key];
    return `
      <div class="stat-input-group">
        <label>${STAT_FULL[key]}</label>
        <div class="stat-input-row">
          <span class="stat-current-val">${current}</span>
          <span class="stat-arrow">→</span>
          <input type="number" id="req-${key}" min="1" max="99" value="${current}"
                 data-original="${current}" oninput="updateStatDiff(this)">
          <span class="stat-diff" id="diff-${key}"></span>
        </div>
      </div>`;
  }).join("") + '</div>';
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

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  loadRequests();
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

  const body = {
    proposed_name: document.getElementById("np-name").value.trim(),
    requested_by: name,
    description: document.getElementById("np-description").value.trim(),
    proposed_placement: parseInt(document.getElementById("np-placement").value) || 50,
    proposed_bowling: parseInt(document.getElementById("np-bowling").value) || 50,
    proposed_tilt_aversion: parseInt(document.getElementById("np-tilt_aversion").value) || 50,
    proposed_wall_ball: parseInt(document.getElementById("np-wall_ball").value) || 50,
    proposed_substance_use: parseInt(document.getElementById("np-substance_use").value) || 50,
    proposed_flair: parseInt(document.getElementById("np-flair").value) || 50,
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
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const zoom = document.getElementById("card-zoom-overlay");
    if (zoom && zoom.classList.contains("visible")) {
      closeCardZoom();
    }
  }
});
