// views/settings.js — réglages : revenus/épargne, budgets du mois, catégories,
// commerçants, export/import CSV, réinitialisation du mois.

import {
  categories, merchants, expenses, monthlyBudgets, settings, resetMonth, uuid,
} from '../db.js';
import { toCents, toInputValue, formatEuros } from '../money.js';
import { buildCSV, downloadCSV, parseCSV } from '../csv.js';
import { buildBackup, downloadBackup, parseBackup, restoreBackup } from '../backup.js';
import {
  getConfig as getSyncConfig, saveConfig as saveSyncConfig, disconnect as syncDisconnect,
  testConnection, push as syncPush, pull as syncPull, isConfigured,
  onSyncStatus, statusLabel, initSync,
} from '../sync.js';

export async function render(root, app) {
  const { year, month } = app.state;
  const [cfg, cats, budgets, merchantList, gh] = await Promise.all([
    settings.get(),
    categories.all(),
    monthlyBudgets.ensure(year, month),
    merchants.all(),
    getSyncConfig(),
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
      <h2>Synchronisation GitHub</h2>
      <div class="sync-status" id="sync-status"><span class="dot"></span><span class="txt">…</span></div>

      <div class="field"><label for="gh-owner">Compte GitHub</label>
        <input id="gh-owner" type="text" autocapitalize="off" autocorrect="off"
               spellcheck="false" placeholder="oliviertanoh"
               value="${escapeAttr(gh.owner)}"></div>

      <div class="field"><label for="gh-repo">Dépôt <span class="muted">(privé)</span></label>
        <input id="gh-repo" type="text" autocapitalize="off" autocorrect="off"
               spellcheck="false" placeholder="comptes-clairs-data"
               value="${escapeAttr(gh.repo)}"></div>

      <div class="field"><label for="gh-token">Jeton d'accès</label>
        <input id="gh-token" type="password" autocapitalize="off" autocorrect="off"
               spellcheck="false" autocomplete="off"
               placeholder="${gh.token ? '•••••••• enregistré' : 'github_pat_…'}"></div>

      <details class="mt-4">
        <summary class="muted">Options avancées</summary>
        <div class="field mt-4"><label for="gh-branch">Branche</label>
          <input id="gh-branch" type="text" autocapitalize="off" spellcheck="false"
                 value="${escapeAttr(gh.branch)}"></div>
        <div class="field"><label for="gh-path">Fichier</label>
          <input id="gh-path" type="text" autocapitalize="off" spellcheck="false"
                 value="${escapeAttr(gh.path)}"></div>
      </details>

      <div class="list-row mt-4">
        <span class="row-label">Sauvegarde automatique</span>
        <input type="checkbox" id="gh-enabled" ${gh.enabled ? 'checked' : ''}>
      </div>

      <div class="stack mt-4">
        <button class="btn btn-primary btn-block" data-act="gh-test">Tester et connecter</button>
        <button class="btn btn-secondary btn-block" data-act="gh-push">⬆︎ Envoyer maintenant</button>
        <button class="btn btn-secondary btn-block" data-act="gh-pull">⬇︎ Récupérer depuis GitHub</button>
        ${isConfigured(gh) ? '<button class="btn btn-danger btn-block" data-act="gh-off">Déconnecter cet appareil</button>' : ''}
      </div>

      <p class="muted mt-4">
        Le dépôt doit être <strong>privé</strong> : le fichier contient ton revenu
        et chacune de tes dépenses. Crée un jeton
        <em>fine-grained</em> limité à ce seul dépôt, permission
        <strong>Contents : Read and write</strong>. Il reste sur cet appareil et
        n'est jamais inclus dans une sauvegarde.
      </p>
    </section>

    <section class="settings-section">
      <h2>Sauvegarde complète</h2>
      <div class="stack">
        <button class="btn btn-secondary btn-block" data-act="backup">🗄 Sauvegarder tout (JSON)</button>
        <button class="btn btn-secondary btn-block" data-act="restore">♻︎ Restaurer une sauvegarde</button>
        <input type="file" id="restore-file" accept=".json,application/json" hidden>
      </div>
      <div class="list-row mt-4">
        <span class="row-label">Me rappeler de sauvegarder</span>
        <select id="s-reminder" style="max-width:48%">
          <option value="7" ${(cfg?.reminderDays ?? 30) === 7 ? 'selected' : ''}>tous les 7 jours</option>
          <option value="30" ${(cfg?.reminderDays ?? 30) === 30 ? 'selected' : ''}>tous les 30 jours</option>
          <option value="0" ${(cfg?.reminderDays ?? 30) === 0 ? 'selected' : ''}>jamais</option>
        </select>
      </div>
      <p class="muted mt-4">
        Capture <strong>tout</strong> (catégories, budgets, commerçants, réglages,
        dépenses) dans un fichier — même format que la synchro GitHub, donc
        interchangeable. Utile comme filet en plus, ou si tu n'utilises pas la synchro.
        ${cfg?.lastExportAt
          ? '<br>Dernier export : ' + new Date(cfg.lastExportAt).toLocaleDateString('fr-FR')
          : ''}
      </p>
    </section>

    <section class="settings-section">
      <h2>Données (CSV & réinitialisation)</h2>
      <div class="stack">
        <button class="btn btn-secondary btn-block" data-act="export">⬇︎ Exporter les dépenses (CSV)</button>
        <button class="btn btn-secondary btn-block" data-act="import">⬆︎ Importer des dépenses (CSV)</button>
        <input type="file" id="import-file" accept=".csv,text/csv" hidden>
        <button class="btn btn-danger btn-block" data-act="reset">Réinitialiser ${app.monthLabel(year, month)}</button>
      </div>
      <p class="muted mt-4">Le CSV s'ouvre dans Excel mais ne contient que les dépenses.
        Pour une sauvegarde totale, utilise « Sauvegarder tout » ci-dessus.</p>
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

  // ---- Synchronisation GitHub ----
  bindGithubSync(root, app, gh);

  // ---- Fréquence du rappel de sauvegarde ----
  root.querySelector('#s-reminder').addEventListener('change', (e) => {
    settings.patch({ reminderDays: Number(e.target.value) }).then(() => app.toast('Rappel mis à jour.'));
  });

  // ---- Sauvegarde complète (JSON) ----
  root.querySelector('[data-act="backup"]').addEventListener('click', async () => {
    const backup = await buildBackup();
    const filename = downloadBackup(backup);
    await settings.patch({ lastExportAt: Date.now() });
    app.toast(`Sauvegarde : ${filename}`);
  });

  const restoreInput = root.querySelector('#restore-file');
  root.querySelector('[data-act="restore"]').addEventListener('click', () => restoreInput.click());
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    restoreInput.value = '';
    let parsed;
    try {
      parsed = parseBackup(await file.text());
    } catch (e) {
      app.toast(e.message);
      return;
    }
    const c = parsed.counts;
    const ok = await app.confirm({
      title: 'Restaurer cette sauvegarde ?',
      message: `Cela REMPLACE toutes les données actuelles par : `
        + `${c.expenses} dépense(s), ${c.categories} catégorie(s), `
        + `${c.merchants} commerçant(s). Action irréversible.`,
      confirmLabel: 'Restaurer',
      danger: true,
    });
    if (!ok) return;
    await restoreBackup(parsed.data);
    app.toast('Sauvegarde restaurée.');
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

// --- Synchronisation GitHub -------------------------------------------------

function bindGithubSync(root, app, gh) {
  const statusEl = root.querySelector('#sync-status');

  app.onCleanup(onSyncStatus((s) => {
    statusEl.className = `sync-status is-${s.state}`;
    statusEl.querySelector('.txt').textContent = statusLabel(s);
  }));

  // Lit les champs. Le jeton n'est remplacé que si l'utilisateur en saisit un
  // nouveau : le champ est vide à l'affichage, on ne l'écrase pas par du vide.
  const readForm = () => {
    const typedToken = root.querySelector('#gh-token').value.trim();
    return {
      owner: root.querySelector('#gh-owner').value.trim(),
      repo: root.querySelector('#gh-repo').value.trim(),
      branch: root.querySelector('#gh-branch').value.trim() || 'main',
      path: root.querySelector('#gh-path').value.trim() || 'comptes-clairs.json',
      enabled: root.querySelector('#gh-enabled').checked,
      ...(typedToken ? { token: typedToken } : {}),
    };
  };

  // Sauvegarde silencieuse à chaque modification de champ : sans ça, appuyer
  // sur « Envoyer » juste après avoir tapé le dépôt utiliserait l'ancien.
  const persist = async () => saveSyncConfig(readForm());
  root.querySelectorAll('#gh-owner, #gh-repo, #gh-branch, #gh-path, #gh-token')
    .forEach((el) => el.addEventListener('change', persist));

  root.querySelector('#gh-enabled').addEventListener('change', async () => {
    const cfg = await saveSyncConfig(readForm());
    if (cfg.enabled && !isConfigured(cfg)) {
      app.toast('Renseigne le compte, le dépôt et le jeton.');
      return;
    }
    await initSync(app); // (ré)arme ou désarme le moteur automatique
    app.toast(cfg.enabled ? 'Sauvegarde automatique activée.' : 'Sauvegarde automatique désactivée.');
  });

  const withBusy = async (btn, fn) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { duration: 5000 });
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  root.querySelector('[data-act="gh-test"]').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const cfg = await saveSyncConfig(readForm());
      if (!isConfigured(cfg)) {
        app.toast('Renseigne le compte, le dépôt et le jeton.');
        return;
      }
      const info = await testConnection(cfg);

      // Un dépôt public exposerait revenu, montants et commerçants au monde
      // entier, définitivement (l'historique git ne s'efface pas). On ne
      // bloque pas — mais on ne laisse pas passer ça en silence.
      if (!info.private) {
        const ok = await app.confirm({
          title: '⚠️ Ce dépôt est public',
          message:
            `${info.fullName} est visible par tout le monde. Y écrire publierait `
            + 'ton revenu, ton objectif d\'épargne et chacune de tes dépenses '
            + '(date, montant, commerçant) — et ils resteraient dans l\'historique '
            + 'git même après suppression. Utilise plutôt un dépôt privé.',
          confirmLabel: 'Utiliser quand même',
          danger: true,
        });
        if (!ok) return;
      }

      await saveSyncConfig({ enabled: true });
      root.querySelector('#gh-enabled').checked = true;
      await initSync(app);
      app.toast(info.hasFile
        ? `Connecté à ${info.fullName} — sauvegarde existante trouvée.`
        : `Connecté à ${info.fullName} — dépôt vide, prêt.`);
    }));

  root.querySelector('[data-act="gh-push"]').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const cfg = await saveSyncConfig(readForm());
      if (!isConfigured(cfg)) { app.toast('Connecte d\'abord un dépôt.'); return; }
      try {
        await syncPush(cfg, { reason: 'envoi manuel' });
      } catch (err) {
        // Conflit = un autre appareil a écrit depuis. Signaler sans offrir de
        // sortie laisserait la sync bloquée : on propose d'écraser, en disant
        // clairement ce qui se perd.
        if (err.kind !== 'conflict') throw err;
        const ok = await app.confirm({
          title: 'GitHub a changé depuis',
          message: 'Un autre appareil a sauvegardé entre-temps. Envoyer maintenant '
            + 'écrasera cette version-là par celle de cet appareil.',
          confirmLabel: 'Écraser GitHub',
          danger: true,
        });
        if (!ok) return;
        await syncPush(cfg, { force: true, reason: 'envoi manuel (écrasement)' });
      }
      app.toast('Envoyé sur GitHub.');
      app.refresh();
    }));

  root.querySelector('[data-act="gh-pull"]').addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const cfg = await saveSyncConfig(readForm());
      if (!isConfigured(cfg)) { app.toast('Connecte d\'abord un dépôt.'); return; }
      const ok = await app.confirm({
        title: 'Récupérer depuis GitHub ?',
        message: 'Les données de cet appareil seront REMPLACÉES par celles du dépôt.',
        confirmLabel: 'Récupérer',
        danger: true,
      });
      if (!ok) return;
      const { counts } = await syncPull(cfg);
      app.toast(`${counts.expenses} dépense(s) récupérée(s).`);
      app.refresh();
    }));

  root.querySelector('[data-act="gh-off"]')?.addEventListener('click', async () => {
    const ok = await app.confirm({
      title: 'Déconnecter cet appareil ?',
      message: 'Le jeton sera effacé d\'ici. Tes données locales et la sauvegarde '
        + 'sur GitHub ne sont pas touchées.',
      confirmLabel: 'Déconnecter',
      danger: true,
    });
    if (!ok) return;
    await syncDisconnect();
    app.toast('Déconnecté.');
    app.refresh();
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
