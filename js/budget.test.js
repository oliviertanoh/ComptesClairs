// budget.test.js — assertions sur la logique pure (money.js + budget.js).
//
// Pas de framework, pas de dépendance. Deux façons de lancer :
//   1. Ouvrir tests.html dans le navigateur (rendu visuel pass/fail).
//   2. Regarder la console : les résultats y sont aussi écrits.
//
// (Node n'est pas requis par le projet ; ces tests tournent dans le
// navigateur, comme le reste de l'app.)

import { toCents, formatEuros, toInputValue } from './money.js';
import {
  budgetLevel,
  overspend,
  progressRatio,
  sumAmounts,
  spentByCategory,
  summarizeMonth,
  remaining,
  planMonth,
} from './budget.js';

const results = [];
let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed++;
  else failed++;
  results.push({ name, ok, actual, expected });
  if (!ok) {
    console.error(`✗ ${name} — attendu ${expected}, obtenu ${actual}`);
  }
}

// ---- money.toCents ---------------------------------------------------------
check('toCents virgule', toCents('12,50'), 1250);
check('toCents point', toCents('12.5'), 1250);
check('toCents entier', toCents('2300'), 230000);
check('toCents espace milliers', toCents('2 300,50'), 230050);
check('toCents point millier + virgule décimale', toCents('1.234,56'), 123456);
check('toCents avec €', toCents('19,99 €'), 1999);
check('toCents vide', toCents(''), 0);
check('toCents null', toCents(null), 0);
check('toCents nombre', toCents(45), 4500);
check('toCents arrondi propre', toCents('0.1') + toCents('0.2'), 30); // pas 0.3000...

// ---- money.format ----------------------------------------------------------
// On compare via includes pour rester tolérant à l'espace insécable.
check('formatEuros décimales', formatEuros(1250).replace(/\s/g, ' ').includes('12,50'), true);
check('toInputValue', toInputValue(1999), '19.99');

// ---- budget.budgetLevel (les seuils, cœur du besoin) -----------------------
check('level 0%', budgetLevel(0, 10000), 'green');
check('level 74%', budgetLevel(7400, 10000), 'green');
check('level 75% pile', budgetLevel(7500, 10000), 'neutral');
check('level 89%', budgetLevel(8900, 10000), 'neutral');
check('level 90% pile', budgetLevel(9000, 10000), 'orange');
check('level 100% pile', budgetLevel(10000, 10000), 'orange');
check('level 101%', budgetLevel(10100, 10000), 'red');
check('level budget nul + dépense', budgetLevel(500, 0), 'red');
check('level budget nul sans dépense', budgetLevel(0, 0), 'neutral');

// ---- budget.overspend ------------------------------------------------------
check('overspend nul', overspend(8000, 10000), 0);
check('overspend positif', overspend(12400, 10000), 2400);
check('overspend exact', overspend(10000, 10000), 0);

// ---- budget.progressRatio --------------------------------------------------
check('ratio à moitié', progressRatio(5000, 10000), 0.5);
check('ratio borné haut', progressRatio(20000, 10000), 1);
check('ratio budget nul entamé', progressRatio(500, 0), 1);

// ---- budget.sum & spentByCategory ------------------------------------------
const sample = [
  { categoryId: 'a', amount: 1000 },
  { categoryId: 'a', amount: 500 },
  { categoryId: 'b', amount: 2000 },
];
check('sumAmounts', sumAmounts(sample), 3500);
check('spentByCategory a', spentByCategory(sample).get('a'), 1500);
check('spentByCategory b', spentByCategory(sample).get('b'), 2000);

// ---- budget.remaining ------------------------------------------------------
check('remaining positif', remaining(230000, 150000), 80000);
check('remaining négatif', remaining(230000, 250000), -20000);

// ---- budget.summarizeMonth (valeurs génériques, aucun chiffre perso) --------
const cats = [
  { id: 'restau', name: 'Restau/livraison' },
  { id: 'courses', name: 'Courses' },
];
const budgets = { restau: 10000, courses: 20000 };
const monthExpenses = [
  { categoryId: 'restau', amount: 15000 }, // dépassement (150 % du budget)
  { categoryId: 'courses', amount: 12000 },
];
const s = summarizeMonth({
  categories: cats,
  budgetForCategory: (id) => budgets[id] ?? 0,
  expenses: monthExpenses,
  income: 200000,
});
check('summary totalSpent', s.totalSpent, 27000);
check('summary totalBudget', s.totalBudget, 30000);
check('summary remaining', s.remaining, 173000);
check('summary restau red', s.categories[0].level, 'red');
check('summary restau over', s.categories[0].over, 5000);
check('summary courses green', s.categories[1].level, 'green');

// ---- budget.planMonth (revenu / épargne / reste à dépenser) ----------------
// Scénario de référence : 2 100 € de revenu, 400 € d'épargne visée,
// 1 700 € de budgets, 1 240 € déjà dépensés au 19 d'un mois de 30 jours.
const p = planMonth({
  income: 210000, savingsTarget: 40000, totalBudget: 170000,
  totalSpent: 124000, dayOfMonth: 19, daysInMonth: 30,
});
check('plan spendable', p.spendable, 170000);
check('plan leftToSpend', p.leftToSpend, 46000);
check('plan non alloué', p.unallocated, 0);
check('plan pas surengagé', p.overcommitted, false);
check('plan épargne atteignable', p.savingsReachable, 40000);
check('plan épargne en danger', p.savingsAtRisk, 0);
check('plan jours restants (aujourd’hui inclus)', p.daysLeft, 12);
check('plan par jour', p.perDay, 3833); // 460 € / 12 j = 38,33 €
check('plan statut', p.status, 'ok');
// Les 3 segments de la barre somment toujours au revenu.
check('plan segments = revenu',
  p.segments.spent + p.segments.left + p.segments.savings, 210000);

// L'épargne est entamée : le segment épargne rétrécit d'autant.
const pHit = planMonth({
  income: 210000, savingsTarget: 40000, totalBudget: 170000,
  totalSpent: 180000, dayOfMonth: 25, daysInMonth: 30,
});
check('plan entamé — reste négatif', pHit.leftToSpend, -10000);
check('plan entamé — épargne atteignable', pHit.savingsReachable, 30000);
check('plan entamé — épargne en danger', pHit.savingsAtRisk, 10000);
check('plan entamé — statut', pHit.status, 'savings-hit');
check('plan entamé — segments = revenu',
  pHit.segments.spent + pHit.segments.left + pHit.segments.savings, 210000);

// Dépassement du revenu lui-même.
const pOver = planMonth({
  income: 210000, savingsTarget: 40000, totalBudget: 170000,
  totalSpent: 220000, dayOfMonth: 30, daysInMonth: 30,
});
check('plan hors revenu — dépassement', pOver.overIncome, 10000);
check('plan hors revenu — épargne atteignable', pOver.savingsReachable, 0);
check('plan hors revenu — statut', pOver.status, 'over-income');
check('plan hors revenu — segment dépensé borné au revenu', pOver.segments.spent, 210000);

// Budgets incohérents avec l'objectif : détecté AVANT toute dépense.
const pBad = planMonth({
  income: 210000, savingsTarget: 40000, totalBudget: 190000,
  totalSpent: 0, dayOfMonth: 1, daysInMonth: 31,
});
check('plan surengagé', pBad.overcommitted, true);
check('plan surengagé — écart', pBad.unallocated, -20000);
check('plan surengagé — jours restants', pBad.daysLeft, 31);

// Épargne visée > revenu : bornée, jamais de `spendable` négatif.
const pAbsurd = planMonth({ income: 100000, savingsTarget: 150000 });
check('plan épargne bornée au revenu', pAbsurd.savingsTarget, 100000);
check('plan spendable jamais négatif', pAbsurd.spendable, 0);

// Revenu non renseigné : aucun plan possible, mais aucune division par zéro.
const pNone = planMonth({ income: 0, savingsTarget: 0, totalSpent: 5000 });
check('plan sans revenu — statut', pNone.status, 'no-income');
check('plan sans revenu — perDay', pNone.perDay, 0);

// Mois passé (pas de jour courant) : pas de « par jour ».
const pPast = planMonth({
  income: 210000, savingsTarget: 40000, totalSpent: 100000, daysInMonth: 31,
});
check('plan mois passé — jours restants', pPast.daysLeft, 0);
check('plan mois passé — perDay', pPast.perDay, 0);

// ---- Rapport ---------------------------------------------------------------
const summary = { passed, failed, total: passed + failed, results };
console.log(
  `%cTests budget : ${passed}/${summary.total} OK${failed ? ` — ${failed} ÉCHEC(S)` : ''}`,
  `color:${failed ? '#D64545' : '#2E9E6B'};font-weight:bold`,
);

export default summary;
