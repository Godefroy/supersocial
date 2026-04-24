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

Préparer un envoi en masse : `linkedin outbox:add` pour empiler les messages un par un, `linkedin outbox:send -n 10` pour traiter par lots en respectant la limite journalière (40 DM/jour) et les pauses humaines entre chaque envoi. Le même message peut être personnalisé par destinataire puisqu'il y a un fichier par item.

Mode debug: `SUPERSOCIAL_DEBUG=true` sur n'importe quelle commande pour logs détaillés. `SUPERSOCIAL_STEALTH=false` pour désactiver le stealth plugin.

## X (Twitter)

Pas encore implémenté. L'architecture (`src/core/provider.ts`, `SocialProvider` interface) est prévue pour accueillir un `XProvider` en miroir du `LinkedInProvider`.
