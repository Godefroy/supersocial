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

Les données produites atterrissent dans `data/linkedin/` (searches, posts, conversations, comments) en markdown avec frontmatter YAML. L'index JSON correspondant est régénérable.

Mode debug: `SUPERSOCIAL_DEBUG=true` sur n'importe quelle commande pour logs détaillés. `SUPERSOCIAL_STEALTH=false` pour désactiver le stealth plugin.

## X (Twitter)

Pas encore implémenté. L'architecture (`src/core/provider.ts`, `SocialProvider` interface) est prévue pour accueillir un `XProvider` en miroir du `LinkedInProvider`.
