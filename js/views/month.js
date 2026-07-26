// views/month.js — écran d'accueil « Ce mois ».
// Objectif : savoir en 2 secondes s'il reste de l'argent, voir un
// dépassement sans le chercher.

import { categories, expenses, monthlyBudgets, settings } from '../db.js';
import { summarizeMonth, planMonth } from '../budget.js';
import { formatEuros, formatEurosCompact } from '../money.js';
import { onSyncStatus, statusLabel, getStatus as getSyncStatus } from '../sync.js';

const DAY_MS = 24 * 60 * 60 * 1000;
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

  // Le plan : ce que devient le revenu une fois l'épargne réservée.
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const plan = planMonth({
    income,
    savingsTarget: cfg?.savingsTarget ?? 0,
    totalBudget: summary.totalBudget,
    totalSpent: summary.totalSpent,
    dayOfMonth: isCurrent ? now.getDate() : null,
    daysInMonth,
  });

  root.innerHTML = `
    <header class="screen-head">
      <div class="month-nav">
        <button class="icon-btn" data-act="prev" aria-label="Mois précédent">‹</button>
        <span class="label">${app.monthLabel(year, month)}</span>
        <button class="icon-btn" data-act="next" aria-label="Mois suivant">›</button>
      </div>
      <div class="head-right">
        <span id="sync-chip" class="sync-chip" hidden></span>
        <button class="icon-btn" data-act="settings" aria-label="Réglages">⚙️</button>
      </div>
    </header>

    <div id="alert-slot"></div>

    ${planCard(plan, summary)}

    <div class="cat-list">
      ${summary.categories.map((c) => catCard(c)).join('')}
    </div>

    ${spendingChart(monthExpenses, summary.totalBudget, year, month)}

    <div id="backup-slot"></div>
  `;

  // Alerte prioritaire : Restau/livraison à ≥ 75 %.
  renderRestauAlert(root.querySelector('#alert-slot'), summary);

  // Rappel de sauvegarde discret (> 30 jours sans export), masqué si la
  // synchronisation GitHub s'en charge déjà.
  renderBackupNudge(root.querySelector('#backup-slot'), cfg, app);

  // Pastille d'état de synchro, discrète tant que tout va bien.
  bindSyncChip(root.querySelector('#sync-chip'), app);

  // Événements.
  root.querySelector('[data-act="prev"]').addEventListener('click', () => app.shiftMonth(-1));
  root.querySelector('[data-act="next"]').addEventListener('click', () => app.shiftMonth(1));
  root.querySelector('[data-act="settings"]').addEventListener('click', () => app.navigate('settings'));
  root.querySelector('[data-act="set-income"]')
    ?.addEventListener('click', () => app.navigate('settings'));
}

// --- Carte « plan du mois » -------------------------------------------------
// Un seul écran doit répondre à : « combien puis-je encore sortir aujourd'hui
// sans casser mon épargne ? ». C'est `leftToSpend`, en gros, et le détail
// dessous sous forme de barre : dépensé | reste | épargne, qui somment au
// revenu. Quand on mord sur l'épargne, son segment rétrécit à vue d'œil.

function planCard(plan, summary) {
  if (plan.status === 'no-income') {
    return `
      <section class="card remaining">
        <div class="caption">Dépensé ce mois</div>
        <div class="amount">${formatEurosCompact(summary.totalSpent)}</div>
        <div class="sub">Renseigne ton revenu et ton objectif d'épargne
          pour voir ce qu'il te reste à dépenser.</div>
        <button class="btn btn-secondary btn-block mt-4" data-act="set-income">
          Régler revenu et épargne
        </button>
      </section>`;
  }

  const pct = (cents) => (plan.income > 0 ? (cents / plan.income) * 100 : 0);
  const seg = plan.segments;
  const negative = plan.leftToSpend < 0;

  // « −38 €/jour » ne veut rien dire : une fois l'enveloppe dépassée, le
  // rythme quotidien n'est plus la bonne information, le montant en trop si.
  const plural = plan.daysLeft > 1 ? 's' : '';
  const perDayLine = plan.leftToSpend <= 0
    ? `${formatEuros(plan.spent)} dépensés sur ${formatEuros(plan.spendable)} dépensables`
    : plan.daysLeft > 0
      ? `soit ${formatEuros(plan.perDay)}/jour sur ${plan.daysLeft} jour${plural} restant${plural}`
      : `${formatEuros(plan.spent)} dépensés sur ${formatEuros(plan.spendable)} dépensables`;

  const verdict = planVerdict(plan);

  return `
    <section class="card remaining plan-card">
      <div class="caption">Reste à dépenser</div>
      <div class="amount ${negative ? 'is-negative' : ''}">
        ${formatEurosCompact(plan.leftToSpend)}
      </div>
      <div class="sub">${perDayLine}</div>

      <div class="plan-bar" role="img"
           aria-label="${formatEuros(seg.spent)} dépensés, ${formatEuros(seg.left)} restants, ${formatEuros(seg.savings)} d'épargne sur ${formatEuros(plan.income)}">
        <span class="seg seg-spent" style="width:${pct(seg.spent).toFixed(2)}%"></span>
        <span class="seg seg-left" style="width:${pct(seg.left).toFixed(2)}%"></span>
        <span class="seg seg-savings" style="width:${pct(seg.savings).toFixed(2)}%"></span>
      </div>

      <ul class="plan-legend">
        <li><i class="dot seg-spent"></i>Dépensé<b>${formatEuros(seg.spent)}</b></li>
        <li><i class="dot seg-left"></i>Reste<b>${formatEuros(seg.left)}</b></li>
        <li><i class="dot seg-savings"></i>Épargne<b>${formatEuros(seg.savings)}</b></li>
      </ul>

      <div class="plan-verdict ${verdict.stateClass}">
        <span aria-hidden="true">${verdict.icon}</span><span>${verdict.text}</span>
      </div>
      ${planAllocationNote(plan)}
    </section>`;
}

function planVerdict(plan) {
  const target = formatEuros(plan.savingsTarget);
  switch (plan.status) {
    case 'over-income':
      return {
        icon: '🚨',
        stateClass: 'state-red',
        text: `Tu as dépensé ${formatEuros(plan.overIncome)} de plus que ton revenu — `
          + `objectif d'épargne perdu, et tu puises ailleurs.`,
      };
    case 'savings-hit':
      return {
        icon: '⚠️',
        stateClass: 'state-red',
        text: `Épargne entamée de ${formatEuros(plan.savingsAtRisk)} : il ne reste que `
          + `${formatEuros(plan.savingsReachable)} des ${target} visés.`,
      };
    case 'tight':
      return {
        icon: '⚠️',
        stateClass: 'state-orange',
        text: plan.savingsTarget > 0
          ? `Marge très fine avant d'entamer tes ${target} d'épargne.`
          : 'Marge très fine avant de dépasser ton revenu.',
      };
    default:
      return {
        icon: '✓',
        stateClass: 'state-green',
        text: plan.savingsTarget > 0
          ? `Objectif d'épargne de ${target} préservé.`
          : `Dans ton revenu.`,
      };
  }
}

// Cohérence du PLAN lui-même, indépendante de ce qui a été dépensé : la somme
// des budgets par catégorie tient-elle dans le revenu moins l'épargne ? Un
// dépassement ici se voit dès le 1er du mois, avant la moindre dépense.
function planAllocationNote(plan) {
  if (plan.savingsTarget === 0 && plan.allocated === 0) return '';

  if (plan.overcommitted) {
    return `
      <div class="plan-note state-orange">
        Tes budgets totalisent ${formatEuros(plan.allocated)}, soit
        <strong>${formatEuros(-plan.unallocated)} de trop</strong> pour garder
        ${formatEuros(plan.savingsTarget)} d'épargne. Baisse un budget, ou l'objectif.
      </div>`;
  }
  if (plan.unallocated > 0) {
    return `
      <div class="plan-note">
        ${formatEuros(plan.unallocated)} non affectés à une catégorie.
      </div>`;
  }
  return '';
}

// --- Pastille de synchronisation --------------------------------------------

function bindSyncChip(chip, app) {
  if (!chip) return;
  const off = onSyncStatus((s) => {
    // Rien à signaler quand c'est à jour : on ne meuble pas l'écran.
    if (s.state === 'disabled' || s.state === 'idle' || s.state === 'ok') {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.textContent = SYNC_ICON[s.state] ?? '↻';
    chip.className = `sync-chip is-${s.state}`;
    chip.title = statusLabel(s);
    chip.setAttribute('aria-label', `Synchronisation : ${statusLabel(s)}`);
  });
  // La vue est jetée et re-rendue en permanence : sans ça, on empilerait des
  // abonnements pointant vers des nœuds détachés.
  app.onCleanup(off);
  chip.addEventListener('click', () => app.navigate('settings'));
}

const SYNC_ICON = {
  syncing: '↻',
  pending: '•',
  offline: '⚡',
  error: '!',
  conflict: '⚠',
};

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
  const reminderDays = cfg?.reminderDays ?? 30;
  if (reminderDays === 0) return; // rappel désactivé
  // La sync GitHub sauvegarde toute seule : harceler pour un export manuel
  // n'aurait plus de sens.
  if (getSyncStatus().state !== 'disabled') return;

  const last = cfg?.lastExportAt ?? null;
  const stale = last === null || Date.now() - last > reminderDays * DAY_MS;
  if (!stale) return;

  slot.innerHTML = `
    <div class="backup-nudge">
      <span aria-hidden="true">💾</span>
      <span>${last === null
        ? 'Pense à faire une sauvegarde.'
        : `Aucune sauvegarde depuis plus de ${reminderDays} jours.`}</span>
      <button data-act="backup">Sauvegarder</button>
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
