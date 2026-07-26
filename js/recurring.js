// recurring.js — charges fixes qui retombent chaque mois (loyer, abonnements).
//
// Pourquoi ça existe : sans ça, il faut ressaisir le loyer tous les mois, et
// tant que ce n'est pas fait le « reste à dépenser » ment. Une règle décrit la
// charge une fois ; l'app crée la dépense correspondante à l'ouverture du mois.
//
// ── Idempotence ────────────────────────────────────────────────────────────
// Chaque règle garde la liste des mois déjà générés (`materialized`). C'est ce
// qui garantit deux choses distinctes :
//   1. rouvrir dix fois le même mois ne crée pas dix loyers ;
//   2. supprimer une occurrence à la main (mois où tu n'as pas payé) ne la
//      fait pas réapparaître — le mois reste marqué comme traité.
// Un identifiant déterministe seul n'aurait donné que la première garantie.

import { recurring, expenses, monthKey, uuid } from './db.js';

/** Une règle s'applique-t-elle à ce mois ? (bornes incluses) */
export function appliesTo(rule, key) {
  if (!rule.active) return false;
  if (rule.startMonth && key < rule.startMonth) return false;
  if (rule.endMonth && key > rule.endMonth) return false;
  return true;
}

/**
 * Date ISO de l'occurrence, en bornant le jour au dernier jour du mois :
 * une charge au 31 doit tomber le 28 en février, pas déborder sur mars.
 */
export function occurrenceDate(year, month, dayOfMonth) {
  const last = new Date(year, month, 0).getDate();
  const day = Math.min(Math.max(dayOfMonth || 1, 1), last);
  return `${monthKey(year, month)}-${String(day).padStart(2, '0')}`;
}

/**
 * Crée les dépenses manquantes du mois à partir des règles actives.
 * Idempotent : ne fait rien pour un mois déjà généré.
 *
 * @param {number} year
 * @param {number} month 1-12
 * @returns {Promise<number>} nombre de dépenses créées
 */
export async function materializeMonth(year, month) {
  const key = monthKey(year, month);
  const rules = await recurring.all();

  const created = [];
  const touched = [];

  for (const rule of rules) {
    if (!appliesTo(rule, key)) continue;
    const done = rule.materialized || [];
    if (done.includes(key)) continue;

    created.push({
      id: uuid(),
      date: occurrenceDate(year, month, rule.dayOfMonth),
      label: rule.label,
      amount: rule.amount,
      categoryId: rule.categoryId,
      note: null,
      // Traçabilité : d'où vient cette dépense, et comment la reconnaître
      // comme fixe dans les calculs et à l'affichage.
      recurringId: rule.id,
      fixed: true,
      createdAt: Date.now(),
    });
    touched.push({ ...rule, materialized: [...done, key] });
  }

  if (created.length === 0) return 0;

  // Les dépenses d'abord : si l'écriture des règles échouait ensuite, on
  // aurait un doublon au prochain passage — gênant mais visible et
  // corrigeable. L'ordre inverse perdrait la charge en silence.
  await expenses.bulkPut(created);
  await recurring.bulkPut(touched);
  return created.length;
}

/**
 * Total des charges fixes prévues pour un mois d'après les RÈGLES (et non
 * d'après les dépenses générées). Sert à l'aperçu dans les réglages, avant
 * même que le mois n'existe.
 * @returns {Promise<number>} centimes
 */
export async function plannedFixedTotal(year, month) {
  const key = monthKey(year, month);
  const rules = await recurring.all();
  return rules
    .filter((r) => appliesTo(r, key))
    .reduce((sum, r) => sum + (r.amount || 0), 0);
}

/**
 * Fabrique une règle à partir d'une dépense existante — « celle-ci revient
 * tous les mois ». Ne matérialise pas le mois courant : la dépense d'origine
 * en tient déjà lieu.
 * @param {object} expense
 * @param {number} dayOfMonth
 */
export function ruleFromExpense(expense, dayOfMonth) {
  const key = expense.date.slice(0, 7);
  return {
    id: uuid(),
    label: expense.label,
    amount: expense.amount,
    categoryId: expense.categoryId,
    dayOfMonth: dayOfMonth || Number(expense.date.slice(8, 10)) || 1,
    active: true,
    startMonth: key,
    endMonth: null,
    // Le mois d'origine est marqué comme déjà traité : sans ça, la dépense
    // serait dupliquée dès le prochain affichage de ce mois.
    materialized: [key],
  };
}
