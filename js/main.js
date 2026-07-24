// main.js — point d'entrée. Amorçage, routage par onglets (hashchange) et
// helpers partagés (toast, flash, confirmation modale) fournis aux vues via
// l'objet `app`. Aucune logique métier ici : elle vit dans budget.js.

import { openDB } from './db.js';
import { seedIfEmpty } from './seed.js';

import * as monthView from './views/month.js';
import * as addView from './views/add.js';
import * as historyView from './views/history.js';
import * as settingsView from './views/settings.js';

const ROUTES = {
  month: monthView,
  add: addView,
  history: historyView,
  settings: settingsView,
};

const viewEl = document.getElementById('view');
const toastEl = document.getElementById('toast');
const flashEl = document.getElementById('saved-flash');
const backdropEl = document.getElementById('sheet-backdrop');
const sheetEl = document.getElementById('sheet');

// Mois affiché (par défaut : mois courant). 1-12.
const today = new Date();
const state = {
  year: today.getFullYear(),
  month: today.getMonth() + 1,
};

let currentRoute = 'month';
let pendingParams = {}; // params transmis à la prochaine vue (ex. édition)
let toastTimer = null;

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const app = {
  state,

  /** Libellé « septembre 2026 ». */
  monthLabel(year = state.year, month = state.month) {
    return `${MONTHS_FR[month - 1]} ${year}`;
  },

  isCurrentMonth() {
    const n = new Date();
    return state.year === n.getFullYear() && state.month === n.getMonth() + 1;
  },

  /** Change le mois affiché de ±1 et rafraîchit. */
  shiftMonth(delta) {
    let m = state.month + delta;
    let y = state.year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    state.month = m;
    state.year = y;
    this.refresh();
  },

  /** Va vers une route (onglet ou écran). params transmis à la vue. */
  navigate(route, params = {}) {
    pendingParams = params;
    if (location.hash === `#${route}`) render(route);
    else location.hash = `#${route}`;
  },

  /** Re-rend la route active (après une écriture en base). */
  refresh() {
    render(currentRoute, { keepParams: true });
  },

  /** Petit toast. options : { actionLabel, onAction, duration }. */
  toast(message, { actionLabel, onAction, duration = 2200 } = {}) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    if (actionLabel && onAction) {
      const btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        this.hideToast();
        onAction();
      });
      toastEl.appendChild(btn);
      duration = Math.max(duration, 4500);
    }
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => this.hideToast(), duration);
  },

  hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove('show');
  },

  /** Flash « ✓ » bref après enregistrement. */
  savedFlash() {
    flashEl.classList.add('show');
    setTimeout(() => flashEl.classList.remove('show'), 650);
  },

  /** Vibration courte. Sans effet sur iOS : dégradation silencieuse. */
  vibrate(ms = 10) {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* ignoré */
    }
  },

  /**
   * Confirmation modale (remplace window.confirm, qui bloque le thread).
   * @returns {Promise<boolean>}
   */
  confirm({ title, message = '', confirmLabel = 'Confirmer', danger = false }) {
    return new Promise((resolve) => {
      sheetEl.innerHTML = '';
      const h = document.createElement('h2');
      h.textContent = title;
      sheetEl.appendChild(h);

      if (message) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = message;
        sheetEl.appendChild(p);
      }

      const actions = document.createElement('div');
      actions.className = 'sheet-actions';

      const cancel = document.createElement('button');
      cancel.className = 'btn btn-secondary';
      cancel.textContent = 'Annuler';

      const ok = document.createElement('button');
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      ok.textContent = confirmLabel;

      actions.append(cancel, ok);
      sheetEl.appendChild(actions);

      const close = (result) => {
        this.closeSheet();
        resolve(result);
      };
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      backdropEl._onBackdrop = () => close(false);

      this.openSheet();
    });
  },

  /** Ouvre une feuille modale déjà remplie (sheetEl). */
  openSheet() {
    backdropEl.hidden = false;
  },

  closeSheet() {
    backdropEl.hidden = true;
    backdropEl._onBackdrop = null;
    sheetEl.innerHTML = '';
  },

  /** Accès brut au nœud de la feuille pour les vues qui construisent leur UI. */
  get sheetEl() {
    return sheetEl;
  },
};

// Fermer la feuille en tapant le fond.
backdropEl.addEventListener('click', (e) => {
  if (e.target === backdropEl && backdropEl._onBackdrop) backdropEl._onBackdrop();
});

// --- Routage ----------------------------------------------------------------

function setActiveTab(route) {
  document.querySelectorAll('.tabbar button').forEach((btn) => {
    btn.setAttribute('aria-current', String(btn.dataset.route === route));
  });
}

async function render(route, { keepParams = false } = {}) {
  const view = ROUTES[route] || ROUTES.month;
  currentRoute = ROUTES[route] ? route : 'month';
  setActiveTab(currentRoute);

  const params = pendingParams;
  if (!keepParams) pendingParams = {};

  viewEl.scrollTop = 0;
  viewEl.innerHTML = '';
  try {
    await view.render(viewEl, app, params);
  } catch (err) {
    console.error('Erreur de rendu de la vue', route, err);
    viewEl.innerHTML = `<div class="empty"><span class="emoji">⚠️</span>
      Une erreur est survenue.<br><span class="muted">${err.message}</span></div>`;
  }
}

function onHashChange() {
  const route = location.hash.replace(/^#/, '') || 'month';
  render(route);
}

// --- Démarrage --------------------------------------------------------------

async function boot() {
  viewEl.innerHTML = '<div class="empty"><span class="emoji">⏳</span>Chargement…</div>';
  await openDB();
  await seedIfEmpty({ year: state.year, month: state.month });

  window.addEventListener('hashchange', onHashChange);

  document.querySelectorAll('.tabbar button').forEach((btn) => {
    btn.addEventListener('click', () => app.navigate(btn.dataset.route));
  });

  onHashChange();

  // Service worker (mode hors ligne). Ignoré si non supporté / non servi en
  // HTTPS/localhost.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('Service worker non enregistré :', e.message);
    });
  }
}

boot();
