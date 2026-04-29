# supersocial

Automation locale pour LinkedIn (et X plus tard) via Playwright. Stockage markdown dans `data/`. Aucun service tiers, aucun API tierce, repo privé qui tourne uniquement sur ta machine.

## Setup

```bash
npm install
npm run dev -- linkedin login
```

La commande `login` ouvre Chrome avec un profil persistant, tu te connectes à LinkedIn à la main, les cookies sont sauvés dans `.chrome-profile/`. Tu ne referas ce login qu'à expiration de session (~1 an pour `li_at`).

## Utilisation via Claude Code

La skill `.claude/skills/supersocial/SKILL.md` liste les commandes disponibles. Claude l'invoque automatiquement quand tu lui demandes une action LinkedIn (recherche, DM, commentaire, publication, synchro posts).

## Utilisation directe

```bash
npm run dev -- linkedin --help
```

Les données produites atterrissent dans `data/linkedin/` (searches, posts, conversations, comments, outbox) en markdown avec frontmatter YAML. L'index JSON correspondant est régénérable.

Envoyer un DM à quelqu'un dont on a l'URL profil :

```bash
npm run dev -- linkedin dm "https://www.linkedin.com/in/slug/" "coucou 👋"
```

La commande résout l'URN du profil, dérive le thread ID existant depuis les `data-event-urn` du compose LinkedIn, synchronise l'historique, affiche les 3 derniers messages, refuse le doublon (dernier sortant identique) et demande confirmation avant d'envoyer. Thread neuf : envoi direct, capture du thread URL après redirection. Accepte aussi directement `/messaging/thread/<id>/` ou le thread ID brut.

Préparer un envoi en masse : `linkedin outbox:add` pour empiler les messages un par un, `linkedin outbox:send -n 10` pour traiter par lots en respectant la limite journalière (40 DM/jour) et les pauses humaines entre chaque envoi. Le même message peut être personnalisé par destinataire puisqu'il y a un fichier par item. Pour rejouer des items en échec après correction (limite atteinte la veille, coupure réseau, etc.) : `linkedin outbox:retry --all` ou `linkedin outbox:retry <id1> <id2>`, optionnellement filtré par `--match <motif-erreur>`.

Sécurité contre les doublons : `outbox:send` vérifie le thread cible avant chaque envoi et skip si le dernier message sortant est identique au body de l'item (item passe en `sent/` avec une note `dedup match`, sans consommer de quota DM). Couvre les retries qui suivent un faux négatif où le message avait été envoyé mais marqué `failed`.

Détection du DM refusé : si LinkedIn affiche l'upsell Premium/InMail (typique pour les non-1ère relation, ou suite à un burst d'envois compose), le code détecte le marqueur `card-upsell-v2__headline` en 3-5s et lève `LinkedInDmRestrictedError` qui interrompt le batch outbox. Pour les cibles non-connectées, utiliser le workflow connect d'abord.

Demande de connexion : `linkedin connect <url> [--note <body>]` envoie une invitation, gère les deux emplacements du bouton "Se connecter" (visible directement ou caché dans le menu "Plus" selon le degré). Court-circuite si déjà 1ère relation ou invitation pendante. `linkedin profile:status <url>` lit le degré de relation, l'URN, l'état du bouton Message et l'état d'invitation.

File d'invitations : `linkedin invite:add` empile, `linkedin invite:send -n N` traite par lots (limite 15/jour), `linkedin invite:check` re-vérifie l'état des invitations envoyées et déplace celles acceptées vers `accepted/`. `invite:retry` rejoue les échecs, `invite:cancel` retire une pending. Stockage symétrique à l'outbox dans `data/linkedin/invitations/{pending,sent,accepted,failed}/` avec un fichier markdown par invitation.

Workflow chaîné invite → DM : `linkedin invite:add <url> --note "..." --then-dm "..."` queue à la fois une invitation et un DM. Le DM partira automatiquement quand la cible passera en 1ère relation, grâce au pre-flight de degré dans `outbox:send` qui skip (statut `waiting`) tant que la cible n'est pas connectée. Le cron `invite:check` (1x/jour) marque les invitations acceptées; le cron `outbox:send` (3x/jour) re-tente les DMs et fire ceux dont la cible est passée 1ère relation.

Mode debug: `SUPERSOCIAL_DEBUG=true` sur n'importe quelle commande pour logs détaillés. `SUPERSOCIAL_STEALTH=false` pour désactiver le stealth plugin.

## Cron

`scripts/cron.sh` est un wrapper générique pour exécuter n'importe quelle commande supersocial sous cron. Il prend la commande en arguments (passés à `npm run dev --`), pose un verrou global PID-based, fixe un PATH explicite, et appende la sortie dans `data/.state/cron/<job>.log` (le nom du job est dérivé des args). Compatible macOS et Linux, aucune dépendance externe.

Le verrou est global, pas par job: le profil Chrome persistant `.chrome-profile/` ne supporte qu'un seul `launchPersistentContext` à la fois. Donc un seul cron supersocial s'exécute simultanément, les autres se skippent silencieusement (avec une trace dans le log) si leur créneau tombe pendant un run en cours.

Exemples d'usage :

```bash
scripts/cron.sh linkedin outbox:send         # log: outbox-send.log
scripts/cron.sh linkedin posts:sync:latest   # log: posts-sync-latest.log
```

La configuration crontab vit dans `scripts/crontab.txt` (template versionné), avec un script d'installation idempotent qui merge le bloc supersocial dans le crontab utilisateur sans toucher aux autres jobs (marqueurs `# >>> supersocial >>>` / `# <<< supersocial <<<`) :

```bash
scripts/crontab.sh preview     # voir ce qui serait installe (chemin substitue)
scripts/crontab.sh install     # ajouter ou rafraichir le bloc dans le crontab utilisateur
scripts/crontab.sh status      # afficher le bloc actuellement installe
scripts/crontab.sh uninstall   # retirer le bloc (laisse intacts les autres jobs)
```

Pour modifier les créneaux ou ajouter une nouvelle commande planifiée, éditer `scripts/crontab.txt` puis relancer `scripts/crontab.sh install`. Le bloc précédent est remplacé proprement.

Suivre l'activité :

```bash
tail -f data/.state/cron/*.log
```

Sur macOS, cron a besoin du Full Disk Access pour lire `data/` (Réglages Système → Confidentialité → Accès complet au disque → ajouter `/usr/sbin/cron`). Si le Mac dort à l'heure d'un créneau, le run est sauté sans rattrapage automatique, d'où les 3 créneaux pour l'outbox. Sur Linux, rien à configurer côté permissions.

## X (Twitter)

Pas encore implémenté. L'architecture (`src/core/provider.ts`, `SocialProvider` interface) est prévue pour accueillir un `XProvider` en miroir du `LinkedInProvider`.
