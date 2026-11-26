const API_URL = "https://script.google.com/macros/s/AKfycbxkDBmVRgyuB8yKgLxx_-qAuQNI9z2xOEd-pzGt4QzNhXJ1aOc0WfDtENvxkYguRK9l/exec";

let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let activeVendors = [];
let vendorDB = [];
let globalAlerts = { unacquired: [], lowStock: [] };
let latestInheritedBudget = 0;
let currentExportType = "";
let collapsedGroups = { acquired: false, partly: false, toAcquire: false };

const BASE_HEADERS = [
    "SL No", "Item", "Item Specs", "Reference Link", "Preferred Company", "Product Code",
    "Required Quantity", "Unit", "Sub Quantity", "Sub Unit",
    "Acquired Qty", "Acquired Sub Qty", "Acquired Sub Unit",
    "Estimated Price", "Selected Vendor", "Total Estimate", "Bill Ref No", "Date of Procurement"
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

function truncatePdfLine(doc, text, maxWidth) {
    if (doc.getTextWidth(text) <= maxWidth) return text;
    const ellipsis = "...";
    const ellWidth = doc.getTextWidth(ellipsis);
    let out = text;
    while (out.length > 0 && doc.getTextWidth(out) + ellWidth > maxWidth) out = out.slice(0, -1);
    return out + ellipsis;
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
    if (disabledFlag) {
        return `<option value="" selected>-</option>`;
    }
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

// Shared localStorage login so Stock Register opens authenticated in a new tab
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
        document.getElementById('budgetInHand').disabled = false;
        document.getElementById('btnUpdateBudget').style.display = "block";
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
                listName: newName, username: USER.username, inheritedBudget: latestInheritedBudget
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

    document.getElementById('tableBody').innerHTML = '<tr><td colspan="25" class="text-center">Loading...</td></tr>';
    const listMeta = getCurrentListMeta();
    if (listMeta) document.getElementById('budgetInHand').value = listMeta.budget;
    updateClosedUI();

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
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="25" class="text-danger text-center">Load failed.</td></tr>';
    }
}

function updateClosedUI() {
    const closed = isCurrentListClosed();
    document.getElementById('listStatusBadge').style.display = closed ? 'inline-block' : 'none';
    document.getElementById('btnAddRow').disabled = closed;
    document.getElementById('btnAddVendor').disabled = closed;
    document.getElementById('btnOptimize').disabled = closed;
    document.getElementById('btnSaveEdits').disabled = closed;
    document.getElementById('btnCloseList').style.display = closed ? 'none' : 'inline-block';
    document.getElementById('btnReopenList').style.display = (closed && (USER.role === "Admin" || USER.role === "Lab Supervisor")) ? 'inline-block' : 'none';
}

// -------------------------------------------------------------
// ALERTS ENGINE (Unacquired Shortfalls + Low Stock Items)
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
    if (isCurrentListClosed()) {
        btn.style.display = 'none';
        return;
    }
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
        const inputId = `alertUnacqQty_${idx}`;
        const subInfo = (!isPieceUnit(a.unit) && a.subQty) ? `<br><span class="text-muted">${esc(a.subQty)} ${esc(a.subUnit || 'Piece')}</span>` : '';
        html += `<tr class="alert-row-unacq">
            <td><span class="badge bg-danger">Unacquired</span></td>
            <td>
                <div class="fw-bold">${esc(a.item)}</div>
                <div class="small text-muted">${esc(a.specs)}</div>
            </td>
            <td class="small">
                From list: <strong>${esc(a.sourceList)}</strong><br>
                Req: ${a.reqQty} | Acq: ${a.acqQty} | <span class="text-danger fw-bold">Pending: ${a.shortfall}</span>
            </td>
            <td class="small">${esc(a.unit)}${subInfo}</td>
            <td><input type="number" id="${inputId}" class="form-control form-control-sm" min="1" value="${a.shortfall}"></td>
            <td class="text-center text-nowrap">
                <button class="btn btn-sm btn-success py-0 px-2" onclick="addAlertItemToList('unacq', ${idx})"><i class="bi bi-plus-circle"></i> Add</button>
                <button class="btn btn-sm btn-outline-secondary py-0 px-2 ms-1" onclick="dismissAlertItem('${esc(a.alertKey)}')">Ignore</button>
            </td>
        </tr>`;
    });

    lowStock.forEach((a, idx) => {
        const inputId = `alertLowQty_${idx}`;
        const remText = a.subPerUnit > 1 ? `${a.totalBase} ${a.subLabel || 'Piece'}` : `${a.totalBase} ${a.unit}`;
        const subInfo = (!isPieceUnit(a.unit) && a.subQty) ? `<br><span class="text-muted">${esc(a.subQty)} ${esc(a.subUnit || 'Piece')}</span>` : '';
        html += `<tr class="alert-row-lowstk">
            <td><span class="badge bg-warning text-dark">Low Stock</span></td>
            <td>
                <div class="fw-bold">${esc(a.item)}</div>
                <div class="small text-muted">${esc(a.specs)}</div>
            </td>
            <td class="small">
                Stock: <strong class="text-danger">${esc(remText)}</strong> | Threshold: <strong>${a.threshold}</strong><br>
                Prev Acquired Qty: ${a.prevAcqQty}
            </td>
            <td class="small">${esc(a.unit)}${subInfo}</td>
            <td><input type="number" id="${inputId}" class="form-control form-control-sm" min="1" value="${a.prevAcqQty || 1}"></td>
            <td class="text-center text-nowrap">
                <button class="btn btn-sm btn-primary py-0 px-2" onclick="addAlertItemToList('lowstk', ${idx})"><i class="bi bi-plus-circle"></i> Add</button>
                <button class="btn btn-sm btn-outline-secondary py-0 px-2 ms-1" onclick="dismissAlertItem('${esc(a.alertKey)}')">Ignore</button>
            </td>
        </tr>`;
    });

    if (!html) {
        html = `<tr><td colspan="6" class="text-center text-muted p-4">No pending alerts for this list.</td></tr>`;
    }
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
        const curQty = parseFloat(currentListData[existingIdx]['Required Quantity']) || 0;
        currentListData[existingIdx]['Required Quantity'] = curQty + qtyToAdd;
    } else {
        collapsedGroups.toAcquire = false;
        const pieceFlag = isPieceUnit(item.unit);
        let newRow = {
            'Item': item.item,
            'Item Specs': item.specs || '',
            'Reference Link': item.refLink || '',
            'Preferred Company': item.prefComp || 'Any',
            'Product Code': item.code || '',
            'Required Quantity': qtyToAdd,
            'Unit': item.unit || 'Piece',
            'Sub Quantity': pieceFlag ? '' : (item.subQty || ''),
            'Sub Unit': pieceFlag ? '' : (item.subUnit || 'Piece'),
            'Acquired Qty': 0,
            'Acquired Sub Qty': '',
            'Acquired Sub Unit': '',
            'Estimated Price': item.estPrice || '',
            'Selected Vendor': '',
            'Total Estimate': '',
            'Bill Ref No': '',
            'Date of Procurement': '',
            _isEditing: false
        };
        activeVendors.forEach(v => newRow[v] = "");
        currentListData.push(newRow);
    }

    await apiPost({
        action: "manageList", subAction: "dismissAlert",
        listName: document.getElementById('listSelector').value,
        alertKey: item.alertKey
    });

    if (type === 'lowstk' && item.stockId) {
        await apiPost({ action: "markStockReqPlaced", stockId: item.stockId });
    }

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
        const msg = `${pending.length} item(s) are not yet fully acquired:\n\n${names}${pending.length > 6 ? '\n...' : ''}\n\nIf you close this list now, these unacquired items will automatically be flagged for inheritance into the next list you create.\n\nProceed to close "${lName}"?`;
        if (!confirm(msg)) return;
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
// MAIN TABLE RENDERING (WITH COLLAPSIBLE ACQUISITION GROUPS)
// -------------------------------------------------------------
function toggleCode(elem) {
    const tr = elem.closest('tr');
    const codeInput = tr.querySelector('.pCode');
    const val = elem.value.trim().toLowerCase();
    if (val === 'any' || val === '') {
        codeInput.value = '';
        codeInput.disabled = true;
    } else {
        codeInput.disabled = false;
    }
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
        <th>Bill Ref No</th>
        <th>Proc. Date</th>
        ${vendorHeaders}
    </tr>`;

    const tbody = document.getElementById('tableBody');
    let total = 0;
    let acquiredCount = 0;
    let savedCount = 0;

    // Partition rows into the 3 acquisition groups while preserving each row's true index (i)
    const buckets = { toAcquire: [], acquired: [], partly: [] };
    currentListData.forEach((row, i) => {
        const reqQty = parseFloat(row['Required Quantity']) || 0;
        const acqQty = parseFloat(row['Acquired Qty']) || 0;
        if (!row._isEditing) {
            savedCount++;
            if (reqQty > 0 && acqQty >= reqQty) acquiredCount++;
            total += (parseFloat(row['Total Estimate']) || 0);
        }
        const key = row._isNew ? 'toAcquire' : getRowGroupKey(row);
        buckets[key].push({ row, i });
    });

    // Display order: Items to Acquire (colourless) -> Acquired Items (pale green) -> Partly Acquired Items (pale yellow)
    const groupDefs = [
        { key: 'toAcquire', label: 'Items to Acquire',      css: 'group-pending' },
        { key: 'acquired',  label: 'Acquired Items',        css: 'group-acquired' },
        { key: 'partly',    label: 'Partly Acquired Items', css: 'group-partly' }
    ];

    const showGroupHeaders = (buckets.acquired.length > 0 || buckets.partly.length > 0);
    const totalCols = 18 + activeVendors.length;
    let rowsHTML = "";

    groupDefs.forEach(g => {
        const items = buckets[g.key];
        if (items.length === 0) return;

        const isCollapsed = showGroupHeaders && collapsedGroups[g.key];

        if (showGroupHeaders) {
            const icon = isCollapsed ? 'bi-caret-right-fill' : 'bi-caret-down-fill';
            rowsHTML += `<tr class="group-header-row ${g.css}" data-group-header="${g.key}" onclick="toggleGroup('${g.key}')">
                <td colspan="${totalCols}">
                    <span class="group-header-sticky">
                        <i class="bi ${icon}"></i> ${g.label} <span class="badge bg-dark">${items.length}</span>
                    </span>
                </td>
            </tr>`;
        }

        if (isCollapsed) return;

        items.forEach(({ row, i }, displayIdx) => {
            const reqQty = parseFloat(row['Required Quantity']) || 0;
            const acqQty = parseFloat(row['Acquired Qty']) || 0;
            const totalEst = parseFloat(row['Total Estimate']) || 0;
            const unitVal = row['Unit'] || 'Piece';
            const pieceFlag = isPieceUnit(unitVal);
            const subUnitVal = pieceFlag ? '' : (row['Sub Unit'] || 'Piece');

            if (!row._isEditing) {
                let selVendor = row['Selected Vendor'] || '';
                let acqBadgeClass = acqQty >= reqQty && reqQty > 0 ? 'text-success fw-bold' : (acqQty > 0 ? 'text-warning fw-bold' : 'text-muted');

                let vendorCells = activeVendors.map(v => {
                    let vPrice = row[v] ?? '';
                    let isNA = vPrice === 'NA';
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

                rowsHTML += `<tr data-group="${g.key}">
                    <td class="sticky-col-0">${displayIdx + 1}</td>
                    <td class="sticky-col-1 text-center text-nowrap">
                        <button class="btn btn-sm btn-outline-primary py-0 px-1" onclick="editRow(${i})" title="Edit" ${closed ? 'disabled' : ''}><i class="bi bi-pencil-square"></i></button>
                        <button class="btn btn-sm btn-outline-secondary py-0 px-1 ms-1" onclick="duplicateRow(${i})" title="Duplicate Row" ${closed ? 'disabled' : ''}><i class="bi bi-copy"></i></button>
                        <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteRow(${i})" title="Delete" ${closed ? 'disabled' : ''}><i class="bi bi-trash"></i></button>
                    </td>
                    <td class="sticky-col-2 fw-bold">${esc(row['Item'])}</td>
                    <td class="sticky-col-3 specs-col text-wrap">
                        <div>${esc(row['Item Specs'])}</div>
                        ${formatRefHtml(row['Reference Link'])}
                    </td>
                    <td>${esc(row['Preferred Company'])}</td>
                    <td>${esc(row['Product Code'])}</td>

                    <td><input type="number" class="form-control form-control-sm number-box" value="${esc(row['Required Quantity'])}" min="1" onchange="updateLiveRow(${i}, 'Required Quantity', this.value)" ${closed ? 'disabled' : ''}></td>
                    <td>
                        <select class="form-select form-select-sm number-box" onchange="updateLiveUnit(${i}, this)" ${closed ? 'disabled' : ''}>
                            ${buildUnitOptions(unitVal)}
                        </select>
                    </td>
                    <td>
                        <input type="number" step="any" min="0" id="liveSubQty_${i}" class="form-control form-control-sm number-box"
                               value="${pieceFlag ? '' : esc(row['Sub Quantity'])}"
                               placeholder="${pieceFlag ? '-' : '100'}"
                               onchange="updateLiveRow(${i}, 'Sub Quantity', this.value)"
                               ${(pieceFlag || closed) ? 'disabled' : ''}>
                    </td>
                    <td>
                        <select id="liveSubUnit_${i}" class="form-select form-select-sm sub-unit-box"
                                onchange="updateLiveSubUnit(${i}, this)"
                                ${(pieceFlag || closed) ? 'disabled' : ''}>
                            ${buildSubUnitOptions(subUnitVal, pieceFlag)}
                        </select>
                    </td>
                    <td class="text-center ${acqBadgeClass}">${acqQty || 0}</td>
                    <td class="text-center small text-muted">${esc(row['Acquired Sub Qty'] || '-')}</td>
                    <td class="text-center small text-muted">${esc(row['Acquired Sub Unit'] || '-')}</td>
                    <td><input type="number" step="0.01" class="form-control form-control-sm number-box" value="${esc(row['Estimated Price'])}" onchange="updateLiveRow(${i}, 'Estimated Price', this.value)" ${closed ? 'disabled' : ''}></td>

                    <td class="fw-bold text-primary">${esc(selVendor)}</td>
                    <td class="fw-bold text-success" id="rowTotal_${i}">₹${totalEst.toFixed(2)}</td>
                    <td class="small text-nowrap">${esc(row['Bill Ref No'] || '-')}</td>
                    <td class="small text-nowrap">${esc(row['Date of Procurement'] || '-')}</td>
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
                    <td>
                        <select class="form-select form-select-sm pUnit number-box" onchange="handleEditUnitChange(this)">
                            ${buildUnitOptions(unitVal)}
                        </select>
                    </td>
                    <td>
                        <input type="number" step="any" min="0" class="form-control form-control-sm pSubQty number-box"
                               value="${pieceFlag ? '' : esc(row['Sub Quantity'])}"
                               placeholder="${pieceFlag ? '-' : '100'}"
                               ${pieceFlag ? 'disabled' : ''}>
                    </td>
                    <td>
                        <select class="form-select form-select-sm pSubUnit sub-unit-box"
                                onchange="handleEditSubUnitChange(this)"
                                ${pieceFlag ? 'disabled' : ''}>
                            ${buildSubUnitOptions(subUnitVal, pieceFlag)}
                        </select>
                    </td>
                    <td class="text-center text-muted small">${acqQty || 0}</td>
                    <td class="text-center text-muted small">${esc(row['Acquired Sub Qty'] || '-')}</td>
                    <td class="text-center text-muted small">${esc(row['Acquired Sub Unit'] || '-')}</td>
                    <td><input type="number" step="0.01" class="form-control form-control-sm pEstPrice number-box" value="${esc(row['Estimated Price'])}"></td>
                    <td colspan="4" class="text-muted small text-center">Save row first</td>
                    ${blankVendorCells}
                </tr>`;
            }
        });
    });

    tbody.innerHTML = rowsHTML;
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    document.getElementById('listProgressSummary').innerText = savedCount > 0
        ? `Procurement Progress: ${acquiredCount} / ${savedCount} item(s) fully acquired`
        : '';
    calcBalance();
}

function handleEditUnitChange(sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new unit type (e.g. Bottle, Vial, Pack):");
        if (u && u.trim()) {
            const cleanU = u.trim();
            sel.add(new Option(cleanU, cleanU), sel.options[0]);
            sel.value = cleanU;
        } else {
            sel.value = "Piece";
        }
    }
    toggleSubQtyInput(sel);
}

function handleEditSubUnitChange(sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new sub-unit type (e.g. Piece, mL, g, Pair):");
        if (u && u.trim()) {
            const cleanU = u.trim();
            sel.add(new Option(cleanU, cleanU), sel.options[0]);
            sel.value = cleanU;
        } else {
            sel.value = "Piece";
        }
    }
}

function toggleSubQtyInput(unitSel) {
    const tr = unitSel.closest('tr');
    if (!tr) return;
    const subInput = tr.querySelector('.pSubQty');
    const subUnitSel = tr.querySelector('.pSubUnit');
    if (!subInput || !subUnitSel) return;

    if (isPieceUnit(unitSel.value)) {
        subInput.value = '';
        subInput.placeholder = '-';
        subInput.disabled = true;

        subUnitSel.innerHTML = buildSubUnitOptions('', true);
        subUnitSel.disabled = true;
    } else {
        subInput.disabled = false;
        subInput.placeholder = '100';

        const prevSubUnit = subUnitSel.value || 'Piece';
        subUnitSel.disabled = false;
        subUnitSel.innerHTML = buildSubUnitOptions(prevSubUnit, false);
        if (!subInput.value) subInput.focus();
    }
}

// -------------------------------------------------------------
// LIVE UPDATE & CALCULATION ENGINE
// -------------------------------------------------------------
function updateLiveRow(i, field, val) {
    currentListData[i][field] = val;

    if (field === 'Required Quantity') {
        let sv = currentListData[i]['Selected Vendor'];
        if (sv && currentListData[i][sv] && currentListData[i][sv] !== 'NA') {
            let price = parseFloat(currentListData[i][sv]) || 0;
            let qty = parseFloat(val) || 0;
            currentListData[i]['Total Estimate'] = (price * qty).toFixed(2);
        }
        calcTotal();
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
        currentListData[i]['Sub Quantity'] = '';
        currentListData[i]['Sub Unit'] = '';
    } else if (!currentListData[i]['Sub Unit']) {
        currentListData[i]['Sub Unit'] = 'Piece';
    }
    renderTable();

    if (!isPieceUnit(currentListData[i]['Unit'])) {
        const subInput = document.getElementById(`liveSubQty_${i}`);
        if (subInput && !subInput.value) subInput.focus();
    }
}

function updateLiveSubUnit(i, sel) {
    if (sel.value === "_NEW_") {
        const u = prompt("Enter new sub-unit type (e.g. Piece, mL, g, Pair):");
        if (u && u.trim()) {
            currentListData[i]['Sub Unit'] = u.trim();
        } else {
            sel.value = currentListData[i]['Sub Unit'] || 'Piece';
            return;
        }
    } else {
        currentListData[i]['Sub Unit'] = sel.value;
    }
    renderTable();
}

function updateVendorPrice(i, v, val) {
    currentListData[i][v] = val;
    if (currentListData[i]['Selected Vendor'] === v) {
        let price = parseFloat(val) || 0;
        let qty = parseFloat(currentListData[i]['Required Quantity']) || 0;
        currentListData[i]['Total Estimate'] = (price * qty).toFixed(2);
        const totalCell = document.getElementById(`rowTotal_${i}`);
        if (totalCell) totalCell.innerText = '₹' + (price * qty).toFixed(2);
    }
    calcTotal();
}

function selectVendor(i, v) {
    currentListData[i]['Selected Vendor'] = v;
    let price = parseFloat(currentListData[i][v]) || 0;
    let qty = parseFloat(currentListData[i]['Required Quantity']) || 0;
    currentListData[i]['Total Estimate'] = (price * qty).toFixed(2);
    calcTotal();
    renderTable();
}

function calcTotal() {
    let total = 0;
    currentListData.forEach(r => { total += parseFloat(r['Total Estimate']) || 0; });
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
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
            if (![...uSel.options].some(o => o.value.toLowerCase() === mUnit.toLowerCase())) {
                uSel.add(new Option(mUnit, mUnit), uSel.options[0]);
            }
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
            currentListData[i]['Total Estimate'] = '';
        }
    }
    renderTable();
}

function optimizeVendors() {
    currentListData.forEach(row => {
        if (row._isEditing) return;
        let bestVendor = '';
        let minPrice = Infinity;
        activeVendors.forEach(v => {
            let p = parseFloat(row[v]);
            if (!isNaN(p) && p > 0 && p < minPrice && row[v] !== 'NA') {
                minPrice = p;
                bestVendor = v;
            }
        });
        if (bestVendor) {
            row['Selected Vendor'] = bestVendor;
            let qty = parseFloat(row['Required Quantity']) || 0;
            row['Total Estimate'] = (minPrice * qty).toFixed(2);
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
        'Bill Ref No': '', 'Date of Procurement': ''
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
    clonedRow['Date of Procurement'] = '';
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
    else {
        currentListData[i] = currentListData[i]._origState;
        currentListData[i]._isEditing = false;
    }
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
        'Item': item,
        'Item Specs': specs,
        'Reference Link': refLink,
        'Preferred Company': tr.querySelector('.pComp').value.trim() || 'Any',
        'Product Code': tr.querySelector('.pCode').value.trim(),
        'Required Quantity': qty,
        'Unit': unitVal,
        'Sub Quantity': subQtyVal,
        'Sub Unit': subUnitVal,
        'Acquired Qty': orig['Acquired Qty'] || 0,
        'Acquired Sub Qty': orig['Acquired Sub Qty'] || '',
        'Acquired Sub Unit': orig['Acquired Sub Unit'] || '',
        'Estimated Price': tr.querySelector('.pEstPrice').value,
        'Selected Vendor': sv,
        'Bill Ref No': orig['Bill Ref No'] || '',
        'Date of Procurement': orig['Date of Procurement'] || '',
        _isEditing: false
    };

    activeVendors.forEach(v => {
        currentListData[i][v] = orig[v] !== undefined ? orig[v] : '';
    });

    if (sv && currentListData[i][sv] && currentListData[i][sv] !== 'NA') {
        currentListData[i]['Total Estimate'] = (parseFloat(currentListData[i][sv]) * qty).toFixed(2);
    } else {
        currentListData[i]['Total Estimate'] = '';
    }

    const btns = tr.querySelectorAll('button');
    btns[0].innerHTML = '<i class="bi bi-hourglass-split"></i>';
    btns[0].disabled = true;
    btns[1].disabled = true;

    await syncTableToBackend();
}

async function saveTableEdits() {
    if (isCurrentListClosed()) return;
    const btn = document.getElementById('btnSaveEdits');
    btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Saving...`;
    btn.disabled = true;
    await syncTableToBackend();
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
        globalAlerts = initRes.alerts || globalAlerts;
        renderTable();
        updateAlertBadge();
    } catch (e) {
        alert("Failed to sync list.");
        renderTable();
    }
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
    latestInheritedBudget = b;
    alert("Budget saved.");
}

function manageList() {
    const lName = document.getElementById('listSelector').value;
    if (!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    document.getElementById('listRename').value = lName;
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    document.getElementById('listQuoteAddress').value = meta.quoteAddress || '';

    if (USER.role === "Admin" || USER.role === "Lab Supervisor" || meta.owner === USER.username) {
        document.getElementById('listRename').disabled = false;
    } else {
        document.getElementById('listRename').disabled = true;
    }
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
    await apiPost({
        action: "manageList", subAction: "updateMeta",
        listName: document.getElementById('listSelector').value,
        collabs: document.getElementById('listCollabs').value,
        quoteAddress: document.getElementById('listQuoteAddress').value
    });
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

// -------------------------------------------------------------
// VIRTUALIZED INVENTORY DB MODAL
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

    if (rawTerm.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted p-4"><i class="bi bi-search fs-4 d-block mb-2"></i> Start typing to search DB...</td></tr>`;
        return;
    }

    const keywords = rawTerm.split(/[\s;,]+/).filter(kw => kw.length > 0);
    let count = 0;
    const MAX_RESULTS = 50;
    let htmlBuffer = "";

    for (const [dbId, p] of Object.entries(productDB)) {
        if (count >= MAX_RESULTS) break;
        const searchableText = `${p.item || ''} ${p.specs || ''} ${p.refLink || ''} ${p.prefComp || ''} ${p.code || ''} ${p.unit || ''} ${p.subQty || ''} ${p.subUnit || ''}`.toLowerCase();

        if (!keywords.every(kw => searchableText.includes(kw))) continue;

        let actionBtns = `<button class="btn btn-sm btn-outline-success py-0 px-1 me-1 text-nowrap" onclick="addFromInventory('${dbId}')"><i class="bi bi-plus-circle"></i> Add</button>`;
        if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
            actionBtns += `<button class="btn btn-sm btn-outline-warning py-0 px-1" onclick="openEditProduct('${dbId}')"><i class="bi bi-pencil-square"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteProduct('${dbId}')"><i class="bi bi-trash"></i></button>`;
        }

        const pieceFlag = isPieceUnit(p.unit);
        htmlBuffer += `<tr>
            <td class="fw-bold">${esc(p.item)}</td>
            <td class="text-wrap">
                <div>${esc(p.specs)}</div>
                ${formatRefHtml(p.refLink, 'inv-ref-line')}
            </td>
            <td>${esc(p.prefComp)}</td>
            <td>${esc(p.code)}</td>
            <td>${esc(p.unit)}</td>
            <td>${pieceFlag ? '-' : esc(p.subQty)}</td>
            <td>${pieceFlag ? '-' : esc(p.subUnit)}</td>
            <td>${esc(p.estPrice)}</td>
            <td class="text-center text-nowrap">${actionBtns}</td>
        </tr>`;
        count++;
    }

    if (count === 0) {
        const kwString = keywords.map(k => `"${esc(k)}"`).join(", ");
        htmlBuffer = `<tr><td colspan="9" class="text-center text-danger p-3 fw-bold"><i class="bi bi-exclamation-triangle"></i> No products matched all keywords: ${kwString}</td></tr>`;
    } else if (count === MAX_RESULTS) {
        htmlBuffer += `<tr><td colspan="9" class="text-center text-muted bg-light">Showing top ${MAX_RESULTS} results...</td></tr>`;
    }
    tbody.innerHTML = htmlBuffer;
}

function addFromInventory(dbId) {
    if (isCurrentListClosed()) return alert("Current list is closed. Select or create an open list.");
    const p = productDB[dbId];
    if (!p) return;
    collapsedGroups.toAcquire = false;
    const pieceFlag = isPieceUnit(p.unit);
    let newRow = {
        'Item': p.item,
        'Item Specs': p.specs || '',
        'Reference Link': p.refLink || '',
        'Preferred Company': p.prefComp || 'Any',
        'Product Code': p.code || '',
        'Required Quantity': 1,
        'Unit': p.unit || 'Piece',
        'Sub Quantity': pieceFlag ? '' : (p.subQty || ''),
        'Sub Unit': pieceFlag ? '' : (p.subUnit || 'Piece'),
        'Acquired Qty': 0,
        'Acquired Sub Qty': '',
        'Acquired Sub Unit': '',
        'Estimated Price': p.estPrice || '',
        'Selected Vendor': '',
        'Total Estimate': '',
        'Bill Ref No': '',
        'Date of Procurement': '',
        _isEditing: true,
        _isNew: true
    };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    renderTable();
    const tContainer = document.querySelector('.table-responsive');
    tContainer.scrollTop = tContainer.scrollHeight;
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
    toggleModalCode();
    toggleModalSubQty();

    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('fullEditModal')).show();
}

function toggleModalCode() {
    const comp = document.getElementById('editComp').value.trim().toLowerCase();
    const cBox = document.getElementById('editCode');
    if (comp === 'any' || comp === '') { cBox.value = ''; cBox.disabled = true; }
    else cBox.disabled = false;
}

function toggleModalSubQty() {
    const uVal = document.getElementById('editUnit').value;
    const sqBox = document.getElementById('editSubQty');
    const suBox = document.getElementById('editSubUnit');
    if (isPieceUnit(uVal)) {
        sqBox.value = ''; sqBox.disabled = true;
        suBox.value = ''; suBox.disabled = true;
    } else {
        sqBox.disabled = false;
        suBox.disabled = false;
        if (!suBox.value) suBox.value = 'Piece';
    }
}

async function submitProductEdit() {
    const btn = document.querySelector('#fullEditModal .btn-success');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';
    btn.disabled = true;

    const unitVal = document.getElementById('editUnit').value.trim() || 'Piece';
    const pieceFlag = isPieceUnit(unitVal);
    await apiPost({
        action: "updateProduct",
        role: USER.role,
        product: {
            dbId: document.getElementById('editDbId').value,
            item: document.getElementById('editItem').value.trim(),
            specs: document.getElementById('editSpecs').value.trim(),
            refLink: document.getElementById('editRefLink').value.trim(),
            prefComp: document.getElementById('editComp').value.trim() || 'Any',
            code: document.getElementById('editCode').value.trim(),
            unit: unitVal,
            subQty: pieceFlag ? '' : document.getElementById('editSubQty').value.trim(),
            subUnit: pieceFlag ? '' : (document.getElementById('editSubUnit').value.trim() || 'Piece'),
            estPrice: document.getElementById('editPrice').value
        }
    });
    await fetchInitData();
    bootstrap.Modal.getInstance(document.getElementById('fullEditModal')).hide();
    renderInventoryTable();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('inventoryModal')).show();

    btn.innerHTML = '<i class="bi bi-floppy"></i> Save to DB';
    btn.disabled = false;
}

async function deleteProduct(dbId) {
    if (confirm("Are you sure you want to delete this product from the master DB?")) {
        await apiPost({ action: "deleteProduct", role: USER.role, dbId: dbId });
        await fetchInitData();
        renderInventoryTable();
    }
}

// -------------------------------------------------------------
// USER MANAGEMENT
// -------------------------------------------------------------
async function openUsersModal() {
    const res = await apiPost({ action: "manageUsers", subAction: "get", role: USER.role });
    if (res.status === "success") {
        const tbody = document.getElementById('usersBody');
        tbody.innerHTML = "";
        res.users.forEach(u => {
            const btn = (u.username === "admin")
                ? ""
                : `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteUser('${esc(u.username)}')"><i class="bi bi-trash"></i></button>`;
            tbody.innerHTML += `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td class="text-center">${btn}</td></tr>`;
        });
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
// EXPORT MODULE
// -------------------------------------------------------------
function openExportModal(type) {
    currentExportType = type;
    const cleanRows = currentListData.filter(r => !r._isEditing);

    let options = `
        <option value="ALL">Master List (Internal - All Items)</option>
        <option value="RFQ">Requirement List / RFQ (For Vendors - No Prices)</option>
        <option value="ALL_VENDORS">All Concerned Vendors (Separate Sheets / Pages)</option>
    `;

    if (activeVendors.length > 0) {
        options += `<option disabled>────────────────────────</option>`;
        activeVendors.forEach(v => {
            const itemCount = cleanRows.filter(r => r['Selected Vendor'] === v).length;
            options += `<option value="${esc(v)}">Vendor: ${esc(v)} (${itemCount} items)</option>`;
        });
    }

    const sel = document.getElementById('exportVendorSelect');
    if (sel) sel.innerHTML = options;

    renderExportCheckboxes();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('exportModal')).show();
}

function renderExportCheckboxes() {
    const mode = document.getElementById('exportVendorSelect') ? document.getElementById('exportVendorSelect').value : "ALL";
    const budgetChk = document.getElementById('exportIncludeBudget');

    let colsToOffer = [];
    let uncheckedByDefault = [];

    if (mode === "ALL") {
        colsToOffer = BASE_HEADERS.filter(h => h !== "Reference Link").concat(activeVendors);
        if (budgetChk) budgetChk.checked = true;
    } else if (mode === "RFQ") {
        colsToOffer = ["SL No", "Item", "Item Specs", "Preferred Company", "Product Code", "Required Quantity", "Unit", "Sub Quantity", "Sub Unit", "Vendor Unit Price", "Vendor Total"];
        uncheckedByDefault = ["Vendor Unit Price", "Vendor Total"];
        if (budgetChk) budgetChk.checked = false;
    } else {
        colsToOffer = ["SL No", "Item", "Item Specs", "Preferred Company", "Product Code", "Required Quantity", "Unit", "Sub Quantity", "Sub Unit", "Unit Price", "Total Estimate"];
        if (budgetChk) budgetChk.checked = false;
    }

    document.getElementById('exportColCheckboxes').innerHTML = colsToOffer.map((c, i) => {
        const isChecked = !uncheckedByDefault.includes(c) ? "checked" : "";
        return `<div class="form-check">
            <input class="form-check-input exp-chk" type="checkbox" value="${esc(c)}" id="chk${i}" ${isChecked}>
            <label class="form-check-label" for="chk${i}">${esc(c)}</label>
        </div>`;
    }).join('');
}

function executeExport() {
    const modalInstance = bootstrap.Modal.getInstance(document.getElementById('exportModal'));
    if (modalInstance) modalInstance.hide();

    const selectedCols = Array.from(document.querySelectorAll('.exp-chk:checked')).map(cb => cb.value);
    if (selectedCols.length === 0) return alert("Select at least one column.");

    const mode = document.getElementById('exportVendorSelect').value;
    const includeRefs = document.getElementById('exportIncludeRefs') ? document.getElementById('exportIncludeRefs').checked : true;
    const includeBudget = document.getElementById('exportIncludeBudget') ? document.getElementById('exportIncludeBudget').checked : false;
    const baseListName = document.getElementById('listSelector').value;
    const listMeta = activeLists.find(l => l.name === baseListName);
    const qAddress = listMeta ? listMeta.quoteAddress : "";

    const budgetAllocated = parseFloat(document.getElementById('budgetInHand').value) || 0;
    const totalUsed = parseFloat(document.getElementById('totalBudget').innerText.replace('₹', '')) || 0;
    const totalRemaining = budgetAllocated - totalUsed;

    const cleanRows = currentListData.filter(r => !r._isEditing);
    if (cleanRows.length === 0) return alert("No saved items to export.");

    function buildRows(rows, vendorName = null) {
        return rows.map((row, index) => {
            let obj = { _refLink: (row['Reference Link'] || '').trim() };
            selectedCols.forEach(col => {
                if (col === "SL No") obj[col] = index + 1;
                else if (col === "Unit Price" && vendorName) obj[col] = row[vendorName] || "";
                else if (col === "Vendor Unit Price" || col === "Vendor Total") obj[col] = "";
                else obj[col] = row[col] !== undefined ? row[col] : "";
            });
            return obj;
        });
    }

    let exportJobs = [];

    if (mode === "ALL") {
        exportJobs.push({ title: `Dr. Nimmi Das Lab - ${baseListName}`, sheetName: "Master List", fileName: baseListName, rows: buildRows(cleanRows), vendorTotal: null });
    } else if (mode === "RFQ") {
        exportJobs.push({ title: `Dr. Nimmi Das Lab - Requirement List (RFQ) - ${baseListName}`, sheetName: "Requirement List", fileName: `${baseListName}_Requirement_List`, rows: buildRows(cleanRows), vendorTotal: null });
    } else if (mode === "ALL_VENDORS") {
        const concernedVendors = activeVendors.filter(v => cleanRows.some(r => r['Selected Vendor'] === v));
        if (concernedVendors.length === 0) return alert("No items assigned to any vendor yet.");
        concernedVendors.forEach(v => {
            const vRows = cleanRows.filter(r => r['Selected Vendor'] === v);
            const vTotal = vRows.reduce((sum, r) => sum + (parseFloat(r['Total Estimate']) || 0), 0);
            exportJobs.push({ title: `Dr. Nimmi Das Lab - ${baseListName} | Vendor: ${v}`, sheetName: v, fileName: `${baseListName}_${v}`, rows: buildRows(vRows, v), vendorTotal: vTotal });
        });
    } else {
        const vRows = cleanRows.filter(r => r['Selected Vendor'] === mode);
        if (vRows.length === 0) return alert(`No items are currently assigned to "${mode}".`);
        const vTotal = vRows.reduce((sum, r) => sum + (parseFloat(r['Total Estimate']) || 0), 0);
        exportJobs.push({ title: `Dr. Nimmi Das Lab - ${baseListName} | Vendor: ${mode}`, sheetName: mode, fileName: `${baseListName}_${mode}`, rows: buildRows(vRows, mode), vendorTotal: vTotal });
    }

    function buildSheetAOA(job) {
        let aoa = [[job.title]];
        if (qAddress) aoa.push([`Quote / Delivery Address: ${qAddress.replace(/\n/g, ', ')}`]);
        aoa.push([]);
        aoa.push(selectedCols);

        job.rows.forEach(obj => {
            aoa.push(selectedCols.map(col => {
                if (col === "Item Specs" && includeRefs && obj._refLink) {
                    const refLine = `Reference: ${truncateSingleLineText(obj._refLink, 48)}`;
                    return obj[col] ? `${obj[col]}\n${refLine}` : refLine;
                }
                return obj[col];
            }));
        });

        if (job.vendorTotal !== null) { aoa.push([]); aoa.push(["Vendor Total Estimate:", `Rs. ${job.vendorTotal.toFixed(2)}`]); }
        if (includeBudget) {
            aoa.push([]); aoa.push(["BUDGET SUMMARY"]);
            aoa.push(["Total Budget Allocated:", `Rs. ${budgetAllocated.toFixed(2)}`]);
            aoa.push(["Total Used:", `Rs. ${totalUsed.toFixed(2)}`]);
            aoa.push(["Total Remaining:", `Rs. ${totalRemaining.toFixed(2)}`]);
        }
        return aoa;
    }

    if (currentExportType === 'excel') {
        const wb = XLSX.utils.book_new();
        const usedNames = new Set();
        exportJobs.forEach(job => {
            const ws = XLSX.utils.aoa_to_sheet(buildSheetAOA(job));
            let safeName = job.sheetName.replace(/[:\\/?*\[\]]/g, '').trim().substring(0, 31) || "Sheet";
            let counter = 1;
            while (usedNames.has(safeName)) safeName = safeName.substring(0, 28) + `_${counter++}`;
            usedNames.add(safeName);
            XLSX.utils.book_append_sheet(wb, ws, safeName);
        });
        XLSX.writeFile(wb, (mode === "ALL_VENDORS") ? `${baseListName}_All_Vendors.xlsx` : `${exportJobs[0].fileName}.xlsx`);
    } else if (currentExportType === 'csv') {
        exportJobs.forEach(job => {
            const ws = XLSX.utils.aoa_to_sheet(buildSheetAOA(job));
            const blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `${job.fileName}.csv`;
            link.click();
        });
    } else if (currentExportType === 'pdf') {
        const doc = new jspdf.jsPDF('landscape');
        const specsColIndex = selectedCols.indexOf("Item Specs");

        exportJobs.forEach((job, idx) => {
            if (idx > 0) doc.addPage();
            doc.setFontSize(14); doc.setFont(undefined, 'bold'); doc.text(job.title, 14, 15); doc.setFont(undefined, 'normal');

            let startYPos = 21;
            if (qAddress) {
                doc.setFontSize(10);
                const splitAddress = doc.splitTextToSize(`Quote / Delivery Address: ${qAddress.replace(/\n/g, ', ')}`, 265);
                doc.text(splitAddress, 14, 22);
                startYPos = 24 + (splitAddress.length * 5);
            }

            doc.autoTable({
                head: [selectedCols],
                body: job.rows.map(obj => selectedCols.map(col => obj[col])),
                startY: startYPos,
                styles: { fontSize: 8 },
                didParseCell: function(data) {
                    if (includeRefs && specsColIndex > -1 && data.section === 'body' && data.column.index === specsColIndex) {
                        const ref = job.rows[data.row.index] ? job.rows[data.row.index]._refLink : "";
                        if (ref) { data.cell.styles.cellPadding = { top: 2, right: 2, bottom: 6.5, left: 2 }; data.cell.styles.minCellHeight = 9; }
                    }
                },
                didDrawCell: function(data) {
                    if (includeRefs && specsColIndex > -1 && data.section === 'body' && data.column.index === specsColIndex) {
                        const ref = job.rows[data.row.index] ? job.rows[data.row.index]._refLink : "";
                        if (ref) {
                            const fullText = `Reference: ${ref}`;
                            doc.setFont(undefined, 'italic'); doc.setFontSize(10); doc.setTextColor(70, 70, 70);
                            const maxW = Math.max(12, data.cell.width - 4);
                            const lineText = truncatePdfLine(doc, fullText, maxW);
                            const textX = data.cell.x + 2, textY = data.cell.y + data.cell.height - 2;
                            doc.text(lineText, textX, textY);
                            if (isUrl(ref)) doc.link(textX, textY - 3.5, doc.getTextWidth(lineText), 4.5, { url: normalizeUrl(ref) });
                            doc.setFont(undefined, 'normal'); doc.setFontSize(8); doc.setTextColor(0, 0, 0);
                        }
                    }
                }
            });

            let finalY = doc.lastAutoTable.finalY + 10;
            doc.setFontSize(10);
            if (job.vendorTotal !== null) {
                doc.setFont(undefined, 'bold'); doc.text(`Vendor Total Estimate: Rs. ${job.vendorTotal.toFixed(2)}`, 14, finalY); doc.setFont(undefined, 'normal'); finalY += 10;
            }
            if (includeBudget) {
                doc.setFont(undefined, 'bold'); doc.text("Budget Summary", 14, finalY); doc.setFont(undefined, 'normal');
                doc.text(`Total Budget Allocated: Rs. ${budgetAllocated.toFixed(2)}`, 14, finalY + 6);
                doc.text(`Total Used: Rs. ${totalUsed.toFixed(2)}`, 14, finalY + 12);
                doc.text(`Total Remaining: Rs. ${totalRemaining.toFixed(2)}`, 14, finalY + 18);
            }
        });
        doc.save((mode === "ALL_VENDORS") ? `${baseListName}_All_Vendors.pdf` : `${exportJobs[0].fileName}.pdf`);
    } else if (currentExportType === 'print') {
        let win = window.open('', '', 'width=950,height=650');
        let html = `<html><head><title>${esc(baseListName)}</title><style>
            body { font-family: Arial, sans-serif; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { border: 1px solid #000; padding: 6px; font-size: 12px; text-align: left; vertical-align: top; }
            th { background-color: #f2f2f2; }
            .ref-line { display: block; font-style: italic; font-size: 10pt; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; margin-top: 3px; }
            .ref-line a { color: #0d6efd; text-decoration: none; }
            .summary { margin-top: 15px; font-size: 14px; }
            .vendor-page { page-break-after: always; }
            .vendor-page:last-child { page-break-after: auto; }
        </style></head><body>`;

        exportJobs.forEach(job => {
            html += `<div class="vendor-page"><h2>${esc(job.title)}</h2>`;
            if (qAddress) html += `<p style="font-size:13px;"><strong>Quote / Delivery Address:</strong><br>${esc(qAddress).replace(/\n/g, '<br>')}</p>`;
            html += `<table><thead><tr>${selectedCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
            job.rows.forEach(row => {
                html += `<tr>${selectedCols.map(c => {
                    if (c === "Item Specs" && includeRefs && row._refLink) return `<td><div>${esc(row[c])}</div>${formatRefHtml(row._refLink)}</td>`;
                    return `<td>${esc(row[c])}</td>`;
                }).join('')}</tr>`;
            });
            html += `</tbody></table>`;
            if (job.vendorTotal !== null) html += `<div class="summary"><strong>Vendor Total Estimate: ₹${job.vendorTotal.toFixed(2)}</strong></div>`;
            if (includeBudget) {
                html += `<div class="summary"><strong>Budget Summary</strong><br>Total Budget Allocated: ₹${budgetAllocated.toFixed(2)}<br>Total Used: ₹${totalUsed.toFixed(2)}<br>Total Remaining: ₹${totalRemaining.toFixed(2)}</div>`;
            }
            html += `</div>`;
        });

        html += `</body></html>`;
        win.document.write(html); win.document.close(); win.print();
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
        let currentItem = "";
        if (tr && tr.querySelector('.pItem')) currentItem = tr.querySelector('.pItem').value.toLowerCase().trim();

        let count = 0; let optionsHTML = ''; const added = new Set();
        for (const [dbId, p] of Object.entries(productDB)) {
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
        const keywords = this.value.toLowerCase().trim().split(/[\s;,]+/).filter(kw => kw.length > 0);
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
