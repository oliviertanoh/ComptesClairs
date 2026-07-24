// backup.js — sauvegarde COMPLÈTE en un seul fichier JSON.
//
// Différence avec csv.js : le CSV n'exporte que les dépenses (pratique pour
// Excel). La sauvegarde JSON capture TOUT — catégories, budgets mensuels,
// commerçants, réglages, dépenses — pour une restauration intégrale après
// une purge de stockage ou un changement de téléphone.

import { exportAll, importAll } from './db.js';

const APP_TAG = 'comptes-clairs';
const FORMAT_VERSION = 1;

/**
 * Construit l'objet de sauvegarde (métadonnées + données).
 * @returns {Promise<object>}
 */
export async function buildBackup() {
  const data = await exportAll();
  return {
    app: APP_TAG,
    version: FORMAT_VERSION,
    exportedAt: Date.now(),
    data,
  };
}

/**
 * Télécharge la sauvegarde en .json via Blob + URL.createObjectURL.
 * @returns {string} nom de fichier
 */
export function downloadBackup(backupObj) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `comptes-clairs-sauvegarde-${stamp}.json`;
  const blob = new Blob([JSON.stringify(backupObj, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/**
 * Analyse et valide un fichier de sauvegarde. Lève une erreur si invalide.
 * @param {string} text contenu du fichier
 * @returns {{data:object, counts:{categories:number, expenses:number,
 *   merchants:number, monthlyBudgets:number}}}
 */
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Fichier illisible (JSON invalide).');
  }
  if (!obj || obj.app !== APP_TAG || !obj.data) {
    throw new Error("Ce fichier n'est pas une sauvegarde Comptes Clairs.");
  }
  const d = obj.data;
  return {
    data: d,
    counts: {
      categories: d.categories?.length ?? 0,
      expenses: d.expenses?.length ?? 0,
      merchants: d.merchants?.length ?? 0,
      monthlyBudgets: d.monthlyBudgets?.length ?? 0,
    },
  };
}

/**
 * Restaure une sauvegarde : REMPLACE tout le contenu actuel.
 * @param {object} data structure `data` issue de parseBackup
 */
export async function restoreBackup(data) {
  await importAll(data);
}
