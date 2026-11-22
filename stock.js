const API_URL = "https://script.google.com/macros/s/AKfycbxkDBmVRgyuB8yKgLxx_-qAuQNI9z2xOEd-pzGt4QzNhXJ1aOc0WfDtENvxkYguRK9l/exec";

let USER = null;
let stockItems = [];
let stockLedger = [];
let reqLists = [];
let allUsernames = [];
let procRows = [];
let expandedStockIds = new Set();

// Proxy authentication cache: { username: expiryTimestampMs } (2 minutes validity)
const proxyAuthCache = {};
const PROXY_AUTH_DURATION_MS = 2 * 60 * 1000;
let pendingDeductionPayload = null;

function esc(val) {
    return String(val ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

async function apiPost(payload) {
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

function nowFormattedDDMMYYYYHHMM() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatStockDisplay(totalBase, unit, subPerUnit, subLabel) {
    if (subPerUnit <= 1) {
        return `${totalBase} ${unit}${totalBase === 1 ? '' : 's'}`;
    }
    const fullPacks = Math.floor(totalBase / subPerUnit);
    const remSub = Number((totalBase % subPerUnit).toFixed(2));
    const lbl = subLabel || "pcs";
    if (remSub === 0) {
        return `${fullPacks} ${unit}${fullPacks === 1 ? '' : 's'} (${subPerUnit} ${lbl}/${unit})`;
    }
    if (fullPacks === 0) {
        return `${remSub} ${lbl}`;
    }
    return `${fullPacks} ${unit}${fullPacks === 1 ? '' : 's'} + ${remSub} ${lbl} (${totalBase} ${lbl})`;
}

function isLowStock(item) {
    const thresh = parseFloat(item.threshold) || 0;
    if (thresh <= 0) return false;
    const compareVal = (item.thresholdType === "qty" && item.subPerUnit > 1)
        ? (item.totalBase / item.subPerUnit)
        : item.totalBase;
    return compareVal <= (thresh + 10);
}

// -------------------------------------------------------------
// AUTHENTICATION INITIALIZATION
// -------------------------------------------------------------
(function initAuth() {
    const stored = localStorage.getItem("labPortalUser") || sessionStorage.getItem("user");
    if (stored) {
        USER = JSON.parse(stored);
        showStockApp();
    } else {
        document.getElementById('stockLoginScreen').style.display = 'flex';
    }
})();

async function stockLogin() {
    const u = document.getElementById('sUsername').value.trim();
    const p = document.getElementById('sPassword').value;
    const btn = document.getElementById('sLoginBtn');
    const err = document.getElementById('sLoginErr');
    if (!u || !p) return;

    btn.innerText = "Verifying...";
    btn.disabled = true;
    err.style.display = 'none';
    try {
        const res = await apiPost({ action: "login", username: u, password: p });
        if (res.status === "success") {
            USER = { username: u, role: res.role };
            localStorage.setItem("labPortalUser", JSON.stringify(USER));
            showStockApp();
        } else {
            err.innerText = res.message || "Invalid credentials.";
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

function showStockApp() {
    document.getElementById('stockLoginScreen').style.display = 'none';
    document.getElementById('stockApp').style.display = 'block';
    document.getElementById('stUsername').innerText = USER.username;
    document.getElementById('stRole').innerText = USER.role;

    if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
        document.getElementById('btnInsertFromReq').style.display = 'inline-block';
    }
    loadStockData();
}

// -------------------------------------------------------------
// LOAD & RENDER STOCK REGISTER
// -------------------------------------------------------------
async function loadStockData() {
    const tbody = document.getElementById('stockTableBody');
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted"><i class="bi bi-hourglass-split"></i> Loading stock register...</td></tr>`;
    try {
        const res = await apiPost({ action: "getStockData", username: USER.username, role: USER.role });
        if (res.status === "success") {
            stockItems = res.stock || [];
            stockLedger = res.ledger || [];
            reqLists = res.lists || [];
            allUsernames = res.usernames || [USER.username];
            renderStockTable();
        } else {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger p-4">${esc(res.message || 'Load failed')}</td></tr>`;
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger p-4">Failed to connect to backend.</td></tr>`;
    }
}

function renderStockTable() {
    const tbody = document.getElementById('stockTableBody');
    const rawSearch = (document.getElementById('stockSearch').value || "").toLowerCase().trim();
    const keywords = rawSearch.split(/[\s;,]+/).filter(Boolean);
    const filterMode = document.getElementById('stockFilterMode').value;

    let lowCount = 0;
    let placedCount = 0;
    stockItems.forEach(item => {
        if (isLowStock(item)) {
            if (item.reqStatus === "PLACED") placedCount++;
            else lowCount++;
        }
    });
    document.getElementById('kpiTotal').innerText = stockItems.length;
    document.getElementById('kpiLow').innerText = lowCount;
    document.getElementById('kpiPlaced').innerText = placedCount;

    let html = "";
    let shown = 0;

    stockItems.forEach(item => {
        const low = isLowStock(item);
        const placed = low && item.reqStatus === "PLACED";

        if (filterMode === "LOW" && !(low && !placed)) return;
        if (filterMode === "PLACED" && !placed) return;

        if (keywords.length > 0) {
            const hay = `${item.item} ${item.specs} ${item.latestVendor} ${item.latestRefNo} ${item.location} ${item.latestDedUser}`.toLowerCase();
            if (!keywords.every(k => hay.includes(k))) return;
        }

        shown++;
        const isExpanded = expandedStockIds.has(item.stockId);
        let rowClass = "stock-main-row";
        let warningBadge = "";

        if (placed) {
            rowClass += " row-req-placed";
            warningBadge = `<span class="ms-1 text-primary" title="Requirement Placed (Stock Low)"><i class="bi bi-exclamation-triangle-fill"></i> <span class="badge bg-primary" style="font-size:0.7rem;">Req. Placed</span></span>`;
        } else if (low) {
            rowClass += " row-low-warning";
            warningBadge = `<span class="ms-1 text-warning" title="Going out of stock soon (Remaining ≤ Threshold + 10)"><i class="bi bi-exclamation-triangle-fill"></i> <span class="badge bg-warning text-dark" style="font-size:0.7rem;">Low Stock</span></span>`;
        }

        const locTag = item.location
            ? `<div class="mt-1"><span class="badge bg-light text-dark border"><i class="bi bi-geo-alt-fill text-secondary"></i> ${esc(item.location)}</span></div>`
            : "";

        const acqBlock = item.latestAcqDate
            ? `<div class="acq-meta">
                    <div class="fw-semibold">${esc(item.latestAcqDate)}</div>
                    <div class="fst-italic">(${esc(item.latestVendor || 'Vendor')}${item.latestRefNo ? `, Ref: ${esc(item.latestRefNo)}` : ''})</div>
               </div>`
            : `<div class="small text-muted">No acquirement recorded</div>`;

        const dedBlock = item.latestDedDateTime
            ? `<div class="ded-meta">
                    <div class="fw-semibold">${esc(item.latestDedDateTime)}</div>
                    <div class="fst-italic">(${esc(item.latestDedUser)}${item.latestDedPurpose ? `, ${esc(item.latestDedPurpose)}` : ''})</div>
               </div>`
            : `<div class="small text-muted mt-1 fst-italic">No deductions yet</div>`;

        const stockDisplay = formatStockDisplay(item.totalBase, item.unit, item.subPerUnit, item.subLabel);
        const threshUnitLabel = (item.thresholdType === "sub" && item.subPerUnit > 1) ? (item.subLabel || "pcs") : item.unit;
        const threshDisplay = item.threshold > 0
            ? `<div class="fw-semibold">${item.threshold} ${esc(threshUnitLabel)}</div><small class="text-muted">Warn ≤ ${item.threshold + 10}</small>`
            : `<span class="text-muted small">Not set</span>`;

        // Expanded Ledger History (newest first)
        const itemLogs = stockLedger.filter(l => l.stockId === item.stockId).reverse();
        let ledgerRows = itemLogs.map(log => {
            const isAcq = log.type === "Acquirement";
            const typeBadge = isAcq
                ? `<span class="badge bg-success-subtle text-success border border-success-subtle">Acquirement</span>`
                : `<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Deduction</span>`;
            const subDetail = log.refOrPurpose ? `<div class="fst-italic text-muted small">${esc(log.refOrPurpose)}</div>` : "";
            const amtLine = (isAcq && log.amount !== "") ? `<div class="small text-success fw-semibold">Amt: ₹${esc(log.amount)}</div>` : "";

            return `<tr>
                <td class="text-nowrap">${esc(log.dateTime)}</td>
                <td>${typeBadge}</td>
                <td>
                    <div class="fw-semibold">${esc(log.actor)}</div>
                    ${subDetail}${amtLine}
                </td>
                <td>${esc(log.stockBefore)}</td>
                <td class="${isAcq ? 'text-muted text-center' : 'text-danger fw-semibold'}">${esc(log.deductedQty || '--')}</td>
                <td class="fw-semibold text-primary">${esc(log.afterDisplay)}</td>
            </tr>`;
        }).join('');

        if (!ledgerRows) {
            ledgerRows = `<tr><td colspan="6" class="text-center text-muted py-2">No transaction history yet.</td></tr>`;
        }

        html += `
        <tr class="${rowClass}" onclick="toggleExpandRow('${esc(item.stockId)}')">
            <td>
                <div class="d-flex align-items-start gap-2">
                    <i class="bi bi-chevron-right chevron-icon mt-1 text-secondary ${isExpanded ? 'chevron-rotated' : ''}" id="chev_${esc(item.stockId)}"></i>
                    <div>
                        <div class="fw-bold">${esc(item.item)} ${warningBadge}</div>
                        <div class="fst-italic text-muted small">${esc(item.specs)}</div>
                        ${locTag}
                    </div>
                </div>
            </td>
            <td>${acqBlock}${dedBlock}</td>
            <td class="fw-bold fs-6 text-dark">${esc(stockDisplay)}</td>
            <td>${threshDisplay}</td>
            <td class="text-center text-nowrap" onclick="event.stopPropagation()">
                <button class="btn btn-sm btn-outline-danger py-1 px-2 fw-semibold" onclick="openDeductModal('${esc(item.stockId)}')" title="Deduct Stock">
                    <i class="bi bi-dash-circle"></i> Deduct
                </button>
                <button class="btn btn-sm btn-outline-secondary py-1 px-2 ms-1" onclick="openEditStockMeta('${esc(item.stockId)}')" title="Edit Location & Threshold">
                    <i class="bi bi-sliders"></i>
                </button>
            </td>
        </tr>
        <tr class="detail-row ${isExpanded ? '' : 'd-none'}" id="detail_${esc(item.stockId)}">
            <td colspan="5">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="fw-bold small text-secondary"><i class="bi bi-clock-history"></i> Transaction History — ${esc(item.item)}</span>
                    <span class="small text-muted">${itemLogs.length} record(s)</span>
                </div>
                <table class="table table-sm table-bordered ledger-table mb-0">
                    <thead>
                        <tr>
                            <th>Date and Time</th>
                            <th>Deduction / Acquirement</th>
                            <th>User Name / Vendor Name</th>
                            <th>Stock Qty</th>
                            <th>Deducted Qty.</th>
                            <th>After Deduction</th>
                        </tr>
                    </thead>
                    <tbody>${ledgerRows}</tbody>
                </table>
            </td>
        </tr>`;
    });

    if (shown === 0) {
        html = `<tr><td colspan="5" class="text-center p-4 text-muted">No stock items found.</td></tr>`;
    }
    tbody.innerHTML = html;
}

function toggleExpandRow(stockId) {
    const detail = document.getElementById(`detail_${stockId}`);
    const chev = document.getElementById(`chev_${stockId}`);
    if (!detail) return;
    if (expandedStockIds.has(stockId)) {
        expandedStockIds.delete(stockId);
        detail.classList.add('d-none');
        if (chev) chev.classList.remove('chevron-rotated');
    } else {
        expandedStockIds.add(stockId);
        detail.classList.remove('d-none');
        if (chev) chev.classList.add('chevron-rotated');
    }
}

// -------------------------------------------------------------
// INSERT FROM REQUIREMENT LIST MODAL (Admin & Supervisor)
// -------------------------------------------------------------
function openInsertFromReqModal() {
    const sel = document.getElementById('reqListDropdown');
    sel.innerHTML = `<option value="" disabled selected>Choose a Requirement List...</option>`;
    reqLists.forEach(l => {
        const tag = l.status === "Closed" ? " [Closed]" : "";
        sel.innerHTML += `<option value="${esc(l.name)}">${esc(l.name + tag)}</option>`;
    });
    document.getElementById('procModalBody').innerHTML = `<tr><td colspan="14" class="text-center p-3 text-muted">Select a requirement list above.</td></tr>`;
    procRows = [];
    bootstrap.Modal.getOrCreateInstance(document.getElementById('insertReqModal')).show();
}

async function loadReqListForProcurement() {
    const listName = document.getElementById('reqListDropdown').value;
    if (!listName) return;
    const tbody = document.getElementById('procModalBody');
    tbody.innerHTML = `<tr><td colspan="14" class="text-center p-3"><i class="bi bi-hourglass-split"></i> Loading list items...</td></tr>`;

    try {
        const payload = await apiPost({ action: "getListData", listName: listName });
        const rows = payload.rows || [];
        const todayStr = new Date().toISOString().split('T')[0];

        procRows = rows.map((r, idx) => {
            const reqQty = parseFloat(r['Required Quantity']) || 0;
            const acqQty = parseFloat(r['Acquired Qty']) || 0;
            const remQty = Math.max(0, reqQty - acqQty);

            // Find existing stock record to prefill location/threshold if available
            const existingStock = stockItems.find(s =>
                s.item.toLowerCase() === String(r['Item'] || '').trim().toLowerCase() &&
                s.specs.toLowerCase() === String(r['Item Specs'] || '').trim().toLowerCase()
            );

            return {
                selected: remQty > 0,
                reqRowIndex: idx,
                item: String(r['Item'] || ''),
                specs: String(r['Item Specs'] || ''),
                prefComp: String(r['Preferred Company'] || 'Any'),
                code: String(r['Product Code'] || ''),
                reqQty: reqQty,
                acqQty: acqQty,
                unit: String(r['Unit'] || 'Piece'),
                subQty: String(r['Sub Quantity'] || ''),
                purchasedQty: remQty > 0 ? remQty : '',
                purchasedSubQty: String(r['Sub Quantity'] || ''),
                vendor: String(r['Selected Vendor'] || ''),
                amount: r['Total Estimate'] || '',
                refNo: '',
                procDate: todayStr,
                location: existingStock ? existingStock.location : '',
                threshold: existingStock && existingStock.threshold > 0 ? existingStock.threshold : '',
                thresholdType: existingStock ? existingStock.thresholdType : (String(r['Unit'] || 'Piece').toLowerCase() === 'piece' ? 'qty' : 'sub')
            };
        });

        renderProcModalRows();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="14" class="text-center text-danger p-3">Failed to load list items.</td></tr>`;
    }
}

function renderProcModalRows() {
    const tbody = document.getElementById('procModalBody');
    if (procRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="14" class="text-center text-muted p-3">This list has no items.</td></tr>`;
        return;
    }

    let html = "";
    procRows.forEach((r, idx) => {
        const isPiece = r.unit.trim().toLowerCase() === "piece";
        const fullyAcqTag = r.acqQty >= r.reqQty && r.reqQty > 0 ? `<div class="badge bg-success-subtle text-success">Acq: ${r.acqQty}</div>` : (r.acqQty > 0 ? `<div class="badge bg-warning-subtle text-dark">Acq: ${r.acqQty}</div>` : '');

        html += `<tr>
            <td class="text-center"><input type="checkbox" ${r.selected ? 'checked' : ''} onchange="procRows[${idx}].selected = this.checked"></td>
            <td class="fw-bold">${esc(r.item)}</td>
            <td class="small">${esc(r.specs)}</td>
            <td class="text-center fw-semibold">${r.reqQty} ${fullyAcqTag}</td>
            <td>${esc(r.unit)}</td>
            <td class="small text-muted">${esc(r.subQty || '-')}</td>
            <td><input type="number" step="0.01" min="0" class="form-control form-control-sm" value="${esc(r.purchasedQty)}" oninput="procRows[${idx}].purchasedQty = this.value"></td>
            <td><input type="text" class="form-control form-control-sm" value="${isPiece ? '' : esc(r.purchasedSubQty)}" placeholder="${isPiece ? '-' : 'e.g. 500 pcs'}" ${isPiece ? 'disabled' : ''} oninput="procRows[${idx}].purchasedSubQty = this.value"></td>
            <td><input type="text" class="form-control form-control-sm" value="${esc(r.vendor)}" oninput="procRows[${idx}].vendor = this.value"></td>
            <td><input type="number" step="0.01" class="form-control form-control-sm" placeholder="₹" value="${esc(r.amount)}" oninput="procRows[${idx}].amount = this.value"></td>
            <td>
                <div class="input-group input-group-sm">
                    <input type="text" class="form-control" placeholder="Bill Ref #" value="${esc(r.refNo)}" oninput="procRows[${idx}].refNo = this.value">
                    <button class="btn btn-outline-primary" type="button" onclick="copyRefDateBelow(${idx}, true)" title="Copy Ref No. & Date to rows below with SAME vendor">
                        <i class="bi bi-arrow-down-square-fill"></i>
                    </button>
                    <button class="btn btn-outline-secondary" type="button" onclick="copyRefDateBelow(${idx}, false)" title="Copy Ref No. & Date to ALL rows below">
                        <i class="bi bi-chevron-double-down"></i>
                    </button>
                </div>
            </td>
            <td><input type="date" class="form-control form-control-sm" value="${esc(r.procDate)}" onchange="procRows[${idx}].procDate = this.value"></td>
            <td><input type="text" class="form-control form-control-sm" placeholder="Shelf / Room" value="${esc(r.location)}" oninput="procRows[${idx}].location = this.value"></td>
            <td>
                <div class="input-group input-group-sm">
                    <input type="number" min="0" class="form-control" placeholder="Min" value="${esc(r.threshold)}" oninput="procRows[${idx}].threshold = this.value">
                    <select class="form-select" style="max-width:65px;" onchange="procRows[${idx}].thresholdType = this.value">
                        <option value="qty" ${r.thresholdType === 'qty' ? 'selected' : ''}>Qty</option>
                        ${!isPiece ? `<option value="sub" ${r.thresholdType === 'sub' ? 'selected' : ''}>Sub</option>` : ''}
                    </select>
                </div>
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
    document.getElementById('chkAllProc').checked = procRows.every(r => r.selected);
}

function toggleAllProcRows(checked) {
    procRows.forEach(r => r.selected = checked);
    renderProcModalRows();
}

function copyRefDateBelow(fromIdx, sameVendorOnly) {
    const src = procRows[fromIdx];
    const srcVendor = (src.vendor || "").trim().toLowerCase();
    for (let i = fromIdx + 1; i < procRows.length; i++) {
        if (!sameVendorOnly || (procRows[i].vendor || "").trim().toLowerCase() === srcVendor) {
            procRows[i].refNo = src.refNo;
            procRows[i].procDate = src.procDate;
        }
    }
    renderProcModalRows();
}

function sortProcRows(mode) {
    procRows.sort((a, b) => {
        if (mode === 'vendor') return (a.vendor || "").localeCompare(b.vendor || "");
        if (mode === 'item') return (a.item || "").localeCompare(b.item || "");
        // vendor_item
        const vCmp = (a.vendor || "").localeCompare(b.vendor || "");
        return vCmp !== 0 ? vCmp : (a.item || "").localeCompare(b.item || "");
    });
    renderProcModalRows();
}

async function submitProcurementBatch() {
    const listName = document.getElementById('reqListDropdown').value;
    const toSubmit = procRows.filter(r => r.selected && parseFloat(r.purchasedQty) > 0);
    if (toSubmit.length === 0) return alert("Please select at least one row with a Purchased Quantity greater than 0.");

    const btn = document.getElementById('btnSubmitProc');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';
    btn.disabled = true;

    try {
        const res = await apiPost({
            action: "addStockFromBill",
            role: USER.role,
            username: USER.username,
            listName: listName,
            items: toSubmit
        });
        if (res.status === "success") {
            bootstrap.Modal.getInstance(document.getElementById('insertReqModal')).hide();
            await loadStockData();
        } else {
            alert(res.message || "Failed to save procurement.");
        }
    } catch (e) {
        alert("Connection error while saving procurement.");
    } finally {
        btn.innerHTML = '<i class="bi bi-check2-circle"></i> Save Procurement to Stock';
        btn.disabled = false;
    }
}

// -------------------------------------------------------------
// DEDUCT STOCK & 2-MINUTE PROXY PASSWORD VALIDATION
// -------------------------------------------------------------
function openDeductModal(stockId) {
    const item = stockItems.find(s => s.stockId === stockId);
    if (!item) return;

    document.getElementById('dedStockId').value = stockId;
    document.getElementById('dedItemName').innerText = item.item;
    document.getElementById('dedItemSpecs').innerText = item.specs || "";
    document.getElementById('dedAvailDisplay').innerText = formatStockDisplay(item.totalBase, item.unit, item.subPerUnit, item.subLabel);
    document.getElementById('dedDateTime').value = nowFormattedDDMMYYYYHHMM();
    document.getElementById('dedQtyInput').value = "";
    document.getElementById('dedPurpose').value = "";

    // Populate user dropdown (defaults to logged-in user)
    const uSel = document.getElementById('dedTargetUser');
    const names = Array.from(new Set([USER.username, ...allUsernames]));
    uSel.innerHTML = names.map(u => `<option value="${esc(u)}" ${u === USER.username ? 'selected' : ''}>${esc(u)}${u === USER.username ? ' (You)' : ''}</option>`).join('');

    // Populate unit mode dropdown (sub-unit vs pack unit)
    const mSel = document.getElementById('dedUnitMode');
    if (item.subPerUnit > 1) {
        const subLbl = item.subLabel || "pcs";
        mSel.innerHTML = `
            <option value="base" selected>${esc(subLbl)} (Sub-Unit)</option>
            <option value="pack">${esc(item.unit)} (${item.subPerUnit} ${esc(subLbl)}/${esc(item.unit)})</option>
        `;
    } else {
        mSel.innerHTML = `<option value="base" selected>${esc(item.unit)}</option>`;
    }

    updateProxyAuthStatus();
    updateDeductPreview();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('deductModal')).show();
}

function updateProxyAuthStatus() {
    const target = document.getElementById('dedTargetUser').value;
    const badge = document.getElementById('proxyAuthBadge');
    if (target === USER.username) {
        badge.style.display = 'none';
        return;
    }
    badge.style.display = 'block';
    const expiry = proxyAuthCache[target];
    if (expiry && Date.now() < expiry) {
        const secsLeft = Math.ceil((expiry - Date.now()) / 1000);
        badge.innerHTML = `<span class="text-success fw-semibold"><i class="bi bi-shield-check"></i> Authorized for ${esc(target)} (${secsLeft}s remaining)</span>`;
    } else {
        badge.innerHTML = `<span class="text-warning-emphasis fw-semibold"><i class="bi bi-key"></i> Password verification for ${esc(target)} will be required on confirm.</span>`;
    }
}

function updateDeductPreview() {
    const stockId = document.getElementById('dedStockId').value;
    const item = stockItems.find(s => s.stockId === stockId);
    const preview = document.getElementById('dedRemainingPreview');
    if (!item) return;

    const qty = parseFloat(document.getElementById('dedQtyInput').value) || 0;
    const mode = document.getElementById('dedUnitMode').value;
    const dedBase = (mode === 'pack' && item.subPerUnit > 1) ? (qty * item.subPerUnit) : qty;
    const remBase = Number((item.totalBase - dedBase).toFixed(2));

    if (qty <= 0) {
        preview.className = "fw-bold text-muted";
        preview.innerText = formatStockDisplay(item.totalBase, item.unit, item.subPerUnit, item.subLabel);
    } else if (remBase < 0) {
        preview.className = "fw-bold text-danger";
        preview.innerText = "Exceeds available stock!";
    } else {
        preview.className = "fw-bold text-primary";
        preview.innerText = formatStockDisplay(remBase, item.unit, item.subPerUnit, item.subLabel);
    }
}

function initiateDeduction() {
    const stockId = document.getElementById('dedStockId').value;
    const item = stockItems.find(s => s.stockId === stockId);
    const qty = parseFloat(document.getElementById('dedQtyInput').value) || 0;
    const mode = document.getElementById('dedUnitMode').value;
    const targetUser = document.getElementById('dedTargetUser').value;
    const purpose = document.getElementById('dedPurpose').value.trim();
    const dateTime = document.getElementById('dedDateTime').value || nowFormattedDDMMYYYYHHMM();

    if (!item) return;
    if (qty <= 0) return alert("Please enter a valid deduction quantity.");

    const dedBase = (mode === 'pack' && item.subPerUnit > 1) ? (qty * item.subPerUnit) : qty;
    if (dedBase > item.totalBase) return alert("Deducted quantity exceeds available stock.");

    const payload = {
        action: "deductStock",
        stockId: stockId,
        deductQty: qty,
        deductMode: mode,
        targetUser: targetUser,
        recordedBy: USER.username,
        purpose: purpose,
        dateTime: dateTime
    };

    // Check if deducting for another user and whether 2-min validation is active
    if (targetUser !== USER.username) {
        const expiry = proxyAuthCache[targetUser];
        if (!expiry || Date.now() >= expiry) {
            pendingDeductionPayload = payload;
            document.getElementById('proxyTargetLabel').innerText = targetUser;
            document.getElementById('proxyPassInput').value = "";
            document.getElementById('proxyPassErr').style.display = 'none';
            bootstrap.Modal.getOrCreateInstance(document.getElementById('proxyPasswordModal')).show();
            setTimeout(() => document.getElementById('proxyPassInput').focus(), 200);
            return;
        }
    }

    executeDeduction(payload);
}

async function verifyProxyAndDeduct() {
    if (!pendingDeductionPayload) return;
    const targetUser = pendingDeductionPayload.targetUser;
    const pwd = document.getElementById('proxyPassInput').value;
    const err = document.getElementById('proxyPassErr');
    const btn = document.getElementById('btnVerifyProxy');

    if (!pwd) return;
    btn.innerText = "Verifying...";
    btn.disabled = true;
    err.style.display = 'none';

    try {
        const res = await apiPost({ action: "verifyProxyPassword", username: targetUser, password: pwd });
        if (res.status === "success") {
            // Cache validation for 2 minutes
            proxyAuthCache[targetUser] = Date.now() + PROXY_AUTH_DURATION_MS;
            bootstrap.Modal.getInstance(document.getElementById('proxyPasswordModal')).hide();
            const toRun = pendingDeductionPayload;
            pendingDeductionPayload = null;
            await executeDeduction(toRun);
        } else {
            err.innerText = "Incorrect password for " + targetUser;
            err.style.display = 'block';
        }
    } catch (e) {
        err.innerText = "Verification failed.";
        err.style.display = 'block';
    } finally {
        btn.innerText = "Verify & Deduct";
        btn.disabled = false;
    }
}

async function executeDeduction(payload) {
    const btn = document.getElementById('btnConfirmDeduct');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Updating...';
    btn.disabled = true;

    try {
        const res = await apiPost(payload);
        if (res.status === "success") {
            const modal = bootstrap.Modal.getInstance(document.getElementById('deductModal'));
            if (modal) modal.hide();
            expandedStockIds.add(payload.stockId); // Auto-expand so user sees the new ledger record
            await loadStockData();
        } else {
            alert(res.message || "Deduction failed.");
        }
    } catch (e) {
        alert("Connection error during deduction.");
    } finally {
        btn.innerText = "Confirm Deduction";
        btn.disabled = false;
    }
}

// -------------------------------------------------------------
// EDIT STORAGE LOCATION & THRESHOLD
// -------------------------------------------------------------
function openEditStockMeta(stockId) {
    const item = stockItems.find(s => s.stockId === stockId);
    if (!item) return;

    document.getElementById('metaStockId').value = stockId;
    document.getElementById('metaItemTitle').innerText = `${item.item} (${item.specs || 'Standard'})`;
    document.getElementById('metaLocation').value = item.location || "";
    document.getElementById('metaThreshold').value = item.threshold || 0;

    const tSel = document.getElementById('metaThresholdType');
    if (item.subPerUnit > 1) {
        tSel.innerHTML = `
            <option value="sub" ${item.thresholdType === 'sub' ? 'selected' : ''}>${esc(item.subLabel || 'pcs')} (Sub Qty)</option>
            <option value="qty" ${item.thresholdType === 'qty' ? 'selected' : ''}>${esc(item.unit)} (Main Qty)</option>
        `;
    } else {
        tSel.innerHTML = `<option value="qty" selected>${esc(item.unit)}</option>`;
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('editStockMetaModal')).show();
}

async function saveStockMeta() {
    const stockId = document.getElementById('metaStockId').value;
    const location = document.getElementById('metaLocation').value.trim();
    const threshold = document.getElementById('metaThreshold').value;
    const thresholdType = document.getElementById('metaThresholdType').value;

    const res = await apiPost({
        action: "updateStockMeta",
        stockId: stockId,
        location: location,
        threshold: threshold,
        thresholdType: thresholdType
    });
    if (res.status === "success") {
        bootstrap.Modal.getInstance(document.getElementById('editStockMetaModal')).hide();
        await loadStockData();
    } else {
        alert(res.message || "Failed to update settings.");
    }
}
