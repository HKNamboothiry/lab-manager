const API_URL = "https://script.google.com/macros/s/AKfycbwet17KJDzMQl0FlMOaqB8M0otVWCckd9DEnq4vlnvmOHRix1HBNaYpaVRtxYM6r2Y/exec";
    
let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let activeVendors = [];
let vendorDB = [];
let latestInheritedBudget = 0;
let currentExportType = "";

const BASE_HEADERS = ["SL No", "Product Code", "Product Name", "Category", "Company", "Company Specs", "Min Qty", "Qty", "Unit", "Company Price", "Selected Vendor", "Final Price"];

async function apiPost(payload) {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    return await res.json();
}

if (sessionStorage.getItem("user")) { USER = JSON.parse(sessionStorage.getItem("user")); showApp(); }

async function verifyLogin() {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    const btn = document.getElementById('loginBtn');
    const err = document.getElementById('loginError');
    if (!u || !p) return;

    btn.innerText = "Verifying..."; btn.disabled = true; err.style.display = 'none';
    try {
        const data = await apiPost({action: "login", username: u, password: p});
        if (data.status === "success") {
            USER = { username: u, role: data.role };
            sessionStorage.setItem("user", JSON.stringify(USER));
            showApp();
        } else { err.innerText = data.message; err.style.display = 'block'; }
    } catch (e) { err.innerText = "Connection error."; err.style.display = 'block'; } 
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
            document.getElementById('vendorList').innerHTML = vendorDB.map(v => `<option value="${v}">`).join('');
            populateListDropdown(); updateDatalists();
        }
    } catch (e) { alert("Failed to fetch initial data."); }
}

function populateListDropdown() {
    const sel = document.getElementById('listSelector');
    sel.innerHTML = '<option value="" disabled selected>Select a List...</option>';
    activeLists.forEach(l => { sel.innerHTML += `<option value="${l.name}">${l.name}</option>`; });
    sel.innerHTML += `<option value="_NEW_" class="text-primary fw-bold">+ Create New List</option>`;
    
    const curr = sel.getAttribute('data-curr');
    if (curr && activeLists.find(x => x.name === curr)) {
        sel.value = curr; handleListChange();
    } else if(activeLists.length > 0) { 
        sel.value = activeLists[0].name; handleListChange(); 
    }
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
        
        if (Array.isArray(payload)) {
            currentListData = payload;
            activeVendors = [];
        } else {
            let fetchedHeaders = payload.headers || BASE_HEADERS;
            let finalPriceIdx = fetchedHeaders.indexOf("Final Price");
            activeVendors = (finalPriceIdx > -1 && finalPriceIdx < fetchedHeaders.length - 1) ? fetchedHeaders.slice(finalPriceIdx + 1) : [];
            currentListData = payload.rows || [];
        }
        
        currentListData.forEach(r => { r._isEditing = false; });
        renderTable();
    } catch (e) { 
        console.error("Data Load Error:", e);
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="20" class="text-danger text-center fw-bold">Load failed. Please verify API deployment.</td></tr>'; 
    }
}

function renderTable() {
    const thead = document.getElementById('tableHead');
    let vendorHeaders = activeVendors.map(v => `<th class="text-info">${v}</th>`).join('');
    thead.innerHTML = `<tr>
        <th class="sticky-col-0">SL No</th>
        <th class="sticky-col-1 text-center">Action</th>
        <th class="sticky-col-2">Code</th>
        <th class="sticky-col-3">Name</th>
        <th class="sticky-col-4">Category</th>
        <th>Company</th>
        <th class="specs-col">Specifications</th>
        <th>Min Qty</th>
        <th>Req Qty</th>
        <th>Unit</th>
        <th>Est Price</th>
        <th>Selected Vendor</th>
        <th class="text-success">Final Price</th>
        ${vendorHeaders}
    </tr>`;

    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = "";
    let total = 0;
    
    currentListData.forEach((row, i) => {
        const mQty = productDB[row['Product Code']] ? productDB[row['Product Code']].minQty : (row['Min Qty'] || 1);
        const qty = parseFloat(row['Qty']) || 0;
        const price = parseFloat(row['Final Price']) || 0;
        
        if(!row._isEditing) {
            total += (qty * price);
            let selVendor = row['Selected Vendor'] || '';
            
            let vendorCells = activeVendors.map(v => {
                let vPrice = row[v] || '';
                let isNA = vPrice === 'NA';
                let isChecked = (selVendor === v) ? 'checked' : '';
                let valToDisplay = isNA ? '' : vPrice;
                return `<td class="vendor-cell">
                    <div class="d-flex align-items-center gap-1">
                        <input type="radio" name="vSelect_${i}" value="${v}" onchange="selectVendor(${i}, '${v}')" ${isChecked} ${isNA ? 'disabled' : ''}>
                        <input type="number" step="0.01" class="form-control form-control-sm" style="width: 75px;" value="${valToDisplay}" onchange="updateVendorPrice(${i}, '${v}', this.value)" ${isNA ? 'disabled' : ''}>
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
                <td class="sticky-col-2 fw-bold">${row['Product Code'] || ''}</td>
                <td class="sticky-col-3 text-wrap name-col">${row['Product Name'] || ''}</td>
                <td class="sticky-col-4">${row['Category'] || ''}</td>
                <td>${row['Company'] || ''}</td>
                <td class="specs-col text-wrap">${row['Company Specs'] || ''}</td>
                <td class="text-center">${mQty}</td>
                <td>${row['Qty'] || ''}</td>
                <td>${row['Unit'] || ''}</td>
                <td>${row['Company Price'] || ''}</td>
                <td class="fw-bold text-primary">${selVendor}</td>
                <td class="fw-bold text-success">₹${price}</td>
                ${vendorCells}
            </tr>`;
        } else {
            const actMin = row._minQty || mQty;
            let blankVendorCells = activeVendors.map(v => `<td class="text-muted small">Save row first</td>`).join('');
            
            tbody.innerHTML += `<tr id="editRow_${i}" class="table-warning">
                <td class="sticky-col-0">${i + 1}</td>
                <td class="sticky-col-1 text-center text-nowrap">
                    <button class="btn btn-sm btn-success py-0 px-1" onclick="saveRow(${i})" title="Save"><i class="bi bi-check-lg"></i></button>
                    <button class="btn btn-sm btn-danger py-0 px-1 ms-1" onclick="cancelRow(${i})" title="Cancel"><i class="bi bi-x-lg"></i></button>
                </td>
                <td class="sticky-col-2"><input type="text" class="form-control form-control-sm pCode fw-bold" value="${row['Product Code'] || ''}" list="codeList" onkeydown="handleEnter(event, this, ${i})" placeholder="Code"></td>
                <td class="sticky-col-3 name-col"><textarea class="form-control form-control-sm pName" rows="2" list="nameList" onkeydown="handleEnter(event, this, ${i})" placeholder="Name (Enter)">${row['Product Name'] || ''}</textarea></td>
                <td class="sticky-col-4"><input type="text" class="form-control form-control-sm pCategory" value="${row['Category'] || ''}" list="categoryList"></td>
                <td><input type="text" class="form-control form-control-sm pCompany" value="${row['Company'] || ''}" list="companyList"></td>
                <td class="specs-col"><textarea class="form-control form-control-sm pSpecs" rows="2">${row['Company Specs'] || ''}</textarea></td>
                <td><input type="number" class="form-control form-control-sm pMinQty number-box" value="${actMin}" ${row._lockUnit ? 'disabled' : ''}></td>
                <td><input type="number" class="form-control form-control-sm pQty number-box" value="${row['Qty'] || ''}" min="${actMin}"></td>
                <td>
                    <select class="form-select form-select-sm pUnit number-box" onchange="checkNewUnit(this)" ${row._lockUnit ? 'disabled' : ''}>
                        <option value="${row['Unit'] || 'Piece'}" selected>${row['Unit'] || 'Piece'}</option>
                        <option value="Box">Box</option><option value="Packet">Packet</option><option value="_NEW_">+ Add</option>
                    </select>
                </td>
                <td><input type="number" step="0.01" class="form-control form-control-sm pCompPrice number-box" value="${row['Company Price'] || ''}"></td>
                <td colspan="2" class="text-muted small text-center">Save row first</td>
                ${blankVendorCells}
            </tr>`;
        }
    });
    
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function openAddVendorModal() {
    document.getElementById('newVendorName').value = '';
    new bootstrap.Modal(document.getElementById('addVendorModal')).show();
}

function confirmAddVendor() {
    const v = document.getElementById('newVendorName').value.trim();
    if(v && !activeVendors.includes(v)) {
        activeVendors.push(v);
        currentListData.forEach(r => r[v] = ""); 
        renderTable();
    }
    bootstrap.Modal.getInstance(document.getElementById('addVendorModal')).hide();
}

function toggleVendorNA(i, v) {
    if(currentListData[i][v] === 'NA') {
        currentListData[i][v] = ''; 
    } else {
        currentListData[i][v] = 'NA';
        if(currentListData[i]['Selected Vendor'] === v) {
            currentListData[i]['Selected Vendor'] = '';
            currentListData[i]['Final Price'] = '';
        }
    }
    renderTable();
}

function updateVendorPrice(i, v, val) {
    currentListData[i][v] = val;
    if(currentListData[i]['Selected Vendor'] === v) currentListData[i]['Final Price'] = val;
    calcTotal();
}

function selectVendor(i, v) {
    currentListData[i]['Selected Vendor'] = v;
    currentListData[i]['Final Price'] = currentListData[i][v];
    calcTotal();
    renderTable(); 
}

function optimizeVendors() {
    currentListData.forEach(row => {
        if(row._isEditing) return;
        let bestVendor = ''; let minPrice = Infinity;
        activeVendors.forEach(v => {
            let p = parseFloat(row[v]);
            if(!isNaN(p) && p > 0 && p < minPrice) {
                minPrice = p; bestVendor = v;
            }
        });
        if(bestVendor) {
            row['Selected Vendor'] = bestVendor;
            row['Final Price'] = minPrice;
        }
    });
    renderTable();
}

function calcTotal() {
    let total = 0;
    currentListData.forEach(r => {
        const qty = parseFloat(r['Qty']) || 0;
        const price = parseFloat(r['Final Price']) || 0;
        total += (qty * price);
    });
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function addNewRow() {
    let newRow = { _isEditing: true, _isNew: true, 'Qty': 1, '_minQty': 1 };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);
    renderTable();
    const tContainer = document.querySelector('.table-responsive');
    tContainer.scrollTop = tContainer.scrollHeight;
}

function editRow(i) {
    currentListData[i]._isEditing = true;
    currentListData[i]._origState = {...currentListData[i]}; 
    const code = currentListData[i]['Product Code'];
    if(productDB[code]) {
        currentListData[i]._minQty = productDB[code].minQty;
        currentListData[i]._lockUnit = !!productDB[code].unit;
    }
    renderTable();
}

function cancelRow(i) {
    if (currentListData[i]._isNew) currentListData.splice(i, 1);
    else { currentListData[i] = currentListData[i]._origState; currentListData[i]._isEditing = false; }
    renderTable();
}

async function deleteRow(i) {
    if(confirm("Delete this item from the list?")) {
        currentListData.splice(i, 1);
        await syncTableToBackend();
    }
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
        fillRowByData(elem, index);
    }
}

function updateDatalists() {
    const c = new Set(), n = new Set(), comp = new Set(), code = new Set();
    for (const [cd, p] of Object.entries(productDB)) {
        if (p.category) c.add(p.category); code.add(cd); if(p.name) n.add(p.name); if(p.company) comp.add(p.company);
    }
    document.getElementById('categoryList').innerHTML = [...c].map(x=>`<option value="${x}">`).join('');
    document.getElementById('codeList').innerHTML = [...code].map(x=>`<option value="${x}">`).join('');
    document.getElementById('nameList').innerHTML = [...n].map(x=>`<option value="${x}">`).join('');
    document.getElementById('companyList').innerHTML = [...comp].map(x=>`<option value="${x}">`).join('');
}

function fillRowByData(elem, index) {
    const tr = elem.closest('tr');
    const cVal = tr.querySelector('.pCode').value.trim();
    const nVal = tr.querySelector('.pName').value.trim().toLowerCase();
    
    let match = null, codeKey = null;
    if (productDB[cVal]) { match = productDB[cVal]; codeKey = cVal; }
    else {
        for (const [k, v] of Object.entries(productDB)) {
            if (v.name.toLowerCase() === nVal) { match = v; codeKey = k; break; }
        }
    }

    if (match) {
        tr.querySelector('.pCode').value = codeKey;
        tr.querySelector('.pCategory').value = match.category || "";
        tr.querySelector('.pName').value = match.name || "";
        tr.querySelector('.pCompany').value = match.company || "";
        tr.querySelector('.pSpecs').value = match.specs || "";
        tr.querySelector('.pCompPrice').value = match.compPrice || "";
        
        tr.querySelector('.pMinQty').value = match.minQty || 1;
        tr.querySelector('.pMinQty').disabled = true; 
        
        const uSel = tr.querySelector('.pUnit');
        if(![...uSel.options].some(o => o.value === match.unit)) uSel.add(new Option(match.unit, match.unit));
        uSel.value = match.unit;
        uSel.disabled = true; 
        
        tr.querySelector('.pQty').min = match.minQty || 1;
        if(parseFloat(tr.querySelector('.pQty').value) < match.minQty) {
            tr.querySelector('.pQty').value = match.minQty;
        }
    } else {
        tr.querySelector('.pUnit').disabled = false;
        tr.querySelector('.pMinQty').disabled = false;
        tr.querySelector('.pQty').min = 1;
    }
}

async function saveRow(i) {
    const tr = document.getElementById(`editRow_${i}`);
    const code = tr.querySelector('.pCode').value.trim();
    const name = tr.querySelector('.pName').value.trim();
    const comp = tr.querySelector('.pCompany').value.trim();
    const qty = parseFloat(tr.querySelector('.pQty').value) || 0;
    const minQty = parseFloat(tr.querySelector('.pMinQty').value) || 1;

    if (!code || !name) return alert("Code and Name are required.");
    if (qty < minQty) return alert(`Quantity cannot be less than Minimum Qty (${minQty})`);
    
    const dup = currentListData.findIndex((r, idx) => idx !== i && r['Product Code'] === code && r['Company'] === comp && !r._isEditing);
    if (dup > -1) return alert("This product already exists in this list!");

    let sv = currentListData[i]._origState ? currentListData[i]._origState['Selected Vendor'] : '';
    let fp = currentListData[i]._origState ? currentListData[i]._origState['Final Price'] : '';

    currentListData[i] = {
        'Product Code': code, 'Product Name': name, 'Category': tr.querySelector('.pCategory').value,
        'Company': comp, 'Company Specs': tr.querySelector('.pSpecs').value, 'Min Qty': minQty, 'Qty': qty,
        'Unit': tr.querySelector('.pUnit').value, 'Company Price': tr.querySelector('.pCompPrice').value,
        'Selected Vendor': sv, 'Final Price': fp,
        _isEditing: false
    };

    activeVendors.forEach(v => { currentListData[i][v] = currentListData[i]._origState ? currentListData[i]._origState[v] : ''; });

    const btns = tr.querySelectorAll('button');
    btns[0].innerHTML = '<i class="bi bi-hourglass-split"></i>'; btns[0].disabled = true; btns[1].disabled = true;

    await syncTableToBackend();
}

async function saveTableEdits() {
    const btn = document.getElementById('btnSaveEdits');
    btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Saving...`; btn.disabled = true;
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
        document.getElementById('vendorList').innerHTML = vendorDB.map(v => `<option value="${v}">`).join('');
        updateDatalists();
        renderTable();
    } catch(e) {
        alert("Failed to sync list to server.");
        renderTable(); 
    }
}

function calcBalance() {
    const t = parseFloat(document.getElementById('totalBudget').innerText.replace('₹',''));
    const h = parseFloat(document.getElementById('budgetInHand').value) || 0;
    const bal = h - t;
    document.getElementById('budgetBalance').innerHTML = bal < 0 ? `<span class="text-danger">Shortage: ₹${Math.abs(bal).toFixed(2)}</span>` : `<span class="text-primary">Remaining: ₹${bal.toFixed(2)}</span>`;
}
document.getElementById('budgetInHand').addEventListener('input', calcBalance);

async function updateBudget() {
    const lName = document.getElementById('listSelector').value;
    const b = document.getElementById('budgetInHand').value;
    await apiPost({action: "manageList", subAction: "updateMeta", listName: lName, budget: b});
    latestInheritedBudget = b;
    alert("Budget saved for this list.");
}

function manageList() {
    const lName = document.getElementById('listSelector').value;
    if(!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    
    document.getElementById('listRename').value = lName;
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    
    if (USER.role === "Admin" || USER.role === "Lab Supervisor" || meta.owner === USER.username) document.getElementById('listRename').disabled = false;
    else document.getElementById('listRename').disabled = true;
    
    new bootstrap.Modal(document.getElementById('listModal')).show();
}

async function renameList() {
    const oldName = document.getElementById('listSelector').value;
    const newName = document.getElementById('listRename').value.trim();
    if (!newName || oldName === newName) return;
    if (activeLists.some(l => l.name === newName)) return alert("List name already exists!");
    await apiPost({action: "manageList", subAction: "rename", oldName: oldName, newName: newName});
    document.getElementById('listSelector').setAttribute('data-curr', newName);
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

async function deleteList() {
    const lName = document.getElementById('listSelector').value;
    const meta = activeLists.find(l => l.name === lName);
    if (USER.role !== "Admin" && USER.role !== "Lab Supervisor" && meta.owner !== USER.username) return alert("You do not have permission to delete this list.");
    
    if(confirm(`Are you absolutely sure you want to delete the list '${lName}'? This cannot be undone.`)) {
        await apiPost({action: "manageList", subAction: "delete", listName: lName});
        document.getElementById('listSelector').setAttribute('data-curr', "");
        bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
        fetchInitData();
    }
}

async function saveListSettings() {
    const lName = document.getElementById('listSelector').value;
    const cols = document.getElementById('listCollabs').value;
    await apiPost({action: "manageList", subAction: "updateMeta", listName: lName, collabs: cols});
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

// -- Inventory Management --
function openInventoryModal() {
    const tbody = document.getElementById('invBody');
    tbody.innerHTML = '';
    for(const [code, p] of Object.entries(productDB)) {
        let actionBtns = `<button class="btn btn-sm btn-outline-success py-0 px-1 me-1 text-nowrap" onclick="addFromInventory('${code}')" title="Add to List"><i class="bi bi-plus-circle"></i> Add</button>`;
        
        if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
            actionBtns += `<button class="btn btn-sm btn-outline-warning py-0 px-1" onclick="openEditProduct('${code}')" title="Edit"><i class="bi bi-pencil-square"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteProduct('${code}')" title="Delete"><i class="bi bi-trash"></i></button>`;
        } else {
            actionBtns += `<span class="text-muted small ms-1">View Only</span>`;
        }
        tbody.innerHTML += `<tr><td>${code}</td><td class="text-wrap" style="min-width:150px;">${p.name}</td><td>${p.category||''}</td><td>${p.company||''}</td><td class="text-wrap" style="min-width:200px;">${p.specs||''}</td><td>${p.minQty||1}</td><td>${p.unit||''}</td><td>${p.compPrice||''}</td><td class="text-center text-nowrap">${actionBtns}</td></tr>`;
    }
    new bootstrap.Modal(document.getElementById('inventoryModal')).show();
}

function addFromInventory(code) {
    if (!document.getElementById('listSelector').value) return alert("Please select or create a list first.");
    const p = productDB[code]; if (!p) return;
    if (currentListData.findIndex((r) => r['Product Code'] === code && r['Company'] === p.company && !r._isEditing) > -1) {
        alert("This product is already in the current list! You can edit its quantity in the table."); bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide(); return;
    }

    let newRow = {
        'Product Code': code, 'Product Name': p.name, 'Category': p.category || '', 'Company': p.company || '',
        'Company Specs': p.specs || '', 'Min Qty': p.minQty || 1, 'Qty': p.minQty || 1, 'Unit': p.unit || 'Piece',
        'Company Price': p.compPrice || '', 'Selected Vendor': '', 'Final Price': '',
        _isEditing: true, _isNew: true, _minQty: p.minQty || 1, _lockUnit: !!p.unit
    };
    activeVendors.forEach(v => newRow[v] = "");
    currentListData.push(newRow);

    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    renderTable();
    const tContainer = document.querySelector('.table-responsive'); tContainer.scrollTop = tContainer.scrollHeight;
}

// FIXED: Explicitly await Data Refresh and re-open modal
function openEditProduct(code) {
    const p = productDB[code];
    document.getElementById('editOrigCode').value = code;
    document.getElementById('editCode').value = code;
    document.getElementById('editName').value = p.name;
    document.getElementById('editCat').value = p.category || '';
    document.getElementById('editComp').value = p.company || '';
    document.getElementById('editSpecs').value = p.specs || '';
    document.getElementById('editMin').value = p.minQty || 1;
    document.getElementById('editUnit').value = p.unit || '';
    document.getElementById('editPrice').value = p.compPrice || '';
    
    bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    new bootstrap.Modal(document.getElementById('fullEditModal')).show();
}

async function submitProductEdit() {
    const btn = document.querySelector('#fullEditModal .btn-success');
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...'; 
    btn.disabled = true;

    const code = document.getElementById('editOrigCode').value;
    const payload = {
        action: "updateProduct", role: USER.role, 
        product: { code: code, name: document.getElementById('editName').value, category: document.getElementById('editCat').value, company: document.getElementById('editComp').value, specs: document.getElementById('editSpecs').value, compPrice: document.getElementById('editPrice').value, minQty: document.getElementById('editMin').value, unit: document.getElementById('editUnit').value }
    };
    
    await apiPost(payload);
    await fetchInitData(); // Wait for data to sync locally
    
    bootstrap.Modal.getInstance(document.getElementById('fullEditModal')).hide();
    openInventoryModal(); // Force visual refresh of inventory
    
    btn.innerHTML = '<i class="bi bi-floppy"></i> Save Info'; 
    btn.disabled = false;
}

async function deleteProduct(code) {
    if(confirm(`Are you sure you want to delete Product Code: ${code} from the inventory?`)) {
        await apiPost({action: "deleteProduct", role: USER.role, code: code});
        await fetchInitData(); 
        openInventoryModal(); // Force visual refresh
    }
}

document.getElementById('invSearch').addEventListener('keyup', function() {
    const f = this.value.toLowerCase();
    const rows = document.getElementById('invBody').getElementsByTagName('tr');
    for(let i=0; i<rows.length; i++) rows[i].style.display = rows[i].innerText.toLowerCase().includes(f) ? "" : "none";
});

// -- User Management --
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
    if(confirm(`Delete user ${username}?`)) {
        await apiPost({action: "manageUsers", subAction: "delete", role: USER.role, targetUser: username});
        openUsersModal();
    }
}

// -- Export Module --
function openExportModal(type) {
    currentExportType = type;
    let vendorOptions = `<option value="ALL">Master List (All Active)</option>`;
    activeVendors.forEach(v => vendorOptions += `<option value="${v}">${v} List</option>`);
    
    const sel = document.getElementById('exportVendorSelect');
    if(sel) sel.innerHTML = vendorOptions;
    
    renderExportCheckboxes();
    new bootstrap.Modal(document.getElementById('exportModal')).show();
}

function renderExportCheckboxes() {
    let mode = document.getElementById('exportVendorSelect') ? document.getElementById('exportVendorSelect').value : "ALL";
    let colsToOffer = (mode === "ALL") ? BASE_HEADERS.concat(activeVendors) : ["SL No", "Product Code", "Product Name", "Qty", "Unit", "Final Price"];
    document.getElementById('exportColCheckboxes').innerHTML = colsToOffer.map((c, i) => `<div class="form-check"><input class="form-check-input exp-chk" type="checkbox" value="${c}" id="chk${i}" checked><label class="form-check-label" for="chk${i}">${c}</label></div>`).join('');
}

function executeExport() {
    bootstrap.Modal.getInstance(document.getElementById('exportModal')).hide();
    const selectedCols = Array.from(document.querySelectorAll('.exp-chk:checked')).map(cb => cb.value);
    if(selectedCols.length === 0) return alert("Select at least one column.");

    const mode = document.getElementById('exportVendorSelect').value;
    const baseListName = document.getElementById('listSelector').value;
    const fileName = mode === "ALL" ? baseListName : `${baseListName}_${mode}`;

    let sourceData = currentListData.filter(r => !r._isEditing);
    if(mode !== "ALL") sourceData = sourceData.filter(r => r['Selected Vendor'] === mode);

    const exportData = sourceData.map((row, index) => {
        let obj = {}; selectedCols.forEach(col => { obj[col] = (col === "SL No") ? (index + 1) : row[col]; }); return obj;
    });

    if (currentExportType === 'excel') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Export"); XLSX.writeFile(wb, `${fileName}.xlsx`);
    } else if (currentExportType === 'csv') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${fileName}.csv`; link.click();
    } else if (currentExportType === 'pdf') {
        const doc = new jspdf.jsPDF('landscape'); doc.text(`Dr. Nimmi Das Lab - ${fileName}`, 14, 15);
        doc.autoTable({ head: [selectedCols], body: exportData.map(obj => selectedCols.map(col => obj[col])), startY: 20, styles: { fontSize: 8 } });
        doc.save(`${fileName}.pdf`);
    } else if (currentExportType === 'print') {
        let win = window.open('', '', 'width=900,height=600');
        let html = `<html><head><title>${fileName}</title><style>table{width:100%; border-collapse:collapse;} th,td{border:1px solid #000; padding:5px;}</style></head><body>`;
        html += `<h2>Dr. Nimmi Das Lab - ${fileName}</h2><table><thead><tr>`; selectedCols.forEach(c => html += `<th>${c}</th>`); html += `</tr></thead><tbody>`;
        exportData.forEach(row => { html += `<tr>`; selectedCols.forEach(c => html += `<td>${row[c] || ''}</td>`); html += `</tr>`; });
        html += `</tbody></table></body></html>`; win.document.write(html); win.document.close(); win.print();
    }
}

document.getElementById('searchInput').addEventListener('keyup', function() {
    const f = this.value.toLowerCase();
    const rows = document.getElementById('tableBody').getElementsByTagName('tr');
    for (let i=0; i<rows.length; i++) rows[i].style.display = rows[i].innerText.toLowerCase().includes(f) ? "" : "none";
});
