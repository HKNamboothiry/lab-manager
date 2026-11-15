const API_URL = "https://script.google.com/macros/s/AKfycbxkDBmVRgyuB8yKgLxx_-qAuQNI9z2xOEd-pzGt4QzNhXJ1aOc0WfDtENvxkYguRK9l/exec"; 
    
let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let activeVendors = [];
let vendorDB = [];
let latestInheritedBudget = 0;
let currentExportType = "";

const BASE_HEADERS = ["SL No", "Item", "Item Specs", "Preferred Company", "Product Code", "Required Quantity", "Unit", "Estimated Price", "Selected Vendor", "Total Estimate"];

async function apiPost(payload) {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    return await res.json();
}

if (sessionStorage.getItem("user")) { USER = JSON.parse(sessionStorage.getItem("user")); showApp(); }

async function verifyLogin() {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    const btn = document.getElementById('loginBtn');
    if (!u || !p) return;
    btn.innerText = "Verifying..."; btn.disabled = true;
    try {
        const data = await apiPost({action: "login", username: u, password: p});
        if (data.status === "success") {
            USER = { username: u, role: data.role };
            sessionStorage.setItem("user", JSON.stringify(USER));
            showApp();
        } else alert("Invalid credentials.");
    } catch (e) { alert("Connection error."); } 
    finally { btn.innerText = "Login"; btn.disabled = false; }
}

function logout() { sessionStorage.removeItem("user"); location.reload(); }

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

async function fetchInitData() {
    try {
        const data = await apiPost({action: "getInit", username: USER.username, role: USER.role});
        if(data.status === "success") {
            productDB = data.products; activeLists = data.lists; vendorDB = data.vendors; latestInheritedBudget = data.latestBudget;
            populateListDropdown(); 
        }
    } catch (e) { alert("Failed to fetch initial data."); }
}

function populateListDropdown() {
    const sel = document.getElementById('listSelector');
    sel.innerHTML = '<option value="" disabled selected>Select a List...</option>';
    activeLists.forEach(l => { sel.innerHTML += `<option value="${l.name}">${l.name}</option>`; });
    sel.innerHTML += `<option value="_NEW_" class="text-primary fw-bold">+ Create New List</option>`;
    
    const curr = sel.getAttribute('data-curr');
    if (curr && activeLists.find(x => x.name === curr)) { sel.value = curr; handleListChange(); } 
    else if(activeLists.length > 0) { sel.value = activeLists[0].name; handleListChange(); }
}

async function handleListChange() {
    const val = document.getElementById('listSelector').value;
    document.getElementById('listSelector').setAttribute('data-curr', val);

    if (val === "_NEW_") {
        const today = new Date().toISOString().split('T')[0];
        let newName = prompt("Enter new list name:", today);
        if(newName) {
            await apiPost({action: "manageList", subAction: "create", listName: newName, username: USER.username, inheritedBudget: latestInheritedBudget});
            document.getElementById('listSelector').setAttribute('data-curr', newName);
            fetchInitData(); 
        } else { document.getElementById('listSelector').value = activeLists[0] ? activeLists[0].name : ""; }
        return;
    }
    
    document.getElementById('tableBody').innerHTML = '<tr><td colspan="20" class="text-center">Loading...</td></tr>';
    const listMeta = activeLists.find(l => l.name === val);
    if(listMeta) document.getElementById('budgetInHand').value = listMeta.budget;

    try {
        const payload = await apiPost({action: "getListData", listName: val});
        if (Array.isArray(payload)) { currentListData = payload; activeVendors = []; } 
        else {
            let fetchedHeaders = payload.headers || BASE_HEADERS;
            let finalPriceIdx = fetchedHeaders.indexOf("Total Estimate");
            activeVendors = (finalPriceIdx > -1 && finalPriceIdx < fetchedHeaders.length - 1) ? fetchedHeaders.slice(finalPriceIdx + 1) : [];
            currentListData = payload.rows || [];
        }
        currentListData.forEach(r => { r._isEditing = false; });
        renderTable();
    } catch (e) { document.getElementById('tableBody').innerHTML = '<tr><td colspan="20" class="text-danger text-center">Load failed.</td></tr>'; }
}

function toggleCode(elem) {
    const tr = elem.closest('tr');
    const codeInput = tr.querySelector('.pCode');
    const val = elem.value.trim().toLowerCase();
    if (val === 'any' || val === '') { codeInput.value = ''; codeInput.disabled = true; } 
    else codeInput.disabled = false;
}

function renderTable() {
    const thead = document.getElementById('tableHead');
    let vendorHeaders = activeVendors.map(v => `<th class="text-info">${v}</th>`).join('');
    thead.innerHTML = `<tr>
        <th class="sticky-col-0">SL No</th>
        <th class="sticky-col-1 text-center">Action</th>
        <th class="sticky-col-2">Item</th>
        <th class="specs-col">Item Specs</th>
        <th>Preferred Company</th>
        <th>Product Code</th>
        <th>Req Qty</th>
        <th>Unit</th>
        <th>Est Price</th>
        <th>Selected Vendor</th>
        <th class="text-success">Total Estimate</th>
        ${vendorHeaders}
    </tr>`;

    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = "";
    let total = 0;
    
    currentListData.forEach((row, i) => {
        const qty = parseFloat(row['Required Quantity']) || 0;
        const totalEst = parseFloat(row['Total Estimate']) || 0;
        
        if(!row._isEditing) {
            total += totalEst;
            let selVendor = row['Selected Vendor'] || '';
            
            let vendorCells = activeVendors.map(v => {
                let vPrice = row[v] || '';
                let isNA = vPrice === 'NA';
                let isChecked = (selVendor === v) ? 'checked' : '';
                let valToDisplay = isNA ? '' : vPrice;
                return `<td class="vendor-cell">
                    <div class="d-flex align-items-center gap-1">
                        <input type="radio" name="vSelect_${i}" value="${v}" onchange="selectVendor(${i}, '${v}')" ${isChecked} ${isNA ? 'disabled' : ''}>
                        <input type="number" step="0.01" class="form-control form-control-sm" style="width: 75px;" placeholder="Price" value="${valToDisplay}" onchange="updateVendorPrice(${i}, '${v}', this.value)" ${isNA ? 'disabled' : ''}>
                        <button class="btn btn-sm btn-outline-danger py-0 px-1 fw-bold" onclick="toggleVendorNA(${i}, '${v}')" title="Mark NA">🚫</button>
                    </div>
                </td>`;
            }).join('');
            
            tbody.innerHTML += `<tr>
                <td class="sticky-col-0">${i + 1}</td>
                <td class="sticky-col-1 text-center text-nowrap">
                    <button class="btn btn-sm btn-outline-primary py-0 px-1" onclick="editRow(${i})" title="Edit"><i class="bi bi-pencil-square"></i></button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteRow(${i})" title="Delete"><i class="bi bi-trash"></i></button>
                </td>
                <td class="sticky-col-2 fw-bold">${row['Item'] || ''}</td>
                <td class="specs-col text-wrap">${row['Item Specs'] || ''}</td>
                <td>${row['Preferred Company'] || ''}</td>
                <td>${row['Product Code'] || ''}</td>
                <td>${row['Required Quantity'] || ''}</td>
                <td>${row['Unit'] || ''}</td>
                <td>${row['Estimated Price'] || ''}</td>
                <td class="fw-bold text-primary">${selVendor}</td>
                <td class="fw-bold text-success">₹${totalEst.toFixed(2)}</td>
                ${vendorCells}
            </tr>`;
        } else {
            let blankVendorCells = activeVendors.map(v => `<td class="text-muted small">Save row first</td>`).join('');
            let isAny = (row['Preferred Company'] || 'Any').toLowerCase() === 'any';
            
            tbody.innerHTML += `<tr id="editRow_${i}" class="table-warning">
                <td class="sticky-col-0">${i + 1}</td>
                <td class="sticky-col-1 text-center text-nowrap">
                    <button class="btn btn-sm btn-success py-0 px-1" onclick="saveRow(${i})" title="Save"><i class="bi bi-check-lg"></i></button>
                    <button class="btn btn-sm btn-danger py-0 px-1 ms-1" onclick="cancelRow(${i})" title="Cancel"><i class="bi bi-x-lg"></i></button>
                </td>
                <td class="sticky-col-2"><input type="text" class="form-control form-control-sm pItem fw-bold" value="${row['Item'] || ''}" list="itemList" onkeydown="handleEnter(event, this, ${i})" placeholder="Item Name"></td>
                <td class="specs-col"><input type="text" class="form-control form-control-sm pSpecs" value="${row['Item Specs'] || ''}" list="specsList" placeholder="Specs (Capacity...)" onkeydown="handleEnter(event, this, ${i})"></td>
                <td><input type="text" class="form-control form-control-sm pComp" value="${row['Preferred Company'] || 'Any'}" list="compList" onchange="toggleCode(this)"></td>
                <td><input type="text" class="form-control form-control-sm pCode" value="${row['Product Code'] || ''}" ${isAny ? 'disabled' : ''}></td>
                <td><input type="number" class="form-control form-control-sm pQty number-box" value="${row['Required Quantity'] || ''}" min="1"></td>
                <td>
                    <select class="form-select form-select-sm pUnit number-box" onchange="checkNewUnit(this)">
                        <option value="${row['Unit'] || 'Piece'}" selected>${row['Unit'] || 'Piece'}</option>
                        <option value="Box">Box</option><option value="Packet">Packet</option><option value="Roll">Roll</option><option value="_NEW_">+ Add</option>
                    </select>
                </td>
                <td><input type="number" step="0.01" class="form-control form-control-sm pEstPrice number-box" value="${row['Estimated Price'] || ''}"></td>
                <td colspan="2" class="text-muted small text-center">Save row first</td>
                ${blankVendorCells}
            </tr>`;
        }
    });
    
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function checkNewUnit(sel) {
    if(sel.value === "_NEW_") {
        const u = prompt("Enter new unit type:");
        if(u) { sel.add(new Option(u, u), sel.options[0]); sel.value = u; }
        else { sel.value = "Piece"; }
    }
}

function handleEnter(e, elem, index) {
    if (e.key === 'Enter' && !e.shiftKey) { 
        e.preventDefault();
        const tr = elem.closest('tr');
        const iVal = tr.querySelector('.pItem').value.trim().toLowerCase();
        
        let match = Object.values(productDB).find(p => p.item.toLowerCase() === iVal);
        if (match) {
            tr.querySelector('.pItem').value = match.item;
            tr.querySelector('.pSpecs').value = match.specs || "";
            tr.querySelector('.pComp').value = match.prefComp || "Any";
            tr.querySelector('.pCode').value = match.code || "";
            toggleCode(tr.querySelector('.pComp'));
            tr.querySelector('.pEstPrice').value = match.estPrice || "";
            
            const uSel = tr.querySelector('.pUnit');
            if(![...uSel.options].some(o => o.value === match.unit)) uSel.add(new Option(match.unit, match.unit));
            uSel.value = match.unit;
        }
    }
}

function openAddVendorModal() { document.getElementById('newVendorName').value = ''; new bootstrap.Modal(document.getElementById('addVendorModal')).show(); }

function confirmAddVendor() {
    const v = document.getElementById('newVendorName').value.trim();
    if(v && !activeVendors.includes(v)) {
        activeVendors.push(v); currentListData.forEach(r => r[v] = ""); renderTable();
    }
    bootstrap.Modal.getInstance(document.getElementById('addVendorModal')).hide();
}

function toggleVendorNA(i, v) {
    if(currentListData[i][v] === 'NA') currentListData[i][v] = ''; 
    else {
        currentListData[i][v] = 'NA';
        if(currentListData[i]['Selected Vendor'] === v) {
            currentListData[i]['Selected Vendor'] = ''; currentListData[i]['Total Estimate'] = '';
        }
    }
    renderTable();
}

function updateVendorPrice(i, v, val) {
    currentListData[i][v] = val;
    if(currentListData[i]['Selected Vendor'] === v) {
        let price = parseFloat(val) || 0;
        let qty = parseFloat(currentListData[i]['Required Quantity']) || 0;
        currentListData[i]['Total Estimate'] = (price * qty).toFixed(2);
    }
    calcTotal();
}

function selectVendor(i, v) {
    currentListData[i]['Selected Vendor'] = v;
    let price = parseFloat(currentListData[i][v]) || 0;
    let qty = parseFloat(currentListData[i]['Required Quantity']) || 0;
    currentListData[i]['Total Estimate'] = (price * qty).toFixed(2);
    calcTotal(); renderTable(); 
}

function optimizeVendors() {
    currentListData.forEach(row => {
        if(row._isEditing) return;
        let bestVendor = ''; let minPrice = Infinity;
        activeVendors.forEach(v => {
            let p = parseFloat(row[v]);
            if(!isNaN(p) && p > 0 && p < minPrice && row[v] !== 'NA') { minPrice = p; bestVendor = v; }
        });
        if(bestVendor) {
            row['Selected Vendor'] = bestVendor;
            let qty = parseFloat(row['Required Quantity']) || 0;
            row['Total Estimate'] = (minPrice * qty).toFixed(2);
        }
    });
    renderTable();
}

function calcTotal() {
    let total = 0;
    currentListData.forEach(r => { total += parseFloat(r['Total Estimate']) || 0; });
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function addNewRow() {
    let newRow = { _isEditing: true, _isNew: true, 'Required Quantity': 1 };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);
    renderTable();
    const tContainer = document.querySelector('.table-responsive'); tContainer.scrollTop = tContainer.scrollHeight;
}

function editRow(i) {
    currentListData[i]._isEditing = true;
    currentListData[i]._origState = {...currentListData[i]}; 
    renderTable();
}

function cancelRow(i) {
    if (currentListData[i]._isNew) currentListData.splice(i, 1);
    else { currentListData[i] = currentListData[i]._origState; currentListData[i]._isEditing = false; }
    renderTable();
}

async function deleteRow(i) {
    if(confirm("Delete this item from the list?")) { currentListData.splice(i, 1); await syncTableToBackend(); }
}

async function saveRow(i) {
    const tr = document.getElementById(`editRow_${i}`);
    const item = tr.querySelector('.pItem').value.trim();
    const specs = tr.querySelector('.pSpecs').value.trim();
    const qty = parseFloat(tr.querySelector('.pQty').value) || 0;

    if (!item) return alert("Item Name is required.");
    if (qty < 1) return alert("Quantity must be at least 1.");

    let sv = currentListData[i]._origState ? currentListData[i]._origState['Selected Vendor'] : '';
    
    currentListData[i] = {
        'Item': item, 'Item Specs': specs, 'Preferred Company': tr.querySelector('.pComp').value || 'Any',
        'Product Code': tr.querySelector('.pCode').value, 'Required Quantity': qty,
        'Unit': tr.querySelector('.pUnit').value, 'Estimated Price': tr.querySelector('.pEstPrice').value,
        'Selected Vendor': sv, _isEditing: false
    };

    activeVendors.forEach(v => { currentListData[i][v] = currentListData[i]._origState ? currentListData[i]._origState[v] : ''; });
    
    if(sv && currentListData[i][sv] && currentListData[i][sv] !== 'NA') {
        currentListData[i]['Total Estimate'] = (parseFloat(currentListData[i][sv]) * qty).toFixed(2);
    } else currentListData[i]['Total Estimate'] = '';

    const btns = tr.querySelectorAll('button');
    btns[0].innerHTML = '<i class="bi bi-hourglass-split"></i>'; btns[0].disabled = true; btns[1].disabled = true;

    await syncTableToBackend();
}

async function saveTableEdits() {
    const btn = document.getElementById('btnSaveEdits'); btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Saving...`; btn.disabled = true;
    await syncTableToBackend();
    btn.innerHTML = `<i class="bi bi-floppy"></i> Save Table Edits`; btn.disabled = false;
}

async function syncTableToBackend() {
    try {
        const cleanData = currentListData.filter(r => !r._isEditing);
        const allHeaders = BASE_HEADERS.concat(activeVendors);
        await apiPost({ action: "saveTableEdits", listName: document.getElementById('listSelector').value, headers: allHeaders, tableData: cleanData });
        const initRes = await apiPost({action: "getInit", username: USER.username, role: USER.role});
        productDB = initRes.products; vendorDB = initRes.vendors;
        renderTable();
    } catch(e) { alert("Failed to sync list."); renderTable(); }
}

function calcBalance() {
    const t = parseFloat(document.getElementById('totalBudget').innerText.replace('₹',''));
    const h = parseFloat(document.getElementById('budgetInHand').value) || 0;
    const bal = h - t;
    document.getElementById('budgetBalance').innerHTML = bal < 0 ? `<span class="text-danger">Shortage: ₹${Math.abs(bal).toFixed(2)}</span>` : `<span class="text-primary">Remaining: ₹${bal.toFixed(2)}</span>`;
}
document.getElementById('budgetInHand').addEventListener('input', calcBalance);

async function updateBudget() {
    const b = document.getElementById('budgetInHand').value;
    await apiPost({action: "manageList", subAction: "updateMeta", listName: document.getElementById('listSelector').value, budget: b});
    latestInheritedBudget = b; alert("Budget saved.");
}

function manageList() {
    const lName = document.getElementById('listSelector').value; if(!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    document.getElementById('listRename').value = lName;
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    if (USER.role === "Admin" || USER.role === "Lab Supervisor" || meta.owner === USER.username) document.getElementById('listRename').disabled = false;
    else document.getElementById('listRename').disabled = true;
    new bootstrap.Modal(document.getElementById('listModal')).show();
}

async function renameList() {
    const oldName = document.getElementById('listSelector').value; const newName = document.getElementById('listRename').value.trim();
    if (!newName || oldName === newName) return;
    await apiPost({action: "manageList", subAction: "rename", oldName: oldName, newName: newName});
    document.getElementById('listSelector').setAttribute('data-curr', newName); bootstrap.Modal.getInstance(document.getElementById('listModal')).hide(); fetchInitData();
}

async function deleteList() {
    const lName = document.getElementById('listSelector').value;
    if(confirm(`Are you absolutely sure you want to delete the list '${lName}'?`)) {
        await apiPost({action: "manageList", subAction: "delete", listName: lName});
        document.getElementById('listSelector').setAttribute('data-curr', ""); bootstrap.Modal.getInstance(document.getElementById('listModal')).hide(); fetchInitData();
    }
}
async function saveListSettings() {
    await apiPost({action: "manageList", subAction: "updateMeta", listName: document.getElementById('listSelector').value, collabs: document.getElementById('listCollabs').value});
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide(); fetchInitData();
}

// -------------------------------------------------------------
// VIRTUALIZED INVENTORY SYSTEM WITH SMART MULTI-KEYWORD SEARCH
// -------------------------------------------------------------
let inventorySearchTerm = "";

function openInventoryModal() {
    inventorySearchTerm = ""; document.getElementById('invSearch').value = "";
    renderInventoryTable(); const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('inventoryModal')); modal.show();
}

function renderInventoryTable() {
    const tbody = document.getElementById('invBody');
    const rawTerm = inventorySearchTerm.toLowerCase().trim();
    
    if (rawTerm.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-4"><i class="bi bi-search fs-4 d-block mb-2"></i> Start typing to search DB...</td></tr>`;
        return;
    }

    const keywords = rawTerm.split(/[\s;,]+/).filter(kw => kw.length > 0);
    let count = 0; const MAX_RESULTS = 50; let htmlBuffer = ""; 
    
    for(const [dbId, p] of Object.entries(productDB)) {
        if (count >= MAX_RESULTS) break;
        const searchableText = `${p.item || ''} ${p.specs || ''} ${p.prefComp || ''} ${p.code || ''}`.toLowerCase();
        
        if (!keywords.every(kw => searchableText.includes(kw))) continue;
        
        let actionBtns = `<button class="btn btn-sm btn-outline-success py-0 px-1 me-1 text-nowrap" onclick="addFromInventory('${dbId}')"><i class="bi bi-plus-circle"></i> Add</button>`;
        if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
            actionBtns += `<button class="btn btn-sm btn-outline-warning py-0 px-1" onclick="openEditProduct('${dbId}')"><i class="bi bi-pencil-square"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteProduct('${dbId}')"><i class="bi bi-trash"></i></button>`;
        }
        
        htmlBuffer += `<tr>
            <td class="fw-bold">${p.item || ''}</td>
            <td class="text-wrap">${p.specs || ''}</td>
            <td>${p.prefComp || ''}</td>
            <td>${p.code || ''}</td>
            <td>${p.unit || ''}</td>
            <td>${p.estPrice || ''}</td>
            <td class="text-center text-nowrap">${actionBtns}</td>
        </tr>`;
        count++;
    }
    
    if (count === 0) {
        const kwString = keywords.map(k => `"${k}"`).join(", ");
        htmlBuffer = `<tr><td colspan="7" class="text-center text-danger p-3 fw-bold"><i class="bi bi-exclamation-triangle"></i> No products matched all keywords: ${kwString}</td></tr>`;
    } else if (count === MAX_RESULTS) {
        htmlBuffer += `<tr><td colspan="7" class="text-center text-muted bg-light">Showing top ${MAX_RESULTS} results...</td></tr>`;
    }
    tbody.innerHTML = htmlBuffer; 
}

function addFromInventory(dbId) {
    const p = productDB[dbId]; if (!p) return;
    let newRow = {
        'Item': p.item, 'Item Specs': p.specs || '', 'Preferred Company': p.prefComp || 'Any',
        'Product Code': p.code || '', 'Required Quantity': 1, 'Unit': p.unit || 'Piece',
        'Estimated Price': p.estPrice || '', 'Selected Vendor': '', 'Total Estimate': '',
        _isEditing: true, _isNew: true
    };
    activeVendors.forEach(v => newRow[v] = ""); currentListData.push(newRow);
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    renderTable(); const tContainer = document.querySelector('.table-responsive'); tContainer.scrollTop = tContainer.scrollHeight;
}

function openEditProduct(dbId) {
    const p = productDB[dbId];
    document.getElementById('editDbId').value = dbId;
    document.getElementById('editItem').value = p.item;
    document.getElementById('editSpecs').value = p.specs || '';
    document.getElementById('editComp').value = p.prefComp || 'Any';
    document.getElementById('editCode').value = p.code || '';
    document.getElementById('editUnit').value = p.unit || '';
    document.getElementById('editPrice').value = p.estPrice || '';
    toggleModalCode();
    
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    new bootstrap.Modal(document.getElementById('fullEditModal')).show();
}

function toggleModalCode() {
    const comp = document.getElementById('editComp').value.trim().toLowerCase();
    const cBox = document.getElementById('editCode');
    if(comp === 'any' || comp === '') { cBox.value = ''; cBox.disabled = true; } else cBox.disabled = false;
}

async function submitProductEdit() {
    const btn = document.querySelector('#fullEditModal .btn-success'); btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...'; btn.disabled = true;
    const payload = {
        action: "updateProduct", role: USER.role, 
        product: { 
            dbId: document.getElementById('editDbId').value, item: document.getElementById('editItem').value, 
            specs: document.getElementById('editSpecs').value, prefComp: document.getElementById('editComp').value || 'Any', 
            code: document.getElementById('editCode').value, unit: document.getElementById('editUnit').value, estPrice: document.getElementById('editPrice').value 
        }
    };
    await apiPost(payload); await fetchInitData(); 
    bootstrap.Modal.getInstance(document.getElementById('fullEditModal')).hide();
    renderInventoryTable(); btn.innerHTML = '<i class="bi bi-floppy"></i> Save to DB'; btn.disabled = false;
}

async function deleteProduct(dbId) {
    if(confirm(`Are you sure you want to delete this product from the master DB?`)) {
        await apiPost({action: "deleteProduct", role: USER.role, dbId: dbId});
        await fetchInitData(); renderInventoryTable(); 
    }
}

async function openUsersModal() {
    const res = await apiPost({action: "manageUsers", subAction: "get", role: USER.role});
    if(res.status === "success") {
        const tbody = document.getElementById('usersBody'); tbody.innerHTML = "";
        res.users.forEach(u => {
            const btn = (u.username === "admin") ? "" : `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteUser('${u.username}')"><i class="bi bi-trash"></i></button>`;
            tbody.innerHTML += `<tr><td>${u.username}</td><td>${u.role}</td><td class="text-center">${btn}</td></tr>`;
        });
        new bootstrap.Modal(document.getElementById('usersModal')).show();
    }
}
document.getElementById('addUserForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const res = await apiPost({action: "manageUsers", subAction: "add", role: USER.role, newUser: document.getElementById('newUName').value.trim(), newPass: document.getElementById('newUPass').value.trim(), newRole: document.getElementById('newURole').value});
    if(res.status === "success") { e.target.reset(); openUsersModal(); } else alert(res.message);
});
async function deleteUser(username) {
    if(confirm(`Delete user ${username}?`)) { await apiPost({action: "manageUsers", subAction: "delete", role: USER.role, targetUser: username}); openUsersModal(); }
}

function openExportModal(type) {
    currentExportType = type;
    let vendorOptions = `<option value="ALL">Master List (All Active)</option>`;
    activeVendors.forEach(v => vendorOptions += `<option value="${v}">${v} List</option>`);
    const sel = document.getElementById('exportVendorSelect'); if(sel) sel.innerHTML = vendorOptions;
    renderExportCheckboxes(); new bootstrap.Modal(document.getElementById('exportModal')).show();
}

function renderExportCheckboxes() {
    let mode = document.getElementById('exportVendorSelect') ? document.getElementById('exportVendorSelect').value : "ALL";
    let colsToOffer = (mode === "ALL") ? BASE_HEADERS.concat(activeVendors) : ["SL No", "Item", "Item Specs", "Preferred Company", "Product Code", "Required Quantity", "Unit", "Total Estimate"];
    document.getElementById('exportColCheckboxes').innerHTML = colsToOffer.map((c, i) => `<div class="form-check"><input class="form-check-input exp-chk" type="checkbox" value="${c}" id="chk${i}" checked><label class="form-check-label" for="chk${i}">${c}</label></div>`).join('');
}

function executeExport() {
    bootstrap.Modal.getInstance(document.getElementById('exportModal')).hide();
    const selectedCols = Array.from(document.querySelectorAll('.exp-chk:checked')).map(cb => cb.value);
    if(selectedCols.length === 0) return alert("Select at least one column.");
    const mode = document.getElementById('exportVendorSelect').value; const baseListName = document.getElementById('listSelector').value;
    const fileName = mode === "ALL" ? baseListName : `${baseListName}_${mode}`;

    let sourceData = currentListData.filter(r => !r._isEditing);
    if(mode !== "ALL") sourceData = sourceData.filter(r => r['Selected Vendor'] === mode);
    const exportData = sourceData.map((row, index) => { let obj = {}; selectedCols.forEach(col => { obj[col] = (col === "SL No") ? (index + 1) : row[col]; }); return obj; });

    if (currentExportType === 'excel') { const ws = XLSX.utils.json_to_sheet(exportData); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Export"); XLSX.writeFile(wb, `${fileName}.xlsx`); } 
    else if (currentExportType === 'csv') { const blob = new Blob([XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(exportData))], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${fileName}.csv`; link.click(); } 
    else if (currentExportType === 'pdf') { const doc = new jspdf.jsPDF('landscape'); doc.text(`Dr. Nimmi Das Lab - ${fileName}`, 14, 15); doc.autoTable({ head: [selectedCols], body: exportData.map(obj => selectedCols.map(col => obj[col])), startY: 20, styles: { fontSize: 8 } }); doc.save(`${fileName}.pdf`); } 
    else if (currentExportType === 'print') { let win = window.open('', '', 'width=900,height=600'); let html = `<html><head><title>${fileName}</title><style>table{width:100%; border-collapse:collapse;} th,td{border:1px solid #000; padding:5px;}</style></head><body><h2>Dr. Nimmi Das Lab - ${fileName}</h2><table><thead><tr>`; selectedCols.forEach(c => html += `<th>${c}</th>`); html += `</tr></thead><tbody>`; exportData.forEach(row => { html += `<tr>`; selectedCols.forEach(c => html += `<td>${row[c] || ''}</td>`); html += `</tr>`; }); html += `</tbody></table></body></html>`; win.document.write(html); win.document.close(); win.print(); }
}

// -------------------------------------------------------------
// GLOBAL EVENT LISTENERS (Virtualization & Cascading Dropdowns)
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    
    // 1. SMART CASCADING DROPDOWNS
    function handleDatalist(e) {
        if (!e.target.matches('input[list]')) return;
        const term = e.target.value.toLowerCase().trim();
        const listId = e.target.getAttribute('list'); 
        const dataList = document.getElementById(listId);
        if (!dataList) return; 
        
        // Cascading Logic: Check if an Item is already selected in this row
        const tr = e.target.closest('tr');
        let currentItem = "";
        if (tr && tr.querySelector('.pItem')) {
            currentItem = tr.querySelector('.pItem').value.toLowerCase().trim();
        }
        
        let count = 0; let optionsHTML = ''; const added = new Set();
        
        for (const [dbId, p] of Object.entries(productDB)) {
            if (count >= 50) break; // Show up to 50 dropdown options
            let val = null;
            
            if (listId === 'itemList' && p.item && p.item.toLowerCase().includes(term)) {
                val = p.item;
            }
            else if (listId === 'specsList' && p.specs && p.specs.toLowerCase().includes(term)) {
                // If an item is already typed, ONLY show specs for that specific item
                if (!currentItem || (p.item && p.item.toLowerCase() === currentItem)) val = p.specs;
            }
            else if (listId === 'compList' && p.prefComp && p.prefComp.toLowerCase().includes(term)) {
                // If an item is already typed, ONLY show companies for that specific item
                if (!currentItem || (p.item && p.item.toLowerCase() === currentItem)) val = p.prefComp;
            }
            
            if (val && !added.has(val)) { added.add(val); optionsHTML += `<option value="${val}">`; count++; }
        }
        dataList.innerHTML = optionsHTML;
    }

    // Trigger dropdown calculation on Click, Focus, and Typing
    document.getElementById('tableBody').addEventListener('input', handleDatalist);
    document.getElementById('tableBody').addEventListener('click', handleDatalist);
    document.getElementById('tableBody').addEventListener('focusin', handleDatalist);

    // 2. INVENTORY MODAL SMART SEARCH
    document.getElementById('invSearch').addEventListener('input', function() { 
        inventorySearchTerm = this.value; renderInventoryTable(); 
    });
    
    // 3. MAIN TABLE SMART SEARCH FILTER
    document.getElementById('searchInput').addEventListener('input', function() {
        const keywords = this.value.toLowerCase().trim().split(/[\s;,]+/).filter(kw => kw.length > 0);
        const rows = document.getElementById('tableBody').getElementsByTagName('tr');
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('table-warning')) continue; 
            if (keywords.length === 0) { rows[i].style.display = ""; continue; }
            const isMatch = keywords.every(kw => rows[i].innerText.toLowerCase().includes(kw));
            rows[i].style.display = isMatch ? "" : "none";
        }
    });
});
