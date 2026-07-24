// csv.js — export / import CSV.
//
// L'export n'est pas un confort : c'est le filet de sécurité contre la purge
// de stockage de Safari (7 jours pour un onglet non installé). L'import sert
// à restaurer après une telle purge.
//
// Format : séparateur « ; », décimale à la virgule (CSV français, s'ouvre
// directement dans Excel fr). Montants en euros à l'affichage, reconvertis en
// centimes à l'import.

import { toCents } from './money.js';

const SEP = ';';
const HEADER = ['date', 'libelle', 'categorie', 'montant', 'note'];

/**
 * Construit le contenu CSV à partir des dépenses.
 * @param {object[]} expenses
 * @param {object[]} categories
 * @returns {string}
 */
export function buildCSV(expenses, categories) {
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const rows = [...expenses]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((e) => [
      e.date,
      e.label ?? '',
      nameById.get(e.categoryId) ?? 'Autre',
      centsToPlain(e.amount),
      e.note ?? '',
    ].map(csvField).join(SEP));

  return [HEADER.join(SEP), ...rows].join('\r\n');
}

/**
 * Déclenche le téléchargement du CSV via Blob + URL.createObjectURL.
 * @returns {string} le nom de fichier utilisé
 */
export function downloadCSV(text, prefix = 'comptes-clairs') {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${prefix}-${stamp}.csv`;
  // BOM UTF-8 pour qu'Excel affiche correctement les accents.
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
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
 * Analyse un CSV et renvoie des enregistrements de dépense prêts à insérer.
 * Les catégories sont résolues par nom (insensible à la casse), défaut Autre.
 *
 * @param {string} text
 * @param {object[]} categories
 * @param {() => string} makeId générateur d'id (uuid)
 * @returns {{records: object[], errors: number}}
 */
export function parseCSV(text, categories, makeId) {
  const clean = text.replace(/^﻿/, '');
  const rows = parseRows(clean);
  if (rows.length === 0) return { records: [], errors: 0 };

  // Localise les colonnes depuis l'en-tête (tolérant à l'ordre).
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.indexOf('date'),
    label: header.indexOf('libelle'),
    category: header.indexOf('categorie'),
    amount: header.indexOf('montant'),
    note: header.indexOf('note'),
  };

  const catByName = new Map(
    categories.map((c) => [c.name.trim().toLowerCase(), c.id]),
  );
  const autre = categories.find((c) => c.name === 'Autre') || categories[0];

  const records = [];
  let errors = 0;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (cols.length === 1 && cols[0].trim() === '') continue; // ligne vide

    const date = (cols[idx.date] || '').trim();
    const amount = toCents(cols[idx.amount] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) {
      errors++;
      continue;
    }

    const catName = (cols[idx.category] || '').trim().toLowerCase();
    const categoryId = catByName.get(catName) || autre.id;
    const note = (cols[idx.note] || '').trim();

    records.push({
      id: makeId(),
      date,
      label: (cols[idx.label] || '').trim() || catName || 'Dépense',
      amount,
      categoryId,
      note: note || null,
      createdAt: Date.now(),
    });
  }

  return { records, errors };
}

// --- utilitaires internes ---------------------------------------------------

function csvField(value) {
  const s = String(value ?? '');
  if (s.includes(SEP) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function centsToPlain(cents) {
  // "1250" -> "12,50" (virgule, sans symbole).
  return ((cents ?? 0) / 100).toFixed(2).replace('.', ',');
}

/** Parse minimal de CSV gérant les guillemets et le séparateur « ; ». */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === SEP) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
