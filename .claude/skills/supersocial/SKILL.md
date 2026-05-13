---
name: supersocial
description: Automatiser LinkedIn (chercher/poster des posts, lire/envoyer des DM, boîte d'envoi, demander des connexions avec ou sans note, lire le degré de relation d'un profil, lire/poster des commentaires, synchroniser l'inventaire de ses posts). À utiliser dès que l'utilisateur demande une action LinkedIn.
---

# supersocial

CLI locale. Invoquer via `npm run dev -- <commande>` depuis la racine du projet.

## Commandes

```bash
npm run dev -- linkedin throttle:status
npm run dev -- linkedin search <query> [-n 20] [--since past-24h|past-week|past-month]
npm run dev -- linkedin posts:sync [-n 50] [--all]
npm run dev -- linkedin posts:sync:latest [-n 200]

# Profils et invitations
npm run dev -- linkedin profile:status <url>
npm run dev -- linkedin connect <url> [--note <body>] [--yes] [--dry-run]

# File d'invitations (préparer puis envoyer en batch sous throttling)
npm run dev -- linkedin invite:add <url> [--note <body>] [--label <label>]
npm run dev -- linkedin invite:list [--status pending|sent|accepted|failed|all]
npm run dev -- linkedin invite:send [-n N] [--dry-run]
npm run dev -- linkedin invite:check [-n N]
npm run dev -- linkedin invite:retry [ids...] [--all] [--match <motif>]
npm run dev -- linkedin invite:cancel <id>

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

## profile:status et connect

`profile:status <url>` charge la page profil et affiche degré (1st/2nd/3rd/out-of-network/unknown), URN, nom, état du bouton Message et état d'invitation.

`connect <url>` envoie une demande de connexion. Court-circuite si déjà 1ère relation ou invitation pendante. Le bouton "Se connecter" est cherché en visible direct d'abord, puis dans le menu "Plus" en fallback (selon le degré). Avec `--note`, ouvre la modale de note personnalisée et y tape le body. Sans note, clique "Envoyer sans note". Trace l'envoi dans `data/linkedin/invitations/sent/` (ou `accepted/` si la cible est déjà 1ère relation).

## File d'invitations

Symétrique à l'outbox DM. Les invitations sont stockées en markdown dans `data/linkedin/invitations/` avec sous-dossiers `pending/`, `sent/`, `accepted/`, `failed/`. Le body du fichier contient la note (vide pour invitation simple).

`invite:add <url> [--note <body>] [--then-dm <body>]` queue une invitation. Avec `--then-dm`, queue aussi un DM dans l'outbox qui ne partira que quand la cible sera passée 1ère relation. `invite:send` traite le batch en respectant la limite invite (15/jour) avec `humanPause("invite")` entre chaque. Les `already-pending` côté LinkedIn passent direct en `sent`, les `already-connected` passent direct en `accepted`. `invite:check` re-vérifie l'état des invitations en `sent` et déplace en `accepted` quand la cible est devenue 1ère relation. `invite:retry` rejoue les `failed`, `invite:cancel` retire une `pending`.

## Workflow chaîné invite → DM

`outbox:send` applique un pre-flight de degré de relation: les items dont la cible n'est pas 1ère relation restent en pending sans humanPause (statut `waiting`). Combiné avec `invite:check` en cron, ça permet le workflow: `invite:add <url> --then-dm <body>` queue l'invitation et le DM. Le cron `invite:send` envoie l'invitation. Le cron `invite:check` re-vérifie chaque jour et marque acceptée quand la cible passe 1ère relation. Au cron `outbox:send` suivant, le DM trouve la cible en 1ère relation et part automatiquement.

Au bout de 10 vérifications sans acceptation, l'invitation passe en `failed` ("non acceptée après 10 vérifications") et le DM `pending` adressé à la même URL est cascadé en `failed`. `invite:retry` ou `outbox:retry` réinitialisent les compteurs si l'utilisateur veut reprendre.

## Gestion d'erreur

Si une commande affiche `RateLimitHitError`, arrêter immédiatement toute commande LinkedIn et prévenir l'utilisateur. Ne pas réessayer.

Si `LinkedInDmRestrictedError` (DM refusé, upsell Premium affiché), arrêter le batch outbox et prévenir l'utilisateur. La cible n'est probablement pas en 1ère relation, ou un burst récent a déclenché une restriction temporaire. Proposer `linkedin connect <url>` pour envoyer une invitation d'abord, puis DM seulement après acceptation.

Si `LoginRequiredError` (session expirée, redirect `/login` ou `/checkpoint/`, cookie `li_at` manquant), le CLI ouvre auto une fenêtre Chrome de login et envoie une notif macOS. Prévenir l'utilisateur que la fenêtre Chrome attend sa connexion. Une fois la session restaurée par l'utilisateur, relancer la commande qui avait échoué.

Si `ThrottleLimitError`, la limite journalière pour cette action est atteinte. Prévenir l'utilisateur et attendre le lendemain, ou lui proposer de consulter `linkedin throttle:status`.

Si `Bouton "Message" introuvable`, le profil peut être privé ou ne pas autoriser les messages entrants (pas de relation directe). Proposer d'utiliser une URL thread existante à la place.

## X/Twitter

Pas encore implémenté. Si l'utilisateur le demande, répondre que seul LinkedIn est supporté pour le moment.
