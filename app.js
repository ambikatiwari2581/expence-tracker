
const $ = (id) => document.getElementById(id);

let currentUser = null;
let editingId = null;

const money = (amount) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR"
  }).format(Number(amount) || 0);

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localMonth() {
  return localDate().slice(0, 7);
}

function message(text) {
  $("message").textContent = text;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request poora nahi hua.");
  }

  return data;
}

function showDashboard(user) {
  currentUser = user;
  $("auth-panel").hidden = true;
  $("dashboard").hidden = false;
  $("user-email").textContent = user.email;
  $("admin-panel").hidden = user.role !== "admin";
}

function showLogin() {
  currentUser = null;
  $("auth-panel").hidden = false;
  $("dashboard").hidden = true;
  $("admin-panel").hidden = true;
  $("password").value = "";
}

async function authenticate(mode) {
  message("");

  try {
    const data = await api(`/api/${mode}`, {
      method: "POST",
      body: JSON.stringify({
        email: $("email").value.trim(),
        password: $("password").value
      })
    });

    showDashboard(data.user);
    $("password").value = "";
    $("date").value = localDate();
    $("report-month").value = localMonth();

    message(mode === "signup"
      ? "Account ban gaya!"
      : "Login successful!");

    await refreshAll();
  } catch (error) {
    message(error.message);
  }
}

$("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("login");
});

$("signup-btn").addEventListener("click", () => {
  if (!$("auth-form").reportValidity()) return;
  authenticate("signup");
});

$("logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    showLogin();
    message("Aap logout ho gaye.");
  } catch (error) {
    message(error.message);
  }
});

function resetEntryForm() {
  editingId = null;
  $("entry-form").reset();
  $("date").value = localDate();
  $("entry-heading").textContent = "नई Entry जोड़ें";
  $("save-btn").textContent = "Entry Save करें";
  $("cancel-edit").hidden = true;
}

$("cancel-edit").addEventListener("click", resetEntryForm);

$("entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("");

  const entry = {
    description: $("description").value.trim(),
    amount: Number($("amount").value),
    type: $("type").value,
    category: $("category").value,
    date: $("date").value
  };

  try {
    const isEditing = editingId !== null;

    await api(
      isEditing ? `/api/entries/${editingId}` : "/api/entries",
      {
        method: isEditing ? "PUT" : "POST",
        body: JSON.stringify(entry)
      }
    );

    resetEntryForm();
    message(isEditing ? "Entry update ho gayi." : "Entry save ho gayi.");
    await refreshAll();
  } catch (error) {
    message(error.message);
  }
});

async function loadEntries() {
  const data = await api("/api/entries");
  const list = $("entries");
  list.replaceChildren();

  let income = 0;
  let expense = 0;

  if (data.entries.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Abhi koi entry nahi hai. Pehli entry jodein.";
    list.append(empty);
  }

  for (const entry of data.entries) {
    if (entry.type === "income") income += Number(entry.amount);
    else expense += Number(entry.amount);

    const card = document.createElement("article");
    card.className = "entry";

    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = entry.description;

    const meta = document.createElement("p");
    meta.textContent =
      `${entry.category} · ${entry.date} · ` +
      (entry.type === "income" ? "आय" : "खर्च");

    const amount = document.createElement("p");
    amount.className = entry.type === "income"
      ? "amount-income" : "amount-expense";
    amount.textContent =
      `${entry.type === "income" ? "+" : "−"}${money(entry.amount)}`;

    details.append(title, meta, amount);

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => beginEdit(entry));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteEntry(entry.id));

    actions.append(edit, remove);
    card.append(details, actions);
    list.append(card);
  }

  $("income-total").textContent = money(income);
  $("expense-total").textContent = money(expense);
  $("balance-total").textContent = money(income - expense);
}

function beginEdit(entry) {
  editingId = entry.id;
  $("description").value = entry.description;
  $("amount").value = entry.amount;
  $("type").value = entry.type;
  $("category").value = entry.category;
  $("date").value = entry.date;
  $("entry-heading").textContent = "Entry Edit करें";
  $("save-btn").textContent = "Changes Save करें";
  $("cancel-edit").hidden = false;
  $("description").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteEntry(id) {
  if (!window.confirm("Kya aap is entry ko delete karna chahte hain?")) {
    return;
  }

  try {
    await api(`/api/entries/${id}`, { method: "DELETE" });
    if (editingId === id) resetEntryForm();
    message("Entry delete ho gayi.");
    await refreshAll();
  } catch (error) {
    message(error.message);
  }
}

async function loadReport() {
  const month = $("report-month").value;
  if (!month) {
    $("report-result").textContent = "Pehle month select karein.";
    return;
  }

  const data = await api(
    `/api/reports?month=${encodeURIComponent(month)}`
  );

  const result = $("report-result");
  result.replaceChildren();

  const lines = [
    `महीना: ${data.month}`,
    `कुल आय: ${money(data.income)}`,
    `कुल खर्च: ${money(data.expense)}`,
    `बची राशि: ${money(data.balance)}`,
    "खर्च की Category के अनुसार:"
  ];

  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    result.append(p);
  }

  if (data.byCategory.length === 0) {
    const p = document.createElement("p");
    p.textContent = "इस महीने कोई खर्च दर्ज नहीं है।";
    result.append(p);
  }

  for (const item of data.byCategory) {
    const p = document.createElement("p");
    p.textContent = `${item.category}: ${money(item.total)}`;
    result.append(p);
  }
}

$("report-btn").addEventListener("click", async () => {
  try {
    await loadReport();
  } catch (error) {
    message(error.message);
  }
});

$("refresh-btn").addEventListener("click", async () => {
  try {
    await refreshAll();
    message("Data refresh ho gaya.");
  } catch (error) {
    message(error.message);
  }
});

async function loadAdminStats() {
  const data = await api("/api/admin/stats");
  const result = $("admin-result");
  result.replaceChildren();

  const stats = [
    `कुल Users: ${data.users}`,
    `कुल Entries: ${data.entries}`,
    `सभी Users के दर्ज खर्चों का कुल: ${money(data.expenses)}`
  ];

  for (const item of stats) {
    const p = document.createElement("p");
    p.textContent = item;
    result.append(p);
  }
}

$("admin-refresh").addEventListener("click", async () => {
  try {
    await loadAdminStats();
  } catch (error) {
    message(error.message);
  }
});

async function refreshAll() {
  await loadEntries();
  await loadReport();

  if (currentUser?.role === "admin") {
    await loadAdminStats();
  }
}

async function startApp() {
  $("date").value = localDate();
  $("report-month").value = localMonth();

  try {
    const data = await api("/api/me");
    showDashboard(data.user);
    await refreshAll();
  } catch {
    showLogin();
  }
}

startApp();
