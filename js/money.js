// money.js — conversion et formatage des montants.
//
// RÈGLE ABSOLUE : tous les montants circulent en CENTIMES, sous forme
// d'entiers. Jamais de flottants dans le stockage ni dans les calculs.
// (0.1 + 0.2 === 0.30000000000000004 en JS ; sur un budget ça s'accumule.)
//
// Ce module ne touche ni au DOM ni à IndexedDB.

const EUR = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
});

// Même formatage mais sans les décimales quand elles sont à ,00 —
// utile pour les gros chiffres de l'accueil.
const EUR_ROUND = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Convertit une saisie utilisateur en centimes (entier).
 * Accepte la virgule française ET le point, les espaces (séparateurs de
 * milliers, y compris insécables) et un symbole €.
 *
 * Exemples :
 *   toCents("12,50")     -> 1250
 *   toCents("12.5")      -> 1250
 *   toCents("2 300,50")  -> 230050
 *   toCents("1.234,56")  -> 123456   (point = millier, virgule = décimale)
 *   toCents("")          -> 0
 *
 * @param {string|number} input
 * @returns {number} centimes, entier
 */
export function toCents(input) {
  if (typeof input === 'number') {
    return Math.round(input * 100);
  }
  if (input == null) return 0;

  let s = String(input).trim();
  if (s === '') return 0;

  // Retire espaces (dont insécables), € et tout caractère parasite hormis
  // chiffres, virgule, point et signe moins.
  s = s.replace(/[\s  €]/g, '');

  // Si une virgule est présente, elle est la décimale : les points sont
  // alors des séparateurs de milliers, on les supprime.
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }

  // Nettoie ce qui resterait (lettres collées, etc.).
  s = s.replace(/[^0-9.\-]/g, '');

  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return 0;

  return Math.round(value * 100);
}

/**
 * Formate des centimes en euros, format fr-FR.
 *   formatEuros(1250)   -> "12,50 €"
 *   formatEuros(230050) -> "2 300,50 €"
 * @param {number} cents
 * @returns {string}
 */
export function formatEuros(cents) {
  return EUR.format((cents ?? 0) / 100);
}

/**
 * Variante sans décimales quand le montant est rond — pour les affichages
 * de grande taille. Repasse au format complet si des centimes existent.
 * @param {number} cents
 * @returns {string}
 */
export function formatEurosCompact(cents) {
  const c = cents ?? 0;
  if (c % 100 === 0) return EUR_ROUND.format(c / 100);
  return EUR.format(c / 100);
}

/**
 * Centimes -> chaîne éditable dans un champ (décimale = point, pas de
 * symbole). Utile pour pré-remplir un <input type="number">.
 *   toInputValue(1250) -> "12.50"
 * @param {number} cents
 * @returns {string}
 */
export function toInputValue(cents) {
  const c = cents ?? 0;
  return (c / 100).toFixed(2);
}
