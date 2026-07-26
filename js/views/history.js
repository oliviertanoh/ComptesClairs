// views/history.js — liste des dépenses groupées par jour.
// Recherche, filtre catégorie + mois, balayer pour supprimer, toucher
// pour modifier.

import { categories, expenses } from '../db.js';
import { formatEuros } from '../money.js';
import { sumAmounts } from '../budget.js';

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Filtres conservés le temps de la session (réinitialisés au reload).
const filters = { q: '', categoryId: '', month: '' };

export async function render(root, app) {
  const [cats, all] = await Promise.all([categories.all(), expenses.all()]);
  const catById = new Map(cats.map((c) => [c.id, c]));

  // Mois présents dans les données (clé "YYYY-MM"), plus récent d'abord.
  const monthKeys = [...new Set(all.map((e) => e.date.slice(0, 7)))]
    .sort()
    .reverse();

  root.innerHTML = `
    <header class="screen-head">
      <h1>Historique</h1>
    </header>

    <div class="filters">
      <input type="search" id="f-q" placeholder="Rechercher un libellé…"
             value="${escapeAttr(filters.q)}">
      <select id="f-cat">
        <option value="">Toutes catégories</option>
        ${cats.map((c) => `<option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>
          ${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <select id="f-month">
        <option value="">Tous les mois</option>
        ${monthKeys.map((k) => `<option value="${k}" ${filters.month === k ? 'selected' : ''}>
          ${monthLabelFromKey(k)}</option>`).join('')}
      </select>
    </div>

    <div id="list"></div>
  `;

  const listEl = root.querySelector('#list');

  function apply() {
    const q = filters.q.trim().toLowerCase();
    let rows = all.filter((e) => {
      if (filters.categoryId && e.categoryId !== filters.categoryId) return false;
      if (filters.month && e.date.slice(0, 7) !== filters.month) return false;
      if (q && !(e.label || '').toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    renderList(listEl, rows, catById, app);
  }

  root.querySelector('#f-q').addEventListener('input', (e) => { filters.q = e.target.value; apply(); });
  root.querySelector('#f-cat').addEventListener('change', (e) => { filters.categoryId = e.target.value; apply(); });
  root.querySelector('#f-month').addEventListener('change', (e) => { filters.month = e.target.value; apply(); });

  apply();
}

function renderList(listEl, rows, catById, app) {
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty"><span class="emoji">🧾</span>
      Aucune dépense.</div>`;
    return;
  }

  // Groupement par jour.
  const groups = new Map();
  for (const e of rows) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }

  listEl.innerHTML = [...groups.entries()].map(([date, items]) => `
    <section class="day-group">
      <div class="day-head">
        <span class="day-label">${dayLabel(date)}</span>
        <span class="day-total">${formatEuros(dayTotal(items))}</span>
      </div>
      ${items.map((e) => expenseRow(e, catById)).join('')}
    </section>
  `).join('');

  wireRows(listEl, app);
}

// Total du jour = ce qui est SORTI. Une rentrée du même jour ne vient pas
// diminuer le total dépensé (ce sont deux mouvements distincts), elle
// s'affiche sur sa propre ligne.
function dayTotal(items) {
  return sumAmounts(items.filter((e) => e.kind !== 'income'));
}

function expenseRow(e, catById) {
  const cat = catById.get(e.categoryId);
  const isIncome = e.kind === 'income';
  const isFixed = Boolean(e.fixed);

  const sub = isIncome
    ? 'Rentrée'
    : `${cat ? escapeHtml(cat.name) : ''}${isFixed ? ' · charge fixe' : ''}`;

  return `
    <div class="exp-row" data-id="${e.id}">
      <button class="exp-delete" data-act="delete" aria-label="Supprimer">Supprimer</button>
      <div class="exp-body" role="button" tabindex="0">
        <div class="exp-icon">${isIncome ? '💸' : (isFixed ? '🔁' : (cat ? cat.icon : '❓'))}</div>
        <div class="exp-main">
          <div class="exp-label">${escapeHtml(e.label || '—')}</div>
          <div class="exp-sub">${sub}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
        </div>
        <div class="exp-amount ${isIncome ? 'is-income' : ''}">
          ${isIncome ? '+ ' : ''}${formatEuros(e.amount)}
        </div>
      </div>
    </div>`;
}

function wireRows(listEl, app) {
  listEl.querySelectorAll('.exp-row').forEach((row) => {
    const body = row.querySelector('.exp-body');
    const id = row.dataset.id;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let dragging = false;

    body.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      dragging = true;
    }, { passive: true });

    body.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Balayage horizontal dominant uniquement.
      if (Math.abs(dx) > Math.abs(dy) && dx < 0) {
        body.style.transform = `translateX(${Math.max(dx, -88)}px)`;
      }
    }, { passive: true });

    body.addEventListener('touchend', () => {
      dragging = false;
      body.style.transform = '';
      if (dx < -44) row.classList.add('swiped');
      else row.classList.remove('swiped');
    });

    // Clic / tap.
    body.addEventListener('click', () => {
      if (row.classList.contains('swiped')) {
        row.classList.remove('swiped');
        return;
      }
      app.navigate('add', { editId: id });
    });

    // Suppression avec confirmation.
    row.querySelector('[data-act="delete"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await app.confirm({
        title: 'Supprimer cette dépense ?',
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) { row.classList.remove('swiped'); return; }
      await expenses.delete(id);
      app.refresh();
      app.toast('Dépense supprimée.');
    });
  });
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const isYest = date.toDateString() === yest.toDateString();
  if (isToday) return "Aujourd'hui";
  if (isYest) return 'Hier';
  return `${JOURS[date.getDay()]} ${d} ${MOIS[m - 1]}`;
}

function monthLabelFromKey(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MOIS[m - 1]} ${y}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }
