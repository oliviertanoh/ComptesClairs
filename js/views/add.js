// views/add.js — saisie d'une dépense. Doit être utilisable en < 10 s.
// Sert aussi à MODIFIER une dépense existante (params.editId).

import { categories, merchants, expenses, recurring, uuid } from '../db.js';
import { ruleFromExpense } from '../recurring.js';
import { toCents, toInputValue, formatEuros } from '../money.js';

// Mémorise la dernière catégorie choisie pour accélérer les saisies en série.
let lastCategoryId = null;

const todayISO = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

export async function render(root, app, params = {}) {
  const [cats, merchantList] = await Promise.all([
    categories.active(),
    merchants.all(),
  ]);

  const autreCat = cats.find((c) => c.name === 'Autre') || cats[cats.length - 1];
  const editing = params.editId ? await expenses.get(params.editId) : null;

  // État local de la saisie.
  const draft = {
    amount: editing ? toInputValue(editing.amount) : '',
    label: editing ? editing.label : '',
    categoryId: editing
      ? editing.categoryId
      : (lastCategoryId || defaultCategoryId(cats)),
    date: editing ? editing.date : todayISO(),
    note: editing ? (editing.note || '') : '',
    merchantId: null,
    // 'expense' | 'income'. Une rentrée (remboursement d'un ami, prime, vente)
    // n'est pas une dépense négative : elle ne doit entamer aucun budget de
    // catégorie, seulement gonfler le revenu du mois.
    kind: editing?.kind === 'income' ? 'income' : 'expense',
  };

  root.innerHTML = `
    <header class="screen-head">
      <h1>${editing ? 'Modifier' : 'Ajouter'}</h1>
      ${editing ? '' : '<button class="icon-btn" data-act="close" aria-label="Fermer">✕</button>'}
    </header>

    <div class="kind-toggle" role="group" aria-label="Type d'opération">
      <button type="button" data-kind="expense"
              aria-pressed="${draft.kind === 'expense'}">Dépense</button>
      <button type="button" data-kind="income"
              aria-pressed="${draft.kind === 'income'}">Rentrée</button>
    </div>

    <div class="field">
      <label for="f-amount">Montant</label>
      <div class="input-suffix">
        <input id="f-amount" class="amount-input" type="text" inputmode="decimal"
               enterkeyhint="next" autocomplete="off" placeholder="0"
               value="${escapeAttr(draft.amount)}">
      </div>
    </div>

    <div class="field">
      <label for="f-label">Libellé</label>
      <input id="f-label" type="text" autocomplete="off" autocorrect="off"
             autocapitalize="sentences" placeholder="Ex. Auchan, Uber Eats…"
             value="${escapeAttr(draft.label)}">
      <ul id="suggestions" class="suggestions"></ul>
    </div>

    <div class="field" id="cat-field">
      <label>Catégorie</label>
      <div class="cat-picker" id="cat-picker">
        ${cats.map((c) => catButton(c, draft.categoryId)).join('')}
      </div>
    </div>

    <div class="field">
      <label for="f-date">Date</label>
      <input id="f-date" type="date" value="${draft.date}">
    </div>

    <div class="field" id="note-field">
      <label for="f-note">Note <span class="muted" id="note-hint"></span></label>
      <textarea id="f-note" placeholder="Optionnel">${escapeHtml(draft.note)}</textarea>
    </div>

    <button class="btn btn-primary btn-block btn-lg" id="save">
      ${editing ? 'Enregistrer les modifications' : 'Enregistrer'}
    </button>
    ${editing && !editing.recurringId && editing.kind !== 'income'
      ? '<button class="btn btn-secondary btn-block mt-4" id="make-recurring">🔁 Celle-ci revient chaque mois</button>'
      : ''}
    ${editing ? '<button class="btn btn-danger btn-block mt-4" id="delete">Supprimer</button>' : ''}
  `;

  const amountEl = root.querySelector('#f-amount');
  const labelEl = root.querySelector('#f-label');
  const suggEl = root.querySelector('#suggestions');
  const pickerEl = root.querySelector('#cat-picker');
  const catFieldEl = root.querySelector('#cat-field');
  const dateEl = root.querySelector('#f-date');
  const noteEl = root.querySelector('#f-note');
  const saveEl = root.querySelector('#save');

  // --- Dépense ou rentrée ---
  function selectKind(kind) {
    draft.kind = kind;
    root.querySelectorAll('.kind-toggle button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    });
    // Une rentrée n'appartient à aucun budget : afficher le sélecteur de
    // catégorie laisserait croire qu'elle en alimente un.
    const isIncome = kind === 'income';
    catFieldEl.hidden = isIncome;
    labelEl.placeholder = isIncome
      ? 'Ex. Remboursement Léa, prime, Vinted…'
      : 'Ex. Auchan, Uber Eats…';
    if (!editing) saveEl.textContent = isIncome ? 'Enregistrer la rentrée' : 'Enregistrer';
    if (isIncome) suggEl.innerHTML = '';
  }

  root.querySelectorAll('.kind-toggle button').forEach((b) => {
    b.addEventListener('click', () => selectKind(b.dataset.kind));
  });
  selectKind(draft.kind);

  // --- Catégorie : sélection ---
  function selectCategory(id) {
    draft.categoryId = id;
    pickerEl.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.id === id));
    });
    updateNoteHint();
  }

  function updateNoteHint() {
    const cat = cats.find((c) => c.id === draft.categoryId);
    const isAutre = cat && cat.name === 'Autre';
    root.querySelector('#note-hint').textContent = isAutre ? '— précise, c\'est « Autre »' : '';
    noteEl.placeholder = isAutre ? 'De quoi s\'agit-il ?' : 'Optionnel';
  }

  pickerEl.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => selectCategory(b.dataset.id));
  });
  updateNoteHint();

  // --- Libellé : suggestions ---
  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (q === '') {
      suggEl.innerHTML = '';
      return;
    }
    const matches = merchantList
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 6);

    suggEl.innerHTML = matches.map((m) => {
      const cat = cats.find((c) => c.id === m.defaultCategoryId);
      const meta = m.defaultAmount != null ? formatEuros(m.defaultAmount) : (cat ? cat.name : '');
      return `<li data-id="${m.id}">
        <span aria-hidden="true">${cat ? cat.icon : '🏷️'}</span>
        <span class="s-name">${escapeHtml(m.name)}</span>
        <span class="s-meta">${escapeHtml(meta)}</span>
      </li>`;
    }).join('');

    suggEl.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => applyMerchant(li.dataset.id));
    });
  }

  function applyMerchant(id) {
    const m = merchantList.find((x) => x.id === id);
    if (!m) return;
    draft.merchantId = m.id;
    labelEl.value = m.name;
    if (m.defaultCategoryId) selectCategory(m.defaultCategoryId);
    if (m.defaultAmount != null && amountEl.value.trim() === '') {
      amountEl.value = toInputValue(m.defaultAmount);
    }
    suggEl.innerHTML = '';
    // Si le montant manque encore, on y renvoie le focus ; sinon on file.
    if (amountEl.value.trim() === '') amountEl.focus();
  }

  labelEl.addEventListener('input', () => {
    draft.merchantId = null; // saisie manuelle : on oublie la suggestion choisie
    // La bibliothèque de commerçants ne concerne que les dépenses.
    if (draft.kind !== 'income') renderSuggestions(labelEl.value);
  });

  // --- Fermer (croix) ---
  root.querySelector('[data-act="close"]')?.addEventListener('click', () => app.navigate('month'));

  // --- Enregistrer ---
  root.querySelector('#save').addEventListener('click', () => save());
  amountEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') labelEl.focus();
  });

  async function save() {
    const cents = toCents(amountEl.value);
    if (cents <= 0) {
      app.toast('Entre un montant.');
      amountEl.focus();
      return;
    }

    const isIncome = draft.kind === 'income';
    let categoryId = draft.categoryId;
    let label = labelEl.value.trim();

    // Libellé inconnu et aucune catégorie explicite -> Autre.
    if (label === '') label = isIncome ? 'Rentrée' : fallbackLabel(cats, categoryId);
    if (!categoryId) categoryId = autreCat.id;

    const record = {
      id: editing ? editing.id : uuid(),
      date: dateEl.value || todayISO(),
      label,
      amount: cents,
      categoryId,
      kind: isIncome ? 'income' : 'expense',
      note: noteEl.value.trim() || null,
      createdAt: editing ? editing.createdAt : Date.now(),
      // Modifier une occurrence générée ne doit pas lui faire perdre son
      // rattachement à la règle qui l'a créée.
      ...(editing?.recurringId ? { recurringId: editing.recurringId, fixed: true } : {}),
    };

    await expenses.put(record);
    if (draft.merchantId) await merchants.touch(draft.merchantId);

    app.vibrate(10);
    app.savedFlash();

    if (editing) {
      app.navigate('history');
      app.toast(isIncome ? 'Rentrée modifiée.' : 'Dépense modifiée.');
      return;
    }

    app.navigate('month');
    app.toast(isIncome
      ? `+ ${formatEuros(cents)} enregistrés.`
      : `${formatEuros(cents)} enregistrés.`);

    // Apprentissage : au 2e usage d'un libellé inconnu, proposer de l'ajouter.
    // Sans objet pour une rentrée (pas de commerçant, pas de catégorie).
    if (!isIncome) await maybeLearn(label, categoryId, cents, merchantList, app);
  }

  // --- Transformer en charge fixe (mode édition) ---
  root.querySelector('#make-recurring')?.addEventListener('click', async () => {
    const day = Number(editing.date.slice(8, 10));
    const ok = await app.confirm({
      title: 'En faire une charge fixe ?',
      message: `« ${editing.label} » (${formatEuros(editing.amount)}) sera recréée `
        + `automatiquement le ${day} de chaque mois. Ce mois-ci n'est pas dupliqué. `
        + 'Modifiable ensuite dans Réglages.',
      confirmLabel: 'Créer la charge fixe',
    });
    if (!ok) return;
    const rule = ruleFromExpense(editing, day);
    await recurring.put(rule);
    // La dépense d'origine devient l'occurrence du mois : on la rattache à la
    // règle, sinon elle resterait comptée comme variable.
    await expenses.put({ ...editing, recurringId: rule.id, fixed: true });
    app.navigate('settings');
    app.toast('Charge fixe créée.');
  });

  // --- Supprimer (mode édition) ---
  root.querySelector('#delete')?.addEventListener('click', async () => {
    const ok = await app.confirm({
      title: 'Supprimer cette dépense ?',
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    await expenses.delete(editing.id);
    app.navigate('history');
    app.toast('Dépense supprimée.');
  });

  // Focus initial sur le montant (sauf en édition où tout est déjà rempli).
  if (!editing) {
    requestAnimationFrame(() => {
      amountEl.focus();
      amountEl.select?.();
    });
  }
}

// Au 2e usage d'un libellé absent de la bibliothèque, proposer l'ajout.
async function maybeLearn(label, categoryId, amount, merchantList, app) {
  const norm = label.trim().toLowerCase();
  const known = merchantList.some((m) => m.name.trim().toLowerCase() === norm);
  if (known) return;

  const all = await expenses.all();
  const count = all.filter((e) => (e.label || '').trim().toLowerCase() === norm).length;
  if (count !== 2) return;

  app.toast(`« ${label} » revient souvent.`, {
    actionLabel: 'Ajouter',
    onAction: async () => {
      await merchants.put({
        id: uuid(),
        name: label,
        defaultCategoryId: categoryId,
        defaultAmount: null,
        useCount: 2,
        lastUsedAt: Date.now(),
      });
      app.toast('Ajouté à la bibliothèque.');
    },
  });
}

function defaultCategoryId(cats) {
  const courses = cats.find((c) => c.name === 'Courses');
  return (courses || cats[0])?.id || null;
}

function fallbackLabel(cats, categoryId) {
  const cat = cats.find((c) => c.id === categoryId);
  return cat ? cat.name : 'Dépense';
}

function catButton(c, selectedId) {
  return `<button type="button" data-id="${c.id}" aria-pressed="${c.id === selectedId}">
    <span class="ico" aria-hidden="true">${c.icon}</span>
    <span class="name">${escapeHtml(c.name)}</span>
  </button>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
