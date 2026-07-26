// seed.js — données initiales du premier lancement : catégories, budgets du
// mois courant, commerçants pré-remplis et réglages. Idempotent : ne fait
// rien si des catégories existent déjà.
//
// Tous les montants sont en centimes.

import { categories, merchants, monthlyBudgets, settings, uuid } from './db.js';

// Couleurs d'identité des catégories (chips/icônes). Volontairement neutres
// et désaturées : elles n'entrent PAS en conflit avec le vert/orange/rouge
// réservés aux états de budget.
// Budgets à 0 : ce dépôt est public (GitHub Pages), on n'y met AUCUN chiffre
// personnel. Tu définis tes vrais budgets dans Réglages, au premier lancement ;
// ils restent dans l'IndexedDB de ton téléphone et ne quittent jamais l'appareil.
// `watch: true` = alerte sur l'accueil dès 75 % du budget. C'est un drapeau,
// pas un nom en dur : renommer la catégorie n'éteint pas son alerte.
const CATEGORY_SEED = [
  { key: 'fixed', name: 'Charges fixes', monthlyBudget: 0, color: '#5B6B7B', icon: '🏠' },
  { key: 'courses', name: 'Courses', monthlyBudget: 0, color: '#4E7A6E', icon: '🛒' },
  { key: 'restau', name: 'Restau/livraison', monthlyBudget: 0, color: '#8A6D5B', icon: '🍔', watch: true },
  { key: 'transport', name: 'Transport', monthlyBudget: 0, color: '#4A6591', icon: '🚊' },
  { key: 'loisirs', name: 'Loisirs/vêtements', monthlyBudget: 0, color: '#7A5B84', icon: '👕' },
  { key: 'imprevus', name: 'Imprévus', monthlyBudget: 0, color: '#7C6E4E', icon: '⚠️' },
  { key: 'epargne', name: 'Épargne', monthlyBudget: 0, color: '#3E6E8E', icon: '💰' },
  { key: 'autre', name: 'Autre', monthlyBudget: 0, color: '#6B7280', icon: '❓' },
];

// Libellés fréquents pour la saisie rapide.
// amount en centimes, ou null si variable.
//
// CONFIDENTIALITÉ : ce dépôt est public. On ne met ici QUE des tarifs publics
// (abonnements, tickets de transport), identiques pour tout le monde. Les
// montants personnels (loyer, crédits, virement d'épargne) sont laissés à
// « variable » (null) — tu renseignes leur montant à la première saisie, il
// reste sur ton téléphone.
const MERCHANT_SEED = {
  fixed: [
    ['Loyer', null],
    ['Crédit Expresso', null],
    ['Crédit Alterna', null],
    ['Salle de sport', null],
    ['Free Mobile', 1999],
    ['Abonnement Claude', 2000],
    ['Apple.com', 299],
    ['Assurance', null],
    ['Électricité', null],
    ['Eau', null],
  ],
  courses: [
    ['Auchan', null],
    ['Carrefour City', null],
    ['U Express', null],
    ['Picard', null],
  ],
  restau: [
    ['Uber Eats', null],
    ['Uber One', 599],
    ["L'Escale Gourmande", null],
    ['Paul Meunier', null],
    ['Croissanterine', null],
    ['Selecta', null],
    ['100 Patates', null],
    ["Domino's", null],
  ],
  transport: [
    ['Uber', null],
    ['SNCF', null],
    ['Keolis Tours', 180],
    ['Semitan', 180],
    ['Carburant', null],
  ],
  loisirs: [
    ['Bershka', null],
    ['Foot Locker', null],
    ['Klarna', null],
    ['Myprotein', null],
    ['TikTok Shop', null],
    ['Sortie/bar', null],
    ['Coiffeur', null],
  ],
  imprevus: [
    ['Pharmacie', null],
    ['Médecin', null],
    ['Réparation', null],
    ['Cadeau', null],
  ],
  epargne: [
    ['Virement épargne', null],
    ['Bitstack', null],
  ],
  autre: [['Retrait DAB', null]],
};

// Neutralisés (dépôt public) : à renseigner dans Réglages au 1er lancement.
const DEFAULT_SETTINGS = {
  monthlyIncome: 0,
  savingsTarget: 0,
  lastExportAt: null,
  reminderDays: 30, // fréquence du rappel de sauvegarde (0 = jamais)
};

/**
 * Amorce la base si elle est vide. Renvoie true si un seed a eu lieu.
 * @param {{year:number, month:number}} current mois courant à budgétiser
 */
export async function seedIfEmpty({ year, month }) {
  const existing = await categories.all();
  if (existing.length > 0) return false;

  // 1. Catégories (on garde la correspondance key -> id généré).
  const idByKey = {};
  const catRecords = CATEGORY_SEED.map((c, i) => {
    const id = uuid();
    idByKey[c.key] = id;
    return {
      id,
      name: c.name,
      monthlyBudget: c.monthlyBudget,
      color: c.color,
      icon: c.icon,
      sortOrder: i,
      archived: false,
      watch: c.watch ?? false,
    };
  });
  await categories.bulkPut(catRecords);

  // 2. Budgets du mois courant, à partir des budgets de référence.
  const mm = String(month).padStart(2, '0');
  const budgetRecords = catRecords.map((c) => ({
    id: `${year}-${mm}_${c.id}`,
    year,
    month,
    categoryId: c.id,
    amount: c.monthlyBudget,
  }));
  await monthlyBudgets.bulkPut(budgetRecords);

  // 3. Commerçants.
  const merchantRecords = [];
  for (const [key, list] of Object.entries(MERCHANT_SEED)) {
    const categoryId = idByKey[key];
    for (const [name, amount] of list) {
      merchantRecords.push({
        id: uuid(),
        name,
        defaultCategoryId: categoryId,
        defaultAmount: amount,
        useCount: 0,
        lastUsedAt: null,
      });
    }
  }
  await merchants.bulkPut(merchantRecords);

  // 4. Réglages.
  await settings.put(DEFAULT_SETTINGS);

  return true;
}
