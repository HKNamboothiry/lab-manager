const API_URL = "https://script.google.com/macros/s/AKfycbwD_GLzrBzNz9ZAaJNXQ5O0__m6Tlyp-q3-EaU1pc-1R_Y__56FZVzBBnYYyXsFSFra/exec";

let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let activeVendors = [];
let vendorDB = [];
let globalAlerts = { unacquired: [], lowStock: [] };
let latestInheritedBudget = 0;
let latestInheritedFacultyAddress = null;
let collapsedGroups = { acquired: false, partly: false, toAcquire: false };

// Non-item bills (Additional Expenses) for current list
let nonItemExpenses = [];

// Multi-list selection sets for the 3 export modals
let selectedRfqLists = new Set();
let selectedFinLists = new Set();
let selectedStockRepLists = new Set();

// Cached stock data for Stock Report
let cachedStockForSummary = [];
let cachedLedgerForSummary = [];

const DEFAULT_FACULTY_ADDRESS = {
    fullName: "Dr. Nimmi Das Anthuparambil",
    designation: "Assistant Professor",
    department: "Department of Physics, IIT Madras",
    building: "",
    room: "HSB 218A",
    email: "nimmi@physics.iitm.ac.in",
    phone: "+91 9496443324"
};

const BASE_HEADERS = [
    "SL No", "Item", "Item Specs", "Reference Link", "Preferred Company", "Product Code",
    "Required Quantity", "Unit", "Sub Quantity", "Sub Unit",
    "Acquired Qty", "Acquired Sub Qty", "Acquired Sub Unit",
    "Estimated Price", "Selected Vendor", "Total Estimate",
    "Bill Ref No", "Bill Date", "Bill Amount", "Date of Procurement", "Item Status"
];
const DEFAULT_UNITS = ["Piece", "Packet", "Box", "Roll", "Bottle"];
const DEFAULT_SUB_UNITS = ["Piece", "mL", "L", "g", "kg", "Pair", "Roll"];

function isPieceUnit(unit) {
    return (unit || "Piece").trim().toLowerCase() === "piece";
}

function esc(val) {
    return String(val ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function isUrl(text) {
    return /^(https?:\/\/|www\.)/i.test((text || "").trim());
}

function normalizeUrl(text) {
    const t = (text || "").trim();
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function formatRefHtml(refLink, extraClass = "") {
    const clean = (refLink || "").trim();
    if (!clean) return "";
    const cls = extraClass ? `ref-line ${extraClass}` : "ref-line";
    if (isUrl(clean)) {
        const href = normalizeUrl(clean);
        return `<div class="${cls}" title="${esc(clean)}">Reference: <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a></div>`;
    }
    return `<div class="${cls}" title="${esc(clean)}">Reference: ${esc(clean)}</div>`;
}

function truncateSingleLineText(text, maxChars = 55) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (clean.length <= maxChars) return clean;
    return clean.slice(0, maxChars - 3) + "...";
}

function formatNowDate() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatDateOnly(val) {
    const s = String(val || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const p = s.slice(0, 10).split("-");
        return `${p[2]}/${p[1]}/${p[0]}`;
    }
    if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return s.slice(0, 10);
    return s;
}

function toIsoDate(val) {
    const s = String(val || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
        const p = s.slice(0, 10).split("/");
        return `${p[2]}-${p[1]}-${p[0]}`;
    }
    return "";
}

function parseDateSortable(val) {
    const iso = toIsoDate(val);
    return iso ? iso : "9999-99-99";
}

function buildUnitOptions(selectedUnit) {
    const curr = (selectedUnit || "Piece").trim();
    const units = [...DEFAULT_UNITS];
    if (curr && !units.some(u => u.toLowerCase() === curr.toLowerCase())) units.unshift(curr);
    let html = units.map(u => {
        const sel = u.toLowerCase() === curr.toLowerCase() ? "selected" : "";
        return `<option value="${esc(u)}" ${sel}>${esc(u)}</option>`;
    }).join('');
    html += `<option value="_NEW_">+ Add</option>`;
    return html;
}

function buildSubUnitOptions(selectedSubUnit, disabledFlag = false) {
    if (disabledFlag) return `<option value="" selected>-</option>`;
    const curr = (selectedSubUnit || "Piece").trim();
    const units = [...DEFAULT_SUB_UNITS];
    if (curr && !units.some(u => u.toLowerCase() === curr.toLowerCase())) units.unshift(curr);
    let html = units.map(u => {
        const sel = u.toLowerCase() === curr.toLowerCase() ? "selected" : "";
        return `<option value="${esc(u)}" ${sel}>${esc(u)}</option>`;
    }).join('');
    html += `<option value="_NEW_">+ Add</option>`;
    return html;
}

async function apiPost(payload) {
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

// -------------------------------------------------------------
// FACULTY ADDRESS HELPERS
// -------------------------------------------------------------
function parseFacultyAddress(raw) {
    if (!raw) return null;
    try {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (obj && (obj.fullName || obj.department || obj.email || obj.phone)) return obj;
    } catch (e) {}
    return null;
}

function getEffectiveFacultyAddress() {
    const meta = getCurrentListMeta();
    const fromMeta = meta ? parseFacultyAddress(meta.facultyAddress) : null;
    if (fromMeta) return fromMeta;
    const fromLatest = parseFacultyAddress(latestInheritedFacultyAddress);
    return fromLatest || { ...DEFAULT_FACULTY_ADDRESS };
}

function isFacultyAddressValid(addr) {
    return !!(addr && addr.fullName && addr.fullName.trim() && (addr.department || addr.email || addr.phone));
}

function formatFacultyAddressLines(addr) {
    if (!addr) return [];
    const lines = [];
    if (addr.fullName) lines.push(addr.fullName);
    if (addr.designation) lines.push(addr.designation);
    if (addr.department) lines.push(addr.department);
    const locParts = [];
    if (addr.room) locParts.push(`Room No. ${addr.room}`);
    if (addr.building) locParts.push(addr.building);
    if (locParts.length) lines.push(locParts.join(", "));
    const contactParts = [];
    if (addr.email) contactParts.push(`Mail: ${addr.email}`);
    if (addr.phone) contactParts.push(`Phone: ${addr.phone}`);
    if (contactParts.length) lines.push(contactParts.join(", "));
    return lines;
}

// -------------------------------------------------------------
// AUTHENTICATION
// -------------------------------------------------------------
const savedUser = localStorage.getItem("labPortalUser") || sessionStorage.getItem("user");
if (savedUser) {
    USER = JSON.parse(savedUser);
    localStorage.setItem("labPortalUser", JSON.stringify(USER));
    showApp();
}

async function verifyLogin() {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    const btn = document.getElementById('loginBtn');
    const err = document.getElementById('loginError');
    if (!u || !p) return;

    btn.innerText = "Verifying...";
    btn.disabled = true;
    err.style.display = 'none';
    try {
        const data = await apiPost({ action: "login", username: u, password: p });
        if (data.status === "success") {
            USER = { username: u, role: data.role };
            localStorage.setItem("labPortalUser", JSON.stringify(USER));
            sessionStorage.setItem("user", JSON.stringify(USER));
            showApp();
        } else {
            err.innerText = data.message || "Invalid credentials.";
            err.style.display = 'block';
        }
    } catch (e) {
        err.innerText = "Connection error.";
        err.style.display = 'block';
    } finally {
        btn.innerText = "Login";
        btn.disabled = false;
    }
}

function logout() {
    localStorage.removeItem("labPortalUser");
    sessionStorage.removeItem("user");
    location.reload();
}

function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'block';
    document.getElementById('uiUsername').innerText = USER.username;
    document.getElementById('uiRole').innerText = USER.role;

    if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
        document.getElementById('btnUsers').style.display = "inline-block";
    }
    fetchInitData();
}

function getCurrentListMeta() {
    const val = document.getElementById('listSelector').value;
    return activeLists.find(l => l.name === val) || null;
}

function isCurrentListClosed() {
    const meta = getCurrentListMeta();
    return meta && meta.status === "Closed";
}

async function fetchInitData() {
    try {
        const data = await apiPost({ action: "getInit", username: USER.username, role: USER.role });
        if (data.status === "success") {
            productDB = data.products || {};
            activeLists = data.lists || [];
            vendorDB = data.vendors || [];
            latestInheritedBudget = data.latestBudget || 0;
            latestInheritedFacultyAddress = data.latestFacultyAddress || JSON.stringify(DEFAULT_FACULTY_ADDRESS);
            globalAlerts = data.alerts || { unacquired: [], lowStock: [] };
            populateListDropdown();
        }
    } catch (e) {
        alert("Failed to fetch initial data.");
    }
}

function populateListDropdown() {
    const sel = document.getElementById('listSelector');
    sel.innerHTML = '<option value="" disabled selected>Select a List...</option>';
    activeLists.forEach(l => {
        const label = l.status === "Closed" ? `${l.name} [Closed]` : l.name;
        sel.innerHTML += `<option value="${esc(l.name)}">${esc(label)}</option>`;
    });
    sel.innerHTML += `<option value="_NEW_" class="text-primary fw-bold">+ Create New List</option>`;

    const curr = sel.getAttribute('data-curr');
    if (curr && activeLists.find(x => x.name === curr)) {
        sel.value = curr;
        handleListChange();
    } else if (activeLists.length > 0) {
        sel.value = activeLists[0].name;
        handleListChange();
    }
}

async function handleListChange() {
    const val = document.getElementById('listSelector').value;
    document.getElementById('listSelector').setAttribute('data-curr', val);
    collapsedGroups = { acquired: false, partly: false, toAcquire: false };

    if (val === "_NEW_") {
        const today = new Date().toISOString().split('T')[0];
        let newName = prompt("Enter new list name:", today);
        if (newName) {
            const res = await apiPost({
                action: "manageList", subAction: "create",
                listName: newName, username: USER.username,
                inheritedBudget: latestInheritedBudget,
                inheritedFacultyAddress: latestInheritedFacultyAddress || JSON.stringify(DEFAULT_FACULTY_ADDRESS)
            });
            if (res.status === "error") return alert(res.message);
            document.getElementById('listSelector').setAttribute('data-curr', newName);
            await fetchInitData();
            const activeAlerts = getRelevantAlertsForCurrentList();
            if (activeAlerts.unacquired.length > 0 || activeAlerts.lowStock.length > 0) {
                openAlertsModal();
            }
        } else {
            document.getElementById('listSelector').value = activeLists[0] ? activeLists[0].name : "";
        }
        return;
    }

    document.getElementById('tableBody').innerHTML = '<tr><td colspan="28" class="text-center">Loading...</td></tr>';
    const listMeta = getCurrentListMeta();
    if (listMeta) {
        document.getElementById('budgetInHand').value = listMeta.budget;
        try {
            const rawExp = listMeta.additionalExpenses ? JSON.parse(listMeta.additionalExpenses) : [];
            nonItemExpenses = Array.isArray(rawExp) ? rawExp : [];
        } catch (e) {
            nonItemExpenses = [];
        }
    } else {
        nonItemExpenses = [];
    }

    // Show Created Date & Time badge right after Alerts button
    const createdBadge = document.getElementById('listCreatedBadge');
    const createdText = document.getElementById('listCreatedText');
    if (listMeta && listMeta.createdDate) {
        createdText.innerText = listMeta.createdDate;
        createdBadge.style.display = 'inline-block';
    } else {
        createdBadge.style.display = 'none';
    }

    // Only the first chronological list's Assigned Budget is editable; later lists auto-inherit
    const canEditBudget = (USER.role === "Admin" || USER.role === "Lab Supervisor") && (!listMeta || listMeta.isFirstList);
    document.getElementById('budgetInHand').disabled = !canEditBudget;
    document.getElementById('btnUpdateBudget').style.display = canEditBudget ? 'block' : 'none';

    updateClosedUI();
    renderNonItemExpenses();

    try {
        const payload = await apiPost({ action: "getListData", listName: val });
        if (Array.isArray(payload)) {
            currentListData = payload;
            activeVendors = [];
        } else {
            let fetchedHeaders = payload.headers || BASE_HEADERS;
            activeVendors = fetchedHeaders.filter(h => !BASE_HEADERS.includes(h));
            currentListData = payload.rows || [];
        }
        currentListData.forEach(r => { r._isEditing = false; });
        renderTable();
        updateAlertBadge();
    } catch (e) {
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="28" class="text-danger text-center">Load failed.</td></tr>';
    }
}

function updateClosedUI() {
    const closed = isCurrentListClosed();
    document.getElementById('listStatusBadge').style.display = closed ? 'inline-block' : 'none';
    document.getElementById('btnAddRow').disabled = closed;
    document.getElementById('btnAddVendor').disabled = closed;
    document.getElementById('btnOptimize').disabled = closed;
    document.getElementById('btnSaveEdits').disabled = closed;
    document.getElementById('btnAddNonItemBill').disabled = closed;
    document.getElementById('btnSaveNonItemBills').disabled = closed;
    document.getElementById('btnCloseList').style.display = closed ? 'none' : 'inline-block';
    document.getElementById('btnReopenList').style.display = (closed && (USER.role === "Admin" || USER.role === "Lab Supervisor")) ? 'inline-block' : 'none';
}

// -------------------------------------------------------------
// P / Q / B / D STATUS ENGINE
// -------------------------------------------------------------
function computeRowPQBD(row) {
    const billNo = String(row['Bill Ref No'] || '').trim();
    const billDate = String(row['Bill Date'] || '').trim();
    const isBilled = !!(billNo && billDate);

    const reqQty = parseFloat(row['Required Quantity']) || 0;
    const acqQty = parseFloat(row['Acquired Qty']) || 0;
    const pieceFlag = isPieceUnit(row['Unit']);
    const reqSub = pieceFlag ? 1 : (parseFloat(row['Sub Quantity']) || 1);
    const acqSub = pieceFlag ? 1 : (parseFloat(row['Acquired Sub Qty']) || reqSub);

    const isDelivered = reqQty > 0 && (acqQty * acqSub) >= (reqQty * reqSub);

    let manual = String(row['Item Status'] || 'P').trim().toUpperCase();
    if (manual !== 'P' && manual !== 'Q') manual = 'P';

    return {
        P: !isBilled && !isDelivered && manual === 'P',
        Q: !isBilled && !isDelivered && manual === 'Q',
        B: isBilled,
        D: isDelivered,
        pqDisabled: isBilled || isDelivered
    };
}

function setManualPQ(i, val) {
    if (isCurrentListClosed()) return;
    const st = computeRowPQBD(currentListData[i]);
    if (st.pqDisabled) return;
    currentListData[i]['Item Status'] = val;
    renderTable();
}

function renderPQBDHtml(row, i, closed) {
    const st = computeRowPQBD(row);
    const disPQ = (closed || st.pqDisabled) ? 'disabled' : '';
    return `<div class="pqbd-group" onclick="event.stopPropagation()">
        <button type="button" class="pqbd-btn ${st.P ? 'active-P' : ''}" title="Pending" onclick="setManualPQ(${i}, 'P')" ${disPQ}>P</button>
        <button type="button" class="pqbd-btn ${st.Q ? 'active-Q' : ''}" title="Quote Generated" onclick="setManualPQ(${i}, 'Q')" ${disPQ}>Q</button>
        <button type="button" class="pqbd-btn ${st.B ? 'active-B' : ''}" title="Billed (Auto when Bill No &amp; Bill Date exist)" disabled>B</button>
        <button type="button" class="pqbd-btn ${st.D ? 'active-D' : ''}" title="Delivered (Auto when Acquired Qty × Sub Qty ≥ Required Qty × Sub Qty)" disabled>D</button>
    </div>`;
}

// -------------------------------------------------------------
// NON-ITEM BILLS (ADDITIONAL EXPENSES) BELOW TABLE
// -------------------------------------------------------------
function renderNonItemExpenses() {
    const tbody = document.getElementById('nonItemExpensesBody');
    if (!tbody) return;
    const closed = isCurrentListClosed();

    if (nonItemExpenses.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted small fst-italic py-2">No non-item bills added yet. Click "+ Add Non-Item Bill" to record GST, shipping, or marketplace fees.</td></tr>`;
        calcTotal();
        return;
    }

    tbody.innerHTML = nonItemExpenses.map((exp, idx) => `
        <tr>
            <td><input type="text" class="form-control form-control-sm" placeholder="e.g., Marketplace fee, GST, Shipping" value="${esc(exp.label || '')}" oninput="nonItemExpenses[${idx}].label = this.value" ${closed ? 'disabled' : ''}></td>
            <td><input type="text" class="form-control form-control-sm" placeholder="Vendor / Payee" value="${esc(exp.vendor || '')}" oninput="nonItemExpenses[${idx}].vendor = this.value; renderVendorTotals();" ${closed ? 'disabled' : ''}></td>
            <td><input type="text" class="form-control form-control-sm" placeholder="Invoice #" value="${esc(exp.invoiceNo || '')}" oninput="nonItemExpenses[${idx}].invoiceNo = this.value" ${closed ? 'disabled' : ''}></td>
            <td><input type="date" class="form-control form-control-sm" value="${esc(toIsoDate(exp.invoiceDate))}" onchange="nonItemExpenses[${idx}].invoiceDate = formatDateOnly(this.value)" ${closed ? 'disabled' : ''}></td>
            <td><input type="number" step="0.01" min="0" class="form-control form-control-sm" placeholder="0.00" value="${esc(exp.amount ?? '')}" oninput="nonItemExpenses[${idx}].amount = this.value; calcTotal();" ${closed ? 'disabled' : ''}></td>
            <td><input type="text" class="form-control form-control-sm" placeholder="Remarks (optional)" value="${esc(exp.remarks || '')}" oninput="nonItemExpenses[${idx}].remarks = this.value" ${closed ? 'disabled' : ''}></td>
            <td class="text-center">
                <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removeNonItemExpenseRow(${idx})" title="Remove" ${closed ? 'disabled' : ''}><i class="bi bi-trash"></i></button>
            </td>
        </tr>
    `).join('');
    calcTotal();
}

function addNonItemExpenseRow() {
    if (isCurrentListClosed()) return;
    nonItemExpenses.push({ label: "", vendor: "", invoiceNo: "", invoiceDate: "", amount: "", remarks: "" });
    renderNonItemExpenses();
}

function removeNonItemExpenseRow(idx) {
    if (isCurrentListClosed()) return;
    nonItemExpenses.splice(idx, 1);
    renderNonItemExpenses();
}

async function saveNonItemExpenses(showAlert = false) {
    const listName = document.getElementById('listSelector').value;
    if (!listName) return;

    const clean = nonItemExpenses
        .map(e => ({
            label: (e.label || "").trim(),
            vendor: (e.vendor || "").trim(),
            invoiceNo: (e.invoiceNo || "").trim(),
            invoiceDate: formatDateOnly(e.invoiceDate),
            amount: e.amount !== "" && e.amount !== undefined ? (parseFloat(e.amount) || 0) : 0,
            remarks: (e.remarks || "").trim()
        }))
        .filter(e => e.label || e.invoiceNo || e.amount > 0);

    const btn = document.getElementById('btnSaveNonItemBills');
    if (btn && showAlert) { btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...'; btn.disabled = true; }

    try {
        await apiPost({
            action: "manageList", subAction: "updateMeta",
            listName: listName, additionalExpenses: clean
        });
        nonItemExpenses = clean;
        const initRes = await apiPost({ action: "getInit", username: USER.username, role: USER.role });
        if (initRes.status === "success") {
            activeLists = initRes.lists || activeLists;
            latestInheritedBudget = initRes.latestBudget || latestInheritedBudget;
        }
        renderNonItemExpenses();
        if (showAlert) alert("Additional expenses saved to Google Sheets.");
    } catch (e) {
        if (showAlert) alert("Failed to save additional expenses.");
    } finally {
        if (btn && showAlert) { btn.innerHTML = '<i class="bi bi-floppy"></i> Save Expenses'; btn.disabled = false; }
    }
}

// -------------------------------------------------------------
// ALERTS ENGINE
// -------------------------------------------------------------
function getRelevantAlertsForCurrentList() {
    const currList = document.getElementById('listSelector').value;
    const meta = getCurrentListMeta();
    const dismissed = (meta && meta.dismissedAlerts) ? meta.dismissedAlerts : [];

    const unacquired = (globalAlerts.unacquired || []).filter(a =>
        a.sourceList !== currList && !dismissed.includes(a.alertKey)
    );
    const lowStock = (globalAlerts.lowStock || []).filter(a =>
        a.reqStatus !== "PLACED" && !dismissed.includes(a.alertKey)
    );
    return { unacquired, lowStock };
}

function updateAlertBadge() {
    const btn = document.getElementById('btnListAlerts');
    if (isCurrentListClosed()) { btn.style.display = 'none'; return; }
    const { unacquired, lowStock } = getRelevantAlertsForCurrentList();
    const totalCount = unacquired.length + lowStock.length;
    if (totalCount > 0) {
        document.getElementById('alertCount').innerText = totalCount;
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
}

function openAlertsModal() {
    renderAlertsModal();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('alertsModal')).show();
}

function renderAlertsModal() {
    const tbody = document.getElementById('alertsBody');
    const { unacquired, lowStock } = getRelevantAlertsForCurrentList();
    let html = "";

    unacquired.forEach((a, idx) => {
        const subInfo = (!isPieceUnit(a.unit) && a.subQty) ? `<br><span class="text-muted">${esc(a.subQty)} ${esc(a.subUnit || 'Piece')}</span>` : '';
        html += `<tr class="alert-row-unacq">
            <td><span class="badge bg-danger">Unacquired</span></td>
            <td><div class="fw-bold">${esc(a.item)}</div><div class="small text-muted">${esc(a.specs)}</div></td>
            <td class="small">From list: <strong>${esc(a.sourceList)}</strong><br>Req: ${a.reqQty} | Acq: ${a.acqQty} | <span class="text-danger fw-bold">Pending: ${a.shortfall}</span></td>
            <td class="small">${esc(a.unit)}${subInfo}</td>
            <td><input type="number" id="alertUnacqQty_${idx}" class="form-control form-control-sm" min="1" value="${a.shortfall}"></td>
            <td class="text-center text-nowrap">
                <button class="btn btn-sm btn-success py-0 px-2" onclick="addAlertItemToList('unacq', ${idx})"><i class="bi bi-plus-circle"></i> Add</button>
                <button class="btn btn-sm btn-outline-secondary py-0 px-2 ms-1" onclick="dismissAlertItem('${esc(a.alertKey)}')">Ignore</button>
            </td>
        </tr>`;
    });

    lowStock.forEach((a, idx) => {
        const remText = a.subPerUnit > 1 ? `${a.totalBase} ${a.subLabel || 'Piece'}` : `${a.totalBase} ${a.unit}`;
        const subInfo = (!isPieceUnit(a.unit) && a.subQty) ? `<br><span class="text-muted">${esc(a.subQty)} ${esc(a.subUnit || 'Piece')}</span>` : '';
        html += `<tr class="alert-row-lowstk">
            <td><span class="badge bg-warning text-dark">Low Stock</span></td>
            <td><div class="fw-bold">${esc(a.item)}</div><div class="small text-muted">${esc(a.specs)}</div></td>
            <td class="small">Stock: <strong class="text-danger">${esc(remText)}</strong> | Threshold: <strong>${a.threshold}</strong><br>Prev Acquired Qty: ${a.prevAcqQty}</td>
            <td class="small">${esc(a.unit)}${subInfo}</td>
            <td><input type="number" id="alertLowQty_${idx}" class="form-control form-control-sm" min="1" value="${a.prevAcqQty || 1}"></td>
            <td class="text-center text-nowrap">
                <button class="btn btn-sm btn-primary py-0 px-2" onclick="addAlertItemToList('lowstk', ${idx})"><i class="bi bi-plus-circle"></i> Add</button>
                <button class="btn btn-sm btn-outline-secondary py-0 px-2 ms-1" onclick="dismissAlertItem('${esc(a.alertKey)}')">Ignore</button>
            </td>
        </tr>`;
    });

    if (!html) html = `<tr><td colspan="6" class="text-center text-muted p-4">No pending alerts for this list.</td></tr>`;
    tbody.innerHTML = html;
}

async function addAlertItemToList(type, idx) {
    if (isCurrentListClosed()) return alert("This list is closed.");
    const { unacquired, lowStock } = getRelevantAlertsForCurrentList();
    const item = type === 'unacq' ? unacquired[idx] : lowStock[idx];
    if (!item) return;

    const qtyInput = document.getElementById(type === 'unacq' ? `alertUnacqQty_${idx}` : `alertLowQty_${idx}`);
    const qtyToAdd = parseFloat(qtyInput.value) || 1;

    const existingIdx = currentListData.findIndex(r =>
        !r._isEditing &&
        String(r['Item'] || '').trim().toLowerCase() === item.item.trim().toLowerCase() &&
        String(r['Item Specs'] || '').trim().toLowerCase() === item.specs.trim().toLowerCase()
    );

    if (existingIdx > -1) {
        currentListData[existingIdx]['Required Quantity'] = (parseFloat(currentListData[existingIdx]['Required Quantity']) || 0) + qtyToAdd;
    } else {
        collapsedGroups.toAcquire = false;
        const pieceFlag = isPieceUnit(item.unit);
        let newRow = {
            'Item': item.item, 'Item Specs': item.specs || '', 'Reference Link': item.refLink || '',
            'Preferred Company': item.prefComp || 'Any', 'Product Code': item.code || '',
            'Required Quantity': qtyToAdd, 'Unit': item.unit || 'Piece',
            'Sub Quantity': pieceFlag ? '' : (item.subQty || ''), 'Sub Unit': pieceFlag ? '' : (item.subUnit || 'Piece'),
            'Acquired Qty': 0, 'Acquired Sub Qty': '', 'Acquired Sub Unit': '',
            'Estimated Price': item.estPrice || '', 'Selected Vendor': '', 'Total Estimate': '',
            'Bill Ref No': '', 'Bill Date': '', 'Bill Amount': '', 'Date of Procurement': '', 'Item Status': 'P',
            _isEditing: false
        };
        activeVendors.forEach(v => newRow[v] = "");
        currentListData.push(newRow);
    }

    await apiPost({ action: "manageList", subAction: "dismissAlert", listName: document.getElementById('listSelector').value, alertKey: item.alertKey });
    if (type === 'lowstk' && item.stockId) await apiPost({ action: "markStockReqPlaced", stockId: item.stockId });

    await syncTableToBackend();
    renderAlertsModal();
    updateAlertBadge();
}

async function dismissAlertItem(alertKey) {
    const lName = document.getElementById('listSelector').value;
    await apiPost({ action: "manageList", subAction: "dismissAlert", listName: lName, alertKey: alertKey });
    const meta = getCurrentListMeta();
    if (meta) {
        if (!meta.dismissedAlerts) meta.dismissedAlerts = [];
        meta.dismissedAlerts.push(alertKey);
    }
    renderAlertsModal();
    updateAlertBadge();
}

// -------------------------------------------------------------
// CLOSE / REOPEN REQUIREMENT LIST
// -------------------------------------------------------------
async function closeCurrentList() {
    const lName = document.getElementById('listSelector').value;
    if (!lName) return;
    const cleanRows = currentListData.filter(r => !r._isEditing);
    const pending = cleanRows.filter(r => (parseFloat(r['Acquired Qty']) || 0) < (parseFloat(r['Required Quantity']) || 0));

    if (pending.length > 0) {
        const names = pending.slice(0, 6).map(r => `• ${r['Item']} (Req: ${r['Required Quantity']}, Acq: ${r['Acquired Qty'] || 0})`).join('\n');
        if (!confirm(`${pending.length} item(s) are not yet fully acquired:\n\n${names}${pending.length > 6 ? '\n...' : ''}\n\nProceed to close "${lName}"?`)) return;
    } else {
        if (!confirm(`All items in "${lName}" are acquired. Close this requirement list now?`)) return;
    }
    await apiPost({ action: "manageList", subAction: "close", listName: lName });
    await fetchInitData();
}

async function reopenCurrentList() {
    const lName = document.getElementById('listSelector').value;
    if (!lName) return;
    if (!confirm(`Reopen list "${lName}" for editing?`)) return;
    await apiPost({ action: "manageList", subAction: "reopen", listName: lName });
    await fetchInitData();
}

// -------------------------------------------------------------
// MAIN TABLE RENDERING & BILL-DRIVEN TOTAL ESTIMATE
// -------------------------------------------------------------
function toggleCode(elem) {
    const tr = elem.closest('tr');
    const codeInput = tr.querySelector('.pCode');
    const val = elem.value.trim().toLowerCase();
    if (val === 'any' || val === '') { codeInput.value = ''; codeInput.disabled = true; }
    else codeInput.disabled = false;
}

function getRowGroupKey(row) {
    const req = parseFloat(row['Required Quantity']) || 0;
    const acq = parseFloat(row['Acquired Qty']) || 0;
    if (req > 0 && acq >= req) return 'acquired';
    if (acq > 0 && acq < req) return 'partly';
    return 'toAcquire';
}

function toggleGroup(groupKey) {
    collapsedGroups[groupKey] = !collapsedGroups[groupKey];
    renderTable();
}

function hasCompleteBill(row) {
    const billNo = String(row['Bill Ref No'] || '').trim();
    const billDate = String(row['Bill Date'] || '').trim();
    const billAmt = parseFloat(row['Bill Amount']);
    return !!(billNo && billDate && !isNaN(billAmt) && billAmt > 0);
}

function recalculateRowTotalEstimate(row) {
    if (hasCompleteBill(row)) {
        row['Total Estimate'] = parseFloat(row['Bill Amount']).toFixed(2);
        return;
    }
    const sv = row['Selected Vendor'];
    if (sv && row[sv] && row[sv] !== 'NA') {
        const price = parseFloat(row[sv]) || 0;
        const qty = parseFloat(row['Required Quantity']) || 0;
        row['Total Estimate'] = (price * qty).toFixed(2);
    } else {
        row['Total Estimate'] = '';
    }
}

function getRowEffectiveAmount(row) {
    if (hasCompleteBill(row)) return parseFloat(row['Bill Amount']);
    return parseFloat(row['Total Estimate']) || 0;
}

function renderTable() {
    const closed = isCurrentListClosed();
    const thead = document.getElementById('tableHead');
    let vendorHeaders = activeVendors.map(v => `<th class="text-info">${esc(v)}</th>`).join('');
    thead.innerHTML = `<tr>
        <th class="sticky-col-0">SL No</th>
        <th class="sticky-col-1 text-center">Action</th>
        <th class="sticky-col-2">Item</th>
        <th class="sticky-col-3 specs-col">Item Specs</th>
        <th>Preferred Company</th>
        <th>Product Code</th>
        <th>Req Qty</th>
        <th>Unit</th>
        <th>Sub Qty</th>
        <th>Sub Unit</th>
        <th class="text-warning">Acq Qty</th>
        <th class="text-warning">Acq Sub Qty</th>
        <th class="text-warning">Acq Sub Unit</th>
        <th>Est Price</th>
        <th>Selected Vendor</th>
        <th class="text-success">Total Estimate</th>
        <th class="text-info">Bill Ref No</th>
        <th class="text-info">Bill Date</th>
        <th class="text-info">Bill Amount</th>
        <th>Proc. Date</th>
        ${vendorHeaders}
    </tr>`;

    const tbody = document.getElementById('tableBody');
    let acquiredCount = 0;
    let savedCount = 0;

    const buckets = { toAcquire: [], acquired: [], partly: [] };
    currentListData.forEach((row, i) => {
        const reqQty = parseFloat(row['Required Quantity']) || 0;
        const acqQty = parseFloat(row['Acquired Qty']) || 0;
        if (!row._isEditing) {
            savedCount++;
            if (reqQty > 0 && acqQty >= reqQty) acquiredCount++;
        }
        const key = row._isNew ? 'toAcquire' : getRowGroupKey(row);
        buckets[key].push({ row, i });
    });

    const groupDefs = [
        { key: 'toAcquire', label: 'Items to Acquire',      css: 'group-pending' },
        { key: 'acquired',  label: 'Acquired Items',        css: 'group-acquired' },
        { key: 'partly',    label: 'Partly Acquired Items', css: 'group-partly' }
    ];

    const showGroupHeaders = (buckets.acquired.length > 0 || buckets.partly.length > 0);
    const totalCols = 20 + activeVendors.length;
    let rowsHTML = "";

    groupDefs.forEach(g => {
        const items = buckets[g.key];
        if (items.length === 0) return;

        const isCollapsed = showGroupHeaders && collapsedGroups[g.key];
        if (showGroupHeaders) {
            const icon = isCollapsed ? 'bi-caret-right-fill' : 'bi-caret-down-fill';
            rowsHTML += `<tr class="group-header-row ${g.css}" data-group-header="${g.key}" onclick="toggleGroup('${g.key}')">
                <td colspan="${totalCols}">
                    <span class="group-header-sticky"><i class="bi ${icon}"></i> ${g.label} <span class="badge bg-dark">${items.length}</span></span>
                </td>
            </tr>`;
        }
        if (isCollapsed) return;

        items.forEach(({ row, i }, displayIdx) => {
            const reqQty = parseFloat(row['Required Quantity']) || 0;
            const acqQty = parseFloat(row['Acquired Qty']) || 0;
            const totalEst = getRowEffectiveAmount(row);
            const unitVal = row['Unit'] || 'Piece';
            const pieceFlag = isPieceUnit(unitVal);
            const subUnitVal = pieceFlag ? '' : (row['Sub Unit'] || 'Piece');

            if (!row._isEditing) {
                const pqbd = computeRowPQBD(row);
                const isLocked = (g.key === 'acquired') || pqbd.D;
                const isVendorLocked = isLocked || pqbd.B;
                let selVendor = row['Selected Vendor'] || '';
                let acqBadgeClass = acqQty >= reqQty && reqQty > 0 ? 'text-success fw-bold' : (acqQty > 0 ? 'text-warning fw-bold' : 'text-muted');

                let vendorCells = activeVendors.map(v => {
                    let vPrice = row[v] ?? '';
                    let isNA = vPrice === 'NA';
                    if (isVendorLocked) {
                        let txt = isNA ? '<span class="text-muted">NA</span>' : (vPrice !== '' ? `₹${parseFloat(vPrice).toFixed(2)}` : '-');
                        let cls = (selVendor === v) ? 'fw-bold text-primary' : 'text-muted';
                        return `<td class="vendor-cell text-center ${cls}">${txt}</td>`;
                    }
                    let isChecked = (selVendor === v) ? 'checked' : '';
                    let valToDisplay = isNA ? '' : vPrice;
                    let safeV = v.replace(/'/g, "\\'");
                    return `<td class="vendor-cell">
                        <div class="d-flex align-items-center gap-1">
                            <input type="radio" name="vSelect_${i}" value="${esc(v)}" onchange="selectVendor(${i}, '${safeV}')" ${isChecked} ${(isNA || closed) ? 'disabled' : ''}>
                            <input type="number" step="0.01" class="form-control form-control-sm" style="width: 75px;" placeholder="Price" value="${esc(valToDisplay)}" onchange="updateVendorPrice(${i}, '${safeV}', this.value)" ${(isNA || closed) ? 'disabled' : ''}>
                            <button class="btn btn-sm btn-outline-danger py-0 px-1 fw-bold" onclick="toggleVendorNA(${i}, '${safeV}')" title="Mark NA" ${closed ? 'disabled' : ''}>🚫</button>
                        </div>
                    </td>`;
                }).join('');

                const actionCellHtml = isLocked
                    ? `<span class="badge bg-success-subtle text-success border border-success-subtle" title="Completely Acquired / Delivered (Locked)"><i class="bi bi-lock-fill"></i> Acquired</span>`
                    : `<button class="btn btn-sm btn-outline-primary py-0 px-1" onclick="editRow(${i})" title="Edit" ${closed ? 'disabled' : ''}><i class="bi bi-pencil-square"></i></button>
                       <button class="btn btn-sm btn-outline-secondary py-0 px-1 ms-1" onclick="duplicateRow(${i})" title="Duplicate Row" ${closed ? 'disabled' : ''}><i class="bi bi-copy"></i></button>
                       <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteRow(${i})" title="Delete" ${closed ? 'disabled' : ''}><i class="bi bi-trash"></i></button>`;

                const reqQtyCell = isLocked
                    ? `<td class="text-center fw-semibold">${esc(row['Required Quantity'])}</td>`
                    : `<td><input type="number" class="form-control form-control-sm number-box" value="${esc(row['Required Quantity'])}" min="1" onchange="updateLiveRow(${i}, 'Required Quantity', this.value)" ${closed ? 'disabled' : ''}></td>`;

                const unitCell = isLocked
                    ? `<td class="text-center">${esc(unitVal)}</td>`
                    : `<td><select class="form-select form-select-sm number-box" onchange="updateLiveUnit(${i}, this)" ${closed ? 'disabled' : ''}>${buildUnitOptions(unitVal)}</select></td>`;

                const subQtyCell = isLocked
                    ? `<td class="text-center">${pieceFlag ? '-' : esc(row['Sub Quantity'] || '-')}</td>`
                    : `<td><input type="number" step="any" min="0" id="liveSubQty_${i}" class="form-control form-control-sm number-box" value="${pieceFlag ? '' : esc(row['Sub Quantity'])}" placeholder="${pieceFlag ? '-' : '100'}" onchange="updateLiveRow(${i}, 'Sub Quantity', this.value)" ${(pieceFlag || closed) ? 'disabled' : ''}></td>`;

                const subUnitCell = isLocked
                    ? `<td class="text-center">${pieceFlag ? '-' : esc(subUnitVal || '-')}</td>`
                    : `<td><select id="liveSubUnit_${i}" class="form-select form-select-sm sub-unit-box" onchange="updateLiveSubUnit(${i}, this)" ${(pieceFlag || closed) ? 'disabled' : ''}>${buildSubUnitOptions(subUnitVal, pieceFlag)}</select></td>`;

                const estPriceCell = isLocked
                    ? `<td class="text-center">${row['Estimated Price'] !== '' && row['Estimated Price'] !== undefined ? '₹' + esc(row['Estimated Price']) : '-'}</td>`
                    : `<td><input type="number" step="0.01" class="form-control form-control-sm number-box" value="${esc(row['Estimated Price'])}" onchange="updateLiveRow(${i}, 'Estimated Price', this.value)" ${closed ? 'disabled' : ''}></td>`;

                const billRefVal = String(row['Bill Ref No'] || '').trim();
                const safeBillRef = billRefVal.replace(/'/g, "\\'");
                const viewBillBtn = billRefVal
                    ? `<button type="button" class="btn btn-sm btn-outline-primary py-0 px-1" onclick="viewRowBill('${safeBillRef}')" title="View Bill (${esc(billRefVal)})"><i class="bi bi-eye"></i></button>`
                    : '';

                const billRefCell = isLocked
                    ? `<td class="small text-nowrap"><div class="d-flex align-items-center justify-content-between gap-1"><span>${esc(billRefVal || '-')}</span>${viewBillBtn}</div></td>`
                    : `<td><div class="d-flex align-items-center gap-1"><input type="text" class="form-control form-control-sm bill-box" placeholder="Bill #" value="${esc(billRefVal)}" onchange="updateLiveBillField(${i}, 'Bill Ref No', this.value)" ${closed ? 'disabled' : ''}>${viewBillBtn}</div></td>`;

                const billDateCell = isLocked
                    ? `<td class="small text-nowrap text-center">${esc(formatDateOnly(row['Bill Date']) || '-')}</td>`
                    : `<td><input type="date" class="form-control form-control-sm bill-box" value="${esc(toIsoDate(row['Bill Date']))}" onchange="updateLiveBillField(${i}, 'Bill Date', formatDateOnly(this.value))" ${closed ? 'disabled' : ''}></td>`;

                const billAmtCell = isLocked
                    ? `<td class="small text-nowrap text-end">${row['Bill Amount'] !== '' && row['Bill Amount'] !== undefined ? '₹' + parseFloat(row['Bill Amount']).toFixed(2) : '-'}</td>`
                    : `<td><input type="number" step="0.01" class="form-control form-control-sm number-box" placeholder="₹" value="${esc(row['Bill Amount'] ?? '')}" onchange="updateLiveBillField(${i}, 'Bill Amount', this.value)" ${closed ? 'disabled' : ''}></td>`;

                rowsHTML += `<tr data-group="${g.key}">
                    <td class="sticky-col-0">${displayIdx + 1}</td>
                    <td class="sticky-col-1 text-center text-nowrap">${actionCellHtml}</td>
                    <td class="sticky-col-2">
                        <div class="fw-bold">${esc(row['Item'])}</div>
                        ${renderPQBDHtml(row, i, closed)}
                    </td>
                    <td class="sticky-col-3 specs-col text-wrap">
                        <div>${esc(row['Item Specs'])}</div>
                        ${formatRefHtml(row['Reference Link'])}
                    </td>
                    <td>${esc(row['Preferred Company'])}</td>
                    <td>${esc(row['Product Code'])}</td>
                    ${reqQtyCell}
                    ${unitCell}
                    ${subQtyCell}
                    ${subUnitCell}
                    <td class="text-center ${acqBadgeClass}">${acqQty || 0}</td>
                    <td class="text-center small text-muted">${esc(row['Acquired Sub Qty'] || '-')}</td>
                    <td class="text-center small text-muted">${esc(row['Acquired Sub Unit'] || '-')}</td>
                    ${estPriceCell}
                    <td class="fw-bold text-primary">${esc(selVendor)}</td>
                    <td class="fw-bold text-success" id="rowTotal_${i}">₹${totalEst.toFixed(2)}</td>
                    ${billRefCell}
                    ${billDateCell}
                    ${billAmtCell}
                    <td class="small text-nowrap">${esc(formatDateOnly(row['Date of Procurement']) || '-')}</td>
                    ${vendorCells}
                </tr>`;
            } else {
                let blankVendorCells = activeVendors.map(() => `<td class="text-muted small">Save row first</td>`).join('');
                let isAny = (row['Preferred Company'] || 'Any').trim().toLowerCase() === 'any';

                rowsHTML += `<tr id="editRow_${i}" class="table-warning" data-group="${g.key}">
                    <td class="sticky-col-0">${displayIdx + 1}</td>
                    <td class="sticky-col-1 text-center text-nowrap">
                        <button class="btn btn-sm btn-success py-0 px-1" onclick="saveRow(${i})" title="Save"><i class="bi bi-check-lg"></i></button>
                        <button class="btn btn-sm btn-danger py-0 px-1 ms-1" onclick="cancelRow(${i})" title="Cancel"><i class="bi bi-x-lg"></i></button>
                    </td>
                    <td class="sticky-col-2"><input type="text" class="form-control form-control-sm pItem fw-bold" value="${esc(row['Item'])}" list="itemList" onkeydown="handleEnter(event, this, ${i})" placeholder="Item Name"></td>
                    <td class="sticky-col-3 specs-col">
                        <input type="text" class="form-control form-control-sm pSpecs" value="${esc(row['Item Specs'])}" list="specsList" placeholder="Specs (Capacity...)" onkeydown="handleEnter(event, this, ${i})">
                        <input type="text" class="form-control form-control-sm pRefLink mt-1 fst-italic" style="font-size: 10pt;" value="${esc(row['Reference Link'])}" placeholder="Reference link (optional)...">
                    </td>
                    <td><input type="text" class="form-control form-control-sm pComp" value="${esc(row['Preferred Company'] || 'Any')}" list="compList" onchange="toggleCode(this)"></td>
                    <td><input type="text" class="form-control form-control-sm pCode" value="${esc(row['Product Code'])}" ${isAny ? 'disabled' : ''}></td>
                    <td><input type="number" class="form-control form-control-sm pQty number-box" value="${esc(row['Required Quantity'])}" min="1"></td>
                    <td><select class="form-select form-select-sm pUnit number-box" onchange="handleEditUnitChange(this)">${buildUnitOptions(unitVal)}</select></td>
                    <td><input type="number" step="any" min="0" class="form-control form-control-sm pSubQty number-box" value="${pieceFlag ? '' : esc(row['Sub Quantity'])}" placeholder="${pieceFlag ? '-' : '100'}" ${pieceFlag ? 'disabled' : ''}></td>
                    <td><select class="form-select form-select-sm pSubUnit sub-unit-box" onchange="handleEditSubUnitChange(this)" ${pieceFlag ? 'disabled' : ''}>${buildSubUnitOptions(subUnitVal, pieceFlag)}</select></td>
                    <td class="text-center text-muted small">${acqQty || 0}</td>
                    <td class="text-center text-muted small">${esc(row['Acquired Sub Qty'] || '-')}</td>
                    <td class="text-center text-muted small">${esc(row['Acquired Sub Unit'] || '-')}</td>
                    <td><input type="number" step="0.01" class="form-control form-control-sm pEstPrice number-box" value="${esc(row['Estimated Price'])}"></td>
                    <td colspan="6" class="text-muted small text-center">Save row first</td>
                    ${blankVendorCells}
                </tr>`;
            }
        });
    });

    tbody.innerHTML = rowsHTML;
    document.getElementById('listProgressSummary').innerText = savedCount > 0
        ? `Procurement Progress: ${acquiredCount} / ${savedCount} item(s) fully acquired`
        : '';
    calcTotal();
}

function updateLiveBillField(i, field, val) {
    currentListData[i][field] = val;
    recalculateRowTotalEstimate(currentListData[i]);
    renderTable();
}

function handleEditUnitChange(sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new unit type (e.g. Bottle, Vial, Pack):");
        if (u && u.trim()) { sel.add(new Option(u.trim(), u.trim()), sel.options[0]); sel.value = u.trim(); }
        else sel.value = "Piece";
    }
    toggleSubQtyInput(sel);
}

function handleEditSubUnitChange(sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new sub-unit type (e.g. Piece, mL, g, Pair):");
        if (u && u.trim()) { sel.add(new Option(u.trim(), u.trim()), sel.options[0]); sel.value = u.trim(); }
        else sel.value = "Piece";
    }
}

function toggleSubQtyInput(unitSel) {
    const tr = unitSel.closest('tr');
    if (!tr) return;
    const subInput = tr.querySelector('.pSubQty');
    const subUnitSel = tr.querySelector('.pSubUnit');
    if (!subInput || !subUnitSel) return;

    if (isPieceUnit(unitSel.value)) {
        subInput.value = ''; subInput.placeholder = '-'; subInput.disabled = true;
        subUnitSel.innerHTML = buildSubUnitOptions('', true); subUnitSel.disabled = true;
    } else {
        subInput.disabled = false; subInput.placeholder = '100';
        const prevSubUnit = subUnitSel.value || 'Piece';
        subUnitSel.disabled = false;
        subUnitSel.innerHTML = buildSubUnitOptions(prevSubUnit, false);
        if (!subInput.value) subInput.focus();
    }
}

// -------------------------------------------------------------
// LIVE UPDATE, COST BREAKDOWN & VENDOR TOTALS ENGINE
// -------------------------------------------------------------
function updateLiveRow(i, field, val) {
    currentListData[i][field] = val;
    if (field === 'Required Quantity') {
        recalculateRowTotalEstimate(currentListData[i]);
        renderTable();
    }
}

function updateLiveUnit(i, sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new unit type (e.g. Bottle, Vial, Pack):");
        if (u && u.trim()) currentListData[i]['Unit'] = u.trim();
        else { sel.value = currentListData[i]['Unit'] || 'Piece'; return; }
    } else {
        currentListData[i]['Unit'] = sel.value;
    }
    if (isPieceUnit(currentListData[i]['Unit'])) {
        currentListData[i]['Sub Quantity'] = ''; currentListData[i]['Sub Unit'] = '';
    } else if (!currentListData[i]['Sub Unit']) {
        currentListData[i]['Sub Unit'] = 'Piece';
    }
    renderTable();
}

function updateLiveSubUnit(i, sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new sub-unit type (e.g. Piece, mL, g, Pair):");
        if (u && u.trim()) currentListData[i]['Sub Unit'] = u.trim();
        else { sel.value = currentListData[i]['Sub Unit'] || 'Piece'; return; }
    } else {
        currentListData[i]['Sub Unit'] = sel.value;
    }
    renderTable();
}

function updateVendorPrice(i, v, val) {
    currentListData[i][v] = val;
    if (currentListData[i]['Selected Vendor'] === v && !hasCompleteBill(currentListData[i])) {
        recalculateRowTotalEstimate(currentListData[i]);
        const totalCell = document.getElementById(`rowTotal_${i}`);
        if (totalCell) totalCell.innerText = '₹' + getRowEffectiveAmount(currentListData[i]).toFixed(2);
    }
    calcTotal();
}

function selectVendor(i, v) {
    currentListData[i]['Selected Vendor'] = v;
    recalculateRowTotalEstimate(currentListData[i]);
    renderTable();
}

function calcTotal() {
    let billedItemTotal = 0;
    let estimatedItemTotal = 0;

    currentListData.forEach(r => {
        if (r._isEditing) return;
        estimatedItemTotal += getRowEffectiveAmount(r);
        if (hasCompleteBill(r)) {
            billedItemTotal += parseFloat(r['Bill Amount']) || 0;
        }
    });

    let nonItemTotal = nonItemExpenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    let totalSpent = billedItemTotal + nonItemTotal;
    let totalEstimated = estimatedItemTotal + nonItemTotal;

    const estEl = document.getElementById('estimatedTotalDisplay');
    const itemEl = document.getElementById('itemCostDisplay');
    const nonItemEl = document.getElementById('nonItemCostDisplay');

    if (estEl) estEl.innerText = '₹' + totalEstimated.toFixed(2);
    if (itemEl) itemEl.innerText = '₹' + billedItemTotal.toFixed(2);
    if (nonItemEl) nonItemEl.innerText = '₹' + nonItemTotal.toFixed(2);
    document.getElementById('totalBudget').innerText = '₹' + totalSpent.toFixed(2);

    calcBalance();
    renderVendorTotals();
}

function renderVendorTotals() {
    const container = document.getElementById('vendorTotalsContainer');
    if (!container) return;
    const totals = {};

    currentListData.forEach(r => {
        if (r._isEditing) return;
        const amt = getRowEffectiveAmount(r);
        if (amt <= 0) return;
        const v = String(r['Selected Vendor'] || 'Unassigned').trim() || 'Unassigned';
        totals[v] = (totals[v] || 0) + amt;
    });

    nonItemExpenses.forEach(e => {
        const amt = parseFloat(e.amount) || 0;
        if (amt <= 0) return;
        const v = String(e.vendor || 'Additional / General').trim() || 'Additional / General';
        totals[v] = (totals[v] || 0) + amt;
    });

    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        container.innerHTML = `<span class="text-muted small fst-italic">No vendor expenditures recorded yet.</span>`;
        return;
    }

    container.innerHTML = entries.map(([v, amt]) => `
        <div class="border rounded px-3 py-1 bg-light d-flex align-items-center gap-2">
            <span class="fw-semibold text-dark small">${esc(v)}</span>
            <span class="badge bg-success-subtle text-success border border-success-subtle fs-6">₹${amt.toFixed(2)}</span>
        </div>
    `).join('');
}

function calcBalance() {
    const t = parseFloat(document.getElementById('totalBudget').innerText.replace('₹', '')) || 0;
    const h = parseFloat(document.getElementById('budgetInHand').value) || 0;
    const bal = h - t;
    document.getElementById('budgetBalance').innerHTML = bal < 0
        ? `<span class="text-danger">Shortage: ₹${Math.abs(bal).toFixed(2)}</span>`
        : `<span class="text-primary">Remaining: ₹${bal.toFixed(2)}</span>`;
}
document.getElementById('budgetInHand').addEventListener('input', calcBalance);

async function updateBudget() {
    const b = document.getElementById('budgetInHand').value;
    await apiPost({ action: "manageList", subAction: "updateMeta", listName: document.getElementById('listSelector').value, budget: b });
    await fetchInitData();
    alert("Budget saved and cascaded to subsequent lists.");
}

function handleEnter(e, elem, index) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const tr = elem.closest('tr');
        const iVal = tr.querySelector('.pItem').value.trim().toLowerCase();
        let match = Object.values(productDB).find(p => p.item && p.item.toLowerCase() === iVal);
        if (match) {
            tr.querySelector('.pItem').value = match.item;
            tr.querySelector('.pSpecs').value = match.specs || "";
            if (!tr.querySelector('.pRefLink').value) tr.querySelector('.pRefLink').value = match.refLink || "";
            tr.querySelector('.pComp').value = match.prefComp || "Any";
            tr.querySelector('.pCode').value = match.code || "";
            toggleCode(tr.querySelector('.pComp'));
            if (!tr.querySelector('.pEstPrice').value) tr.querySelector('.pEstPrice').value = match.estPrice || "";
            const uSel = tr.querySelector('.pUnit');
            const mUnit = match.unit || "Piece";
            if (![...uSel.options].some(o => o.value.toLowerCase() === mUnit.toLowerCase())) uSel.add(new Option(mUnit, mUnit), uSel.options[0]);
            uSel.value = mUnit;
            const pieceFlag = isPieceUnit(mUnit);
            tr.querySelector('.pSubQty').value = pieceFlag ? "" : (match.subQty || "");
            const suSel = tr.querySelector('.pSubUnit');
            suSel.innerHTML = buildSubUnitOptions(pieceFlag ? "" : (match.subUnit || "Piece"), pieceFlag);
            toggleSubQtyInput(uSel);
        }
    }
}

function openAddVendorModal() {
    document.getElementById('newVendorName').value = '';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('addVendorModal')).show();
}

function confirmAddVendor() {
    const v = document.getElementById('newVendorName').value.trim();
    if (v && !activeVendors.includes(v)) {
        activeVendors.push(v);
        currentListData.forEach(r => r[v] = "");
        renderTable();
    }
    const modal = bootstrap.Modal.getInstance(document.getElementById('addVendorModal'));
    if (modal) modal.hide();
}

function toggleVendorNA(i, v) {
    if (currentListData[i][v] === 'NA') {
        currentListData[i][v] = '';
    } else {
        currentListData[i][v] = 'NA';
        if (currentListData[i]['Selected Vendor'] === v) {
            currentListData[i]['Selected Vendor'] = '';
            recalculateRowTotalEstimate(currentListData[i]);
        }
    }
    renderTable();
}

function optimizeVendors() {
    currentListData.forEach(row => {
        const pqbd = computeRowPQBD(row);
        if (row._isEditing || getRowGroupKey(row) === 'acquired' || pqbd.D || pqbd.B) return;
        let bestVendor = '';
        let minPrice = Infinity;
        activeVendors.forEach(v => {
            let p = parseFloat(row[v]);
            if (!isNaN(p) && p > 0 && p < minPrice && row[v] !== 'NA') { minPrice = p; bestVendor = v; }
        });
        if (bestVendor) {
            row['Selected Vendor'] = bestVendor;
            recalculateRowTotalEstimate(row);
        }
    });
    renderTable();
}

function addNewRow() {
    if (isCurrentListClosed()) return;
    collapsedGroups.toAcquire = false;
    let newRow = {
        _isEditing: true, _isNew: true, 'Reference Link': '',
        'Required Quantity': 1, 'Unit': 'Piece', 'Sub Quantity': '', 'Sub Unit': '',
        'Acquired Qty': 0, 'Acquired Sub Qty': '', 'Acquired Sub Unit': '',
        'Bill Ref No': '', 'Bill Date': '', 'Bill Amount': '', 'Date of Procurement': '', 'Item Status': 'P'
    };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);
    renderTable();
    const tContainer = document.querySelector('.table-responsive');
    tContainer.scrollTop = tContainer.scrollHeight;
}

function duplicateRow(i) {
    if (isCurrentListClosed()) return;
    collapsedGroups.toAcquire = false;
    let clonedRow = JSON.parse(JSON.stringify(currentListData[i]));
    clonedRow._isEditing = true;
    clonedRow._isNew = true;
    clonedRow['Selected Vendor'] = '';
    clonedRow['Total Estimate'] = '';
    clonedRow['Acquired Qty'] = 0;
    clonedRow['Acquired Sub Qty'] = '';
    clonedRow['Acquired Sub Unit'] = '';
    clonedRow['Bill Ref No'] = '';
    clonedRow['Bill Date'] = '';
    clonedRow['Bill Amount'] = '';
    clonedRow['Date of Procurement'] = '';
    clonedRow['Item Status'] = 'P';
    activeVendors.forEach(v => clonedRow[v] = '');
    delete clonedRow._origState;

    currentListData.splice(i + 1, 0, clonedRow);
    renderTable();
}

function editRow(i) {
    if (isCurrentListClosed()) return;
    currentListData[i]._isEditing = true;
    currentListData[i]._origState = { ...currentListData[i] };
    renderTable();
}

function cancelRow(i) {
    if (currentListData[i]._isNew) currentListData.splice(i, 1);
    else { currentListData[i] = currentListData[i]._origState; currentListData[i]._isEditing = false; }
    renderTable();
}

async function deleteRow(i) {
    if (isCurrentListClosed()) return;
    if (confirm("Delete this item from the list?")) {
        currentListData.splice(i, 1);
        await syncTableToBackend();
    }
}

async function saveRow(i) {
    const tr = document.getElementById(`editRow_${i}`);
    const item = tr.querySelector('.pItem').value.trim();
    const specs = tr.querySelector('.pSpecs').value.trim();
    const refLink = tr.querySelector('.pRefLink').value.trim();
    const qty = parseFloat(tr.querySelector('.pQty').value) || 0;
    const unitVal = tr.querySelector('.pUnit').value;
    const pieceFlag = isPieceUnit(unitVal);
    const subQtyVal = pieceFlag ? '' : tr.querySelector('.pSubQty').value.trim();
    const subUnitVal = pieceFlag ? '' : (tr.querySelector('.pSubUnit').value || 'Piece');

    if (!item) return alert("Item Name is required.");
    if (qty < 1) return alert("Quantity must be at least 1.");

    const orig = currentListData[i]._origState || {};
    let sv = orig['Selected Vendor'] || '';

    currentListData[i] = {
        'Item': item, 'Item Specs': specs, 'Reference Link': refLink,
        'Preferred Company': tr.querySelector('.pComp').value.trim() || 'Any',
        'Product Code': tr.querySelector('.pCode').value.trim(),
        'Required Quantity': qty, 'Unit': unitVal, 'Sub Quantity': subQtyVal, 'Sub Unit': subUnitVal,
        'Acquired Qty': orig['Acquired Qty'] || 0,
        'Acquired Sub Qty': orig['Acquired Sub Qty'] || '',
        'Acquired Sub Unit': orig['Acquired Sub Unit'] || '',
        'Estimated Price': tr.querySelector('.pEstPrice').value,
        'Selected Vendor': sv,
        'Bill Ref No': orig['Bill Ref No'] || '',
        'Bill Date': orig['Bill Date'] || '',
        'Bill Amount': orig['Bill Amount'] || '',
        'Date of Procurement': orig['Date of Procurement'] || '',
        'Item Status': orig['Item Status'] || 'P',
        _isEditing: false
    };

    activeVendors.forEach(v => { currentListData[i][v] = orig[v] !== undefined ? orig[v] : ''; });
    recalculateRowTotalEstimate(currentListData[i]);

    const btns = tr.querySelectorAll('button');
    btns[0].innerHTML = '<i class="bi bi-hourglass-split"></i>';
    btns[0].disabled = true; btns[1].disabled = true;
    await syncTableToBackend();
}

async function saveTableEdits() {
    if (isCurrentListClosed()) return;
    const btn = document.getElementById('btnSaveEdits');
    btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Saving...`;
    btn.disabled = true;
    await syncTableToBackend();
    await saveNonItemExpenses(false);
    btn.innerHTML = `<i class="bi bi-floppy"></i> Save Table Edits`;
    btn.disabled = false;
}

async function syncTableToBackend() {
    try {
        const cleanData = currentListData.filter(r => !r._isEditing);
        const allHeaders = BASE_HEADERS.concat(activeVendors);
        await apiPost({
            action: "saveTableEdits",
            listName: document.getElementById('listSelector').value,
            headers: allHeaders,
            tableData: cleanData
        });
        const initRes = await apiPost({ action: "getInit", username: USER.username, role: USER.role });
        productDB = initRes.products || productDB;
        vendorDB = initRes.vendors || vendorDB;
        activeLists = initRes.lists || activeLists;
        latestInheritedBudget = initRes.latestBudget || latestInheritedBudget;
        globalAlerts = initRes.alerts || globalAlerts;
        renderTable();
        updateAlertBadge();
    } catch (e) {
        alert("Failed to sync list.");
        renderTable();
    }
}

// -------------------------------------------------------------
// LIST SETUP & FACULTY ADDRESS MODAL
// -------------------------------------------------------------
function manageList(showFacultyWarning = false) {
    const lName = document.getElementById('listSelector').value;
    if (!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    document.getElementById('listRename').value = lName;
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    document.getElementById('listQuoteAddress').value = meta.quoteAddress || '';

    const fac = getEffectiveFacultyAddress();
    document.getElementById('facFullName').value = fac.fullName || '';
    document.getElementById('facDesignation').value = fac.designation || '';
    document.getElementById('facDepartment').value = fac.department || '';
    document.getElementById('facBuilding').value = fac.building || '';
    document.getElementById('facRoom').value = fac.room || '';
    document.getElementById('facEmail').value = fac.email || '';
    document.getElementById('facPhone').value = fac.phone || '';

    const banner = document.getElementById('facultyAlertBanner');
    if (banner) banner.style.display = showFacultyWarning ? 'block' : 'none';

    document.getElementById('listRename').disabled = !(USER.role === "Admin" || USER.role === "Lab Supervisor" || meta.owner === USER.username);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('listModal')).show();
}

async function renameList() {
    const oldName = document.getElementById('listSelector').value;
    const newName = document.getElementById('listRename').value.trim();
    if (!newName || oldName === newName) return;
    await apiPost({ action: "manageList", subAction: "rename", oldName: oldName, newName: newName });
    document.getElementById('listSelector').setAttribute('data-curr', newName);
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

async function deleteList() {
    const lName = document.getElementById('listSelector').value;
    if (confirm(`Are you absolutely sure you want to delete the list '${lName}'?`)) {
        await apiPost({ action: "manageList", subAction: "delete", listName: lName });
        document.getElementById('listSelector').setAttribute('data-curr', "");
        bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
        fetchInitData();
    }
}

async function saveListSettings() {
    const facObj = {
        fullName: document.getElementById('facFullName').value.trim(),
        designation: document.getElementById('facDesignation').value.trim(),
        department: document.getElementById('facDepartment').value.trim(),
        building: document.getElementById('facBuilding').value.trim(),
        room: document.getElementById('facRoom').value.trim(),
        email: document.getElementById('facEmail').value.trim(),
        phone: document.getElementById('facPhone').value.trim()
    };
    await apiPost({
        action: "manageList", subAction: "updateMeta",
        listName: document.getElementById('listSelector').value,
        collabs: document.getElementById('listCollabs').value,
        quoteAddress: document.getElementById('listQuoteAddress').value,
        facultyAddress: facObj
    });
    latestInheritedFacultyAddress = JSON.stringify(facObj);
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

// -------------------------------------------------------------
// MULTI-LIST PILL SELECTOR & BUDGET SPENDING TABLE HELPERS
// -------------------------------------------------------------
function renderListPills(containerId, selectedSet) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = activeLists.map(l => {
        const active = selectedSet.has(l.name) ? 'active' : '';
        const safeName = l.name.replace(/'/g, "\\'");
        return `<span class="list-pill ${active}" onclick="toggleExportListPill('${containerId}', '${safeName}')">
            <i class="bi ${active ? 'bi-check-circle-fill' : 'bi-circle'}"></i> ${esc(l.name)}
        </span>`;
    }).join('');
}

function toggleExportListPill(containerId, listName) {
    const set = containerId === 'rfqListPills' ? selectedRfqLists
        : (containerId === 'finListPills' ? selectedFinLists : selectedStockRepLists);
    if (set.has(listName)) {
        if (set.size === 1) return;
        set.delete(listName);
    } else {
        set.add(listName);
    }
    renderListPills(containerId, set);
}

function buildBudgetSpendingRows(listNames) {
    const selected = activeLists.filter(l => listNames.includes(l.name));
    return selected.map(l => ({
        name: l.name,
        createdDate: l.createdDate || "N/A",
        assigned: (parseFloat(l.budget) || 0).toFixed(2),
        spent: (parseFloat(l.spentAmount) || 0).toFixed(2),
        balance: (parseFloat(l.balance) || 0).toFixed(2)
    }));
}

function appendBudgetTableToPdf(doc, budgetRows, startY) {
    if (!budgetRows || budgetRows.length === 0) return startY;
    doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text("Budget Spending Summary", 14, startY);
    doc.autoTable({
        head: [["List Name", "Creation Date", "Assigned Budget", "Spent Amount", "Balance"]],
        body: budgetRows.map(r => [r.name, r.createdDate, `Rs. ${r.assigned}`, `Rs. ${r.spent}`, `Rs. ${r.balance}`]),
        startY: startY + 3,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [33, 37, 41], halign: 'center' },
        columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
        didParseCell: function(data) {
            if (data.section === 'body' && data.row.index === budgetRows.length - 1 && data.column.index === 4) {
                data.cell.styles.fontStyle = 'bold';
                data.cell.styles.fillColor = [255, 243, 205];
                data.cell.styles.textColor = [13, 110, 253];
                data.cell.styles.fontSize = 9;
            }
        }
    });
    return doc.lastAutoTable.finalY + 6;
}

function buildBudgetTableHtml(budgetRows) {
    if (!budgetRows || budgetRows.length === 0) return "";
    const rows = budgetRows.map((r, idx) => {
        const isLast = idx === budgetRows.length - 1;
        const balStyle = isLast
            ? 'style="background:#fff3cd;color:#0d6efd;font-weight:800;font-size:13px;border:2px solid #0d6efd;"'
            : '';
        return `<tr>
            <td>${esc(r.name)}</td>
            <td class="text-center">${esc(r.createdDate)}</td>
            <td class="text-end">₹${r.assigned}</td>
            <td class="text-end">₹${r.spent}</td>
            <td class="text-end" ${balStyle}>₹${r.balance}</td>
        </tr>`;
    }).join('');
    return `<h4 style="margin-top:16px;margin-bottom:6px;">Budget Spending Summary</h4>
        <table class="rep-table">
            <thead><tr><th>List Name</th><th>Creation Date</th><th>Assigned Budget</th><th>Spent Amount</th><th>Balance</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// -------------------------------------------------------------
// EXPORT 1: REQUEST FOR QUOTATION (RFQ — ONLY 'P' ITEMS)
// -------------------------------------------------------------
function openRfqModal() {
    const fac = getEffectiveFacultyAddress();
    if (!isFacultyAddressValid(fac)) {
        manageList(true);
        return;
    }
    const curr = document.getElementById('listSelector').value;
    selectedRfqLists = new Set(curr ? [curr] : (activeLists[0] ? [activeLists[0].name] : []));
    renderListPills('rfqListPills', selectedRfqLists);

    const vSel = document.getElementById('rfqVendorSelect');
    const allVendors = Array.from(new Set([...activeVendors, ...vendorDB])).sort();
    vSel.innerHTML = `<option value="ALL">All Items (General RFQ)</option>` +
        allVendors.map(v => `<option value="${esc(v)}">Vendor: ${esc(v)}</option>`).join('');

    bootstrap.Modal.getOrCreateInstance(document.getElementById('rfqModal')).show();
}

async function executeRfqExport() {
    const listNames = Array.from(selectedRfqLists);
    if (listNames.length === 0) return alert("Select at least one list.");
    const targetVendor = document.getElementById('rfqVendorSelect').value;
    const format = document.getElementById('rfqFormatSelect').value;
    const includeRefs = document.getElementById('rfqIncludeRefs').checked;

    const btn = document.getElementById('btnRunRfqExport');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Generating...';
    btn.disabled = true;

    try {
        const res = await apiPost({ action: "getMultipleListsData", listNames });
        const listsData = res.listsData || {};
        let combinedRows = [];
        listNames.forEach(ln => {
            const rows = (listsData[ln] && listsData[ln].rows) ? listsData[ln].rows : [];
            rows.forEach(r => {
                if (!computeRowPQBD(r).P) return; // Include only Pending (P) items
                if (targetVendor !== "ALL" && String(r['Selected Vendor'] || '').trim() !== targetVendor) return;
                combinedRows.push(r);
            });
        });

        if (combinedRows.length === 0) {
            alert("No pending (P) items found for the selected list(s) and vendor.");
            return;
        }

        const facLines = formatFacultyAddressLines(getEffectiveFacultyAddress());
        const genDate = formatNowDate();
        const title = targetVendor === "ALL" ? "REQUEST FOR QUOTATION" : `REQUEST FOR QUOTATION — ${targetVendor}`;
        const includedNote = `Included lists: ${listNames.join(", ")}`;
        const cols = ["Sl. No.", "Item", "Item Specs", "Preferred Company", "Product Code", "Required Qty", "Unit", "Sub Qty", "Sub Unit"];

        const tableRows = combinedRows.map((r, idx) => {
            const specsTxt = includeRefs && r['Reference Link']
                ? `${r['Item Specs'] || ''}\nReference: ${truncateSingleLineText(r['Reference Link'], 50)}`.trim()
                : (r['Item Specs'] || '');
            return [
                idx + 1,
                r['Item'] || '',
                specsTxt,
                r['Preferred Company'] || 'Any',
                r['Product Code'] || '',
                r['Required Quantity'] || '',
                r['Unit'] || 'Piece',
                isPieceUnit(r['Unit']) ? '-' : (r['Sub Quantity'] || '-'),
                isPieceUnit(r['Unit']) ? '-' : (r['Sub Unit'] || '-')
            ];
        });

        bootstrap.Modal.getInstance(document.getElementById('rfqModal')).hide();

        if (format === 'excel') {
            const aoa = [
                ["DR. NIMMI DAS LAB"],
                [title, "", "", "", "", "", "", "", `Date: ${genDate}`],
                ...facLines.map(l => [l]),
                [],
                cols,
                ...tableRows,
                [],
                [includedNote]
            ];
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            XLSX.utils.book_append_sheet(wb, ws, "RFQ");
            XLSX.writeFile(wb, `RFQ_${targetVendor === "ALL" ? "General" : targetVendor}.xlsx`);
        } else if (format === 'pdf') {
            const doc = new jspdf.jsPDF('landscape');
            const pageW = doc.internal.pageSize.getWidth();
            doc.setFontSize(15); doc.setFont(undefined, 'bold');
            doc.text("DR. NIMMI DAS LAB", pageW / 2, 13, { align: 'center' });
            doc.setFontSize(11);
            doc.text(title, pageW / 2, 19, { align: 'center' });

            doc.setFontSize(9); doc.setFont(undefined, 'normal');
            doc.text(`Date: ${genDate}`, pageW - 14, 25, { align: 'right' });
            let y = 25;
            facLines.forEach(line => { doc.text(line, 14, y); y += 4.5; });

            doc.autoTable({
                head: [cols],
                body: tableRows,
                startY: Math.max(y + 2, 32),
                styles: { fontSize: 8, valign: 'top' },
                headStyles: { fillColor: [33, 37, 41] }
            });

            const finalY = doc.lastAutoTable.finalY + 8;
            doc.setFontSize(7.5); doc.setFont(undefined, 'italic');
            doc.text(includedNote, 14, finalY);
            doc.save(`RFQ_${targetVendor === "ALL" ? "General" : targetVendor}.pdf`);
        } else {
            const html = `<!DOCTYPE html><html><head><title>${esc(title)}</title><style>
                body { font-family: Arial, sans-serif; margin: 24px; font-size: 12px; }
                .hdr { text-align: center; } .hdr h2 { margin: 0; } .hdr h4 { margin: 4px 0 12px; }
                .meta { display: flex; justify-content: space-between; margin-bottom: 12px; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border: 1px solid #333; padding: 6px; vertical-align: top; }
                th { background: #f1f5f9; }
                .foot { margin-top: 14px; font-style: italic; font-size: 10px; color: #555; }
            </style></head><body>
                <div class="hdr"><h2>DR. NIMMI DAS LAB</h2><h4>${esc(title)}</h4></div>
                <div class="meta">
                    <div>${facLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
                    <div><strong>Date:</strong> ${esc(genDate)}</div>
                </div>
                <table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                <tbody>${tableRows.map(r => `<tr>${r.map(c => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table>
                <div class="foot">${esc(includedNote)}</div>
            </body></html>`;
            const win = window.open('', '', 'width=1024,height=720');
            win.document.write(html); win.document.close(); win.focus(); win.print();
        }
    } finally {
        btn.innerHTML = '<i class="bi bi-download"></i> Generate RFQ';
        btn.disabled = false;
    }
}

// -------------------------------------------------------------
// EXPORT 2: FINANCIAL STATEMENT (EXPENDITURE & SUMMARY REPORT)
// -------------------------------------------------------------
function openFinancialModal() {
    const curr = document.getElementById('listSelector').value;
    selectedFinLists = new Set(curr ? [curr] : (activeLists[0] ? [activeLists[0].name] : []));
    renderListPills('finListPills', selectedFinLists);
    updateFinancialFormatOptions();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('financialModal')).show();
}

function updateFinancialFormatOptions() {
    const type = document.getElementById('finReportType').value;
    const fmt = document.getElementById('finFormatSelect');
    if (type === 'summary') {
        fmt.innerHTML = `<option value="pdf">PDF Document (Only)</option>`;
    } else {
        fmt.innerHTML = `
            <option value="pdf">PDF Document</option>
            <option value="excel">Excel File (.xlsx)</option>
            <option value="print">Printable View</option>
        `;
    }
}

async function executeFinancialExport() {
    const listNames = Array.from(selectedFinLists);
    if (listNames.length === 0) return alert("Select at least one list.");
    const reportType = document.getElementById('finReportType').value;
    const format = reportType === 'summary' ? 'pdf' : document.getElementById('finFormatSelect').value;
    const toAddress = (document.getElementById('finToAddress').value || "").trim();
    const includeBudgetTable = document.getElementById('finIncludeBudgetTable').checked;
    const budgetRows = includeBudgetTable ? buildBudgetSpendingRows(listNames) : [];

    const btn = document.getElementById('btnRunFinExport');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Generating...';
    btn.disabled = true;

    try {
        const res = await apiPost({ action: "getMultipleListsData", listNames });
        const listsData = res.listsData || {};

        const vendorMap = {};
        const addlExpensesAll = [];

        listNames.forEach(ln => {
            const rows = (listsData[ln] && listsData[ln].rows) ? listsData[ln].rows : [];
            rows.forEach(r => {
                const billNo = String(r['Bill Ref No'] || '').trim();
                const billAmt = parseFloat(r['Bill Amount']) || parseFloat(r['Total Estimate']) || 0;
                if (!billNo || billAmt <= 0) return;

                const vendor = String(r['Selected Vendor'] || 'Unspecified Vendor').trim() || 'Unspecified Vendor';
                const billDate = formatDateOnly(r['Bill Date'] || r['Date of Procurement']);
                const qty = parseFloat(r['Acquired Qty']) || parseFloat(r['Required Quantity']) || 1;
                const unit = String(r['Unit'] || 'Piece').trim();
                const pieceFlag = isPieceUnit(unit);
                const subQty = pieceFlag ? 0 : (parseFloat(r['Acquired Sub Qty']) || parseFloat(r['Sub Quantity']) || 0);
                const subUnit = pieceFlag ? '' : String(r['Acquired Sub Unit'] || r['Sub Unit'] || 'Piece').trim();
                const hasSub = !pieceFlag && subQty > 0;
                const totalPieces = hasSub ? Number((qty * subQty).toFixed(2)) : qty;
                const costPerPiece = totalPieces > 0 ? (billAmt / totalPieces) : billAmt;

                if (!vendorMap[vendor]) vendorMap[vendor] = [];
                vendorMap[vendor].push({
                    item: String(r['Item'] || '').trim(),
                    specs: String(r['Item Specs'] || '').trim(),
                    refLink: String(r['Reference Link'] || '').trim(),
                    prefComp: String(r['Preferred Company'] || '').trim(),
                    code: String(r['Product Code'] || '').trim(),
                    billNo, billDate, amount: billAmt,
                    qty, unit, hasSub, subQty, subUnit, totalPieces, costPerPiece
                });
            });

            const meta = activeLists.find(l => l.name === ln);
            if (meta && meta.additionalExpenses) {
                try {
                    const exps = JSON.parse(meta.additionalExpenses);
                    if (Array.isArray(exps)) {
                        exps.forEach(e => {
                            const amt = parseFloat(e.amount) || 0;
                            if (amt > 0) {
                                addlExpensesAll.push({
                                    label: e.label || "Additional Expense",
                                    vendor: e.vendor || "General",
                                    invoiceNo: e.invoiceNo || "-",
                                    invoiceDate: formatDateOnly(e.invoiceDate),
                                    amount: amt,
                                    remarks: e.remarks || ""
                                });
                            }
                        });
                    }
                } catch (e) {}
            }
        });

        const vendorNames = Object.keys(vendorMap).sort((a, b) => a.localeCompare(b));
        if (vendorNames.length === 0 && addlExpensesAll.length === 0) {
            alert("No billed items (with Bill Number & Bill Amount) found in the selected list(s).");
            return;
        }

        vendorNames.forEach(v => {
            vendorMap[v].sort((a, b) => {
                const dCmp = parseDateSortable(a.billDate).localeCompare(parseDateSortable(b.billDate));
                return dCmp !== 0 ? dCmp : a.billNo.localeCompare(b.billNo);
            });
        });

        const facLines = formatFacultyAddressLines(getEffectiveFacultyAddress());
        const genDate = formatNowDate();
        const exporterNote = `Exported by: ${USER.username} (${USER.role}) on ${genDate}`;
        const includedNote = `Included lists: ${listNames.join(", ")}`;

        bootstrap.Modal.getInstance(document.getElementById('financialModal')).hide();

        if (reportType === 'summary') {
            generateSummaryReportPdf(vendorNames, vendorMap, addlExpensesAll, facLines, toAddress, genDate, exporterNote, includedNote, budgetRows);
        } else {
            generateExpenditureReport(format, vendorNames, vendorMap, addlExpensesAll, facLines, toAddress, genDate, exporterNote, includedNote, budgetRows);
        }
    } finally {
        btn.innerHTML = '<i class="bi bi-file-earmark-pdf"></i> Generate Statement';
        btn.disabled = false;
    }
}

function generateSummaryReportPdf(vendorNames, vendorMap, addlExpensesAll, facLines, toAddress, genDate, exporterNote, includedNote, budgetRows) {
    const doc = new jspdf.jsPDF('portrait');
    const pageW = doc.internal.pageSize.getWidth();

    doc.setFontSize(15); doc.setFont(undefined, 'bold');
    doc.text("DR. NIMMI DAS LAB", pageW / 2, 14, { align: 'center' });
    doc.setFontSize(11);
    doc.text("FINANCIAL STATEMENT — SUMMARY REPORT", pageW / 2, 20, { align: 'center' });

    doc.setFontSize(8.5); doc.setFont(undefined, 'bold');
    doc.text("From:", 14, 28);
    doc.setFont(undefined, 'normal');
    let yLeft = 32;
    facLines.forEach(l => { doc.text(l, 14, yLeft); yLeft += 4; });

    let yRight = 28;
    doc.setFont(undefined, 'bold');
    doc.text(`Date: ${genDate}`, pageW - 14, yRight, { align: 'right' });
    yRight += 5;
    if (toAddress) {
        doc.text("To:", pageW / 2 + 10, yRight);
        doc.setFont(undefined, 'normal');
        yRight += 4;
        doc.splitTextToSize(toAddress, pageW / 2 - 24).forEach(l => { doc.text(l, pageW / 2 + 10, yRight); yRight += 4; });
    }

    const body = [];
    let sl = 1;
    let grandTotal = 0;

    vendorNames.forEach(v => {
        body.push([{ content: `Vendor: ${v}`, colSpan: 4, styles: { fontStyle: 'bold', fillColor: [233, 236, 239] } }]);
        const invMap = {};
        vendorMap[v].forEach(it => {
            const k = `${it.billNo}||${it.billDate}`;
            if (!invMap[k]) invMap[k] = { billNo: it.billNo, billDate: it.billDate, amt: 0 };
            invMap[k].amt += it.amount;
        });
        const invoices = Object.values(invMap).sort((a, b) => {
            const d = parseDateSortable(a.billDate).localeCompare(parseDateSortable(b.billDate));
            return d !== 0 ? d : a.billNo.localeCompare(b.billNo);
        });
        let vTotal = 0;
        invoices.forEach(inv => {
            vTotal += inv.amt;
            body.push([sl++, inv.billNo, inv.billDate || "-", `Rs. ${inv.amt.toFixed(2)}`]);
        });
        grandTotal += vTotal;
        body.push([
            { content: `Vendor Total (${v})`, colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } },
            { content: `Rs. ${vTotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold' } }
        ]);
    });

    if (addlExpensesAll.length > 0) {
        body.push([{ content: "Additional Expenses (Non-Item Bills)", colSpan: 4, styles: { fontStyle: 'bold', fillColor: [255, 243, 205] } }]);
        let addlTotal = 0;
        addlExpensesAll.forEach(e => {
            addlTotal += e.amount;
            body.push([sl++, `${e.invoiceNo} (${e.label})`, e.invoiceDate || "-", `Rs. ${e.amount.toFixed(2)}`]);
        });
        grandTotal += addlTotal;
        body.push([
            { content: "Additional Expenses Total", colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } },
            { content: `Rs. ${addlTotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold' } }
        ]);
    }

    body.push([
        { content: "GRAND TOTAL", colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', fontSize: 10, fillColor: [209, 231, 221] } },
        { content: `Rs. ${grandTotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold', fontSize: 10, fillColor: [209, 231, 221] } }
    ]);

    doc.autoTable({
        head: [["Sl. No.", "Bill Number", "Bill Date", "Invoice Amt"]],
        body,
        startY: Math.max(yLeft, yRight) + 4,
        styles: { fontSize: 8.5 },
        headStyles: { fillColor: [33, 37, 41], halign: 'center' },
        columnStyles: { 0: { halign: 'center', cellWidth: 18 }, 2: { halign: 'center', cellWidth: 32 }, 3: { halign: 'right', cellWidth: 38 } }
    });

    let fy = doc.lastAutoTable.finalY + 8;
    if (budgetRows && budgetRows.length > 0) {
        fy = appendBudgetTableToPdf(doc, budgetRows, fy) + 14;
    } else {
        fy += 14;
    }

    if (fy > 270) { doc.addPage(); fy = 28; }
    doc.setFontSize(9); doc.setFont(undefined, 'normal');
    doc.line(pageW - 75, fy, pageW - 14, fy);
    doc.text("Signature", pageW - 44, fy + 5, { align: 'center' });

    doc.setFontSize(7.5); doc.setFont(undefined, 'italic');
    doc.text(exporterNote, 14, fy + 10);
    doc.text(includedNote, 14, fy + 14);
    doc.save(`Financial_Summary_Report_${genDate.replace(/\//g, '-')}.pdf`);
}

function drawRupeeVector(doc, x, y, size = 2.6, isBold = false) {
    const prevLW = doc.getLineWidth();
    doc.setLineWidth(isBold ? 0.34 : 0.24);
    doc.setDrawColor(20, 20, 20);
    // Top bar
    doc.line(x, y - size, x + size * 0.85, y - size);
    // Middle bar
    doc.line(x, y - size * 0.62, x + size * 0.85, y - size * 0.62);
    // Curve right side + lower diagonal leg
    doc.line(x + size * 0.42, y - size, x + size * 0.62, y - size * 0.78);
    doc.line(x + size * 0.62, y - size * 0.78, x + size * 0.56, y - size * 0.45);
    doc.line(x + size * 0.56, y - size * 0.45, x + size * 0.12, y - size * 0.32);
    doc.line(x + size * 0.12, y - size * 0.32, x + size * 0.68, y + size * 0.12);
    doc.setLineWidth(prevLW);
}

function formatQtyCellPlain(it) {
    if (!it.hasSub) return `${it.qty} ${it.unit}`;
    return `${it.qty} ${it.unit}\n${it.subQty} ${it.subUnit}/${it.unit}\nTotal: ${it.totalPieces} ${it.subUnit}`;
}

function formatQtyCellHtml(it) {
    if (!it.hasSub) return `<div>${esc(it.qty)} ${esc(it.unit)}</div>`;
    return `<div><strong>${esc(it.qty)} ${esc(it.unit)}</strong></div>
        <div class="small text-muted">${esc(it.subQty)} ${esc(it.subUnit)}/${esc(it.unit)}</div>
        <div class="small fst-italic">Total: ${esc(it.totalPieces)} ${esc(it.subUnit)}</div>`;
}

function generateExpenditureReport(format, vendorNames, vendorMap, addlExpensesAll, facLines, toAddress, genDate, exporterNote, includedNote, budgetRows) {
    let grandTotal = 0;

    if (format === 'excel') {
        const aoa = [
            ["DR. NIMMI DAS LAB"],
            ["FINANCIAL STATEMENT — EXPENDITURE REPORT", "", "", "", "", "", `Date: ${genDate}`],
            ["From:"],
            ...facLines.map(l => [l])
        ];
        if (toAddress) { aoa.push(["To:"]); toAddress.split('\n').forEach(l => aoa.push([l])); }
        aoa.push([], ["Sl. No.", "Item & Item Specs", "Bill Number", "Bill Date", "Cost / Piece (₹)", "Qty & Unit", "Amount (₹)"]);

        let sl = 1;
        vendorNames.forEach(v => {
            aoa.push([`Vendor: ${v}`]);
            let vTotal = 0;
            vendorMap[v].forEach(it => {
                vTotal += it.amount;
                const desc = [it.item, it.specs, it.prefComp ? `Preferred company: ${it.prefComp}${it.code ? ` [${it.code}]` : ''}` : '', it.refLink].filter(Boolean).join("\n");
                aoa.push([sl++, desc, it.billNo, it.billDate || "-", `₹ ${it.costPerPiece.toFixed(2)}`, formatQtyCellPlain(it), `₹ ${it.amount.toFixed(2)}`]);
            });
            grandTotal += vTotal;
            aoa.push(["", "", "", "", "", `Vendor Total (${v})`, `₹ ${vTotal.toFixed(2)}`]);
        });

        if (addlExpensesAll.length > 0) {
            aoa.push(["Additional Expenses (Non-Item Bills)"]);
            let addlTotal = 0;
            addlExpensesAll.forEach(e => {
                addlTotal += e.amount;
                const desc = `${e.label}${e.vendor ? ` (${e.vendor})` : ''}${e.remarks ? ` - ${e.remarks}` : ''}`;
                aoa.push([sl++, desc, e.invoiceNo, e.invoiceDate || "-", "-", "-", `₹ ${e.amount.toFixed(2)}`]);
            });
            grandTotal += addlTotal;
            aoa.push(["", "", "", "", "", "Additional Expenses Total", `₹ ${addlTotal.toFixed(2)}`]);
        }
        aoa.push([], ["", "", "", "", "", "GRAND TOTAL", `₹ ${grandTotal.toFixed(2)}`]);

        if (budgetRows && budgetRows.length > 0) {
            aoa.push([], ["BUDGET SPENDING SUMMARY"], ["List Name", "Creation Date", "Assigned Budget", "Spent Amount", "Balance"]);
            budgetRows.forEach(r => aoa.push([r.name, r.createdDate, `₹ ${r.assigned}`, `₹ ${r.spent}`, `₹ ${r.balance}`]));
        }
        aoa.push([], [exporterNote], [includedNote]);

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Expenditure Report");
        XLSX.writeFile(wb, `Expenditure_Report_${genDate.replace(/\//g, '-')}.xlsx`);
        return;
    }

    if (format === 'pdf') {
        const doc = new jspdf.jsPDF('landscape');
        const pageW = doc.internal.pageSize.getWidth();
        doc.setFontSize(15); doc.setFont(undefined, 'bold');
        doc.text("DR. NIMMI DAS LAB", pageW / 2, 14, { align: 'center' });
        doc.setFontSize(11);
        doc.text("FINANCIAL STATEMENT — EXPENDITURE REPORT", pageW / 2, 20, { align: 'center' });

        doc.setFontSize(8.5); doc.setFont(undefined, 'bold');
        doc.text("From:", 14, 28);
        doc.setFont(undefined, 'normal');
        let yLeft = 32;
        facLines.forEach(l => { doc.text(l, 14, yLeft); yLeft += 4; });

        let yRight = 28;
        doc.setFont(undefined, 'bold');
        doc.text(`Date: ${genDate}`, pageW - 14, yRight, { align: 'right' });
        yRight += 5;
        if (toAddress) {
            doc.text("To:", pageW / 2 + 20, yRight);
            doc.setFont(undefined, 'normal');
            yRight += 4;
            doc.splitTextToSize(toAddress, pageW / 2 - 34).forEach(l => { doc.text(l, pageW / 2 + 20, yRight); yRight += 4; });
        }

        const body = [];
        let sl = 1;
        vendorNames.forEach(v => {
            body.push([{ content: `Vendor: ${v}`, colSpan: 7, styles: { fontStyle: 'bold', fillColor: [233, 236, 239] } }]);
            let vTotal = 0;
            vendorMap[v].forEach(it => {
                vTotal += it.amount;
                const desc = [
                    it.item,
                    it.specs,
                    it.prefComp ? `Preferred company: ${it.prefComp}${it.code ? ` [${it.code}]` : ''}` : '',
                    it.refLink ? truncateSingleLineText(it.refLink, 55) : ''
                ].filter(Boolean).join("\n");
                body.push([
                    sl++,
                    desc,
                    it.billNo,
                    it.billDate || "-",
                    { content: it.costPerPiece.toFixed(2), _rupee: true },
                    formatQtyCellPlain(it),
                    { content: it.amount.toFixed(2), _rupee: true }
                ]);
            });
            grandTotal += vTotal;
            body.push([
                { content: `Vendor Total (${v})`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
                { content: vTotal.toFixed(2), _rupee: true, _boldRupee: true, styles: { halign: 'right', fontStyle: 'bold' } }
            ]);
        });

        if (addlExpensesAll.length > 0) {
            body.push([{ content: "Additional Expenses (Non-Item Bills)", colSpan: 7, styles: { fontStyle: 'bold', fillColor: [255, 243, 205] } }]);
            let addlTotal = 0;
            addlExpensesAll.forEach(e => {
                addlTotal += e.amount;
                const desc = `${e.label}${e.vendor ? ` (${e.vendor})` : ''}${e.remarks ? `\nRemarks: ${e.remarks}` : ''}`;
                body.push([
                    sl++,
                    desc,
                    e.invoiceNo,
                    e.invoiceDate || "-",
                    "-",
                    "-",
                    { content: e.amount.toFixed(2), _rupee: true }
                ]);
            });
            grandTotal += addlTotal;
            body.push([
                { content: "Additional Expenses Total", colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } },
                { content: addlTotal.toFixed(2), _rupee: true, _boldRupee: true, styles: { halign: 'right', fontStyle: 'bold' } }
            ]);
        }

        body.push([
            { content: "GRAND TOTAL", colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', fontSize: 10, fillColor: [209, 231, 221] } },
            { content: grandTotal.toFixed(2), _rupee: true, _boldRupee: true, styles: { halign: 'right', fontStyle: 'bold', fontSize: 10, fillColor: [209, 231, 221] } }
        ]);

        doc.autoTable({
            head: [["Sl. No.", "Item & Item Specs", "Bill Number", "Bill Date", "Cost / Piece", "Qty & Unit", "Amount"]],
            body,
            startY: Math.max(yLeft, yRight) + 4,
            styles: { fontSize: 8, valign: 'top', cellPadding: 2.5 },
            headStyles: { fillColor: [33, 37, 41], halign: 'center' },
            columnStyles: {
                0: { halign: 'center', cellWidth: 13 },
                1: { cellWidth: 96 },
                2: { cellWidth: 28 },
                3: { halign: 'center', cellWidth: 23 },
                4: { halign: 'right', cellWidth: 28, cellPadding: { top: 2.5, right: 2.5, bottom: 2.5, left: 6 } },
                5: { halign: 'center', cellWidth: 46 },
                6: { halign: 'right', cellWidth: 35, cellPadding: { top: 2.5, right: 2.5, bottom: 2.5, left: 6 } }
            },
            didDrawCell: function(data) {
                if (data.section === 'body' && data.cell.raw && data.cell.raw._rupee) {
                    const isBold = !!data.cell.raw._boldRupee;
                    const symSize = data.cell.styles.fontSize >= 10 ? 2.8 : 2.3;
                    drawRupeeVector(doc, data.cell.x + 2.2, data.cell.y + 4.8, symSize, isBold);
                }
            }
        });

        let fy = doc.lastAutoTable.finalY + 8;
        if (budgetRows && budgetRows.length > 0) {
            fy = appendBudgetTableToPdf(doc, budgetRows, fy) + 14;
        } else {
            fy += 14;
        }

        if (fy > 185) { doc.addPage(); fy = 28; }
        doc.setFontSize(9); doc.setFont(undefined, 'normal');
        doc.line(pageW - 75, fy, pageW - 14, fy);
        doc.text("Signature", pageW - 44, fy + 5, { align: 'center' });

        doc.setFontSize(7.5); doc.setFont(undefined, 'italic');
        doc.text(exporterNote, 14, fy + 10);
        doc.text(includedNote, 14, fy + 14);
        doc.save(`Expenditure_Report_${genDate.replace(/\//g, '-')}.pdf`);
        return;
    }

    // Printable view
    const rupeeCell = (val, bold = false) => `<div class="amt-cell${bold ? ' fw-bold' : ''}"><span>₹</span><span>${val}</span></div>`;
    let sl = 1;
    let rowsHtml = "";
    vendorNames.forEach(v => {
        rowsHtml += `<tr style="background:#e9ecef;"><td colspan="7"><strong>Vendor: ${esc(v)}</strong></td></tr>`;
        let vTotal = 0;
        vendorMap[v].forEach(it => {
            vTotal += it.amount;
            rowsHtml += `<tr>
                <td class="text-center">${sl++}</td>
                <td>
                    <strong>${esc(it.item)}</strong>
                    ${it.specs ? `<div>${esc(it.specs)}</div>` : ''}
                    ${it.prefComp ? `<div class="fst-italic small">Preferred company: ${esc(it.prefComp)}${it.code ? ` [${esc(it.code)}]` : ''}</div>` : ''}
                    ${it.refLink ? `<div class="fst-italic small">${esc(it.refLink)}</div>` : ''}
                </td>
                <td>${esc(it.billNo)}</td>
                <td class="text-center">${esc(it.billDate || '-')}</td>
                <td>${rupeeCell(it.costPerPiece.toFixed(2))}</td>
                <td class="text-center">${formatQtyCellHtml(it)}</td>
                <td>${rupeeCell(it.amount.toFixed(2))}</td>
            </tr>`;
        });
        grandTotal += vTotal;
        rowsHtml += `<tr><td colspan="6" class="text-end"><strong>Vendor Total (${esc(v)})</strong></td><td>${rupeeCell(vTotal.toFixed(2), true)}</td></tr>`;
    });

    if (addlExpensesAll.length > 0) {
        rowsHtml += `<tr style="background:#fff3cd;"><td colspan="7"><strong>Additional Expenses (Non-Item Bills)</strong></td></tr>`;
        let addlTotal = 0;
        addlExpensesAll.forEach(e => {
            addlTotal += e.amount;
            rowsHtml += `<tr>
                <td class="text-center">${sl++}</td>
                <td><strong>${esc(e.label)}</strong>${e.vendor ? ` (${esc(e.vendor)})` : ''}${e.remarks ? `<div class="small fst-italic">${esc(e.remarks)}</div>` : ''}</td>
                <td>${esc(e.invoiceNo)}</td>
                <td class="text-center">${esc(e.invoiceDate || '-')}</td>
                <td class="text-center">-</td>
                <td class="text-center">-</td>
                <td>${rupeeCell(e.amount.toFixed(2))}</td>
            </tr>`;
        });
        grandTotal += addlTotal;
        rowsHtml += `<tr><td colspan="6" class="text-end"><strong>Additional Expenses Total</strong></td><td>${rupeeCell(addlTotal.toFixed(2), true)}</td></tr>`;
    }

    rowsHtml += `<tr style="background:#d1e7dd;font-size:13px;"><td colspan="6" class="text-end"><strong>GRAND TOTAL</strong></td><td>${rupeeCell(grandTotal.toFixed(2), true)}</td></tr>`;

    const html = `<!DOCTYPE html><html><head><title>Expenditure Report</title><style>
        body { font-family: Arial, sans-serif; margin: 24px; font-size: 12px; }
        .hdr { text-align: center; } .hdr h2 { margin: 0; } .hdr h4 { margin: 4px 0 12px; }
        .meta { display: flex; justify-content: space-between; margin-bottom: 14px; gap: 24px; }
        table.rep-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
        table.rep-table th, table.rep-table td { border: 1px solid #333; padding: 6px; vertical-align: top; }
        table.rep-table th { background: #f1f5f9; text-align: center; }
        .text-center { text-align: center; } .text-end { text-align: right; }
        .fst-italic { font-style: italic; } .small { font-size: 10.5px; color: #444; }
        .fw-bold { font-weight: 700; }
        .amt-cell { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; white-space: nowrap; }
        .sig { margin-top: 48px; text-align: right; }
        .sig-line { display: inline-block; width: 200px; border-top: 1px solid #111; text-align: center; padding-top: 4px; }
        .foot { margin-top: 16px; font-style: italic; font-size: 10px; color: #555; }
    </style></head><body>
        <div class="hdr"><h2>DR. NIMMI DAS LAB</h2><h4>FINANCIAL STATEMENT — EXPENDITURE REPORT</h4></div>
        <div class="meta">
            <div><strong>From:</strong>${facLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
            <div style="text-align:right;">
                <div><strong>Date:</strong> ${esc(genDate)}</div>
                ${toAddress ? `<div style="margin-top:6px;"><strong>To:</strong><br>${esc(toAddress).replace(/\n/g, '<br>')}</div>` : ''}
            </div>
        </div>
        <table class="rep-table">
            <thead><tr><th>Sl. No.</th><th>Item &amp; Item Specs</th><th>Bill Number</th><th>Bill Date</th><th>Cost / Piece</th><th>Qty &amp; Unit</th><th>Amount</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
        ${buildBudgetTableHtml(budgetRows)}
        <div class="sig"><div class="sig-line">Signature</div></div>
        <div class="foot"><div>${esc(exporterNote)}</div><div>${esc(includedNote)}</div></div>
    </body></html>`;
    const win = window.open('', '', 'width=1024,height=720');
    win.document.write(html); win.document.close(); win.focus(); win.print();
}

// -------------------------------------------------------------
// EXPORT 3: STOCK REPORT (PROCUREMENT SUMMARY — MULTI-LIST)
// -------------------------------------------------------------
async function openProcurementSummaryModal() {
    const curr = document.getElementById('listSelector').value;
    if (!curr && activeLists.length === 0) return alert("Please select a requirement list first.");

    selectedStockRepLists = new Set(curr ? [curr] : [activeLists[0].name]);
    renderListPills('stockRepListPills', selectedStockRepLists);

    const listMeta = getCurrentListMeta();
    document.getElementById('sumListName').innerText = curr || activeLists[0].name;
    document.getElementById('sumPreparedBy').innerText = `${USER.username} (${USER.role})`;

    const cleanRows = currentListData.filter(r => !r._isEditing);
    const procDates = cleanRows.map(r => formatDateOnly(r['Date of Procurement'])).filter(Boolean);
    document.getElementById('sumListCreatedDate').value = (listMeta && listMeta.createdDate) ? formatDateOnly(listMeta.createdDate) : "";
    document.getElementById('sumLastProcDate').value = procDates.length > 0 ? procDates[procDates.length - 1] : "";

    bootstrap.Modal.getOrCreateInstance(document.getElementById('procSummaryModal')).show();

    try {
        const stRes = await apiPost({ action: "getStockData", username: USER.username, role: USER.role });
        if (stRes.status === "success") {
            cachedStockForSummary = stRes.stock || [];
            cachedLedgerForSummary = stRes.ledger || [];
        }
    } catch (e) {}
}

function buildParticularText(itemName, specs, prefComp, code, refLink) {
    const parts = [];
    if (itemName) parts.push(`<strong>${esc(itemName)}</strong>`);
    if (specs) parts.push(`<div>${esc(specs)}</div>`);
    if (prefComp || code) parts.push(`<div><strong>Preferred company:</strong> ${esc(prefComp || "Any")}${code ? ` [${esc(code)}]` : ""}</div>`);
    if (refLink) parts.push(`<div class="fst-italic" style="font-size:10pt;">${esc(refLink)}</div>`);
    return parts.join("");
}

function buildParticularPlain(itemName, specs, prefComp, code, refLink) {
    const lines = [];
    if (itemName) lines.push(itemName);
    if (specs) lines.push(specs);
    if (prefComp || code) lines.push(`Preferred company: ${prefComp || "Any"}${code ? ` [${code}]` : ""}`);
    if (refLink) lines.push(truncateSingleLineText(refLink, 55));
    return lines.join("\n");
}

async function buildStockReportModel() {
    const listNames = Array.from(selectedStockRepLists);
    const includeBudgetTable = document.getElementById('stockIncludeBudgetTable').checked;
    const budgetRows = includeBudgetTable ? buildBudgetSpendingRows(listNames) : [];

    const res = await apiPost({ action: "getMultipleListsData", listNames });
    const listsData = res.listsData || {};

    let cleanRows = [];
    let allExpenses = [];

    listNames.forEach(ln => {
        const rows = (listsData[ln] && listsData[ln].rows) ? listsData[ln].rows : [];
        cleanRows = cleanRows.concat(rows);
        const meta = activeLists.find(l => l.name === ln);
        if (meta && meta.additionalExpenses) {
            try {
                const arr = JSON.parse(meta.additionalExpenses);
                if (Array.isArray(arr)) allExpenses = allExpenses.concat(arr);
            } catch (e) {}
        }
    });

    const nowStr = formatNowDate();
    const preparedBy = `${USER.username} (${USER.role})`;
    const createdDate = formatDateOnly(document.getElementById('sumListCreatedDate').value) || "N/A";
    const lastProcOverride = formatDateOnly(document.getElementById('sumLastProcDate').value);
    const rowProcDates = cleanRows.map(r => formatDateOnly(r['Date of Procurement'])).filter(Boolean);
    const lastProcDate = lastProcOverride || (rowProcDates.length ? rowProcDates[rowProcDates.length - 1] : "N/A");

    let hasIncompleteItem = false;
    let subTotal = 0;

    const groupedBuckets = {
        acquired: { title: "Completely Acquired", rows: [] },
        partly:   { title: "Partially Acquired", rows: [] },
        pending:  { title: "Pending Deliveries/ Purchases", rows: [] }
    };

    cleanRows.forEach(row => {
        const itemName = String(row['Item'] || '').trim();
        const specs = String(row['Item Specs'] || '').trim();
        const prefComp = String(row['Preferred Company'] || '').trim();
        const code = String(row['Product Code'] || '').trim();
        const refLink = String(row['Reference Link'] || '').trim();
        const reqQty = parseFloat(row['Required Quantity']) || 0;
        const unit = String(row['Unit'] || 'Piece').trim();
        const subQty = String(row['Sub Quantity'] || '').trim();
        const subUnit = String(row['Sub Unit'] || '').trim();
        const acqQty = parseFloat(row['Acquired Qty']) || 0;
        const acqSubQty = String(row['Acquired Sub Qty'] || '').trim();
        const acqSubUnit = String(row['Acquired Sub Unit'] || '').trim();

        const isComplete = reqQty > 0 && acqQty >= reqQty;
        const isPartly = acqQty > 0 && acqQty < reqQty;
        const groupKey = isComplete ? 'acquired' : (isPartly ? 'partly' : 'pending');
        if (!isComplete) hasIncompleteItem = true;

        let unitAmtStr = "-", rowAmtStr = "-";
        if (isComplete) {
            const totalAmt = getRowEffectiveAmount(row);
            const unitAmt = acqQty > 0 ? (totalAmt / acqQty) : 0;
            subTotal += totalAmt;
            unitAmtStr = unitAmt.toFixed(2);
            rowAmtStr = totalAmt.toFixed(2);
        }

        groupedBuckets[groupKey].rows.push({
            particularHtml: buildParticularText(itemName, specs, prefComp, code, refLink),
            particularPlain: buildParticularPlain(itemName, specs, prefComp, code, refLink),
            reqMain: `${reqQty} ${unit}`,
            reqSub: (!isPieceUnit(unit) && subQty && subUnit) ? `${subQty} ${subUnit}/${unit}` : "",
            aqMain: `${acqQty} ${unit}${!isComplete ? "*" : ""}`,
            aqSub: (!isPieceUnit(unit) && acqSubQty && acqSubUnit) ? `${acqSubQty} ${acqSubUnit}/${unit}` : "",
            vendorMain: String(row['Selected Vendor'] || '').trim() || "-",
            vendorSub: row['Bill Ref No'] ? `Bill: ${row['Bill Ref No']}` : "",
            unitAmount: unitAmtStr,
            rowAmount: rowAmtStr,
            showPrice: isComplete
        });
    });

    let slCounter = 1;
    const procGroups = [groupedBuckets.acquired, groupedBuckets.partly, groupedBuckets.pending]
        .filter(g => g.rows.length > 0)
        .map(g => { g.rows.forEach(r => { r.slNo = slCounter++; }); return g; });

    const validExpenses = allExpenses
        .map(e => ({ label: (e.label || "Additional Expense").trim(), amount: parseFloat(e.amount) || 0 }))
        .filter(e => e.amount > 0);
    const grandTotal = subTotal + validExpenses.reduce((s, e) => s + e.amount, 0);

    const stockSummaryRows = cleanRows.map((row, idx) => {
        const itemName = String(row['Item'] || '').trim();
        const specs = String(row['Item Specs'] || '').trim();
        const unit = String(row['Unit'] || 'Piece').trim();
        const matchedStock = cachedStockForSummary.find(s =>
            s.item.trim().toLowerCase() === itemName.toLowerCase() &&
            s.specs.trim().toLowerCase() === specs.toLowerCase()
        );
        const subPerUnit = matchedStock ? (parseFloat(matchedStock.subPerUnit) || 1) : (parseFloat(row['Sub Quantity']) || 1);
        const subLabel = matchedStock ? (matchedStock.subLabel || row['Sub Unit'] || '') : (row['Sub Unit'] || '');
        const hasSub = !isPieceUnit(unit) && subPerUnit > 1 && subLabel;

        const afterBase = matchedStock ? (parseFloat(matchedStock.totalBase) || 0) : ((parseFloat(row['Acquired Qty']) || 0) * (hasSub ? subPerUnit : 1));
        const addedBase = (parseFloat(row['Acquired Qty']) || 0) * (hasSub ? subPerUnit : 1);
        const beforeBase = Math.max(0, Number((afterBase - addedBase).toFixed(2)));

        const threshVal = matchedStock ? (parseFloat(matchedStock.threshold) || 0) : 0;
        const threshUnit = matchedStock && matchedStock.thresholdType === 'sub' && hasSub ? subLabel : unit;

        return {
            slNo: idx + 1,
            itemHtml: buildParticularText(itemName, specs, row['Preferred Company'], row['Product Code'], row['Reference Link']),
            itemPlain: buildParticularPlain(itemName, specs, row['Preferred Company'], row['Product Code'], row['Reference Link']),
            beforeQty: `${hasSub ? Math.floor(beforeBase / subPerUnit) : beforeBase} ${unit}`,
            beforeSub: hasSub ? `${beforeBase} ${subLabel}` : "-",
            afterQty: `${hasSub ? Math.floor(afterBase / subPerUnit) : afterBase} ${unit}`,
            afterSub: hasSub ? `${afterBase} ${subLabel}` : "-",
            thresholdDisplay: threshVal > 0 ? `${threshVal} ${threshUnit}` : null
        };
    });

    return {
        labName: "DR. NIMMI DAS LAB",
        listTitle: listNames.join(", "),
        includedNote: `Included lists: ${listNames.join(", ")}`,
        createdDate, lastProcDate, prepDate: nowStr, preparedBy,
        procGroups, subTotal, validExpenses, grandTotal, hasIncompleteItem,
        budgetRows, stockSummaryRows
    };
}

async function printProcurementSummary() {
    const m = await buildStockReportModel();
    const inst = bootstrap.Modal.getInstance(document.getElementById('procSummaryModal'));
    if (inst) inst.hide();

    const procRowsHtml = m.procGroups.map(g => {
        const hdr = `<tr style="background:#e9ecef;"><td colspan="7"><strong>${esc(g.title)} (${g.rows.length})</strong></td></tr>`;
        const body = g.rows.map(r => `<tr>
            <td class="text-center">${r.slNo}</td>
            <td>${r.particularHtml}</td>
            <td class="text-center"><div>${esc(r.reqMain)}</div>${r.reqSub ? `<div class="fst-italic small text-muted">${esc(r.reqSub)}</div>` : ''}</td>
            <td class="text-center"><div>${esc(r.aqMain)}</div>${r.aqSub ? `<div class="fst-italic small text-muted">${esc(r.aqSub)}</div>` : ''}</td>
            <td><div>${esc(r.vendorMain)}</div>${r.vendorSub ? `<div class="fst-italic small text-muted">${esc(r.vendorSub)}</div>` : ''}</td>
            <td class="text-end">${r.showPrice ? '₹' + r.unitAmount : '-'}</td>
            <td class="text-end">${r.showPrice ? '₹' + r.rowAmount : '-'}</td>
        </tr>`).join('');
        return hdr + body;
    }).join('');

    const expensesHtml = m.validExpenses.map(e => `<tr><td colspan="6" class="text-end"><strong>${esc(e.label)}</strong></td><td class="text-end">₹${e.amount.toFixed(2)}</td></tr>`).join('');
    const stockRowsHtml = m.stockSummaryRows.map(s => `<tr>
        <td class="text-center">${s.slNo}</td><td>${s.itemHtml}</td>
        <td class="text-center">${esc(s.beforeQty)}</td><td class="text-center">${esc(s.beforeSub)}</td>
        <td class="text-center">${esc(s.afterQty)}</td><td class="text-center">${esc(s.afterSub)}</td>
        <td class="text-center">${s.thresholdDisplay ? esc(s.thresholdDisplay) : '<span class="fst-italic text-muted">Not set</span>'}</td>
    </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><title>Stock Report</title><style>
        body { font-family: Arial, sans-serif; color: #111; margin: 24px; font-size: 12px; }
        .report-title { text-align: center; font-size: 20px; font-weight: 800; margin-bottom: 4px; }
        .report-subtitle { text-align: center; font-size: 14px; margin-bottom: 14px; }
        .meta-grid { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 10px; }
        hr.divider { border: 0; border-top: 1.5px solid #222; margin: 10px 0 16px; }
        table.rep-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
        table.rep-table th, table.rep-table td { border: 1px solid #333; padding: 6px 8px; vertical-align: top; }
        table.rep-table th { background: #f1f5f9; text-align: center; }
        .text-center { text-align: center; } .text-end { text-align: right; }
        .fst-italic { font-style: italic; } .small { font-size: 11px; } .text-muted { color: #555; }
        .foot { margin-top: 14px; font-style: italic; font-size: 10px; color: #555; }
    </style></head><body>
        <div class="report-title">${esc(m.labName)}</div>
        <div class="report-subtitle">REPORT OF PROCUREMENT TITLED : <em>${esc(m.listTitle)}</em></div>
        <div class="meta-grid">
            <div><div><strong>Date of list creation:</strong> ${esc(m.createdDate)}</div><div><strong>Last date of procurement:</strong> ${esc(m.lastProcDate)}</div></div>
            <div style="text-align:right;"><div><strong>Date of report preparation:</strong> ${esc(m.prepDate)}</div><div><strong>Prepared by:</strong> ${esc(m.preparedBy)}</div></div>
        </div>
        <hr class="divider">
        <table class="rep-table">
            <thead><tr><th>Sl. No.</th><th>Particulars</th><th>Required Qty</th><th>Acquired Qty</th><th>Vendor &amp; Bill No.</th><th>Unit Price</th><th>Total Amount</th></tr></thead>
            <tbody>${procRowsHtml}
                <tr><td colspan="6" class="text-end"><strong>Sub Total</strong></td><td class="text-end"><strong>₹${m.subTotal.toFixed(2)}</strong></td></tr>
                ${expensesHtml}
                <tr><td colspan="6" class="text-end"><strong>Grand Total</strong></td><td class="text-end"><strong>₹${m.grandTotal.toFixed(2)}</strong></td></tr>
            </tbody>
        </table>
        ${m.hasIncompleteItem ? `<div class="fst-italic small mb-2">*Not acquired completely</div>` : ''}
        <h4>Stock Summary</h4>
        <table class="rep-table">
            <thead>
                <tr><th rowspan="2">Sl. No.</th><th rowspan="2">Item &amp; Specifications</th><th colspan="2">Before Purchase</th><th colspan="2">After Purchase</th><th rowspan="2">Threshold Qty</th></tr>
                <tr><th>Qty</th><th>Sub Qty &amp; Unit</th><th>Qty</th><th>Sub Qty &amp; Unit</th></tr>
            </thead>
            <tbody>${stockRowsHtml}</tbody>
        </table>
        ${buildBudgetTableHtml(m.budgetRows)}
        <div class="foot">${esc(m.includedNote)}</div>
    </body></html>`;
    const win = window.open('', '', 'width=1024,height=720');
    win.document.write(html); win.document.close(); win.focus(); win.print();
}

async function downloadProcurementSummaryPdf() {
    const m = await buildStockReportModel();
    const inst = bootstrap.Modal.getInstance(document.getElementById('procSummaryModal'));
    if (inst) inst.hide();

    const doc = new jspdf.jsPDF('landscape');
    const pageW = doc.internal.pageSize.getWidth();

    doc.setFontSize(16); doc.setFont(undefined, 'bold');
    doc.text(m.labName, pageW / 2, 14, { align: 'center' });
    doc.setFontSize(11); doc.setFont(undefined, 'normal');
    doc.text(`REPORT OF PROCUREMENT TITLED : ${m.listTitle}`, pageW / 2, 21, { align: 'center' });

    doc.setFontSize(9.5);
    doc.text(`Date of list creation: ${m.createdDate}`, 14, 29);
    doc.text(`Last date of procurement: ${m.lastProcDate}`, 14, 34);
    doc.text(`Date of report preparation: ${m.prepDate}`, pageW - 14, 29, { align: 'right' });
    doc.text(`Prepared by: ${m.preparedBy}`, pageW - 14, 34, { align: 'right' });
    doc.line(14, 38, pageW - 14, 38);

    const procBody = [];
    m.procGroups.forEach(g => {
        procBody.push([{ content: `${g.title} (${g.rows.length})`, colSpan: 7, styles: { fontStyle: 'bold', fillColor: [233, 236, 239] } }]);
        g.rows.forEach(r => {
            procBody.push([
                r.slNo, r.particularPlain,
                r.reqSub ? `${r.reqMain}\n${r.reqSub}` : r.reqMain,
                r.aqSub ? `${r.aqMain}\n${r.aqSub}` : r.aqMain,
                r.vendorSub ? `${r.vendorMain}\n${r.vendorSub}` : r.vendorMain,
                r.showPrice ? `Rs. ${r.unitAmount}` : "-",
                r.showPrice ? `Rs. ${r.rowAmount}` : "-"
            ]);
        });
    });
    procBody.push([{ content: "Sub Total", colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } }, { content: `Rs. ${m.subTotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold' } }]);
    m.validExpenses.forEach(e => procBody.push([{ content: e.label, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold' } }, { content: `Rs. ${e.amount.toFixed(2)}`, styles: { halign: 'right' } }]));
    procBody.push([{ content: "Grand Total", colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 244, 248] } }, { content: `Rs. ${m.grandTotal.toFixed(2)}`, styles: { halign: 'right', fontStyle: 'bold', fillColor: [240, 244, 248] } }]);

    doc.autoTable({
        head: [["Sl. No.", "Particulars", "Required Qty", "Acquired Qty", "Vendor & Bill No.", "Unit Price", "Total Amount"]],
        body: procBody, startY: 42,
        styles: { fontSize: 8, cellPadding: 2.5, valign: 'top' },
        headStyles: { fillColor: [33, 37, 41], halign: 'center' }
    });

    let curY = doc.lastAutoTable.finalY + 6;
    if (m.hasIncompleteItem) { doc.setFontSize(8.5); doc.setFont(undefined, 'italic'); doc.text("*Not acquired completely", 14, curY); doc.setFont(undefined, 'normal'); curY += 6; }

    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.text("Stock Summary", 14, curY);

    doc.autoTable({
        head: [
            [{ content: "Sl. No.", rowSpan: 2 }, { content: "Item & Specifications", rowSpan: 2 }, { content: "Before Purchase", colSpan: 2 }, { content: "After Purchase", colSpan: 2 }, { content: "Threshold Qty", rowSpan: 2 }],
            ["Qty", "Sub Qty & Unit", "Qty", "Sub Qty & Unit"]
        ],
        body: m.stockSummaryRows.map(s => [s.slNo, s.itemPlain, s.beforeQty, s.beforeSub, s.afterQty, s.afterSub, s.thresholdDisplay || "Not set"]),
        startY: curY + 3, styles: { fontSize: 8, valign: 'top' }, headStyles: { fillColor: [33, 37, 41], halign: 'center' }
    });

    let finalY = doc.lastAutoTable.finalY + 7;
    if (m.budgetRows && m.budgetRows.length > 0) {
        finalY = appendBudgetTableToPdf(doc, m.budgetRows, finalY);
    }

    doc.setFontSize(7.5); doc.setFont(undefined, 'italic');
    doc.text(m.includedNote, 14, finalY + 2);
    doc.save(`Stock_Report_${m.prepDate.replace(/\//g, '-')}.pdf`);
}

// -------------------------------------------------------------
// BILLS UPLOAD, RENAME & VIEW (Google Drive)
// -------------------------------------------------------------
async function openBillsModal() {
    const listName = document.getElementById('listSelector').value;
    if (!listName) return alert("Please select a requirement list first.");
    document.getElementById('billsListTitle').innerText = listName;
    document.getElementById('billsFolderPath').innerText = listName;
    document.getElementById('billRefPrefix').value = "";
    document.getElementById('billFileInput').value = "";
    document.getElementById('billsFolderLink').style.display = "none";
    bootstrap.Modal.getOrCreateInstance(document.getElementById('billsModal')).show();
    await loadListBills(listName);
}

async function loadListBills(listName) {
    const container = document.getElementById('billsListContainer');
    container.innerHTML = `<div class="p-3 text-center text-muted small"><i class="bi bi-hourglass-split"></i> Loading uploaded bills...</div>`;
    try {
        const res = await apiPost({ action: "getListBills", listName });
        if (res.status === "success") {
            const folderLink = document.getElementById('billsFolderLink');
            if (res.folderUrl) { folderLink.href = res.folderUrl; folderLink.style.display = "inline"; }
            const files = res.files || [];
            if (files.length === 0) {
                container.innerHTML = `<div class="p-3 text-center text-muted small fst-italic">No bills uploaded for this list yet.</div>`;
                return;
            }
            container.innerHTML = files.map(f => {
                const safeId = String(f.id).replace(/'/g, "\\'");
                const safeName = String(f.name).replace(/'/g, "\\'");
                const previewUrl = `https://drive.google.com/file/d/${f.id}/preview`;
                return `
                <div class="list-group-item d-flex justify-content-between align-items-center py-2 gap-2">
                    <div class="text-truncate">
                        <i class="bi bi-file-earmark-text text-success me-2"></i>
                        <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" class="fw-semibold text-decoration-none">${esc(f.name)}</a>
                        <small class="text-muted ms-2">${esc(f.date)}</small>
                    </div>
                    <div class="d-flex align-items-center gap-1 flex-shrink-0">
                        <button type="button" class="btn btn-sm btn-outline-primary py-0 px-2" onclick="openBillViewerModal('${esc(f.name)}', '${esc(previewUrl)}', '${esc(f.url)}')" title="Preview Bill">
                            <i class="bi bi-eye"></i>
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" onclick="renameBillFile('${safeId}', '${safeName}')" title="Rename Bill">
                            <i class="bi bi-pencil"></i> Rename
                        </button>
                    </div>
                </div>`;
            }).join('');
        } else {
            container.innerHTML = `<div class="p-3 text-center text-danger small">${esc(res.message || 'Failed to load bills.')}</div>`;
        }
    } catch (e) {
        container.innerHTML = `<div class="p-3 text-center text-danger small">Connection error while loading bills.</div>`;
    }
}

function uploadBillFile() {
    const listName = document.getElementById('listSelector').value;
    const fileInput = document.getElementById('billFileInput');
    const invoiceId = (document.getElementById('billRefPrefix').value || "").trim().replace(/[\\/:*?"<>|]/g, '_');

    if (!listName) return alert("Select a list first.");
    if (!invoiceId) return alert("Please enter the Invoice ID to use as the file name.");
    if (!fileInput.files || fileInput.files.length === 0) return alert("Please choose a bill file to upload.");

    const file = fileInput.files[0];
    if (file.size > 15 * 1024 * 1024) return alert("File is too large. Keep bill files under 15 MB.");

    const extMatch = file.name.match(/(\.[^.]+)$/);
    const ext = extMatch ? extMatch[1] : "";
    const finalName = `${invoiceId}${ext}`;

    const btn = document.getElementById('btnUploadBill');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Uploading...';
    btn.disabled = true;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const res = await apiPost({
                action: "uploadBill", listName, fileName: finalName,
                mimeType: file.type || "application/octet-stream",
                fileData: e.target.result.split(',')[1]
            });
            if (res.status === "success") {
                document.getElementById('billRefPrefix').value = "";
                fileInput.value = "";
                await loadListBills(listName);
            } else alert(res.message || "Upload failed.");
        } catch (err) {
            alert("Connection error while uploading bill.");
        } finally {
            btn.innerHTML = '<i class="bi bi-cloud-upload"></i> Upload Bill';
            btn.disabled = false;
        }
    };
    reader.readAsDataURL(file);
}

async function renameBillFile(fileId, currentName) {
    const currentBase = currentName.replace(/\.[^.]+$/, "");
    const newBase = prompt("Enter new Invoice ID / file name:", currentBase);
    if (!newBase || !newBase.trim() || newBase.trim() === currentBase) return;

    const listName = document.getElementById('listSelector').value;
    try {
        const res = await apiPost({
            action: "renameBill",
            fileId: fileId,
            newName: newBase.trim()
        });
        if (res.status === "success") {
            await loadListBills(listName);
        } else {
            alert(res.message || "Failed to rename bill.");
        }
    } catch (e) {
        alert("Connection error while renaming bill.");
    }
}

async function viewRowBill(invoiceId) {
    const listName = document.getElementById('listSelector').value;
    if (!listName || !invoiceId) return;

    try {
        const res = await apiPost({
            action: "getBillByInvoiceId",
            listName: listName,
            invoiceId: invoiceId
        });
        if (res.status === "success" && res.file) {
            openBillViewerModal(res.file.name, res.file.previewUrl, res.file.url);
        } else if (res.status === "not_found") {
            alert("Bill is not found!");
        } else {
            alert(res.message || "Could not load bill.");
        }
    } catch (e) {
        alert("Connection error while fetching bill.");
    }
}

function openBillViewerModal(title, previewUrl, externalUrl) {
    document.getElementById('billViewerTitle').innerText = title || "View Bill";
    document.getElementById('billViewerFrame').src = previewUrl;
    document.getElementById('billViewerExternalLink').href = externalUrl || previewUrl;

    const modalEl = document.getElementById('billViewerModal');
    modalEl.addEventListener('hidden.bs.modal', function onHide() {
        document.getElementById('billViewerFrame').src = "";
        modalEl.removeEventListener('hidden.bs.modal', onHide);
    });
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

// -------------------------------------------------------------
// INVENTORY DB & USER MANAGEMENT
// -------------------------------------------------------------
let inventorySearchTerm = "";
function openInventoryModal() {
    inventorySearchTerm = "";
    document.getElementById('invSearch').value = "";
    renderInventoryTable();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('inventoryModal')).show();
}

function renderInventoryTable() {
    const tbody = document.getElementById('invBody');
    const rawTerm = inventorySearchTerm.toLowerCase().trim();
    if (!rawTerm) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted p-4"><i class="bi bi-search fs-4 d-block mb-2"></i> Start typing to search DB...</td></tr>`;
        return;
    }
    const keywords = rawTerm.split(/[\s;,]+/).filter(Boolean);
    let count = 0, htmlBuffer = "";
    for (const [dbId, p] of Object.entries(productDB)) {
        if (count >= 50) break;
        const hay = `${p.item || ''} ${p.specs || ''} ${p.refLink || ''} ${p.prefComp || ''} ${p.code || ''} ${p.unit || ''} ${p.subQty || ''} ${p.subUnit || ''}`.toLowerCase();
        if (!keywords.every(kw => hay.includes(kw))) continue;
        let actionBtns = `<button class="btn btn-sm btn-outline-success py-0 px-1 me-1 text-nowrap" onclick="addFromInventory('${dbId}')"><i class="bi bi-plus-circle"></i> Add</button>`;
        if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
            actionBtns += `<button class="btn btn-sm btn-outline-warning py-0 px-1" onclick="openEditProduct('${dbId}')"><i class="bi bi-pencil-square"></i></button>
                           <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteProduct('${dbId}')"><i class="bi bi-trash"></i></button>`;
        }
        const pieceFlag = isPieceUnit(p.unit);
        htmlBuffer += `<tr>
            <td class="fw-bold">${esc(p.item)}</td>
            <td class="text-wrap"><div>${esc(p.specs)}</div>${formatRefHtml(p.refLink, 'inv-ref-line')}</td>
            <td>${esc(p.prefComp)}</td><td>${esc(p.code)}</td><td>${esc(p.unit)}</td>
            <td>${pieceFlag ? '-' : esc(p.subQty)}</td><td>${pieceFlag ? '-' : esc(p.subUnit)}</td>
            <td>${esc(p.estPrice)}</td><td class="text-center text-nowrap">${actionBtns}</td>
        </tr>`;
        count++;
    }
    tbody.innerHTML = count === 0 ? `<tr><td colspan="9" class="text-center text-danger p-3 fw-bold">No products matched.</td></tr>` : htmlBuffer;
}

function addFromInventory(dbId) {
    if (isCurrentListClosed()) return alert("Current list is closed.");
    const p = productDB[dbId];
    if (!p) return;
    collapsedGroups.toAcquire = false;
    const pieceFlag = isPieceUnit(p.unit);
    let newRow = {
        'Item': p.item, 'Item Specs': p.specs || '', 'Reference Link': p.refLink || '',
        'Preferred Company': p.prefComp || 'Any', 'Product Code': p.code || '',
        'Required Quantity': 1, 'Unit': p.unit || 'Piece',
        'Sub Quantity': pieceFlag ? '' : (p.subQty || ''), 'Sub Unit': pieceFlag ? '' : (p.subUnit || 'Piece'),
        'Acquired Qty': 0, 'Acquired Sub Qty': '', 'Acquired Sub Unit': '',
        'Estimated Price': p.estPrice || '', 'Selected Vendor': '', 'Total Estimate': '',
        'Bill Ref No': '', 'Bill Date': '', 'Bill Amount': '', 'Date of Procurement': '', 'Item Status': 'P',
        _isEditing: true, _isNew: true
    };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    renderTable();
}

function openEditProduct(dbId) {
    const p = productDB[dbId];
    document.getElementById('editDbId').value = dbId;
    document.getElementById('editItem').value = p.item;
    document.getElementById('editSpecs').value = p.specs || '';
    document.getElementById('editRefLink').value = p.refLink || '';
    document.getElementById('editComp').value = p.prefComp || 'Any';
    document.getElementById('editCode').value = p.code || '';
    document.getElementById('editUnit').value = p.unit || 'Piece';
    document.getElementById('editSubQty').value = p.subQty || '';
    document.getElementById('editSubUnit').value = p.subUnit || '';
    document.getElementById('editPrice').value = p.estPrice || '';
    toggleModalCode(); toggleModalSubQty();
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('fullEditModal')).show();
}

function toggleModalCode() {
    const comp = document.getElementById('editComp').value.trim().toLowerCase();
    const cBox = document.getElementById('editCode');
    if (comp === 'any' || comp === '') { cBox.value = ''; cBox.disabled = true; } else cBox.disabled = false;
}

function toggleModalSubQty() {
    const uVal = document.getElementById('editUnit').value;
    const sqBox = document.getElementById('editSubQty'), suBox = document.getElementById('editSubUnit');
    if (isPieceUnit(uVal)) { sqBox.value = ''; sqBox.disabled = true; suBox.value = ''; suBox.disabled = true; }
    else { sqBox.disabled = false; suBox.disabled = false; if (!suBox.value) suBox.value = 'Piece'; }
}

async function submitProductEdit() {
    const btn = document.querySelector('#fullEditModal .btn-success');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...'; btn.disabled = true;
    const unitVal = document.getElementById('editUnit').value.trim() || 'Piece';
    const pieceFlag = isPieceUnit(unitVal);
    await apiPost({
        action: "updateProduct", role: USER.role,
        product: {
            dbId: document.getElementById('editDbId').value,
            item: document.getElementById('editItem').value.trim(),
            specs: document.getElementById('editSpecs').value.trim(),
            refLink: document.getElementById('editRefLink').value.trim(),
            prefComp: document.getElementById('editComp').value.trim() || 'Any',
            code: document.getElementById('editCode').value.trim(),
            unit: unitVal, subQty: pieceFlag ? '' : document.getElementById('editSubQty').value.trim(),
            subUnit: pieceFlag ? '' : (document.getElementById('editSubUnit').value.trim() || 'Piece'),
            estPrice: document.getElementById('editPrice').value
        }
    });
    await fetchInitData();
    bootstrap.Modal.getInstance(document.getElementById('fullEditModal')).hide();
    renderInventoryTable();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('inventoryModal')).show();
    btn.innerHTML = '<i class="bi bi-floppy"></i> Save to DB'; btn.disabled = false;
}

async function deleteProduct(dbId) {
    if (confirm("Delete this product from the master DB?")) {
        await apiPost({ action: "deleteProduct", role: USER.role, dbId });
        await fetchInitData();
        renderInventoryTable();
    }
}

async function openUsersModal() {
    const res = await apiPost({ action: "manageUsers", subAction: "get", role: USER.role });
    if (res.status === "success") {
        document.getElementById('usersBody').innerHTML = res.users.map(u => `<tr>
            <td>${esc(u.username)}</td><td>${esc(u.role)}</td>
            <td class="text-center">${u.username === "admin" ? "" : `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteUser('${esc(u.username)}')"><i class="bi bi-trash"></i></button>`}</td>
        </tr>`).join('');
        bootstrap.Modal.getOrCreateInstance(document.getElementById('usersModal')).show();
    }
}

document.getElementById('addUserForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const res = await apiPost({
        action: "manageUsers", subAction: "add", role: USER.role,
        newUser: document.getElementById('newUName').value.trim(),
        newPass: document.getElementById('newUPass').value.trim(),
        newRole: document.getElementById('newURole').value
    });
    if (res.status === "success") { e.target.reset(); openUsersModal(); }
    else alert(res.message);
});

async function deleteUser(username) {
    if (confirm(`Delete user ${username}?`)) {
        await apiPost({ action: "manageUsers", subAction: "delete", role: USER.role, targetUser: username });
        openUsersModal();
    }
}

// -------------------------------------------------------------
// GLOBAL EVENT LISTENERS
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    function handleDatalist(e) {
        if (!e.target.matches('input[list]')) return;
        const term = e.target.value.toLowerCase().trim();
        const listId = e.target.getAttribute('list');
        const dataList = document.getElementById(listId);
        if (!dataList) return;
        const tr = e.target.closest('tr');
        const currentItem = (tr && tr.querySelector('.pItem')) ? tr.querySelector('.pItem').value.toLowerCase().trim() : "";

        let count = 0, optionsHTML = '';
        const added = new Set();
        for (const [, p] of Object.entries(productDB)) {
            if (count >= 50) break;
            let val = null;
            if (listId === 'itemList' && p.item && p.item.toLowerCase().includes(term)) val = p.item;
            else if (listId === 'specsList' && p.specs && p.specs.toLowerCase().includes(term)) {
                if (!currentItem || (p.item && p.item.toLowerCase() === currentItem)) val = p.specs;
            } else if (listId === 'compList' && p.prefComp && p.prefComp.toLowerCase().includes(term)) {
                if (!currentItem || (p.item && p.item.toLowerCase() === currentItem)) val = p.prefComp;
            }
            if (val && !added.has(val)) { added.add(val); optionsHTML += `<option value="${esc(val)}">`; count++; }
        }
        dataList.innerHTML = optionsHTML;
    }

    document.getElementById('tableBody').addEventListener('input', handleDatalist);
    document.getElementById('tableBody').addEventListener('click', handleDatalist);
    document.getElementById('tableBody').addEventListener('focusin', handleDatalist);

    document.getElementById('invSearch').addEventListener('input', function() {
        inventorySearchTerm = this.value;
        renderInventoryTable();
    });

    document.getElementById('searchInput').addEventListener('input', function() {
        const keywords = this.value.toLowerCase().trim().split(/[\s;,]+/).filter(Boolean);
        const rows = document.getElementById('tableBody').getElementsByTagName('tr');
        const visibleGroups = new Set();

        for (let i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('group-header-row')) continue;
            if (rows[i].classList.contains('table-warning')) {
                if (rows[i].dataset.group) visibleGroups.add(rows[i].dataset.group);
                continue;
            }
            if (keywords.length === 0) {
                rows[i].style.display = "";
                if (rows[i].dataset.group) visibleGroups.add(rows[i].dataset.group);
                continue;
            }
            const isMatch = keywords.every(kw => rows[i].innerText.toLowerCase().includes(kw));
            rows[i].style.display = isMatch ? "" : "none";
            if (isMatch && rows[i].dataset.group) visibleGroups.add(rows[i].dataset.group);
        }

        for (let i = 0; i < rows.length; i++) {
            if (!rows[i].classList.contains('group-header-row')) continue;
            const gKey = rows[i].dataset.groupHeader;
            rows[i].style.display = (keywords.length === 0 || visibleGroups.has(gKey)) ? "" : "none";
        }
    });
});
