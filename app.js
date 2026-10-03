// Suivi des locations : locations "Seul" et "Avec Ali", frais et remboursements.
// Les données sont enregistrées dans le navigateur (localStorage).

const STORAGE_KEY = 'locations-data-v1';
let { vehicles, rentals } = load();
let filter = 'all';
let editingVehicleId = null;
let editingRentalId = null;   // location en cours de modification
let feeContext = null;        // { rentalId, feeId|null }

const $ = (sel) => document.querySelector(sel);
const money = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Accepte l'ancien format (simple liste de locations) et le nouveau { vehicles, rentals }.
function normalize(raw) {
  const data = Array.isArray(raw) ? { vehicles: [], rentals: raw } : (raw || {});
  const vs = Array.isArray(data.vehicles) ? data.vehicles : [];
  const rs = Array.isArray(data.rentals) ? data.rentals : [];
  vs.forEach((v) => {
    if (!Array.isArray(v.fees)) v.fees = [];
    if (!Array.isArray(v.fines)) v.fines = [];
  });
  rs.forEach((r) => {
    if (!Array.isArray(r.payments)) r.payments = [];
    if (r.vehicleId && vs.some((v) => v.id === r.vehicleId)) return;
    // Ancienne location avec un nom de véhicule libre : on crée le véhicule correspondant.
    let v = vs.find((x) => x.name === r.vehicle && x.type === r.type);
    if (!v) {
      v = { id: uid(), name: r.vehicle || 'Véhicule', plate: '', type: r.type, share: r.share ?? 50, fees: [], fines: [] };
      vs.push(v);
    }
    r.vehicleId = v.id;
  });
  return { vehicles: vs, rentals: rs };
}

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { return normalize(null); }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ vehicles, rentals }));
  render();
}

const vehicleById = (id) => vehicles.find((v) => v.id === id);
const vehicleName = (r) => {
  const v = vehicleById(r.vehicleId);
  if (!v) return r.vehicle || 'Véhicule supprimé';
  return v.plate ? `${v.name} (${v.plate})` : v.name;
};

// ---------- Calculs ----------

// Qui peut payer un frais selon le type de location.
function payersFor(type) {
  return type === 'ali'
    ? [['moi', 'Moi'], ['ali', 'Ali'], ['client', 'Le client']]
    : [['moi', 'Moi'], ['client', 'Le client']];
}
const payerLabel = (p) => ({ moi: 'Moi', ali: 'Ali', client: 'Le client' }[p]);

// Renouvellement automatique : une location continue de facturer une nouvelle période
// (jour / semaine / mois) à chaque échéance, jusqu'à ce qu'on la termine (stoppedAt).
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toIso = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
const todayStr = () => toIso(new Date());

function periodsCount(r) {
  if (!r.period) return 1; // anciennes locations : un seul paiement
  const start = parseDay(r.start);
  const end = parseDay(r.stoppedAt || todayStr());
  if (end < start) return 0;
  if (r.period === 'mois') {
    let m = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
    if (end.getDate() < start.getDate()) m--;
    return m + 1;
  }
  const days = Math.round((end - start) / 86400000);
  return Math.floor(days / (r.period === 'semaine' ? 7 : 1)) + 1;
}
const revenue = (r) => (r.price || 0) * (r.period ? periodsCount(r) : 1);

// Assurance mensuelle d'un véhicule : comptée automatiquement mois par mois, comme un loyer.
function insuranceTotal(v) {
  if (!v.insurance || !v.insurance.amount) return 0;
  return v.insurance.amount * periodsCount({ period: 'mois', start: v.insurance.start });
}

// Début de la période n° k (0 = la première, qui commence à la date de début).
function periodStart(r, k) {
  const d = parseDay(r.start);
  if (!r.period || r.period === 'jour') d.setDate(d.getDate() + k);
  else if (r.period === 'semaine') d.setDate(d.getDate() + 7 * k);
  else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + k);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last)); // 31 janvier + 1 mois = 28/29 février
  }
  return d;
}

// Le client paie à la FIN de chaque période : la période n° k est due à la fin de celle-ci
// (ou à la date d'arrêt si la location est terminée en cours de période).
function periodDueDate(r, k) {
  if (!r.period) return parseDay(r.start);
  const end = periodStart(r, k + 1);
  if (r.stoppedAt) {
    const stop = parseDay(r.stoppedAt);
    if (stop < end) return stop;
  }
  return end;
}

// Paiements : on regarde la plus ancienne période non réglée.
function paymentInfo(r) {
  const paid = (r.payments || []).reduce((s, p) => s + p.amount, 0);
  const due = revenue(r);
  const remaining = due - paid;
  const price = r.price || 0;
  const today = parseDay(todayStr());
  let lateDays = 0, dueToday = false, nextDue = null, nextAmount = 0, overdue = 0;
  if (price > 0 && remaining > 0.005) {
    const count = r.period ? periodsCount(r) : 1;
    let ended = 0; // périodes déjà échues
    while (ended < count && periodDueDate(r, ended) <= today) ended++;
    overdue = Math.max(0, ended * price - paid);
    const idx = Math.floor((paid + 0.005) / price); // 1re période non entièrement payée
    if (idx < count) {
      const dd = periodDueDate(r, idx);
      const diff = Math.round((today - dd) / 86400000);
      if (diff > 0) lateDays = diff; else if (diff === 0) dueToday = true;
      nextDue = dd;
      nextAmount = (idx + 1) * price - paid;
    }
  }
  return { paid, due, remaining, overdue, lateDays, dueToday, nextDue, nextAmount };
}

function compute(r) {
  const paid = { moi: 0, ali: 0, client: 0 };
  r.fees.forEach((f) => { paid[f.payer] += f.amount; });
  const insurance = insuranceTotal(r);
  if (insurance) paid[r.insurance.payer] += insurance;
  const total = paid.moi + paid.ali + paid.client;
  const s = r.type === 'ali' ? r.share / 100 : 1;
  const myCost = total * s;
  const aliCost = total - myCost;
  // Frais avancés par le client : la société doit les lui rembourser.
  const refundClient = paid.client;
  // Entre associés : chacun doit supporter sa part des frais payés par les associés.
  const partnerPaid = paid.moi + paid.ali;
  let aliOwesMe = 0, iOweAli = 0;
  if (r.type === 'ali') {
    const diff = paid.moi - partnerPaid * s; // >0 : Ali me doit
    if (diff > 0.005) aliOwesMe = diff;
    else if (diff < -0.005) iOweAli = -diff;
  }
  return {
    paid, total, insurance, myCost, aliCost, refundClient,
    aliOwesMe, iOweAli,
    myProfit: (revenue(r) * s) - myCost,
    aliProfit: r.type === 'ali' ? (revenue(r) * (1 - s)) - aliCost : 0,
  };
}

// ---------- Affichage ----------

function render() {
  const list = rentals.filter((r) => filter === 'all' || r.type === filter)
    .sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const vlist = vehicles.filter((v) => filter === 'all' || v.type === filter);
  renderSummary(list, vlist);
  $('#vehicles').innerHTML = `<h2>Véhicules</h2>` + (vlist.length
    ? vlist.map(vehicleCardHtml).join('')
    : '<p class="empty">Aucun véhicule. Cliquez sur « Véhicules » pour en ajouter.</p>');
  const box = $('#rentals');
  if (!list.length) {
    box.innerHTML = '<p class="empty">Aucune location. Cliquez sur « Nouvelle location » pour commencer.</p>';
    return;
  }
  box.innerHTML = list.map(cardHtml).join('');
}

function renderSummary(list, vlist) {
  let price = 0, fees = 0, refundClient = 0, aliOwesMe = 0, iOweAli = 0, profit = 0, cashed = 0, unpaid = 0;
  let finesPending = 0, finesAmount = 0;
  // Les frais des véhicules (hors location) comptent aussi dans les totaux.
  [...list, ...vlist].forEach((r) => {
    const c = compute(r);
    const p = paymentInfo(r);
    cashed += p.paid; unpaid += p.overdue;
    price += revenue(r); fees += c.total; refundClient += c.refundClient;
    aliOwesMe += c.aliOwesMe; iOweAli += c.iOweAli; profit += c.myProfit;
    (r.fines || []).filter((f) => f.status !== 'done').forEach((f) => { finesPending++; finesAmount += f.amount; });
  });
  const stat = (k, v, alert) => `<div class="stat${alert ? ' alert' : ''}"><div class="k">${k}</div><div class="v">${money(v)}</div></div>`;
  const finesStat = `<div class="stat${finesPending ? ' alert' : ''}"><div class="k">Amendes à traiter</div><div class="v">${finesPending}</div>${finesPending ? `<div class="muted">${money(finesAmount)}</div>` : ''}</div>`;
  let html = stat('Chiffre d\'affaires', price) + stat('Encaissé', cashed) + stat('Impayés', unpaid, unpaid > 0)
    + finesStat + stat('Total des frais', fees) + stat('Mon bénéfice', profit)
    + stat('À rembourser aux clients', refundClient, refundClient > 0);
  if (filter !== 'solo') {
    html += stat('Ali me doit', aliOwesMe) + stat('Je dois à Ali', iOweAli, iOweAli > 0);
  }
  $('#summary').innerHTML = html;
}

// Tableau des frais d'une location ou d'un véhicule ; attr = data-r="…" ou data-v="…".
function feesTableHtml(o, attr) {
  const rows = o.fees.length
    ? o.fees.map((f) => `
        <tr>
          <td>${fmtDate(f.date)}</td>
          <td>${esc(f.label)}</td>
          <td>${payerLabel(f.payer)}</td>
          <td class="num">${money(f.amount)}</td>
          <td class="num">
            <button class="small" data-act="edit-fee" ${attr} data-f="${f.id}">Modifier</button>
            <button class="small danger" data-act="del-fee" ${attr} data-f="${f.id}">✕</button>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">Aucun frais.</td></tr>';
  return `<div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Frais</th><th>Payé par</th><th class="num">Montant</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

// Carte d'un véhicule : ses frais propres, indépendants des locations.
// Retrouve qui louait un véhicule à une date donnée, pour rattacher une amende au bon client.
function renterAtDate(vehicleId, dateStr) {
  if (!dateStr) return null;
  const d = parseDay(dateStr);
  const matches = rentals.filter((r) => r.vehicleId === vehicleId).filter((r) => {
    const start = parseDay(r.start);
    if (d < start) return false;
    if (r.period) return !r.stoppedAt || d <= parseDay(r.stoppedAt);
    return !r.end || d <= parseDay(r.end); // ancien format avec date de fin
  });
  if (!matches.length) return null;
  matches.sort((a, b) => b.start.localeCompare(a.start));
  return matches[0];
}

function finesHtml(v) {
  const fines = (v.fines || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const rows = fines.length ? fines.map((f) => {
    const renter = renterAtDate(v.id, f.date);
    const who = renter ? `${esc(renter.client)}${renter.phone ? ' · ' + esc(renter.phone) : ''}` : '<span class="muted">Aucune location trouvée</span>';
    const badge = f.status === 'done' ? '<span class="pay-badge pay-ok">Traitée</span>' : '<span class="pay-badge pay-late">À traiter</span>';
    return `<tr>
          <td>${fmtDate(f.date)}</td>
          <td>${who}</td>
          <td>${esc(f.reference || '')}</td>
          <td class="num">${money(f.amount)}</td>
          <td>${badge}</td>
          <td class="num">
            <button class="small" data-act="toggle-fine" data-v="${v.id}" data-fi="${f.id}">${f.status === 'done' ? 'Rouvrir' : 'Marquer traitée'}</button>
            <button class="small" data-act="edit-fine" data-v="${v.id}" data-fi="${f.id}">Modifier</button>
            <button class="small danger" data-act="del-fine" data-v="${v.id}" data-fi="${f.id}">✕</button>
          </td>
        </tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">Aucune amende enregistrée.</td></tr>';
  return `<h4 class="pay-title">Amendes</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Locataire à cette date</th><th>Référence</th><th class="num">Montant</th><th>Statut</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <button class="primary small" data-act="add-fine" data-v="${v.id}">+ Ajouter une amende</button>`;
}

// Suivi du remboursement du véhicule : revenus des locations moins frais et assurance, comparés au prix d'achat.
function recoveryInfo(v) {
  const price = v.purchasePrice || 0;
  const income = rentals.filter((r) => r.vehicleId === v.id).reduce((s, r) => s + revenue(r), 0);
  const costs = compute(v).total;
  const net = income - costs;
  const remaining = Math.max(0, price - net);
  const percent = price > 0 ? Math.min(100, Math.max(0, (net / price) * 100)) : 0;
  return { price, income, costs, net, remaining, percent, recovered: price > 0 && net >= price - 0.005 };
}

function recoveryHtml(v) {
  if (!v.purchasePrice) return '';
  const r = recoveryInfo(v);
  if (r.recovered) {
    return `<div class="pay-title"><strong>Véhicule remboursé</strong> · ${money(r.price)} d'achat couverts (net généré : ${money(r.net)})</div>`;
  }
  return `<h4 class="pay-title">Remboursement du véhicule</h4>
      <div>Prix d'achat : ${money(r.price)} · Net généré jusqu'ici : ${money(r.net)} (${r.percent.toFixed(0)} %) · Reste à récupérer : <span class="due">${money(r.remaining)}</span></div>
      <div class="recovery-bar"><div style="width:${r.percent}%"></div></div>`;
}

function insuranceText(v) {
  if (!v.insurance || !v.insurance.amount) return '';
  const n = periodsCount({ period: 'mois', start: v.insurance.start });
  const total = insuranceTotal(v);
  return `<div>Assurance : ${money(v.insurance.amount)}/mois payée par ${payerLabel(v.insurance.payer)} depuis le ${fmtDate(v.insurance.start)}`
    + ` · ${n} mois × ${money(v.insurance.amount)} = ${money(total)}</div>`;
}

function vehicleCardHtml(v) {
  const c = compute(v);
  const isAli = v.type === 'ali';
  const rented = rentals.filter((r) => r.vehicleId === v.id);
  const hasCost = v.fees.length > 0 || c.insurance > 0;
  const pending = (v.fines || []).filter((f) => f.status !== 'done');
  let balance = insuranceText(v);
  if (c.refundClient > 0) balance += `<div>Frais avancés par le client : <span class="due">${money(c.refundClient)} à lui rembourser</span></div>`;
  if (isAli) {
    balance += `<div>Ma part (${v.share} %) : ${money(c.myCost)} · Part d'Ali (${100 - v.share} %) : ${money(c.aliCost)}</div>`;
    if (c.aliOwesMe) balance += `<div>Ali me doit <span class="ok">${money(c.aliOwesMe)}</span></div>`;
    else if (c.iOweAli) balance += `<div>Je dois à Ali <span class="due">${money(c.iOweAli)}</span></div>`;
    else if (hasCost) balance += '<div>Comptes équilibrés avec Ali.</div>';
  } else if (hasCost) {
    balance += `<div>Frais à ma charge : ${money(c.myCost)}</div>`;
  }
  if (!hasCost) balance = '<div class="muted">Aucun frais sur ce véhicule.</div>';
  return `
    <article class="card ${v.type}">
      <div class="card-head">
        <div>
          <h3>${esc(v.name)}${v.plate ? ' · ' + esc(v.plate) : ''}<span class="badge ${v.type}">${isAli ? 'Avec Ali' : 'Seul'}</span></h3>
          <div class="muted">${rented.length} location${rented.length > 1 ? 's' : ''}</div>
          ${pending.length ? `<span class="pay-badge pay-late">${pending.length} amende${pending.length > 1 ? 's' : ''} à traiter</span>` : ''}
        </div>
        <div><strong>${money(c.total)}</strong> <span class="muted">de frais</span></div>
      </div>
      ${recoveryHtml(v)}
      <h4 class="pay-title">Frais</h4>
      ${feesTableHtml(v, `data-v="${v.id}"`)}
      <div class="balance">${balance}</div>
      ${finesHtml(v)}
      <div class="card-actions">
        <button class="primary small" data-act="add-fee" data-v="${v.id}">+ Ajouter un frais</button>
      </div>
    </article>`;
}

const PERIODS = { jour: 'Location à la journée', semaine: 'Location à la semaine', mois: 'Location au mois' };
function rentalPeriodText(r) {
  // Anciennes locations : elles avaient une date de fin au lieu d'un type.
  if (!r.period) return `du ${fmtDate(r.start)}${r.end ? ' au ' + fmtDate(r.end) : ''}`;
  const status = r.stoppedAt ? `terminée le ${fmtDate(r.stoppedAt)}` : 'renouvelée automatiquement';
  return `${PERIODS[r.period]} · depuis le ${fmtDate(r.start)} · ${status}`;
}

// Détail du montant : "3 semaines × 250 €".
function rentalAmountText(r) {
  if (!r.period) return '';
  const n = periodsCount(r);
  const unit = { jour: 'jour', semaine: 'semaine', mois: 'mois' }[r.period];
  return `${n} ${unit}${n > 1 && unit !== 'mois' ? 's' : ''} × ${money(r.price)}`;
}

// Statut de paiement (badge) et tableau des paiements reçus d'une location.
function payStatusHtml(r) {
  const p = paymentInfo(r);
  if (p.due <= 0) return '';
  if (p.remaining <= 0.005) return '<span class="pay-badge pay-ok">Payé' + (p.remaining < -0.005 ? ` · ${money(-p.remaining)} d'avance` : '') + '</span>';
  if (p.lateDays) return `<span class="pay-badge pay-late">En retard de ${p.lateDays} jour${p.lateDays > 1 ? 's' : ''} · ${money(p.overdue)} dus</span>`;
  if (p.dueToday) return `<span class="pay-badge pay-due">À payer aujourd'hui · ${money(p.nextAmount)}</span>`;
  return `<span class="pay-badge pay-due">Prochain paiement le ${fmtDate(toIso(p.nextDue))} · ${money(p.nextAmount)}</span>`;
}

function paymentsHtml(r) {
  const pays = (r.payments || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const rows = pays.length ? pays.map((p) => `
        <tr>
          <td>${fmtDate(p.date)}</td>
          <td>${esc(p.note || '')}</td>
          <td class="num">${money(p.amount)}</td>
          <td class="num">
            <button class="small" data-act="edit-pay" data-r="${r.id}" data-p="${p.id}">Modifier</button>
            <button class="small danger" data-act="del-pay" data-r="${r.id}" data-p="${p.id}">✕</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">Aucun paiement reçu.</td></tr>';
  return `<h4 class="pay-title">Paiements reçus</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Note</th><th class="num">Montant</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <button class="primary small" data-act="add-pay" data-r="${r.id}">+ Enregistrer un paiement</button>`;
}

function cardHtml(r) {
  const c = compute(r);
  const isAli = r.type === 'ali';

  let balance = '';
  if (c.refundClient > 0) balance += `<div>Frais avancés par le client : <span class="due">${money(c.refundClient)} à lui rembourser</span></div>`;
  if (isAli) {
    balance += `<div>Ma part (${r.share} %) : ${money(c.myCost)} de frais · Part d'Ali (${100 - r.share} %) : ${money(c.aliCost)}</div>`;
    if (c.aliOwesMe) balance += `<div>Ali me doit <span class="ok">${money(c.aliOwesMe)}</span></div>`;
    else if (c.iOweAli) balance += `<div>Je dois à Ali <span class="due">${money(c.iOweAli)}</span></div>`;
    else balance += '<div>Comptes équilibrés avec Ali.</div>';
    balance += `<div>Bénéfice : moi ${money(c.myProfit)} · Ali ${money(c.aliProfit)}</div>`;
  } else {
    balance += `<div>Frais à ma charge : ${money(c.myCost)} · Bénéfice : ${money(c.myProfit)}</div>`;
  }
  if (!r.fees.length) balance = '<div class="muted">Rien à rembourser pour le moment.</div>';

  return `
    <article class="card ${r.type}">
      <div class="card-head">
        <div>
          <h3>${esc(vehicleName(r))}<span class="badge ${r.type}">${isAli ? 'Avec Ali' : 'Seul'}</span></h3>
          <div class="muted">${esc(r.client)}${r.phone ? ` · <a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : ''} · ${rentalPeriodText(r)}</div>
        </div>
        <div style="text-align:right"><strong>${money(revenue(r))}</strong><div class="muted">${rentalAmountText(r)}</div>${payStatusHtml(r)}</div>
      </div>
      ${paymentsHtml(r)}
      <h4 class="pay-title">Frais</h4>
      ${feesTableHtml(r, `data-r="${r.id}"`)}
      <div class="balance">${balance}</div>
      <div class="card-actions">
        <button class="primary small" data-act="add-fee" data-r="${r.id}">+ Ajouter un frais</button>
        ${r.period ? (r.stoppedAt
          ? `<button class="small" data-act="resume-rental" data-r="${r.id}">Reprendre</button>`
          : `<button class="small" data-act="stop-rental" data-r="${r.id}">Terminer la location</button>`) : ''}
        <button class="small" data-act="edit-rental" data-r="${r.id}">Modifier la location</button>
        <button class="small danger" data-act="del-rental" data-r="${r.id}">Supprimer</button>
      </div>
    </article>`;
}

// ---------- Interactions ----------

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  render();
});

// Boutons des cartes : la cible est une location (data-r) ou un véhicule (data-v).
function onCardClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const isVehicle = !!b.dataset.v;
  const r = isVehicle ? vehicleById(b.dataset.v) : rentals.find((x) => x.id === b.dataset.r);
  if (!r) return;
  const act = b.dataset.act;
  if (act === 'add-fee') openFee(r, null, isVehicle);
  else if (act === 'edit-fee') openFee(r, r.fees.find((f) => f.id === b.dataset.f), isVehicle);
  else if (act === 'del-fee') {
    if (confirm('Supprimer ce frais ?')) { r.fees = r.fees.filter((f) => f.id !== b.dataset.f); save(); }
  } else if (act === 'add-fine') openFine(r, null);
  else if (act === 'edit-fine') openFine(r, r.fines.find((f) => f.id === b.dataset.fi));
  else if (act === 'toggle-fine') {
    const f = r.fines.find((x) => x.id === b.dataset.fi);
    f.status = f.status === 'done' ? 'pending' : 'done';
    save();
  } else if (act === 'del-fine') {
    if (confirm('Supprimer cette amende ?')) { r.fines = r.fines.filter((f) => f.id !== b.dataset.fi); save(); }
  } else if (act === 'add-pay') openPay(r, null);
  else if (act === 'edit-pay') openPay(r, r.payments.find((p) => p.id === b.dataset.p));
  else if (act === 'del-pay') {
    if (confirm('Supprimer ce paiement ?')) { r.payments = r.payments.filter((p) => p.id !== b.dataset.p); save(); }
  } else if (act === 'stop-rental') {
    const d = prompt('Date de fin de la location (AAAA-MM-JJ) :', todayStr());
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(parseDay(d))) { r.stoppedAt = d; save(); }
    else if (d) alert('Date invalide.');
  } else if (act === 'resume-rental') { delete r.stoppedAt; save(); }
  else if (act === 'edit-rental') openRental(r);
  else if (act === 'del-rental') {
    if (confirm('Supprimer cette location et tous ses frais ?')) { rentals = rentals.filter((x) => x.id !== r.id); save(); }
  }
}
$('#rentals').addEventListener('click', onCardClick);
$('#vehicles').addEventListener('click', onCardClick);

// Location
const dlgRental = $('#dlg-rental');
const formRental = $('#form-rental');

// Le type (seul / avec Ali) découle du véhicule choisi.
function syncRentalVehicle(useVehicleShare) {
  const v = vehicleById(formRental.vehicleId.value);
  const isAli = v && v.type === 'ali';
  $('#share-field').hidden = !isAli;
  $('#rental-type').textContent = v ? (isAli ? 'Véhicule partagé avec Ali' : 'Véhicule à moi seul') : '';
  if (isAli && useVehicleShare) formRental.share.value = v.share;
}
formRental.vehicleId.addEventListener('change', () => syncRentalVehicle(true));

function openRental(r) {
  if (!vehicles.length) {
    alert('Ajoutez d\'abord un véhicule.');
    openVehicles();
    return;
  }
  editingRentalId = r ? r.id : null;
  $('#rental-title').textContent = r ? 'Modifier la location' : 'Nouvelle location';
  formRental.reset();
  const opts = (type, label) => {
    const vs = vehicles.filter((v) => v.type === type);
    return vs.length ? `<optgroup label="${label}">${vs.map((v) => `<option value="${v.id}">${esc(v.name)}${v.plate ? ' (' + esc(v.plate) + ')' : ''}</option>`).join('')}</optgroup>` : '';
  };
  formRental.vehicleId.innerHTML = opts('solo', 'À moi seul') + opts('ali', 'Avec Ali');
  if (r) {
    formRental.vehicleId.value = r.vehicleId;
    formRental.client.value = r.client;
    formRental.phone.value = r.phone || '';
    formRental.start.value = r.start;
    formRental.period.value = r.period || 'jour';
    formRental.price.value = r.price;
    formRental.share.value = r.share;
    syncRentalVehicle(false);
  } else {
    syncRentalVehicle(true);
  }
  dlgRental.showModal();
}
$('#btn-new-rental').addEventListener('click', () => openRental(null));

formRental.addEventListener('submit', () => {
  const v = vehicleById(formRental.vehicleId.value);
  const type = v.type;
  const data = {
    type,
    vehicleId: v.id,
    vehicle: v.name,
    client: formRental.client.value.trim(),
    phone: formRental.phone.value.trim(),
    start: formRental.start.value,
    period: formRental.period.value,
    price: parseFloat(formRental.price.value) || 0,
    share: type === 'ali' ? Math.min(100, Math.max(0, parseFloat(formRental.share.value) || 0)) : 100,
  };
  if (editingRentalId) {
    const r = rentals.find((x) => x.id === editingRentalId);
    Object.assign(r, data);
    // Si la location n'est plus "avec Ali", les frais payés par Ali n'ont plus de sens.
    if (type !== 'ali') r.fees.forEach((f) => { if (f.payer === 'ali') f.payer = 'moi'; });
  } else {
    rentals.push({ id: uid(), ...data, fees: [], payments: [] });
  }
  save();
});

// Frais
const dlgFee = $('#dlg-fee');
const formFee = $('#form-fee');

function openFee(r, fee, isVehicle) {
  feeContext = { owner: r, feeId: fee ? fee.id : null };
  $('#fee-title').textContent = fee ? 'Modifier le frais' : (isVehicle ? 'Nouveau frais sur le véhicule' : 'Nouveau frais');
  formFee.reset();
  // Sans location, il n'y a pas de client : il ne peut pas avancer un frais du véhicule.
  formFee.payer.innerHTML = payersFor(r.type).filter(([v]) => !isVehicle || v !== 'client').map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  formFee.date.value = new Date().toISOString().slice(0, 10);
  if (fee) {
    formFee.label.value = fee.label;
    formFee.amount.value = fee.amount;
    formFee.date.value = fee.date;
    formFee.payer.value = fee.payer;
  }
  dlgFee.showModal();
}

formFee.addEventListener('submit', () => {
  const r = feeContext.owner;
  const data = {
    label: formFee.label.value.trim(),
    amount: parseFloat(formFee.amount.value) || 0,
    date: formFee.date.value,
    payer: formFee.payer.value,
  };
  if (feeContext.feeId) Object.assign(r.fees.find((f) => f.id === feeContext.feeId), data);
  else r.fees.push({ id: uid(), ...data });
  save();
});

// Paiements reçus
const dlgPay = $('#dlg-pay');
const formPay = $('#form-pay');
let payContext = null;

function openPay(r, pay) {
  payContext = { rental: r, payId: pay ? pay.id : null };
  $('#pay-title').textContent = pay ? 'Modifier le paiement' : 'Enregistrer un paiement';
  formPay.reset();
  formPay.date.value = todayStr();
  if (pay) {
    formPay.amount.value = pay.amount;
    formPay.date.value = pay.date;
    formPay.note.value = pay.note || '';
  } else {
    // Par défaut : ce qu'il reste à payer sur la période en cours, ou à défaut le prix d'une période.
    const next = paymentInfo(r).nextAmount;
    formPay.amount.value = next > 0.005 ? +next.toFixed(2) : (r.price || '');
  }
  dlgPay.showModal();
}

formPay.addEventListener('submit', () => {
  const r = payContext.rental;
  r.payments = r.payments || [];
  const data = {
    amount: parseFloat(formPay.amount.value) || 0,
    date: formPay.date.value,
    note: formPay.note.value.trim(),
  };
  if (payContext.payId) Object.assign(r.payments.find((p) => p.id === payContext.payId), data);
  else r.payments.push({ id: uid(), ...data });
  save();
});

document.querySelectorAll('dialog .cancel').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close()));

// Amendes
const dlgFine = $('#dlg-fine');
const formFine = $('#form-fine');
let fineContext = null;

function showFineRenter() {
  const renter = renterAtDate(fineContext.vehicle.id, formFine.date.value);
  $('#fine-renter').textContent = renter
    ? `Locataire à cette date : ${renter.client}${renter.phone ? ' · ' + renter.phone : ''}`
    : (formFine.date.value ? 'Aucune location trouvée à cette date.' : '');
}
formFine.date.addEventListener('change', showFineRenter);

function openFine(v, fine) {
  fineContext = { vehicle: v, fineId: fine ? fine.id : null };
  $('#fine-title').textContent = fine ? 'Modifier l\'amende' : 'Nouvelle amende';
  formFine.reset();
  formFine.date.value = todayStr();
  if (fine) {
    formFine.date.value = fine.date;
    formFine.amount.value = fine.amount;
    formFine.reference.value = fine.reference || '';
    formFine.note.value = fine.note || '';
    formFine.status.value = fine.status;
  }
  showFineRenter();
  dlgFine.showModal();
}

formFine.addEventListener('submit', () => {
  const v = fineContext.vehicle;
  v.fines = v.fines || [];
  const data = {
    date: formFine.date.value,
    amount: parseFloat(formFine.amount.value) || 0,
    reference: formFine.reference.value.trim(),
    note: formFine.note.value.trim(),
    status: formFine.status.value,
  };
  if (fineContext.fineId) Object.assign(v.fines.find((f) => f.id === fineContext.fineId), data);
  else v.fines.push({ id: uid(), ...data });
  save();
});

// Véhicules
const dlgVehicles = $('#dlg-vehicles');
const formVehicle = $('#form-vehicle');

function renderVehicles() {
  const box = $('#vehicle-list');
  if (!vehicles.length) { box.innerHTML = '<p class="muted">Aucun véhicule pour le moment.</p>'; return; }
  box.innerHTML = vehicles.map((v) => {
    const count = rentals.filter((r) => r.vehicleId === v.id).length;
    return `<div class="vehicle">
      <div>
        <strong>${esc(v.name)}</strong>${v.plate ? ' · ' + esc(v.plate) : ''}
        <span class="badge ${v.type}">${v.type === 'ali' ? 'Avec Ali · ' + v.share + ' %' : 'Seul'}</span>
        <div class="muted">${count} location${count > 1 ? 's' : ''}${v.insurance && v.insurance.amount ? ` · assurance ${money(v.insurance.amount)}/mois (${payerLabel(v.insurance.payer)})` : ''}${v.purchasePrice ? ` · achat ${money(v.purchasePrice)}${recoveryInfo(v).recovered ? ' (remboursé)' : ''}` : ''}</div>
      </div>
      <div class="btns">
        <button class="small" data-vact="edit" data-v="${v.id}">Modifier</button>
        <button class="small danger" data-vact="del" data-v="${v.id}">✕</button>
      </div>
    </div>`;
  }).join('');
}

function toggleVehicleShare() {
  const isAli = formVehicle.type.value === 'ali';
  $('#vehicle-share-field').hidden = !isAli;
  $('#vehicle-insurance-payer-field').hidden = !isAli;
}
formVehicle.type.addEventListener('change', toggleVehicleShare);

function resetVehicleForm() {
  editingVehicleId = null;
  formVehicle.reset();
  formVehicle.insuranceStart.value = todayStr();
  $('#vehicle-form-title').textContent = 'Ajouter un véhicule';
  $('#vehicle-submit').textContent = 'Ajouter';
  $('#vehicle-cancel-edit').hidden = true;
  toggleVehicleShare();
}

function openVehicles() {
  resetVehicleForm();
  renderVehicles();
  dlgVehicles.showModal();
}
$('#btn-vehicles').addEventListener('click', openVehicles);
$('#vehicle-cancel-edit').addEventListener('click', resetVehicleForm);

$('#vehicle-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-vact]');
  if (!b) return;
  const v = vehicleById(b.dataset.v);
  if (b.dataset.vact === 'edit') {
    editingVehicleId = v.id;
    formVehicle.name.value = v.name;
    formVehicle.plate.value = v.plate || '';
    formVehicle.purchasePrice.value = v.purchasePrice || '';
    formVehicle.type.value = v.type;
    formVehicle.share.value = v.share ?? 50;
    formVehicle.insuranceAmount.value = v.insurance ? v.insurance.amount : '';
    formVehicle.insuranceStart.value = v.insurance ? v.insurance.start : todayStr();
    formVehicle.insurancePayer.value = v.insurance ? v.insurance.payer : 'moi';
    $('#vehicle-form-title').textContent = 'Modifier le véhicule';
    $('#vehicle-submit').textContent = 'Enregistrer';
    $('#vehicle-cancel-edit').hidden = false;
    toggleVehicleShare();
  } else if (rentals.some((r) => r.vehicleId === v.id)) {
    alert('Ce véhicule a des locations : supprimez-les d\'abord.');
  } else if (confirm(`Supprimer ${v.name} ?`)) {
    vehicles = vehicles.filter((x) => x.id !== v.id);
    save();
    renderVehicles();
  }
});

formVehicle.addEventListener('submit', (e) => {
  e.preventDefault();
  const type = formVehicle.type.value;
  const insuranceAmount = parseFloat(formVehicle.insuranceAmount.value) || 0;
  const data = {
    name: formVehicle.name.value.trim(),
    plate: formVehicle.plate.value.trim(),
    purchasePrice: parseFloat(formVehicle.purchasePrice.value) || 0,
    type,
    share: type === 'ali' ? Math.min(100, Math.max(0, parseFloat(formVehicle.share.value) || 0)) : 100,
    insurance: insuranceAmount > 0 ? {
      amount: insuranceAmount,
      start: formVehicle.insuranceStart.value || todayStr(),
      payer: type === 'ali' ? formVehicle.insurancePayer.value : 'moi',
    } : null,
  };
  if (editingVehicleId) {
    const v = vehicleById(editingVehicleId);
    // Les locations existantes gardent leur type et leur part : seuls le nom et la plaque changent.
    Object.assign(v, data);
    rentals.filter((r) => r.vehicleId === v.id).forEach((r) => { r.vehicle = v.name; });
    // Un véhicule qui n'est plus partagé n'a plus de frais payés par Ali.
    if (type !== 'ali') v.fees.forEach((f) => { if (f.payer === 'ali') f.payer = 'moi'; });
  } else {
    vehicles.push({ id: uid(), ...data, fees: [], fines: [] });
  }
  save();
  resetVehicleForm();
  renderVehicles();
});

// Export / import
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ vehicles, rentals }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `locations-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (typeof raw !== 'object' || raw === null) throw new Error();
    if (confirm('Remplacer les données actuelles par celles du fichier ?')) {
      ({ vehicles, rentals } = normalize(raw));
      save();
    }
  } catch { alert('Fichier invalide.'); }
  e.target.value = '';
});

render();
