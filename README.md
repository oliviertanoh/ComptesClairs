# Comptes Clairs

PWA de suivi de budget personnel. HTML/CSS/JS vanilla, **aucune dépendance,
aucun build**, 100 % hors ligne. Données stockées en local (IndexedDB).

Un seul utilisateur, jamais publiée. Développée sur Ubuntu, utilisée sur
iPhone via « Ajouter à l'écran d'accueil ».

---

## Lancer en local (Ubuntu)

Aucune installation. On sert juste le dossier :

```bash
cd ComptesClairs
python3 -m http.server 8000
```

Puis, sur la machine de dev : <http://localhost:8000>

> Le service worker (mode hors ligne) n'est actif que sur **localhost** ou en
> **HTTPS**. En `http://localhost` tout fonctionne pour développer.

### Lancer les tests de la logique

La logique métier (`money.js`, `budget.js`) est testée à part. Ouvre dans le
navigateur :

<http://localhost:8000/tests.html>

La page affiche chaque assertion en vert/rouge (et écrit le bilan dans la
console). C'est cette partie qui « coûte de l'argent » si elle a un bug —
lance-la après toute modif de `budget.js` ou `money.js`.

---

## Installer sur l'iPhone

Le point délicat : **le service worker exige HTTPS**. Depuis le téléphone,
`http://192.168.x.x:8000` (ton IP locale) chargera l'app mais **sans** le mode
hors ligne ni une installation fiable. Deux solutions propres :

### Option A — Déploiement statique gratuit (recommandé)

GitHub Pages ou Netlify servent le dossier en HTTPS d'office. Comme il n'y a
aucun build, c'est immédiat.

**GitHub Pages :**

1. Pousse ce dossier sur un dépôt GitHub.
2. *Settings → Pages → Branch: `main`, dossier `/ (root)`*.
3. L'URL `https://<toi>.github.io/<repo>/` est prête en une minute.

**Netlify :** glisse-dépose le dossier sur <https://app.netlify.com/drop> →
URL HTTPS instantanée.

### Option B — Tunnel HTTPS temporaire

Pour tester vite sans déployer, expose ton serveur local en HTTPS :

```bash
# exemple avec cloudflared (aucun compte requis)
cloudflared tunnel --url http://localhost:8000
```

Il affiche une URL `https://…trycloudflare.com` ouvrable depuis l'iPhone.

### Ajouter à l'écran d'accueil

Sur l'iPhone, dans **Safari** (pas Chrome — l'installation PWA passe par
Safari sur iOS) :

1. Ouvre l'URL HTTPS de l'app.
2. Bouton **Partager** (carré avec flèche) → **Sur l'écran d'accueil**.
3. Valide. L'icône apparaît ; l'app s'ouvre en plein écran, sans barre Safari.

Une fois installée ainsi, l'app s'ouvre même **en mode avion**.

---

## Sauvegarde — à ne pas négliger

Safari efface les données d'un site **non visité depuis 7 jours**. Une PWA
**installée sur l'écran d'accueil** échappe à cette règle — mais un simple
onglet Safari, non. Sans sauvegarde, une purge de stockage efface tout.

### Synchronisation GitHub (recommandé)

L'app pousse toute seule un `comptes-clairs.json` dans un dépôt GitHub après
chaque modification, et le récupère au lancement. Plus rien à télécharger ni à
recharger à la main.

> **Le dépôt doit être privé.** Le fichier contient le revenu, l'objectif
> d'épargne et **chaque dépense** (date, montant, commerçant) : un profil
> financier complet. Sur un dépôt public il serait lisible par tout le monde,
> indexable, et conservé **définitivement dans l'historique git** même après
> suppression du fichier. Un dépôt privé est gratuit et n'affecte pas les
> Pages du dépôt public de l'app.

**Mise en place :**

1. Crée un dépôt **privé** vide, par ex. `comptes-clairs-data`.
2. GitHub → *Settings → Developer settings → Personal access tokens →
   Fine-grained tokens* → **Generate new token**.
   - *Repository access* : **Only select repositories** → ce seul dépôt.
   - *Permissions → Repository permissions → Contents* : **Read and write**.
     Rien d'autre.
3. Dans l'app : Réglages → **Synchronisation GitHub** → compte, dépôt, jeton →
   **Tester et connecter**.

Le jeton reste dans IndexedDB **sur l'appareil**. Il n'est ni dans le code, ni
dans une sauvegarde, ni poussé sur le dépôt (store `sync` dédié, exclu de
`exportAll()`). L'app refuse de connecter un dépôt public sans avertissement
explicite.

**Comportement :** envoi 3 s après chaque modification, plus au passage en
arrière-plan. Hors ligne, l'envoi est mis en attente et reprend au retour du
réseau — une marque persistante (`dirtySince`) garantit qu'une modification
survit à une fermeture brutale de l'app. Si deux appareils ont divergé, l'app
affiche les deux états et **demande** lequel garder ; elle n'écrase jamais
d'elle-même.

**Nouveau téléphone :** installer l'app → *Récupérer depuis GitHub* → tout
revient.

### Filets de secours

- **Sauvegarde complète (JSON) :** Réglages → *Sauvegarder tout*. Même format
  que le fichier synchronisé, donc interchangeable.
- **CSV :** au format français (séparateur `;`, décimale `,`), s'ouvre dans
  Excel/LibreOffice. Ne contient **que les dépenses**.
- Sans synchro active, l'accueil affiche un **rappel discret** passé 30 jours
  sans export.

---

## Le plan du mois

Le revenu et l'objectif d'épargne sont enregistrés **par mois**
(store `monthlyPlan`), pas seulement dans les réglages : un mois à 1 800 € et
le suivant à 2 100 € restent tous deux justes, et le Bilan calcule l'épargne
passée avec le revenu d'alors. Les réglages servent de valeur par défaut.

L'épargne est réservée **en premier**, et les charges fixes déduites en
entier — qu'elles soient déjà prélevées ou non :

```text
spendable          = revenu − objectif d'épargne
variableSpendable  = spendable − charges fixes du mois
leftToSpend        = variableSpendable − dépenses variables  ← le grand chiffre
perDay             = leftToSpend / jours restants
```

La barre découpe le revenu en quatre segments qui somment toujours à 100 % :
**charges | dépensé | reste | épargne**. Quand on mord sur l'épargne, c'est son
segment qui rétrécit — le dégât se voit sans rien lire.

Une note compare la **somme des budgets par catégorie** à `spendable` : si les
budgets dépassent, le plan est intenable dès le 1er du mois. Un statut à part,
`fixed-overrun`, signale le cas où les charges fixes seules épuisent
l'enveloppe — aucun arbitrage quotidien ne peut le rattraper.

Toute cette logique est pure et testée (`planMonth` dans `budget.js`).

---

## Charges fixes

Une règle (`store recurring`) décrit une charge qui retombe chaque mois :
libellé, montant, catégorie, jour. L'app crée la dépense correspondante à
l'ouverture du mois, marquée `fixed: true` et rattachée à la règle
(`recurringId`).

**Idempotence :** chaque règle garde la liste des mois déjà générés
(`materialized`). Rouvrir dix fois le même mois ne crée pas dix loyers, et
supprimer une occasion à la main ne la fait pas réapparaître. Un identifiant
déterministe seul n'aurait donné que la première garantie.

Un jour 29/30/31 est ramené au dernier jour des mois plus courts. Une règle
créée aujourd'hui ne rétroagit pas sur les mois passés (`startMonth`).

Depuis l'historique, ouvrir une dépense propose **« Celle-ci revient chaque
mois »** : la règle est créée et le mois d'origine marqué comme déjà traité,
pour ne pas dupliquer la dépense de départ.

> **Le graphe de rythme exclut les charges fixes, des deux côtés.** Le loyer
> tombe le 2 : en le comptant, le cumul décollait au-dessus d'une ligne idéale
> linéaire et l'app annonçait « plus vite que le budget » tous les mois pendant
> deux semaines. Une alerte qui se déclenche à tort systématiquement finit
> ignorée — donc inutile le jour où elle a raison.

---

## Rentrées d'argent

Une opération porte un `kind` : `'expense'` (défaut) ou `'income'`. Une rentrée
— remboursement d'un ami, prime, vente — n'entame **aucun budget de
catégorie** : elle s'ajoute au revenu du mois. Sans ça, avancer 60 € au restau
pour quatre personnes comptait comme 60 € dépensés.

---

## Écran Bilan

Répond aux deux questions qu'aucun autre écran ne traitait :

- **« 340 € en restau, c'est beaucoup ? »** — comparaison à la moyenne des
  3 mois précédents, par catégorie. Un mois sans dépense dans la catégorie
  compte comme 0 : l'ignorer gonflerait la référence.
- **« est-ce que je tiens mon objectif dans la durée ? »** — épargne réellement
  réalisée sur 6 mois, avec le repère d'objectif de chaque mois.

Un mois sans revenu enregistré est **masqué** plutôt qu'affiché à −dépensé :
on ignore combien il est rentré, et une barre rouge pleine serait un mensonge.

`trend()` ne qualifie une variation de hausse/baisse qu'au-delà de **5 %** —
en dessous, le bruit d'un mois à l'autre ne veut rien dire.

---

## Structure

```text
index.html            coquille + les 3 onglets
manifest.json         PWA (standalone, portrait)
sw.js                 service worker (cache-first, hors ligne)
tests.html            lance les tests de la logique
css/
  tokens.css          variables : couleurs, espacements, typo
  app.css             composants
js/
  main.js             entrée + routage par onglets (hashchange)
  db.js               couche IndexedDB
  seed.js             catégories + commerçants initiaux
  budget.js           calculs purs — NI DOM NI IndexedDB
  budget.test.js      assertions sur budget.js + money.js
  money.js            toCents / formatEuros (montants en centimes)
  csv.js              export / import
  backup.js           sauvegarde complète JSON (tous les stores)
  sync.js             synchronisation GitHub (API Contents, envoi auto)
  recurring.js        charges fixes (règles + matérialisation idempotente)
  views/              month, add, history, bilan, settings
icons/                180, 192, 512, 512-maskable
```

### Notes d'implémentation

- **Montants en centimes (entiers) partout.** Jamais de flottants — voir
  `money.js`. La saisie accepte la virgule française et le point.
- **`budget.js` est pur** (entrées → sorties), donc testable seul.
- **Changer la palette** = éditer `css/tokens.css` (`:root`). Le vert / orange
  / rouge sont réservés aux états de budget ; l'accent bleu acier au reste.
- **Après modification d'un fichier statique**, incrémente `CACHE_VERSION`
  dans `sw.js` (et ajoute le fichier à `ASSETS` s'il est nouveau), sinon
  l'ancienne version reste servie depuis le cache.
- **Le jeton GitHub vit dans son propre store IndexedDB** (`sync`, base v2),
  précisément pour qu'`exportAll()` ne puisse pas le ramasser. Ne le déplace
  pas dans `settings` : il finirait publié dans le fichier de sauvegarde.
- **Les migrations IndexedDB sont additives** : chaque `createObjectStore` est
  gardé par `contains()`. Monter de version n'efface rien — en particulier pas
  le jeton, qu'il ne faut donc jamais avoir à ressaisir.
- **`watch` sur une catégorie** pilote l'alerte d'accueil. Avant, l'alerte
  cherchait le nom exact `'Restau/livraison'` : renommer la catégorie
  l'éteignait définitivement, sans message ni erreur.
- **Tout nouveau store doit être ajouté à `exportAll()` ET `importAll()`**,
  sinon la synchro GitHub le perd en silence. `sync` est la seule exception
  volontaire.
- **Le service worker ne touche pas aux requêtes cross-origin** : servir une
  réponse de l'API GitHub depuis le cache produirait un faux conflit ou la
  restauration de données périmées.
