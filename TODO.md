# TODO

Plan de développement pour supersocial. Maintenu à chaque ajout/retrait.

## État actuel

Commandes fonctionnelles :
- `linkedin login` : session persistante via `.chrome-profile/`
- `linkedin search <query>` : posts par mot-clé
- `linkedin posts:sync` : synchro complète (243 posts depuis 2013 synchronisés)
- `linkedin posts:sync:latest` : synchro incrémentale (s'arrête sur IDs connus)
- `linkedin comments <postIdOrUrl>` : tous les commentaires avec threading
- `linkedin throttle:status` : compteurs journaliers par action
- `linkedin thread <url>` : synchro d'une conversation (URL profil, URL thread ou thread ID)
- `linkedin dm <url> <body>` : envoi DM avec synchro + confirmation + dédup
- `linkedin outbox:add|list|send|retry|cancel` : boîte d'envoi pour batch throttlé (retry rejoue les items `failed`)
- `linkedin conversations:rename` : recompose les noms de fichier des conversations dont le slug est resté en thread ID brut
- `scripts/cron.sh <args>` : wrapper cron générique (verrou global PID-based, log par job dans `data/.state/cron/<job>.log`)
- `scripts/crontab.{txt,sh}` : template versionné + script `install/uninstall/status/preview` qui merge le bloc supersocial dans le crontab utilisateur via marqueurs

Infra :
- Throttling persistant par action LinkedIn (`BASE_PROFILES`) dans `data/.state/`
- Storage markdown + frontmatter YAML, index JSON régénérables
- Extraction robuste : aria-labels + data-urn + fallback innerText
- Décodage des dates depuis URN snowflake + fallback label relatif
- Dédup des messages par `data-event-urn`, refus du doublon au `dm` (sauf `--force`)
- Stockage conversations dans `data/linkedin/conversations/<slug>.md` avec index JSON par thread_id
- Outbox : pending/sent/failed sous `data/linkedin/outbox/`, un markdown par item. `outbox:send` dédup avant chaque envoi (compare le dernier sortant du thread au body), un match passe l'item en `sent` avec note sans consommer de quota dm
- Détection de DM refusé via `card-upsell-v2__headline` (upsell Premium): fast-fail en 3-5s avec `LinkedInDmRestrictedError`, break du batch outbox
- Résolution URL profil → thread ID via dérivation base64 depuis les `data-event-urn` (décoder, prendre la partie après `&`, réencoder avec préfixe `2-`). Évite la recherche inbox, gère homonymes et threads anciens
- Détection outgoing par comparaison URN sender (data-event-urn) ∉ participants "autres" (où self est filtré par nom depuis l'alt de `.global-nav__me-photo`)
- Headless par défaut (mode "new" de Playwright + stealth) sauf `linkedin login`. Sur redirect `/login` ou `/checkpoint/`, le CLI lève `LoginRequiredError`, notifie macOS et ouvre auto une fenêtre Chrome headful pour résoudre la session

## À faire

### Lecture LinkedIn

- [ ] `linkedin inbox:list` : lister les conversations (aperçu, non-lu) depuis `/messaging/`
- [x] `linkedin thread <url>` : lire une conversation, stocker en markdown append-only

### Écriture LinkedIn

- [x] `linkedin dm <url> <body>` : envoyer un DM
- [x] `linkedin outbox:*` : préparer et envoyer des DM en batch
- [x] `linkedin connect <url> [--note <body>]` : envoyer une invitation, avec ou sans note (gère le bouton "Se connecter" visible direct ou dans le menu "Plus")
- [x] `linkedin profile:status <url>` : lire degré, URN, état Message/invitation
- [x] `linkedin invite:*` : file d'invitations symétrique à l'outbox (`add|list|send|check|retry|cancel`), stockage `data/linkedin/invitations/{pending,sent,accepted,failed}/`. `invite:check` re-vérifie l'état des envoyées et déplace en `accepted/` quand la cible est passée 1ère relation.
- [x] Workflow chaîné `invite → wait → dm`: `invite:add --then-dm <body>` queue invitation + DM atomiquement. `outbox:send` skip les DMs dont la cible n'est pas 1ère relation (statut `waiting`, reste en pending sans humanPause). Cron `invite:check` marque acceptée → cron `outbox:send` suivant fire le DM.
- [x] Pre-flight degré dans `outbox:send` (jamais DM si non-1ère relation, partage cache profil avec `readConversation`)
- [x] Cron entries pour `invite:send` (2x/jour) et `invite:check` (1x/jour)
- [x] Expiration des invitations non acceptées : `invite:check` plafonne à 10 vérifications max (1x/20h), au-delà passe en `failed` et cascade les DM `pending` adressés à la même URL en `failed`. `outbox:send` applique le même compteur côté pre-flight degré (10 essais waiting max). Constantes en haut de `invitations.ts` et `outbox.ts`.
- [ ] `linkedin comment <postId> <body>` : poster un commentaire
- [ ] `linkedin publish <body>` : publier un post

### Provider X

- [ ] `XProvider` implémentant `SocialProvider`
- [ ] Flow `x login`
- [ ] Implémenter les méthodes en miroir de LinkedIn
- [ ] URN decoder pour X (epoch Twitter, shift différent)
- [ ] Stockage dans `data/x/` en miroir de `data/linkedin/`

## Améliorations possibles

- [ ] Sync incrémentale pour les commentaires (ne récupérer que les nouveaux sur un post déjà fetché)
- [ ] Sync incrémentale pour les threads (s'arrêter dès que tous les messages chargés sont déjà dans le fichier)
- [ ] URN profil des commentateurs : actuellement l'URL `/in/slug/` est le seul identifiant disponible depuis la page commentaires. Pour le vrai URN `urn:li:fsd_profile:...`, il faut visiter la page profil.
- [ ] Extraction de l'URN des posts côté search : souvent absent du DOM React, on retombe sur ID synthétique. Parser le blob `<script id="rehydrate-data">` (format Next.js RSC Flight) serait plus robuste.
- [ ] Tracker les limites hebdomadaires en plus du journalier (ex : 100-200 invitations/semaine)
- [ ] Commande `linkedin health` : vérifier session valide, test rapide d'extraction, rapport
- [ ] Outbox : support d'un délai programmé (envoyer pas avant telle heure, fenêtres ouvrables uniquement via `waitForWorkingWindow`)
- [x] Outbox : reprendre les items `failed` après correction (`outbox:retry [ids...] | --all` avec `--match <motif>`)
- [ ] Tests (aucun actuellement)
- [ ] CI GitHub Actions pour typecheck (si le repo passe en public un jour)

## Notes

- Les règles d'usage (no `/feed/`, confirmation avant run, limites humaines) vivent dans `CLAUDE.md`.
- Pour débugger, privilégier les dumps existants dans `data/.state/debug/` plutôt que relancer la commande.
- Mode debug : `SUPERSOCIAL_DEBUG=true` sur n'importe quelle commande.
