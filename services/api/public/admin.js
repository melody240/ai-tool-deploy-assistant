const state = {
  token: sessionStorage.getItem("adminToken") || "",
  codes: [],
  total: 0,
  stats: null,
  audit: [],
  offset: 0,
  limit: 100
};

const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginForm = document.querySelector("#login-form");
const tokenInput = document.querySelector("#admin-token");
const loginError = document.querySelector("#login-error");
const globalMessage = document.querySelector("#global-message");
const codeTable = document.querySelector("#code-table");
const codeEmpty = document.querySelector("#code-empty");
const auditTable = document.querySelector("#audit-table");
const auditEmpty = document.querySelector("#audit-empty");
const codesDialog = document.querySelector("#codes-dialog");
const generatedCodes = document.querySelector("#generated-codes");
const createCodeForm = document.querySelector("#create-code-form");
const filterForm = document.querySelector("#filter-form");
const pageState = document.querySelector("#page-state");
const previousPage = document.querySelector("#previous-page");
const nextPage = document.querySelector("#next-page");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = tokenInput.value.trim();
  sessionStorage.setItem("adminToken", state.token);
  await login();
});

document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#refresh-button").addEventListener("click", loadDashboard);
createCodeForm.addEventListener("submit", createCodes);
filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.offset = 0;
  void loadDashboard();
});
document.querySelector("#clear-filter").addEventListener("click", () => {
  filterForm.reset();
  state.offset = 0;
  void loadDashboard();
});
previousPage.addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  void loadDashboard();
});
nextPage.addEventListener("click", () => {
  state.offset += state.limit;
  void loadDashboard();
});
document.querySelector("#close-codes").addEventListener("click", () => {
  codesDialog.hidden = true;
  generatedCodes.value = "";
});
document.querySelector("#copy-codes").addEventListener("click", async () => {
  await navigator.clipboard.writeText(generatedCodes.value);
  showMessage("兑换码已复制到剪贴板。");
});

if (state.token) void login();

async function login() {
  loginError.hidden = true;
  try {
    await loadDashboard();
    loginView.hidden = true;
    dashboardView.hidden = false;
  } catch (error) {
    sessionStorage.removeItem("adminToken");
    loginError.textContent = friendlyError(error);
    loginError.hidden = false;
  }
}

function logout() {
  state.token = "";
  sessionStorage.removeItem("adminToken");
  dashboardView.hidden = true;
  loginView.hidden = false;
  tokenInput.value = "";
}

async function loadDashboard() {
  setBusy(true);
  try {
    const query = new URLSearchParams({
      limit: String(state.limit),
      offset: String(state.offset)
    });
    const filters = new FormData(filterForm);
    for (const name of ["search", "status", "batch"]) {
      const value = String(filters.get(name) || "").trim();
      if (value) query.set(name, value);
    }
    const [codeResponse, stats, auditResponse] = await Promise.all([
      api(`/v1/admin/codes?${query}`),
      api("/v1/admin/stats"),
      api("/v1/admin/audit?limit=100")
    ]);
    state.codes = codeResponse.codes;
    state.total = codeResponse.total;
    state.stats = stats;
    state.audit = auditResponse.events;
    renderDashboard();
  } finally {
    setBusy(false);
  }
}

function renderDashboard() {
  const stats = state.stats;
  document.querySelector("#stat-codes").textContent = String(stats.total);
  document.querySelector("#stat-bound").textContent = String(stats.bound);
  document.querySelector("#stat-active").textContent = String(stats.active);
  document.querySelector("#stat-disabled").textContent = String(stats.disabled);
  document.querySelector("#stat-expired").textContent = String(stats.expired);
  document.querySelector("#stat-renewed").textContent = String(
    stats.renewedLast24Hours
  );
  renderCodes();
  renderAudit();
  const start = state.total === 0 ? 0 : state.offset + 1;
  const end = Math.min(state.offset + state.codes.length, state.total);
  pageState.textContent = `${start}-${end} / ${state.total}`;
  previousPage.disabled = state.offset === 0;
  nextPage.disabled = state.offset + state.codes.length >= state.total;
}

function renderCodes() {
  codeTable.replaceChildren(
    ...state.codes.map((code) => {
      const actions = element("div", "row-actions");
      const reset = button("重置设备", "small", async () => {
        if (!window.confirm(`确认重置兑换码 ${code.prefix}… 的设备绑定？`)) return;
        await api(`/v1/admin/codes/${encodeURIComponent(code.id)}/reset`, {
          method: "POST"
        });
        showMessage("设备绑定已重置。");
        await loadDashboard();
      });
      reset.disabled =
        !code.boundDeviceId || code.resetCount >= code.maxResets;
      actions.append(reset);
      if (code.status === "disabled") {
        actions.append(
          button("重新启用", "small", async () => {
            await api(`/v1/admin/codes/${encodeURIComponent(code.id)}/enable`, {
              method: "POST"
            });
            showMessage("兑换码已重新启用。");
            await loadDashboard();
          })
        );
      } else {
        actions.append(
          button("停用", "small danger", async () => {
            if (!window.confirm(`确认停用兑换码 ${code.prefix}…？`)) return;
            await api(`/v1/admin/codes/${encodeURIComponent(code.id)}/disable`, {
              method: "POST"
            });
            showMessage("兑换码已停用，后续续期将被拒绝。");
            await loadDashboard();
          })
        );
      }
      const expired = code.expiresAt && new Date(code.expiresAt) <= new Date();
      const stateLabel =
        code.status === "disabled"
          ? status("已停用", "disabled")
          : expired
            ? status("已到期", "disabled")
            : status("可用", "active");
      return row([
        `${code.prefix}…`,
        code.batch || "未分批",
        code.label || "无备注",
        stateLabel,
        code.boundDeviceId ? shortId(code.boundDeviceId) : "未绑定",
        `${code.resetCount} / ${code.maxResets}`,
        code.expiresAt ? formatDate(code.expiresAt) : "长期有效",
        code.lastRenewedAt ? formatDate(code.lastRenewedAt) : "尚未续期",
        code.lastAppVersion || "未知",
        formatDate(code.createdAt),
        actions
      ]);
    })
  );
  codeEmpty.hidden = state.codes.length > 0;
}

function renderAudit() {
  auditTable.replaceChildren(
    ...state.audit.map((event) =>
      row([
        formatDate(event.createdAt),
        event.actor === "admin" ? "管理员" : "客户端",
        auditAction(event.action),
        event.targetId ? shortId(event.targetId) : "无",
        JSON.stringify(event.metadata)
      ])
    )
  );
  auditEmpty.hidden = state.audit.length > 0;
}

async function createCodes(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const expiresAt = String(form.get("expiresAt") || "").trim();
  const payload = {
    count: Number(form.get("count")),
    label: String(form.get("label") || "").trim() || undefined,
    batch: String(form.get("batch") || "").trim() || undefined,
    maxResets: Number(form.get("maxResets"))
  };
  if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
  try {
    const response = await api("/v1/admin/codes", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    generatedCodes.value = response.codes.join("\n");
    codesDialog.hidden = false;
    event.currentTarget.reset();
    event.currentTarget.elements.count.value = "1";
    event.currentTarget.elements.maxResets.value = "1";
    await loadDashboard();
  } catch (error) {
    showMessage(friendlyError(error), true);
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) logout();
    const error = new Error(payload.error || `HTTP_${response.status}`);
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function setBusy(busy) {
  document.querySelector("#refresh-button").disabled = busy;
}

function showMessage(message, isError = false) {
  globalMessage.textContent = message;
  globalMessage.classList.toggle("error", isError);
  globalMessage.hidden = false;
}

function row(values) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const td = document.createElement("td");
    if (value instanceof Node) td.append(value);
    else td.textContent = value;
    tr.append(td);
  }
  return tr;
}

function button(text, className, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = text;
  control.className = className;
  control.addEventListener("click", async () => {
    control.disabled = true;
    try {
      await action();
    } catch (error) {
      showMessage(friendlyError(error), true);
    } finally {
      control.disabled = false;
    }
  });
  return control;
}

function status(text, kind) {
  const value = element("span", `status ${kind === "active" ? "good" : kind}`);
  value.textContent = text;
  return value;
}

function element(tag, className) {
  const value = document.createElement(tag);
  value.className = className;
  return value;
}

function shortId(value) {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function auditAction(value) {
  return {
    "codes.created": "生成兑换码",
    "code.reset": "重置设备",
    "code.disabled": "停用兑换码",
    "code.enabled": "启用兑换码",
    "license.activated": "首次激活",
    "license.existing": "重复激活",
    "license.renewed": "许可证续期"
  }[value] || value;
}

function friendlyError(error) {
  const messages = {
    UNAUTHORIZED: "管理员 Token 不正确。",
    INVALID_COUNT: "生成数量必须在 1 到 500 之间。",
    INVALID_MAX_RESETS: "重置次数必须在 0 到 20 之间。",
    INVALID_EXPIRATION: "授权期限必须是未来时间。",
    RESET_LIMIT_REACHED: "这个兑换码已经用完重置机会。",
    CODE_NOT_FOUND: "没有找到这个兑换码。",
    RATE_LIMITED: "操作过于频繁，请稍后重试。"
  };
  return messages[error.code] || error.message || "操作失败，请检查服务日志。";
}
