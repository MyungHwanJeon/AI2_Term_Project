/* No build step or third-party dependencies. Submissions require student numbers and passwords. */
(function () {
  "use strict";

  const HARD_UPLOAD_LIMIT = 50 * 1024 * 1024;
  const STATES = { queued: "채점 대기", running: "채점 중", completed: "채점 완료", failed: "채점 실패" };

  function formatAP(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
      ? (value * 100).toFixed(2) : "—";
  }

  function validStudentId(value) { return typeof value === "string" && /^[0-9]{6,12}$/.test(value); }

  function uploadLimit(config) {
    return Math.min(HARD_UPLOAD_LIMIT, Number(config && config.max_upload_bytes) > 0
      ? Number(config.max_upload_bytes) : HARD_UPLOAD_LIMIT);
  }

  function fileIssue(file, config) {
    if (!file) return "JSON 파일을 선택해 주세요.";
    if (!/\.json$/i.test(file.name)) return ".json 형식의 파일을 선택해 주세요.";
    if (!Number.isFinite(file.size) || file.size <= 0) return "빈 파일은 제출할 수 없습니다.";
    if (file.size > uploadLimit(config)) return `파일 크기 초과 · 최대 ${formatSize(uploadLimit(config))}`;
    return "";
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} MiB`;
    return `${Math.ceil(bytes / 1024)} KiB`;
  }

  function safeApiBase(value, origin) {
    if (value === "" || value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error("채점 서버 주소 오류 · 관리자에게 문의해 주세요.");
    let url;
    try { url = new URL(value, origin); }
    catch (_) { throw new Error("채점 서버 주소 오류 · 관리자에게 문의해 주세요."); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && (!local || new URL(origin).protocol === "https:"))) {
      throw new Error("채점 서버 연결 오류 · 관리자에게 문의해 주세요.");
    }
    return url.href.replace(/\/+$/, "");
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { formatAP, validStudentId, fileIssue, safeApiBase };
  if (typeof document === "undefined") return;

  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries([
    "connectionDot", "connectionText", "studentCount", "submissionCount", "bestScore", "queueCount", "queueLabel",
    "leaderboardRows", "leaderboardEmpty", "emptyTitle", "emptyText", "leaderboardError", "updatedAt", "refreshButton",
    "studentSearch", "studentId", "studentPassword", "predictionFile", "dropZone", "fileName", "fileHint",
    "clearFile", "submissionForm", "submitButton", "formMessage", "uploadStatus", "uploadStatusText", "historyButton",
    "historyList", "historyHint", "historyError"
  ].map(id => [id, byId(id)]));

  const state = {
    apiBase: "", config: null, configError: null, rows: [], boardLoaded: false,
    file: null, uploading: false, publicBusy: false, privateBusy: false,
    credentials: null, history: [], generation: 0, disposed: false,
    controllers: new Set(), timer: null, lastBoard: 0, lastPrivate: 0, privateFailures: 0,
    storagePrefix: "ai2-term-project:v1:"
  };

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };

  function showMessage(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("error", isError);
    element.hidden = !message;
  }

  function storeStudentId(value) {
    try { localStorage.setItem(state.storagePrefix + "student", value); } catch (_) { /* Storage is optional. */ }
  }

  function pendingKey(studentId) { return `${state.storagePrefix}${state.apiBase || location.origin}:pending:${studentId}`; }
  function readPending(studentId) {
    try {
      const values = JSON.parse(sessionStorage.getItem(pendingKey(studentId)) || "[]");
      return Array.isArray(values) ? values.filter(id => typeof id === "string" && id.length <= 160).slice(-100) : [];
    } catch (_) { return []; }
  }
  function writePending(studentId, ids) {
    try { sessionStorage.setItem(pendingKey(studentId), JSON.stringify([...new Set(ids)].slice(-100))); } catch (_) { /* Optional. */ }
  }

  function formatTime(value, compact = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      ...(compact ? {} : { year: "numeric" })
    }).format(date);
  }

  function errorMessage(error) {
    if (error && error.userMessage) return error.userMessage;
    if (error && error.name === "AbortError") return "서버 응답 지연 · 잠시 후 다시 시도해 주세요.";
    return "채점 서버 연결 실패 · 인터넷 연결을 확인해 주세요.";
  }

  function responseMessage(status, payload) {
    const raw = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.detail || "";
    const text = typeof raw === "string" ? raw.toLowerCase() : "";
    if (status === 401 || status === 403) return "학번과 비밀번호를 확인하시기 바랍니다.";
    if (status === 413) return "제출 가능한 파일 크기를 초과했습니다.";
    if (status === 429 || status === 503) return "접수 요청 초과 · 잠시 후 다시 시도해 주세요.";
    if (status === 404) return "조회된 기록 없음 · 학번을 확인해 주세요.";
    if (status === 400 || status === 422) {
      if (/student|학번/.test(text)) return "학번은 숫자 6–12자리로 입력해 주세요.";
      if (/too many|prediction.*limit|maximum.*prediction/.test(text)) return "예측 객체 수가 제출 한도를 초과했습니다.";
      return "접수 실패 · JSON 형식과 필수 항목을 확인해 주세요.";
    }
    return "요청 처리 실패 · 잠시 후 다시 시도해 주세요.";
  }

  async function request(path, options = {}, timeout = 20000) {
    const controller = new AbortController();
    state.controllers.add(controller);
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(state.apiBase + path, { ...options, cache: "no-store", signal: controller.signal, credentials: "omit", redirect: "error" });
      let payload;
      try { payload = await response.json(); }
      catch (_) { throw Object.assign(new Error("Invalid response"), { userMessage: "채점 서버 응답 오류 · 관리자에게 문의해 주세요." }); }
      if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status, userMessage: responseMessage(response.status, payload) });
      return payload;
    } finally {
      clearTimeout(timer);
      state.controllers.delete(controller);
    }
  }

  function connection(ok) {
    ui.connectionDot.classList.toggle("online", ok);
    ui.connectionDot.classList.toggle("offline", !ok);
    ui.connectionText.textContent = ok ? "채점 서버 연결됨" : "연결 확인 필요";
  }

  async function loadConfig() {
    const config = await request("/api/config");
    if (!config || typeof config.auth_required !== "boolean" || !Array.isArray(config.categories) || !Array.isArray(config.test_images)) {
      throw Object.assign(new Error("Invalid configuration"), { userMessage: "채점 설정 조회 실패 · 새로고침해 주세요." });
    }
    state.config = config;
    updateFileLabel();
    ui.submitButton.disabled = state.uploading;
  }

  function renderBoard() {
    const query = ui.studentSearch.value.trim();
    const mine = ui.studentId.value.trim();
    const rows = state.rows.filter(row => String(row.student_id).includes(query));
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = make("tr", String(row.student_id) === mine ? "my-row" : "");
      const rank = make("td");
      rank.append(make("span", `rank-marker${Number(row.rank) <= 3 ? " top-rank" : ""}`, row.rank));
      const student = make("td", "student-cell", row.student_id);
      if (String(row.student_id) === mine) student.append(make("span", "mine-label", "본인"));
      const time = make("td", "time-column", formatTime(row.submitted_at, true));
      time.title = `${formatTime(row.submitted_at)} (한국 시간)`;
      tr.append(rank, student, make("td", "numeric", formatAP(row.bb_ap)), make("td", "numeric", formatAP(row.mask_ap)),
        make("td", "numeric final-column", formatAP(row.score)), make("td", "numeric", Number.isFinite(row.submission_count) ? row.submission_count.toLocaleString("ko-KR") : "—"), time);
      fragment.append(tr);
    }
    ui.leaderboardRows.replaceChildren(fragment);
    ui.leaderboardEmpty.hidden = rows.length > 0;
    if (!rows.length && state.boardLoaded) {
      ui.emptyTitle.textContent = query ? "해당 학번의 기록 없음" : "등록된 기록 없음";
      ui.emptyText.textContent = query ? "학번을 확인하거나 검색어를 삭제해 주세요." : "채점이 완료된 제출 결과가 표시됩니다.";
    }
  }

  async function refreshPublic() {
    if (state.publicBusy || state.disposed || state.configError) return;
    state.publicBusy = true;
    ui.refreshButton.disabled = true;
    try {
      if (!state.config) await loadConfig();
      const data = await request("/api/leaderboard");
      if (!Array.isArray(data.rows) || !data.queue) throw new Error("Invalid leaderboard");
      state.rows = data.rows;
      state.boardLoaded = true;
      renderBoard();
      ui.studentCount.textContent = data.rows.length.toLocaleString("ko-KR");
      const total = data.rows.reduce((sum, row) => sum + (Number.isFinite(row.submission_count) ? row.submission_count : 0), 0);
      ui.submissionCount.textContent = total.toLocaleString("ko-KR");
      ui.bestScore.textContent = data.rows.length ? formatAP(Math.max(...data.rows.map(row => row.score))) : "—";
      ui.queueCount.textContent = `${Number(data.queue.queued) || 0} / ${Number(data.queue.running) || 0}`;
      ui.updatedAt.textContent = `업데이트 ${formatTime(data.updated_at, true)} · 한국 시간`;
      showMessage(ui.leaderboardError, "");
      connection(true);
    } catch (error) {
      if (state.disposed) return;
      connection(false);
      showMessage(ui.leaderboardError, errorMessage(error) + (state.boardLoaded ? " 마지막으로 조회한 기록을 표시합니다." : ""), true);
      if (!state.boardLoaded) {
        ui.emptyTitle.textContent = "채점 서버 연결 대기";
        ui.emptyText.textContent = "서버 연결 후 제출 기록이 표시됩니다.";
      }
    } finally {
      state.lastBoard = Date.now();
      state.publicBusy = false;
      ui.refreshButton.disabled = false;
    }
  }

  function credentialsFromForm() {
    const studentId = ui.studentId.value.trim();
    if (!validStudentId(studentId)) {
      ui.studentId.focus();
      throw Object.assign(new Error("Invalid student ID"), { userMessage: "학번은 숫자 6–12자리로 입력해 주세요." });
    }
    const password = ui.studentPassword.value;
    if ([...password].length < 8 || [...password].length > 128) {
      ui.studentPassword.focus();
      throw Object.assign(new Error("Invalid password"), { userMessage: "비밀번호는 8–128자로 입력하시기 바랍니다." });
    }
    storeStudentId(studentId);
    return { studentId, password };
  }

  function authHeaders(credentials) {
    const bytes = new TextEncoder().encode(credentials.studentId + ":" + credentials.password);
    return { "Authorization": "Basic " + btoa(String.fromCharCode(...bytes)) };
  }

  function useCredentials(credentials) {
    if (state.credentials?.studentId !== credentials.studentId || state.credentials?.password !== credentials.password) {
      state.generation += 1;
      state.history = [];
    }
    state.credentials = credentials;
    state.privateFailures = 0;
    renderHistory();
  }

  function friendlyEvaluationError(value) {
    const text = typeof value === "string" ? value.toLowerCase() : "";
    if (/timeout|deadline|time limit/.test(text)) return "채점 제한 시간 초과";
    if (/image.?id/.test(text)) return "image_id가 테스트 이미지 목록과 일치하지 않습니다.";
    if (/category/.test(text)) return "category_id를 데이터셋의 원래 값으로 지정해 주세요.";
    if (/bbox|bounding/.test(text)) return "bbox의 좌표·크기·이미지 범위를 확인해 주세요. 형식: [x, y, width, height]";
    if (/rle|segmentation|mask/.test(text)) return "";
    if (/score|nan|infinity|finite/.test(text)) return "score는 0–1 범위의 유한한 숫자여야 합니다.";
    if (/json|parse|prediction/.test(text)) return "JSON 객체 목록과 필수 항목을 확인해 주세요.";
    return "채점 실패 · 파일 형식을 확인해 주세요.";
  }

  function renderHistory() {
    const fragment = document.createDocumentFragment();
    for (const item of state.history.slice(0, 20)) {
      const status = Object.hasOwn(STATES, item.status) ? item.status : "queued";
      const li = make("li", "history-item");
      const top = make("div", "history-item-top");
      const badge = make("span", `status-badge ${status}`, STATES[status]);
      if (status === "running") badge.prepend(make("span", "spinner"));
      top.append(badge, status === "completed" ? make("strong", "history-score", formatAP(item.metrics?.score))
        : make("span", "history-date", formatTime(item.created_at, true)));
      li.append(top);
      if (status === "completed") {
        li.append(make("p", "history-detail", `bbox ${formatAP(item.metrics?.bb_ap)} · mask ${formatAP(item.metrics?.mask_ap)} · ${formatTime(item.finished_at, true)}`));
      } else if (status === "failed") {
        const detail = friendlyEvaluationError(item.error);
        if (detail) li.append(make("p", "history-detail failed", detail));
      } else {
        li.append(make("p", "history-detail", status === "running" ? "성능 평가 진행 중" : "채점 순서 대기 중"));
      }
      li.append(make("p", "history-id", `ID ${item.submission_id}`));
      fragment.append(li);
    }
    ui.historyList.replaceChildren(fragment);
    if (state.history.length) {
      ui.historyHint.textContent = "최근 제출 기록 · 대기 중인 결과 자동 갱신";
    } else if (state.credentials) {
      ui.historyHint.textContent = "조회된 제출 기록 없음";
    }
  }

  async function refreshPrivate() {
    if (!state.credentials || state.privateBusy || state.disposed) return;
    const credentials = { ...state.credentials };
    const generation = state.generation;
    const current = () => generation === state.generation && !state.disposed;
    state.privateBusy = true;
    ui.historyButton.disabled = true;
    try {
      const data = await request(`/api/history?student_id=${encodeURIComponent(credentials.studentId)}`, { headers: authHeaders(credentials) });
      if (!Array.isArray(data.submissions)) throw new Error("Invalid history");
      // Recent history can omit older pending jobs. Track only this student's known IDs.
      const known = new Map(data.submissions.map(item => [String(item.submission_id), item]));
      const pending = readPending(credentials.studentId);
      const missing = pending.filter(id => !known.has(id));
      for (const id of missing.slice(0, 10)) {
        if (!current()) return;
        try {
          const item = await request(`/api/submissions/${encodeURIComponent(id)}`, { headers: authHeaders(credentials) });
          known.set(id, item);
        } catch (error) {
          if (error.status === 404) {
            writePending(credentials.studentId, readPending(credentials.studentId).filter(value => value !== id));
          } else { throw error; }
        }
      }
      if (!current()) return;
      // Keep jobs accepted while this read was in flight.
      for (const item of state.history) if (!known.has(item.submission_id) && ["queued", "running"].includes(item.status)) known.set(item.submission_id, item);
      const previousPending = new Set(state.history.filter(item => ["queued", "running"].includes(item.status)).map(item => item.submission_id));
      state.history = [...known.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const pendingIds = new Set(readPending(credentials.studentId));
      for (const item of state.history) {
        if (["queued", "running"].includes(item.status)) pendingIds.add(item.submission_id);
        else pendingIds.delete(item.submission_id);
      }
      writePending(credentials.studentId, [...pendingIds]);
      state.privateFailures = 0;
      renderHistory();
      if (!state.history.length) ui.historyHint.textContent = "제출 기록 없음";
      showMessage(ui.historyError, "");
      if (state.history.some(item => previousPending.has(item.submission_id) && item.status === "completed")) void refreshPublic();
    } catch (error) {
      if (!current()) return;
      state.privateFailures += 1;
      showMessage(ui.historyError, errorMessage(error), true);
      if (error.status === 401 || error.status === 403) {
        state.credentials = null;
        state.history = [];
        renderHistory();
        ui.historyHint.textContent = "학번을 확인한 뒤 다시 조회해 주시기 바랍니다.";
      }
    } finally {
      state.lastPrivate = Date.now();
      state.privateBusy = false;
      ui.historyButton.disabled = false;
    }
  }

  function updateFileLabel() {
    ui.fileName.textContent = state.file ? state.file.name : "파일을 선택하거나 끌어다 놓기";
    ui.fileHint.textContent = state.file ? `${formatSize(state.file.size)} · 제출 준비됨` : `JSON · 최대 ${formatSize(uploadLimit(state.config))}`;
    ui.dropZone.classList.toggle("has-file", Boolean(state.file));
    ui.clearFile.hidden = !state.file;
  }

  function selectFile(file) {
    if (state.uploading) return;
    const problem = fileIssue(file, state.config);
    if (problem) {
      state.file = null;
      ui.predictionFile.value = "";
      showMessage(ui.formMessage, problem, true);
    } else {
      state.file = file;
      showMessage(ui.formMessage, "");
    }
    updateFileLabel();
  }

  function setUploading(uploading, message = "파일 확인 중") {
    state.uploading = uploading;
    ui.submitButton.disabled = uploading || !state.config;
    ui.predictionFile.disabled = uploading;
    ui.clearFile.disabled = uploading;
    ui.studentId.disabled = uploading;
    ui.studentPassword.disabled = uploading;
    ui.uploadStatus.hidden = !uploading;
    ui.uploadStatusText.textContent = message;
    ui.submissionForm.setAttribute("aria-busy", String(uploading));
  }

  async function submit(event) {
    event.preventDefault();
    if (state.uploading) return;
    showMessage(ui.formMessage, "");
    if (!state.config) {
      showMessage(ui.formMessage, "채점 서버 연결 확인 필요", true);
      return;
    }
    let credentials;
    try { credentials = credentialsFromForm(); }
    catch (error) { showMessage(ui.formMessage, errorMessage(error), true); return; }
    const problem = fileIssue(state.file, state.config);
    if (problem) { showMessage(ui.formMessage, problem, true); ui.predictionFile.focus(); return; }
    const file = state.file;
    let sent = false;
    setUploading(true);
    try {
      let predictions;
      try { predictions = JSON.parse(await file.text()); }
      catch (_) { throw Object.assign(new Error("Invalid JSON"), { userMessage: "JSON 읽기 실패 · UTF-8 JSON 형식을 확인해 주세요." }); }
      if (!Array.isArray(predictions)) throw Object.assign(new Error("Not an array"), { userMessage: "예측 JSON의 최상위 구조는 객체 목록 [ … ]이어야 합니다." });
      if (Number.isInteger(state.config.max_predictions) && predictions.length > state.config.max_predictions) {
        throw Object.assign(new Error("Too many predictions"), { userMessage: `파일당 최대 ${state.config.max_predictions.toLocaleString("ko-KR")}개까지 제출 가능합니다.` });
      }
      predictions = null;
      const body = new FormData();
      body.append("student_id", credentials.studentId);
      body.append("password", credentials.password);
      body.append("file", file, file.name);
      useCredentials(credentials);
      setUploading(true, "JSON 파일 업로드 중");
      sent = true;
      const result = await request("/api/submissions", { method: "POST", body }, 120000);
      if (typeof result.submission_id !== "string" || !Object.hasOwn(STATES, result.status)) throw new Error("Invalid submission response");
      const pending = readPending(credentials.studentId);
      if (["queued", "running"].includes(result.status)) writePending(credentials.studentId, [...pending, result.submission_id]);
      state.history.unshift({ submission_id: result.submission_id, student_id: credentials.studentId, status: result.status, created_at: new Date().toISOString(), metrics: null });
      renderHistory();
      showMessage(ui.formMessage, "");
      state.file = null;
      ui.predictionFile.value = "";
      updateFileLabel();
      void refreshPrivate();
      void refreshPublic();
    } catch (error) {
      if (!state.disposed) {
        const uncertain = sent && !error.status;
        showMessage(ui.formMessage, errorMessage(error) + (uncertain ? " 접수 여부는 내 제출 기록에서 확인해 주세요." : ""), true);
        if (uncertain) void refreshPrivate();
      }
    } finally { setUploading(false); }
  }

  function resetIdentity() {
    state.generation += 1;
    state.credentials = null;
    state.history = [];
    state.lastPrivate = 0;
    renderHistory();
    ui.historyHint.textContent = "";
    showMessage(ui.historyError, "");
    showMessage(ui.formMessage, "");
    renderBoard();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (state.disposed) return;
    state.timer = window.setTimeout(async () => {
      if (!document.hidden) {
        const now = Date.now();
        const requests = [];
        if (now - state.lastBoard > 15000) requests.push(refreshPublic());
        const interval = Math.min(60000, 4000 * (2 ** Math.min(state.privateFailures, 4)));
        if (state.credentials && now - state.lastPrivate > interval) requests.push(refreshPrivate());
        await Promise.allSettled(requests);
      }
      schedule();
    }, 2000);
  }

  ui.submissionForm.addEventListener("submit", submit);
  ui.studentSearch.addEventListener("input", renderBoard);
  ui.studentId.addEventListener("input", resetIdentity);
  ui.studentPassword.addEventListener("input", resetIdentity);
  ui.predictionFile.addEventListener("change", () => { if (ui.predictionFile.files[0]) selectFile(ui.predictionFile.files[0]); });
  ui.clearFile.addEventListener("click", () => { state.file = null; ui.predictionFile.value = ""; updateFileLabel(); showMessage(ui.formMessage, ""); });
  ui.refreshButton.addEventListener("click", () => { void refreshPublic(); });
  ui.historyButton.addEventListener("click", async () => {
    if (!state.config) { showMessage(ui.historyError, "채점 서버 연결 확인 필요", true); return; }
    try { useCredentials(credentialsFromForm()); await refreshPrivate(); }
    catch (error) { showMessage(ui.historyError, errorMessage(error), true); }
  });
  for (const eventName of ["dragenter", "dragover"]) ui.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    if (!state.uploading) ui.dropZone.classList.add("dragging");
  });
  for (const eventName of ["dragleave", "drop"]) ui.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    ui.dropZone.classList.remove("dragging");
  });
  ui.dropZone.addEventListener("drop", event => {
    if (state.uploading) return;
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) { showMessage(ui.formMessage, "한 번에 JSON 파일 하나만 선택해 주세요.", true); return; }
    selectFile(files[0]);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.disposed) { void refreshPublic(); if (state.credentials) void refreshPrivate(); }
  });
  window.addEventListener("pagehide", () => {
    state.disposed = true;
    clearTimeout(state.timer);
    for (const controller of state.controllers) controller.abort();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) { state.disposed = false; void refreshPublic(); schedule(); }
  });

  try {
    state.apiBase = safeApiBase(window.LEADERBOARD_CONFIG?.apiBase, location.origin);
    const remembered = localStorage.getItem(state.storagePrefix + "student");
    if (validStudentId(remembered)) ui.studentId.value = remembered;
  } catch (error) {
    if (error instanceof TypeError || /서버|연결/.test(error.message)) {
      state.configError = error;
      connection(false);
      showMessage(ui.leaderboardError, error.message, true);
      ui.emptyTitle.textContent = "채점 서버 설정 확인 필요";
      ui.emptyText.textContent = "관리자에게 연결 설정 확인을 요청해 주세요.";
    }
  }
  void refreshPublic();
  schedule();
})();
