// views/settings.js — réglages : revenus/épargne, budgets du mois, catégories,
// commerçants, export/import CSV, réinitialisation du mois.

import {
  categories, merchants, expenses, monthlyBudgets, settings, resetMonth, uuid,
} from '../db.js';
import { toCents, toInputValue, formatEuros } from '../money.js';
import { buildCSV, downloadCSV, parseCSV } from '../csv.js';

export async function render(root, app) {
  const { year, month } = app.state;
  const [cfg, cats, budgets, merchantList] = await Promise.all([
    settings.get(),
    categories.all(),
    monthlyBudgets.ensure(year, month),
    merchants.all(),
  ]);

  const active = cats.filter((c) => !c.archived).sort((a, b) => a.sortOrder - b.sortOrder);
  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b.amount]));

  root.innerHTML = `
    <header class="screen-head">
      <div class="month-nav">
        <button class="icon-btn" data-act="back" aria-label="Retour">‹</button>
        <h1>Réglages</h1>
      </div>
    </header>

    <section class="settings-section">
      <h2>Revenus</h2>
      <div class="list-row">
        <span class="row-label">Revenu mensuel</span>
        <input id="s-income" type="text" inputmode="decimal"
               value="${toInputValue(cfg?.monthlyIncome ?? 0)}">
      </div>
      <div class="list-row">
        <span class="row-label">Objectif d'épargne</span>
        <input id="s-savings" type="text" inputmode="decimal"
               value="${toInputValue(cfg?.savingsTarget ?? 0)}">
      </div>
    </section>

    <section class="settings-section">
      <h2>Budgets — ${app.monthLabel(year, month)}</h2>
      ${active.map((c) => `
        <div class="list-row">
          <span class="row-icon" aria-hidden="true">${c.icon}</span>
          <span class="row-label">${escapeHtml(c.name)}</span>
          <input type="text" inputmode="decimal" data-budget="${c.id}"
                 value="${toInputValue(budgetMap.get(c.id) ?? c.monthlyBudget)}">
        </div>`).join('')}
      <p class="muted mt-4">Modifier un budget ici ne change que ${app.monthLabel(year, month)}.</p>
    </section>

    <section class="settings-section">
      <h2>Catégories</h2>
      <div id="cat-list">
        ${cats.sort((a, b) => a.sortOrder - b.sortOrder).map((c) => catRow(c)).join('')}
      </div>
      <button class="btn btn-secondary btn-block mt-4" data-act="add-cat">＋ Nouvelle catégorie</button>
    </section>

    <section class="settings-section">
      <h2>Commerçants (${merchantList.length})</h2>
      <input type="search" id="merch-search" placeholder="Filtrer…" class="mb-4">
      <div id="merch-list"></div>
      <button class="btn btn-secondary btn-block mt-4" data-act="add-merch">＋ Nouveau commerçant</button>
    </section>

    <section class="settings-section">
      <h2>Données</h2>
      <div class="stack">
        <button class="btn btn-secondary btn-block" data-act="export">⬇︎ Exporter en CSV</button>
        <button class="btn btn-secondary btn-block" data-act="import">⬆︎ Importer un CSV</button>
        <input type="file" id="import-file" accept=".csv,text/csv" hidden>
        <button class="btn btn-danger btn-block" data-act="reset">Réinitialiser ${app.monthLabel(year, month)}</button>
      </div>
      <p class="muted mt-4">
        ${cfg?.lastExportAt
          ? 'Dernière sauvegarde : ' + new Date(cfg.lastExportAt).toLocaleDateString('fr-FR')
          : 'Aucune sauvegarde exportée pour l\'instant.'}
      </p>
    </section>
  `;

  // ---- Revenus / épargne (sauvegarde à la sortie du champ) ----
  root.querySelector('#s-income').addEventListener('change', (e) => {
    settings.patch({ monthlyIncome: toCents(e.target.value) }).then(() => app.toast('Revenu mis à jour.'));
  });
  root.querySelector('#s-savings').addEventListener('change', (e) => {
    settings.patch({ savingsTarget: toCents(e.target.value) }).then(() => app.toast('Objectif mis à jour.'));
  });

  // ---- Budgets du mois ----
  root.querySelectorAll('input[data-budget]').forEach((input) => {
    input.addEventListener('change', async () => {
      const categoryId = input.dataset.budget;
      const amount = toCents(input.value);
      await monthlyBudgets.put({
        id: `${year}-${String(month).padStart(2, '0')}_${categoryId}`,
        year, month, categoryId, amount,
      });
      app.toast('Budget mis à jour.');
    });
  });

  // ---- Catégories ----
  root.querySelector('[data-act="add-cat"]').addEventListener('click', () => editCategory(app, null, cats));
  root.querySelectorAll('#cat-list .list-row').forEach((row) => {
    const id = row.dataset.id;
    const cat = cats.find((c) => c.id === id);
    row.querySelector('[data-act="edit-cat"]').addEventListener('click', () => editCategory(app, cat, cats));
    row.querySelector('[data-act="archive-cat"]').addEventListener('click', async () => {
      await categories.put({ ...cat, archived: !cat.archived });
      app.refresh();
    });
  });

  // ---- Commerçants ----
  const merchListEl = root.querySelector('#merch-list');
  function renderMerchants(q = '') {
    const ql = q.trim().toLowerCase();
    const list = merchantList.filter((m) => m.name.toLowerCase().includes(ql));
    const catById = new Map(cats.map((c) => [c.id, c]));
    merchListEl.innerHTML = list.map((m) => {
      const cat = catById.get(m.defaultCategoryId);
      const amount = m.defaultAmount != null ? formatEuros(m.defaultAmount) : 'variable';
      return `<div class="list-row" data-id="${m.id}">
        <span class="row-icon" aria-hidden="true">${cat ? cat.icon : '🏷️'}</span>
        <span class="row-label">${escapeHtml(m.name)}<br>
          <span class="muted">${cat ? escapeHtml(cat.name) : ''} · ${amount}</span></span>
        <button class="icon-btn" data-act="edit-merch" aria-label="Modifier">✎</button>
      </div>`;
    }).join('') || '<p class="muted center">Aucun commerçant.</p>';

    merchListEl.querySelectorAll('.list-row').forEach((row) => {
      const m = merchantList.find((x) => x.id === row.dataset.id);
      row.querySelector('[data-act="edit-merch"]').addEventListener('click', () => editMerchant(app, m, cats));
    });
  }
  renderMerchants();
  root.querySelector('#merch-search').addEventListener('input', (e) => renderMerchants(e.target.value));
  root.querySelector('[data-act="add-merch"]').addEventListener('click', () => editMerchant(app, null, cats));

  // ---- Navigation ----
  root.querySelector('[data-act="back"]').addEventListener('click', () => app.navigate('month'));

  // ---- Export / import / reset ----
  root.querySelector('[data-act="export"]').addEventListener('click', async () => {
    const all = await expenses.all();
    if (all.length === 0) { app.toast('Rien à exporter.'); return; }
    const filename = downloadCSV(buildCSV(all, cats));
    await settings.patch({ lastExportAt: Date.now() });
    app.toast(`Exporté : ${filename}`);
  });

  const fileInput = root.querySelector('#import-file');
  root.querySelector('[data-act="import"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { records, errors } = parseCSV(text, cats, uuid);
    fileInput.value = '';
    if (records.length === 0) { app.toast('Aucune ligne valide dans ce CSV.'); return; }
    const ok = await app.confirm({
      title: 'Importer ces dépenses ?',
      message: `${records.length} dépense(s) seront ajoutées${errors ? `, ${errors} ligne(s) ignorée(s)` : ''}.`,
      confirmLabel: 'Importer',
    });
    if (!ok) return;
    await expenses.bulkPut(records);
    app.toast(`${records.length} dépense(s) importée(s).`);
    app.refresh();
  });

  root.querySelector('[data-act="reset"]').addEventListener('click', async () => {
    const ok = await app.confirm({
      title: `Réinitialiser ${app.monthLabel(year, month)} ?`,
      message: 'Toutes les dépenses de ce mois seront supprimées. Les budgets sont conservés.',
      confirmLabel: 'Réinitialiser',
      danger: true,
    });
    if (!ok) return;
    const n = await resetMonth(year, month);
    app.toast(`${n} dépense(s) supprimée(s).`);
  });
}

function catRow(c) {
  return `<div class="list-row" data-id="${c.id}">
    <span class="row-icon" aria-hidden="true">${c.icon}</span>
    <span class="row-label">${escapeHtml(c.name)}
      ${c.archived ? '<span class="archived-tag">— archivée</span>' : ''}</span>
    <button class="icon-btn" data-act="edit-cat" aria-label="Modifier">✎</button>
    <button class="icon-btn" data-act="archive-cat" aria-label="${c.archived ? 'Réactiver' : 'Archiver'}">
      ${c.archived ? '↩︎' : '🗄'}</button>
  </div>`;
}

// --- Formulaires modaux -----------------------------------------------------

async function editCategory(app, cat, allCats) {
  const isNew = !cat;
  const s = app.sheetEl;
  s.innerHTML = `
    <h2>${isNew ? 'Nouvelle catégorie' : 'Modifier la catégorie'}</h2>
    <div class="field"><label>Nom</label>
      <input id="c-name" type="text" value="${escapeAttr(cat?.name ?? '')}"></div>
    <div class="field"><label>Icône (emoji)</label>
      <input id="c-icon" type="text" maxlength="4" value="${escapeAttr(cat?.icon ?? '🏷️')}"></div>
    <div class="field"><label>Couleur</label>
      <input id="c-color" type="color" value="${cat?.color ?? '#5b6b7b'}"></div>
    <div class="field"><label>Budget de référence</label>
      <input id="c-budget" type="text" inputmode="decimal"
             value="${toInputValue(cat?.monthlyBudget ?? 0)}"></div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-act="cancel">Annuler</button>
      <button class="btn btn-primary" data-act="save">Enregistrer</button>
    </div>
  `;
  app.openSheet();
  s.querySelector('[data-act="cancel"]').addEventListener('click', () => app.closeSheet());
  s.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const name = s.querySelector('#c-name').value.trim();
    if (!name) { app.toast('Donne un nom.'); return; }
    const monthlyBudget = toCents(s.querySelector('#c-budget').value);
    const record = {
      id: cat?.id ?? uuid(),
      name,
      icon: s.querySelector('#c-icon').value.trim() || '🏷️',
      color: s.querySelector('#c-color').value,
      monthlyBudget,
      sortOrder: cat?.sortOrder ?? (Math.max(0, ...allCats.map((c) => c.sortOrder)) + 1),
      archived: cat?.archived ?? false,
    };
    await categories.put(record);
    // Nouvelle catégorie : lui créer un budget pour le mois courant.
    if (isNew) {
      const { year, month } = app.state;
      await monthlyBudgets.put({
        id: `${year}-${String(month).padStart(2, '0')}_${record.id}`,
        year, month, categoryId: record.id, amount: monthlyBudget,
      });
    }
    app.closeSheet();
    app.refresh();
  });
}

async function editMerchant(app, m, allCats) {
  const isNew = !m;
  const active = allCats.filter((c) => !c.archived);
  const s = app.sheetEl;
  s.innerHTML = `
    <h2>${isNew ? 'Nouveau commerçant' : 'Modifier le commerçant'}</h2>
    <div class="field"><label>Nom</label>
      <input id="m-name" type="text" value="${escapeAttr(m?.name ?? '')}"></div>
    <div class="field"><label>Catégorie par défaut</label>
      <select id="m-cat">
        ${active.map((c) => `<option value="${c.id}" ${m?.defaultCategoryId === c.id ? 'selected' : ''}>
          ${escapeHtml(c.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label>Montant par défaut <span class="muted">(vide = variable)</span></label>
      <input id="m-amount" type="text" inputmode="decimal"
             value="${m?.defaultAmount != null ? toInputValue(m.defaultAmount) : ''}"></div>
    <div class="sheet-actions">
      ${isNew ? '' : '<button class="btn btn-danger" data-act="delete">Supprimer</button>'}
      <button class="btn btn-secondary" data-act="cancel">Annuler</button>
      <button class="btn btn-primary" data-act="save">Enregistrer</button>
    </div>
  `;
  app.openSheet();
  s.querySelector('[data-act="cancel"]').addEventListener('click', () => app.closeSheet());
  s.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    await merchants.delete(m.id);
    app.closeSheet();
    app.refresh();
  });
  s.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const name = s.querySelector('#m-name').value.trim();
    if (!name) { app.toast('Donne un nom.'); return; }
    const amountStr = s.querySelector('#m-amount').value.trim();
    await merchants.put({
      id: m?.id ?? uuid(),
      name,
      defaultCategoryId: s.querySelector('#m-cat').value,
      defaultAmount: amountStr === '' ? null : toCents(amountStr),
      useCount: m?.useCount ?? 0,
      lastUsedAt: m?.lastUsedAt ?? null,
    });
    app.closeSheet();
    app.refresh();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }
