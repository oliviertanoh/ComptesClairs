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
 * Plan du mois : ce que devient le revenu une fois l'objectif d'épargne
 * réservé. C'est le calcul qui manquait — `savingsTarget` était saisi puis
 * jamais utilisé.
 *
 * Le raisonnement, dans l'ordre :
 *   1. On met l'épargne de côté EN PREMIER (revenu − épargne = `spendable`),
 *      pas avec ce qui reste à la fin. C'est la seule façon de tenir un
 *      objectif.
 *   2. `spendable` se compare à la somme des budgets par catégorie : si les
 *      budgets dépassent, le plan est intenable AVANT même la 1re dépense
 *      (`overcommitted`).
 *   3. `leftToSpend` = ce qu'on peut encore sortir sans toucher à l'épargne.
 *      C'est le chiffre du quotidien.
 *
 * La barre d'affichage découpe le revenu en 3 segments qui somment TOUJOURS
 * à `income` (tant que income > 0) : dépensé | reste à dépenser | épargne.
 * Quand on mord sur l'épargne, c'est le segment épargne qui rétrécit — donc
 * la barre montre le dégât sans texte à lire.
 *
 * @param {Object} args
 * @param {number} args.income revenu mensuel (centimes)
 * @param {number} args.savingsTarget objectif d'épargne (centimes)
 * @param {number} args.totalBudget somme des budgets par catégorie (centimes)
 * @param {number} args.totalSpent total dépensé à ce jour (centimes)
 * @param {number} [args.dayOfMonth] jour courant 1-31 (mois en cours seulement)
 * @param {number} [args.daysInMonth] nombre de jours du mois
 * @returns {{
 *   income:number, savingsTarget:number, spendable:number, allocated:number,
 *   unallocated:number, overcommitted:boolean, spent:number,
 *   leftToSpend:number, savingsAtRisk:number, savingsReachable:number,
 *   overIncome:number, daysLeft:number, perDay:number,
 *   segments:{spent:number, left:number, savings:number},
 *   status:'no-income'|'over-income'|'savings-hit'|'tight'|'ok'
 * }}
 */
export function planMonth({
  income = 0,
  savingsTarget = 0,
  totalBudget = 0,
  fixedSpent = 0,
  variableSpent = null,
  totalSpent = null,
  dayOfMonth = null,
  daysInMonth = 30,
}) {
  // `variableSpent` explicite, sinon déduit de `totalSpent` (mois sans aucune
  // charge fixe : tout est variable).
  const varSpent = variableSpent ?? Math.max((totalSpent ?? 0) - fixedSpent, 0);
  const spent = fixedSpent + varSpent;

  // Un objectif d'épargne supérieur au revenu n'a pas de sens : on le borne
  // plutôt que de produire un `spendable` négatif qui contaminerait tout.
  const target = clamp(savingsTarget, 0, Math.max(income, 0));
  const spendable = Math.max(income - target, 0);

  const allocated = totalBudget;
  const unallocated = spendable - allocated;

  // LE point clé : les charges fixes du mois sont déduites en entier, qu'elles
  // soient déjà prélevées ou non. Ce qui reste est la seule somme sur laquelle
  // une décision quotidienne a un sens.
  const variableSpendable = spendable - fixedSpent;
  const leftToSpend = variableSpendable - varSpent;

  // Découpage de la barre. Les quatre segments somment à `income`.
  const segFixed = clamp(fixedSpent, 0, income);
  const segSpent = clamp(varSpent, 0, income - segFixed);
  const segLeft = clamp(leftToSpend, 0, income - segFixed - segSpent);
  const segSavings = Math.max(income - segFixed - segSpent - segLeft, 0);

  // `segSavings` EST l'épargne encore atteignable : dès qu'on dépasse
  // `spendable`, elle fond à la même vitesse que le dépassement.
  const savingsReachable = segSavings;
  const savingsAtRisk = Math.max(target - savingsReachable, 0);
  const overIncome = Math.max(spent - income, 0);

  // Jours restants, aujourd'hui inclus (on peut encore dépenser aujourd'hui).
  const daysLeft = dayOfMonth == null
    ? 0
    : clamp(daysInMonth - dayOfMonth + 1, 0, daysInMonth);
  const perDay = daysLeft > 0 ? Math.round(leftToSpend / daysLeft) : 0;

  return {
    income,
    savingsTarget: target,
    spendable,
    allocated,
    unallocated,
    overcommitted: allocated > spendable,
    fixedSpent,
    variableSpent: varSpent,
    variableSpendable,
    spent,
    leftToSpend,
    savingsAtRisk,
    savingsReachable,
    overIncome,
    daysLeft,
    perDay,
    segments: { fixed: segFixed, spent: segSpent, left: segLeft, savings: segSavings },
    status: planStatus({ income, target, spendable, spent, fixedSpent, leftToSpend }),
  };
}

function planStatus({ income, target, spendable, spent, fixedSpent, leftToSpend }) {
  if (income <= 0) return 'no-income';
  if (spent > income) return 'over-income';
  // Les charges fixes seules mangent déjà toute l'enveloppe : aucun arbitrage
  // quotidien ne peut rattraper ça, c'est le plan qu'il faut revoir.
  if (fixedSpent > spendable) return 'fixed-overrun';
  if (target > 0 && spent > spendable) return 'savings-hit';
  // Moins de 10 % de l'enveloppe restante : ça va se jouer serré.
  if (spendable > 0 && leftToSpend < spendable * 0.10) return 'tight';
  return 'ok';
}

// --- Aides au bilan (comparaisons d'un mois à l'autre) ----------------------

/**
 * Moyenne entière d'une liste de montants. 0 sur liste vide (pas NaN : une
 * moyenne qui vaut NaN se propage jusqu'à l'affichage).
 * @param {number[]} values
 * @returns {number} centimes
 */
export function average(values) {
  if (!values || values.length === 0) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

/**
 * Compare une valeur à une référence (typiquement : ce mois vs moyenne des
 * mois précédents).
 *
 * `direction` n'est 'up'/'down' qu'au-delà de 5 % d'écart : sous ce seuil, la
 * variation naturelle d'un mois à l'autre ne veut rien dire et afficher une
 * flèche donnerait un faux signal.
 *
 * @returns {{delta:number, ratio:number|null, direction:'up'|'down'|'flat'|'new'}}
 */
export function trend(value, reference) {
  if (!reference) {
    return { delta: value, ratio: null, direction: value > 0 ? 'new' : 'flat' };
  }
  const delta = value - reference;
  const ratio = delta / reference;
  if (Math.abs(ratio) < 0.05) return { delta, ratio, direction: 'flat' };
  return { delta, ratio, direction: delta > 0 ? 'up' : 'down' };
}

function clamp(v, lo, hi) {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
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
