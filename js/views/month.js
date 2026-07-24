// views/month.js — écran d'accueil « Ce mois ».
// Objectif : savoir en 2 secondes s'il reste de l'argent, voir un
// dépassement sans le chercher.

import { categories, expenses, monthlyBudgets, settings } from '../db.js';
import { summarizeMonth, budgetLevel } from '../budget.js';
import { formatEuros, formatEurosCompact } from '../money.js';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const LEVEL_LABEL = {
  green: 'dans le budget',
  neutral: 'à surveiller',
  orange: 'presque atteint',
  red: 'dépassé',
};

export async function render(root, app) {
  const { year, month } = app.state;

  const [cats, monthExpenses, budgets, cfg] = await Promise.all([
    categories.active(),
    expenses.forMonth(year, month),
    monthlyBudgets.ensure(year, month),
    settings.get(),
  ]);

  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b.amount]));
  const income = cfg?.monthlyIncome ?? 0;

  const summary = summarizeMonth({
    categories: cats,
    budgetForCategory: (id) => budgetMap.get(id) ?? 0,
    expenses: monthExpenses,
    income,
  });

  root.innerHTML = `
    <header class="screen-head">
      <div class="month-nav">
        <button class="icon-btn" data-act="prev" aria-label="Mois précédent">‹</button>
        <span class="label">${app.monthLabel(year, month)}</span>
        <button class="icon-btn" data-act="next" aria-label="Mois suivant">›</button>
      </div>
      <button class="icon-btn" data-act="settings" aria-label="Réglages">⚙️</button>
    </header>

    <div id="alert-slot"></div>

    <section class="card remaining">
      <div class="caption">Reste disponible</div>
      <div class="amount ${summary.remaining < 0 ? 'is-negative' : ''}">
        ${formatEurosCompact(summary.remaining)}
      </div>
      <div class="sub">
        ${formatEuros(summary.totalSpent)} dépensés sur ${formatEuros(income)}
      </div>
      <div class="bar global-progress ${globalLevel(summary)}">
        <span style="width:${Math.round(summary.ratio * 100)}%"></span>
      </div>
    </section>

    <div class="cat-list">
      ${summary.categories.map((c) => catCard(c)).join('')}
    </div>

    ${spendingChart(monthExpenses, summary.totalBudget, year, month)}

    <div id="backup-slot"></div>
  `;

  // Alerte prioritaire : Restau/livraison à ≥ 75 %.
  renderRestauAlert(root.querySelector('#alert-slot'), summary);

  // Rappel de sauvegarde discret (> 30 jours sans export).
  renderBackupNudge(root.querySelector('#backup-slot'), cfg, app);

  // Événements.
  root.querySelector('[data-act="prev"]').addEventListener('click', () => app.shiftMonth(-1));
  root.querySelector('[data-act="next"]').addEventListener('click', () => app.shiftMonth(1));
  root.querySelector('[data-act="settings"]').addEventListener('click', () => app.navigate('settings'));
}

function globalLevel(summary) {
  return `state-${budgetLevel(summary.totalSpent, summary.totalBudget)}`;
}

function catCard(c) {
  const pct = Math.round((c.budget > 0 ? c.spent / c.budget : (c.spent > 0 ? 1 : 0)) * 100);
  const stateClass = `state-${c.level}`;
  const overText = c.over > 0
    ? `<span class="cat-over ${stateClass}">dépassé de ${formatEuros(c.over)}</span>`
    : `<span class="${stateClass}">${LEVEL_LABEL[c.level]}</span>`;

  return `
    <article class="card cat-card">
      <div class="cat-icon" style="background:${hexToSoft(c.category.color)}">
        ${c.category.icon}
      </div>
      <div class="cat-name">${escapeHtml(c.category.name)}</div>
      <div class="cat-figures">
        <strong>${formatEuros(c.spent)}</strong> / ${formatEuros(c.budget)}
      </div>
      <div class="bar ${stateClass}">
        <span style="width:${Math.min(pct, 100)}%"></span>
      </div>
      <div class="cat-status">
        ${overText}
        <span class="${stateClass}">${pct}%</span>
      </div>
    </article>`;
}

function renderRestauAlert(slot, summary) {
  const restau = summary.categories.find((c) => c.category.name === 'Restau/livraison');
  if (!restau || restau.budget <= 0) return;
  if (restau.spent / restau.budget < 0.75) return;

  const over = restau.over > 0;
  slot.innerHTML = `
    <div class="alert-banner ${over ? 'is-red' : ''}" role="alert">
      <span class="ico" aria-hidden="true">${over ? '🚨' : '⚠️'}</span>
      <span>
        Restau/livraison : ${formatEuros(restau.spent)} sur ${formatEuros(restau.budget)}
        ${over ? `— dépassé de ${formatEuros(restau.over)}` : '— attention, budget presque atteint'}
      </span>
    </div>`;
}

function renderBackupNudge(slot, cfg, app) {
  const last = cfg?.lastExportAt ?? null;
  const stale = last === null || Date.now() - last > THIRTY_DAYS;
  if (!stale) return;

  slot.innerHTML = `
    <div class="backup-nudge">
      <span aria-hidden="true">💾</span>
      <span>${last === null
        ? 'Pense à exporter une sauvegarde CSV.'
        : 'Aucune sauvegarde depuis plus de 30 jours.'}</span>
      <button data-act="backup">Exporter</button>
    </div>`;
  slot.querySelector('[data-act="backup"]').addEventListener('click', () => app.navigate('settings'));
}

// Graphe mensuel léger : dépense cumulée du mois vs. rythme idéal du budget.
// SVG pur, aucune bibliothèque. La ligne cumulée est tracée dans l'accent
// (neutre) ; le vert/orange/rouge reste réservé au libellé d'état.
function spendingChart(monthExpenses, totalBudget, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();

  // Cumul par jour.
  const cumul = new Array(daysInMonth + 1).fill(0);
  const perDay = new Array(daysInMonth + 1).fill(0);
  for (const e of monthExpenses) {
    const d = Number(e.date.slice(8, 10));
    if (d >= 1 && d <= daysInMonth) perDay[d] += e.amount;
  }
  let run = 0;
  for (let d = 1; d <= daysInMonth; d++) { run += perDay[d]; cumul[d] = run; }

  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const lastDay = isCurrent ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

  // Géométrie (viewBox fixe, rendu responsive via width:100%).
  const W = 320;
  const H = 132;
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxY = Math.max(totalBudget, cumul[daysInMonth], 1) * 1.08;
  const x = (day) => padL + ((day - 1) / (daysInMonth - 1)) * innerW;
  const y = (v) => padT + (1 - v / maxY) * innerH;
  const yBase = y(0);

  // Ligne réelle (jusqu'à aujourd'hui pour le mois courant).
  const pts = [];
  for (let d = 1; d <= lastDay; d++) pts.push(`${x(d).toFixed(1)},${y(cumul[d]).toFixed(1)}`);
  const linePath = pts.length ? `M${pts.join(' L')}` : '';
  const areaPath = pts.length
    ? `M${x(1).toFixed(1)},${yBase.toFixed(1)} L${pts.join(' L')} L${x(lastDay).toFixed(1)},${yBase.toFixed(1)} Z`
    : '';

  // Ligne de rythme idéal (0 → budget total sur le mois).
  const paceLine = totalBudget > 0
    ? `<line x1="${x(1).toFixed(1)}" y1="${yBase.toFixed(1)}"
             x2="${x(daysInMonth).toFixed(1)}" y2="${y(totalBudget).toFixed(1)}"
             stroke="var(--text-faint)" stroke-width="1.5"
             stroke-dasharray="3 3" fill="none" />`
    : '';

  // Marqueur « aujourd'hui ».
  const marker = isCurrent
    ? `<line x1="${x(lastDay).toFixed(1)}" y1="${padT}" x2="${x(lastDay).toFixed(1)}" y2="${yBase.toFixed(1)}"
             stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2 2" />
       <circle cx="${x(lastDay).toFixed(1)}" cy="${y(cumul[lastDay]).toFixed(1)}" r="3.5"
               fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5" />`
    : '';

  // Légende d'état (texte + couleur, jamais couleur seule).
  const { caption, stateClass, icon } = chartCaption({
    cumulNow: cumul[lastDay], totalBudget, lastDay, daysInMonth, isCurrent,
  });

  return `
    <section class="card spend-chart">
      <div class="chart-title">Rythme du mois</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dépense cumulée du mois">
        <line x1="${padL}" y1="${yBase.toFixed(1)}" x2="${W - padR}" y2="${yBase.toFixed(1)}"
              stroke="var(--border)" stroke-width="1" />
        ${paceLine}
        ${areaPath ? `<path d="${areaPath}" fill="var(--accent-soft)" />` : ''}
        ${linePath ? `<path d="${linePath}" fill="none" stroke="var(--accent)"
              stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />` : ''}
        ${marker}
        <text x="${padL}" y="${H - 6}" font-size="9" fill="var(--text-faint)">1</text>
        <text x="${W - padR}" y="${H - 6}" font-size="9" fill="var(--text-faint)"
              text-anchor="end">${daysInMonth}</text>
      </svg>
      <div class="chart-caption ${stateClass}">
        <span aria-hidden="true">${icon}</span><span>${caption}</span>
      </div>
      <div class="chart-legend">
        <span><span class="swatch" style="background:var(--accent)"></span>Dépensé</span>
        ${totalBudget > 0
          ? '<span><span class="swatch" style="background:var(--text-faint)"></span>Rythme du budget</span>'
          : ''}
      </div>
    </section>`;
}

function chartCaption({ cumulNow, totalBudget, lastDay, daysInMonth, isCurrent }) {
  if (totalBudget <= 0) {
    return { caption: 'Aucun budget défini ce mois-ci.', stateClass: 'state-neutral', icon: '•' };
  }
  if (!isCurrent) {
    const over = cumulNow > totalBudget;
    return {
      caption: `${formatEuros(cumulNow)} dépensés sur ${formatEuros(totalBudget)} de budget.`,
      stateClass: over ? 'state-red' : 'state-green',
      icon: over ? '↑' : '✓',
    };
  }
  // Mois courant : cumul réel vs. rythme attendu à cette date.
  const pace = totalBudget * (lastDay / daysInMonth);
  const projected = cumulNow / (lastDay / daysInMonth); // extrapolation fin de mois
  if (cumulNow > pace * 1.05) {
    return {
      caption: `Plus vite que le budget — à ce rythme, ~${formatEuros(projected)} en fin de mois.`,
      stateClass: 'state-orange',
      icon: '↑',
    };
  }
  if (cumulNow < pace * 0.95) {
    return { caption: 'En dessous du rythme prévu. Marge confortable.', stateClass: 'state-green', icon: '↓' };
  }
  return { caption: 'Dans le rythme du budget.', stateClass: 'state-neutral', icon: '→' };
}

// Teinte douce à partir d'une couleur de catégorie (fond d'icône).
function hexToSoft(hex) {
  return `color-mix(in srgb, ${hex} 16%, var(--surface-2))`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
