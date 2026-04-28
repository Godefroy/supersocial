
## Writing style

- Always write in French. (except if replying to an english message, then write in english)
- Never use em dashes (`—`). Reformulate.
- Prefer positive formulations over negative ones. E.g. "rester indépendant" rather than "ne pas dépendre", "dès le premier sprint" rather than "pas à la fin".
- Avoid label-colon patterns like "Objectif :", "Result:", "Avantage :". Integrate the information into the sentence.

## Persistance des règles

Ne pas utiliser le système de mémoire Claude (`~/.claude/projects/.../memory/`). Toutes les règles persistantes pour ce projet s'écrivent dans ce `CLAUDE.md`.

## Règles LinkedIn

Ne jamais charger `linkedin.com/feed/` (ni `/feed/follows`, `/feed/hashtag/...`, ni aucune URL du feed algorithmique) depuis le code supersocial: ça brûle le feed personnalisé de l'utilisateur. Naviguer directement vers l'URL cible (search, profil, permalien post, conversation), pas de warmup préalable. Si un health-check est nécessaire, utiliser une page neutre (ex: `/settings/`, `/in/me/`).

Avant chaque exécution réelle d'une commande `supersocial linkedin *` qui charge une page LinkedIn, demander confirmation à l'utilisateur. Chaque lancement consomme du quota et peut polluer son compte. Ne jamais enchaîner plusieurs runs pour debugger sans demander: inspecter les dumps existants dans `data/.state/debug/` à la place.

Respecter les limites humaines quand plusieurs commandes s'enchaînent: 15-20 invitations/jour, 40-50 DM/jour, fenêtre lu-ve 9h-12h / 14h-18h. Le throttling est géré par `src/core/throttle.ts` mais ne sauve pas d'un enchaînement abusif.

Si une commande remonte `RateLimitHitError` (HTTP 429 ou 999), arrêter immédiatement toute commande LinkedIn pour la journée et prévenir l'utilisateur. Ne pas relancer.

Avant tout retry d'envoi DM dont la tentative précédente a échoué, vérifier que le message n'est pas déjà parti côté LinkedIn. Certains chemins (`compose-no-redirect`, confirmations manquantes) lèvent une exception alors que LinkedIn a accepté l'envoi. La dédup intégrée à `outbox:send` (lecture du thread + comparaison du dernier sortant au body de l'item) couvre ce risque. Ne jamais court-circuiter cette dédup en bricolant un envoi direct sans vérification visuelle de la conversation.

## Skills Claude Code

Les skills (`.claude/skills/*/SKILL.md`) doivent rester centrées sur leur fonction: frontmatter déclencheur, commandes à exécuter, gestion des erreurs visibles. Ne pas y documenter l'architecture interne, le throttling, le data layout, ni des règles que le code applique déjà.

## Documentation

Le `README.md` reste synthétique et décrit l'installation, l'usage via la skill, et les points d'attention. Toute nouvelle commande CLI, règle d'usage, ou point d'attention qui apparaît au fil du travail doit être reflété dans le `README.md` et la skill correspondante. Le README ne paraphrase pas la skill, il y renvoie.

Le `TODO.md` liste ce qui reste à développer et ce qui est fait. Le maintenir à jour: cocher les items quand une feature est livrée, ajouter les nouvelles idées et améliorations qui émergent, retirer ce qui n'est plus pertinent.
