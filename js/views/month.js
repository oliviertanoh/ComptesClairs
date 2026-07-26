// views/month.js — écran d'accueil « Ce mois ».
// Objectif : savoir en 2 secondes s'il reste de l'argent, voir un
// dépassement sans le chercher.

import { categories, expenses, monthlyBudgets, monthlyPlan, settings } from '../db.js';
import { summarizeMonth, planMonth, sumAmounts } from '../budget.js';
import { materializeMonth } from '../recurring.js';
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

  // Les charges fixes du mois sont créées avant toute lecture : sinon le
  // premier affichage du mois montrerait un « reste » qui ignore le loyer.
  await materializeMonth(year, month);

  const [cats, monthEntries, budgets, monthPlan, cfg] = await Promise.all([
    categories.active(),
    expenses.forMonth(year, month),
    monthlyBudgets.ensure(year, month),
    monthlyPlan.ensure(year, month),
    settings.get(),
  ]);

  // Les rentrées d'argent (remboursement, prime) ne sont pas des dépenses :
  // elles gonflent le revenu du mois, jamais un budget de catégorie.
  const spends = monthEntries.filter((e) => e.kind !== 'income');
  const extraIncome = sumAmounts(monthEntries.filter((e) => e.kind === 'income'));
  const fixedSpent = sumAmounts(spends.filter((e) => e.fixed));
  const variableSpent = sumAmounts(spends.filter((e) => !e.fixed));

  const income = (monthPlan?.income ?? 0) + extraIncome;

  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b.amount]));
  const summary = summarizeMonth({
    categories: cats,
    budgetForCategory: (id) => budgetMap.get(id) ?? 0,
    expenses: spends,
    income,
  });

  // Le plan : ce que devient le revenu une fois l'épargne réservée et les
  // charges fixes déduites.
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const plan = planMonth({
    income,
    savingsTarget: monthPlan?.savingsTarget ?? 0,
    totalBudget: summary.totalBudget,
    fixedSpent,
    variableSpent,
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
      </div>
    </header>

    <div id="alert-slot"></div>

    ${planCard(plan, summary)}

    ${extraIncome > 0 ? `
      <p class="muted center mb-4">
        + ${formatEuros(extraIncome)} de rentrées ce mois (remboursements, primes)
      </p>` : ''}

    <div class="cat-list">
      ${summary.categories.map((c) => catCard(c)).join('')}
    </div>

    ${spendingChart(spends, plan, year, month)}

    <div id="backup-slot"></div>
  `;

  // Alerte prioritaire sur les catégories surveillées.
  renderWatchAlerts(root.querySelector('#alert-slot'), summary);

  // Rappel de sauvegarde discret (> 30 jours sans export), masqué si la
  // synchronisation GitHub s'en charge déjà.
  renderBackupNudge(root.querySelector('#backup-slot'), cfg, app);

  // Pastille d'état de synchro, discrète tant que tout va bien.
  bindSyncChip(root.querySelector('#sync-chip'), app);

  // Événements.
  root.querySelector('[data-act="prev"]').addEventListener('click', () => app.shiftMonth(-1));
  root.querySelector('[data-act="next"]').addEventListener('click', () => app.shiftMonth(1));
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
           aria-label="Sur ${formatEuros(plan.income)} : ${formatEuros(seg.fixed)} de charges fixes, ${formatEuros(seg.spent)} dépensés, ${formatEuros(seg.left)} restants, ${formatEuros(seg.savings)} d'épargne">
        <span class="seg seg-fixed" style="width:${pct(seg.fixed).toFixed(2)}%"></span>
        <span class="seg seg-spent" style="width:${pct(seg.spent).toFixed(2)}%"></span>
        <span class="seg seg-left" style="width:${pct(seg.left).toFixed(2)}%"></span>
        <span class="seg seg-savings" style="width:${pct(seg.savings).toFixed(2)}%"></span>
      </div>

      <ul class="plan-legend">
        ${seg.fixed > 0
          ? `<li><i class="dot seg-fixed"></i>Charges<b>${formatEuros(seg.fixed)}</b></li>`
          : ''}
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
    case 'fixed-overrun':
      return {
        icon: '🚨',
        stateClass: 'state-red',
        text: `Tes charges fixes (${formatEuros(plan.fixedSpent)}) dépassent à elles `
          + `seules ce que tu peux dépenser. Aucun arbitrage quotidien ne rattrapera `
          + `ça — c'est le loyer, les abonnements ou l'objectif d'épargne qu'il faut revoir.`,
      };
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

// Alertes des catégories surveillées (drapeau `watch` sur la catégorie).
//
// Avant, cette alerte cherchait la catégorie par son nom exact
// « Restau/livraison ». Les réglages permettant de renommer une catégorie,
// la renommer éteignait l'alerte définitivement — sans message ni erreur.
// Le drapeau suit la catégorie quel que soit son nom.
function renderWatchAlerts(slot, summary) {
  const watched = summary.categories
    .filter((c) => c.category.watch && c.budget > 0 && c.spent / c.budget >= 0.75)
    .sort((a, b) => b.ratio - a.ratio);

  if (watched.length === 0) return;

  slot.innerHTML = watched.map((c) => {
    const over = c.over > 0;
    return `
      <div class="alert-banner ${over ? 'is-red' : ''}" role="alert">
        <span class="ico" aria-hidden="true">${over ? '🚨' : '⚠️'}</span>
        <span>
          ${escapeHtml(c.category.name)} : ${formatEuros(c.spent)} sur ${formatEuros(c.budget)}
          ${over ? `— dépassé de ${formatEuros(c.over)}` : '— attention, budget presque atteint'}
        </span>
      </div>`;
  }).join('');
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

// Graphe mensuel léger : dépense cumulée du mois vs. rythme idéal.
// SVG pur, aucune bibliothèque. La ligne cumulée est tracée dans l'accent
// (neutre) ; le vert/orange/rouge reste réservé au libellé d'état.
//
// ── Les charges fixes sont EXCLUES, des deux côtés ─────────────────────────
// Le loyer tombe le 2 : en le comptant, le cumul décollait d'un coup au-dessus
// d'une ligne « idéale » linéaire, et l'app annonçait « plus vite que le
// budget » tous les mois pendant deux semaines. Une alerte qui se déclenche à
// tort systématiquement finit ignorée — donc inutile le jour où elle a raison.
// On compare ce qui se compare : le variable, seul poste où le rythme a un
// sens puisque c'est le seul sur lequel on décide au jour le jour.
function spendingChart(spends, plan, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const variableExpenses = spends.filter((e) => !e.fixed);
  const target = Math.max(plan.variableSpendable, 0);

  // Cumul par jour.
  const cumul = new Array(daysInMonth + 1).fill(0);
  const perDay = new Array(daysInMonth + 1).fill(0);
  for (const e of variableExpenses) {
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

  const maxY = Math.max(target, cumul[daysInMonth], 1) * 1.08;
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

  // Ligne de rythme idéal (0 → enveloppe variable, étalée sur le mois).
  const paceLine = target > 0
    ? `<line x1="${x(1).toFixed(1)}" y1="${yBase.toFixed(1)}"
             x2="${x(daysInMonth).toFixed(1)}" y2="${y(target).toFixed(1)}"
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
    cumulNow: cumul[lastDay], target, lastDay, daysInMonth, isCurrent,
  });

  return `
    <section class="card spend-chart">
      <div class="chart-title">Rythme du mois <span class="muted">— hors charges fixes</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Dépenses variables cumulées du mois">
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
        <span><span class="swatch" style="background:var(--accent)"></span>Dépenses variables</span>
        ${target > 0
          ? '<span><span class="swatch" style="background:var(--text-faint)"></span>Rythme cible</span>'
          : ''}
      </div>
    </section>`;
}

function chartCaption({ cumulNow, target, lastDay, daysInMonth, isCurrent }) {
  if (target <= 0) {
    return {
      caption: "Aucune enveloppe variable ce mois-ci (revenu ou charges à renseigner).",
      stateClass: 'state-neutral',
      icon: '•',
    };
  }
  if (!isCurrent) {
    const over = cumulNow > target;
    return {
      caption: `${formatEuros(cumulNow)} de variable sur ${formatEuros(target)} disponibles.`,
      stateClass: over ? 'state-red' : 'state-green',
      icon: over ? '↑' : '✓',
    };
  }
  // Mois courant : cumul réel vs. rythme attendu à cette date.
  const pace = target * (lastDay / daysInMonth);
  const projected = cumulNow / (lastDay / daysInMonth); // extrapolation fin de mois
  if (cumulNow > pace * 1.05) {
    return {
      caption: `Plus vite que prévu — à ce rythme, ~${formatEuros(projected)} de variable en fin de mois.`,
      stateClass: 'state-orange',
      icon: '↑',
    };
  }
  if (cumulNow < pace * 0.95) {
    return { caption: 'En dessous du rythme prévu. Marge confortable.', stateClass: 'state-green', icon: '↓' };
  }
  return { caption: 'Dans le rythme.', stateClass: 'state-neutral', icon: '→' };
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
