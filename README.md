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
onglet Safari, non. L'export CSV est donc un **filet de sécurité**, pas un
confort.

- **Exporter :** Réglages → *Exporter en CSV*. Le fichier part dans
  Téléchargements ; garde-le (mail à toi-même, cloud, peu importe).
- **Restaurer :** Réglages → *Importer un CSV* après une purge ou sur un
  nouvel appareil.
- L'accueil affiche un **rappel discret** si aucune sauvegarde n'a été
  exportée depuis plus de 30 jours.

Le CSV est au format français (séparateur `;`, décimale `,`) : il s'ouvre
directement dans Excel/LibreOffice et s'y modifie.

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
  views/              month, add, history, settings
icons/                180, 192, 512, 512-maskable
```

### Notes d'implémentation

- **Montants en centimes (entiers) partout.** Jamais de flottants — voir
  `money.js`. La saisie accepte la virgule française et le point.
- **`budget.js` est pur** (entrées → sorties), donc testable seul.
- **Changer la palette** = éditer `css/tokens.css` (`:root`). Le vert / orange
  / rouge sont réservés aux états de budget ; l'accent bleu acier au reste.
- **Après modification d'un fichier statique**, incrémente `CACHE_VERSION`
  dans `sw.js`, sinon l'ancienne version reste servie depuis le cache.
