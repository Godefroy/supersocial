---
name: supersocial
description: Automatiser LinkedIn (chercher/poster des posts, lire/envoyer des DM, boîte d'envoi, lire/poster des commentaires, synchroniser l'inventaire de ses posts). À utiliser dès que l'utilisateur demande une action LinkedIn.
---

# supersocial

CLI locale. Invoquer via `npm run dev -- <commande>` depuis la racine du projet.

## Commandes

```bash
npm run dev -- linkedin throttle:status
npm run dev -- linkedin search <query> [-n 20] [--since past-24h|past-week|past-month]
npm run dev -- linkedin posts:sync [-n 50] [--all]
npm run dev -- linkedin posts:sync:latest [-n 200]

# Conversations privées
npm run dev -- linkedin thread <url>
npm run dev -- linkedin dm <url> <body> [--yes] [--dry-run] [--force] [--queue]
npm run dev -- linkedin conversations:rename

# Boîte d'envoi (préparer des messages, envoyer en batch sous throttling)
npm run dev -- linkedin outbox:add <url> <body> [--label <label>]
npm run dev -- linkedin outbox:list [--status pending|sent|failed|all]
npm run dev -- linkedin outbox:send [-n N] [--dry-run]
npm run dev -- linkedin outbox:retry [ids...] [--all] [--match <motif>]
npm run dev -- linkedin outbox:cancel <id>

# Commentaires
npm run dev -- linkedin comments <postIdOrUrl>
npm run dev -- linkedin comment <postId> <body>

npm run dev -- linkedin publish <body> [--visibility public|connections]
```

Toutes les commandes écrivent leur résultat dans `data/linkedin/` et affichent le fichier produit sur stdout.

## thread et dm

`<url>` accepte trois formes : URL profil (`/in/slug/`), URL thread (`/messaging/thread/<id>/`) ou thread ID brut (`2-...`).

Pour une URL profil, la résolution navigue vers `/messaging/compose/?recipient=<urn>` et dérive le thread ID depuis les `data-event-urn` des messages chargés (LinkedIn affiche les messages du thread existant dans le panneau droit, même si l'URL du navigateur ne change pas). S'il n'y a pas encore de thread, le resolver retourne une `composeUrl` et l'envoi se fait en mode neuf.

`thread <url>` synchronise l'historique et le stocke dans `data/linkedin/conversations/`.

`dm <url> <body>` essaie de charger l'historique d'abord. Si thread existant : affiche les 3 derniers messages, refuse le doublon (sauf `--force`), demande confirmation (sauf `--yes`), envoie, re-synchronise. Si thread neuf : envoi direct via compose, pas de dédup possible.

`conversations:rename` rebaptise les fichiers de conversation dont le slug est resté sur le thread ID brut (cas d'un thread créé via compose dont les participants n'étaient pas extractibles au moment de l'envoi). Idempotent.

`--dry-run` affiche ce qui serait envoyé sans envoyer. `--queue` ajoute à la boîte d'envoi.

## Boîte d'envoi

`outbox:add` pose un markdown dans `data/linkedin/outbox/pending/`. `outbox:send` traite les items en attente, un par un, avec `humanPause("dm")` entre chaque, et s'arrête sur `RateLimitHitError`. Nombre d'envois plafonné par la capacité journalière restante (`getDailyLimits().dm - getTodayCount("dm")`). Les items envoyés passent dans `sent/`, ceux en erreur dans `failed/`. Pour rejouer des items en échec : `outbox:retry --all` (tout) ou `outbox:retry <id1> <id2>` (sélection), avec `--match <motif>` pour filtrer par regex sur le message d'erreur.

Avant chaque envoi, `outbox:send` vérifie le thread cible et compare le dernier message sortant au body de l'item. Si match exact, l'item passe direct en `sent/` avec `note: déjà envoyé (dedup match)` sans consommer de quota dm. Sécurise les retries après un faux négatif (ex: compose-no-redirect où le message a été envoyé mais l'exception a été levée).

## Gestion d'erreur

Si une commande affiche `RateLimitHitError`, arrêter immédiatement toute commande LinkedIn et prévenir l'utilisateur. Ne pas réessayer.

Si `Cookies LinkedIn manquants` ou `Pas de session LinkedIn dans le profil Chrome`, lancer `npm run dev -- linkedin login` pour connecter le profil Chrome persistant.

Si `ThrottleLimitError`, la limite journalière pour cette action est atteinte. Prévenir l'utilisateur et attendre le lendemain, ou lui proposer de consulter `linkedin throttle:status`.

Si `Bouton "Message" introuvable`, le profil peut être privé ou ne pas autoriser les messages entrants (pas de relation directe). Proposer d'utiliser une URL thread existante à la place.

## X/Twitter

Pas encore implémenté. Si l'utilisateur le demande, répondre que seul LinkedIn est supporté pour le moment.
