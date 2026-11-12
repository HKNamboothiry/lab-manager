const API_URL = "https://script.google.com/macros/s/AKfycbwet17KJDzMQl0FlMOaqB8M0otVWCckd9DEnq4vlnvmOHRix1HBNaYpaVRtxYM6r2Y/exec";
    
let USER = null;
let productDB = {};
let activeLists = [];
let currentListData = [];
let currentExportType = "";

// -- Authentication --
if (sessionStorage.getItem("user")) {
    USER = JSON.parse(sessionStorage.getItem("user"));
    showApp();
}

async function verifyLogin() {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    const btn = document.getElementById('loginBtn');
    const err = document.getElementById('loginError');
    if (!u || !p) return;

    btn.innerText = "Verifying..."; btn.disabled = true; err.style.display = 'none';

    try {
        const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "login", username: u, password: p}) });
        const data = await res.json();
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
    
    // Supervisor/Admin privileges
    if (USER.role === "Admin" || USER.role === "Lab Supervisor") {
        document.getElementById('budgetInHand').disabled = false;
        document.getElementById('btnUpdateBudget').style.display = "block";
    }
    fetchInitData();
}

// -- Data Loading --
async function fetchInitData() {
    try {
        const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "getInit", username: USER.username, role: USER.role}) });
        const data = await res.json();
        if(data.status === "success") {
            productDB = data.products;
            activeLists = data.lists;
            populateListDropdown();
            updateDatalists();
        }
    } catch (e) { alert("Failed to fetch initial data."); }
}

function populateListDropdown() {
    const sel = document.getElementById('listSelector');
    sel.innerHTML = '<option value="" disabled selected>Select a List...</option>';
    activeLists.forEach(l => { sel.innerHTML += `<option value="${l.name}">${l.name}</option>`; });
    sel.innerHTML += `<option value="_NEW_" class="text-primary fw-bold">+ Create New List</option>`;
    if(activeLists.length > 0) { sel.value = activeLists[0].name; handleListChange(); }
}

async function handleListChange() {
    const val = document.getElementById('listSelector').value;
    if (val === "_NEW_") {
        const newName = prompt("Enter new list name (e.g. November Reagents):");
        if(newName) {
            await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "manageList", subAction: "create", listName: newName, username: USER.username}) });
            fetchInitData(); // Reload everything
        } else {
            document.getElementById('listSelector').value = activeLists[0] ? activeLists[0].name : "";
        }
        return;
    }
    
    // Load table data
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '<tr><td colspan="11" class="text-center">Loading...</td></tr>';
    
    const listMeta = activeLists.find(l => l.name === val);
    document.getElementById('budgetInHand').value = listMeta.budget;

    try {
        const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "getListData", listName: val}) });
        currentListData = await res.json();
        renderTable();
    } catch (e) { tbody.innerHTML = '<tr><td colspan="11" class="text-danger text-center">Load failed</td></tr>'; }
}

function renderTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = "";
    let total = 0;
    currentListData.forEach((row, i) => {
        const qty = parseFloat(row['Qty']) || 0;
        const price = parseFloat(row['Price']) || parseFloat(row['Company Price']) || 0;
        total += (qty * price);
        tbody.innerHTML += `<tr>
            <td class="sticky-col-0">${i + 1}</td>
            <td class="sticky-col-1 fw-bold">${row['Product Code'] || ''}</td>
            <td class="sticky-col-2">${row['Product Name'] || ''}</td>
            <td>${row['Category'] || ''}</td><td>${row['Company'] || ''}</td>
            <td class="text-wrap">${row['Company Specs'] || ''}</td>
            <td>${row['Qty'] || ''}</td><td>${row['Unit'] || ''}</td>
            <td>${row['Company Price'] || ''}</td><td class="fw-bold">${row['Price'] || ''}</td>
            <td>${row['Vendor'] || ''}</td>
        </tr>`;
    });
    document.getElementById('totalBudget').innerText = '₹' + total.toFixed(2);
    calcBalance();
}

// -- Form Logic & Restrictions --
function updateDatalists() {
    const catFilter = document.getElementById('pCategory').value.toLowerCase();
    const c = new Set(), n = new Set(), comp = new Set(), code = new Set();
    for (const [cd, p] of Object.entries(productDB)) {
        if (p.category) c.add(p.category);
        if (!catFilter || (p.category && p.category.toLowerCase() === catFilter)) {
            code.add(cd); if(p.name) n.add(p.name); if(p.company) comp.add(p.company);
        }
    }
    document.getElementById('categoryList').innerHTML = [...c].map(x=>`<option value="${x}">`).join('');
    document.getElementById('codeList').innerHTML = [...code].map(x=>`<option value="${x}">`).join('');
    document.getElementById('nameList').innerHTML = [...n].map(x=>`<option value="${x}">`).join('');
    document.getElementById('companyList').innerHTML = [...comp].map(x=>`<option value="${x}">`).join('');
}

// Bi-directional autofill
document.getElementById('pCategory').addEventListener('input', updateDatalists);
document.getElementById('pCode').addEventListener('input', fillByData);
document.getElementById('pName').addEventListener('input', fillByData);

function fillByData() {
    const cVal = document.getElementById('pCode').value;
    const nVal = document.getElementById('pName').value.toLowerCase();
    let match = null, codeKey = null;

    if (productDB[cVal]) { match = productDB[cVal]; codeKey = cVal; }
    else {
        for (const [k, v] of Object.entries(productDB)) {
            if (v.name.toLowerCase() === nVal) { match = v; codeKey = k; break; }
        }
    }

    if (match) {
        document.getElementById('pCode').value = codeKey;
        document.getElementById('pCategory').value = match.category || "";
        document.getElementById('pName').value = match.name || "";
        document.getElementById('pCompany').value = match.company || "";
        document.getElementById('pSpecs').value = match.specs || "";
        document.getElementById('pCompPrice').value = match.compPrice || "";
        document.getElementById('pMinQty').value = match.minQty || 1;
        
        // Lock Unit and Minimum Qty logic
        const uSel = document.getElementById('pUnit');
        if(![...uSel.options].some(o => o.value === match.unit)) {
            uSel.add(new Option(match.unit, match.unit));
        }
        uSel.value = match.unit;
        uSel.disabled = true; // Lock it
        document.getElementById('pQty').min = match.minQty || 1;
    } else {
        document.getElementById('pUnit').disabled = false;
        document.getElementById('pQty').min = 1;
    }
}

function checkNewUnit(sel) {
    if(sel.value === "_NEW_") {
        const u = prompt("Enter new unit type:");
        if(u) { sel.add(new Option(u, u), sel.options[sel.length-1]); sel.value = u; }
        else { sel.value = "Piece"; }
    }
}

document.getElementById('purchaseForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const code = document.getElementById('pCode').value;
    const comp = document.getElementById('pCompany').value;
    const qty = parseFloat(document.getElementById('pQty').value);
    const minQty = parseFloat(document.getElementById('pMinQty').value);

    // Validations
    if (qty < minQty) return alert(`Quantity cannot be less than Minimum Qty (${minQty})`);
    
    // Duplicate check in current list
    if (currentListData.some(r => r['Product Code'] === code && r['Company'] === comp)) {
        alert("A product with this Code and Company already exists in the current list.");
        return;
    }

    const payload = {
        action: "saveItem",
        listName: document.getElementById('listSelector').value,
        slNo: currentListData.length + 1, code: code, name: document.getElementById('pName').value,
        category: document.getElementById('pCategory').value, company: comp, specs: document.getElementById('pSpecs').value,
        qty: qty, minQty: minQty, unit: document.getElementById('pUnit').value, compPrice: document.getElementById('pCompPrice').value,
        price: "", vendor: ""
    };

    const btn = e.target.querySelector('button'); btn.innerText = "..."; btn.disabled = true;
    try {
        await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) });
        e.target.reset(); document.getElementById('pUnit').disabled = false;
        handleListChange(); // reload table
    } catch(err) { alert("Save failed"); } finally { btn.innerText = "Add to List"; btn.disabled = false; }
});

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
    await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "manageList", subAction: "updateMeta", listName: lName, budget: b}) });
    alert("Budget saved for this list.");
}

// -- List Setup (Sharing) --
function manageList() {
    const lName = document.getElementById('listSelector').value;
    if(!lName) return;
    const meta = activeLists.find(l => l.name === lName);
    document.getElementById('listCollabs').value = meta.collabs.join(',');
    new bootstrap.Modal(document.getElementById('listModal')).show();
}

async function saveListSettings() {
    const lName = document.getElementById('listSelector').value;
    const cols = document.getElementById('listCollabs').value;
    await fetch(API_URL, { method: 'POST', body: JSON.stringify({action: "manageList", subAction: "updateMeta", listName: lName, collabs: cols}) });
    bootstrap.Modal.getInstance(document.getElementById('listModal')).hide();
    fetchInitData();
}

// -- Inventory Editing (Admin/Supervisor Only) --
function openInventoryModal() {
    const tbody = document.getElementById('invBody');
    tbody.innerHTML = '';
    for(const [code, p] of Object.entries(productDB)) {
        const btn = (USER.role === "Admin" || USER.role === "Lab Supervisor") ? `<button class="btn btn-sm btn-warning" onclick="editProduct('${code}')">Edit</button>` : `<span class="text-muted small">View Only</span>`;
        tbody.innerHTML += `<tr><td>${code}</td><td>${p.name}</td><td>${p.category||''}</td><td>${p.company||''}</td><td>${p.specs||''}</td><td>${p.minQty||1}</td><td>${p.unit||''}</td><td>${p.compPrice||''}</td><td>${btn}</td></tr>`;
    }
    new bootstrap.Modal(document.getElementById('inventoryModal')).show();
}

function editProduct(code) {
    const p = productDB[code];
    const newName = prompt("Edit Name:", p.name);
    if(!newName) return;
    const newCat = prompt("Edit Category:", p.category);
    const newMin = prompt("Edit Min Qty:", p.minQty);
    
    productDB[code].name = newName;
    productDB[code].category = newCat;
    productDB[code].minQty = newMin;
    
    fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: "updateProduct", role: USER.role, product: {code: code, name: newName, category: newCat, company: p.company, specs: p.specs, compPrice: p.compPrice, minQty: newMin, unit: p.unit} }) });
    openInventoryModal(); // refresh
}

// -- Export Module --
const COLUMNS = ["SL No", "Product Code", "Product Name", "Category", "Company", "Company Specs", "Qty", "Unit", "Company Price", "Price", "Vendor"];

function openExportModal(type) {
    currentExportType = type;
    const div = document.getElementById('exportColCheckboxes');
    div.innerHTML = COLUMNS.map((c, i) => `<div class="form-check"><input class="form-check-input exp-chk" type="checkbox" value="${c}" id="chk${i}" checked><label class="form-check-label" for="chk${i}">${c}</label></div>`).join('');
    new bootstrap.Modal(document.getElementById('exportModal')).show();
}

function executeExport() {
    bootstrap.Modal.getInstance(document.getElementById('exportModal')).hide();
    const selectedCols = Array.from(document.querySelectorAll('.exp-chk:checked')).map(cb => cb.value);
    if(selectedCols.length === 0) return alert("Select at least one column.");

    // Filter data
    const exportData = currentListData.map(row => {
        let obj = {};
        selectedCols.forEach(col => obj[col] = row[col]);
        return obj;
    });

    const listName = document.getElementById('listSelector').value;

    if (currentExportType === 'excel') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Export");
        XLSX.writeFile(wb, `${listName}.xlsx`);
    } 
    else if (currentExportType === 'csv') {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const csv = XLSX.utils.sheet_to_csv(ws);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${listName}.csv`;
        link.click();
    } 
    else if (currentExportType === 'pdf') {
        const doc = new jspdf.jsPDF('landscape');
        doc.text(`Dr. Nimmi Das Lab - ${listName}`, 14, 15);
        const rows = exportData.map(obj => selectedCols.map(col => obj[col]));
        doc.autoTable({ head: [selectedCols], body: rows, startY: 20, styles: { fontSize: 8 } });
        doc.save(`${listName}.pdf`);
    } 
    else if (currentExportType === 'print') {
        let win = window.open('', '', 'width=900,height=600');
        let html = `<html><head><title>${listName}</title><style>table{width:100%; border-collapse:collapse;} th,td{border:1px solid #000; padding:5px;}</style></head><body>`;
        html += `<h2>Dr. Nimmi Das Lab - ${listName}</h2><table><thead><tr>`;
        selectedCols.forEach(c => html += `<th>${c}</th>`);
        html += `</tr></thead><tbody>`;
        exportData.forEach(row => { html += `<tr>`; selectedCols.forEach(c => html += `<td>${row[c] || ''}</td>`); html += `</tr>`; });
        html += `</tbody></table></body></html>`;
        win.document.write(html);
        win.document.close();
        win.print();
    }
}

// Main Table Filter
document.getElementById('searchInput').addEventListener('keyup', function() {
    const f = this.value.toLowerCase();
    const rows = document.getElementById('tableBody').getElementsByTagName('tr');
    for (let i=0; i<rows.length; i++) {
        rows[i].style.display = rows[i].innerText.toLowerCase().includes(f) ? "" : "none";
    }
});
