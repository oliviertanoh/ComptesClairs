// budget.js — LA logique métier. Aucun accès au DOM, aucun accès à
// IndexedDB. Entrées -> sorties, point. C'est ici qu'un bug coûte de
// l'argent réel : ce fichier doit rester testable en isolation
// (voir budget.test.js).
//
// Tous les montants sont en centimes (entiers).

/** Seuils du code couleur (fraction du budget consommé). */
export const THRESHOLDS = {
  NEUTRAL: 0.75, // en dessous : vert
  ORANGE: 0.90, // à partir de 0,90 : orange
  RED: 1.00, // au-delà de 1,00 : rouge
};

/**
 * Somme des montants d'une liste de dépenses.
 * @param {{amount:number}[]} expenses
 * @returns {number} centimes
 */
export function sumAmounts(expenses) {
  return expenses.reduce((total, e) => total + e.amount, 0);
}

/**
 * Dépensé par catégorie.
 * @param {{categoryId:string, amount:number}[]} expenses
 * @returns {Map<string, number>} categoryId -> centimes
 */
export function spentByCategory(expenses) {
  const map = new Map();
  for (const e of expenses) {
    map.set(e.categoryId, (map.get(e.categoryId) || 0) + e.amount);
  }
  return map;
}

/**
 * Niveau d'alerte d'un budget.
 *   < 75 %      -> 'green'
 *   75 – < 90 % -> 'neutral'
 *   90 – 100 %  -> 'orange'
 *   > 100 %     -> 'red'
 *
 * Cas d'un budget nul : toute dépense est un dépassement -> 'red',
 * sinon 'neutral'.
 *
 * @param {number} spent centimes
 * @param {number} budget centimes
 * @returns {'green'|'neutral'|'orange'|'red'}
 */
export function budgetLevel(spent, budget) {
  if (budget <= 0) {
    return spent > 0 ? 'red' : 'neutral';
  }
  const r = spent / budget;
  if (r < THRESHOLDS.NEUTRAL) return 'green';
  if (r < THRESHOLDS.ORANGE) return 'neutral';
  if (r <= THRESHOLDS.RED) return 'orange';
  return 'red';
}

/**
 * Montant du dépassement (0 si dans les clous).
 * @returns {number} centimes
 */
export function overspend(spent, budget) {
  return spent > budget ? spent - budget : 0;
}

/**
 * Fraction consommée, bornée à [0, 1] pour piloter une barre de
 * progression. Un budget nul déjà entamé renvoie 1 (barre pleine).
 * @returns {number} entre 0 et 1
 */
export function progressRatio(spent, budget) {
  if (budget <= 0) return spent > 0 ? 1 : 0;
  const r = spent / budget;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

/**
 * Reste disponible du mois : revenus − total dépensé.
 * Peut être négatif (et doit alors se voir).
 * @returns {number} centimes
 */
export function remaining(income, totalSpent) {
  return income - totalSpent;
}

/**
 * Synthèse complète d'un mois, prête à afficher. Ne fait aucune requête :
 * on lui passe les données déjà chargées.
 *
 * @param {Object} args
 * @param {{id:string}[]} args.categories catégories (déjà filtrées si besoin)
 * @param {(categoryId:string)=>number} args.budgetForCategory budget du mois
 * @param {{categoryId:string, amount:number}[]} args.expenses dépenses du mois
 * @param {number} args.income revenu mensuel (centimes)
 * @returns {{
 *   categories: Array<{category:object, spent:number, budget:number,
 *     level:string, over:number, ratio:number}>,
 *   totalSpent:number, totalBudget:number, remaining:number, ratio:number
 * }}
 */
export function summarizeMonth({ categories, budgetForCategory, expenses, income }) {
  const spentMap = spentByCategory(expenses);

  const cats = categories.map((category) => {
    const spent = spentMap.get(category.id) || 0;
    const budget = budgetForCategory(category.id);
    return {
      category,
      spent,
      budget,
      level: budgetLevel(spent, budget),
      over: overspend(spent, budget),
      ratio: progressRatio(spent, budget),
    };
  });

  const totalSpent = sumAmounts(expenses);
  const totalBudget = cats.reduce((s, c) => s + c.budget, 0);

  return {
    categories: cats,
    totalSpent,
    totalBudget,
    remaining: remaining(income, totalSpent),
    ratio: totalBudget > 0 ? Math.min(totalSpent / totalBudget, 1) : 0,
  };
}
