// views/bilan.js — regarder en arrière, pas juste en ce moment.
//
// L'accueil répond à « où j'en suis aujourd'hui ». Cet écran répond aux deux
// questions qu'aucun autre ne traitait :
//   1. « 340 € en restau, c'est beaucoup ? » — sans point de comparaison, un
//      montant ne veut rien dire. On le confronte à la moyenne des mois
//      précédents.
//   2. « est-ce que je tiens mon objectif d'épargne dans la durée ? » — l'app
//      le disait pour le mois en cours et oubliait tout le reste.
//
// Les revenus viennent de `monthlyPlan` (instantané par mois) et non des
// réglages : recalculer l'épargne de mars avec le salaire d'aujourd'hui
// donnerait un historique faux, donc pire qu'aucun historique.

import { categories, expenses, monthlyPlan } from '../db.js';
import { materializeMonth } from '../recurring.js';
import { sumAmounts, average, trend } from '../budget.js';
import { formatEuros, formatEurosCompact } from '../money.js';

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.',
  'août', 'sept.', 'oct.', 'nov.', 'déc.'];

// Nombre de mois précédents servant de référence.
const LOOKBACK = 3;

export async function render(root, app) {
  const { year, month } = app.state;

  // Le Bilan a ses propres flèches de mois : sans ça, un mois atteint depuis
  // ici afficherait des totaux sans ses charges fixes, contredisant l'accueil.
  await materializeMonth(year, month);
  await monthlyPlan.ensure(year, month);

  const [cats, all, plans] = await Promise.all([
    categories.all(),
    expenses.all(),
    monthlyPlan.all(),
  ]);

  const catById = new Map(cats.map((c) => [c.id, c]));
  const planByKey = new Map(plans.map((p) => [p.id, p]));

  // Regroupement par mois, dépenses et rentrées séparées.
  const byMonth = new Map();
  for (const e of all) {
    const key = e.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { spends: [], incomes: [] });
    if (e.kind === 'income') byMonth.get(key).incomes.push(e);
    else byMonth.get(key).spends.push(e);
  }

  const currentKey = keyOf(year, month);
  const previousKeys = previousMonths(year, month, LOOKBACK)
    .filter((k) => byMonth.has(k));

  root.innerHTML = `
    <header class="screen-head">
      <div class="month-nav">
        <button class="icon-btn" data-act="prev" aria-label="Mois précédent">‹</button>
        <span class="label">${app.monthLabel(year, month)}</span>
        <button class="icon-btn" data-act="next" aria-label="Mois suivant">›</button>
      </div>
      <h1 class="head-title">Bilan</h1>
    </header>

    ${savingsSection(byMonth, planByKey, year, month)}
    ${categorySection(byMonth, catById, currentKey, previousKeys)}
  `;

  root.querySelector('[data-act="prev"]').addEventListener('click', () => app.shiftMonth(-1));
  root.querySelector('[data-act="next"]').addEventListener('click', () => app.shiftMonth(1));
}

// --- Épargne réalisée, mois par mois ----------------------------------------

function savingsSection(byMonth, planByKey, year, month) {
  // 6 mois glissants, du plus ancien au plus récent.
  const keys = [...previousMonths(year, month, 5).reverse(), keyOf(year, month)];

  const all = keys.map((key) => {
    const plan = planByKey.get(key);
    const bucket = byMonth.get(key);
    const base = plan?.income ?? 0;
    const income = base + sumAmounts(bucket?.incomes ?? []);
    const spent = sumAmounts(bucket?.spends ?? []);
    const target = plan?.savingsTarget ?? 0;
    // Ce qui reste à la fin : c'est ça, l'épargne réellement réalisée.
    return { key, income, spent, target, saved: income - spent, base };
  });

  // Sans revenu enregistré pour un mois, « épargné » vaudrait −dépensé : le
  // mois apparaîtrait en rouge plein alors qu'on ignore simplement combien
  // il est rentré. On préfère ne pas l'afficher plutôt que mentir.
  const rows = all.filter((r) => r.base > 0);
  const skipped = all.length - rows.length;

  if (rows.length === 0) {
    return `<section class="card bilan-card">
      <div class="chart-title">Épargne réalisée</div>
      <p class="muted center mt-4">
        Pas encore d'historique — le revenu de chaque mois se renseigne dans
        Réglages, et l'app le mémorise mois par mois à partir de maintenant.
      </p>
    </section>`;
  }

  const maxAbs = Math.max(...rows.map((r) => Math.max(Math.abs(r.saved), r.target)), 1);
  const withTarget = rows.filter((r) => r.target > 0);
  const hits = withTarget.filter((r) => r.saved >= r.target).length;

  return `
    <section class="card bilan-card">
      <div class="chart-title">Épargne réalisée</div>

      <div class="savings-bars">
        ${rows.map((r) => {
          const h = Math.round((Math.abs(r.saved) / maxAbs) * 100);
          const targetH = r.target > 0 ? Math.round((r.target / maxAbs) * 100) : null;
          const neg = r.saved < 0;
          const hit = r.target > 0 && r.saved >= r.target;
          return `
            <div class="sb-col">
              <div class="sb-track">
                ${targetH !== null
                  ? `<span class="sb-target" style="bottom:${targetH}%"
                           title="Objectif ${formatEuros(r.target)}"></span>`
                  : ''}
                <span class="sb-fill ${neg ? 'is-neg' : (hit ? 'is-hit' : 'is-miss')}"
                      style="height:${Math.min(h, 100)}%"></span>
              </div>
              <div class="sb-label">${labelOf(r.key)}</div>
              <div class="sb-value ${neg ? 'state-red' : ''}">${formatEurosCompact(r.saved)}</div>
            </div>`;
        }).join('')}
      </div>

      <div class="chart-legend mt-4">
        <span><span class="swatch" style="background:var(--state-green)"></span>Objectif atteint</span>
        <span><span class="swatch" style="background:var(--accent)"></span>En dessous</span>
        <span><span class="swatch swatch-line"></span>Objectif</span>
      </div>

      ${withTarget.length > 0 ? `
        <p class="muted mt-4 center">
          Objectif tenu <strong>${hits} mois sur ${withTarget.length}</strong>.
          Moyenne épargnée : <strong>${formatEuros(average(rows.map((r) => r.saved)))}</strong>/mois.
        </p>` : ''}
      ${skipped > 0 ? `
        <p class="muted mt-4 center">
          ${skipped} mois masqué${skipped > 1 ? 's' : ''} — revenu non renseigné.
        </p>` : ''}
    </section>`;
}

// --- Comparaison par catégorie ----------------------------------------------

function categorySection(byMonth, catById, currentKey, previousKeys) {
  const current = byMonth.get(currentKey)?.spends ?? [];

  if (current.length === 0) {
    return `<section class="card bilan-card mt-4">
      <div class="chart-title">Par catégorie</div>
      <p class="muted center mt-4">Aucune dépense ce mois-ci.</p>
    </section>`;
  }

  const totalsFor = (list) => {
    const m = new Map();
    for (const e of list) m.set(e.categoryId, (m.get(e.categoryId) || 0) + e.amount);
    return m;
  };

  const currentTotals = totalsFor(current);
  const historyTotals = previousKeys.map((k) => totalsFor(byMonth.get(k).spends));

  const rows = [...currentTotals.entries()]
    .map(([categoryId, amount]) => {
      const cat = catById.get(categoryId);
      // Un mois sans dépense dans la catégorie compte comme 0 : l'ignorer
      // gonflerait artificiellement la moyenne de référence.
      const past = historyTotals.map((m) => m.get(categoryId) || 0);
      const reference = average(past);
      return { cat, amount, reference, t: trend(amount, reference) };
    })
    .sort((a, b) => b.amount - a.amount);

  const refLabel = previousKeys.length > 0
    ? `moyenne des ${previousKeys.length} mois précédents`
    : 'aucun historique de comparaison';

  return `
    <section class="card bilan-card mt-4">
      <div class="chart-title">Par catégorie <span class="muted">— vs ${refLabel}</span></div>
      <ul class="bilan-list">
        ${rows.map((r) => `
          <li>
            <span class="bl-icon" aria-hidden="true">${r.cat?.icon ?? '❓'}</span>
            <span class="bl-name">${escapeHtml(r.cat?.name ?? 'Inconnue')}
              <br><span class="muted">réf. ${formatEuros(r.reference)}</span></span>
            <span class="bl-amount">${formatEuros(r.amount)}</span>
            <span class="bl-trend ${trendClass(r.t)}">${trendText(r.t)}</span>
          </li>`).join('')}
      </ul>
    </section>`;
}

// Une hausse de dépense est un signal orange/rouge, une baisse est verte —
// c'est bien un état de budget, pas une décoration.
function trendClass(t) {
  if (t.direction === 'up') return 'state-orange';
  if (t.direction === 'down') return 'state-green';
  return 'state-neutral';
}

function trendText(t) {
  if (t.direction === 'new') return 'nouveau';
  if (t.direction === 'flat') return '≈ stable';
  const pct = Math.round(Math.abs(t.ratio) * 100);
  return `${t.direction === 'up' ? '↑' : '↓'} ${pct} %`;
}

// --- Utilitaires de mois ----------------------------------------------------

function keyOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Les `count` mois précédant (year, month), du plus récent au plus ancien. */
function previousMonths(year, month, count) {
  const out = [];
  let y = year;
  let m = month;
  for (let i = 0; i < count; i++) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    out.push(keyOf(y, m));
  }
  return out;
}

function labelOf(key) {
  const [, m] = key.split('-').map(Number);
  return MOIS[m - 1];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
