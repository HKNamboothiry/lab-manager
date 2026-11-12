const API_URL = "https://script.google.com/macros/s/AKfycbwet17KJDzMQl0FlMOaqB8M0otVWCckd9DEnq4vlnvmOHRix1HBNaYpaVRtxYM6r2Y/exec";
    
let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let vendorDB = [];
let latestInheritedBudget = 0;
let currentExportType = "";

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
        sel.value = curr;
        handleListChange();
    } else if(activeLists.length > 0) { 
        sel.value = activeLists[0].name; 
        handleListChange(); 
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
    
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '<tr><td colspan="13" class="text-center">Loading...</td></tr>';
    
    const listMeta = activeLists.find(l => l.name === val);
    document.getElementById('budgetInHand').value = listMeta.budget;

    try {
        currentListData = await apiPost({action: "getListData", listName: val});
        currentListData.forEach(r => { r._isEditing = false; });
        renderTable();
    } catch (e) { tbody.innerHTML = '<tr><td colspan="13" class="text-danger text-center">Load failed</td></tr>'; }
}

function renderTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = "";
    let total = 0;
    
    currentListData.forEach((row, i) => {
        const mQty = productDB[row['Product Code']] ? productDB[row['Product Code']].minQty : (row['Min Qty'] || 1);
        
        if(!row._isEditing) {
            const qty = parseFloat(row['Qty']) || 0;
            const price = parseFloat(row['Price']) || parseFloat(row['Company Price']) || 0;
            total += (qty * price);
            
            tbody.innerHTML += `<tr>
                <td class="sticky-col-0">${i + 1}</td>
                <td class="sticky-col-1 text-center">
                    <button class="btn btn-sm btn-outline-primary py-0 px-1" onclick="editRow(${i})" title="Edit"><i class="bi bi-pencil-square"></i></button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteRow(${i})" title="Delete"><i class="bi bi-trash"></i></button>
                </td>
                <td class="sticky-col-2 fw-bold">${row['Product Code'] || ''}</td>
                <td class="name-col text-wrap">${row['Product Name'] || ''}</td>
                <td>${row['Category'] || ''}</td>
                <td>${row['Company'] || ''}</td>
                <td class="text-wrap">${row['Company Specs'] || ''}</td>
                <td class="text-center">${mQty}</td>
                <td>${row['Qty'] || ''}</td>
                <td>${row['Unit'] || ''}</td>
                <td>${row['Company Price'] || ''}</td>
                <td class="fw-bold text-success">
                    <input type="number" class="form-control form-control-sm number-box" value="${row['Price'] || ''}" onchange="updateRowData(${i}, 'Price', this.value)">
                </td>
                <td>
                    <input type="text" list="vendorList" class="form-control form-control-sm" value="${row['Vendor'] || ''}" onchange="updateRowData(${i}, 'Vendor', this.value)">
                </td>
            </tr>`;
        } else {
            const actMin = row._minQty || mQty;
            tbody.innerHTML += `<tr id="editRow_${i}" class="table-warning">
                <td class="sticky-col-0">${i + 1}</td>
                <td class="sticky-col-1 text-center">
                    <button class="btn btn-sm btn-success py-0 px-1" onclick="saveRow(${i})" title="Save"><i class="bi bi-check-lg"></i></button>
                    <button class="btn btn-sm btn-danger py-0 px-1 ms-1" onclick="cancelRow(${i})" title="Cancel"><i class="bi bi-x-lg"></i></button>
                </td>
                <td class="sticky-col-2"><input type="text" class="form-control form-control-sm pCode fw-bold" value="${row['Product Code'] || ''}" list="codeList" onkeydown="handleEnter(event, this, ${i})" placeholder="Code"></td>
                <td class="name-col"><textarea class="form-control form-control-sm pName" rows="2" list="nameList" onkeydown="handleEnter(event, this, ${i})">${row['Product Name'] || ''}</textarea></td>
                <td><input type="text" class="form-control form-control-sm pCategory" value="${row['Category'] || ''}" list="categoryList"></td>
                <td><input type="text" class="form-control form-control-sm pCompany" value="${row['Company'] || ''}" list="companyList"></td>
                <td><textarea class="form-control form-control-sm pSpecs" rows="2">${row['Company Specs'] || ''}</textarea></td>
                <td><input type="number" class="form-control form-control-sm pMinQty number-box" value="${actMin}" ${row._lockUnit ? 'disabled' : ''}></td>
                <td><input type="number" class="form-control form-control-sm pQty number-box" value="${row['Qty'] || ''}" min="${actMin}"></td>
                <td>
                    <select class="form-select form-select-sm pUnit number-box" onchange="checkNewUnit(this)" ${row._lockUnit ? 'disabled' : ''}>
                        <option value="${row['Unit'] || 'Piece'}" selected>${row['Unit'] || 'Piece'}</option>
                        <option value="Box">Box</option><option value="Packet">Packet</option><option value="_NEW_">+ Add</option>
                    </select>
                </td>
                <td><input type="number" step="0.01" class="form-control form-control-sm pCompPrice number-box" value="${row['Company Price'] || ''}"></td>
                <td><input type="number" step="0.01" class="form-control form-control-sm pPrice number-box" value="${row['Price'] || ''}"></td>
                <td><input type="text" class="form-control form-control-sm pVendor" value="${row['Vendor'] || ''}" list="vendorList"></td>
            </tr>`;
        }
    });
    
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function updateRowData(index, field, value) {
    currentListData[index][field] = value;
    let total = 0;
    currentListData.forEach(r => {
        const qty = parseFloat(r['Qty']) || 0;
        const price = parseFloat(r['Price']) || parseFloat(r['Company Price']) || 0;
        total += (qty * price);
    });
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

function addNewRow() {
    currentListData.push({ _isEditing: true, _isNew: true, 'Qty': 1, '_minQty': 1 });
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
    if (e.key === 'Enter' && !e.shiftKey) { // shift+enter allows newlines in textarea
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
        tr.querySelector('.pMinQty').disabled = true; // Lock
        
        const uSel = tr.querySelector('.pUnit');
        if(![...uSel.options].some(o => o.value === match.unit)) uSel.add(new Option(match.unit, match.unit));
        uSel.value = match.unit;
        uSel.disabled = true; // Lock
        
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
    if (dup > -1) return alert("This product already exists in this list! Edit the existing one instead.");

    currentListData[i] = {
        'Product Code': code, 'Product Name': name, 'Category': tr.querySelector('.pCategory').value,
        'Company': comp, 'Company Specs': tr.querySelector('.pSpecs').value, 'Min Qty': minQty, 'Qty': qty,
        'Unit': tr.querySelector('.pUnit').value, 'Company Price': tr.querySelector('.pCompPrice').value,
        'Price': tr.querySelector('.pPrice').value, 'Vendor': tr.querySelector('.pVendor').value,
        _isEditing: false
    };

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
        await apiPost({ action: "saveTableEdits", listName: document.getElementById('listSelector').value, tableData: cleanData });
        
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

// -- Budget --
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

// -- List Setup (Rename, Delete, Collaborators) --
function manageList() {
    const lName = document.getElementById('listSelector').value;
    if(!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    
    document.getElementById('listRename').value = lName;
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    
    // Hide Delete/Rename for students unless they own it
    if (USER.role === "Admin" || USER.role === "Lab Supervisor" || meta.owner === USER.username) {
        document.getElementById('listRename').disabled = false;
    } else {
        document.getElementById('listRename').disabled = true;
    }
    
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
    
    if (USER.role !== "Admin" && USER.role !== "Lab Supervisor" && meta.owner !== USER.username) {
        return alert("You do not have permission to delete this list.");
    }
    
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
        let btn = `<span class="text-muted small">View</span>`;
        if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
            btn = `<button class="btn btn-sm btn-outline-warning py-0 px-1" onclick="openEditProduct('${code}')" title="Edit"><i class="bi bi-pencil-square"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" onclick="deleteProduct('${code}')" title="Delete"><i class="bi bi-trash"></i></button>`;
        }
        tbody.innerHTML += `<tr><td>${code}</td><td class="text-wrap" style="min-width:150px;">${p.name}</td><td>${p.category||''}</td><td>${p.company||''}</td><td class="text-wrap" style="min-width:200px;">${p.specs||''}</td><td>${p.minQty||1}</td><td>${p.unit||''}</td><td>${p.compPrice||''}</td><td class="text-center">${btn}</td></tr>`;
    }
    new bootstrap.Modal(document.getElementById('inventoryModal')).show();
}

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
    const code = document.getElementById('editOrigCode').value;
    const payload = {
        action: "updateProduct", role: USER.role, 
        product: {
            code: code, name: document.getElementById('editName').value, category: document.getElementById('editCat').value,
            company: document.getElementById('editComp').value, specs: document.getElementById('editSpecs').value,
            compPrice: document.getElementById('editPrice').value, minQty: document.getElementById('editMin').value,
            unit: document.getElementById('editUnit').value
        }
    };
    await apiPost(payload);
    bootstrap.Modal.getInstance(document.getElementById('fullEditModal')).hide();
    fetchInitData(); 
}

async function deleteProduct(code) {
    if(confirm(`Are you sure you want to delete Product Code: ${code} from the inventory?`)) {
        await apiPost({action: "deleteProduct", role: USER.role, code: code});
        fetchInitData(); 
        bootstrap.Modal.getInstance(document.getElementById('inventoryModal')).hide();
    }
}

document.getElementById('invSearch').addEventListener('keyup', function() {
    const f = this.value.toLowerCase();
    const rows = document.getElementById('invBody').getElementsByTagName('tr');
    for(let i=0; i<rows.length; i++) rows[i].style.display = rows[i].innerText.toLowerCase().includes(f) ? "" : "none";
});

// -- User Management (Admin / Supervisor Only) --
async function openUsersModal() {
    const res = await apiPost({action: "manageUsers", subAction: "get", role: USER.role});
    if(res.status === "success") {
        const tbody = document.getElementById('usersBody');
        tbody.innerHTML = "";
        res.users.forEach(u => {
            const btn = (u.username === "admin") ? "" : `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteUser('${u.username}')"><i class="bi bi-trash"></i></button>`;
            tbody.innerHTML += `<tr><td>${u.username}</td><td>${u.role}</td><td class="text-center">${btn}</td></tr>`;
        });
        new bootstrap.Modal(document.getElementById('usersModal')).show();
    }
}

document.getElementById('addUserForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const u = document.getElementById('newUName').value.trim();
    const p = document.getElementById('newUPass').value.trim();
    const r = document.getElementById('newURole').value;
    
    const res = await apiPost({action: "manageUsers", subAction: "add", role: USER.role, newUser: u, newPass: p, newRole: r});
    if(res.status === "success") {
        e.target.reset();
        openUsersModal(); // Refresh modal
    } else alert(res.message);
});

async function deleteUser(username) {
    if(confirm(`Delete user ${username}?`)) {
        await apiPost({action: "manageUsers", subAction: "delete", role: USER.role, targetUser: username});
        openUsersModal();
    }
}

// -- Export Module --
const COLUMNS = ["SL No", "Product Code", "Product Name", "Category", "Company", "Company Specs", "Qty", "Unit", "Company Price", "Price", "Vendor"];
function openExportModal(type) {
    currentExportType = type;
    document.getElementById('exportColCheckboxes').innerHTML = COLUMNS.map((c, i) => `<div class="form-check"><input class="form-check-input exp-chk" type="checkbox" value="${c}" id="chk${i}" checked><label class="form-check-label" for="chk${i}">${c}</label></div>`).join('');
    new bootstrap.Modal(document.getElementById('exportModal')).show();
}

function executeExport() {
    bootstrap.Modal.getInstance(document.getElementById('exportModal')).hide();
    const selectedCols = Array.from(document.querySelectorAll('.exp-chk:checked')).map(cb => cb.value);
    if(selectedCols.length === 0) return alert("Select at least one column.");

    const exportData = currentListData.filter(r => !r._isEditing).map((row, index) => {
        let obj = {}; selectedCols.forEach(col => { obj[col] = (col === "SL No") ? (index + 1) : row[col]; }); return obj;
    });

    const listName = document.getElementById('listSelector').value;

    if (currentExportType === 'excel') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Export"); XLSX.writeFile(wb, `${listName}.xlsx`);
    } else if (currentExportType === 'csv') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${listName}.csv`; link.click();
    } else if (currentExportType === 'pdf') {
        const doc = new jspdf.jsPDF('landscape'); doc.text(`Dr. Nimmi Das Lab - ${listName}`, 14, 15);
        doc.autoTable({ head: [selectedCols], body: exportData.map(obj => selectedCols.map(col => obj[col])), startY: 20, styles: { fontSize: 8 } });
        doc.save(`${listName}.pdf`);
    } else if (currentExportType === 'print') {
        let win = window.open('', '', 'width=900,height=600');
        let html = `<html><head><title>${listName}</title><style>table{width:100%; border-collapse:collapse;} th,td{border:1px solid #000; padding:5px;}</style></head><body>`;
        html += `<h2>Dr. Nimmi Das Lab - ${listName}</h2><table><thead><tr>`; selectedCols.forEach(c => html += `<th>${c}</th>`); html += `</tr></thead><tbody>`;
        exportData.forEach(row => { html += `<tr>`; selectedCols.forEach(c => html += `<td>${row[c] || ''}</td>`); html += `</tr>`; });
        html += `</tbody></table></body></html>`; win.document.write(html); win.document.close(); win.print();
    }
}

document.getElementById('searchInput').addEventListener('keyup', function() {
    const f = this.value.toLowerCase();
    const rows = document.getElementById('tableBody').getElementsByTagName('tr');
    for (let i=0; i<rows.length; i++) rows[i].style.display = rows[i].innerText.toLowerCase().includes(f) ? "" : "none";
});
